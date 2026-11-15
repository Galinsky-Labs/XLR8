import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const adminUrl = process.env.TEST_DATABASE_URL ?? '';
export const skip = adminUrl ? false : 'TEST_DATABASE_URL is not set (needs a real PostgreSQL)';
export const config = Object.freeze({ production: false, sessionHours: 12, guestDays: 7, engineServiceUrl: '', publicOrigin: '' });

/** Fresh database per test file so tests never share state. */
export async function freshDatabase() {
  const name = `xlr8_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (let attempt = 0; ; attempt++) {
    try { await admin.query(`CREATE DATABASE ${name}`); break; } catch (error) {
      // 55006: template1 briefly busy while another test database is created or dropped.
      if (error.code !== '55006' || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 25);
  await migrate(pool);
  return {
    pool, url: url.toString(),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    }
  };
}

let counter = 0;
export const unique = prefix => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
export const iso = (offsetHours, base = Date.UTC(2027, 2, 1, 9)) => new Date(base + offsetHours * 3600_000).toISOString();
