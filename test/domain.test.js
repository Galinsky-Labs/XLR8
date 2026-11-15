import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, skip, config, unique, iso } from './helpers.js';
import * as d from '../src/domain.js';

let db;
before(async () => { if (!skip) db = await freshDatabase(); });
after(async () => { await db?.drop(); });

const account = async (name = 'Ada') => {
  const r = await d.signUp(db.pool, { email: `${unique('u')}@example.test`, password: 'correct horse battery', displayName: name }, config);
  return { ...r, user: await d.authenticate(db.pool, r.session) };
};
const orgFor = async owner => d.createOrganization(db.pool, owner.user, { slug: unique('org-'), name: 'Org' });
const eventFor = async (owner, org, extra = {}) => d.createEvent(db.pool, owner.user, org.slug, { slug: unique('ev-'), title: 'Summit', timezone: 'Europe/Berlin', startsAt: iso(0), endsAt: iso(8), visibility: 'public', capacity: 5, ...extra });
const code = c => error => error instanceof d.AppError && error.code === c;

// ---------- C02 identity ----------
test('sign-up, login, logout and session expiry', { skip }, async () => {
  const email = `${unique('a')}@Example.test`;
  const signed = await d.signUp(db.pool, { email, password: 'correct horse battery', displayName: 'Ada' }, config);
  assert.equal(signed.user.email, email.toLowerCase());
  await assert.rejects(d.signUp(db.pool, { email: email.toUpperCase(), password: 'another long pass', displayName: 'X' }, config), code('email_taken'));
  await assert.rejects(d.signUp(db.pool, { email: 'b@example.test', password: 'short', displayName: 'X' }, config), code('weak_password'));
  await assert.rejects(d.logIn(db.pool, { email, password: 'wrong password!!' }, config), code('invalid_credentials'));
  await assert.rejects(d.logIn(db.pool, { email: 'nobody@example.test', password: 'whatever12345' }, config), code('invalid_credentials'));
  const login = await d.logIn(db.pool, { email, password: 'correct horse battery' }, config);
  assert.equal((await d.authenticate(db.pool, login.session)).id, signed.user.id);
  await d.logOut(db.pool, login.session);
  assert.equal(await d.authenticate(db.pool, login.session), null, 'logout invalidates the session');
  assert.ok(await d.authenticate(db.pool, signed.session), 'other tab stays signed in');
  await db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
  assert.equal(await d.authenticate(db.pool, signed.session), null, 'expired sessions are rejected');
  assert.equal(await d.authenticate(db.pool, 'x'.repeat(10)), null);
});

test('logout everywhere revokes every tab', { skip }, async () => {
  const a = await account();
  const second = await d.logIn(db.pool, { email: a.user.email, password: 'correct horse battery' }, config);
  await d.logOutAll(db.pool, a.user);
  assert.equal(await d.authenticate(db.pool, a.session), null);
  assert.equal(await d.authenticate(db.pool, second.session), null);
});

test('organizations: cross-organization access is denied and roles are server-side', { skip }, async () => {
  const owner = await account('Owner');
  const outsider = await account('Outsider');
  const org = await orgFor(owner);
  await assert.rejects(d.listOrganizationEvents(db.pool, outsider.user, org.slug), code('not_found'));
  await assert.rejects(d.createEvent(db.pool, outsider.user, org.slug, { slug: unique('x-'), title: 'X', timezone: 'UTC', startsAt: iso(0), endsAt: iso(1), visibility: 'public', capacity: 1 }), code('not_found'));
  const member = await account('Member');
  await d.addMember(db.pool, owner.user, org.slug, { email: member.user.email, role: 'member' });
  await assert.rejects(d.createEvent(db.pool, member.user, org.slug, { slug: unique('x-'), title: 'X', timezone: 'UTC', startsAt: iso(0), endsAt: iso(1), visibility: 'public', capacity: 1 }), code('forbidden'));
  await assert.rejects(d.addMember(db.pool, member.user, org.slug, { email: member.user.email, role: 'organizer' }), code('forbidden'), 'members cannot promote themselves');
  await assert.rejects(d.addMember(db.pool, owner.user, org.slug, { email: member.user.email, role: 'owner' }), code('invalid_input'), 'owner role cannot be granted by request');
  await d.addMember(db.pool, owner.user, org.slug, { email: member.user.email, role: 'organizer' });
  assert.ok(await eventFor(member, org));
  // Spoofed role/org fields in the body are ignored.
  const created = await d.createOrganization(db.pool, member.user, { slug: unique('o-'), name: 'Mine', role: 'member', organizationId: org.id });
  assert.equal(created.role, 'owner');
});

// ---------- C03 events and sessions ----------
test('draft events are invisible; publishing exposes only published sessions', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org);
  const visitor = await account('Visitor');
  await assert.rejects(d.getEvent(db.pool, visitor.user, event.slug), code('not_found'));
  await assert.rejects(d.getEvent(db.pool, null, event.slug), code('not_found'));
  assert.ok(!(await d.listPublicEvents(db.pool)).some(e => e.id === event.id));
  await d.addSession(db.pool, owner.user, event.id, { title: 'Keynote', kind: 'keynote', startsAt: iso(0), endsAt: iso(1), publish: true });
  await d.addSession(db.pool, owner.user, event.id, { title: 'Overlapping workshop', kind: 'workshop', startsAt: iso(0.5), endsAt: iso(2), publish: true });
  await d.addSession(db.pool, owner.user, event.id, { title: 'Secret draft', kind: 'talk', startsAt: iso(3), endsAt: iso(4) });
  await assert.rejects(d.addSession(db.pool, owner.user, event.id, { title: 'Outside', kind: 'talk', startsAt: iso(7), endsAt: iso(9) }), code('invalid_input'));
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  const seen = await d.getEvent(db.pool, visitor.user, event.slug);
  assert.deepEqual(seen.sessions.map(s => s.title), ['Keynote', 'Overlapping workshop']);
  assert.equal(seen.organizer, false);
  assert.equal(seen.seats.waitlisted, undefined, 'waitlist count is organizer-only');
  assert.equal((await d.getEvent(db.pool, owner.user, event.slug)).sessions.length, 3);
  assert.ok((await d.listPublicEvents(db.pool)).some(e => e.id === event.id));
});

test('private events are not discoverable by outsiders', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org, { visibility: 'private' });
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  const outsider = await account();
  await assert.rejects(d.getEvent(db.pool, outsider.user, event.slug), code('not_found'));
  await assert.rejects(d.register(db.pool, outsider.user, event.id), code('not_found'));
  assert.ok(!(await d.listPublicEvents(db.pool)).some(e => e.id === event.id));
});

test('optimistic conflict detection and stable links through cancellation', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org);
  const results = await Promise.allSettled([
    d.updateEvent(db.pool, owner.user, event.id, { version: event.version, title: 'Edit A' }),
    d.updateEvent(db.pool, owner.user, event.id, { version: event.version, title: 'Edit B' })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'exactly one concurrent edit wins');
  assert.ok(code('version_conflict')(results.find(r => r.status === 'rejected').reason));
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  await d.setEventStatus(db.pool, owner.user, event.id, 'cancelled');
  const cancelled = await d.getEvent(db.pool, null, event.slug);
  assert.equal(cancelled.status, 'cancelled', 'the same link shows an explicit cancellation');
  await assert.rejects(d.setEventStatus(db.pool, owner.user, event.id, 'published'), code('invalid_transition'));
  await assert.rejects(d.updateEvent(db.pool, owner.user, event.id, { version: cancelled.version, title: 'x' }), code('cancelled'));
});

test('session edits use versions and cancellation keeps the session listed', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org);
  const s = await d.addSession(db.pool, owner.user, event.id, { title: 'Talk', kind: 'talk', startsAt: iso(1), endsAt: iso(2), publish: true });
  const moved = await d.updateSession(db.pool, owner.user, event.id, s.id, { version: s.version, startsAt: iso(2), endsAt: iso(3) });
  assert.equal(moved.version, 2);
  await assert.rejects(d.updateSession(db.pool, owner.user, event.id, s.id, { version: 1, title: 'stale' }), code('version_conflict'));
  const cancelled = await d.updateSession(db.pool, owner.user, event.id, s.id, { version: 2, status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  assert.equal((await d.getEvent(db.pool, null, event.slug)).sessions[0].status, 'cancelled');
});

test('time zones: IANA validation and daylight-saving boundaries', { skip }, async () => {
  assert.ok(d.isTimeZone('Europe/Berlin') && d.isTimeZone('America/New_York') && d.isTimeZone('UTC'));
  assert.ok(!d.isTimeZone('Mars/Olympus') && !d.isTimeZone('CEST') && !d.isTimeZone(''));
  // Europe/Berlin switches to summer time at 01:00 UTC on 2027-03-28.
  assert.equal(d.formatInZone(new Date('2027-03-28T00:30:00Z'), 'Europe/Berlin'), '28/03/2027, 01:30 GMT+1');
  assert.equal(d.formatInZone(new Date('2027-03-28T01:30:00Z'), 'Europe/Berlin'), '28/03/2027, 03:30 GMT+2');
  // US fall-back: 01:30 occurs twice on 2027-11-07 in New York.
  assert.equal(d.formatInZone(new Date('2027-11-07T05:30:00Z'), 'America/New_York'), '07/11/2027, 01:30 GMT-4');
  assert.equal(d.formatInZone(new Date('2027-11-07T06:30:00Z'), 'America/New_York'), '07/11/2027, 01:30 GMT-5');
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org, { timezone: 'Europe/Berlin', startsAt: '2027-03-27T22:00:00+01:00', endsAt: '2027-03-28T04:00:00+02:00' });
  assert.equal(event.startsAt, '2027-03-27T21:00:00.000Z');
  assert.equal(new Date(event.endsAt) - new Date(event.startsAt), 5 * 3600_000, 'stored instants span the lost hour correctly');
  await assert.rejects(eventFor(owner, org, { timezone: 'Nowhere/Zone' }), code('invalid_input'));
  await assert.rejects(eventFor(owner, org, { startsAt: '2027-03-01 09:00' }), code('invalid_input'));
});

// ---------- C04 registration, waitlist, invitations ----------
test('registration is idempotent and capacity races never overbook', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org, { capacity: 5 });
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  const people = await Promise.all(Array.from({ length: 20 }, (_, i) => account(`P${i}`)));
  const results = await Promise.all(people.map(p => d.register(db.pool, p.user, event.id)));
  assert.equal(results.filter(r => r.status === 'registered').length, 5);
  assert.equal(results.filter(r => r.status === 'waitlisted').length, 15);
  const again = await Promise.all(people.slice(0, 3).map(p => d.register(db.pool, p.user, event.id)));
  assert.ok(again.every(r => r.idempotent));
  const { rows: [{ registered }] } = await db.pool.query("SELECT count(*) AS registered FROM registrations WHERE event_id = $1 AND status = 'registered'", [event.id]);
  assert.equal(registered, 5);

  // Concurrent cancellations promote from the waitlist in order without overbooking.
  const registeredPeople = people.filter((_, i) => results[i].status === 'registered');
  await Promise.all(registeredPeople.slice(0, 3).map(p => d.cancelRegistration(db.pool, p.user, event.id)));
  const counts = (await db.pool.query("SELECT status, count(*) AS n FROM registrations WHERE event_id = $1 GROUP BY status ORDER BY status", [event.id])).rows;
  assert.deepEqual(counts, [{ status: 'cancelled', n: 3 }, { status: 'registered', n: 5 }, { status: 'waitlisted', n: 12 }]);

  // Raising capacity promotes the next waitlisted people.
  const current = await d.getEvent(db.pool, owner.user, event.slug);
  await d.updateEvent(db.pool, owner.user, event.id, { version: current.version, capacity: 7 });
  assert.equal((await d.getEvent(db.pool, owner.user, event.slug)).seats.registered, 7);

  // Cancel and re-register: back of the waitlist.
  const first = registeredPeople[0];
  const re = await d.register(db.pool, first.user, event.id);
  assert.equal(re.status, 'waitlisted');
});

test('registration requires a published event', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org);
  const p = await account();
  await assert.rejects(d.register(db.pool, owner.user, event.id), code('not_open'));
  await assert.rejects(d.register(db.pool, p.user, event.id), code('not_found'));
});

test('invitations: guest identity, replay, max uses, expiry, revocation and email binding', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org, { visibility: 'private', capacity: 10 });
  const unpublished = await d.createInvitation(db.pool, owner.user, event.id, {});
  await assert.rejects(d.acceptInvitation(db.pool, null, unpublished.token, { displayName: 'Early' }, config), code('not_open'));
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');

  const open = await d.createInvitation(db.pool, owner.user, event.id, { maxUses: 2 });
  const preview = await d.previewInvitation(db.pool, open.token);
  assert.deepEqual(Object.keys(preview).sort(), ['event', 'requiresEmail']);
  assert.ok(!JSON.stringify(preview).includes('registered'), 'lookup does not expose attendees or counts');

  const guest = await d.acceptInvitation(db.pool, null, open.token, { displayName: 'Guest One' }, config);
  assert.equal(guest.user.kind, 'guest');
  assert.equal(guest.registration.status, 'registered');
  const guestUser = await d.authenticate(db.pool, guest.session);
  assert.equal(guestUser.id, guest.user.id);
  assert.equal((await d.getEvent(db.pool, guestUser, event.slug)).registration.status, 'registered', 'invited guest can see the private event');
  const replay = await d.acceptInvitation(db.pool, guestUser, open.token, {}, config);
  assert.ok(replay.registration.idempotent, 'replay by the same identity is idempotent');
  await assert.rejects(d.createOrganization(db.pool, guestUser, { slug: unique('g-'), name: 'G' }), code('account_required'));

  const second = await account('Second');
  await d.acceptInvitation(db.pool, second.user, open.token, {}, config);
  const third = await account('Third');
  await assert.rejects(d.acceptInvitation(db.pool, third.user, open.token, {}, config), code('invitation_used'));

  const bound = await d.createInvitation(db.pool, owner.user, event.id, { email: third.user.email });
  await assert.rejects(d.acceptInvitation(db.pool, null, bound.token, { displayName: 'Imposter' }, config), code('unauthenticated'));
  await assert.rejects(d.acceptInvitation(db.pool, second.user, bound.token, {}, config), code('wrong_identity'));
  assert.equal((await d.acceptInvitation(db.pool, third.user, bound.token, {}, config)).registration.status, 'registered');

  const revoked = await d.createInvitation(db.pool, owner.user, event.id, {});
  await d.revokeInvitation(db.pool, owner.user, event.id, revoked.id);
  await assert.rejects(d.previewInvitation(db.pool, revoked.token), code('invalid_invitation'));
  await assert.rejects(d.acceptInvitation(db.pool, null, revoked.token, { displayName: 'Late' }, config), code('invalid_invitation'));

  const expired = await d.createInvitation(db.pool, owner.user, event.id, { expiresInHours: 1 }, new Date(Date.now() - 2 * 3600_000));
  await assert.rejects(d.previewInvitation(db.pool, expired.token), code('invalid_invitation'));
  await assert.rejects(d.previewInvitation(db.pool, 'A'.repeat(43)), code('invalid_invitation'));

  const outsider = await account();
  await assert.rejects(d.createInvitation(db.pool, outsider.user, event.id, {}), code('not_found'));

  // Guest expiry ends access.
  await db.pool.query("UPDATE users SET guest_expires_at = now() - interval '1 minute' WHERE id = $1", [guest.user.id]);
  assert.equal(await d.authenticate(db.pool, guest.session), null);
});

test('check-in is organizer-only and limited to registered attendees', { skip }, async () => {
  const owner = await account();
  const org = await orgFor(owner);
  const event = await eventFor(owner, org, { capacity: 1 });
  await d.setEventStatus(db.pool, owner.user, event.id, 'published');
  const a = await account('A');
  const b = await account('B');
  await d.register(db.pool, a.user, event.id);
  await d.register(db.pool, b.user, event.id);
  await assert.rejects(d.checkIn(db.pool, a.user, event.id, a.user.id), code('not_found'));
  assert.deepEqual(await d.checkIn(db.pool, owner.user, event.id, a.user.id), { checkedIn: true });
  await assert.rejects(d.checkIn(db.pool, owner.user, event.id, b.user.id), code('not_found'), 'waitlisted people cannot be checked in');
  const attendees = await d.listAttendees(db.pool, owner.user, event.id);
  assert.ok(attendees.find(x => x.id === a.user.id).checkedInAt);
  await assert.rejects(d.listAttendees(db.pool, a.user, event.id), code('not_found'), 'attendee directory is organizer-only');
});
