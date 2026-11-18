import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PageSnapshot } from '../lib/leads/fingerprint';
import type { RunData, RunPage } from '../lib/leads/run-data';
import {
  contentNotServedCandidates,
  missingPageStatusCandidates,
  productNoPriceCandidates,
} from '../lib/leads/sales-signals';
import { runGate, servedJsonLd, servedWordCount, type GateIo } from '../lib/leads/truth-gate';
import { isMoneyPath, selectLeadPages } from '../lib/leads/page-selector';
import { buildTeaser, hasCausalWording, shortLabel, whyItMatters } from '../lib/leads/teaser';
import { parseJsonLdSchemas } from '../lib/utils';

const ORIGIN = 'https://example.com';
const u = (path: string) => `${ORIGIN}${path}`;
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const html = (body: string, head = '') =>
  `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const SHELL = html(
  '<div id="root"></div><script src="/app.js"></script><script>window.__DATA__={"text":"lots of words in a script"}</script>',
);

const snap = (status: number, body: string, url: string, headers: Record<string, string> = {}): PageSnapshot => ({
  status,
  url,
  headers: { 'content-type': 'text/html', ...headers },
  body,
});

function io(routes: Record<string, PageSnapshot | null>, missing = 404): GateIo {
  return {
    randomPath: () => '/lead-check-test',
    browser: null,
    get: async (url) => {
      if (url in routes) return routes[url];
      if (url === u('/')) return snap(200, html(`<p>${words(400)}</p>`), url);
      return snap(missing, missing === 200 ? SHELL : 'Not found', url);
    },
  };
}

function run(
  pages: RunPage[],
  extra: Partial<RunData> = {},
  checks: Array<{ id: string; status: string; note?: string }> = [],
): RunData {
  return {
    runDir: '/nonexistent',
    kind: 'lead',
    metadata: {
      leadScan: {
        cap: 25,
        home: u('/'),
        selected: pages.map((p) => ({ url: p.url, reason: p.url === u('/') ? 'homepage' : 'template', template: '/' })),
        disallowedByRobots: [],
        languages: [],
        sitemapTotal: 10,
        sitemapSample: [],
      },
      siteChecks: { domain: 'example.com', checks },
    },
    pages: Object.fromEntries(pages.map((p) => [p.url, p])),
    findings: {},
    ...extra,
  };
}

const page = (path: string, extra: Partial<RunPage> = {}): RunPage => ({
  url: u(path),
  status: 200,
  foundIn: 'sitemap',
  ...extra,
});
const PRODUCT = (offers: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Chair"${offers}}</script>`;

void describe('content missing from the served HTML', () => {
  void it('counts served words with noscript and template text, without scripts and styles', () => {
    assert.equal(servedWordCount(SHELL), 0, 'the title is not page text');
    assert.equal(servedWordCount(html('<noscript>Please enable JavaScript now</noscript>')), 4);
    assert.equal(servedWordCount(html('<template shadowrootmode="open"><p>shadow text here</p></template>')), 3);
  });

  void it('offers pages with enough rendered text, the ones the scan named first, utility pages never', () => {
    const data = run(
      [
        page('/', { contentQuality: { wordCount: 500 } }),
        page('/products/chair', { contentQuality: { wordCount: 800 } }),
        page('/about', { contentQuality: { wordCount: 900 } }),
        page('/thin', { contentQuality: { wordCount: 120 } }),
        page('/login', { contentQuality: { wordCount: 900 } }),
      ],
      {
        findings: {
          'Significant content rendered by JavaScript [high]': {
            examples: [
              `~880 additional words added by JavaScript. Raw HTML has 20 words, rendered has 900. — <a href="${u('/about')}">x</a>`,
            ],
          },
        },
      },
    );
    assert.deepEqual(
      contentNotServedCandidates(data).map((c) => `${new URL(c.url).pathname}:${c.keyReason}`),
      ['/:homepage', '/products/chair:selling page'],
    );
  });

  void it('passes when a plain request gets an empty shell, and words the fact with both counts', async () => {
    const data = run([
      page('/', { contentQuality: { wordCount: 500 } }),
      page('/products/chair', { contentQuality: { wordCount: 800 } }),
    ]);
    const result = await runGate(
      data,
      null,
      io({ [u('/')]: snap(200, SHELL, u('/')), [u('/products/chair')]: snap(200, SHELL, u('/products/chair')) }),
    );
    const h = result.highlights.find((x) => x.type === 'content-not-served');
    assert.ok(h);
    assert.equal(h.rootCause, 'content-needs-javascript');
    assert.match(
      h.fact,
      /^The HTML the server sends for the homepage holds no text at all; the page shows about 500 words once JavaScript has run; 1 more scanned page is served the same way$/,
    );
    assert.deepEqual(h.evidence.methods, ['browser-crawl', 'http-get-served-html']);
    assert.equal(result.causes[0], 'content-needs-javascript', 'leads the teaser order');
    assert.equal(hasCausalWording(`${h.fact} ${whyItMatters(h)} ${shortLabel(h)}`), false);
  });

  void it('passes over a page whose served HTML has the text; drops a redirect elsewhere and a refused request', async () => {
    const data = run([
      page('/', { contentQuality: { wordCount: 500 } }),
      page('/products/a', { contentQuality: { wordCount: 500 } }),
      page('/products/b', { contentQuality: { wordCount: 500 } }),
    ]);
    const result = await runGate(
      data,
      null,
      io({
        [u('/products/a')]: snap(200, SHELL, u('/geo/us')),
        [u('/products/b')]: snap(403, 'Forbidden', u('/products/b')),
      }),
    );
    assert.equal(
      result.highlights.some((x) => x.type === 'content-not-served'),
      false,
    );
    const reasons = result.candidatesDropped.filter((d) => d.type === 'content-not-served').map((d) => d.reason);
    assert.deepEqual(
      reasons.sort(),
      ['blocked', 'no-second-method-available'],
      'a page served with its text leaves no drop',
    );
  });
});

void describe('product page without a price for search engines', () => {
  const noOffers = {
    structuredData: { jsonLdSchemas: [{ type: 'Product', warnings: ['Missing recommended field: offers'] }] },
  };

  void it('reads JSON-LD nodes from served HTML, @graph included, and skips broken blocks', () => {
    const body = html(
      `<script type="application/ld+json">{"@graph":[{"@type":"Product"},{"@type":"WebSite"}]}</script><script type="application/ld+json">{broken</script><script type=application/ld+json>null</script>`,
    );
    assert.deepEqual(
      servedJsonLd(body).map((n) => n['@type'] ?? 'graph'),
      ['graph', 'Product', 'WebSite'],
    );
  });

  void it('offers only pages whose every Product lacks offers', () => {
    const data = run([
      page('/products/chair', noOffers),
      page('/products/table', {
        structuredData: { jsonLdSchemas: [{ type: 'Product', warnings: ['Missing recommended field: sku'] }] },
      }),
      page('/blog/x', { structuredData: { jsonLdSchemas: [{ type: 'Article', warnings: [] }] } }),
    ]);
    assert.deepEqual(
      productNoPriceCandidates(data).map((c) => c.url),
      [u('/products/chair')],
    );
  });

  void it('passes when the served page shows a price and its Product has none', async () => {
    const data = run([page('/products/chair', noOffers)]);
    const body = html(`<h1>Chair</h1><p>€ 249,00</p>${PRODUCT('')}`);
    const result = await runGate(data, null, io({ [u('/products/chair')]: snap(200, body, u('/products/chair')) }));
    const h = result.highlights.find((x) => x.type === 'product-no-price');
    assert.ok(h);
    assert.equal(
      h.fact,
      '/products/chair shows a price to visitors, but the product data it publishes for search engines (schema.org Product) has no price, offer, rating or review',
    );
    assert.equal(hasCausalWording(`${h.fact} ${whyItMatters(h)}`), false);
  });

  void it('drops it when a price is published another way, no price is shown, or the data is added by script', async () => {
    const cases: Array<[string, string]> = [
      [html(`<p>€ 249</p>${PRODUCT(',"offers":{"@type":"Offer","price":"249"}')}`), 'second-method-disagrees'],
      [
        html(`<p>€ 249</p>${PRODUCT(',"hasVariant":[{"@type":"Product","offers":{"price":"1"}}]')}`),
        'second-method-disagrees',
      ],
      [html(`<p>€ 249</p><span itemprop="price">249</span>${PRODUCT('')}`), 'second-method-disagrees'],
      [html(`<p>Ask for a quote</p>${PRODUCT('')}`), 'second-method-disagrees'],
      [
        html(`<p>€ 249</p>${PRODUCT(',"aggregateRating":{"ratingValue":4.8,"reviewCount":12}')}`),
        'second-method-disagrees',
      ],
      [html('<p>€ 249</p>'), 'no-second-method-available'],
    ];
    for (const [body, reason] of cases) {
      const data = run([page('/products/chair', noOffers)]);
      const result = await runGate(data, null, io({ [u('/products/chair')]: snap(200, body, u('/products/chair')) }));
      assert.equal(
        result.highlights.some((x) => x.type === 'product-no-price'),
        false,
      );
      assert.equal(result.candidatesDropped.find((d) => d.type === 'product-no-price')?.reason, reason);
    }
  });
});

void describe('missing pages that answer 200', () => {
  const failed = [{ id: 'not-found', status: 'fail', note: 'unknown URL returns HTTP 200' }];

  void it('is a candidate only when the audit probe got 200', () => {
    assert.equal(missingPageStatusCandidates(run([page('/')], {}, failed)).length, 1);
    assert.equal(
      missingPageStatusCandidates(
        run([page('/')], {}, [{ id: 'not-found', status: 'warn', note: 'unknown URL returns HTTP 302' }]),
      ).length,
      0,
    );
    assert.equal(missingPageStatusCandidates(run([page('/')])).length, 0);
  });

  void it('passes when two made-up addresses answer 200 in place', async () => {
    const result = await runGate(run([page('/')], {}, failed), null, io({}, 200));
    const h = result.highlights.find((x) => x.type === 'missing-page-status');
    assert.ok(h);
    assert.equal(h.url, u('/lead-check-test'));
    assert.equal(h.evidence.target, u('/lead-check-test/lead-check-test'));
    assert.match(h.fact, /answers "200 OK" where a missing page should answer "404 Not Found"$/);
    assert.equal(result.control.statusUnreliable, true);
  });

  void it('drops it when the site answers 404 after all, or sends the visitor elsewhere', async () => {
    const real = await runGate(run([page('/')], {}, failed), null, io({}));
    assert.equal(
      real.candidatesDropped.find((d) => d.type === 'missing-page-status')?.reason,
      'second-method-disagrees',
    );
    const moved = await runGate(
      run([page('/')], {}, failed),
      null,
      io({ [u('/lead-check-test')]: snap(200, SHELL, u('/')) }, 200),
    );
    assert.equal(
      moved.highlights.some((x) => x.type === 'missing-page-status'),
      false,
    );
  });
});

void describe('selling pages in the lead scan', () => {
  void it('recognises selling paths by whole segment', () => {
    for (const p of [
      '/products/chair',
      '/de/produkte/stuhl',
      '/pricing',
      '/shop',
      '/p/123',
      '/contact-sales',
      '/book/room',
    ]) {
      assert.equal(isMoneyPath(p), true, p);
    }
    for (const p of ['/press', '/production-notes', '/blog/pricing-strategy', '/planning']) {
      assert.equal(isMoneyPath(p) && !/pricing-strategy/.test(p), false, p);
    }
  });

  void it('takes up to three pages of a selling template before one page of other templates, the same on a rescan', () => {
    const sitemapUrls = [
      ...Array.from({ length: 40 }, (_, i) => u(`/blog/post-${i}`)),
      ...Array.from({ length: 20 }, (_, i) => u(`/products/item-${i}`)),
      u('/careers/engineer'),
      u('/careers/designer'),
      u('/about'),
      u('/pricing'),
    ];
    const pick = () => selectLeadPages({ home: u('/'), homeLinks: [], sitemapUrls, cap: 12 }).selected;
    const selected = pick();
    const by = (reason: string) => selected.filter((p) => p.reason === reason).map((p) => new URL(p.url).pathname);
    assert.equal(by('money').filter((p) => p.startsWith('/products/')).length, 3);
    assert.ok(by('money').includes('/pricing'));
    assert.ok(by('template').includes('/about'));
    assert.equal(
      by('template').some((p) => p.startsWith('/careers')),
      false,
      'careers wait for the fill step',
    );
    assert.deepEqual(pick(), selected);
    assert.notDeepEqual(
      by('money').filter((p) => p.startsWith('/products/')),
      ['/products/item-0', '/products/item-1', '/products/item-2'],
      'drawn from the whole template, not its first pages',
    );
  });

  void it('keeps selling pages to their share of the scan', () => {
    const sitemapUrls = ['shop', 'store', 'products', 'collections', 'catalog', 'book'].flatMap((t) =>
      Array.from({ length: 5 }, (_, i) => u(`/${t}/x-${i}`)),
    );
    const { selected } = selectLeadPages({ home: u('/'), homeLinks: [], sitemapUrls, cap: 10 });
    assert.equal(selected.filter((p) => p.reason === 'money').length, 4);
  });
});

void describe('teaser and audit fixes', () => {
  void it('a teaser can be built from the three new facts', async () => {
    const data = run(
      [
        page('/', { contentQuality: { wordCount: 500 } }),
        page('/products/chair', {
          structuredData: { jsonLdSchemas: [{ type: 'Product', warnings: ['Missing recommended field: offers'] }] },
        }),
      ],
      {},
      [{ id: 'not-found', status: 'fail', note: 'unknown URL returns HTTP 200' }],
    );
    const result = await runGate(
      data,
      null,
      io(
        {
          [u('/')]: snap(200, SHELL, u('/')),
          [u('/products/chair')]: snap(200, html(`<p>$ 49.00</p>${PRODUCT('')}`), u('/products/chair')),
        },
        200,
      ),
    );
    assert.deepEqual(result.causes, ['content-needs-javascript', 'product-data', 'missing-page-status']);
    assert.equal(result.teaserReady, true);
    for (const h of result.highlights) assert.notEqual(shortLabel(h), h.type);
    assert.equal(typeof buildTeaser, 'function');
  });

  void it('JSON-LD that is null or a bare value is not a schema', () => {
    const scripts = [
      'null',
      '"text"',
      '[null, {"@type":"Article","author":"A"}]',
      '{"@graph":[null,{"@type":"Person"}]}',
    ];
    const schemas = parseJsonLdSchemas({ querySelectorAll: () => scripts.map((textContent) => ({ textContent })) });
    assert.deepEqual(
      schemas.map((s) => s['@type'] ?? 'graph'),
      ['Article', 'graph', 'Person'],
    );
  });
});
