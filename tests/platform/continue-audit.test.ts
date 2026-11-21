/** Continuing an audit the page cap stopped: who may, what the new audit carries, what its worker may read. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { artifacts, audits } from '../../web/db/schema';
import { continueAudit, getAudit, listAudits, startAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import type { Principal } from '../../web/lib/core/principal';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { continueFile, continueSource } from '../../web/lib/core/worker';
import type { FileStore } from '../../web/lib/platform/types';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

const code = (c: string) => (e: unknown) => e instanceof CoreError && e.code === c;
const internal: Principal = { kind: 'internal', label: 'internal' };
const CAP = { cap: 5000, pagesLoaded: 5000, sitemapUrls: 9000, sitemapHeld: 4500 };

async function capped(extra: Partial<typeof audits.$inferInsert> = {}, withArchive = true) {
  const site = await findOrCreateSite(t.db, `c${randomUUID().slice(0, 8)}.example`);
  const id = randomUUID();
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: 'full',
    targetUrl: `https://${site.host}`,
    profile: 'standard',
    profileHash: id,
    comparableKey: 'k',
    status: 'succeeded',
    source: 'internal',
    currentAttempt: 1,
    options: { perf: true, visual: true },
    pageCap: CAP,
    ...extra,
  });
  const file = (kind: string, rel: string) => ({
    auditId: id,
    kind,
    blobKey: `audits/${id}/1/${rel}`,
    bytes: 10,
    sha256: 'a'.repeat(64),
    createdAt: new Date(),
  });
  if (withArchive) await t.db.insert(artifacts).values(file('raw_archive', 'model/raw-archive.tar.gz'));
  await t.db
    .insert(artifacts)
    .values([file('screenshot', 'evidence/home/screenshot.mobile.png'), file('report_md', 'audit-report.md')]);
  return id;
}

void test(
  'continue: refused unless a succeeded full audit was stopped by the cap and its run is kept',
  { skip: SKIP_DB },
  async () => {
    await assert.rejects(
      continueAudit(t.db, internal, { audit_id: await capped({ pageCap: null }) }),
      code('invalid_input'),
    );
    await assert.rejects(
      continueAudit(t.db, internal, { audit_id: await capped({ status: 'failed' }) }),
      code('audit_not_ready'),
    );
    await assert.rejects(
      continueAudit(t.db, internal, { audit_id: await capped({ mode: 'quick' }) }),
      code('invalid_input'),
    );
    await assert.rejects(continueAudit(t.db, internal, { audit_id: await capped({}, false) }), code('not_generated'));
    await assert.rejects(
      continueAudit(t.db, internal, { audit_id: await capped(), max_pages: 5000 }),
      code('invalid_input'),
    );
    const reader: Principal = {
      kind: 'client',
      clientId: randomUUID(),
      name: 'r',
      scopes: ['audits:read'],
    };
    await assert.rejects(continueAudit(t.db, reader, { audit_id: await capped() }));
  },
);

void test(
  'continue: a new audit with the same options, a higher cap and the audit it continues',
  { skip: SKIP_DB },
  async () => {
    const parent = await capped();
    const res = await continueAudit(t.db, internal, { audit_id: parent });
    assert.equal(res.status, 'queued');
    assert.notEqual(res.audit_id, parent);
    const [row] = await t.db.select().from(audits).where(eq(audits.id, res.audit_id));
    const o = row!.options as Record<string, unknown>;
    assert.equal(o.continueFrom, parent);
    assert.equal(o.maxPages, 10000);
    assert.equal(o.perf, true);
    assert.equal(o.visual, true);
    assert.equal(row!.mode, 'full');
    // The same request again is the audit already queued, not a third one.
    assert.equal((await continueAudit(t.db, internal, { audit_id: parent })).audit_id, res.audit_id);
    assert.equal((await continueAudit(t.db, internal, { audit_id: await capped(), max_pages: 0 })).status, 'queued');

    const view = await getAudit(t.db, internal, res.audit_id);
    assert.equal(view.continued_from, parent);
    assert.deepEqual((await getAudit(t.db, internal, parent)).page_cap, {
      cap: 5000,
      pages_loaded: 5000,
      sitemap_held: 4500,
    });
    const listed = (await listAudits(t.db, internal, { limit: 500 })).find((a) => a.audit_id === parent);
    assert.equal(listed?.page_cap?.cap, 5000);
  },
);

void test('continue: a caller cannot name the audit to continue through start_audit', { skip: SKIP_DB }, async () => {
  const parent = await capped();
  const res = await startAudit(t.db, internal, {
    url: `https://s${randomUUID().slice(0, 8)}.example`,
    mode: 'full',
    options: { continueFrom: parent },
  });
  const [row] = await t.db.select().from(audits).where(eq(audits.id, res.audit_id));
  assert.equal((row!.options as Record<string, unknown>).continueFrom, null);
});

void test(
  'continue: the worker reads only the run and evidence of the audit it continues',
  { skip: SKIP_DB },
  async () => {
    const parent = await capped();
    const other = await capped();
    const child = (await continueAudit(t.db, internal, { audit_id: parent })).audit_id;
    const source = await continueSource(t.db, { auditId: child, attempt: 1 });
    assert.equal(source?.audit_id, parent);
    assert.deepEqual(source!.files.map((f) => f.path).sort(), [
      'evidence/home/screenshot.mobile.png',
      'model/raw-archive.tar.gz',
    ]);
    assert.equal(await continueSource(t.db, { auditId: parent, attempt: 1 }), null);

    const store = { get: async (key: string) => ({ body: key, bytes: key.length }) } as unknown as FileStore;
    const s = { auditId: child, attempt: 1 };
    assert.ok(await continueFile(t.db, store, s, `audits/${parent}/1/model/raw-archive.tar.gz`));
    await assert.rejects(continueFile(t.db, store, s, `audits/${parent}/1/audit-report.md`), code('forbidden'));
    await assert.rejects(continueFile(t.db, store, s, `audits/${other}/1/model/raw-archive.tar.gz`), code('forbidden'));
    await assert.rejects(
      continueFile(t.db, store, { auditId: parent, attempt: 1 }, `audits/${parent}/1/model/raw-archive.tar.gz`),
      code('forbidden'),
    );
  },
);
