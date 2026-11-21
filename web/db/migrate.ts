/**
 * Applies db/migrations to a database. Used by `yarn db:migrate` and by the test harness,
 * which passes a schema name so each test file gets its own copy of the tables.
 */
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// web/ runs as CommonJS under tsx, and tests import this file from the repo root.
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(connectionString: string, schemaName?: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (schemaName) {
      await client.query(`create schema if not exists "${schemaName}"`);
      await client.query(`set search_path to "${schemaName}"`);
    }
    await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_DIR,
      ...(schemaName ? { migrationsSchema: schemaName } : {}),
    });
  } finally {
    await client.end();
  }
}
