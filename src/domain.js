// Application domain: identity (C02), events/sessions (C03) and registration (C04).
// Every mutation is authorized server-side from the session identity; client-supplied
// organization ids or roles are never trusted.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { transaction } from './db.js';

const scrypt = promisify(scryptCallback);

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AppError(status, code, message); };
const sha256 = value => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

// ---------- validation helpers ----------
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const EVENT_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
export function str(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') fail(400, 'invalid_input', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) fail(400, 'invalid_input', `${field} must be ${min}-${max} characters`);
  return trimmed;
}
export function isTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone.includes('/') || zone === 'UTC'; } catch { return false; }
}
function instant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) fail(400, 'invalid_input', `${field} must be an ISO 8601 timestamp with offset`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(400, 'invalid_input', `${field} is not a valid time`);
  return date;
}
/** Render an instant in an IANA zone (used by tests and server-rendered summaries). */
export function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(date);
}

// ---------- identity (C02) ----------
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const publicUser = row => ({ id: row.id, displayName: row.display_name, kind: row.kind, ...(row.email ? { email: row.email } : {}) });

export async function createSession(db, userId, hours) {
  const value = token();
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))", [sha256(value), userId, hours]);
  return value;
}

export async function signUp(pool, input, config) {
  const email = str(input?.email, 'email', { max: 254 }).toLowerCase();
  if (!EMAIL.test(email)) fail(400, 'invalid_input', 'email is invalid');
  const password = typeof input?.password === 'string' ? input.password : '';
  if (password.length < 10 || password.length > 200) fail(400, 'weak_password', 'password must be 10-200 characters');
  const displayName = str(input?.displayName, 'displayName', { max: 80 });
  const hash = await hashPassword(password);
  return transaction(pool, async client => {
    const existing = await client.query('SELECT 1 FROM users WHERE email_normalized = $1', [email]);
    if (existing.rowCount) fail(409, 'email_taken', 'An account with this email already exists');
    const { rows: [user] } = await client.query("INSERT INTO users (email, display_name, password_hash, kind) VALUES ($1, $2, $3, 'account') RETURNING *", [email, displayName, hash]);
    return { user: publicUser(user), session: await createSession(client, user.id, config.sessionHours) };
  });
}

export async function logIn(pool, input, config) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input?.password === 'string' ? input.password : '';
  const { rows: [user] } = await pool.query("SELECT * FROM users WHERE email_normalized = $1 AND kind = 'account'", [email]);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH); // constant work for unknown emails
  if (!user || !ok) fail(401, 'invalid_credentials', 'Email or password is incorrect');
  return { user: publicUser(user), session: await createSession(pool, user.id, config.sessionHours) };
}

export async function authenticate(pool, sessionToken) {
  if (typeof sessionToken !== 'string' || sessionToken.length < 20 || sessionToken.length > 100) return null;
  const { rows: [row] } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND (u.kind = 'account' OR u.guest_expires_at > now())`, [sha256(sessionToken)]);
  return row ? publicUser(row) : null;
}

export async function logOut(pool, sessionToken) {
  if (typeof sessionToken === 'string') await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(sessionToken)]);
}

/** Logout everywhere: revokes every session of the user (all tabs and devices). */
export async function logOutAll(pool, user) {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
}

const requireUser = user => { if (!user) fail(401, 'unauthenticated', 'Sign in first'); return user; };
const requireAccount = user => { requireUser(user); if (user.kind !== 'account') fail(403, 'account_required', 'Guests cannot manage organizations'); return user; };

export async function createOrganization(pool, user, input) {
  requireAccount(user);
  const slug = str(input?.slug, 'slug', { max: 48 });
  if (!SLUG.test(slug)) fail(400, 'invalid_input', 'slug must be lowercase letters, digits and dashes');
  const name = str(input?.name, 'name', { max: 120 });
  return transaction(pool, async client => {
    const taken = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
    if (taken.rowCount) fail(409, 'slug_taken', 'That organization slug is taken');
    const { rows: [org] } = await client.query('INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id, slug, name', [slug, name]);
    await client.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [org.id, user.id]);
    return { ...org, role: 'owner' };
  });
}

export async function listMyOrganizations(pool, user) {
  requireUser(user);
  const { rows } = await pool.query('SELECT o.id, o.slug, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY o.name', [user.id]);
  return rows;
}

async function membership(db, organizationId, userId) {
  const { rows: [row] } = await db.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [organizationId, userId]);
  return row?.role ?? null;
}

async function orgBySlugFor(db, user, slug, roles) {
  requireUser(user);
  const { rows: [org] } = await db.query('SELECT id, slug, name FROM organizations WHERE slug = $1', [String(slug)]);
  const role = org ? await membership(db, org.id, user.id) : null;
  // Non-members get 404, not 403, so organization existence is not disclosed.
  if (!org || !role) fail(404, 'not_found', 'Organization not found');
  if (!roles.includes(role)) fail(403, 'forbidden', 'Your role does not allow this');
  return { ...org, role };
}

export async function addMember(pool, user, orgSlug, input) {
  requireAccount(user);
  const org = await orgBySlugFor(pool, user, orgSlug, ['owner']);
  const role = input?.role;
  if (!['organizer', 'member'].includes(role)) fail(400, 'invalid_input', 'role must be organizer or member');
  const email = str(input?.email, 'email', { max: 254 }).toLowerCase();
  const { rows: [target] } = await pool.query("SELECT id FROM users WHERE email_normalized = $1 AND kind = 'account'", [email]);
  if (!target) fail(404, 'not_found', 'No account with that email');
  await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE memberships.role <> \'owner\'', [org.id, target.id, role]);
  return { organization: org.slug, userId: target.id, role };
}

// ---------- events and sessions (C03) ----------
const eventRow = row => ({
  id: row.id, slug: row.slug, title: row.title, description: row.description, timezone: row.timezone,
  startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), visibility: row.visibility, status: row.status,
  capacity: row.capacity, version: row.version, organization: row.organization_slug ? { slug: row.organization_slug, name: row.organization_name } : undefined
});
const sessionRow = row => ({ id: row.id, title: row.title, kind: row.kind, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), status: row.status, worldTemplate: row.world_template, version: row.version });

function eventFields(input, partial = false) {
  const out = {};
  if (!partial || input.title !== undefined) out.title = str(input.title, 'title', { max: 160 });
  if (!partial || input.description !== undefined) out.description = typeof input.description === 'string' ? input.description.slice(0, 5000) : '';
  if (!partial || input.timezone !== undefined) { if (!isTimeZone(input.timezone)) fail(400, 'invalid_input', 'timezone must be an IANA zone such as Europe/Berlin'); out.timezone = input.timezone; }
  if (!partial || input.startsAt !== undefined) out.starts_at = instant(input.startsAt, 'startsAt');
  if (!partial || input.endsAt !== undefined) out.ends_at = instant(input.endsAt, 'endsAt');
  if (!partial || input.visibility !== undefined) { if (!['public', 'private'].includes(input.visibility)) fail(400, 'invalid_input', 'visibility must be public or private'); out.visibility = input.visibility; }
  if (!partial || input.capacity !== undefined) { if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100000) fail(400, 'invalid_input', 'capacity must be 1-100000'); out.capacity = input.capacity; }
  return out;
}

export async function createEvent(pool, user, orgSlug, input) {
  const org = await orgBySlugFor(pool, user, orgSlug, ['owner', 'organizer']);
  const slug = str(input?.slug, 'slug', { max: 64 });
  if (!EVENT_SLUG.test(slug)) fail(400, 'invalid_input', 'slug must be lowercase letters, digits and dashes');
  const f = eventFields(input ?? {});
  if (f.ends_at <= f.starts_at) fail(400, 'invalid_input', 'endsAt must be after startsAt');
  const taken = await pool.query('SELECT 1 FROM events WHERE slug = $1', [slug]);
  if (taken.rowCount) fail(409, 'slug_taken', 'That event slug is taken');
  const { rows: [row] } = await pool.query(
    'INSERT INTO events (organization_id, slug, title, description, timezone, starts_at, ends_at, visibility, capacity, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [org.id, slug, f.title, f.description, f.timezone, f.starts_at, f.ends_at, f.visibility, f.capacity, user.id]);
  return eventRow(row);
}

async function eventForOrganizer(db, user, eventId, lock = false) {
  requireUser(user);
  if (typeof eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(eventId)) fail(404, 'not_found', 'Event not found');
  const { rows: [event] } = await db.query(`SELECT * FROM events WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [eventId]);
  const role = event ? await membership(db, event.organization_id, user.id) : null;
  if (!event || !role) fail(404, 'not_found', 'Event not found');
  if (!['owner', 'organizer'].includes(role)) fail(403, 'forbidden', 'Only organizers can change this event');
  return event;
}

/** Optimistic concurrency: the caller supplies the version it edited; stale edits get 409. */
export async function updateEvent(pool, user, eventId, input) {
  return transaction(pool, async client => {
    const event = await eventForOrganizer(client, user, eventId, true);
    if (input?.version !== event.version) fail(409, 'version_conflict', `Event changed since version ${input?.version}; current version is ${event.version}`);
    if (event.status === 'cancelled') fail(409, 'cancelled', 'Cancelled events cannot be edited');
    const f = eventFields(input, true);
    const merged = { ...event, ...f };
    if (merged.ends_at <= merged.starts_at) fail(400, 'invalid_input', 'endsAt must be after startsAt');
    const { rows: [row] } = await client.query(
      'UPDATE events SET title=$2, description=$3, timezone=$4, starts_at=$5, ends_at=$6, visibility=$7, capacity=$8, version=version+1, updated_at=now() WHERE id=$1 RETURNING *',
      [event.id, merged.title, merged.description, merged.timezone, merged.starts_at, merged.ends_at, merged.visibility, merged.capacity]);
    if (f.capacity !== undefined && f.capacity > event.capacity) await promoteWaitlist(client, event.id, row.capacity);
    return eventRow(row);
  });
}

export async function setEventStatus(pool, user, eventId, status) {
  return transaction(pool, async client => {
    const event = await eventForOrganizer(client, user, eventId, true);
    const allowed = { published: ['draft'], cancelled: ['draft', 'published'] };
    if (!allowed[status]?.includes(event.status)) fail(409, 'invalid_transition', `Cannot change ${event.status} event to ${status}`);
    const { rows: [row] } = await client.query('UPDATE events SET status=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING *', [event.id, status]);
    return eventRow(row);
  });
}

export async function addSession(pool, user, eventId, input) {
  const event = await eventForOrganizer(pool, user, eventId);
  const title = str(input?.title, 'title', { max: 160 });
  if (!['keynote', 'talk', 'workshop', 'breakout', 'social', 'exhibition'].includes(input?.kind)) fail(400, 'invalid_input', 'kind is invalid');
  const starts = instant(input?.startsAt, 'startsAt');
  const ends = instant(input?.endsAt, 'endsAt');
  if (ends <= starts) fail(400, 'invalid_input', 'endsAt must be after startsAt');
  if (starts < event.starts_at || ends > event.ends_at) fail(400, 'invalid_input', 'session must fall within the event');
  const template = input?.worldTemplate ?? null;
  if (template !== null && (typeof template !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(template))) fail(400, 'invalid_input', 'worldTemplate must be an engine world id');
  const status = input?.publish === true ? 'published' : 'draft';
  const { rows: [row] } = await pool.query('INSERT INTO event_sessions (event_id, title, kind, starts_at, ends_at, status, world_template) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [event.id, title, input.kind, starts, ends, status, template]);
  return sessionRow(row);
}

export async function updateSession(pool, user, eventId, sessionId, input) {
  return transaction(pool, async client => {
    const event = await eventForOrganizer(client, user, eventId);
    const { rows: [current] } = await client.query('SELECT * FROM event_sessions WHERE id = $1 AND event_id = $2 FOR UPDATE', [String(sessionId), event.id]);
    if (!current) fail(404, 'not_found', 'Session not found');
    if (input?.version !== current.version) fail(409, 'version_conflict', `Session changed; current version is ${current.version}`);
    if (current.status === 'cancelled') fail(409, 'cancelled', 'Cancelled sessions cannot be edited');
    const next = { title: input.title === undefined ? current.title : str(input.title, 'title', { max: 160 }), starts_at: input.startsAt === undefined ? current.starts_at : instant(input.startsAt, 'startsAt'), ends_at: input.endsAt === undefined ? current.ends_at : instant(input.endsAt, 'endsAt') };
    let status = current.status;
    if (input.status !== undefined) {
      const allowed = { published: ['draft'], cancelled: ['draft', 'published'] };
      if (!allowed[input.status]?.includes(current.status)) fail(409, 'invalid_transition', `Cannot change ${current.status} session to ${input.status}`);
      status = input.status;
    }
    if (next.ends_at <= next.starts_at) fail(400, 'invalid_input', 'endsAt must be after startsAt');
    if (next.starts_at < event.starts_at || next.ends_at > event.ends_at) fail(400, 'invalid_input', 'session must fall within the event');
    const { rows: [row] } = await client.query('UPDATE event_sessions SET title=$2, starts_at=$3, ends_at=$4, status=$5, version=version+1, updated_at=now() WHERE id=$1 RETURNING *', [current.id, next.title, next.starts_at, next.ends_at, status]);
    return sessionRow(row);
  });
}

/** Who may see an event: organization members always; others only when published and public, or when registered/invited. */
async function canView(db, user, event) {
  if (user && await membership(db, event.organization_id, user.id)) return 'organizer-or-member';
  if (event.status === 'draft') return null;
  if (event.visibility === 'public') return 'public';
  if (!user) return null;
  const { rowCount } = await db.query("SELECT 1 FROM registrations WHERE event_id = $1 AND user_id = $2 AND status <> 'cancelled' UNION SELECT 1 FROM invitation_redemptions r JOIN invitations i ON i.id = r.invitation_id WHERE i.event_id = $1 AND r.user_id = $2", [event.id, user.id]);
  return rowCount ? 'invited' : null;
}

export async function getEvent(pool, user, slug) {
  const { rows: [event] } = await pool.query('SELECT e.*, o.slug AS organization_slug, o.name AS organization_name FROM events e JOIN organizations o ON o.id = e.organization_id WHERE e.slug = $1', [String(slug)]);
  const access = event ? await canView(pool, user, event) : null;
  if (!event || !access) fail(404, 'not_found', 'Event not found'); // private/draft events are indistinguishable from missing ones
  const organizer = access === 'organizer-or-member' && user ? ['owner', 'organizer'].includes(await membership(pool, event.organization_id, user.id)) : false;
  const sessions = (await pool.query(`SELECT * FROM event_sessions WHERE event_id = $1 ${organizer ? '' : "AND status <> 'draft'"} ORDER BY starts_at, title`, [event.id])).rows.map(sessionRow);
  const { rows: [counts] } = await pool.query("SELECT count(*) FILTER (WHERE status = 'registered') AS registered, count(*) FILTER (WHERE status = 'waitlisted') AS waitlisted FROM registrations WHERE event_id = $1", [event.id]);
  let registration = null;
  if (user) registration = (await pool.query('SELECT status, checked_in_at FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, user.id])).rows[0] ?? null;
  return { ...eventRow(event), sessions, organizer, registration, seats: { capacity: event.capacity, registered: counts.registered, waitlisted: organizer ? counts.waitlisted : undefined } };
}

export async function listPublicEvents(pool) {
  const { rows } = await pool.query("SELECT e.*, o.slug AS organization_slug, o.name AS organization_name FROM events e JOIN organizations o ON o.id = e.organization_id WHERE e.status IN ('published', 'cancelled') AND e.visibility = 'public' AND e.ends_at > now() - interval '7 days' ORDER BY e.starts_at LIMIT 100");
  return rows.map(eventRow);
}

export async function listOrganizationEvents(pool, user, orgSlug) {
  const org = await orgBySlugFor(pool, user, orgSlug, ['owner', 'organizer', 'member']);
  const { rows } = await pool.query('SELECT * FROM events WHERE organization_id = $1 ORDER BY starts_at', [org.id]);
  return rows.map(eventRow);
}

// ---------- registration, waitlist, invitations and check-in (C04) ----------
async function promoteWaitlist(client, eventId, capacity) {
  const { rows: [{ registered }] } = await client.query("SELECT count(*) AS registered FROM registrations WHERE event_id = $1 AND status = 'registered'", [eventId]);
  const free = capacity - registered;
  if (free <= 0) return [];
  const { rows } = await client.query(
    "UPDATE registrations SET status = 'registered', waitlisted_at = NULL, updated_at = now() WHERE (event_id, user_id) IN (SELECT event_id, user_id FROM registrations WHERE event_id = $1 AND status = 'waitlisted' ORDER BY waitlisted_at, user_id LIMIT $2) RETURNING user_id",
    [eventId, free]);
  return rows.map(row => row.user_id);
}

/** Idempotent registration. The event row lock serializes capacity decisions so concurrent requests never overbook. */
export async function register(pool, user, eventId, { invitationId = null } = {}) {
  requireUser(user);
  if (typeof eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(eventId)) fail(404, 'not_found', 'Event not found');
  return transaction(pool, async client => {
    const { rows: [event] } = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!event || !(await canView(client, user, event))) fail(404, 'not_found', 'Event not found');
    if (event.status !== 'published') fail(409, 'not_open', 'Registration is not open for this event');
    const { rows: [existing] } = await client.query('SELECT status FROM registrations WHERE event_id = $1 AND user_id = $2', [event.id, user.id]);
    if (existing && existing.status !== 'cancelled') return { status: existing.status, idempotent: true };
    const { rows: [{ registered }] } = await client.query("SELECT count(*) AS registered FROM registrations WHERE event_id = $1 AND status = 'registered'", [event.id]);
    const status = registered < event.capacity ? 'registered' : 'waitlisted';
    await client.query(
      `INSERT INTO registrations (event_id, user_id, status, via_invitation, waitlisted_at) VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'waitlisted' THEN clock_timestamp() END)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status, via_invitation = COALESCE(EXCLUDED.via_invitation, registrations.via_invitation), waitlisted_at = EXCLUDED.waitlisted_at, checked_in_at = NULL, updated_at = now()`,
      [event.id, user.id, status, invitationId]);
    return { status, idempotent: false };
  });
}

export async function cancelRegistration(pool, user, eventId) {
  requireUser(user);
  return transaction(pool, async client => {
    const { rows: [event] } = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [String(eventId)]);
    if (!event) fail(404, 'not_found', 'Event not found');
    const { rowCount } = await client.query("UPDATE registrations SET status = 'cancelled', waitlisted_at = NULL, updated_at = now() WHERE event_id = $1 AND user_id = $2 AND status <> 'cancelled'", [event.id, user.id]);
    if (!rowCount) fail(404, 'not_found', 'No active registration');
    const promoted = await promoteWaitlist(client, event.id, event.capacity);
    return { status: 'cancelled', promoted: promoted.length };
  });
}

export async function createInvitation(pool, user, eventId, input, now = new Date()) {
  const event = await eventForOrganizer(pool, user, eventId);
  const email = input?.email === undefined || input?.email === null ? null : str(input.email, 'email', { max: 254 }).toLowerCase();
  if (email && !EMAIL.test(email)) fail(400, 'invalid_input', 'email is invalid');
  const maxUses = input?.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) fail(400, 'invalid_input', 'maxUses must be 1-10000');
  const hours = input?.expiresInHours ?? 24 * 14;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) fail(400, 'invalid_input', 'expiresInHours must be up to 90 days');
  const value = token();
  const { rows: [row] } = await pool.query('INSERT INTO invitations (event_id, token_hash, email, max_uses, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expires_at',
    [event.id, sha256(value), email, maxUses, new Date(now.getTime() + hours * 3600_000), user.id]);
  return { id: row.id, token: value, path: `/invite/${value}`, email, maxUses, expiresAt: row.expires_at.toISOString() };
}

export async function revokeInvitation(pool, user, eventId, invitationId) {
  const event = await eventForOrganizer(pool, user, eventId);
  const { rowCount } = await pool.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND event_id = $2 AND revoked_at IS NULL', [String(invitationId), event.id]);
  if (!rowCount) fail(404, 'not_found', 'Invitation not found');
  return { revoked: true };
}

/** Invitation lookup reveals only the event title/time, never other attendees. Invalid, expired and revoked links look the same. */
export async function previewInvitation(pool, invitationToken) {
  const invitation = await validInvitation(pool, invitationToken);
  const { rows: [event] } = await pool.query('SELECT title, slug, starts_at, ends_at, timezone, status FROM events WHERE id = $1', [invitation.event_id]);
  return { event: { title: event.title, slug: event.slug, startsAt: event.starts_at.toISOString(), endsAt: event.ends_at.toISOString(), timezone: event.timezone, status: event.status }, requiresEmail: Boolean(invitation.email) };
}

async function validInvitation(db, invitationToken, lock = false) {
  if (typeof invitationToken !== 'string' || invitationToken.length < 20 || invitationToken.length > 100) fail(404, 'invalid_invitation', 'This invitation link is not valid');
  const { rows: [invitation] } = await db.query(`SELECT * FROM invitations WHERE token_hash = $1${lock ? ' FOR UPDATE' : ''}`, [sha256(invitationToken)]);
  if (!invitation || invitation.revoked_at || invitation.expires_at <= new Date()) fail(404, 'invalid_invitation', 'This invitation link is not valid');
  return invitation;
}

/**
 * Accept an invitation. A signed-in account is bound to the invitation (and must
 * match its email when one is set). Without a session a time-limited guest
 * identity is created for this invitation only. Replays by the same user are idempotent.
 */
export async function acceptInvitation(pool, user, invitationToken, input, config) {
  return transaction(pool, async client => {
    const invitation = await validInvitation(client, invitationToken, true);
    const { rows: [event] } = await client.query('SELECT status FROM events WHERE id = $1', [invitation.event_id]);
    if (event.status !== 'published') fail(409, 'not_open', 'Registration is not open for this event');
    let actor = user;
    let session = null;
    if (!actor) {
      if (invitation.email) fail(401, 'unauthenticated', 'Sign in with the invited email address to accept');
      const displayName = str(input?.displayName, 'displayName', { max: 80 });
      const { rows: [guest] } = await client.query("INSERT INTO users (display_name, kind, guest_expires_at) VALUES ($1, 'guest', now() + make_interval(days => $2)) RETURNING *", [displayName, config.guestDays]);
      actor = publicUser(guest);
      session = await createSession(client, guest.id, Math.min(config.sessionHours, config.guestDays * 24));
    } else if (invitation.email && invitation.email !== actor.email) {
      fail(403, 'wrong_identity', 'This invitation was issued to a different email address');
    }
    const redeemed = await client.query('SELECT 1 FROM invitation_redemptions WHERE invitation_id = $1 AND user_id = $2', [invitation.id, actor.id]);
    if (!redeemed.rowCount) {
      if (invitation.uses >= invitation.max_uses) fail(410, 'invitation_used', 'This invitation has already been used');
      await client.query('UPDATE invitations SET uses = uses + 1 WHERE id = $1', [invitation.id]);
      await client.query('INSERT INTO invitation_redemptions (invitation_id, user_id) VALUES ($1, $2)', [invitation.id, actor.id]);
    }
    return { user: actor, session, eventId: invitation.event_id, invitationId: invitation.id };
  }).then(async result => {
    const registration = await register(pool, result.user, result.eventId, { invitationId: result.invitationId });
    return { user: result.user, session: result.session, eventId: result.eventId, registration };
  });
}

export async function checkIn(pool, user, eventId, attendeeId) {
  const event = await eventForOrganizer(pool, user, eventId);
  const { rowCount } = await pool.query("UPDATE registrations SET checked_in_at = COALESCE(checked_in_at, now()), updated_at = now() WHERE event_id = $1 AND user_id = $2 AND status = 'registered'", [event.id, String(attendeeId)]);
  if (!rowCount) fail(404, 'not_found', 'No registered attendee with that id');
  return { checkedIn: true };
}

export async function listAttendees(pool, user, eventId) {
  const event = await eventForOrganizer(pool, user, eventId);
  const { rows } = await pool.query('SELECT u.id, u.display_name, u.kind, r.status, r.checked_in_at FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.event_id = $1 ORDER BY r.status, r.created_at', [event.id]);
  return rows.map(row => ({ id: row.id, displayName: row.display_name, kind: row.kind, status: row.status, checkedInAt: row.checked_in_at?.toISOString() ?? null }));
}
