// XLR8 HTTP server: JSON API, static application shell and health endpoint.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, publicConfig, engineStatus } from './config.js';
import { createPool } from './db.js';
import * as d from './domain.js';

const PUBLIC = resolve(import.meta.dirname, '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin'
};
const COOKIE = 'xlr8_session';

/** Fixed-window limiter per client and bucket (in-memory; one instance on the free plan). */
export function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return key => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) { hits.set(key, { start: t, count: 1 }); if (hits.size > 10_000) hits.clear(); return true; }
    entry.count++;
    return entry.count <= limit;
  };
}

function cookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const index = part.indexOf('='); if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
  return out;
}

async function body(request) {
  if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) throw new d.AppError(415, 'unsupported_media_type', 'Send application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new d.AppError(413, 'too_large', 'Request body too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new d.AppError(400, 'invalid_json', 'Malformed JSON'); }
}

export function createApp({ config, pool }) {
  const authLimit = createLimiter({ limit: 20, windowMs: 60_000 });
  const inviteLimit = createLimiter({ limit: 30, windowMs: 60_000 });
  const secure = config.production;
  const sessionCookie = (value, maxAgeSeconds) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;

  const routes = [
    ['GET', /^\/api\/status$/, async () => ({ engine: engineStatus(config), database: await dbOk() ? 'available' : 'unavailable' })],
    ['POST', /^\/api\/auth\/signup$/, async ({ json, ip, reply }) => { limit(authLimit, ip); const r = await d.signUp(db(), await json(), config); reply.cookie = sessionCookie(r.session, config.sessionHours * 3600); return { user: r.user }; }],
    ['POST', /^\/api\/auth\/login$/, async ({ json, ip, reply }) => { limit(authLimit, ip); const r = await d.logIn(db(), await json(), config); reply.cookie = sessionCookie(r.session, config.sessionHours * 3600); return { user: r.user }; }],
    ['POST', /^\/api\/auth\/logout$/, async ({ token, reply }) => { await d.logOut(db(), token); reply.cookie = sessionCookie('', 0); return { ok: true }; }],
    ['POST', /^\/api\/auth\/logout-all$/, async ({ user, reply }) => { if (!user) throw new d.AppError(401, 'unauthenticated', 'Sign in first'); await d.logOutAll(db(), user); reply.cookie = sessionCookie('', 0); return { ok: true }; }],
    ['GET', /^\/api\/me$/, async ({ user }) => ({ user, organizations: user ? await d.listMyOrganizations(db(), user) : [] })],
    ['POST', /^\/api\/orgs$/, async ({ user, json }) => d.createOrganization(db(), user, await json())],
    ['POST', /^\/api\/orgs\/([a-z0-9-]+)\/members$/, async ({ user, json, m }) => d.addMember(db(), user, m[1], await json())],
    ['GET', /^\/api\/orgs\/([a-z0-9-]+)\/events$/, async ({ user, m }) => ({ events: await d.listOrganizationEvents(db(), user, m[1]) })],
    ['POST', /^\/api\/orgs\/([a-z0-9-]+)\/events$/, async ({ user, json, m }) => d.createEvent(db(), user, m[1], await json())],
    ['GET', /^\/api\/events$/, async () => ({ events: await d.listPublicEvents(db()) })],
    ['GET', /^\/api\/events\/by-slug\/([a-z0-9-]+)$/, async ({ user, m }) => d.getEvent(db(), user, m[1])],
    ['PATCH', /^\/api\/events\/([0-9a-f-]{36})$/, async ({ user, json, m }) => d.updateEvent(db(), user, m[1], await json())],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/publish$/, async ({ user, m }) => d.setEventStatus(db(), user, m[1], 'published')],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/cancel$/, async ({ user, m }) => d.setEventStatus(db(), user, m[1], 'cancelled')],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/sessions$/, async ({ user, json, m }) => d.addSession(db(), user, m[1], await json())],
    ['PATCH', /^\/api\/events\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})$/, async ({ user, json, m }) => d.updateSession(db(), user, m[1], m[2], await json())],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/registration$/, async ({ user, m }) => d.register(db(), user, m[1])],
    ['DELETE', /^\/api\/events\/([0-9a-f-]{36})\/registration$/, async ({ user, m }) => d.cancelRegistration(db(), user, m[1])],
    ['GET', /^\/api\/events\/([0-9a-f-]{36})\/attendees$/, async ({ user, m }) => ({ attendees: await d.listAttendees(db(), user, m[1]) })],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/attendees\/([0-9a-f-]{36})\/check-in$/, async ({ user, m }) => d.checkIn(db(), user, m[1], m[2])],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/invitations$/, async ({ user, json, m }) => d.createInvitation(db(), user, m[1], await json())],
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/invitations\/([0-9a-f-]{36})\/revoke$/, async ({ user, m }) => d.revokeInvitation(db(), user, m[1], m[2])],
    ['GET', /^\/api\/invitations\/([A-Za-z0-9_-]{20,100})$/, async ({ ip, m }) => { limit(inviteLimit, ip); return d.previewInvitation(db(), m[1]); }],
    ['POST', /^\/api\/invitations\/([A-Za-z0-9_-]{20,100})\/accept$/, async ({ user, json, ip, m, reply }) => {
      limit(inviteLimit, ip);
      const r = await d.acceptInvitation(db(), user, m[1], await json(), config);
      if (r.session) reply.cookie = sessionCookie(r.session, Math.min(config.sessionHours, config.guestDays * 24) * 3600);
      return { user: r.user, eventId: r.eventId, registration: r.registration };
    }],
    // C01: room entry requires the engine release; this is the explicit unavailable state.
    ['POST', /^\/api\/events\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})\/join$/, async () => { throw new d.AppError(503, 'engine_unavailable', engineStatus(config).reason ?? 'Engine unavailable'); }]
  ];

  function db() { if (!pool) throw new d.AppError(503, 'database_unavailable', 'The database is not configured'); return pool; }
  async function dbOk() { if (!pool) return false; try { await pool.query('SELECT 1'); return true; } catch { return false; } }
  function limit(limiter, ip) { if (!limiter(ip)) throw new d.AppError(429, 'rate_limited', 'Too many requests; try again shortly'); }

  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site';
    const expected = config.publicOrigin || `${secure ? 'https' : 'http'}://${request.headers.host}`;
    return origin === expected;
  }

  async function handleApi(request, response, url) {
    const reply = { cookie: null };
    let status = 200;
    let payload;
    try {
      if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request)) throw new d.AppError(403, 'cross_origin', 'Cross-origin requests are not allowed');
      const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
      if (!route) throw new d.AppError(404, 'not_found', 'Unknown API route');
      const token = cookies(request.headers.cookie)[COOKIE];
      const user = pool && token ? await d.authenticate(pool, token) : null;
      const ip = (config.production ? String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || request.socket.remoteAddress || 'unknown';
      payload = await route[2]({ request, json: () => body(request), user, token, ip, reply, m: url.pathname.match(route[1]) });
      if (request.method === 'POST' && /\/(orgs|events|sessions|invitations)$/.test(url.pathname)) status = 201;
    } catch (error) {
      if (error instanceof d.AppError) { status = error.status; payload = { error: { code: error.code, message: error.message } }; }
      else if (error?.code === '23505') { status = 409; payload = { error: { code: 'conflict', message: 'That record already exists' } }; }
      else { status = 500; payload = { error: { code: 'internal', message: 'Unexpected error' } }; console.error(error); }
    }
    const headers = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (reply.cookie) headers['set-cookie'] = reply.cookie;
    response.writeHead(status, headers).end(JSON.stringify(payload));
  }

  async function handleStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, SECURITY_HEADERS).end(); return; }
    let path = url.pathname;
    if (path === '/config.json') { response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(publicConfig(config))); return; }
    if (!extname(path)) path = '/index.html'; // client-side routes: /, /events/:slug, /invite/:token, /org/:slug
    const file = resolve(PUBLIC, '.' + path);
    if (!file.startsWith(PUBLIC + sep)) { response.writeHead(404, SECURITY_HEADERS).end(); return; }
    try {
      const data = await readFile(file);
      response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' }).end('Not found'); }
  }

  return createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { response.writeHead(400).end(); return; }
    if (url.pathname === '/healthz') {
      const database = await dbOk();
      response.writeHead(database ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: database, database: database ? 'available' : 'unavailable', engine: engineStatus(config).state }));
      return;
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
    return handleStatic(request, response, url);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  const pool = config.databaseUrl ? createPool(config.databaseUrl) : null;
  createApp({ config, pool }).listen(config.port, () => console.log(`XLR8 listening on :${config.port} (database ${pool ? 'configured' : 'absent'}, engine ${engineStatus(config).state})`));
}
