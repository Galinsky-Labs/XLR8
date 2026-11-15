import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freshDatabase, skip } from './helpers.js';
import { migrate } from '../src/migrate.js';

test('migrations apply forward once, detect edits and roll back a failed file completely', { skip }, async () => {
  const db = await freshDatabase();
  try {
    assert.deepEqual(await migrate(db.pool), [], 're-running is a no-op');
    const tables = (await db.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map(r => r.table_name);
    for (const table of ['users', 'sessions', 'organizations', 'memberships', 'events', 'event_sessions', 'registrations', 'invitations', 'invitation_redemptions', 'schema_migrations']) assert.ok(tables.includes(table), table);

    const dir = await mkdtemp(join(tmpdir(), 'xlr8-mig-'));
    await cp(resolve(import.meta.dirname, '../migrations'), dir, { recursive: true });
    await writeFile(join(dir, '004_bad.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;');
    await assert.rejects(migrate(db.pool, dir), /004_bad\.sql failed and was rolled back/);
    const half = await db.pool.query("SELECT to_regclass('public.half_done') AS t");
    assert.equal(half.rows[0].t, null, 'partial DDL rolled back');
    assert.equal((await db.pool.query("SELECT count(*) FROM schema_migrations WHERE name = '004_bad.sql'")).rows[0].count, 0);

    await writeFile(join(dir, '004_bad.sql'), 'CREATE TABLE half_done (id int);');
    assert.deepEqual(await migrate(db.pool, dir), ['004_bad.sql'], 'fixed migration applies forward');

    await writeFile(join(dir, '001_identity.sql'), '-- edited\n');
    await assert.rejects(migrate(db.pool, dir), /was modified/);
  } finally { await db.drop(); }
});

test('concurrent migrators serialize on the advisory lock', { skip }, async () => {
  const db = await freshDatabase();
  try {
    const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
    assert.deepEqual(results, [[], [], []]);
  } finally { await db.drop(); }
});
