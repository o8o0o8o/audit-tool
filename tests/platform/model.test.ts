import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildAuditModel, buildRowParts, loadRunPages } from '../../lib/model/build/build-audit-model';
import { deriveCode, isStableTitle } from '../../lib/model/finding-codes';
import { pgSafe } from '../../lib/model/pg-safe';
import { computeScanQuality, isBlockedErrorKey } from '../../lib/model/scan-quality';
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

/** Rewrites one gzipped JSON file of a fixture run. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is edited freely
function editGz(runDir: string, file: string, edit: (v: Record<string, any>) => void): void {
  const full = path.join(runDir, file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is edited freely
  const value = JSON.parse(gunzipSync(readFileSync(full)).toString('utf8')) as Record<string, any>;
  edit(value);
  writeFileSync(full, gzipSync(JSON.stringify(value)));
}

void test('finding codes: an error message, a path or a URL gives no code of its own', () => {
  for (const title of [
    "Audit failed: browserType.launch: Executable doesn't exist at /Users/someone/Library/Caches/ms-playwright/chromium-1155/chrome",
    'Error during processing robots.txt: fetch failed',
    'TypeError: Cannot read properties of undefined',
    'Request to https://x.example/api failed',
    'Sizes 1200 x 630, 1080 x 1080, 400 x 400 found',
  ]) {
    assert.equal(isStableTitle(title), false, title);
    assert.equal(deriveCode(title).code, 'untyped', title);
  }
  for (const title of [
    'Stylesheet failed to load',
    'Some pages have TTI more than 3800ms',
    'ads.txt missing on a site that shows ads',
    'Product schema lacks reviews/ratings',
    'HTTP→HTTPS and www redirects not combined',
    'Accessibility (axe): Form elements must have labels',
    'JavaScript error when a control is clicked',
  ])
    assert.notEqual(deriveCode(title).code, 'untyped', title);
  // an explicit code keeps its URL parameter
  const explicit = deriveCode('Trailing-slash duplicate URL pairs in sitemap https://x.example/sitemap.xml');
  assert.equal(explicit.code, 'trailing-slash-duplicate-url-pairs-in-sitemap');
  assert.equal(explicit.explicit, true);
});

void test('scan quality: one definition of blocked; a page without a status was not read', () => {
  assert.equal(isBlockedErrorKey('503'), false, 'a bare 503 is a failure');
  assert.equal(isBlockedErrorKey('challenge-503'), true);
  const q = computeScanQuality({
    keyUrl: 'https://a.example/',
    pages: [
      { url: 'https://a.example/', status: 200 },
      { url: 'https://a.example/no-status' },
      { url: 'https://a.example/down', status: 503 },
    ],
    byError: { '503': ['https://a.example/down'], timeout: ['https://a.example/slow'] },
    sitemapTotal: null,
    sitemapCrawled: null,
    probesBlocked: 0,
    botProtection: null,
  });
  assert.equal(q.pagesOk, 1);
  assert.equal(q.pagesBlocked, 0);
  assert.equal(q.pagesFailed, 3, '503, timeout and the page without a status');
  const run = writeFixtureRun();
  try {
    editGz(run.runDir, 'manifest.json.gz', (m) => (m.progress.byError = { '503': ['https://fixture.example/blog'] }));
    const rows = buildRowParts(run.runDir);
    assert.ok(
      rows.pages.every((p) => !p.blocked),
      'the page rows use the same rule: a bare 503 is not a block',
    );
  } finally {
    run.cleanup();
  }
});

void test('model: llmsTxt is null unless the run shows the result', () => {
  const none = writeFixtureRun();
  const missing = writeFixtureRun({
    findings: { 'llms.txt is missing': { severity: 'low', count: 1, examples: ['https://fixture.example/llms.txt'] } },
  });
  const recorded = writeFixtureRun();
  const blocked = writeFixtureRun({
    homepageBlocked: true,
    blockedPaths: ['/about', '/pricing'],
    findings: { 'llms.txt is missing': { severity: 'low', count: 1, examples: ['https://fixture.example/llms.txt'] } },
  });
  try {
    assert.equal(
      buildAuditModel({ runDir: none.runDir, auditId: ID }).siteProfile.llmsTxt,
      null,
      'no finding is not "valid"',
    );
    assert.equal(buildAuditModel({ runDir: missing.runDir, auditId: ID }).siteProfile.llmsTxt, 'missing');
    editGz(recorded.runDir, 'metadata.json.gz', (m) => (m.aeo = { llmsTxt: { hasLlmsTxt: true, status: 'valid' } }));
    assert.equal(buildAuditModel({ runDir: recorded.runDir, auditId: ID }).siteProfile.llmsTxt, 'valid');
    editGz(
      recorded.runDir,
      'metadata.json.gz',
      (m) => (m.aeo = { llmsTxt: { hasLlmsTxt: false, status: 'server-error' } }),
    );
    assert.equal(buildAuditModel({ runDir: recorded.runDir, auditId: ID }).siteProfile.llmsTxt, null, 'failed fetch');
    assert.equal(buildAuditModel({ runDir: blocked.runDir, auditId: ID }).siteProfile.llmsTxt, null, 'blocked scan');
    assert.equal(
      buildAuditModel({ runDir: missing.runDir, auditId: ID, mode: 'page' }).siteProfile.llmsTxt,
      null,
      'single page',
    );
  } finally {
    for (const r of [none, missing, recorded, blocked]) r.cleanup();
  }
});

void test('model: findings of blocked pages are absent from the stored run data too', () => {
  const origin = 'https://fixture.example';
  const ex = (p: string) => `<a href="${origin}${p}">${origin}${p}</a> has the problem`;
  const run = writeFixtureRun({
    blockedPaths: ['/contact'],
    findings: {
      'Only on the blocked page': { severity: 'high', count: 1, examples: [ex('/contact')] },
      'On a blocked and a read page': { severity: 'medium', count: 2, examples: [ex('/contact'), ex('/about')] },
      // the page is /about; the link inside the example text is not where the finding was raised
      'Read page that links to the blocked one': {
        severity: 'low',
        count: 1,
        examples: [`${ex('/about')}: link to <a href="${origin}/contact">contact</a>`],
      },
      'Capped sample, all of it blocked': { severity: 'low', count: 40, examples: [ex('/contact')] },
      'Site-level fact': { severity: 'low', count: 1, examples: ['No CAA record for fixture.example'] },
    },
  });
  try {
    editGz(run.runDir, 'analysis.json.gz', (a) => {
      a.overall = Object.keys(a.details);
      a.bySeverity = { high: ['Only on the blocked page [high]'], medium: ['On a blocked and a read page [medium]'] };
      a.summary.quickWins = [{ issue: 'Only on the blocked page' }, { issue: 'Site-level fact' }];
    });
    const doc = buildAuditModel({ runDir: run.runDir, auditId: ID });
    const { runData, pages } = buildRowParts(run.runDir);
    const analysis = runData.analysis as {
      details: Record<string, { count: number; examples: string[] }>;
      overall: string[];
      bySeverity: Record<string, string[]>;
      summary: { quickWins: Array<{ issue: string }> };
    };
    const stored = Object.keys(analysis.details).sort();
    assert.deepEqual(
      stored,
      doc.findings.map((f) => f.title).sort(),
      'the API and the stored run data hold the same findings',
    );
    assert.ok(!stored.includes('Only on the blocked page'));
    assert.ok(!analysis.overall.includes('Only on the blocked page'));
    assert.deepEqual(analysis.bySeverity.high, []);
    assert.deepEqual(
      analysis.summary.quickWins.map((q) => q.issue),
      ['Site-level fact'],
    );
    const mixed = analysis.details['On a blocked and a read page']!;
    assert.equal(mixed.count, 1);
    assert.deepEqual(mixed.examples, [ex('/about')], 'the blocked page is not shown as an example');
    assert.ok(stored.includes('Read page that links to the blocked one'));
    assert.deepEqual(
      analysis.details['Capped sample, all of it blocked']!.examples,
      [],
      'kept: 40 occurrences, 1 blocked page',
    );
    assert.equal(pages.find((p) => p.url === `${origin}/contact`)?.blocked, true);
  } finally {
    run.cleanup();
  }
});

void test('model: page rows carry depth, speed index, LCP element and weight; a URL is one record', () => {
  const run = writeFixtureRun();
  try {
    editGz(run.runDir, 'pages/batch_0001.json.gz', (b) => {
      Object.assign(b.pages['https://fixture.example/about'], {
        urlAnalysis: { depth: 1 },
        speedIndex: 1964.4,
        vitals: { lcpElement: 'h1' },
        requests: { totalRequests: 3, byType: { script: 2, image: 1 }, totalSize: 5000 },
        imageOptimization: { totalImageSize: 1200 },
        thirdPartyData: { totalSize: 800 },
      });
    });
    // a second batch that lists a page again
    writeFileSync(
      path.join(run.runDir, 'pages', 'batch_0002.json.gz'),
      gzipSync(
        JSON.stringify({
          pages: {
            'https://fixture.example/about': { url: 'https://fixture.example/about', status: 200, title: 'again' },
          },
        }),
      ),
    );
    editGz(run.runDir, 'manifest.json.gz', (m) => m.files.pageBatches.push({ file: 'pages/batch_0002.json.gz' }));
    const manifest = JSON.parse(gunzipSync(readFileSync(path.join(run.runDir, 'manifest.json.gz'))).toString('utf8'));
    assert.equal(loadRunPages(run.runDir, manifest).length, 5);
    const about = buildRowParts(run.runDir).pages.find((p) => p.url.endsWith('/about'))!;
    assert.equal(about.title, 'Page /about', 'the first record wins');
    assert.equal(about.depth, 1);
    assert.equal(about.speedIndexMs, 1964);
    assert.equal(about.lcpElement, 'h1');
    assert.deepEqual(about.weight, {
      totalBytes: 5000,
      imageBytes: 1200,
      thirdPartyBytes: 800,
      requestsByType: { script: 2, image: 1 },
    });
  } finally {
    run.cleanup();
  }
});

void test('pgSafe: NULs go, lone surrogates are replaced, in values and keys', () => {
  const v = pgSafe({ 'k\u0000': 'a\u0000b', list: ['ok', 'half \ud83d', { deep: '\udc00x' }], pair: '😀', n: 1 });
  assert.deepEqual(v, { k: 'ab', list: ['ok', 'half �', { deep: '�x' }], pair: '😀', n: 1 });
});
