import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { freshDatabase, skip, config, unique, iso } from './helpers.js';
import { createApp, createLimiter } from '../src/server.js';
import { loadConfig, publicConfig } from '../src/config.js';

async function listen(app) {
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${app.address().port}`;
}

test('without backends the app shows explicit unavailable states (C01)', async () => {
  const app = createApp({ config, pool: null });
  const base = await listen(app);
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ok: false, database: 'unavailable', engine: 'unavailable' });
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.engine.state, 'unavailable');
    assert.match(status.engine.reason, /R12/);
    assert.equal(status.database, 'unavailable');
    const events = await fetch(`${base}/api/events`);
    assert.equal(events.status, 503);
    assert.equal((await events.json()).error.code, 'database_unavailable');
    const shell = await fetch(`${base}/events/anything`);
    assert.equal(shell.status, 200, 'client routes fall back to the shell');
    assert.match(await shell.text(), /<main id="main"/);
    const join = await fetch(`${base}/api/events/00000000-0000-0000-0000-000000000000/sessions/00000000-0000-0000-0000-000000000000/join`, { method: 'POST' });
    assert.equal(join.status, 503);
    assert.equal((await join.json()).error.code, 'engine_unavailable');
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      const response = await fetch(`${base}${path}`);
      assert.ok(!(await response.text()).includes('"dependencies"'), `${path} must not escape public/`);
    }
  } finally { app.close(); }
});

test('browser config exposes no server secrets', () => {
  const server = loadConfig({ DATABASE_URL: 'postgres://user:supersecret@db/x', PORT: '1', NODE_ENV: 'production' });
  const exposed = JSON.stringify(publicConfig(server));
  assert.ok(!exposed.includes('supersecret') && !exposed.includes('postgres://'));
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL is required/);
});

test('rate limiter allows a bounded burst per key', () => {
  let t = 0;
  const limiter = createLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter('a')), [true, true, true, false]);
  assert.equal(limiter('b'), true);
  t = 1000;
  assert.equal(limiter('a'), true);
});

let db;
before(async () => { if (!skip) db = await freshDatabase(); });
after(async () => { await db?.drop(); });

test('end-to-end HTTP flow with security headers, cookies and origin checks', { skip }, async () => {
  const app = createApp({ config, pool: db.pool });
  const base = await listen(app);
  const jar = { cookie: '' };
  const call = async (path, { method = 'GET', body, origin = base, cookie = jar.cookie, type = 'application/json' } = {}) => {
    const headers = { origin };
    if (body !== undefined) headers['content-type'] = type;
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && cookie === jar.cookie) jar.cookie = setCookie.split(';')[0];
    return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
  };
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const signup = await call('/api/auth/signup', { method: 'POST', body: { email: `${unique('h')}@example.test`, password: 'correct horse battery', displayName: 'Host' } });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    assert.match(signup.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(signup.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!JSON.stringify(signup.json).includes('password'));

    const crossSite = await call('/api/orgs', { method: 'POST', body: { slug: unique('o-'), name: 'X' }, origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error.code, 'cross_origin');
    const wrongType = await call('/api/orgs', { method: 'POST', body: 'slug=x', type: 'application/x-www-form-urlencoded' });
    assert.equal(wrongType.status, 415);
    const huge = await call('/api/orgs', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(70_000) }) });
    assert.equal(huge.status, 413);

    const org = await call('/api/orgs', { method: 'POST', body: { slug: unique('o-'), name: 'Galaxy' } });
    assert.equal(org.status, 201);
    const event = await call(`/api/orgs/${org.json.slug}/events`, { method: 'POST', body: { slug: unique('e-'), title: 'Launch', timezone: 'America/New_York', startsAt: iso(0), endsAt: iso(4), visibility: 'public', capacity: 2 } });
    assert.equal(event.status, 201);
    assert.equal((await call(`/api/events/${event.json.id}/publish`, { method: 'POST' })).status, 200);
    const session = await call(`/api/events/${event.json.id}/sessions`, { method: 'POST', body: { title: 'Opening', kind: 'keynote', startsAt: iso(0), endsAt: iso(1), publish: true } });
    assert.equal(session.status, 201);
    const invitation = await call(`/api/events/${event.json.id}/invitations`, { method: 'POST', body: { maxUses: 1 } });
    assert.equal(invitation.status, 201);

    const anonymous = await call(`/api/events/by-slug/${event.json.slug}`, { cookie: '' });
    assert.equal(anonymous.json.sessions.length, 1);
    assert.equal(anonymous.json.organizer, false);
    const guest = await call(`/api/invitations/${invitation.json.token}/accept`, { method: 'POST', body: { displayName: 'Visitor' }, cookie: 'x' });
    assert.equal(guest.status, 200);
    assert.equal(guest.json.registration.status, 'registered');
    const guestCookie = guest.headers.get('set-cookie').split(';')[0];
    const me = await call('/api/me', { cookie: guestCookie });
    assert.equal(me.json.user.kind, 'guest');
    const join = await call(`/api/events/${event.json.id}/sessions/${session.json.id}/join`, { method: 'POST', cookie: guestCookie });
    assert.equal(join.status, 503, 'rooms report the engine as unavailable');

    const attendees = await call(`/api/events/${event.json.id}/attendees`);
    assert.equal(attendees.json.attendees.length, 1);
    assert.equal((await call(`/api/events/${event.json.id}/attendees`, { cookie: guestCookie })).status, 404, 'guests cannot read the attendee list');

    assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await call('/api/me')).json.user, null);
    const config = await fetch(`${base}/config.json`);
    assert.equal((await config.json()).engine.state, 'unavailable');
  } finally { app.close(); }
});

test('package boundary: no copied engine implementation and exact dependency pins (C01)', async () => {
  const root = resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  const sources = [];
  for (const dir of ['src', 'public']) for (const file of await readdir(resolve(root, dir))) sources.push(await readFile(resolve(root, dir, file), 'utf8'));
  for (const text of sources) {
    assert.ok(!/@babylonjs|rapier|from ['"]@browser-vr-engine\/(?!contracts)/.test(text), 'engine implementation must not be imported or copied into the app');
    assert.ok(!/innerHTML/.test(text), 'client renders user text with textContent only');
  }
  const record = JSON.parse(await readFile(resolve(root, 'docs/engine-dependency.json'), 'utf8'));
  assert.equal(record.repository, 'Galinsky-Labs/Browser-VR-Engine');
  assert.equal(record.requiredRelease, 'BVR-R12');
  assert.equal(record.status, 'unreleased');
});
