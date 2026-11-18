import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PageSnapshot } from '../lib/leads/fingerprint';
import type { RunData, RunPage } from '../lib/leads/run-data';
import {
  VULNERABLE_LIBRARY_FINDING,
  buildCandidates,
  deadLinkCandidates,
  isLanguageSwitch,
  missingHreflangCandidates,
  noindexCandidates,
  sitemapDeadCandidates,
  findingsNotOnAllowlist,
  analyticsGapCandidates,
  emailAuthCandidates,
  templateTextCandidates,
  trackingBeforeConsentCandidates,
  unnamedControlsCandidates,
  vulnerableLibraryCandidates,
} from '../lib/leads/sales-signals';
import { describeTrackingCookies, trackingCookies, trackingVendor } from '../lib/leads/tracking-cookies';
import { emptyProfile } from '../lib/leads/stack-profile';
import {
  bannerVersion,
  emailFact,
  groupByRootCause,
  readMailRecords,
  runControl,
  runGate,
  servedNoindex,
  type FirstVisit,
  type GateBrowser,
  type GateIo,
  type Highlight,
  type TagSession,
  type UnnamedControl,
} from '../lib/leads/truth-gate';
import { txtChunks } from '../lib/leads/doh';
import type { EolHit, StackProfile } from '../lib/leads/types';

const ORIGIN = 'https://example.com';
const u = (path: string) => `${ORIGIN}${path}`;
const HTML = '<!doctype html><html><head><title>Ok</title></head><body><p>Hello</p></body></html>';

const snap = (status: number, body = HTML, headers: Record<string, string> = {}, url = u('/')): PageSnapshot => ({
  status,
  url,
  headers: { 'content-type': 'text/html', ...headers },
  body,
});

/** A site that answers 200 on its homepage, 404 on anything unknown, and whatever `routes` says. */
function io(routes: Record<string, PageSnapshot | null>, browser?: GateBrowser | null): GateIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    randomPath: () => '/lead-check-test',
    browser: browser ?? null,
    get: async (url) => {
      asked.push(url);
      if (url in routes) return routes[url];
      if (url === u('/')) return snap(200);
      return snap(404, 'Not found', {}, url);
    },
  };
}

const clicking = (
  statusFor: Record<string, number | null>,
  runtime: Record<string, string> = {},
): GateBrowser & { clicks: string[]; opened: string[] } => {
  const clicks: string[] = [];
  const opened: string[] = [];
  return {
    clicks,
    opened,
    openPage: async (url) => {
      opened.push(url);
      return { status: statusFor[url] ?? 200 };
    },
    readRuntime: async () => ({ status: 200, runtime }),
    followLink: async (source, target, name) => {
      clicks.push(`${source} -> ${target}`);
      return { status: statusFor[target] ?? 200, via: 'browser-click', screenshot: `evidence/${name}.png` };
    },
  };
};

const NAV = [
  { href: u('/pricing'), text: 'Pricing', position: 'header' as const },
  { href: u('/tools/locale?_lcl=ar_AE'), text: 'العربية', position: 'header' as const },
  { href: u('/old-page'), text: 'Resources', position: 'nav' as const },
  { href: u('/careers'), text: 'Careers', position: 'footer' as const },
];

function page(path: string, extra: Partial<RunPage> = {}): RunPage {
  return { url: u(path), status: 200, foundIn: 'sitemap', siteHints: { navLinks: NAV, ctaLinks: [] }, ...extra };
}

function run(pages: RunPage[], metadata: RunData['metadata'] = {}): RunData {
  return {
    runDir: '/nonexistent',
    kind: 'lead',
    metadata: {
      leadScan: {
        cap: 25,
        home: u('/'),
        selected: [
          { url: u('/'), reason: 'homepage', template: '/' },
          { url: u('/pricing'), reason: 'navigation', template: '/pricing' },
        ],
        disallowedByRobots: [],
        languages: [],
        sitemapTotal: 10,
        sitemapSample: [],
      },
      ...metadata,
    },
    pages: Object.fromEntries(pages.map((p) => [p.url, p])),
    findings: {},
  };
}

const THREE_PAGES = [page('/'), page('/pricing'), page('/blog/a')];
const TODAY = '2026-11-13';

const stackWith = (eol: EolHit[]): StackProfile => ({ ...emptyProfile('legacy'), eol });
const DRUPAL7: EolHit = {
  product: 'drupal',
  label: 'Drupal',
  version: '7',
  cycle: '7',
  eolDate: '2025-01-05',
  kinds: ['meta', 'header'],
};

void describe('truth gate: control', () => {
  void it('passes when the homepage loads and a random missing URL is a real 404', async () => {
    const { control, requests } = await runControl(ORIGIN, io({}));
    assert.deepEqual(control, {
      homepage: 200,
      randomMissing: 404,
      blocked: false,
      statusUnreliable: false,
      note: null,
    });
    assert.equal(requests, 2);
  });

  void it('marks status codes unreliable when missing pages answer 200', async () => {
    const { control } = await runControl(ORIGIN, io({ [u('/lead-check-test')]: snap(200) }));
    assert.equal(control.statusUnreliable, true);
    assert.equal(control.blocked, false);
    assert.match(control.note ?? '', /returned 200 instead of 404/);
  });

  void it('marks the site blocked when the homepage is refused, and asks nothing more', async () => {
    const fake = io({ [u('/')]: snap(403, 'Forbidden', { server: 'cloudflare' }) });
    const { control, requests } = await runControl(ORIGIN, fake);
    assert.equal(control.blocked, true);
    assert.equal(requests, 1);
    assert.deepEqual(fake.asked, [u('/')]);
  });
});

void describe('truth gate: dead navigation links', () => {
  void it('a dead language switch passes when a plain GET and a browser click both end on 404', async () => {
    const browser = clicking({ [u('/tools/locale?_lcl=ar_AE')]: 404 });
    const result = await runGate(
      run(THREE_PAGES),
      null,
      io({ [u('/pricing')]: snap(200), [u('/old-page')]: snap(200), [u('/careers')]: snap(200) }, browser),
      { today: TODAY },
    );
    assert.equal(result.highlights.length, 1);
    const h = result.highlights[0];
    assert.equal(h.type, 'dead-nav-link');
    assert.equal(h.rootCause, 'language-switch');
    assert.equal(h.fact, 'The "العربية" link in the header returns 404 on all 3 pages scanned');
    assert.equal(h.url, u('/'), 'the prospect is pointed at the homepage');
    assert.deepEqual(h.evidence.methods, ['http-get', 'browser-click']);
    assert.deepEqual(h.evidence.control, { homepage: 200, randomMissing: 404 });
    assert.match(h.evidence.screenshot ?? '', /^evidence\/dead-nav-link-/);
    assert.equal(result.teaserReady, false, 'one cause is not a teaser');
    assert.deepEqual(
      browser.clicks,
      [`${u('/')} -> ${u('/tools/locale?_lcl=ar_AE')}`],
      'only a target the plain GET saw as gone is clicked',
    );
  });

  void it('drops a link when the browser does not agree with the plain GET', async () => {
    const result = await runGate(
      run(THREE_PAGES),
      null,
      io({ [u('/pricing')]: snap(200), [u('/old-page')]: snap(200), [u('/careers')]: snap(200) }, clicking({})),
      { today: TODAY },
    );
    assert.equal(result.highlights.length, 0);
    const drop = result.candidatesDropped.find((d) => d.reason === 'second-method-disagrees');
    assert.match(drop?.detail ?? '', /plain GET saw 404, the browser saw 200/);
  });

  void it('403, 429 and 5xx on a link target are never a dead link', async () => {
    const routes = {
      [u('/pricing')]: snap(403),
      [u('/tools/locale?_lcl=ar_AE')]: snap(429),
      [u('/old-page')]: snap(503),
      [u('/careers')]: null,
    };
    const browser = clicking({});
    const result = await runGate(run(THREE_PAGES), null, io(routes, browser), { today: TODAY });
    assert.equal(result.highlights.length, 0);
    assert.deepEqual(browser.clicks, []);
  });

  void it('does not check link targets when missing pages do not return 404', async () => {
    const fake = io({ [u('/lead-check-test')]: snap(200) }, clicking({ [u('/old-page')]: 404 }));
    const result = await runGate(run(THREE_PAGES), null, fake, { today: TODAY });
    assert.equal(result.highlights.length, 0);
    assert.deepEqual(fake.asked, [u('/'), u('/lead-check-test')], 'no link target was requested');
  });

  void it('without a browser the click cannot be made, so nothing passes', async () => {
    const result = await runGate(
      run(THREE_PAGES),
      null,
      io({ [u('/pricing')]: snap(200), [u('/careers')]: snap(200), [u('/old-page')]: snap(200) }),
      { today: TODAY },
    );
    assert.equal(result.highlights.length, 0);
    assert.ok(result.candidatesDropped.some((d) => d.reason === 'no-second-method-available'));
  });

  void it('a link with a different address on each page is one link, counted on the pages where it is gone', async () => {
    const switchOn = (path: string) => ({
      href: u(`/tools/locale?_lcl=ar_AE&_path=${encodeURIComponent(path)}`),
      text: 'عربي',
      position: 'header' as const,
    });
    const pages = ['/', '/a', '/b', '/c'].map((p) => page(p, { siteHints: { navLinks: [switchOn(p)], ctaLinks: [] } }));
    const candidates = deadLinkCandidates(run(pages));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].variants.length, 4);
    assert.equal(candidates[0].target, switchOn('/').href, 'the homepage address is the one that is clicked');

    const browser = clicking({ [switchOn('/').href]: 404 });
    // The address on /c works; the other three are gone.
    const result = await runGate(run(pages), null, io({ [switchOn('/c').href]: snap(200) }, browser), { today: TODAY });
    assert.equal(result.highlights.length, 1);
    assert.equal(result.highlights[0].fact, 'The "عربي" link in the header returns 404 on 3 of 4 pages scanned');
    assert.equal(browser.clicks.length, 1, 'one click, not one per page');
    assert.equal(result.highlights[0].evidence.also, undefined);
  });

  void it('targets the scan loaded successfully are not candidates, and language switches are recognised', () => {
    const candidates = deadLinkCandidates(run(THREE_PAGES));
    assert.equal(
      candidates.some((c) => c.target === u('/pricing')),
      false,
    );
    assert.equal(candidates.find((c) => c.target.includes('_lcl'))?.rootCause, 'language-switch');
    assert.equal(candidates.find((c) => c.target === u('/old-page'))?.rootCause, 'dead-navigation-links');
    assert.equal(isLanguageSwitch(u('/de/'), 'Deutsch'), true);
    assert.equal(isLanguageSwitch(u('/de/'), 'Our team'), false);
    assert.equal(isLanguageSwitch(u('/pricing'), 'EN'), false);
  });
});

void describe('truth gate: noindex, vitals, end of life, images', () => {
  void it('noindex passes only when the served HTML or a header carries it', async () => {
    const noindexPage = page('/pricing', { indexability: { hasNoindexTag: true, metaRobots: 'noindex, follow' } });
    const served = '<html><head><meta name="robots" content="noindex, follow"></head><body>x</body></html>';
    const yes = await runGate(
      run([page('/'), noindexPage]),
      null,
      io({
        [u('/pricing')]: snap(200, served),
        [u('/old-page')]: snap(200),
        [u('/careers')]: snap(200),
        [u('/tools/locale?_lcl=ar_AE')]: snap(200),
      }),
      { today: TODAY },
    );
    assert.equal(yes.highlights[0]?.type, 'noindex');
    assert.match(
      yes.highlights[0].fact,
      /^\/pricing, linked from the main navigation, tells search engines not to index it \(meta robots: noindex, follow\)$/,
    );
    assert.deepEqual(yes.highlights[0].evidence.methods, ['browser-crawl', 'http-get-served-html']);

    // Only the rendered page had it (added by JavaScript): not eligible.
    const no = await runGate(
      run([page('/'), noindexPage]),
      null,
      io({
        [u('/old-page')]: snap(200),
        [u('/careers')]: snap(200),
        [u('/tools/locale?_lcl=ar_AE')]: snap(200),
        [u('/pricing')]: snap(200),
      }),
      { today: TODAY },
    );
    assert.equal(no.highlights.length, 0);
    assert.ok(no.candidatesDropped.some((d) => d.type === 'noindex' && d.reason === 'second-method-disagrees'));

    assert.equal(servedNoindex('<meta content="NOINDEX" name="googlebot">'), 'NOINDEX');
    assert.equal(
      servedNoindex('<meta name="robots" content="index, follow"><meta name="description" content="noindex">'),
      null,
    );
  });

  void it('utility pages and pages that are not key pages are not noindex candidates', () => {
    const pages = [
      page('/'),
      page('/search', { indexability: { hasNoindexTag: true } }),
      page('/blog/draft', { indexability: { hasNoindexTag: true }, foundIn: 'discovered' }),
      page('/listed', { indexability: { hasNoindexTag: true }, foundIn: 'sitemap' }),
    ];
    assert.deepEqual(
      noindexCandidates(run(pages)).map((c) => `${c.keyReason}:${new URL(c.url).pathname}`),
      ['sitemap:/listed'],
    );
  });

  void it('real-user vitals pass only on phones, at origin level, well inside the poor band', async () => {
    const crux = (lcp: number, formFactor = 'PHONE', targetType = 'origin') => ({
      cruxData: {
        target: ORIGIN,
        targetType,
        formFactor,
        collectionPeriod: { lastDate: { year: 2026, month: 11, day: 9 } },
        metrics: { LCP: { percentiles: { p75: lcp } }, CLS: { percentiles: { p75: 0.05 } } },
      },
    });
    const gate = (metadata: RunData['metadata']) =>
      runGate(run([page('/', { siteHints: {} })], metadata), null, io({}), { today: TODAY });

    const poor = await gate(crux(5200));
    assert.equal(poor.highlights[0]?.type, 'poor-vitals');
    assert.match(
      poor.highlights[0].fact,
      /main content takes 5\.2 s to appear at the 75th percentile \(Google rates anything above 4\.0 s as poor\)/,
    );
    assert.equal(poor.highlights[0].evidence.source, 'Chrome UX Report, origin level, phones, 28 days to 2026-11-09');
    assert.deepEqual(poor.highlights[0].evidence.methods, ['chrome-ux-report']);

    assert.equal((await gate(crux(4100))).highlights.length, 0, 'inside the band, but not well inside');
    assert.equal((await gate(crux(5200, 'ALL_FORM_FACTORS'))).highlights.length, 0);
    assert.equal((await gate(crux(5200, 'PHONE', 'url'))).highlights.length, 0);
    assert.equal((await gate(crux(2000))).highlights.length, 0);
  });

  void it('an end-of-life version needs two kinds of evidence; a runtime global can be the second', async () => {
    const bare = run([page('/', { siteHints: {} })]);
    const drupal = await runGate(bare, stackWith([DRUPAL7]), io({}, clicking({})), { today: TODAY });
    assert.equal(drupal.highlights[0]?.fact, 'The site runs on Drupal 7, which stopped receiving fixes on 2025-01-05');
    assert.equal(drupal.highlights[0].rootCause, 'end-of-life:drupal');

    const nuxt: EolHit = {
      product: 'nuxt',
      label: 'Nuxt',
      version: '2',
      cycle: '2',
      eolDate: '2024-06-30',
      kinds: ['source'],
    };
    const oneKind = await runGate(bare, stackWith([nuxt]), io({}, clicking({}, {})), { today: TODAY });
    assert.equal(oneKind.highlights.length, 0);
    assert.ok(oneKind.candidatesDropped.some((d) => d.reason === 'version-not-confirmed-by-two-kinds'));

    const twoKinds = await runGate(bare, stackWith([nuxt]), io({}, clicking({}, { vue: '2.7.16' })), { today: TODAY });
    assert.equal(
      twoKinds.highlights[0]?.fact,
      'The site is built with Nuxt 2, which stopped receiving fixes on 2024-06-30',
    );
    assert.deepEqual(twoKinds.highlights[0].evidence.methods.sort(), ['signal:global', 'signal:source']);

    const php: EolHit = {
      product: 'php',
      label: 'PHP',
      version: '7.4.33',
      cycle: '7.4',
      eolDate: '2022-11-28',
      kinds: ['header'],
      upstreamOnly: true,
    };
    const upstream = await runGate(bare, stackWith([php]), io({}), { today: TODAY });
    assert.equal(upstream.highlights.length, 0);
    assert.ok(upstream.candidatesDropped.some((d) => d.reason === 'upstream-version-only'));
  });

  void it('a broken image passes only when its file is really gone', async () => {
    const withImage = (image: string) =>
      run([
        page('/', {
          siteHints: {},
          brokenMediaData: { brokenImages: [image] },
          visualShots: [{ kind: 'Broken images detected', file: 'evidence/home--visual/broken-1.jpg' }],
        }),
      ]);
    const gone = await runGate(withImage(u('/img/team.jpg')), null, io({}), { today: TODAY });
    assert.equal(gone.highlights[0]?.fact, 'An image on the homepage does not load: its file returns 404');
    assert.deepEqual(gone.highlights[0].evidence.methods, ['browser-render', 'http-get']);
    assert.equal(gone.highlights[0].evidence.screenshot, 'evidence/home--visual/broken-1.jpg');

    const served = await runGate(
      withImage(u('/img/ok.jpg')),
      null,
      io({ [u('/img/ok.jpg')]: snap(200, 'binary', { 'content-type': 'image/jpeg' }) }),
      { today: TODAY },
    );
    assert.equal(served.highlights.length, 0);
    assert.ok(
      served.candidatesDropped.some((d) => d.type === 'broken-image' && d.reason === 'second-method-disagrees'),
    );
  });
});

void describe('truth gate: template text, hreflang, sitemap, libraries', () => {
  const bare = (path: string, extra: Partial<RunPage> = {}) => page(path, { siteHints: {}, ...extra });

  void it('template code passes only when the served HTML shows it outside scripts and templates', async () => {
    const pages = [
      bare('/', {
        textIntegrityData: { templateTokens: ['{{ product.title }}', 'undefined'], placeholderText: false },
      }),
      bare('/about', { textIntegrityData: { templateTokens: ['undefined'], placeholderText: false } }),
    ];
    const candidates = templateTextCandidates(run(pages));
    assert.equal(candidates.length, 1, 'a bare "undefined" is not template code');
    assert.deepEqual(candidates[0].tokens, ['{{ product.title }}']);

    const served = '<html><body><h1>{{ product.title }}</h1><script>var t = "{{ x }}"</script></body></html>';
    const pass = await runGate(run(pages), null, io({ [u('/')]: snap(200, served) }), { today: TODAY });
    assert.equal(pass.highlights[0]?.type, 'template-text');
    assert.equal(
      pass.highlights[0].fact,
      'The homepage shows raw template code ("{{ product.title }}") where content should be',
    );

    const onlyInScript = '<html><body><h1>Shoes</h1><script>var t = "{{ product.title }}"</script></body></html>';
    const drop = await runGate(run(pages), null, io({ [u('/')]: snap(200, onlyInScript) }), { today: TODAY });
    assert.equal(drop.highlights.length, 0, 'text that only JavaScript shows is not eligible');
    assert.ok(drop.candidatesDropped.some((d) => d.type === 'template-text' && d.reason === 'second-method-disagrees'));

    const lorem = [bare('/', { textIntegrityData: { templateTokens: [], placeholderText: true } })];
    const loremGate = await runGate(
      run(lorem),
      null,
      io({ [u('/')]: snap(200, '<html><body><p>Lorem ipsum dolor sit amet</p></body></html>') }),
      { today: TODAY },
    );
    assert.equal(loremGate.highlights[0]?.fact, 'The homepage shows placeholder text ("Lorem ipsum")');
  });

  const intl = (lang: string) => ({ internationalSEO: { langAttribute: lang, hasHreflang: false } });
  const SITEMAP = u('/sitemap.xml');
  const multilingual = () =>
    run([bare('/', intl('nl')), bare('/en/', intl('en-GB')), bare('/fr/', intl('fr'))], {
      sitemaps: { urls: {}, total: 3, [SITEMAP]: {} },
    });
  const servedLang = (lang: string, head = '') =>
    snap(200, `<html lang="${lang}"><head>${head}</head><body>x</body></html>`);

  void it('several languages and no hreflang passes when pages, headers and sitemap all lack it', async () => {
    const c = missingHreflangCandidates(multilingual());
    assert.deepEqual(c[0]?.languages, ['nl', 'en', 'fr']);
    assert.equal(
      missingHreflangCandidates(run([bare('/', intl('nl')), bare('/en/', intl('nl'))])).length,
      0,
      'one language',
    );
    assert.equal(
      missingHreflangCandidates(
        run([bare('/', intl('nl')), bare('/en/', { internationalSEO: { langAttribute: 'en', hasHreflang: true } })]),
      ).length,
      0,
      'a page with hreflang',
    );

    const routes = {
      [u('/')]: servedLang('nl'),
      [u('/en/')]: servedLang('en'),
      [SITEMAP]: snap(200, `<urlset><url><loc>${u('/')}</loc></url></urlset>`, { 'content-type': 'application/xml' }),
    };
    const pass = await runGate(multilingual(), null, io(routes), { today: TODAY });
    assert.equal(pass.highlights[0]?.type, 'missing-hreflang');
    assert.match(
      pass.highlights[0].fact,
      /^The site has pages in Dutch, English and French, but none of the 3 pages we scanned tells search engines/,
    );
    assert.match(pass.highlights[0].fact, /no hreflang in those pages, their HTTP headers or the sitemap$/);

    const inSitemap = await runGate(
      multilingual(),
      null,
      io({ ...routes, [SITEMAP]: snap(200, '<urlset><xhtml:link rel="alternate" hreflang="en" href="x"/></urlset>') }),
      { today: TODAY },
    );
    assert.equal(inSitemap.highlights.length, 0, 'hreflang in the sitemap counts');

    const index = await runGate(
      multilingual(),
      null,
      io({
        ...routes,
        [SITEMAP]: snap(200, `<sitemapindex><sitemap><loc>${u('/pages.xml')}</loc></sitemap></sitemapindex>`),
        [u('/pages.xml')]: snap(200, '<urlset><xhtml:link hreflang="fr" href="y"/></urlset>'),
      }),
      { today: TODAY },
    );
    assert.equal(index.highlights.length, 0, 'child sitemaps of an index are read too');

    const inHeader = await runGate(
      multilingual(),
      null,
      io({
        ...routes,
        [u('/en/')]: snap(200, '<html lang="en"></html>', {
          link: '<https://example.com/>; rel="alternate"; hreflang="nl"',
        }),
      }),
      { today: TODAY },
    );
    assert.equal(inHeader.highlights.length, 0, 'hreflang in a Link header counts');

    const unreadable = await runGate(multilingual(), null, io({ ...routes, [SITEMAP]: snap(403, 'no') }), {
      today: TODAY,
    });
    assert.equal(unreadable.highlights.length, 0, 'absence is claimed only where we could look');
    assert.ok(unreadable.candidatesDropped.some((d) => d.type === 'missing-hreflang' && d.reason === 'blocked'));
  });

  const withSample = (sample: string[]) =>
    run([bare('/')], {
      leadScan: {
        cap: 25,
        home: u('/'),
        selected: [{ url: u('/'), reason: 'homepage', template: '/' }],
        disallowedByRobots: [],
        languages: [],
        sitemapTotal: 900,
        sitemapSample: sample,
      },
    });

  void it('dead sitemap URLs pass when a plain GET and a browser both see them gone, and are counted as a sample', async () => {
    const sample = Array.from({ length: 30 }, (_, i) => u(`/p/${i}`));
    const c = sitemapDeadCandidates(withSample([u('/'), ...sample]));
    assert.equal(c[0]?.sample.length, 20);
    assert.ok(!c[0].sample.includes(u('/')), 'pages the scan loaded are not re-requested');

    const routes = Object.fromEntries(c[0].sample.map((url, i) => [url, snap(i < 3 ? 404 : 200, 'x', {}, url)]));
    const browser = clicking(Object.fromEntries(c[0].sample.slice(0, 3).map((url) => [url, 404])));
    const pass = await runGate(withSample([u('/'), ...sample]), null, io(routes, browser), { today: TODAY });
    const hl = pass.highlights.find((x) => x.type === 'sitemap-dead-urls');
    assert.equal(hl?.fact, '3 of 20 sitemap addresses we sampled return 404 (the sitemap lists 900 addresses)');
    assert.equal(hl?.evidence.also?.length, 2);
    assert.equal(browser.opened.length, 3);

    const oneDead = Object.fromEntries(c[0].sample.map((url, i) => [url, snap(i < 1 ? 404 : 200, 'x', {}, url)]));
    const below = await runGate(withSample([u('/'), ...sample]), null, io(oneDead, clicking({})), { today: TODAY });
    assert.ok(below.candidatesDropped.some((d) => d.type === 'sitemap-dead-urls' && d.reason === 'below-threshold'));

    const browserSays200 = await runGate(withSample([u('/'), ...sample]), null, io(routes, clicking({})), {
      today: TODAY,
    });
    assert.equal(browserSays200.highlights.length, 0, 'the browser must agree');

    const refused = Object.fromEntries(c[0].sample.map((url) => [url, snap(429, 'slow down', {}, url)]));
    const blocked = await runGate(withSample([u('/'), ...sample]), null, io(refused, browser), { today: TODAY });
    assert.ok(blocked.candidatesDropped.some((d) => d.type === 'sitemap-dead-urls' && d.reason === 'blocked'));

    assert.equal(sitemapDeadCandidates(withSample([u('/a'), u('/b')])).length, 0, 'too small a sample');
  });

  const JQUERY_FINDING = {
    [VULNERABLE_LIBRARY_FINDING]: {
      count: 1,
      examples: [
        `jQuery 1.12.4: XSS in htmlPrefilter / DOM manipulation (CVE-2020-11022, CVE-2020-11023); upgrade to 3.5.0 or later. Bootstrap 4.1.3: XSS in tooltip/popover data-template (CVE-2019-8331); upgrade to 4.3.1 or later — <a href="${u('/')}">${u('/')}</a>`,
      ],
    },
  };
  const withScripts = (scripts: string[]) => {
    const data = run([page('/', { siteHints: { scripts } })]);
    data.findings = JQUERY_FINDING;
    return data;
  };

  void it('a library advisory passes when the downloaded file banner states the same version', async () => {
    const data = withScripts([u('/js/jquery.min.js'), u('/js/app.js'), u('/js/bootstrap.bundle.js')]);
    const c = vulnerableLibraryCandidates(data, null);
    assert.deepEqual(
      c.map((x) => `${x.lib} ${x.version} ${x.fixedIn} ${x.scripts.join(',')}`),
      [`jquery 1.12.4 3.5.0 ${u('/js/jquery.min.js')}`, `bootstrap 4.1.3 4.3.1 ${u('/js/bootstrap.bundle.js')}`],
    );

    const routes = {
      [u('/js/jquery.min.js')]: snap(200, '/*! jQuery v1.12.4 | (c) jQuery Foundation | jquery.org/license */'),
      [u('/js/bootstrap.bundle.js')]: snap(200, '/*!\n  * Bootstrap v4.1.3 (https://getbootstrap.com/)'),
    };
    const pass = await runGate(data, null, io(routes), { today: TODAY });
    const hl = pass.highlights.find((x) => x.type === 'vulnerable-library');
    assert.equal(
      hl?.fact,
      'The site loads jQuery 1.12.4, a version with a published security advisory (XSS in htmlPrefilter / DOM manipulation (CVE-2020-11022, CVE-2020-11023)); it is fixed from version 3.5.0; 1 more library on the site has a published advisory too',
    );
    assert.equal(hl?.evidence.target, u('/js/jquery.min.js'));

    const otherVersion = await runGate(
      data,
      null,
      io({
        [u('/js/jquery.min.js')]: snap(200, '/*! jQuery v3.6.0 */'),
        [u('/js/bootstrap.bundle.js')]: snap(200, ''),
      }),
      { today: TODAY },
    );
    assert.equal(otherVersion.highlights.length, 0, 'the banner must agree with the scan');
    assert.ok(
      otherVersion.candidatesDropped.some(
        (d) => d.type === 'vulnerable-library' && d.reason === 'second-method-disagrees',
      ),
    );

    const bundled = await runGate(withScripts([u('/js/app.js')]), null, io({}), { today: TODAY });
    assert.ok(bundled.candidatesDropped.some((d) => d.reason === 'no-second-method-available'));

    const drupal = { ...emptyProfile('legacy'), cms: 'Drupal' };
    assert.deepEqual(
      vulnerableLibraryCandidates(data, drupal).map((x) => x.lib),
      ['bootstrap'],
      'Drupal patches its own jQuery in place',
    );
    assert.equal(bannerVersion('jquery-ui', '/*! jQuery UI - v1.12.1 - 2016-09-14 */'), '1.12.1');
    assert.equal(bannerVersion('jquery', '/*! jQuery UI - v1.12.1 */'), null);
  });
});

void describe('truth gate: root causes, threshold, disclosure', () => {
  const h = (type: Highlight['type'], rootCause: string, target: string): Highlight => ({
    type,
    rootCause,
    angle: 'x',
    fact: `fact ${target}`,
    url: u('/'),
    evidence: { target, methods: ['a', 'b'], control: { homepage: 200, randomMissing: 404 }, checkedAt: 'now' },
    gate: 'pass',
  });

  void it('one highlight per root cause, in teaser order, with the rest folded in', () => {
    const dropped: Parameters<typeof groupByRootCause>[1] = [];
    const grouped = groupByRootCause(
      [
        h('noindex', 'noindex', 'a'),
        h('dead-nav-link', 'dead-navigation-links', 'b'),
        h('dead-nav-link', 'dead-navigation-links', 'c'),
        h('dead-nav-link', 'dead-navigation-links', 'd'),
        h('end-of-life', 'end-of-life:drupal', 'e'),
      ],
      dropped,
    );
    assert.deepEqual(
      grouped.map((g) => g.rootCause),
      ['end-of-life:drupal', 'dead-navigation-links', 'noindex'],
      'the heavy fact first; between equals, what a visitor runs into first',
    );
    assert.deepEqual(
      grouped.map((g) => g.weight),
      ['heavy', 'medium', 'medium'],
    );
    assert.deepEqual(grouped[1].evidence.also, ['c', 'd']);
    assert.equal(grouped[1].fact, 'fact b; 2 more navigation links do the same');
    assert.equal(dropped.filter((d) => d.reason === 'same-root-cause').length, 2);
  });

  void it('three distinct causes with a heavy one make a teaser; the security check and the allowlist are reported', async () => {
    const pages = [page('/', { brokenMediaData: { brokenImages: [u('/img/gone.jpg')] } }), page('/pricing')];
    const data = run(pages, {
      siteChecks: {
        checks: [
          { id: 'js-secrets', status: 'fail', note: '1 finding' },
          { id: 'subdomain-takeover', status: 'pass' },
          { id: 'caa', status: 'warn' },
        ],
      },
    });
    data.findings = { 'Orphan page': { count: 156 }, 'Broken images detected': { count: 1 } };
    const browser = clicking({ [u('/tools/locale?_lcl=ar_AE')]: 404, [u('/old-page')]: 404 });
    const result = await runGate(data, stackWith([DRUPAL7]), io({ [u('/careers')]: snap(200) }, browser), {
      today: TODAY,
    });

    assert.deepEqual(result.causes, [
      'language-switch',
      'dead-navigation-links',
      'end-of-life:drupal',
      'broken-images',
    ]);
    assert.deepEqual(
      result.highlights.map((x) => x.weight),
      ['heavy', 'heavy', 'heavy', 'medium'],
      'links dead on every page and outdated software are heavy; one broken image is not',
    );
    assert.equal(result.teaserReady, true);
    assert.deepEqual(result.disclosure, [{ check: 'js-secrets', note: '1 finding' }]);
    assert.ok(result.candidatesDropped.some((d) => d.reason === 'not-on-allowlist' && d.detail === 'orphan pages'));
    assert.ok(result.requestsSent > 0);

    const strict = await runGate(data, stackWith([DRUPAL7]), io({ [u('/careers')]: snap(200) }, browser), {
      today: TODAY,
      minCauses: 5,
    });
    assert.equal(strict.teaserReady, false);
  });

  void it('builds no candidate from a run with nothing wrong', () => {
    assert.deepEqual(buildCandidates(run([page('/', { siteHints: {} })]), null), []);
  });
});

void describe('truth gate: tracking cookies before consent, unnamed controls', () => {
  const bare = (path: string, extra: Partial<RunPage> = {}) => page(path, { siteHints: {}, ...extra });

  void it('knows analytics and advertising cookies by name, and nothing else', () => {
    assert.equal(trackingVendor('_ga'), 'Google Analytics');
    assert.equal(trackingVendor('_ga_9N2P64WP07'), 'Google Analytics');
    assert.equal(trackingVendor('_gcl_au'), 'Google Ads');
    assert.equal(trackingVendor('_hjSessionUser_1501362'), 'Hotjar');
    for (const other of [
      'ABTasty',
      'ASP.NET_SessionId',
      'OptanonConsent',
      'fr_vid',
      '_abck',
      'AWSALB',
      'test_cookie',
    ]) {
      assert.equal(trackingVendor(other), null, other);
    }
    const found = trackingCookies(['_gcl_au', 'ABTasty', '_ga', '_ga_X1', '_fbp', '_hjSession_1', '_clck', '_ga']);
    assert.equal(found.length, 6);
    assert.equal(
      describeTrackingCookies(found),
      'Google Ads (_gcl_au), Google Analytics (_ga, _ga_X1), Meta (_fbp), Hotjar (_hjSession_1) and 1 more service',
      'at most two names per service and four services',
    );
  });

  const consentRun = (cookies: string[]) =>
    run([
      bare('/', {
        consentData: { cookiesBeforeConsent: cookies, cookies: [{ name: 'ABTasty', domain: '.example.com' }] },
      }),
    ]);
  const visiting = (visit: FirstVisit | null): GateBrowser & { visits: string[] } => {
    const visits: string[] = [];
    return { ...clicking({}), visits, firstVisit: async (url) => (visits.push(url), visit) };
  };
  const cookie = (name: string) => ({ name, domain: '.example.com' });

  void it('tracking cookies pass when a first visit shows a banner with a way to refuse and the cookies already set', async () => {
    const candidates = trackingBeforeConsentCandidates(consentRun(['_gcl_au', '_ga']));
    assert.equal(candidates.length, 1);
    assert.deepEqual(
      candidates[0].cookies.map((c) => c.name),
      ['_gcl_au', '_ga'],
      'an A/B-test cookie is not tracking',
    );
    assert.deepEqual(trackingBeforeConsentCandidates(consentRun([])), [], 'no tracking cookie, no candidate');

    const browser = visiting({
      status: 200,
      cookies: [cookie('_gcl_au'), cookie('_ga'), cookie('_fbp'), cookie('OptanonConsent')],
      banner: { vendor: 'OneTrust', text: 'We use cookies', canRefuse: true },
      screenshot: 'evidence/consent.png',
    });
    const pass = await runGate(consentRun(['_gcl_au', '_ga']), null, io({}, browser), { today: TODAY });
    const h = pass.highlights.find((x) => x.type === 'tracking-before-consent');
    assert.equal(
      h?.fact,
      'The cookie banner (OneTrust) lets visitors refuse tracking, but before anyone answers, the homepage has already set 3 analytics and advertising cookies: Google Ads (_gcl_au), Google Analytics (_ga) and Meta (_fbp)',
    );
    assert.equal(h?.evidence.screenshot, 'evidence/consent.png');
    assert.deepEqual(browser.visits, [u('/')]);
  });

  void it('no banner, a notice without a way to refuse, or no cookies on a first visit: no claim', async () => {
    const data = consentRun(['_gcl_au']);
    const reasonFor = async (visit: FirstVisit | null) =>
      (await runGate(data, null, io({}, visiting(visit)), { today: TODAY })).candidatesDropped.find(
        (d) => d.type === 'tracking-before-consent',
      )?.reason;
    const base = { status: 200, cookies: [cookie('_gcl_au')], screenshot: null };
    assert.equal(await reasonFor({ ...base, banner: null }), 'no-consent-prompt');
    assert.equal(
      await reasonFor({ ...base, banner: { vendor: null, text: 'We use cookies', canRefuse: false } }),
      'no-consent-prompt',
    );
    assert.equal(
      await reasonFor({ ...base, cookies: [], banner: { vendor: null, text: 'We use cookies', canRefuse: true } }),
      'second-method-disagrees',
    );
    assert.equal(await reasonFor({ ...base, status: 403, banner: null }), 'blocked');
    const noBrowser = await runGate(data, null, io({}, clicking({})), { today: TODAY });
    assert.equal(
      noBrowser.candidatesDropped.find((d) => d.type === 'tracking-before-consent')?.reason,
      'no-second-method-available',
    );
  });

  const SOCIAL = ['<a.social-link>'];
  const unnamedRun = () =>
    run([
      bare('/', {
        agentic: { checks: { interactiveNames: { passed: false, offenders: [...SOCIAL, '<button.slick-next>'] } } },
      }),
      bare('/pricing', { agentic: { checks: { interactiveNames: { passed: false, offenders: SOCIAL } } } }),
      bare('/about', { agentic: { checks: { interactiveNames: { passed: false, offenders: SOCIAL } } } }),
    ]);
  const naming = (controls: UnnamedControl[], viewport: 'desktop' | 'phone' = 'desktop'): GateBrowser => ({
    ...clicking({}),
    unnamedControls: async () => ({ status: 200, viewport, controls, screenshot: 'evidence/unnamed.png' }),
  });
  const social = (href: string): UnnamedControl => ({
    role: 'link',
    label: '<a.social-link>',
    region: 'footer',
    href,
    hint: 'social-link icon-x',
  });

  void it('unnamed controls: one candidate, from the page whose offenders recur on the most pages', () => {
    const [c] = unnamedControlsCandidates(unnamedRun());
    assert.equal(c.url, u('/'));
    assert.deepEqual(c.offenders, ['<a.social-link>', '<button.slick-next>'], 'the most widespread first');
    assert.deepEqual(c.pagesWith, { '<a.social-link>': 3, '<button.slick-next>': 1 });
    assert.deepEqual(unnamedControlsCandidates(run([bare('/')])), []);
  });

  void it('unnamed controls pass when the accessibility tree gives them no name, and say what they are', async () => {
    const browser = naming([
      social('https://www.facebook.com/example'),
      social('https://instagram.com/example'),
      { role: 'button', label: '<button.slick-next>', region: 'main', href: null, hint: 'slick-next slick-arrow' },
      { role: 'button', label: '<button.not-in-scan>', region: 'header', href: null, hint: 'x' },
    ]);
    const pass = await runGate(unnamedRun(), null, io({}, browser), { today: TODAY });
    const h = pass.highlights.find((x) => x.type === 'unnamed-controls');
    assert.equal(
      h?.fact,
      'The Facebook and Instagram links in the footer have no accessible name on all 3 pages scanned: a screen reader announces each one only as "link"; 1 more control on the page has no name either',
    );
    assert.deepEqual(h?.evidence.methods, ['scan-static-html', 'browser-accessibility-tree:desktop']);

    const phone = await runGate(
      run([
        bare('/x', { agentic: { checks: { interactiveNames: { offenders: ['<button.menu-toggle>'] } } } }),
        bare('/y'),
      ]),
      null,
      io(
        {},
        naming(
          [{ role: 'button', label: '<button.menu-toggle>', region: 'header', href: null, hint: 'menu-toggle' }],
          'phone',
        ),
      ),
      { today: TODAY },
    );
    assert.equal(
      phone.highlights.find((x) => x.type === 'unnamed-controls')?.fact,
      'On a phone-sized screen, the menu button in the header has no accessible name on /x: a screen reader announces it only as "button"',
    );
  });

  void it('unnamed controls drop when the browser names them (an SVG title, an aria-label set by script)', async () => {
    const result = await runGate(unnamedRun(), null, io({}, naming([])), { today: TODAY });
    assert.equal(result.highlights.length, 0);
    assert.equal(
      result.candidatesDropped.find((d) => d.type === 'unnamed-controls')?.reason,
      'second-method-disagrees',
    );
  });

  void it('the findings these types are built from are not listed as left out', () => {
    const data = run([bare('/')]);
    data.findings = {
      'Interactive elements without an accessible name': { count: 3 },
      'Tracking cookies without consent banner': { count: 2 },
      'Cookies with excessive lifespan': { count: 1 },
    };
    assert.deepEqual(
      findingsNotOnAllowlist(data).map((f) => f.finding),
      ['Cookies with excessive lifespan'],
    );
  });
});

void describe('truth gate: email authentication, analytics data loss', () => {
  const absent = () => Object.assign(new Error('none'), { code: 'ENODATA' });
  const resolver = (name: string, txt: Record<string, string[]>, mx: string[] = []) => ({
    name,
    resolveTxt: async (n: string) => {
      if (n === '_dmarc.google.com') return [['v=DMARC1; p=reject']];
      if (n in txt) return txt[n].map((r) => [r]);
      throw absent();
    },
    resolveMx: async (n: string) => {
      if (mx.includes(n)) return [{ exchange: 'mx.example.net', priority: 10 }];
      throw absent();
    },
    resolveCaa: async () => [],
  });
  const checks = (spf: string, dmarc: string, status = 'fail') => ({
    siteChecks: {
      domain: 'example.com',
      checks: [
        { id: 'spf', status, note: spf },
        { id: 'dmarc', status: 'warn', note: dmarc },
      ],
    },
  });
  const emailRun = (spf: string, dmarc: string, status = 'fail') =>
    run([page('/', { siteHints: {} })], checks(spf, dmarc, status));

  void it('reads DoH TXT answers and a subdomain on its organisational domain', async () => {
    assert.deepEqual(txtChunks('"v=spf1 include:a" " -all"'), ['v=spf1 include:a', ' -all']);
    const dns = resolver('a', { 'example.com': ['v=spf1 -all'], '_dmarc.example.com': ['v=DMARC1; p=none'] });
    assert.deepEqual(await readMailRecords(dns, 'pl.example.com'), {
      domain: 'example.com',
      spf: ['v=spf1 -all'],
      lookups: 0,
      dmarc: 'none',
    });
  });

  void it('states only the gaps worth stating', () => {
    const v = { domain: 'example.com', spf: [] as string[], lookups: 0, dmarc: null as string | null };
    assert.match(emailFact(v)!, /^example\.com publishes no SPF record and no DMARC policy, so mail servers/);
    assert.match(emailFact({ ...v, dmarc: 'none' })!, /only a report-only DMARC policy \(p=none\)/);
    assert.equal(emailFact({ ...v, dmarc: 'reject' }), null, 'DMARC enforced: no SPF alone is not stated');
    assert.equal(emailFact({ ...v, spf: ['v=spf1 -all'], dmarc: 'none' }), null, 'p=none alone is too common');
    assert.match(
      emailFact({ ...v, spf: ['v=spf1 …'], lookups: 18, dmarc: 'reject' })!,
      /^example\.com has an SPF record that needs 18 DNS lookups where the email standard \(RFC 7208\) allows 10/,
    );
    assert.match(
      emailFact({ ...v, spf: ['v=spf1 -all'], lookups: 14 })!,
      /no DMARC policy, .*; it also has an SPF record that needs 14/,
    );
  });

  void it('email passes when two resolvers agree, and not otherwise', async () => {
    const r = emailRun('no record', 'no valid record');
    assert.equal(emailAuthCandidates(r).length, 1);
    assert.deepEqual(emailAuthCandidates(emailRun('v=spf1 -all (0 lookups)', 'p=reject', 'pass')), []);
    const empty = {};
    const both = [resolver('cloudflare', empty), resolver('google', empty)];
    const pass = await runGate(r, null, { ...io({}), dns: both }, { minCauses: 1 });
    const h = pass.highlights.find((x) => x.type === 'email-auth');
    assert.ok(h);
    assert.match(h.fact, /^example\.com publishes no SPF record and no DMARC policy/);
    assert.deepEqual(h.evidence.methods, [
      'scan-system-resolver',
      'dns-over-https:cloudflare',
      'dns-over-https:google',
    ]);

    const split = [resolver('cloudflare', empty), resolver('google', { 'example.com': ['v=spf1 -all'] })];
    const disagree = await runGate(r, null, { ...io({}), dns: split }, { minCauses: 1 });
    assert.equal(disagree.highlights.length, 0);
    assert.equal(disagree.candidatesDropped.find((d) => d.type === 'email-auth')?.reason, 'second-method-disagrees');

    const none = await runGate(r, null, io({}), { minCauses: 1 });
    assert.equal(none.candidatesDropped.find((d) => d.type === 'email-auth')?.reason, 'no-second-method-available');
  });

  const tagRun = (ids: Record<string, { status: string; note: string }>) =>
    run([page('/', { siteHints: {} })], {
      siteChecks: { domain: 'example.com', checks: Object.entries(ids).map(([id, c]) => ({ id, ...c })) },
    });
  const session = (s: Partial<TagSession>): GateBrowser & { sessions: number } => {
    const b = {
      ...clicking({}),
      sessions: 0,
      tagSession: async () => {
        b.sessions++;
        return { status: 200, gtm: [], pageViews: [], consentDenied: false, linker: [], spa: null, ...s };
      },
    };
    return b;
  };

  void it('analytics candidates come from the failing tag checks', () => {
    const r = tagRun({
      'gtm-container': { status: 'fail', note: 'GTM-ABC123: fails to load; GTM-OK: 3 tags' },
      'spa-pageview': { status: 'fail', note: '0 page_view after client-side navigation' },
      'ga4-linker': { status: 'pass', note: '1 sibling-domain link tested' },
    });
    const c = analyticsGapCandidates(r);
    assert.deepEqual(
      c.map((x) => x.kind),
      ['gtm-missing', 'spa-pageview'],
    );
    assert.deepEqual(c[0].containerIds, ['GTM-ABC123']);
  });

  void it('analytics gaps pass only when the browser sees them, in one session, folded into one cause', async () => {
    const r = tagRun({
      'gtm-container': { status: 'fail', note: 'GTM-ABC123: fails to load' },
      'spa-pageview': { status: 'fail', note: '0 page_view after client-side navigation' },
      'ga4-linker': { status: 'fail', note: '1 sibling-domain link tested' },
    });
    const browser = session({
      gtm: [{ id: 'GTM-ABC123', requested: true, status: 200, empty: true }],
      pageViews: ['G-1'],
      spa: { to: u('/shop'), soft: true, pageViewsAfter: 0 },
      linker: [{ href: 'https://example-shop.de/', host: 'example-shop.de', decorated: false, tids: ['G-1'] }],
    });
    const gate = await runGate(r, null, io({}, browser), { minCauses: 1 });
    assert.equal(browser.sessions, 1, 'one tag session for all three');
    assert.equal(gate.highlights.length, 1);
    const h = gate.highlights[0];
    assert.equal(h.rootCause, 'analytics-data-loss');
    assert.match(
      h.fact,
      /^The homepage loads the Google Tag Manager container GTM-ABC123, but Google sends back an empty container/,
    );
    assert.match(h.fact, /; the homepage loses analytics data in 2 more ways too$/);

    const quiet = session({
      gtm: [{ id: 'GTM-ABC123', requested: false, status: null, empty: false }],
      pageViews: [],
      spa: { to: u('/shop'), soft: true, pageViewsAfter: 0 },
      linker: [{ href: 'https://example-shop.de/', host: 'example-shop.de', decorated: false, tids: ['G-2'] }],
    });
    const none = await runGate(r, null, io({}, quiet), { minCauses: 1 });
    assert.equal(none.highlights.length, 0, 'not requested, no page view on arrival, another property');
    assert.equal(none.candidatesDropped.filter((d) => d.type === 'analytics-gap').length, 3);
  });

  void it('the SPA and linker facts name the page and the property', async () => {
    const r = tagRun({
      'spa-pageview': { status: 'fail', note: '' },
      'ga4-linker': { status: 'fail', note: '' },
    });
    const gate = await runGate(
      r,
      null,
      io(
        {},
        session({
          pageViews: ['G-1'],
          spa: { to: u('/shop'), soft: true, pageViewsAfter: 0 },
          linker: [{ href: 'https://example-shop.de/', host: 'example-shop.de', decorated: false, tids: ['G-1'] }],
        }),
      ),
      { minCauses: 1 },
    );
    assert.match(
      gate.highlights[0].fact,
      /following the site's own link to \/shop changes the page without a reload and sends no page view/,
    );
    assert.match(gate.candidatesDropped.find((d) => d.reason === 'same-root-cause')?.detail ?? '', /example-shop\.de/);
  });
});
