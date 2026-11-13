import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TechnologyDetector } from '../lib/analyzers/seo/technology-detector';

const cmsNames = (html: string, headers: Record<string, string> = {}, scripts: string[] = []) =>
  TechnologyDetector.detectFromHtml(html, headers, scripts).byCategory.cms;

const frameworkNames = (html: string, scripts: string[] = []) =>
  TechnologyDetector.detectFromHtml(html, {}, scripts).byCategory.frameworks;

void describe('technology detector: case handling', () => {
  void it('every pattern matched against lowercased input is case-insensitive', () => {
    // HTML, script URLs and header/cookie values are lowercased before matching, so a pattern with an
    // uppercase literal and no `i` flag can never match.
    const offenders: string[] = [];
    for (const [category, signatures] of Object.entries(TechnologyDetector.SIGNATURES)) {
      for (const sig of signatures) {
        const patterns: RegExp[] = [
          ...(sig.patterns.html ?? []),
          ...(sig.patterns.scripts ?? []),
          ...(sig.patterns.cookies ?? []),
          ...(sig.patterns.assetHosts ?? []),
          ...Object.values(sig.patterns.headers ?? {}),
          ...Object.values(sig.patterns.meta ?? {}),
        ];
        for (const pattern of patterns) {
          if (pattern.flags.includes('i')) continue;
          const literals = pattern.source.replace(/\\./g, '');
          if (/[A-Z]/.test(literals)) offenders.push(`${category}/${sig.name}: /${pattern.source}/`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  void it('detects cookie-only CMS signatures from a mixed-case Set-Cookie header', () => {
    const cases: Array<[string, string]> = [
      ['Concrete CMS', 'CONCRETE=abc123; path=/; HttpOnly'],
      ['Concrete CMS', 'CONCRETE5=abc123; path=/'],
      ['Craft CMS', 'CraftSessionId=abc123; path=/; HttpOnly'],
      ['Sitecore', 'SC_ANALYTICS_GLOBAL_COOKIE=abc|True; expires=Tue, 01-Jan-2030 00:00:00 GMT'],
      ['Kentico', 'CMSPreferredCulture=en-US; path=/'],
      ['ExpressionEngine', 'exp_last_visit=1700000000; path=/'],
    ];
    for (const [name, cookie] of cases) {
      assert.ok(cmsNames('<html></html>', { 'Set-Cookie': cookie }).includes(name), `${name} from "${cookie}"`);
    }
  });

  void it('finds a cookie that is not the first one in the header', () => {
    const cookie = 'session=1; path=/\nCONCRETE=abc; path=/';
    assert.ok(cmsNames('', { 'set-cookie': cookie }).includes('Concrete CMS'));
    assert.ok(cmsNames('', { 'set-cookie': 'a=1; path=/\n_shopify_y=abc; path=/' }).includes('Shopify'));
  });

  void it('detects Next.js, Nuxt and Remix from their mixed-case HTML markers', () => {
    assert.ok(frameworkNames('<script id="__NEXT_DATA__" type="application/json">{}</script>').includes('Next.js'));
    assert.ok(frameworkNames('<script>window.__NUXT__={}</script>').includes('Nuxt.js'));
    assert.ok(frameworkNames('<script>window.__remixContext = {}</script>').includes('Remix'));
    assert.equal(TechnologyDetector.quickDetectFramework('<script id="__NEXT_DATA__">{}</script>'), 'Next.js');
  });

  void it('detects Material UI from its class names', () => {
    const html = '<button class="MuiButtonBase-root MuiButton-root">Go</button>';
    assert.ok(TechnologyDetector.detectFromHtml(html).byCategory.cssFrameworks.includes('Material UI'));
  });
});

void describe('technology detector: loose signatures', () => {
  void it('does not call a site HubSpot CMS because it loads the HubSpot tracking script', () => {
    const html = '<script src="https://js.hs-scripts.com/123.js"></script><a href="https://hubspot.com">HubSpot</a>';
    const result = TechnologyDetector.detectFromHtml(html, {}, ['https://js.hs-scripts.com/123.js']);
    assert.equal(result.byCategory.cms.includes('HubSpot CMS'), false);
    assert.ok(result.byCategory.marketing.includes('HubSpot'), 'still listed as a marketing tool');
  });

  void it('detects HubSpot CMS from signals of a HubSpot-served page', () => {
    assert.ok(cmsNames('<meta name="generator" content="HubSpot">').includes('HubSpot CMS'));
    assert.ok(cmsNames('<span class="hs_cos_wrapper hs_cos_wrapper_widget">x</span>').includes('HubSpot CMS'));
    assert.ok(cmsNames('', { 'X-HS-Hub-Id': '123456' }).includes('HubSpot CMS'));
  });

  void it('detects Craft CMS without a session cookie', () => {
    assert.ok(cmsNames('<meta name="generator" content="SEOmatic">').includes('Craft CMS'));
    assert.ok(cmsNames('<input type="hidden" name="CRAFT_CSRF_TOKEN" value="x">').includes('Craft CMS'));
  });

  void it('does not call a site Magento because of a PHP session cookie', () => {
    assert.equal(cmsNames('', { 'set-cookie': 'PHPSESSID=abc; path=/' }).includes('Magento'), false);
  });

  void it('detects Magento from its own signals', () => {
    assert.ok(cmsNames('<script type="text/x-magento-init">{}</script>').includes('Magento'));
    assert.ok(cmsNames('', { 'X-Magento-Tags': 'cms_p_2' }).includes('Magento'));
    assert.ok(cmsNames('', { 'set-cookie': 'a=1\nfrontend=abc; path=/' }).includes('Magento'));
  });
});

void describe('technology detector: legacy CMS behind a headless image CDN', () => {
  // Shape of the first prospect that was mis-tagged: a Concrete CMS site whose images come from Contentful.
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/concrete/css/features/basics/frontend.css">
    <script>var CCM_DISPATCHER_FILENAME = "/index.php"; var CCM_APPLICATION_URL = "https://example.com";</script>
    <script src="/concrete/js/jquery.js"></script>
    </head><body><img src="https://images.ctfassets.net/space/asset/photo.jpg"></body></html>`;
  const headers = { 'Set-Cookie': 'CONCRETE=abc123; path=/; secure; HttpOnly' };

  void it('reports Concrete CMS, with a cookie among the detection methods', () => {
    const result = TechnologyDetector.detectFromHtml(html, headers, ['/concrete/js/jquery.js']);
    const concrete = result.technologies.find((t) => t.name === 'Concrete CMS');
    assert.ok(concrete, 'Concrete CMS detected');
    const types = concrete.detectedBy.map((m) => m.type);
    assert.ok(types.includes('cookie'), `cookie among ${types.join(', ')}`);
    assert.ok(types.includes('html'));
  });
});
