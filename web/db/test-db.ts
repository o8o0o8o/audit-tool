/** Test-only: a private schema with the migrations applied. Lives in web/ so it resolves web/'s packages. */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { runMigrations } from './migrate';
import type { Db } from './client';

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  schemaName: string;
  close(): Promise<void>;
}

export async function createTestDb(url: string): Promise<TestDb> {
  const schemaName = `t_${randomBytes(6).toString('hex')}`;
  await runMigrations(url, schemaName);
  const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schemaName}` });
  return {
    db: drizzle(pool, { schema }),
    pool,
    schemaName,
    async close() {
      await pool.query(`drop schema "${schemaName}" cascade`);
      await pool.end();
    },
  };
}

// Query helpers for tests under tests/platform/, which cannot resolve web/'s packages themselves.
export { and, desc, eq, sql } from 'drizzle-orm';
