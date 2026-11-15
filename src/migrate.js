// Forward-only migrations. Each file runs in its own transaction under an
// advisory lock; a failed file rolls back completely and later files do not run.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPool } from './db.js';
import { loadConfig } from './config.js';

export async function migrate(pool, directory = resolve(import.meta.dirname, '../migrations')) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock(7238001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await client.query('SELECT name, sha256 FROM schema_migrations')).rows.map(row => [row.name, row.sha256]));
    const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      if (done.has(name)) {
        if (done.get(name) !== digest) throw new Error(`Applied migration ${name} was modified; add a new migration instead`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [name, digest]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed and was rolled back: ${error.message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7238001)').catch(() => {});
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig();
  if (!config.migrationDatabaseUrl) { console.log('No DATABASE_URL; skipping migrations (service will report database unavailable).'); process.exit(0); }
  const pool = createPool(config.migrationDatabaseUrl, 1);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is current.');
  } finally { await pool.end(); }
}
