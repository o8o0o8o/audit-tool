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
import { internalPrincipal } from '../../web/lib/core/principal';
import {
  getSite,
  getTechStack,
  listFindings,
  getRecommendations,
  getSiteChecks,
  listCheckTypes,
} from '../../web/lib/core/results';
import { LeadSummary } from '../../lib/model/lead-summary';

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
  await t.db
    .insert(audits)
    .values({
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
