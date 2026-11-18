import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  advisoryIds,
  compareLibraryVersions,
  describeVulnerableLibrary,
  detectLibrariesFromUrl,
  detectLibrariesInContent,
  fixWording,
  libraryName,
  mergeVulnerable,
  vulnerabilitiesFor,
} from '../lib/analyzers/security/js-vulnerability-db';
import { JsLibraryScan, VULNERABLE_LIBRARY_MESSAGE } from '../lib/analyzers/site-checks/js-library-scan';
import {
  CORS_BLOCKED_MESSAGE,
  CSP_BLOCKED_MESSAGE,
  DEPRECATED_FEATURE_MESSAGE,
  QUIRKS_MODE_MESSAGE,
  STYLESHEET_FAILED_MESSAGE,
  browserIssueFindings,
  readBrowserIssue,
  type BrowserIssue,
} from '../lib/analyzers/seo/browser-issues-analyzer';
import {
  axeIssues,
  axeMessage,
  summariseAxeViolations,
  wcagCriteria,
} from '../lib/analyzers/accessibility/axe-findings';
import type { PageSnapshot } from '../lib/leads/fingerprint';
import type { RunData } from '../lib/leads/run-data';
import { blockedByPolicyCandidates, vulnerableLibraryCandidates } from '../lib/leads/sales-signals';
import { allows, enforcedPolicies, governing, parsePolicy, vendorOf } from '../lib/leads/csp';
import { hasCausalWording, shortLabel, whyItMatters } from '../lib/leads/teaser';
import { runGate, type GateIo } from '../lib/leads/truth-gate';

const URL_ = 'https://example.com/page';

void describe('JavaScript library advisories (Retire.js data)', () => {
  void it('reads a library and its version from a script address, a file name and file content', () => {
    assert.deepEqual(detectLibrariesFromUrl('https://cdn.example.com/ajax/libs/jquery/3.4.1/jquery.min.js'), [
      { library: 'jquery', version: '3.4.1', via: 'uri' },
    ]);
    assert.deepEqual(detectLibrariesFromUrl('https://example.com/js/jquery-1.12.4.min.js'), [
      { library: 'jquery', version: '1.12.4', via: 'filename' },
    ]);
    assert.deepEqual(detectLibrariesFromUrl('https://example.com/assets/app.3f9a1c.js'), []);
    assert.deepEqual(detectLibrariesInContent('var x=1;/*! jQuery v3.4.1 | (c) JS Foundation */!function(e,t){}'), [
      { library: 'jquery', version: '3.4.1', via: 'filecontent' },
    ]);
    assert.deepEqual(detectLibrariesInContent('console.log("hello")'), []);
  });

  void it('compares versions with pre-releases before their release', () => {
    assert.ok(compareLibraryVersions('3.4.1', '3.5.0') < 0);
    assert.ok(compareLibraryVersions('3.10.0', '3.9.9') > 0);
    assert.equal(compareLibraryVersions('3.5', '3.5.0'), 0);
    assert.ok(compareLibraryVersions('3.5.0-beta.1', '3.5.0') < 0);
    assert.equal(compareLibraryVersions('2.2.4-aem', '2.2.4'), 0, 'a vendor suffix is not a pre-release');
  });

  void it('lists the advisories that apply to a version, with their ids and the fixed release', () => {
    const hit = vulnerabilitiesFor({ library: 'jquery', version: '3.4.1', via: 'uri' });
    assert.ok(hit);
    assert.ok(hit.vulnerabilities.length >= 2);
    assert.match(advisoryIds(hit), /CVE-2020-1102[23]/);
    assert.equal(hit.fixedIn, '3.5.0');
    assert.match(
      describeVulnerableLibrary(hit),
      /^jquery 3\.4\.1: \d+ published advisories, worst medium \(.*\); all fixed from version 3\.5\.0$/,
    );
    assert.equal(vulnerabilitiesFor({ library: 'jquery', version: '3.7.1', via: 'uri' }), null);
    assert.equal(vulnerabilitiesFor({ library: 'not-a-library', version: '1.0.0', via: 'uri' }), null);
    assert.equal(vulnerabilitiesFor({ library: 'jquery', version: 'latest', via: 'uri' }), null);
    assert.equal(fixWording('3.999.999'), 'no fixed release in the 3.x line');
  });

  void it('keeps one row per library and version, the most severe first', () => {
    const a = vulnerabilitiesFor({ library: 'jquery', version: '3.4.1', via: 'uri' })!;
    const b = vulnerabilitiesFor({ library: 'jquery', version: '3.4.1', via: 'filecontent' })!;
    assert.equal(mergeVulnerable([a, b]).length, 1);
  });

  void it('the site scan reports what the scripts carry and keeps rows the gate can read', () => {
    const scan = new JsLibraryScan();
    scan.addUrl('https://example.com/assets/app.js');
    scan.addUrl('https://cdn.example.net/jquery/3.4.1/jquery.min.js');
    scan.addScript('https://example.com/assets/app.js', 'x;/*! jQuery v3.4.1 | (c) */y');
    const { issues, checks } = scan.result();
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.message, VULNERABLE_LIBRARY_MESSAGE);
    assert.match(
      issues[0]!.detail ?? '',
      /jquery 3\.4\.1: \d+ published advisories.*CVE-2020-1102.*all fixed from version 3\.5\.0, in https:\/\/example\.com\/assets\/app\.js/,
    );
    assert.equal(checks[0]!.id, 'js-libraries');
    assert.equal(checks[0]!.status, 'fail');
    const row = (checks[0]!.details as Array<{ script: string; via: string }>)[0]!;
    assert.equal(row.via, 'filecontent', 'the file that carries the code wins over an address');
    assert.equal(row.script, 'https://example.com/assets/app.js');

    const clean = new JsLibraryScan();
    clean.addUrl('https://example.com/assets/app.js');
    assert.equal(clean.result().checks[0]!.status, 'pass');
    assert.equal(new JsLibraryScan().result().checks[0]!.status, 'skipped');
  });

  void it('the gate passes a bundled library only when its own download carries the same version', async () => {
    const run = (version: string): RunData => ({
      runDir: '/nonexistent',
      kind: 'lead',
      metadata: {
        leadScan: {
          cap: 25,
          home: 'https://example.com/',
          selected: [],
          disallowedByRobots: [],
          languages: [],
          sitemapTotal: 0,
          sitemapSample: [],
        },
        siteChecks: {
          domain: 'example.com',
          checks: [
            {
              id: 'js-libraries',
              status: 'fail',
              details: [
                {
                  library: 'jquery',
                  version,
                  via: 'filecontent',
                  script: 'https://example.com/assets/app.js',
                  ids: 'CVE-2020-11022',
                  advisories: 2,
                  worst: 'medium',
                  fixedIn: '3.5.0',
                },
              ],
            },
          ],
        },
      },
      pages: { 'https://example.com/': { url: 'https://example.com/', status: 200 } },
      findings: {},
    });
    const snap = (status: number, body: string, url: string): PageSnapshot => ({
      status,
      url,
      headers: { 'content-type': 'text/javascript' },
      body,
    });
    const io = (body: string): GateIo => ({
      randomPath: () => '/lead-check-test',
      browser: null,
      get: async (url) =>
        url === 'https://example.com/'
          ? snap(200, '<html><body><p>hi</p></body></html>', url)
          : url.endsWith('/app.js')
            ? snap(200, body, url)
            : snap(404, 'Not found', url),
    });
    assert.equal(vulnerableLibraryCandidates(run('3.4.1'), null).length, 1);

    const pass = await runGate(run('3.4.1'), null, io('x;/*! jQuery v3.4.1 | (c) */y'));
    const h = pass.highlights.find((x) => x.type === 'vulnerable-library');
    assert.ok(h);
    assert.match(
      h.fact,
      /^The site loads jquery 3\.4\.1 in its own script app\.js: a version with \d+ published security advisories \(CVE-2020-1102.*\); all fixed from version 3\.5\.0$/,
    );
    assert.deepEqual(h.evidence.methods, ['scan:script-content', 'http-get-script-content']);
    assert.equal(h.evidence.target, 'https://example.com/assets/app.js');

    const upgraded = await runGate(run('3.4.1'), null, io('x;/*! jQuery v3.7.1 | (c) */y'));
    assert.equal(
      upgraded.highlights.some((x) => x.type === 'vulnerable-library'),
      false,
    );
    assert.equal(
      upgraded.candidatesDropped.find((d) => d.type === 'vulnerable-library')?.reason,
      'second-method-disagrees',
    );

    const gone = await runGate(run('3.4.1'), null, io('console.log(1)'));
    assert.equal(
      gone.candidatesDropped.find((d) => d.type === 'vulnerable-library')?.reason,
      'no-second-method-available',
    );
  });
});

void describe("Chrome's Issues panel", () => {
  const cors = {
    code: 'CorsIssue',
    details: {
      corsIssueDetails: {
        isWarning: false,
        request: { url: 'https://api.other.com/v1/items' },
        corsErrorStatus: { corsError: 'MissingAllowOriginHeader' },
      },
    },
  };
  const csp = (reportOnly: boolean) => ({
    code: 'ContentSecurityPolicyIssue',
    details: {
      contentSecurityPolicyIssueDetails: {
        isReportOnly: reportOnly,
        contentSecurityPolicyViolationType: 'kURLViolation',
        blockedURL: 'https://cdn.x.com/a.js',
        violatedDirective: 'script-src-elem',
      },
    },
  });

  void it('keeps the issues that mean something is blocked or broken, and drops the rest', () => {
    assert.deepEqual(readBrowserIssue(cors), {
      kind: 'cors',
      subject: 'https://api.other.com/v1/items',
      reason: 'MissingAllowOriginHeader',
    });
    assert.deepEqual(readBrowserIssue(csp(false)), {
      kind: 'csp',
      subject: 'https://cdn.x.com/a.js',
      reason: 'URL: script-src-elem',
    });
    assert.equal(readBrowserIssue(csp(true)), null, 'a report-only policy blocks nothing');
    assert.equal(
      readBrowserIssue({
        code: 'CookieIssue',
        details: { cookieIssueDetails: { cookieWarningReasons: ['WarnThirdPartyPhaseout'] } },
      }),
      null,
    );
    assert.equal(
      readBrowserIssue({
        code: 'StylesheetLoadingIssue',
        details: {
          stylesheetLoadingIssueDetails: {
            styleSheetLoadingIssueReason: 'LateImportRule',
            sourceCodeLocation: { url: 'https://example.com/a.css' },
          },
        },
      }),
      null,
    );
    assert.deepEqual(
      readBrowserIssue({
        code: 'StylesheetLoadingIssue',
        details: {
          stylesheetLoadingIssueDetails: {
            styleSheetLoadingIssueReason: 'RequestFailed',
            failedRequestInfo: { url: 'https://example.com/gone.css' },
          },
        },
      }),
      { kind: 'stylesheet', subject: 'https://example.com/gone.css', reason: 'RequestFailed' },
    );
    assert.equal(
      readBrowserIssue({
        code: 'QuirksModeIssue',
        details: { quirksModeIssueDetails: { isLimitedQuirksMode: true, url: URL_ } },
      }),
      null,
    );
    assert.equal(readBrowserIssue({ code: 'SomethingNew', details: {} }), null);
    assert.equal(readBrowserIssue(null as unknown), null);
  });

  void it('turns them into one finding per kind', () => {
    const issues: BrowserIssue[] = [
      { kind: 'cors', subject: 'https://api.other.com/v1/items', reason: 'MissingAllowOriginHeader' },
      { kind: 'cors', subject: 'https://api.other.com/v1/items', reason: 'MissingAllowOriginHeader' },
      { kind: 'csp', subject: 'https://cdn.x.com/a.js', reason: 'URL: script-src-elem' },
      { kind: 'stylesheet', subject: 'https://example.com/gone.css', reason: 'RequestFailed' },
      { kind: 'quirks', subject: URL_, reason: 'QuirksMode' },
      { kind: 'deprecation', subject: 'UnloadHandler', reason: '' },
    ];
    const found = browserIssueFindings(issues, URL_);
    assert.deepEqual(
      found.map((i) => [i.message, i.severity]),
      [
        [CORS_BLOCKED_MESSAGE, 'medium'],
        [CSP_BLOCKED_MESSAGE, 'medium'],
        [STYLESHEET_FAILED_MESSAGE, 'medium'],
        [QUIRKS_MODE_MESSAGE, 'medium'],
        [DEPRECATED_FEATURE_MESSAGE, 'low'],
      ],
    );
    assert.match(found[0]!.detail ?? '', /refused 1 request\(s\).*MissingAllowOriginHeader.*api\.other\.com/);
    assert.equal(browserIssueFindings([], URL_).length, 0);
  });

  void it('does not blame the page for quirks mode in an embedded third-party frame', () => {
    const found = browserIssueFindings(
      [{ kind: 'quirks', subject: 'https://player.video.com/embed/1', reason: 'QuirksMode' }],
      URL_,
    );
    assert.equal(found.length, 0);
  });
});

void describe('axe violations as findings', () => {
  const raw = [
    {
      id: 'button-name',
      impact: 'critical',
      help: 'Buttons must have discernible text',
      tags: ['wcag2a', 'wcag412', 'section508'],
      nodes: [{ html: '<button class="x">\n  <svg></svg></button>' }, { html: '<button></button>' }],
    },
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must meet minimum color contrast ratio thresholds',
      tags: ['wcag143'],
      nodes: [{ html: '<p>x</p>' }],
    },
    {
      id: 'region',
      impact: 'moderate',
      help: 'All page content should be contained by landmarks',
      tags: ['best-practice'],
      nodes: [{ html: '<div>x</div>' }],
    },
    {
      id: 'image-redundant-alt',
      impact: 'minor',
      help: 'Alternative text of images should not be repeated as text',
      tags: [],
      nodes: [{ html: '<img>' }],
    },
  ];

  void it('reads WCAG criteria from rule tags', () => {
    assert.deepEqual(wcagCriteria(['wcag2a', 'wcag412', 'wcag21aa', 'wcag1410', 'best-practice']), ['4.1.2', '1.4.10']);
  });

  void it('reports one finding per rule, by impact, without contrast and minor rules', () => {
    const issues = axeIssues(summariseAxeViolations(raw), URL_);
    assert.deepEqual(
      issues.map((i) => [i.message, i.severity]),
      [
        [axeMessage('Buttons must have discernible text'), 'high'],
        [axeMessage('All page content should be contained by landmarks'), 'low'],
      ],
    );
    assert.match(
      issues[0]!.detail ?? '',
      /2 element\(s\) fail axe rule <code>button-name<\/code> \(WCAG 4\.1\.2, impact critical\)/,
    );
    assert.match(issues[0]!.detail ?? '', /&lt;button class="x"&gt; &lt;svg&gt;/);
    assert.match(issues[1]!.detail ?? '', /an axe best-practice rule/);
  });
});

void describe('blocked by the site`s own Content Security Policy', () => {
  const SELF = 'https://example.com/shop';
  const policy = (text: string) => parsePolicy(text);

  void it('answers whether a policy allows an address, with fallbacks, wildcards and schemes', () => {
    const p = policy(
      "default-src 'self'; script-src 'self' https://*.googletagmanager.com https://cdn.example.net/libs/; img-src *; connect-src https:",
    );
    assert.equal(allows(p, 'script-src-elem', 'https://www.googletagmanager.com/gtm.js', SELF), true);
    assert.equal(
      allows(p, 'script-src-elem', 'https://googletagmanager.com/gtm.js', SELF),
      false,
      '*. needs a subdomain',
    );
    assert.equal(allows(p, 'script-src-elem', 'https://bat.bing.com/bat.js', SELF), false);
    assert.equal(allows(p, 'script-src-elem', 'https://example.com/app.js', SELF), true, "'self'");
    assert.equal(allows(p, 'script-src-elem', 'https://cdn.example.net/libs/a.js', SELF), true);
    assert.equal(allows(p, 'script-src-elem', 'https://cdn.example.net/other/a.js', SELF), false, 'path prefix');
    assert.equal(allows(p, 'img-src', 'https://bat.bing.com/action/0', SELF), true);
    assert.equal(allows(p, 'connect-src', 'https://bat.bing.com/x', SELF), true, 'scheme source');
    assert.equal(allows(p, 'font-src', 'https://fonts.gstatic.com/a.woff2', SELF), false, 'falls back to default-src');
    assert.equal(
      allows(policy("img-src 'self'"), 'script-src-elem', 'https://bat.bing.com/bat.js', SELF),
      true,
      'no directive governs scripts',
    );
    assert.equal(
      allows(policy("script-src 'nonce-abc' 'strict-dynamic'"), 'script-src-elem', 'https://bat.bing.com/bat.js', SELF),
      null,
    );
    assert.equal(governing(p, 'script-src-elem')?.directive, 'script-src');
  });

  void it('reads enforced policies from the header and from a meta tag, not the report-only header', () => {
    const found = enforcedPolicies(
      {
        'content-security-policy': "default-src 'self', script-src 'self'",
        'content-security-policy-report-only': "default-src 'none'",
      },
      `<meta http-equiv="Content-Security-Policy" content="img-src 'self'">`,
    );
    assert.equal(found.length, 3);
    assert.deepEqual(found[2]!.get('img-src'), ["'self'"]);
    const encoded = enforcedPolicies(
      {},
      `<meta http-equiv="Content-Security-Policy" content="connect-src &#x27;self&#x27; https://a.example.com; img-src &#39;none&#39;">`,
    );
    assert.deepEqual(encoded[0]!.get('connect-src'), ["'self'", 'https://a.example.com'], 'entities are decoded first');
    assert.deepEqual(encoded[0]!.get('img-src'), ["'none'"]);
    assert.equal(enforcedPolicies({}).length, 0);
  });

  void it('names the tags a marketing team depends on', () => {
    assert.equal(vendorOf('https://bat.bing.net/actionp/0?ti=1'), 'the Microsoft Advertising (Bing Ads) tag');
    assert.equal(vendorOf('https://connect.facebook.net/en_US/fbevents.js'), 'the Meta (Facebook) pixel');
    assert.equal(vendorOf('https://cdn.unknown-widget.io/a.js'), null);
  });

  const run = (issues: Array<{ kind: string; subject: string; reason: string }>): RunData => ({
    runDir: '/nonexistent',
    kind: 'lead',
    metadata: {
      leadScan: {
        cap: 25,
        home: 'https://example.com/',
        selected: [],
        disallowedByRobots: [],
        languages: [],
        sitemapTotal: 0,
        sitemapSample: [],
      },
    },
    pages: {
      'https://example.com/': { url: 'https://example.com/', status: 200, browserIssues: issues },
      'https://example.com/shop': { url: 'https://example.com/shop', status: 200, browserIssues: issues },
    },
    findings: {},
  });
  const bing = { kind: 'csp', subject: 'https://bat.bing.net/actionp/0?ti=1', reason: 'URL: connect-src' };
  const widget = { kind: 'csp', subject: 'https://cdn.unknown-widget.io/a.js', reason: 'URL: script-src-elem' };
  const io = (csp: string | null): GateIo => ({
    randomPath: () => '/lead-check-test',
    browser: null,
    get: async (url) =>
      url === 'https://example.com/' || url === 'https://example.com/shop'
        ? {
            status: 200,
            url,
            headers: { 'content-type': 'text/html', ...(csp ? { 'content-security-policy': csp } : {}) },
            body: '<html><body><p>hi</p></body></html>',
          }
        : { status: 404, url, headers: {}, body: 'Not found' },
  });

  void it('offers one candidate per blocked host, known tags first, and nothing for inline blocks', () => {
    const candidates = blockedByPolicyCandidates(
      run([widget, bing, { kind: 'csp', subject: 'an inline script or style', reason: 'Inline: script-src' }]),
    );
    assert.deepEqual(
      candidates.map((c) => [c.vendor, c.directive, c.pages.length]),
      [
        ['the Microsoft Advertising (Bing Ads) tag', 'connect-src', 2],
        [null, 'script-src-elem', 2],
      ],
    );
  });

  void it('passes when the served policy does not list the host, and says which list', async () => {
    const gate = await runGate(
      run([bing]),
      null,
      io("default-src 'self'; connect-src 'self' https://www.google-analytics.com"),
    );
    const h = gate.highlights.find((x) => x.type === 'blocked-by-policy');
    assert.ok(h);
    assert.equal(
      h.fact,
      "The site's own Content Security Policy blocks the Microsoft Advertising (Bing Ads) tag on all 2 pages scanned: its connect-src list does not include bat.bing.net, so the browser refuses the request",
    );
    assert.deepEqual(h.evidence.methods, ['browser-issues-panel', 'http-get-policy-header']);
    assert.equal(gate.causes[0], 'blocked-by-own-policy');
    assert.equal(hasCausalWording(`${h.fact} ${whyItMatters(h)} ${shortLabel(h)}`), false);
    assert.ok(
      h.evidence.observations?.[0]?.headers?.['content-security-policy'],
      'the policy header is kept as evidence',
    );
  });

  void it('drops it when the served policy allows the host, is absent, or cannot be read from a header', async () => {
    const cases: Array<[string | null, string]> = [
      ["connect-src 'self' https://bat.bing.net", 'second-method-disagrees'],
      [null, 'no-second-method-available'],
      ["script-src 'nonce-x' 'strict-dynamic'", 'second-method-disagrees'],
    ];
    for (const [csp, reason] of cases) {
      const gate = await runGate(run([bing]), null, io(csp));
      assert.equal(
        gate.highlights.some((x) => x.type === 'blocked-by-policy'),
        false,
        String(csp),
      );
      assert.equal(gate.candidatesDropped.find((d) => d.type === 'blocked-by-policy')?.reason, reason, String(csp));
    }
    const strict = await runGate(run([{ ...widget }]), null, io("script-src 'nonce-x' 'strict-dynamic'"));
    assert.equal(
      strict.candidatesDropped.find((d) => d.type === 'blocked-by-policy')?.reason,
      'no-second-method-available',
    );
  });
});

void describe('how a library is named in a fact', () => {
  void it('a framework is what the site runs on; other libraries keep their name', () => {
    assert.deepEqual(libraryName('nextjs'), { name: 'Next.js', framework: true });
    assert.deepEqual(libraryName('axios'), { name: 'axios', framework: false });
    assert.equal(fixWording('15.5.28'), 'all fixed from version 15.5.28');
  });
});
