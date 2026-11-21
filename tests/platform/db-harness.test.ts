import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, SKIP_DB } from './db-harness';
import { apiClients, audits, sites } from '../../web/db/schema';

/** Drizzle wraps the pg error; the constraint name is on its cause. */
const violates = (name: string) => (err: unknown) =>
  (err as { cause?: { constraint?: string } }).cause?.constraint === name;

test('harness: migrations run into a private schema; one active audit per client, site and profile', { skip: SKIP_DB }, async () => {
  const t = await createTestDb();
  try {
    const [site] = await t.db.insert(sites).values({ host: 'example.com', registrableDomain: 'example.com' }).returning();
    const [client] = await t.db.insert(apiClients).values({ name: 'c', keyHash: 'h', scopes: ['audits:read'] }).returning();
    const row = {
      siteId: site!.id, mode: 'quick', targetUrl: 'https://example.com/', profile: 'standard',
      profileHash: 'p1', comparableKey: 'k', status: 'queued', source: 'api', createdByClientId: client!.id,
    };
    await t.db.insert(audits).values({ ...row, id: randomUUID() });
    await assert.rejects(t.db.insert(audits).values({ ...row, id: randomUUID() }), violates('audits_active'));
    // a finished audit does not block a new one
    await t.db.update(audits).set({ status: 'succeeded' });
    await t.db.insert(audits).values({ ...row, id: randomUUID() });
    await assert.rejects(t.db.insert(audits).values({ ...row, id: randomUUID(), status: 'bogus' }), violates('audits_status'));
  } finally {
    await t.close();
  }
});
