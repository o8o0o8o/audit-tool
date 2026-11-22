/** Retention of page data (design §9): old audits lose their pages and keep their findings and reports. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { tempStore } from './helpers';
import { artifacts, auditRunData, audits, pages, scores } from '../../web/db/schema';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { dropOldPageData, pageDataDays, runRetention } from '../../web/lib/core/retention';
import { renderReportHtml } from '../../web/lib/core/render-report';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
});

const DAY = 86400_000;
const NOW = new Date('2026-11-22T12:00:00Z');

async function makeAudit(files: ReturnType<typeof tempStore>['store'], status: string, finishedDaysAgo: number | null) {
  const site = await findOrCreateSite(t.db, `r${randomUUID().slice(0, 8)}.example`);
  const id = randomUUID();
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: 'full',
    targetUrl: `https://${site.host}`,
    profile: 'standard',
    profileHash: id,
    comparableKey: 'k',
    source: 'internal',
    status,
    currentAttempt: 1,
    finishedAt: finishedDaysAgo == null ? null : new Date(NOW.getTime() - finishedDaysAgo * DAY),
  });
  await t.db.insert(pages).values([
    { auditId: id, chunk: 1, url: `https://${site.host}/` },
    { auditId: id, chunk: 1, url: `https://${site.host}/about` },
  ]);
  await t.db.insert(auditRunData).values([
    { auditId: id, name: 'manifest', data: {} },
    { auditId: id, name: 'analysis', data: {} },
  ]);
  await t.db.insert(scores).values({ auditId: id, category: 'overall', score: 71 });
  const prefix = `audits/${id}/1/`;
  const put = (rel: string) => files.put(prefix + rel, new Uint8Array([1]));
  for (const rel of [
    'model/site.json.gz',
    'model/run-data.json.gz',
    'model/pages-0001.ndjson.gz',
    'model/pages-0002.ndjson.gz',
    'raw/run.tar.gz',
    'site.example.html',
    'audit-report.md',
    'evidence/home/screenshot.mobile.png',
  ])
    await put(rel);
  const art = (kind: string, rel: string) => ({
    auditId: id,
    kind,
    blobKey: prefix + rel,
    bytes: 1,
    sha256: 'a'.repeat(64),
  });
  await t.db
    .insert(artifacts)
    .values([
      art('raw_archive', 'raw/run.tar.gz'),
      art('report_html', 'site.example.html'),
      art('report_md', 'audit-report.md'),
      art('screenshot', 'evidence/home/screenshot.mobile.png'),
    ]);
  return id;
}

async function state(files: ReturnType<typeof tempStore>['store'], id: string) {
  const keys: string[] = [];
  for await (const f of files.list(`audits/${id}/`)) keys.push(f.key.slice(`audits/${id}/1/`.length));
  const [audit] = await t.db.select().from(audits).where(eq(audits.id, id));
  return {
    pages: (await t.db.select().from(pages).where(eq(pages.auditId, id))).length,
    runData: (await t.db.select().from(auditRunData).where(eq(auditRunData.auditId, id))).length,
    scores: (await t.db.select().from(scores).where(eq(scores.auditId, id))).length,
    deletedArtifacts: (await t.db.select().from(artifacts).where(eq(artifacts.auditId, id)))
      .filter((a) => a.deletedAt)
      .map((a) => a.kind),
    droppedAt: audit!.pagesDroppedAt,
    keys: keys.sort(),
  };
}

void test('page data: the setting is a number of days; 0 keeps it for ever', () => {
  assert.equal(pageDataDays({}), 90);
  assert.equal(pageDataDays({ PAGE_DATA_RETENTION_DAYS: '30' }), 30);
  assert.equal(pageDataDays({ PAGE_DATA_RETENTION_DAYS: '0' }), 0);
  for (const bad of ['', 'soon', '-5', '1.5']) assert.equal(pageDataDays({ PAGE_DATA_RETENTION_DAYS: bad }), 90, bad);
});

void test(
  'page data: an audit older than 90 days loses its pages and keeps findings, scores and reports',
  { skip: SKIP_DB },
  async () => {
    const files = tempStore();
    try {
      const old = await makeAudit(files.store, 'succeeded', 91);
      const oldFailed = await makeAudit(files.store, 'failed', 200);
      const recent = await makeAudit(files.store, 'succeeded', 89);
      const running = await makeAudit(files.store, 'running', null);
      const fresh = await state(files.store, recent);

      assert.equal(await dropOldPageData(t.db, files.store, { now: NOW }), 2);

      for (const id of [old, oldFailed]) {
        const s = await state(files.store, id);
        assert.equal(s.pages, 0);
        assert.equal(s.runData, 0);
        assert.equal(s.scores, 1, 'scores stay');
        assert.deepEqual(s.deletedArtifacts, ['raw_archive']);
        assert.equal(s.droppedAt?.toISOString(), NOW.toISOString());
        assert.deepEqual(s.keys, [
          'audit-report.md',
          'evidence/home/screenshot.mobile.png',
          'model/site.json.gz',
          'site.example.html',
        ]);
      }
      for (const id of [recent, running]) assert.deepEqual(await state(files.store, id), { ...fresh, droppedAt: null });

      // The report of such an audit is the HTML the run stored: nothing is rendered from no pages.
      assert.equal(await renderReportHtml(t.db, files.store, old), null);

      // A second run finds nothing; the whole retention step reports the count.
      assert.equal(await dropOldPageData(t.db, files.store, { now: NOW }), 0);
      const later = new Date(NOW.getTime() + 2 * DAY);
      assert.equal((await runRetention(t.db, files.store, later)).pageData, 1, 'the 89-day audit, two days on');
      assert.equal((await state(files.store, recent)).pages, 0);
    } finally {
      files.cleanup();
    }
  },
);

void test(
  'page data: 0 days deletes nothing, and a run stopped halfway is finished by the next',
  { skip: SKIP_DB },
  async () => {
    const files = tempStore();
    try {
      const id = await makeAudit(files.store, 'succeeded', 400);
      assert.equal(await dropOldPageData(t.db, files.store, { now: NOW, days: 0 }), 0);
      assert.equal((await state(files.store, id)).pages, 2);
      // Files already gone, rows not yet: as after a crash between the two.
      await files.store.delete([`audits/${id}/1/model/pages-0001.ndjson.gz`, `audits/${id}/1/raw/run.tar.gz`]);
      assert.equal(await dropOldPageData(t.db, files.store, { now: NOW }), 1);
      const s = await state(files.store, id);
      assert.equal(s.pages, 0);
      assert.ok(s.droppedAt);
      assert.ok(!s.keys.some((k) => k.startsWith('model/pages-') || k.startsWith('raw/')));
    } finally {
      files.cleanup();
    }
  },
);
