import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HydrationMismatchAnalyzer,
  compareSeoTags,
  extractSeoTags,
  HYDRATION_MISMATCH_MESSAGE,
} from '../lib/analyzers/seo/hydration-mismatch-analyzer';
import { hiddenContentIssues, HiddenContentAnalyzer } from '../lib/analyzers/seo/hidden-content-analyzer';
import {
  scrollLoadedIssues,
  ScrollLoadedContentAnalyzer,
  type ScrollPage,
} from '../lib/analyzers/seo/scroll-loaded-content-analyzer';
import {
  DarkModeContrastAnalyzer,
  darkModeContrastIssues,
  supportsDarkMode,
  type DarkModePage,
} from '../lib/analyzers/accessibility/dark-mode-contrast-analyzer';
import {
  FormHealthAnalyzer,
  CAPTCHA_FAILED_MESSAGE,
  INSECURE_FORM_MESSAGE,
  THIRD_PARTY_FORM_MESSAGE,
} from '../lib/analyzers/content/form-health-analyzer';
import {
  numbersInText,
  priceConsistencyIssues,
  productPricesFromJsonLd,
  PriceConsistencyAnalyzer,
} from '../lib/analyzers/seo/price-consistency-analyzer';
import {
  assetDeliveryIssues,
  cdnHtmlCacheIssues,
  classifyCdnCache,
  hasCacheBuster,
  DUPLICATE_LIBRARY_MESSAGE,
  NO_CACHE_BUSTING_MESSAGE,
  REDIRECTED_ASSETS_MESSAGE,
} from '../lib/analyzers/performance/asset-delivery-analyzer';
import {
  attributeBannerShifts,
  bannerClsIssues,
  ClsAttributionAnalyzer,
} from '../lib/analyzers/performance/cls-attribution';

// ─── hydration mismatch ─────────────────────────────────────────────────────

const doc = (head: string, body = '') => `<html><head>${head}</head><body>${body}</body></html>`;

void test('hydration: differing canonical is HIGH, differing title MEDIUM', () => {
  const served = doc('<title>Shoes</title><link rel="canonical" href="/a">', '<h1>Shoes</h1>');
  const rendered = doc('<title>Boots</title><link rel="canonical" href="https://x.com/b">', '<h1>Shoes</h1>');
  const r = HydrationMismatchAnalyzer.analyze(served, rendered, 'https://x.com/a');
  assert.deepEqual(
    r.issues.map((i) => [i.message, i.severity]),
    [
      [HYDRATION_MISMATCH_MESSAGE, 'high'],
      [HYDRATION_MISMATCH_MESSAGE, 'medium'],
    ],
  );
});

void test('hydration: whitespace, case, entities and robots order are ignored; missing tags skipped', () => {
  const s = extractSeoTags(doc('<title> Tom &amp; Jerry\n</title><meta name="robots" content="noindex, follow">'));
  const r = extractSeoTags(
    doc('<title>tom & jerry</title><meta name="robots" content="follow,noindex">', '<h1>x</h1>'),
  );
  assert.deepEqual(compareSeoTags(s, r), []);
});

// ─── hidden content ─────────────────────────────────────────────────────────

void test('hidden content: only flags near-empty visible text with lots hidden', async () => {
  assert.equal(hiddenContentIssues({ visibleWords: 20, hiddenWords: 500 }).length, 1);
  assert.equal(hiddenContentIssues({ visibleWords: 80, hiddenWords: 5000 }).length, 0);
  assert.equal(hiddenContentIssues({ visibleWords: 10, hiddenWords: 300 }).length, 0);
  const r = await HiddenContentAnalyzer.analyze({ evaluate: () => Promise.reject(new Error('x')) });
  assert.equal(r.issues.length, 0);
});

// ─── scroll-loaded ──────────────────────────────────────────────────────────

void test('scroll-loaded: thresholds', () => {
  assert.equal(scrollLoadedIssues({ words: 500, internalLinks: 10 }, { words: 700, internalLinks: 10 }).length, 1);
  assert.equal(scrollLoadedIssues({ words: 1000, internalLinks: 10 }, { words: 1250, internalLinks: 15 }).length, 0);
  assert.equal(scrollLoadedIssues({ words: 1000, internalLinks: 10 }, { words: 1000, internalLinks: 20 }).length, 1);
});

void test('scroll-loaded: scrolls, re-measures and scrolls back to top', async () => {
  let snaps = 0;
  const calls: string[] = [];
  const page = {
    evaluate: (fn: unknown, arg?: unknown) => {
      const src = String(fn);
      if (src.includes('innerText')) {
        snaps++;
        return Promise.resolve(snaps === 1 ? { words: 100, internalLinks: 5 } : { words: 900, internalLinks: 40 });
      }
      calls.push(arg === undefined ? 'top' : `step${String(arg)}`);
      return Promise.resolve(arg !== undefined && Number(arg) >= 2);
    },
  } as unknown as ScrollPage;
  const r = await ScrollLoadedContentAnalyzer.analyze(page, () => Promise.resolve());
  assert.equal(r.issues.length, 1);
  assert.equal(calls.at(-1), 'top');
  assert.ok(calls.filter((c) => c.startsWith('step')).length <= 8);
});

// ─── dark mode contrast ─────────────────────────────────────────────────────

void test('dark mode: skipped when unsupported, emulation restored when scanned', async () => {
  assert.equal(supportsDarkMode({ mediaRules: 0, colorSchemeMeta: false, colorSchemeCss: false }), false);
  const emulated: unknown[] = [];
  let n = 0;
  const page: DarkModePage = {
    evaluate: <T>() => {
      n++;
      return Promise.resolve(
        (n === 1
          ? { mediaRules: 2, colorSchemeMeta: false, colorSchemeCss: false }
          : {
              checked: 10,
              failures: [
                { text: 'Hi <b>', selector: 'p', ratio: 1.8, fg: 'rgb(0, 0, 0)', bg: 'rgb(20, 20, 20)', large: false },
              ],
            }) as T,
      );
    },
    emulateMedia: (o) => {
      emulated.push(o.colorScheme);
      return Promise.resolve();
    },
  };
  const r = await DarkModeContrastAnalyzer.analyze(page, () => Promise.resolve());
  assert.deepEqual(emulated, ['dark', null]);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].detail ?? '', /Hi &lt;b&gt;/);
  assert.equal(darkModeContrastIssues({ checked: 5, failures: [] }).length, 0);
});

// ─── form health ────────────────────────────────────────────────────────────

void test('form health: insecure action, third-party credentials, failed captcha', () => {
  const html = `<form action="http://x.com/login"><input type="password"></form>
    <form action="https://evil-collector.io/c"><input type="email"></form>
    <form action="https://forms.hsforms.com/x"><input type="email"></form>
    <div class="g-recaptcha" data-sitekey="k"></div>`;
  const r = FormHealthAnalyzer.analyze(html, 'https://x.com/', {
    'https://www.google.com/recaptcha/api.js': { status: 403 },
  });
  assert.deepEqual(
    r.issues.map((i) => i.message),
    [INSECURE_FORM_MESSAGE, THIRD_PARTY_FORM_MESSAGE, CAPTCHA_FAILED_MESSAGE],
  );
  assert.doesNotMatch(r.issues[1].detail ?? '', /hsforms/);
  const ok = FormHealthAnalyzer.analyze('<div class="g-recaptcha"></div>', 'https://x.com/', {
    'https://www.google.com/recaptcha/api.js': { status: 200 },
  });
  assert.equal(ok.issues.length, 0);
});

// ─── price consistency ──────────────────────────────────────────────────────

void test('price: Offer, AggregateOffer, @graph and number formats', () => {
  const graph = JSON.stringify({
    '@graph': [
      { '@type': 'Product', name: 'Sofa', offers: { '@type': 'Offer', price: '1299.00', priceCurrency: 'EUR' } },
    ],
  });
  for (const shown of ['€1,299.00', '1.299,00 €', '1299 EUR', '1 299,00 €', '€1299']) {
    assert.equal(priceConsistencyIssues([graph], `Sofa ${shown} Buy`).length, 0, shown);
  }
  assert.equal(priceConsistencyIssues([graph], 'Sofa €1,199.00').length, 1);
  const agg = { '@type': 'Product', name: 'T', offers: [{ '@type': 'AggregateOffer', lowPrice: 10, highPrice: 20 }] };
  assert.deepEqual(productPricesFromJsonLd([agg])[0].prices, [10, 20]);
  assert.equal(priceConsistencyIssues([agg], 'From $20').length, 0);
  assert.ok(numbersInText('$12.99').has(12.99));
  const html = `<script type="application/ld+json">${graph}</script>`;
  assert.equal(PriceConsistencyAnalyzer.analyze(html, 'Sofa 999').issues.length, 1);
});

// ─── asset delivery ─────────────────────────────────────────────────────────

void test('asset delivery: redirects, cache-busting, duplicate libraries', () => {
  const issues = assetDeliveryIssues(
    {
      'https://x.com/': { resourceType: 'document', status: 200 },
      'https://x.com/img/a.png': { resourceType: 'image', status: 301 },
      'https://x.com/app.js': {
        resourceType: 'script',
        status: 200,
        headers: { 'cache-control': 'public, max-age=31536000' },
      },
      'https://x.com/app.3f9a1c2b.js': {
        resourceType: 'script',
        status: 200,
        headers: { 'cache-control': 'max-age=31536000' },
      },
      'https://code.jquery.com/jquery-3.6.0.min.js': { resourceType: 'script', status: 200 },
      'https://cdn.x.com/jquery-1.12.4.min.js': { resourceType: 'script', status: 200 },
    },
    'https://x.com/',
  );
  assert.deepEqual(
    issues.map((i) => i.message),
    [REDIRECTED_ASSETS_MESSAGE, NO_CACHE_BUSTING_MESSAGE, DUPLICATE_LIBRARY_MESSAGE],
  );
  assert.doesNotMatch(issues[1].detail ?? '', /3f9a1c2b/);
  assert.equal(hasCacheBuster('https://x.com/main.css?v=12'), true);
  assert.equal(hasCacheBuster('https://x.com/main.css'), false);
});

void test('asset delivery: CDN classifier and site reducer', () => {
  assert.equal(classifyCdnCache({ 'cf-cache-status': 'DYNAMIC' }), 'miss');
  assert.equal(classifyCdnCache({ 'x-vercel-cache': 'HIT' }), 'hit');
  assert.equal(classifyCdnCache({ 'x-cache': 'Miss from cloudfront', 'x-amz-cf-id': 'a' }), 'miss');
  assert.equal(classifyCdnCache({ server: 'nginx' }), 'none');
  assert.equal(cdnHtmlCacheIssues(['miss', 'miss', 'miss', 'miss', 'miss', 'none']).length, 1);
  assert.equal(cdnHtmlCacheIssues(['miss', 'miss', 'miss', 'miss']).length, 0);
  assert.equal(cdnHtmlCacheIssues(['miss', 'miss', 'miss', 'hit', 'hit']).length, 0);
});

// ─── CLS attribution ────────────────────────────────────────────────────────

const rect = (y: number) => ({ x: 0, y, width: 400, height: 100 });

void test('cls: banner itself shifting, and content pushed down by a top banner', async () => {
  const own = [
    { value: 0.06, startTime: 1, sources: [{ node: 'DIV', selector: '#onetrust-banner-sdk', currentRect: rect(800) }] },
  ];
  assert.equal(bannerClsIssues(attributeBannerShifts(own)).length, 1);
  const pushed = [
    {
      value: 0.08,
      startTime: 1,
      sources: [{ node: 'MAIN', selector: 'main', previousRect: rect(0), currentRect: rect(120) }],
    },
  ];
  assert.equal(attributeBannerShifts(pushed).length, 0);
  const r = await ClsAttributionAnalyzer.analyze(
    {
      evaluate: <T>() =>
        Promise.resolve([{ selector: '#cookie-bar', rect: { x: 0, y: 0, width: 400, height: 118 } }] as T),
    },
    pushed,
  );
  assert.equal(r.issues.length, 1);
  assert.equal(bannerClsIssues(attributeBannerShifts([{ ...own[0], value: 0.01 }])).length, 0);
});
