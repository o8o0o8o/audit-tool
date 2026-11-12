import { test } from 'node:test';
import assert from 'node:assert';
import {
  GTM_FINDING_MESSAGES,
  GTM_FINDING_PATTERN,
  GtmContainerAnalyzer,
  containerFindings,
  extractJsonObject,
  isEmptyStub,
  normalizeGtmIds,
  parseGtmContainer,
  summarizeContainer,
} from '../lib/analyzers/analytics/gtm-container-analyzer';
import type { HttpProbeFetcher } from '../lib/analyzers/site-checks/http-probe';
import { SEVERITY } from '../lib/constants';

/** Synthetic container mimicking the published gtm.js layout. */
function gtmJs(resource: object, extra = ''): string {
  return `// Copyright 2012 Google Inc. All rights reserved.\n(function(){\nvar data = {\n"resource": ${JSON.stringify(
    resource,
    null,
    1,
  )}\n,"runtime":[[50,"__c",[46,"a"],[36,[17,[15,"a"],"value"]]]]\n,"blob":{"1":"1"}${extra}\n};\n})();`;
}

const customHtml = (html: string) => ({
  function: '__html',
  tag_id: 1,
  vtp_html: ['template', html],
  vtp_supportDocumentWrite: false,
});

const SAMPLE = {
  version: '42',
  macros: [{ function: '__e' }, { function: '__c', vtp_value: 'G-OTHER12345' }],
  tags: [
    { function: '__googtag', tag_id: 2, vtp_tagId: 'G-ABC1234567' },
    { function: '__gaawe', tag_id: 3, vtp_eventName: 'lead', vtp_measurementIdOverride: ['macro', 1] },
    { function: '__ua', tag_id: 4, vtp_trackingId: 'UA-1-1' },
    { function: '__awct', tag_id: 5, vtp_conversionId: '123456789', vtp_conversionLabel: 'x' },
    { function: '__baut', tag_id: 6, vtp_tagId: '9999' },
    { function: '__paused', tag_id: 7, vtp_originalTagType: 'ua' },
    customHtml(
      '<script>!function(f,b,e){}(window,document,"https://connect.facebook.net/en_US/fbevents.js");fbq("init","1")</script>',
    ),
    customHtml('<script src="https://static.hotjar.com/c/hotjar-1.js"></script> "quoted } brace {"'),
    { function: '__cvt_123_45', tag_id: 8, vtp_pixel: 'https://analytics.tiktok.com/i18n/pixel/events.js' },
  ],
  predicates: [{ function: '_eq', arg0: ['macro', 0], arg1: 'gtm.js' }],
  rules: [
    [
      ['if', 0],
      ['add', 0],
    ],
  ],
};

void test('extractJsonObject handles nested braces and braces inside strings', () => {
  const src = 'var data = {"resource": {"a": "x}{\\"y", "b": {"c": 1}}, "runtime": []}';
  assert.strictEqual(extractJsonObject(src), '{"a": "x}{\\"y", "b": {"c": 1}}');
  assert.strictEqual(extractJsonObject('no resource here'), null);
  assert.strictEqual(extractJsonObject('{"resource": {"a": 1'), null);
});

void test('parseGtmContainer reads version, tag types, IDs and vendors', () => {
  const c = parseGtmContainer('GTM-TEST1', gtmJs(SAMPLE));
  assert.ok(c);
  assert.strictEqual(c.parsedWith, 'json');
  assert.strictEqual(c.version, '42');
  assert.strictEqual(c.tagCount, 9);
  assert.strictEqual(c.tagTypes.__html, 2);
  assert.strictEqual(c.customHtmlCount, 2);
  assert.strictEqual(c.uaTagCount, 1);
  assert.strictEqual(c.pausedTagCount, 1);
  assert.deepStrictEqual(c.ga4Ids, ['G-ABC1234567', 'G-OTHER12345']);
  assert.deepStrictEqual(c.adsIds, ['AW-123456789']);
  assert.deepStrictEqual(c.vendors, ['Bing UET', 'Google Ads', 'Hotjar', 'Meta Pixel', 'TikTok']);
  assert.ok(c.sizeBytes < c.responseBytes);
  assert.strictEqual(
    summarizeContainer(c),
    `GTM-TEST1 v42: 9 tags, 2 Custom HTML, ${Math.round(c.sizeBytes / 1024)} KB`,
  );
});

void test('parseGtmContainer falls back to a regex scan on broken JSON', () => {
  const body =
    'var data = {"resource": {"version":"7", "tags":[{"function":"__html","vtp_html":"G-ZZZ9999999"},{"function":"__ua",}], "predicates":[]}}';
  const c = parseGtmContainer('GTM-X1234', body);
  assert.ok(c);
  assert.strictEqual(c.parsedWith, 'regex');
  assert.strictEqual(c.version, '7');
  assert.strictEqual(c.customHtmlCount, 1);
  assert.strictEqual(c.uaTagCount, 1);
  assert.deepStrictEqual(c.ga4Ids, ['G-ZZZ9999999']);
});

void test('parseGtmContainer returns null for non-GTM bodies without crashing', () => {
  assert.strictEqual(parseGtmContainer('GTM-X1234', '(function(){var x=1;})();'), null);
  assert.strictEqual(parseGtmContainer('GTM-X1234', ''), null);
});

void test('isEmptyStub detects the unknown-ID stub', () => {
  assert.ok(isEmptyStub(gtmJs({ version: '1', macros: [], tags: [], predicates: [], rules: [] })));
  assert.ok(!isEmptyStub(gtmJs(SAMPLE)));
});

void test('normalizeGtmIds dedupes, uppercases and drops non-GTM IDs', () => {
  assert.deepStrictEqual(normalizeGtmIds(['gtm-abc123', 'GTM-ABC123', 'G-XYZ123456', 'GTM-<x>']), ['GTM-ABC123']);
});

void test('containerFindings: UA, unknown IDs, size and Custom HTML', () => {
  const c = parseGtmContainer('GTM-TEST1', gtmJs(SAMPLE));
  assert.ok(c);
  const issues = containerFindings(c, ['G-ABC1234567'], ['AW-123456789/label']);
  const byMsg = new Map(issues.map((i) => [i.message, i]));
  assert.strictEqual(byMsg.get(GTM_FINDING_MESSAGES.universalAnalytics)?.severity, SEVERITY.MEDIUM);
  const unknown = byMsg.get(GTM_FINDING_MESSAGES.unknownIds);
  assert.strictEqual(unknown?.severity, SEVERITY.LOW);
  assert.match(unknown?.detail ?? '', /G-OTHER12345/);
  assert.doesNotMatch(unknown?.detail ?? '', /AW-123456789,/);
  assert.ok(!byMsg.has(GTM_FINDING_MESSAGES.nearSizeLimit));
  assert.ok(!byMsg.has(GTM_FINDING_MESSAGES.manyCustomHtml));

  // No known GA4 IDs on the site → no unknown-ID finding.
  assert.ok(!containerFindings(c, [], []).some((i) => i.message === GTM_FINDING_MESSAGES.unknownIds));

  const big = { ...c, sizeBytes: 190 * 1024, customHtmlCount: 12, uaTagCount: 0 };
  const msgs = containerFindings(big, [], []).map((i) => i.message);
  assert.deepStrictEqual(msgs, [GTM_FINDING_MESSAGES.nearSizeLimit, GTM_FINDING_MESSAGES.manyCustomHtml]);
  for (const m of Object.values(GTM_FINDING_MESSAGES)) assert.match(m, GTM_FINDING_PATTERN);
});

void test('analyze: fetch failures, empty stub, network error and cap', async () => {
  const seen: string[] = [];
  const fetcher: HttpProbeFetcher = (url) => {
    seen.push(url);
    const id = new URL(url).searchParams.get('id');
    if (id === 'GTM-NET1') return Promise.resolve(null);
    if (id === 'GTM-404A') return Promise.resolve({ status: 404, url, headers: {}, body: '' });
    if (id === 'GTM-STUB') {
      return Promise.resolve({
        status: 200,
        url,
        headers: {},
        body: gtmJs({ version: '1', macros: [], tags: [], predicates: [], rules: [] }),
      });
    }
    return Promise.resolve({ status: 200, url, headers: {}, body: gtmJs(SAMPLE) });
  };
  const r = await GtmContainerAnalyzer.analyze(
    ['GTM-NET1', 'GTM-404A', 'GTM-STUB', 'GTM-EXTRA'],
    ['G-ABC1234567'],
    [],
    fetcher,
  );
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(r.issues.filter((i) => i.message === GTM_FINDING_MESSAGES.failsToLoad).length, 2);
  assert.ok(r.issues.every((i) => i.severity === SEVERITY.HIGH));
  assert.strictEqual(r.checks[0].status, 'fail');
  assert.match(r.checks[0].note ?? '', /GTM-NET1: not checked/);

  const ok = await GtmContainerAnalyzer.analyze(['GTM-GOOD'], ['G-ABC1234567'], [], fetcher);
  assert.strictEqual(ok.checks[0].status, 'warn');
  assert.strictEqual(ok.info.containers.length, 1);
  assert.match(ok.checks[0].note ?? '', /^GTM-GOOD v42: 9 tags, 2 Custom HTML/);

  const skipped = await GtmContainerAnalyzer.analyze(['GTM-NET1'], [], [], fetcher);
  assert.strictEqual(skipped.checks[0].status, 'skipped');
  assert.strictEqual(skipped.issues.length, 0);
});
