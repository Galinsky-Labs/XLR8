import pg from 'pg';

// bigint counts as numbers (counts here are far below 2^53).
pg.types.setTypeParser(20, value => Number(value));

export function createPool(connectionString, max = 5) {
  const ssl = /sslmode=require|neon\.tech/.test(connectionString) ? { rejectUnauthorized: true } : undefined;
  return new pg.Pool({ connectionString, max, ssl, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
