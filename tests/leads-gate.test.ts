import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PageSnapshot } from '../lib/leads/fingerprint';
import type { RunData, RunPage } from '../lib/leads/run-data';
import { buildCandidates, deadLinkCandidates, isLanguageSwitch, noindexCandidates } from '../lib/leads/sales-signals';
import { emptyProfile } from '../lib/leads/stack-profile';
import {
  groupByRootCause,
  runControl,
  runGate,
  servedNoindex,
  type GateBrowser,
  type GateIo,
  type Highlight,
} from '../lib/leads/truth-gate';
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
): GateBrowser & { clicks: string[] } => {
  const clicks: string[] = [];
  return {
    clicks,
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
    );
    assert.deepEqual(grouped[1].evidence.also, ['c', 'd']);
    assert.equal(grouped[1].fact, 'fact b; 2 more navigation links do the same');
    assert.equal(dropped.filter((d) => d.reason === 'same-root-cause').length, 2);
  });

  void it('three distinct causes make a teaser; the security check and the allowlist are reported', async () => {
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
      'end-of-life:drupal',
      'language-switch',
      'dead-navigation-links',
      'broken-images',
    ]);
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
