import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataLayerOverwrittenAfterGtm,
  decodeGa4Events,
  findPii,
  tagRuntimeIssues,
  type TagPageInput,
  type TagRequest,
} from '../lib/analyzers/analytics/tag-runtime-analyzer';
import {
  analyticsConsentDenied,
  brandSiblingHosts,
  linkerVerdict,
  spaVerdict,
  TagBehaviorProbe,
  type ProbeBrowser,
  type ProbePage,
} from '../lib/analyzers/site-checks/tag-behavior-probe';
import { tagSummary } from '../lib/analyzers/site-checks/site-probes';
import { isAnalyticsFinding, isNeverRefuteCheckFinding } from '../lib/analyzers/site-checks/site-checks-types';
import { getAnalyticsTagsSection, getDomainExposureSection } from '../lib/reports/sections/domain-exposure';
import { categorize } from '../lib/phase2/categorize';
import { scoredCategoryOf } from '../lib/phase2/score-impact';
import type { PageInfo } from '../lib/types';

const PAGE = 'https://example.com/products/shoe';
const hit = (q: string) => `https://region1.google-analytics.com/g/collect?v=2&${q}`;

function input(requests: Record<string, TagRequest>, extra: Partial<TagPageInput> = {}): TagPageInput {
  return {
    url: PAGE,
    requests,
    htmlGa4Ids: ['G-AAAA111111'],
    htmlGtmIds: [],
    anchors: [],
    hasProductSchema: false,
    consentToolDetected: false,
    ...extra,
  };
}
const messages = (i: TagPageInput) => tagRuntimeIssues(i).issues.map((x) => x.message);

void test('decodeGa4Events merges URL params with each batched POST body line', () => {
  const events = decodeGa4Events({
    [hit('tid=G-AAAA111111&dl=https%3A%2F%2Fexample.com%2F')]: {
      postData: 'en=page_view\nen=scroll&epn.percent_scrolled=90',
    },
    [hit('tid=G-AAAA111111&en=user_engagement')]: {},
    'https://example.com/g/collect?tid=UA-1&en=x': {},
  });
  assert.deepEqual(
    events.map((e) => e.en),
    ['page_view', 'scroll', 'user_engagement'],
  );
  assert.equal(events[0].dl, 'https://example.com/');
});

void test('clean page: one page_view to the referenced property', () => {
  assert.deepEqual(messages(input({ [hit('tid=G-AAAA111111&en=page_view')]: { status: 204 } })), []);
});

void test('duplicate page_view, multiple and unknown properties', () => {
  const m = messages(
    input({
      [hit('tid=G-AAAA111111&en=page_view&_s=1')]: {},
      [hit('tid=G-AAAA111111&en=page_view&_s=2')]: {},
      [hit('tid=G-BBBB222222&en=page_view')]: {},
    }),
  );
  assert.ok(m.includes('Duplicate GA4 page_view on page load'));
  assert.ok(m.includes('Page views sent to multiple GA4 properties'));
  assert.ok(m.includes('GA4 hits sent to a property not referenced on the page'));
});

void test('installed but silent: MEDIUM, or LOW with a consent tool', () => {
  const quiet = tagRuntimeIssues(input({}));
  assert.equal(quiet.issues[0].message, 'Analytics installed but no GA4 hits sent');
  assert.equal(quiet.issues[0].severity, 'medium');
  assert.equal(tagRuntimeIssues(input({}, { consentToolDetected: true })).issues[0].severity, 'low');
});

void test('failed GTM script and failing server-side endpoint', () => {
  const m = messages(
    input({
      'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX': { status: 404 },
      'https://sgtm.example.com/g/collect?v=2&tid=G-AAAA111111&en=page_view': { status: 500 },
    }),
  );
  assert.ok(m.includes('Google tag script failed to load'));
  assert.ok(m.includes('Server-side tagging endpoint returns errors'));
  assert.ok(!m.includes('Analytics installed but no GA4 hits sent'));
});

void test('debug mode and PII are detected; PII is masked', () => {
  const m = tagRuntimeIssues(
    input({
      [hit('tid=G-AAAA111111&en=page_view&_dbg=1&dl=https%3A%2F%2Fexample.com%2Fthanks%3Femail%3Djane.doe%40mail.com')]:
        {},
    }),
  ).issues;
  assert.ok(m.some((i) => i.message === 'GA4 debug mode enabled in production'));
  const pii = m.find((i) => i.message === 'Personal data sent to Google Analytics');
  assert.ok(pii);
  assert.doesNotMatch(pii.detail!, /jane\.doe/);
  assert.equal(
    findPii({ tid: 'G-1', en: 'x', host: 'h', params: { dl: 'https://e.com/?token=abc' } })?.sample,
    'token=…',
  );
  assert.equal(findPii({ tid: 'G-1', en: 'x', host: 'h', params: { dl: 'https://e.com/?page=2' } }), null);
});

void test('Meta Pixel duplicate PageView', () => {
  const m = messages(
    input(
      {
        'https://www.facebook.com/tr/?id=123&ev=PageView&rl=1': {},
        'https://www.facebook.com/tr/?id=123&ev=PageView&rl=2': {},
      },
      { htmlGa4Ids: [] },
    ),
  );
  assert.deepEqual(m, ['Meta Pixel fires duplicate PageView']);
  const m2 = messages(
    input(
      {
        'https://www.facebook.com/tr?id=123&ev=PageView&a=1': {},
        'https://www.facebook.com/tr?id=123&ev=PageView&a=2': {},
      },
      { htmlGa4Ids: [] },
    ),
  );
  assert.deepEqual(m2, ['Meta Pixel fires duplicate PageView']);
});

void test('dataLayer overwrite, consent order, internal UTM links, view_item', () => {
  const html = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':1})})(window,document,'script','dataLayer','GTM-X');</script>
    <script>dataLayer = [{pageType: 'product'}];</script>`;
  assert.ok(dataLayerOverwrittenAfterGtm(html));
  assert.ok(!dataLayerOverwrittenAfterGtm('<script>window.dataLayer = window.dataLayer || [];</script>'));
  const m = messages(
    input(
      { [hit('tid=G-AAAA111111&en=page_view')]: {} },
      {
        servedHtml: html,
        dataLayer: { consentDefaultIndex: 3, firstTagIndex: 0, hasViewItem: false },
        anchors: ['https://example.com/sale?utm_source=banner', 'https://other.com/?utm_source=x'],
        hasProductSchema: true,
      },
    ),
  );
  assert.ok(m.includes('dataLayer is overwritten after GTM loads'));
  assert.ok(m.includes('Consent Mode default set after tags start'));
  assert.ok(m.includes('Internal links with UTM parameters'));
  assert.ok(m.includes('Product page sends no view_item event'));
});

void test('behaviour probe helpers', () => {
  assert.deepEqual(brandSiblingHosts('www.acmeshoes.com', ['shop.acmeshoes.de', 'blog.acmeshoes.com', 'twitter.com']), [
    'shop.acmeshoes.de',
  ]);
  assert.deepEqual(brandSiblingHosts('abc.com', ['abc.de']), []); // label too short to be meaningful
  assert.ok(analyticsConsentDenied('G100'));
  assert.ok(!analyticsConsentDenied('G111'));
  assert.equal(
    linkerVerdict([{ href: 'https://shop.acme.de/', decorated: 'https://shop.acme.de/?_gl=1*abc' }]).length,
    0,
  );
  assert.equal(linkerVerdict([{ href: 'https://shop.acme.de/', decorated: 'https://shop.acme.de/' }]).length, 1);
  assert.equal(spaVerdict('https://e.com/a', 0)[0].message, 'Client-side navigation sends no page_view');
  assert.equal(spaVerdict('https://e.com/a', 1).length, 0);
});

void test('TagBehaviorProbe skips both checks when the homepage sends no GA4 hits', async () => {
  const page = {
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => [],
    url: () => 'https://example.com/',
    on: () => undefined,
  } as unknown as ProbePage;
  const browser: ProbeBrowser = {
    newContext: async () => ({ newPage: async () => page, close: async () => undefined }),
  };
  const res = await TagBehaviorProbe.probe(browser, 'https://example.com/');
  assert.deepEqual(
    res.checks.map((c) => c.status),
    ['skipped', 'skipped'],
  );
});

void test('tagSummary unions IDs and counts tagged pages with hits', () => {
  const pages = {
    a: {
      analytics: { trackingIds: { gtm: ['GTM-AB12CD'], ga4: [] } },
      tagRuntime: { ga4Ids: ['G-AAAA111111'], hits: 3, pageViews: 1, metaPixelIds: [], gtmIds: [] },
    },
    b: {
      analytics: { trackingIds: { gtm: ['GTM-AB12CD'] } },
      tagRuntime: { ga4Ids: [], hits: 0, pageViews: 0, metaPixelIds: [], gtmIds: [] },
    },
  } as unknown as Record<string, PageInfo>;
  const s = tagSummary(pages);
  assert.deepEqual(s.gtm, ['GTM-AB12CD']);
  assert.deepEqual(s.ga4, ['G-AAAA111111']);
  assert.equal(s.installed, 2);
  assert.equal(s.withHits, 1);
});

void test('analytics findings are routed, never refuted and split from Domain & Exposure', () => {
  for (const m of [
    'Duplicate GA4 page_view on page load',
    'GTM container fails to load',
    'Client-side navigation sends no page_view',
    'Personal data sent to Google Analytics',
  ]) {
    assert.ok(isAnalyticsFinding(m), m);
    assert.ok(isNeverRefuteCheckFinding(m), m);
  }
  assert.equal(categorize('Duplicate GA4 page_view on page load'), 'technical');
  assert.equal(categorize('Personal data sent to Google Analytics'), 'privacy');
  assert.equal(scoredCategoryOf('Personal data sent to Google Analytics'), 'security');
  assert.equal(scoredCategoryOf('GTM container still has Universal Analytics tags'), 'technical');

  const siteChecks = {
    checkedAt: '',
    domain: 'example.com',
    checks: [
      { id: 'spf', label: 'SPF', status: 'pass' as const },
      { id: 'ga4-hits', label: 'GA4 hits', status: 'pass' as const, note: 'hits on 3 of 3 tagged pages' },
    ],
  };
  const details = {
    'Duplicate GA4 page_view on page load': { severity: 'high', count: 2 },
    'Google tags run without Consent Mode': { severity: 'medium', count: 1 },
    'No DMARC record': { severity: 'medium', count: 1 },
  };
  const analytics = getAnalyticsTagsSection(siteChecks, details);
  const domain = getDomainExposureSection(siteChecks, details);
  assert.match(analytics, /id="analytics-tags"/);
  assert.match(analytics, /GA4 hits/);
  assert.match(analytics, /Duplicate GA4 page_view/);
  assert.match(analytics, /Google tags run without Consent Mode/);
  assert.doesNotMatch(analytics, /DMARC|SPF/);
  assert.match(domain, /No DMARC record/);
  assert.doesNotMatch(domain, /GA4|Consent Mode/);
});

void test('a hit with a 2xx response that later reports aborted is not a failure', () => {
  const m = messages(input({ [hit('tid=G-AAAA111111&en=page_view')]: { status: 204, failed: true } }));
  assert.deepEqual(m, []);
});
