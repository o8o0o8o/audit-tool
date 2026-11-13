import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TechnologyDetector } from '../lib/analyzers/seo/technology-detector';
import { LIBRARIES } from '../lib/analyzers/security/js-library-analyzer';
import { EOL_TABLE, eolHits, eolStatus, type EolTable } from '../lib/leads/eol';
import {
  blockReason,
  extractScriptSrcs,
  fingerprintSite,
  parseRobots,
  profileFromSnapshot,
  signalSummary,
  stackColumns,
  type BrowserSnapshot,
  type PageFetcher,
  type PageSnapshot,
} from '../lib/leads/fingerprint';
import { buildStackProfile, trackOf } from '../lib/leads/stack-profile';
import { extractVersions, frameworkVariants, mergeVersions, versionsCompatible } from '../lib/leads/versions';

const TODAY = '2026-11-13';

const page = (
  body: string,
  headers: Record<string, string> = {},
  status = 200,
  url = 'https://example.com/',
): PageSnapshot => ({
  status,
  url,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body,
});

const html = (inner: string) => `<!doctype html><html><head>${inner}</head><body><p>Hello</p></body></html>`;

const profile = (body: string, headers: Record<string, string> = {}) =>
  profileFromSnapshot(page(body, headers), null, TODAY);

const CONCRETE_WITH_CONTENTFUL = html(
  `<link rel="stylesheet" href="/concrete/css/features/basics/frontend.css">
   <script src="/concrete/js/jquery.js"></script>
   <img src="https://images.ctfassets.net/space/asset/photo.jpg">`,
);

void describe('stack profile: kinds', () => {
  void it('a legacy CMS that stores images in a headless CMS is hybrid, not headless', () => {
    const p = profile(CONCRETE_WITH_CONTENTFUL, { 'set-cookie': 'CONCRETE=abc; path=/' });
    assert.equal(p.kind, 'hybrid');
    assert.equal(p.cms, 'Concrete CMS');
    assert.equal(p.cmsSecondary, 'Contentful');
    assert.equal(p.confidence, 'high', 'cookie + page source are two kinds');
    assert.equal(trackOf(p.kind), 'migrate');
  });

  void it('an asset host alone never makes a site headless', () => {
    const p = profile(html('<img src="https://images.ctfassets.net/space/asset/photo.jpg">'));
    assert.equal(p.kind, 'unknown');
    assert.equal(p.cms, 'Contentful');
    assert.equal(p.confidence, 'low');
    assert.match(p.notes.join(' '), /file store/);
  });

  void it('a headless CMS behind a meta-framework is headless: asset host + front-end markup are two kinds', () => {
    const p = profile(
      html(
        '<script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script><img src="https://cdn.sanity.io/images/p/d/a.jpg">',
      ),
    );
    assert.equal(p.kind, 'headless');
    assert.equal(p.cms, 'Sanity');
    assert.equal(p.framework, 'Next.js');
    assert.equal(p.frameworkVersion, 'Pages Router');
    assert.equal(p.confidence, 'high');
    assert.equal(trackOf(p.kind), 'optimise');
  });

  void it('a headless CMS asset host next to a plain React bundle stays low confidence', () => {
    const p = profile(
      html('<div id="root" data-reactroot=""></div><img src="https://images.ctfassets.net/s/a/p.jpg">'),
    );
    assert.equal(p.kind, 'headless');
    assert.equal(p.framework, 'React');
    assert.equal(p.confidence, 'low');
  });

  void it('a headless CMS seen by a script and an asset host is high confidence', () => {
    const p = profile(
      html(
        '<script src="/_next/static/chunks/main.js"></script><script src="https://app.storyblok.com/f/storyblok-v2-latest.js"></script><img src="https://a.storyblok.com/f/1/a.jpg">',
      ),
    );
    assert.equal(p.kind, 'headless');
    assert.equal(p.cms, 'Storyblok');
    assert.equal(p.confidence, 'high');
  });

  void it('one kind of signal is low confidence, two kinds are high', () => {
    const paths = html(
      '<link rel="stylesheet" href="/wp-content/themes/x/style.css"><script src="/wp-includes/js/a.js"></script>',
    );
    const low = profile(paths);
    assert.equal(low.kind, 'legacy');
    assert.equal(low.cms, 'WordPress');
    assert.equal(low.confidence, 'low', 'a path in the HTML and the same path in a script URL are one kind');

    const high = profile(paths, { link: '<https://example.com/wp-json/>; rel="https://api.w.org/"' });
    assert.equal(high.confidence, 'high');
  });

  void it('builders, custom front ends and empty pages', () => {
    const webflow = profile(
      html('<meta name="generator" content="Webflow">').replace(
        '<html>',
        '<html data-wf-site="abc" data-wf-page="def">',
      ),
    );
    assert.equal(webflow.kind, 'builder');
    assert.equal(webflow.confidence, 'high');
    assert.equal(trackOf(webflow.kind), 'migrate');

    const custom = profile(
      html('<script src="/_next/static/chunks/main.js"></script><script>self.__next_f.push([1,"x"])</script>'),
    );
    assert.equal(custom.kind, 'custom');
    assert.equal(custom.cms, null);
    assert.equal(custom.frameworkVersion, 'App Router');

    const nothing = profile(html('<title>Plain</title>'));
    assert.equal(nothing.kind, 'unknown');
    assert.equal(nothing.confidence, 'low');
  });

  void it('a legacy CMS that shows only as paths on a meta-framework site is a back end, not the stack', () => {
    const next = '<script src="/_next/static/chunks/main.js"></script>';
    const wpOnly = profile(html(`${next}<img src="https://cms.example.com/wp-content/uploads/a.jpg">`));
    assert.equal(wpOnly.kind, 'headless');
    assert.equal(wpOnly.cms, 'WordPress');
    assert.equal(wpOnly.confidence, 'low');
    assert.equal(trackOf(wpOnly.kind), 'optimise');
    assert.match(wpOnly.notes.join(' '), /not the system that renders the site/);

    const withHeadless = profile(
      html(`${next}<img src="/wp-content/uploads/a.jpg"><img src="https://images.ctfassets.net/s/a/p.jpg">`),
    );
    assert.equal(withHeadless.kind, 'headless');
    assert.equal(withHeadless.cms, 'Contentful');
    assert.equal(withHeadless.cmsSecondary, 'WordPress');
    assert.equal(withHeadless.confidence, 'high');

    // A generator tag or a header is evidence about the site itself: it stays the stack.
    const realWp = profile(
      html(`${next}<meta name="generator" content="WordPress 6.4"><link href="/wp-content/themes/x/style.css">`),
    );
    assert.equal(realWp.kind, 'legacy');
    assert.equal(realWp.cms, 'WordPress');

    // Without a meta-framework the paths are the only evidence there is: legacy, low confidence.
    const plain = profile(html('<link href="/wp-content/themes/x/style.css">'));
    assert.equal(plain.kind, 'legacy');
    assert.equal(plain.confidence, 'low');
  });

  void it('text inside a code sample is not a signal', () => {
    const p = profile(
      html('<title>Blog</title>') + '<pre><code>&lt;script src="/wp-content/x.js"&gt; /_next/static/</code></pre>',
    );
    assert.equal(p.cms, null);
    assert.equal(p.framework, null);
  });
});

void describe('versions', () => {
  void it('reads WordPress from the generator tag and from core asset URLs as two kinds', () => {
    const body = html(
      `<meta name="generator" content="WordPress 6.4.2">
       <meta name="generator" content="WPML ver:4.6.9 stt:1,3;">
       <link rel="stylesheet" href="https://example.com/wp-includes/css/dist/block-library/style.min.css?ver=6.4.2">
       <script src="https://example.com/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>`,
    );
    const merged = mergeVersions(extractVersions({ html: body, headers: {}, scriptSrcs: extractScriptSrcs(body) }));
    const wp = merged.find((v) => v.product === 'wordpress')!;
    assert.equal(wp.version, '6.4.2');
    assert.deepEqual(wp.kinds.sort(), ['meta', 'source']);
    assert.equal(merged.find((v) => v.product === 'jquery')?.version, '3.7.1');
  });

  void it('does not take a bundled library version for the WordPress version', () => {
    const body = html('<script src="/wp-includes/js/dist/vendor/react.min.js?ver=18.2.0"></script>');
    assert.equal(
      extractVersions({ html: body, headers: {}, scriptSrcs: [] }).some((f) => f.product === 'wordpress'),
      false,
    );
  });

  void it('reads Drupal, PHP and servers from headers', () => {
    const findings = extractVersions({
      html: html('<meta name="Generator" content="Drupal 7 (http://drupal.org)">'),
      headers: {
        'X-Generator': 'Drupal 7 (http://drupal.org)',
        'x-powered-by': 'PHP/7.4.33',
        server: 'nginx/1.18.0 (Ubuntu)',
      },
      scriptSrcs: [],
    });
    const merged = mergeVersions(findings);
    const drupal = merged.find((v) => v.product === 'drupal')!;
    assert.equal(drupal.version, '7');
    assert.deepEqual(drupal.kinds.sort(), ['header', 'meta']);
    assert.equal(merged.find((v) => v.product === 'php')?.version, '7.4.33');
    assert.equal(merged.find((v) => v.product === 'nginx')?.version, '1.18.0');
  });

  void it('marks disagreeing observations as a conflict and keeps only the agreeing kinds', () => {
    const merged = mergeVersions([
      { product: 'wordpress', label: 'WordPress', version: '6.4', kind: 'meta', source: 'meta generator' },
      { product: 'wordpress', label: 'WordPress', version: '6.2.1', kind: 'source', source: 'asset' },
    ]);
    assert.equal(merged[0].version, '6.4');
    assert.equal(merged[0].conflict, true);
    assert.deepEqual(merged[0].kinds, ['meta']);
    assert.ok(versionsCompatible('6.4', '6.4.2'));
    assert.equal(versionsCompatible('6.4', '6.40'), false);
  });

  void it('reads library versions from script paths and runtime globals', () => {
    const merged = mergeVersions(
      extractVersions({
        html: html(''),
        headers: {},
        scriptSrcs: [
          '/assets/jquery-1.12.4.min.js',
          'https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.6.9/angular.min.js',
        ],
        runtime: { jquery: '1.12.4' },
      }),
    );
    const jq = merged.find((v) => v.product === 'jquery')!;
    assert.equal(jq.version, '1.12.4');
    assert.deepEqual(jq.kinds.sort(), ['global', 'source']);
    assert.equal(merged.find((v) => v.product === 'angularjs')?.version, '1.6.9');
  });

  void it('tells the Next.js router types and Nuxt 2 apart', () => {
    assert.deepEqual(frameworkVariants('<script>self.__next_f.push([])</script>'), [
      { framework: 'Next.js', variant: 'App Router' },
    ]);
    assert.deepEqual(frameworkVariants('<div id="__nuxt"><div id="__layout"></div></div>'), [
      { framework: 'Nuxt.js', variant: '2' },
    ]);
    assert.deepEqual(frameworkVariants('<script type="application/json" id="__NUXT_DATA__">[]</script>'), [
      { framework: 'Nuxt.js', variant: '3+' },
    ]);
  });
});

void describe('end of life', () => {
  const table: EolTable = {
    generatedAt: TODAY,
    source: 'test',
    notCovered: [],
    products: {
      drupal: {
        label: 'Drupal',
        cycles: [
          { cycle: '10.6', releaseDate: null, eol: '2026-12-16' },
          { cycle: '10.5', releaseDate: null, eol: '2026-07-01' },
          { cycle: '8.9', releaseDate: null, eol: '2021-11-02' },
          { cycle: '8.8', releaseDate: null, eol: '2020-12-02' },
          { cycle: '7', releaseDate: null, eol: '2025-01-05' },
        ],
      },
      php: {
        label: 'PHP',
        cycles: [
          { cycle: '7.4', releaseDate: null, eol: '2022-11-28' },
          { cycle: '8.3', releaseDate: null, eol: '2027-12-31' },
        ],
      },
      wordpress: {
        label: 'WordPress',
        cycles: [
          { cycle: '6.4', releaseDate: null, eol: false },
          { cycle: '3.6', releaseDate: null, eol: true },
        ],
      },
    },
  };

  void it('matches a full version to its release cycle', () => {
    assert.deepEqual(eolStatus('php', '7.4.33', TODAY, table), { cycle: '7.4', eolDate: '2022-11-28', isEol: true });
    assert.equal(eolStatus('php', '8.3.1', TODAY, table)?.isEol, false);
    assert.deepEqual(eolStatus('drupal', '7', TODAY, table), { cycle: '7', eolDate: '2025-01-05', isEol: true });
    assert.equal(eolStatus('drupal', '7.98', TODAY, table)?.isEol, true);
  });

  void it('a major-only version is end-of-life only when every cycle under it has ended', () => {
    assert.deepEqual(eolStatus('drupal', '8', TODAY, table), { cycle: '8', eolDate: '2021-11-02', isEol: true });
    assert.equal(eolStatus('drupal', '10', TODAY, table)?.isEol, false, '10.6 is still maintained');
  });

  void it('answers null, not "maintained", when it does not know', () => {
    assert.equal(eolStatus('drupal', '6', TODAY, table), null);
    assert.equal(eolStatus('ghost', '5.1', TODAY, table), null);
    assert.equal(eolStatus('php', 'beta', TODAY, table), null);
  });

  void it('handles boolean end-of-life values', () => {
    assert.equal(eolStatus('wordpress', '6.4.2', TODAY, table)?.isEol, false);
    assert.deepEqual(eolStatus('wordpress', '3.6', TODAY, table), { cycle: '3.6', eolDate: null, isEol: true });
  });

  void it('raises hits only for CMSs, frameworks and PHP, and marks PHP as upstream-only', () => {
    const hits = eolHits(
      [
        { product: 'drupal', label: 'Drupal', version: '7', kinds: ['meta', 'header'], sources: [] },
        { product: 'php', label: 'PHP', version: '7.4.33', kinds: ['header'], sources: [] },
        { product: 'jquery', label: 'jQuery', version: '1.12.4', kinds: ['source'], sources: [] },
      ],
      TODAY,
    );
    assert.deepEqual(hits.map((h) => h.product).sort(), ['drupal', 'php']);
    assert.equal(hits.find((h) => h.product === 'php')?.upstreamOnly, true);
    assert.deepEqual(hits.find((h) => h.product === 'drupal')?.kinds, ['meta', 'header']);
  });

  void it('the generated table covers the stacks the end-of-life angle relies on', () => {
    for (const product of [
      'drupal',
      'wordpress',
      'joomla',
      'typo3',
      'php',
      'angularjs',
      'vue',
      'nuxt',
      'nextjs',
      'concrete-cms',
    ]) {
      assert.ok(EOL_TABLE.products[product]?.cycles.length, `${product} is in lib/data/eol-versions.json`);
    }
    assert.equal(eolStatus('drupal', '7', TODAY)?.isEol, true);
    assert.equal(eolStatus('angularjs', '1.8.3', TODAY)?.isEol, true);
  });

  void it('the hand-typed end-of-life advisories agree with the generated table', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const cases: Array<[lib: string, product: string, version: string]> = [
      ['angularjs', 'angularjs', '1.8'],
      ['vue', 'vue', '2.7'],
    ];
    for (const [lib, product, version] of cases) {
      const advisory = LIBRARIES[lib].advisories.find((a) => /end-of-life/i.test(a.summary));
      assert.ok(advisory, `${lib} has an end-of-life advisory`);
      const typed = /\((\w{3}) (\d{4})\)/.exec(advisory.summary);
      assert.ok(typed, `${lib} advisory names a month and year`);
      const status = eolStatus(product, version, TODAY);
      assert.ok(status?.eolDate, `${product} ${version} has a date in the generated table`);
      // The typed date is the first day without support; the table holds the last supported day.
      const lastDay = new Date(`${status.eolDate}T00:00:00Z`);
      const firstUnsupported = new Date(lastDay.getTime() + 24 * 3600 * 1000);
      const accepted = [lastDay, firstUnsupported].map((d) => `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
      assert.ok(
        accepted.includes(`${typed[1]} ${typed[2]}`),
        `${lib}: "${typed[1]} ${typed[2]}" vs table ${status.eolDate}`,
      );
    }
  });
});

void describe('fingerprint: reading a site', () => {
  void it('recognises refusals and challenge pages', () => {
    assert.equal(blockReason(403, { server: 'cloudflare' }, 'x'), 'challenge-403');
    assert.equal(blockReason(403, {}, 'Forbidden'), 'http-403');
    assert.equal(blockReason(429, {}, ''), 'http-429');
    assert.equal(
      blockReason(200, { 'content-type': 'text/html' }, '<html><title>Just a moment...</title></html>'),
      'challenge-page',
    );
    assert.equal(
      blockReason(
        200,
        { 'content-type': 'text/html' },
        '<html><head><title>Client Challenge</title></head><body><noscript>Please enable JavaScript to proceed.</noscript></body></html>',
      ),
      'challenge-page',
    );
    assert.equal(blockReason(200, { 'content-type': 'text/html' }, ''), 'empty');
    assert.equal(blockReason(200, { 'content-type': 'application/json' }, '{"ok":true}'), 'not-html');
    assert.equal(blockReason(200, { 'content-type': 'text/html' }, html('<title>Ok</title>')), null);
    // A long real page that mentions a protection vendor is not a challenge.
    const long = html('<title>Blog</title>') + '<p>We compared PerimeterX and others.</p>' + 'x'.repeat(25_000);
    assert.equal(blockReason(200, { 'content-type': 'text/html' }, long), null);
  });

  void it('parses robots.txt sitemaps and a site-wide disallow', () => {
    const open = parseRobots('User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n');
    assert.deepEqual(open, { sitemaps: ['https://example.com/sitemap.xml'], disallowAll: false });
    assert.equal(parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n').disallowAll, false);
    assert.equal(parseRobots('User-agent: GPTBot\nUser-agent: *\nDisallow: / # all\n').disallowAll, true);
    assert.equal(parseRobots('User-agent: *\nDisallow: /\nAllow: /public/\n').disallowAll, false);
  });

  void it('fingerprints a readable site with two requests and never opens a browser', async () => {
    const asked: string[] = [];
    const fetchPage: PageFetcher = async (url) => {
      asked.push(url);
      if (url.endsWith('/robots.txt'))
        return {
          status: 200,
          url,
          headers: { 'content-type': 'text/plain' },
          body: 'Sitemap: https://example.com/sitemap.xml',
        };
      return page(CONCRETE_WITH_CONTENTFUL, { 'set-cookie': 'CONCRETE=abc; path=/' });
    };
    let browserCalls = 0;
    const result = await fingerprintSite('example.com', {
      fetchPage,
      readInBrowser: async () => {
        browserCalls++;
        return null;
      },
      now: () => new Date(`${TODAY}T10:00:00Z`),
    });
    assert.deepEqual(asked, ['https://example.com/', 'https://example.com/robots.txt']);
    assert.equal(browserCalls, 0);
    assert.equal(result.requestsSent, 2);
    assert.equal(result.via, 'http');
    assert.equal(result.profile.kind, 'hybrid');
    assert.deepEqual(result.robots, { status: 200, sitemaps: ['https://example.com/sitemap.xml'], disallowAll: false });

    const columns = stackColumns(result);
    assert.equal(columns.stack_kind, 'hybrid');
    assert.equal(columns.cms_detected, 'Concrete CMS');
    assert.equal(columns.cms_secondary, 'Contentful');
    assert.equal(columns.stack_confidence, 'high');
    assert.match(columns.stack_signals, /Concrete CMS\[cookie\+source\]; Contentful\[asset-host\]/);
    assert.equal(columns.fingerprinted_at, `${TODAY}T10:00:00.000Z`);
  });

  void it('retries a refused site in the browser and uses what the browser saw', async () => {
    const rendered: BrowserSnapshot = {
      ...page(
        html('<meta name="generator" content="Drupal 7 (http://drupal.org)"><script src="/misc/drupal.js"></script>'),
        {
          'x-generator': 'Drupal 7 (http://drupal.org)',
        },
      ),
      scriptUrls: ['https://example.com/misc/drupal.js'],
      globals: [],
      runtime: { jquery: '1.4.4' },
      requests: 14,
    };
    const result = await fingerprintSite('example.com', {
      fetchPage: async (url) => (url.endsWith('/robots.txt') ? null : page('Forbidden', { server: 'cloudflare' }, 403)),
      readInBrowser: async () => rendered,
    });
    assert.equal(result.via, 'browser');
    assert.equal(result.unreadableReason, null);
    assert.equal(result.profile.cms, 'Drupal');
    assert.equal(result.profile.cmsVersion, '7');
    assert.equal(result.profile.confidence, 'high');
    assert.ok(
      result.profile.eol.some((h) => h.product === 'drupal'),
      'Drupal 7 is past its end of life',
    );
    assert.equal(result.requestsSent, 1 + 14 + 1);
    assert.match(signalSummary(result), /via:browser/);
  });

  void it('marks a site unreadable when the browser is refused too, and claims nothing', async () => {
    let robotsAsked = false;
    const result = await fingerprintSite('blocked.example', {
      fetchPage: async (url) => {
        if (url.endsWith('/robots.txt')) robotsAsked = true;
        return page('<html><title>Just a moment...</title></html>', { server: 'cloudflare' }, 403, url);
      },
      readInBrowser: async (url) => ({
        ...page('<html><title>Just a moment...</title></html>', {}, 403, url),
        scriptUrls: [],
        globals: [],
        runtime: {},
        requests: 3,
      }),
    });
    assert.equal(result.profile.kind, 'unreadable');
    assert.equal(result.unreadableReason, 'http-403');
    assert.equal(result.profile.cms, null);
    assert.equal(robotsAsked, false, 'a site that refused us is not asked again');
    const columns = stackColumns(result);
    assert.equal(columns.stack_kind, 'unreadable');
    assert.equal(columns.stack_confidence, '');
    assert.equal(columns.stack_signals, 'unreadable:http-403');
  });

  void it('tries the www host on a network error and reports a dead site as unreadable', async () => {
    const asked: string[] = [];
    const result = await fingerprintSite('gone.example', {
      fetchPage: async (url) => {
        asked.push(url);
        return null;
      },
    });
    assert.deepEqual(asked, ['https://gone.example/', 'https://www.gone.example/']);
    assert.equal(result.unreadableReason, 'network');
    assert.equal(result.via, 'none');
  });

  void it('does not open a browser for a homepage that is simply gone', async () => {
    let browserCalls = 0;
    const result = await fingerprintSite('example.com', {
      fetchPage: async (url) => page('Not found', {}, 404, url),
      readInBrowser: async () => {
        browserCalls++;
        return null;
      },
    });
    assert.equal(browserCalls, 0);
    assert.equal(result.unreadableReason, 'http-404');
  });

  void it('notes a redirect to another site and a site-wide robots disallow', async () => {
    const result = await fingerprintSite('old-brand.example', {
      fetchPage: async (url) =>
        url.endsWith('/robots.txt')
          ? { status: 200, url, headers: {}, body: 'User-agent: *\nDisallow: /\n' }
          : page(html('<title>New brand</title>'), {}, 200, 'https://www.new-brand.example/'),
    });
    assert.equal(result.redirectedTo, 'new-brand.example');
    assert.equal(result.robots?.disallowAll, true);
    assert.match(signalSummary(result), /redirect:new-brand\.example; robots:disallow-all/);
  });

  void it('every global a signature names is probed in the browser', () => {
    // 'analytics' and 'serviceWorker' are deliberately not probed: they exist on unrelated pages.
    const skipped = new Set(['analytics', 'serviceWorker']);
    for (const signatures of Object.values(TechnologyDetector.SIGNATURES)) {
      for (const sig of signatures) {
        for (const g of sig.patterns.globals ?? []) {
          if (!skipped.has(g)) assert.ok(TechnologyDetector.KNOWN_GLOBALS.includes(g), `${sig.name}: ${g}`);
        }
      }
    }
  });
});

void describe('stack profile: direct', () => {
  void it('two legacy CMSs with equal evidence stay low confidence', () => {
    const tech = (name: string) => ({
      name,
      category: 'CMS',
      confidence: 'medium',
      detectedBy: [
        { type: 'meta', tag: 'generator', value: name },
        { type: 'html', pattern: 'x' },
      ],
    });
    const p = buildStackProfile({ technologies: [tech('WordPress'), tech('Drupal')], versions: [], today: TODAY });
    assert.equal(p.kind, 'legacy');
    assert.equal(p.confidence, 'low');
    assert.match(p.notes.join(' '), /equal evidence/);
  });
});
