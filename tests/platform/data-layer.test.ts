/**
 * Data-layer review fixes: re-scoring, loader failures, unsafe text, duplicate pages, disclosures
 * loaded out of order, the findings cursor, reloads, deterministic finding codes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { tempStore, writeFixtureRun, type FixtureRunOptions } from './helpers';
import {
  auditDocuments,
  auditRunData,
  audits,
  checkTypes,
  disclosures,
  findings,
  loadProgress,
  pages,
  scores,
} from '../../web/db/schema';
import { loadAudit, MAX_LOAD_ATTEMPTS, runLoader } from '../../web/lib/core/loader';
import { ensureScored, failedMark, noDataMark, rescoreStale, scoringVersion } from '../../web/lib/core/rescore';
import { getSite, listFindings } from '../../web/lib/core/results';
import { internalPrincipal } from '../../web/lib/core/principal';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { buildAuditModel, buildRowParts, readRun } from '../../lib/model/build/build-audit-model';
import type { PageRecord } from '../../lib/model/page';
import type { SiteDocument } from '../../lib/model/site';

let t: TestDb;
const files = tempStore();
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
  files.cleanup();
});

interface ModelEdits {
  doc?: (d: SiteDocument) => unknown;
  pages?: (p: PageRecord[]) => PageRecord[][];
  /** false: only site.json.gz, as audits loaded before the row parts existed. */
  rows?: boolean;
  finishedAt?: Date | null;
  createdAt?: Date;
}

async function putModel(id: string, opts: FixtureRunOptions, edits: ModelEdits = {}) {
  const run = writeFixtureRun(opts);
  try {
    const source = readRun(run.runDir);
    const doc = buildAuditModel({ runDir: run.runDir, auditId: id }, source);
    const prefix = `audits/${id}/1/model/`;
    await files.store.put(`${prefix}site.json.gz`, gzipSync(JSON.stringify(edits.doc ? edits.doc(doc) : doc)));
    if (edits.rows !== false) {
      const rows = buildRowParts(run.runDir, source);
      await files.store.put(`${prefix}run-data.json.gz`, gzipSync(JSON.stringify(rows.runData)));
      const chunks = edits.pages ? edits.pages(rows.pages) : [rows.pages];
      for (const [i, chunk] of chunks.entries())
        await files.store.put(
          `${prefix}pages-${String(i + 1).padStart(4, '0')}.ndjson.gz`,
          gzipSync(chunk.map((r) => JSON.stringify(r)).join('\n')),
        );
    }
    return doc;
  } finally {
    run.cleanup();
  }
}

async function builtAudit(opts: FixtureRunOptions = {}, edits: ModelEdits = {}) {
  const id = randomUUID();
  const domain = opts.domain ?? 'fixture.example';
  const site = await findOrCreateSite(t.db, domain);
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: opts.lead ? 'quick' : 'full',
    targetUrl: `https://${domain}`,
    profile: 'standard',
    profileHash: randomUUID(),
    comparableKey: 'k',
    status: 'built',
    source: 'internal',
    currentAttempt: 1,
    finishedAt: edits.finishedAt === undefined ? new Date() : edits.finishedAt,
    ...(edits.createdAt ? { createdAt: edits.createdAt } : {}),
  });
  const model = await putModel(id, opts, edits);
  return { id, siteId: site.id, model };
}

const auditRow = async (id: string) => (await t.db.select().from(audits).where(eq(audits.id, id)))[0]!;
const scoreMap = async (id: string) =>
  Object.fromEntries(
    (await t.db.select().from(scores).where(eq(scores.auditId, id))).map((s) => [s.category, s.score]),
  );

void test(
  'scores: the loader does not claim a scoring version; a re-score follows a version change',
  { skip: SKIP_DB },
  async () => {
    const { id } = await builtAudit({ domain: 'rescore.example' });
    assert.equal((await loadAudit(t.db, files.store, id)).outcome, 'succeeded');
    assert.equal((await auditRow(id)).scoringVersion, null, 'scores copied from the run carry no version');
    assert.equal((await scoreMap(id)).overall, 71, "the run's own score");

    await ensureScored(t.db, null, [id]);
    const version = scoringVersion();
    assert.equal((await auditRow(id)).scoringVersion, version);
    const current = await scoreMap(id);
    assert.equal(typeof current.overall, 'number');
    const [doc] = await t.db.select().from(auditDocuments).where(eq(auditDocuments.auditId, id));
    assert.equal(
      (doc!.document as SiteDocument).scores.find((s) => s.category === 'overall')?.score,
      current.overall,
      'the site document carries the same scores',
    );

    // scores written by other scoring code
    await t.db.update(scores).set({ score: 1 }).where(eq(scores.auditId, id));
    await t.db.update(audits).set({ scoringVersion: 'older-code' }).where(eq(audits.id, id));
    const site = await getSite(t.db, internalPrincipal(), { audit_id: id });
    assert.deepEqual(await scoreMap(id), current, 'a read that returns scores re-scores first');
    assert.equal(site.scores.overall, current.overall);
    assert.equal(site.scoring_version, version);
    assert.equal(site.scores_current, true);
    assert.deepEqual(
      site.score_trend.map((s) => s.audit_id),
      [id],
    );
  },
);

void test('scores: an audit that cannot be re-scored is marked and the queue moves on', { skip: SKIP_DB }, async () => {
  const noData = await builtAudit({ domain: 'no-run-data.example' }, { rows: false });
  await loadAudit(t.db, files.store, noData.id);
  const broken = await builtAudit({ domain: 'broken-run-data.example' });
  await loadAudit(t.db, files.store, broken.id);
  // run data the scoring script cannot read
  await t.db
    .update(auditRunData)
    .set({ data: { files: 'x' } })
    .where(eq(auditRunData.auditId, broken.id));
  const version = scoringVersion();
  for (let i = 0; i < 3; i++) await rescoreStale(t.db, null, 50);
  assert.equal((await auditRow(noData.id)).scoringVersion, noDataMark(version));
  assert.equal((await scoreMap(noData.id)).overall, 71, 'its scores stay as loaded');
  assert.equal((await auditRow(broken.id)).scoringVersion, failedMark(version), 'marked after three failures');
  assert.equal(await rescoreStale(t.db, null, 50), 0, 'nothing is left in the queue');
  const site = await getSite(t.db, internalPrincipal(), { audit_id: noData.id });
  assert.equal(site.scores_current, false, 'a caller can tell the scores are not from the current code');
});

void test(
  'loader: a model that cannot be loaded fails after three tries and does not hold other audits',
  { skip: SKIP_DB },
  async () => {
    const old = new Date(Date.now() - 86_400_000);
    const bad = await builtAudit(
      { domain: 'poison.example' },
      { doc: (d) => ({ ...d, findings: 'not a list' }), createdAt: old },
    );
    const good = await builtAudit({ domain: 'healthy.example' });
    const finished: string[] = [];
    const onFinished = async (id: string) => void finished.push(id);
    const first = await runLoader(t.db, files.store, { onFinished });
    assert.equal(first.find((r) => r.auditId === good.id)?.outcome, 'succeeded', 'the other audit loads');
    assert.equal(first.find((r) => r.auditId === bad.id)?.outcome, 'failed');
    let row = await auditRow(bad.id);
    assert.equal(row.loadAttempts, 1);
    assert.match(row.error ?? '', /^load: /);
    assert.notEqual(row.status, 'failed', 'one failure is not final');
    for (let i = 1; i < MAX_LOAD_ATTEMPTS; i++) await runLoader(t.db, files.store, { onFinished });
    row = await auditRow(bad.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.loadAttempts, MAX_LOAD_ATTEMPTS);
    assert.match(row.error ?? '', /findings/);
    assert.ok(finished.includes(bad.id), 'a failed audit is reported like any finished one');
    assert.deepEqual(
      (await runLoader(t.db, files.store)).filter((r) => r.auditId === bad.id),
      [],
      'it left the queue',
    );
  },
);

void test('loader: a NUL character and a page listed twice do not stop a load', { skip: SKIP_DB }, async () => {
  const { id } = await builtAudit(
    {
      domain: 'unsafe-text.example',
      findings: {
        'Title with a NUL\u0000 inside': {
          severity: 'high',
          count: 1,
          examples: ['text with \u0000 and half an emoji \ud83d'],
        },
      },
    },
    {
      doc: (d) => ({
        ...d,
        siteChecks: [{ checkId: 'x', label: 'A\u0000B', status: 'pass', note: null, details: null }],
      }),
      pages: (p) => [
        [
          { ...p[0]!, title: 'Home\u0000page', sections: { ...p[0]!.sections, raw: 'a\u0000b', '\u0000key': 1 } },
          ...p.slice(1),
        ],
        [{ ...p[0]!, title: 'second record of the same URL' }],
      ],
    },
  );
  const res = await loadAudit(t.db, files.store, id);
  assert.equal(res.outcome, 'succeeded', res.error);
  const rows = await t.db.select().from(pages).where(eq(pages.auditId, id));
  assert.equal(rows.length, 5, 'one row per URL');
  const home = rows.find((r) => r.url === 'https://unsafe-text.example/')!;
  assert.equal(home.title, 'Homepage', 'the first record wins, without the NUL');
  assert.equal((home.sections as Record<string, unknown>).raw, 'ab');
  const [f] = await t.db.select().from(findings).where(eq(findings.auditId, id));
  assert.equal(f!.title, 'Title with a NUL inside');
});

void test(
  'disclosures: first and last seen follow the audits’ dates, not the load order',
  { skip: SKIP_DB },
  async () => {
    const siteChecks = [
      {
        id: 'js-secrets',
        label: 'Secrets in JavaScript',
        status: 'fail',
        details: [{ url: 'https://order.example/main.js' }],
      },
    ];
    const day = (n: number) => new Date(Date.UTC(2026, 10, n));
    const oldest = await builtAudit({ domain: 'order.example', siteChecks }, { finishedAt: day(1) });
    const middle = await builtAudit({ domain: 'order.example', siteChecks }, { finishedAt: day(5) });
    const newest = await builtAudit({ domain: 'order.example', siteChecks }, { finishedAt: day(9) });
    for (const a of [middle, newest, oldest])
      assert.equal((await loadAudit(t.db, files.store, a.id)).outcome, 'succeeded');
    const rows = await t.db.select().from(disclosures).where(eq(disclosures.siteId, oldest.siteId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.firstAuditId, oldest.id);
    assert.equal(rows[0]!.lastSeenAuditId, newest.id);
  },
);

void test('list_findings: cursor pages reach every finding; total counts them all', { skip: SKIP_DB }, async () => {
  const findingsIn = Object.fromEntries(
    ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'].map((name, i) => [
      `${name} check finding`,
      { severity: i < 2 ? 'high' : 'low', count: i === 3 || i === 4 ? 5 : i + 1, examples: [`${name} example`] },
    ]),
  );
  const { id } = await builtAudit({ domain: 'cursor.example', findings: findingsIn });
  await loadAudit(t.db, files.store, id);
  const p = internalPrincipal();
  const all = await listFindings(t.db, p, { audit_id: id, limit: 500 });
  assert.equal(all.total, 7);
  assert.equal(all.count, 7);
  assert.equal(all.next_cursor, null);
  const seen: string[] = [];
  let cursor: string | null = null;
  let calls = 0;
  do {
    const page: Awaited<ReturnType<typeof listFindings>> = await listFindings(t.db, p, {
      audit_id: id,
      limit: 3,
      cursor,
    });
    assert.equal(page.total, 7, 'total is the whole result, not the page');
    seen.push(...page.findings.map((f) => f.id));
    cursor = page.next_cursor;
    calls++;
  } while (cursor && calls < 10);
  assert.equal(calls, 3);
  assert.deepEqual(
    seen,
    all.findings.map((f) => f.id),
    'same order, nothing skipped or repeated',
  );
  const low = await listFindings(t.db, p, { audit_id: id, severity_min: 'high', limit: 1 });
  assert.equal(low.total, 2);
  assert.ok(low.next_cursor);
  await assert.rejects(listFindings(t.db, p, { audit_id: id, cursor: 'nonsense' }), /cursor/);
});

void test('list_findings: a blocked scan shows no findings', { skip: SKIP_DB }, async () => {
  const { id, model } = await builtAudit({
    domain: 'blocked-findings.example',
    homepageBlocked: true,
    blockedPaths: ['/about', '/pricing'],
  });
  await loadAudit(t.db, files.store, id);
  assert.ok(model.findings.length > 0, 'findings without a page URL are still in the model');
  const r = await listFindings(t.db, internalPrincipal(), { audit_id: id });
  assert.equal(r.scan_quality, 'blocked');
  assert.deepEqual(r.findings, []);
  assert.equal(r.total, 0);
});

void test(
  'reload: readers keep the audit; a failed reload changes nothing; fewer chunks leave no old rows',
  { skip: SKIP_DB },
  async () => {
    const opts = { domain: 'reload.example' };
    const { id } = await builtAudit(opts, { pages: (p) => [p.slice(0, 3), p.slice(3)] });
    await loadAudit(t.db, files.store, id);
    await t.db.update(audits).set({ scoringVersion: 'some-version' }).where(eq(audits.id, id));
    assert.equal((await t.db.select().from(pages).where(eq(pages.auditId, id))).length, 5);
    assert.equal(
      (await loadAudit(t.db, files.store, id)).outcome,
      'skipped',
      'without `reload` a succeeded audit is left',
    );

    // a rebuilt model that cannot be loaded
    await files.store.put(`audits/${id}/1/model/site.json.gz`, gzipSync(JSON.stringify({ modelVersion: '0.1.0' })));
    const failed = await loadAudit(t.db, files.store, id, { reload: true });
    assert.equal(failed.outcome, 'failed');
    let row = await auditRow(id);
    assert.equal(row.status, 'succeeded', 'never hidden from readers');
    assert.equal(row.loadAttempts, 0);
    assert.equal(row.scoringVersion, 'some-version');
    assert.equal((await t.db.select().from(pages).where(eq(pages.auditId, id))).length, 5, 'rows as before');
    assert.equal((await listFindings(t.db, internalPrincipal(), { audit_id: id })).total, 4);

    // a rebuilt model with fewer pages, in one chunk
    await files.store.delete([`audits/${id}/1/model/pages-0002.ndjson.gz`]);
    await putModel(id, opts, { pages: (p) => [p.slice(0, 2)] });
    const ok = await loadAudit(t.db, files.store, id, { reload: true });
    assert.equal(ok.outcome, 'succeeded', ok.error);
    row = await auditRow(id);
    assert.equal(row.status, 'succeeded');
    assert.equal(row.scoringVersion, null, 'reloaded scores are the run’s again');
    const after = await t.db.select().from(pages).where(eq(pages.auditId, id));
    assert.deepEqual(
      after.map((r) => r.chunk),
      [1, 1],
      'no rows of the old second chunk',
    );
    assert.ok((await t.db.select().from(loadProgress).where(eq(loadProgress.auditId, id))).length >= 6);
  },
);

void test(
  'finding codes: the row and the stored document agree, and a second load gives the same codes',
  { skip: SKIP_DB },
  async () => {
    const junk = 'audit-failed-browsertype-launch-executable-doesn-t-exist-at-users-someone';
    const title = "Audit failed: browserType.launch: Executable doesn't exist at /Users/someone/Library/Caches/x";
    const { id } = await builtAudit(
      {
        domain: 'codes.example',
        findings: {
          'Brand new stable check title': { severity: 'low', count: 1, examples: ['x'] },
          'No CAA record': { severity: 'low', count: 1, examples: ['x'] },
          [title]: { severity: 'high', count: 1, examples: ['x'] },
        },
      },
      // a document built before the rule: the error message still has a code of its own
      { doc: (d) => ({ ...d, findings: d.findings.map((f) => (f.title === title ? { ...f, code: junk } : f)) }) },
    );
    const codesOf = async () => {
      const rows = await t.db.select().from(findings).where(eq(findings.auditId, id));
      const [doc] = await t.db.select().from(auditDocuments).where(eq(auditDocuments.auditId, id));
      const inDoc = Object.fromEntries((doc!.document as SiteDocument).findings.map((f) => [f.id, f.code]));
      for (const r of rows) assert.equal(inDoc[r.id], r.code, `document and row agree for "${r.title}"`);
      return Object.fromEntries(rows.map((r) => [r.title, r.code]));
    };
    await loadAudit(t.db, files.store, id);
    const first = await codesOf();
    assert.equal(first[title], 'untyped');
    assert.equal(first['Brand new stable check title'], 'brand-new-stable-check-title');
    assert.equal(first['No CAA record'], 'no-caa-record');
    assert.equal((await t.db.select().from(checkTypes).where(eq(checkTypes.code, junk))).length, 0);
    const [fresh] = await t.db.select().from(checkTypes).where(eq(checkTypes.code, 'brand-new-stable-check-title'));
    assert.equal(fresh?.derived, true);
    await loadAudit(t.db, files.store, id, { reload: true });
    assert.deepEqual(await codesOf(), first);
  },
);
