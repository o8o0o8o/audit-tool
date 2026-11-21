import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditModel } from '../../lib/model/build/build-audit-model';
import { deriveCode } from '../../lib/model/finding-codes';
import { computeScanQuality } from '../../lib/model/scan-quality';
import { SiteDocument } from '../../lib/model/site';
import { LeadSummary } from '../../lib/model/lead-summary';
import { z } from 'zod';
import { GATE_RUN, writeFixtureRun } from './helpers';

const ID = '11111111-1111-4111-8111-111111111111';

void test('finding codes: derived codes are stable, carry no number or URL', () => {
  const a = deriveCode('Some pages have too many requests (24 pages)');
  const b = deriveCode('<b>Some pages have too many requests</b> (3 pages)');
  assert.equal(a.code, b.code);
  assert.equal(a.params.count, 24);
  const c = deriveCode('Image https://x.example/a.png is 2400 KB, over the "hero" limit of 200 KB');
  assert.doesNotMatch(c.code, /(^|-)\d+(-|$)/);
  assert.doesNotMatch(c.code, /https?|example/);
  assert.deepEqual(c.params.urls, ['https://x.example/a.png']);
  assert.deepEqual(c.params.values, ['hero']);
  assert.equal(deriveCode('Missing h1 tag').code, 'missing-h1-tag', 'alphanumeric names stay');
  assert.equal(deriveCode('No CAA record').explicit, true);
});

void test('model: two builds of the same run give identical codes and ids', () => {
  const { runDir, cleanup } = writeFixtureRun();
  try {
    const x = buildAuditModel({ runDir, auditId: ID });
    const y = buildAuditModel({ runDir, auditId: ID });
    assert.deepEqual(
      x.findings.map((f) => [f.id, f.code]),
      y.findings.map((f) => [f.id, f.code]),
    );
    assert.ok(SiteDocument.safeParse(x).success);
    assert.ok(z.toJSONSchema(SiteDocument), 'the schema renders as JSON Schema');
    assert.ok(z.toJSONSchema(LeadSummary));
  } finally {
    cleanup();
  }
});

void test('scan quality: a clean run is ok; a challenged homepage is blocked and has no scores', () => {
  const clean = writeFixtureRun();
  const blocked = writeFixtureRun({ homepageBlocked: true, blockedPaths: ['/about', '/pricing'] });
  const partial = writeFixtureRun({ blockedPaths: ['/contact'] });
  try {
    const ok = buildAuditModel({ runDir: clean.runDir, auditId: ID });
    assert.equal(ok.scanQuality.state, 'ok');
    assert.equal(ok.scores.find((s) => s.category === 'overall')?.score, 71);
    const b = buildAuditModel({ runDir: blocked.runDir, auditId: ID });
    assert.equal(b.scanQuality.state, 'blocked');
    assert.ok(b.scores.every((s) => s.score === null));
    const p = buildAuditModel({ runDir: partial.runDir, auditId: ID });
    assert.equal(p.scanQuality.state, 'partial');
    assert.equal(p.scanQuality.pagesBlocked, 1);
    // a finding raised only on the blocked page is dropped
    assert.ok(!p.findings.some((f) => f.title === 'Only blocked page issue'));
    assert.ok(ok.findings.some((f) => f.title === 'Only blocked page issue'));
  } finally {
    clean.cleanup();
    blocked.cleanup();
    partial.cleanup();
  }
  const q = computeScanQuality({
    keyUrl: 'https://a.example/',
    pages: [{ url: 'https://a.example/', status: 200 }],
    byError: { '429': ['https://a.example/x'] },
    sitemapTotal: null,
    sitemapCrawled: null,
    probesBlocked: 0,
    botProtection: 'Cloudflare',
  });
  assert.equal(q.state, 'blocked', '1 of 2 blocked is ≥ 50 %');
  assert.equal(q.botProtection, 'Cloudflare');
});

void test('model: site profile, stack, tracking ids, gate facts with depends_on', () => {
  const { runDir, cleanup } = writeFixtureRun({ lead: true, gateRun: GATE_RUN });
  try {
    const d = buildAuditModel({ runDir, auditId: ID });
    assert.equal(d.audit.mode, 'quick');
    assert.deepEqual(d.siteProfile.languages, ['en']);
    assert.equal(d.siteProfile.aiCrawlerRules?.GPTBot, 'disallowed');
    assert.equal(d.siteProfile.hasContactForm, true);
    assert.deepEqual(d.siteProfile.bookingLinks, ['https://calendly.com/x']);
    assert.ok(d.stack?.technologies.some((t) => t.name === 'WordPress' && t.kind === 'cms'));
    assert.ok(d.stack?.trackingIds.some((t) => t.kind === 'ga4' && t.value === 'G-TEST123' && t.sendsHits));
    assert.equal(d.fieldMetrics[0]?.lcpP75, 2100);
    assert.deepEqual(
      d.gateRuns[0]?.facts.map((f) => f.dependsOn),
      ['pages', 'dns', 'homepage'],
    );
  } finally {
    cleanup();
  }
});
