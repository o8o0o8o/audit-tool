/**
 * Platform test harness: each test file gets a schema of its own in DATABASE_URL_TEST with the
 * migrations applied, and drops it at the end. Without DATABASE_URL_TEST the tests are skipped.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createTestDb as create, type TestDb } from '../../web/db/test-db';

export type { TestDb };

/** Reads DATABASE_URL_TEST from the environment, else from web/.env.local. */
export function testDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const envFile = path.resolve(__dirname, '../../web/.env.local');
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL_TEST='));
  return line?.slice('DATABASE_URL_TEST='.length).trim() || undefined;
}

export const SKIP_DB = testDatabaseUrl() ? false : 'DATABASE_URL_TEST not set: start `docker compose up -d db` to run platform tests';

export function createTestDb(): Promise<TestDb> {
  const url = testDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL_TEST not set');
  return create(url);
}
