import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { GATE_RUN, tempStore, writeFixtureRun } from './helpers';
import {
  auditDocuments,
  audits,
  disclosures,
  findings,
  leadFacts,
  loadProgress,
  scores,
  sites,
  technologies,
} from '../../web/db/schema';
import { loadAudit } from '../../web/lib/core/loader';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { buildAuditModel } from '../../lib/model/build/build-audit-model';
import { getLeadSummary } from '../../web/lib/core/lead-summary';
import { listLeadSummaries } from '../../web/lib/core/lead-summaries';
import { internalPrincipal } from '../../web/lib/core/principal';
import {
  getSite,
  getTechStack,
  listFindings,
  getRecommendations,
  getSiteChecks,
  listCheckTypes,
} from '../../web/lib/core/results';
import { LeadSummary, LeadSummaryRow } from '../../lib/model/lead-summary';

let t: TestDb;
const files = tempStore();
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
  files.cleanup();
});

async function builtAudit(
  opts: Parameters<typeof writeFixtureRun>[0] = {},
  doc?: (d: ReturnType<typeof buildAuditModel>) => unknown,
) {
  const run = writeFixtureRun(opts);
  const id = randomUUID();
  const site = await findOrCreateSite(t.db, opts.domain ?? 'fixture.example');
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: opts.lead ? 'quick' : 'full',
    targetUrl: `https://${opts.domain ?? 'fixture.example'}`,
    profile: 'standard',
    profileHash: randomUUID(),
    comparableKey: 'k',
    status: 'built',
    source: 'internal',
    currentAttempt: 1,
    finishedAt: new Date(),
  });
  const model = buildAuditModel({ runDir: run.runDir, auditId: id });
  await files.store.put(`audits/${id}/1/model/site.json.gz`, gzipSync(JSON.stringify(doc ? doc(model) : model)));
  run.cleanup();
  return { id, siteId: site.id, model };
}

void test('loader: a loader killed halfway resumes and the row counts are right', { skip: SKIP_DB }, async () => {
  const { id, model } = await builtAudit({ lead: true, gateRun: GATE_RUN });
  await assert.rejects(loadAudit(t.db, files.store, id, { failAfterChunks: 2 }), /simulated/);
  assert.equal((await t.db.select().from(audits).where(eq(audits.id, id)))[0]!.status, 'loading');
  assert.equal((await t.db.select().from(loadProgress).where(eq(loadProgress.auditId, id))).length, 2);
  const res = await loadAudit(t.db, files.store, id);
  assert.equal(res.outcome, 'succeeded');
  assert.equal(res.chunks, 3, 'only the remaining chunks ran');
  assert.equal((await t.db.select().from(findings).where(eq(findings.auditId, id))).length, model.findings.length);
  assert.equal((await t.db.select().from(auditDocuments).where(eq(auditDocuments.auditId, id))).length, 1);
  assert.equal((await t.db.select().from(scores).where(eq(scores.auditId, id))).length, model.scores.length);
  assert.ok((await t.db.select().from(technologies).where(eq(technologies.auditId, id))).length > 0);
  const [row] = await t.db.select().from(audits).where(eq(audits.id, id));
  assert.equal(row!.status, 'succeeded');
  assert.equal(row!.loadAttempts, 0, 'a killed loader is not a failed load');
  assert.equal(row!.scoringVersion, null, "the run's scores are not stamped with this app's scoring version");
  // loading again is a no-op (status no longer built)
  assert.equal((await loadAudit(t.db, files.store, id)).outcome, 'skipped');
});

void test('loader: an unknown model major leaves the audit built with load_blocked', { skip: SKIP_DB }, async () => {
  const { id } = await builtAudit({}, (d) => ({ ...d, modelVersion: '9.0.0' }));
  const res = await loadAudit(t.db, files.store, id);
  assert.equal(res.outcome, 'blocked');
  const [row] = await t.db.select().from(audits).where(eq(audits.id, id));
  assert.equal(row!.status, 'built');
  assert.equal(row!.loadBlocked, 'model_version');
});

void test('read tools name the audit they used; get_lead_summary validates', { skip: SKIP_DB }, async () => {
  const { id } = await builtAudit({ domain: 'reads.example', lead: true, gateRun: GATE_RUN });
  await loadAudit(t.db, files.store, id);
  const p = internalPrincipal();
  for (const r of [
    await listFindings(t.db, p, { domain: 'reads.example' }),
    await getTechStack(t.db, p, { domain: 'www.reads.example' }),
    await getRecommendations(t.db, p, { audit_id: id }),
    await getSiteChecks(t.db, p, { domain: 'reads.example' }),
    await getSite(t.db, p, { domain: 'reads.example' }),
  ]) {
    assert.equal(r.audit_id, id);
    assert.equal(r.mode, 'quick');
    assert.ok(r.scanned_at);
    assert.equal(r.scan_quality, 'ok');
  }
  assert.ok((await listCheckTypes(t.db, p)).check_types.some((c) => c.code === 'untyped'));
  const s = await getLeadSummary(t.db, p, { domain: 'reads.example' });
  assert.ok(LeadSummary.safeParse(s).success);
  assert.equal(s.facts[0]!.weight, 'heavy');
  assert.equal(s.teaser_ready, true);
  assert.equal(s.outreach_blocked, false);
  assert.equal(s.quick_wins.length, 1);
  assert.equal(s.scores?.overall, 71);
});

void test(
  'lead summary: blocked scan → null scores and only allowed facts; open disclosure → outreach_blocked',
  { skip: SKIP_DB },
  async () => {
    const { id, siteId } = await builtAudit({
      domain: 'blocked-scan.example',
      lead: true,
      homepageBlocked: true,
      blockedPaths: ['/about', '/pricing'],
      gateRun: GATE_RUN,
    });
    await loadAudit(t.db, files.store, id);
    const s = await getLeadSummary(t.db, internalPrincipal(), { audit_id: id });
    assert.equal(s.scan_quality.state, 'blocked');
    assert.equal(s.scores, null);
    assert.deepEqual(s.quick_wins, []);
    assert.deepEqual(s.unverified_findings, []);
    assert.deepEqual(
      s.facts.map((f) => f.dependsOn),
      ['dns'],
      'homepage not read: only dns facts',
    );
    assert.deepEqual(s.stack, []);
    await t.db
      .insert(disclosures)
      .values({ siteId, code: 'js-secrets', target: 'https://blocked-scan.example/app.js' });
    const s2 = await getLeadSummary(t.db, internalPrincipal(), { audit_id: id });
    assert.equal(s2.outreach_blocked, true);
    assert.equal(s2.teaser_ready, false);
    assert.equal(s2.disclosure?.status, 'open');
    void sites;
    void leadFacts;
  },
);

void test('disclosures: a second scan of the same exposure updates the row', { skip: SKIP_DB }, async () => {
  const checks = [
    {
      id: 'js-secrets',
      label: 'Secrets in JavaScript',
      status: 'fail',
      details: [{ url: 'https://leaky.example/main.js' }],
    },
  ];
  const a = await builtAudit({ domain: 'leaky.example', siteChecks: checks });
  await loadAudit(t.db, files.store, a.id);
  const b = await builtAudit({ domain: 'leaky.example', siteChecks: checks });
  await loadAudit(t.db, files.store, b.id);
  const rows = await t.db.select().from(disclosures).where(eq(disclosures.siteId, a.siteId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.firstAuditId, a.id);
  assert.equal(rows[0]!.lastSeenAuditId, b.id);
});

void test(
  'lead summaries: one query gives every site, and each row agrees with get_lead_summary',
  { skip: SKIP_DB },
  async () => {
    const day = 86400_000;
    const older = await builtAudit({ domain: 'list-a.example', lead: true, gateRun: GATE_RUN });
    await loadAudit(t.db, files.store, older.id);
    await t.db
      .update(audits)
      .set({ finishedAt: new Date(Date.now() - 3 * day) })
      .where(eq(audits.id, older.id));
    const newer = await builtAudit({ domain: 'list-a.example', lead: true, gateRun: GATE_RUN });
    await loadAudit(t.db, files.store, newer.id);
    const full = await builtAudit({ domain: 'list-a.example' });
    await loadAudit(t.db, files.store, full.id);
    const blocked = await builtAudit({
      domain: 'list-blocked.example',
      lead: true,
      homepageBlocked: true,
      blockedPaths: ['/about', '/pricing'],
      gateRun: GATE_RUN,
    });
    await loadAudit(t.db, files.store, blocked.id);
    const pub = await builtAudit({ domain: 'list-public.example', lead: true });
    await loadAudit(t.db, files.store, pub.id);
    await t.db.update(audits).set({ source: 'public' }).where(eq(audits.id, pub.id));
    const running = await builtAudit({ domain: 'list-running.example', lead: true });

    const mine = (rows: LeadSummaryRow[]) => rows.filter((r) => r.domain.startsWith('list-'));
    const latest = mine((await listLeadSummaries(t.db, internalPrincipal(), { limit: 500 })).summaries);
    assert.deepEqual(
      latest.map((r) => `${r.domain} ${r.mode} ${r.audit_id === older.id ? 'older' : 'latest'}`).sort(),
      ['list-a.example full latest', 'list-a.example quick latest', 'list-blocked.example quick latest'],
      'newest per site and scan type; no public scan, no unfinished audit',
    );
    assert.ok(!latest.some((r) => r.audit_id === pub.id || r.audit_id === running.id));
    const all = mine(
      (await listLeadSummaries(t.db, internalPrincipal(), { latest_only: false, limit: 500 })).summaries,
    );
    assert.ok(
      all.some((r) => r.audit_id === older.id),
      'latest_only=false has the earlier audit too',
    );

    // Every row says what get_lead_summary says about the same audit.
    for (const row of latest) {
      const one = await getLeadSummary(t.db, internalPrincipal(), { audit_id: row.audit_id });
      assert.equal(row.scan_quality, one.scan_quality.state);
      assert.equal(row.pages_read, one.scan_quality.pages_read);
      assert.equal(row.outreach_blocked, one.outreach_blocked);
      assert.equal(row.facts.teaser_ready, one.teaser_ready);
      assert.equal(row.facts.heavy + row.facts.medium + row.facts.light, one.facts.length, row.domain);
      assert.deepEqual(
        row.facts.top.map((f) => f.fact),
        one.facts.slice(0, 3).map((f) => f.fact),
      );
      assert.equal(row.scores.overall, one.scores?.overall ?? null);
      assert.equal(row.scores.seo, one.scores?.seo ?? null);
      assert.equal(row.issues.total, Object.values(one.counts).reduce((a, b) => a + b, 0) * (one.scores ? 1 : 0));
      assert.deepEqual(row.quick_wins, one.quick_wins);
      assert.deepEqual(row.site.languages, one.site_profile.languages);
      assert.equal(row.stack.cms, one.stack.find((s) => s.kind === 'cms')?.name ?? null);
      assert.equal(
        row.tracking.has_ga4,
        one.tracking_ids.some((i) => i.kind === 'ga4'),
      );
      assert.equal(row.links.report, one.links.report);
    }
    const b = latest.find((r) => r.audit_id === blocked.id)!;
    assert.equal(b.scan_quality, 'blocked');
    assert.equal(b.scores.overall, null);
    assert.equal(b.issues.total, 0);
    assert.deepEqual(b.quick_wins, []);

    // An open disclosure blocks outreach in the list too, and filters select on it.
    await t.db
      .insert(disclosures)
      .values({ siteId: newer.siteId, code: 'js-secrets', target: 'https://list-a.example/x.js' });
    const blockedOut = mine(
      (await listLeadSummaries(t.db, internalPrincipal(), { outreach_blocked: true, limit: 500 })).summaries,
    );
    assert.deepEqual([...new Set(blockedOut.map((r) => r.domain))], ['list-a.example']);
    assert.ok(blockedOut.every((r) => !r.facts.teaser_ready));
    assert.ok(!JSON.stringify(blockedOut).includes('js-secrets'), 'no detail of the disclosure');
    const quick = mine(
      (await listLeadSummaries(t.db, internalPrincipal(), { mode: 'quick', domain: 'list-a' })).summaries,
    );
    assert.deepEqual(
      quick.map((r) => r.audit_id),
      [newer.id],
    );

    // Pages: the cursor reaches every row once.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listLeadSummaries(t.db, internalPrincipal(), { latest_only: false, limit: 2, cursor });
      seen.push(...page.summaries.map((r) => r.audit_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    for (const r of all) assert.ok(seen.includes(r.audit_id));

    // Scopes: audits:read is needed; prospect data only with prospects:read.
    const reader = { kind: 'client', clientId: randomUUID(), name: 'r', scopes: ['audits:read'] } as const;
    assert.ok((await listLeadSummaries(t.db, reader, {})).summaries.every((r) => r.prospect === null));
    await assert.rejects(listLeadSummaries(t.db, reader, { prospect_stage: 'new' }), /prospects:read/);
    await assert.rejects(
      listLeadSummaries(t.db, { kind: 'client', clientId: randomUUID(), name: 'n', scopes: [] }, {}),
      /audits:read/,
    );
    for (const r of all) LeadSummaryRow.parse(r);
  },
);
