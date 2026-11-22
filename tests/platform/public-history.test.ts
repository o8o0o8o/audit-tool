/** A public scan's report has no History, and public scans are in no other audit's History. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { audits } from '../../web/db/schema';
import { auditHistory, auditHistoryIds } from '../../web/lib/core/render-report';
import { findOrCreateSite } from '../../web/lib/core/sites';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

void test(
  'history: none for a public scan, and public scans are left out of the others',
  { skip: SKIP_DB },
  async () => {
    const site = await findOrCreateSite(t.db, `h${randomUUID().slice(0, 8)}.example`);
    const add = async (source: string, day: number) => {
      const id = randomUUID();
      await t.db.insert(audits).values({
        id,
        siteId: site.id,
        mode: 'quick',
        targetUrl: `https://${site.host}`,
        profile: 'standard',
        profileHash: id,
        comparableKey: 'same',
        status: 'succeeded',
        source,
        currentAttempt: 1,
        finishedAt: new Date(Date.UTC(2026, 0, day)),
      });
      return (await t.db.select().from(audits).where(eq(audits.id, id)))[0]!;
    };
    const internal1 = await add('internal', 1);
    const public1 = await add('public', 2);
    const api1 = await add('api', 3);
    const public2 = await add('public', 4);
    const internal2 = await add('internal', 5);

    assert.deepEqual(await auditHistoryIds(t.db, public2), []);
    assert.deepEqual(await auditHistory(t.db, public2), []);
    assert.deepEqual((await auditHistoryIds(t.db, internal2)).sort(), [internal1.id, api1.id].sort());
    assert.ok(!(await auditHistoryIds(t.db, internal2)).includes(public1.id));
  },
);
