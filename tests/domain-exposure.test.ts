import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EmailDnsAnalyzer,
  evaluateDmarc,
  evaluateSpf,
  type DnsLookup,
} from '../lib/analyzers/site-checks/email-dns-analyzer';
import {
  ExposedFilesProbe,
  candidateDirectories,
  type ProbeFetcher,
} from '../lib/analyzers/site-checks/exposed-files-probe';
import { NotFoundProbe, notFoundVerdict } from '../lib/analyzers/site-checks/not-found-probe';
import {
  SubdomainTakeoverAnalyzer,
  collectSiteHosts,
  type TakeoverLookup,
} from '../lib/analyzers/site-checks/subdomain-takeover';
import { isPageCheckFinding, isSiteCheckFinding, orgDomain } from '../lib/analyzers/site-checks/site-checks-types';
import { HeadIntegrityAnalyzer, findHeadBreak } from '../lib/analyzers/seo/head-integrity-analyzer';
import { bfcacheIssues, BfcacheAnalyzer } from '../lib/analyzers/performance/bfcache-analyzer';
import {
  advisoryFor,
  jsLibraryIssues,
  libraryFromUrl,
  JsLibraryAnalyzer,
} from '../lib/analyzers/security/js-library-analyzer';
import { consentModeIssues, ConsentModeAnalyzer } from '../lib/analyzers/analytics/consent-mode-analyzer';
import { isIpOrLocal } from '../lib/analyzers/site-checks/site-probes';
import { getDomainExposureSection } from '../lib/reports/sections/domain-exposure';
import { categorize } from '../lib/phase2/categorize';
import { scoredCategoryOf } from '../lib/phase2/score-impact';
import { verifyFinding } from '../lib/phase3/finding-verifier';

// ─── helpers ────────────────────────────────────────────────────────────────

const absent = () => Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
const failed = () => Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });

function fakeDns(txt: Record<string, string[]>, opts: { mx?: boolean; caa?: string[] } = {}): DnsLookup {
  return {
    resolveTxt: async (n) => {
      if (n in txt) return txt[n].map((r) => [r]);
      throw absent();
    },
    resolveMx: async () => {
      if (opts.mx) return [{ exchange: 'mx.example.com', priority: 10 }];
      throw absent();
    },
    resolveCaa: async (n) => {
      if (opts.caa?.includes(n)) return [{ critical: 0, issue: 'letsencrypt.org' }];
      throw absent();
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const page = <T>(value: T) => ({ evaluate: async () => value }) as unknown as { evaluate<R>(fn: () => R): Promise<R> };

// ─── SPF / DMARC ────────────────────────────────────────────────────────────

void test('SPF: missing, multiple, +all, ?all, ptr', async () => {
  const dns = fakeDns({});
  assert.equal((await evaluateSpf(dns, 'example.com', [])).issues[0].message, 'No SPF record');
  const multi = await evaluateSpf(dns, 'example.com', ['v=spf1 -all', 'v=spf1 ~all']);
  assert.ok(multi.issues.some((i) => i.message === 'Multiple SPF records'));
  assert.ok((await evaluateSpf(dns, 'example.com', ['v=spf1 +all'])).issues.some((i) => /\+all/.test(i.message!)));
  assert.ok((await evaluateSpf(dns, 'example.com', ['v=spf1 all'])).issues.some((i) => /\+all/.test(i.message!)));
  assert.ok((await evaluateSpf(dns, 'example.com', ['v=spf1 ?all'])).issues.some((i) => /neutral/.test(i.message!)));
  assert.ok((await evaluateSpf(dns, 'example.com', ['v=spf1 ptr -all'])).issues.some((i) => /ptr/.test(i.message!)));
  assert.equal((await evaluateSpf(dns, 'example.com', ['v=spf1 include:_spf.google.com -all'])).issues.length, 0);
});

void test('SPF: counts nested lookups and flags more than 10', async () => {
  const txt: Record<string, string[]> = {};
  const includes = Array.from({ length: 4 }, (_, i) => `inc${i}.example.net`);
  includes.forEach((d) => (txt[d] = ['v=spf1 a mx include:deep.example.net -all']));
  txt['deep.example.net'] = ['v=spf1 a -all'];
  const record = `v=spf1 ${includes.map((d) => `include:${d}`).join(' ')} -all`;
  const res = await evaluateSpf(fakeDns(txt), 'example.com', [record]);
  // 4 includes + 4×(a + mx + include) + deep's "a" once (seen-set) = 4 + 12 + 1 = 17
  assert.equal(res.lookups, 17);
  assert.ok(res.issues.some((i) => i.message === 'SPF record exceeds 10 DNS lookups'));
});

void test('DMARC: missing, multiple, no policy, p=none, no rua, good', () => {
  assert.equal(evaluateDmarc('example.com', []).issues[0].message, 'No DMARC record');
  assert.ok(
    evaluateDmarc('example.com', ['v=DMARC1; p=reject', 'v=DMARC1; p=none']).issues.some(
      (i) => i.message === 'Multiple DMARC records',
    ),
  );
  assert.equal(
    evaluateDmarc('example.com', ['v=DMARC1; rua=mailto:a@b.c']).issues[0].message,
    'DMARC record has no valid policy',
  );
  const none = evaluateDmarc('example.com', ['v=DMARC1; p=none']).issues.map((i) => i.message);
  assert.deepEqual(none, [
    'DMARC policy is p=none (monitoring only)',
    'DMARC record has no aggregate report address (rua)',
  ]);
  assert.equal(evaluateDmarc('example.com', ['v=DMARC1; p=reject; rua=mailto:d@example.com']).issues.length, 0);
});

void test('EmailDnsAnalyzer: no MX skips mail-receiving checks; CAA falls back to org domain', async () => {
  const res = await EmailDnsAnalyzer.analyze(
    'shop.example.co.uk',
    fakeDns(
      {
        'shop.example.co.uk': ['v=spf1 -all'],
        '_dmarc.example.co.uk': ['v=DMARC1; p=reject; rua=mailto:x@example.co.uk'],
      },
      { caa: ['example.co.uk'] },
    ),
  );
  assert.deepEqual(res.issues, []);
  const byId = Object.fromEntries(res.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(byId, {
    spf: 'pass',
    dmarc: 'pass',
    dkim: 'skipped',
    'mta-sts': 'skipped',
    'tls-rpt': 'skipped',
    caa: 'pass',
  });
});

void test('EmailDnsAnalyzer: MX present reports DKIM, MTA-STS, TLS-RPT and CAA gaps', async () => {
  const res = await EmailDnsAnalyzer.analyze(
    'example.com',
    fakeDns({ 'example.com': ['v=spf1 mx -all'] }, { mx: true }),
  );
  const msgs = res.issues.map((i) => i.message);
  for (const m of [
    'No DMARC record',
    'No DKIM key found at common selectors',
    'No MTA-STS policy',
    'No TLS-RPT record',
    'No CAA record',
  ]) {
    assert.ok(msgs.includes(m), m);
  }
});

void test('EmailDnsAnalyzer: DKIM found, MTA-STS policy validated', async () => {
  const dns = fakeDns(
    {
      'example.com': ['v=spf1 -all'],
      '_dmarc.example.com': ['v=DMARC1; p=quarantine; rua=mailto:r@example.com'],
      'google._domainkey.example.com': ['v=DKIM1; k=rsa; p=MIIB'],
      '_mta-sts.example.com': ['v=STSv1; id=1'],
      '_smtp._tls.example.com': ['v=TLSRPTv1; rua=mailto:t@example.com'],
    },
    { mx: true, caa: ['example.com'] },
  );
  const ok = await EmailDnsAnalyzer.analyze('example.com', dns, async () => ({
    ok: true,
    body: 'version: STSv1\nmode: enforce\nmx: *.example.com\nmax_age: 86400',
  }));
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.checks.find((c) => c.id === 'dkim')?.note, 'selector: google');
  const bad = await EmailDnsAnalyzer.analyze('example.com', dns, async () => ({ ok: false, body: '' }));
  assert.deepEqual(
    bad.issues.map((i) => i.message),
    ['MTA-STS policy file missing or invalid'],
  );
});

void test('EmailDnsAnalyzer: DNS failure gives no finding, only a skipped check', async () => {
  const dns: DnsLookup = {
    resolveTxt: async () => {
      throw failed();
    },
    resolveMx: async () => {
      throw failed();
    },
    resolveCaa: async () => {
      throw failed();
    },
  };
  const res = await EmailDnsAnalyzer.analyze('example.com', dns);
  assert.deepEqual(res.issues, []);
  assert.ok(res.checks.every((c) => c.status === 'skipped'));
});

void test('orgDomain handles common ccTLD second levels', () => {
  assert.equal(orgDomain('a.b.example.com'), 'example.com');
  assert.equal(orgDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(orgDomain('example.com.au'), 'example.com.au');
});

// ─── Exposed files ──────────────────────────────────────────────────────────

void test('ExposedFilesProbe: confirmed hits are reported, catch-all 200 pages are not', async () => {
  const routes: Record<string, string | Uint8Array> = {
    'https://example.com/.git/HEAD': 'ref: refs/heads/main\n',
    'https://example.com/.env': 'APP_KEY=abc\nDB_PASSWORD=secret\n',
    'https://example.com/backup.zip': new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]),
    'https://example.com/uploads/': '<html><head><title>Index of /uploads</title></head></html>',
  };
  const fetcher: ProbeFetcher = async (url) => {
    const r = routes[url];
    // Every other path: a catch-all 200 HTML page (SPA fallback).
    if (r === undefined) return { status: 200, bytes: enc('<!doctype html><html><body>Home</body></html>') };
    return { status: 200, bytes: typeof r === 'string' ? enc(r) : r };
  };
  const res = await ExposedFilesProbe.probe('https://example.com', ['/uploads/', '/assets/'], fetcher);
  const msgs = res.issues.map((i) => i.message).sort();
  assert.deepEqual(msgs, [
    '.env file exposed',
    'Backup or database dump publicly downloadable',
    'Directory listing enabled',
    'Git repository exposed',
  ]);
  assert.equal(res.issues.find((i) => i.message === 'Git repository exposed')?.severity, 'critical');
  assert.equal(res.checks[0].status, 'fail');
});

void test('ExposedFilesProbe: clean site passes; repeated 403 stops early and is marked skipped', async () => {
  const clean = await ExposedFilesProbe.probe('https://example.com', [], async () => ({
    status: 404,
    bytes: new Uint8Array(),
  }));
  assert.deepEqual(clean.issues, []);
  assert.equal(clean.checks[0].status, 'pass');
  let calls = 0;
  const blocked = await ExposedFilesProbe.probe('https://example.com', [], async () => {
    calls++;
    return { status: 403, bytes: new Uint8Array() };
  });
  assert.equal(blocked.checks[0].status, 'skipped');
  assert.ok(calls < 12, `stopped after ${calls} calls`);
});

void test('candidateDirectories takes first-level same-origin dirs only', () => {
  const dirs = candidateDirectories('https://example.com', [
    'https://example.com/static/img/a.png',
    'https://cdn.other.com/x/y.png',
    '/media/photo.jpg',
  ]);
  assert.deepEqual(dirs, ['/uploads/', '/wp-content/uploads/', '/static/', '/media/']);
});

// ─── Missing-page probe ─────────────────────────────────────────────────────

void test('notFoundVerdict: 200 and 5xx are MEDIUM, redirect is LOW, 404/403 pass', () => {
  assert.equal(notFoundVerdict('u', { status: 200 })?.message, 'Missing pages return HTTP 200 instead of 404');
  assert.equal(notFoundVerdict('u', { status: 301, location: '/' })?.severity, 'low');
  assert.equal(notFoundVerdict('u', { status: 503 })?.severity, 'medium');
  assert.equal(notFoundVerdict('u', { status: 404 }), null);
  assert.equal(notFoundVerdict('u', { status: 403 }), null);
  assert.equal(notFoundVerdict('u', null), null);
});

void test('NotFoundProbe requests a random path under the origin', async () => {
  let asked = '';
  const res = await NotFoundProbe.probe('https://example.com/', async (u) => {
    asked = u;
    return { status: 404 };
  });
  assert.match(asked, /^https:\/\/example\.com\/seo-audit-missing-[0-9a-f]{12}$/);
  assert.equal(res.checks[0].status, 'pass');
});

// ─── Subdomain takeover ─────────────────────────────────────────────────────

void test('collectSiteHosts keeps same-site hosts only', () => {
  assert.deepEqual(
    collectSiteHosts('https://www.example.com', ['blog.example.com', 'example.com', 'twitter.com', 'evilexample.com']),
    ['www.example.com', 'blog.example.com', 'example.com'],
  );
});

void test('SubdomainTakeoverAnalyzer: NXDOMAIN target and service fingerprint are flagged', async () => {
  const lookup: TakeoverLookup = {
    resolveCname: async (h) => {
      if (h === 'docs.example.com') return ['example-docs.github.io'];
      if (h === 'old.example.com') return ['old-app.azurewebsites.net'];
      if (h === 'cdn.example.com') return ['d123.cloudfront.net'];
      throw absent();
    },
    resolveAddress: async (h) => {
      if (h === 'old-app.azurewebsites.net') throw absent();
      return ['1.2.3.4'];
    },
    fetchBody: async (u) =>
      u === 'https://docs.example.com/' ? "<h1>There isn't a GitHub Pages site here.</h1>" : 'ok',
  };
  const res = await SubdomainTakeoverAnalyzer.analyze(
    ['www.example.com', 'docs.example.com', 'old.example.com', 'cdn.example.com'],
    lookup,
  );
  assert.equal(res.issues.length, 2);
  assert.ok(
    res.issues.every((i) => i.message === 'Dangling CNAME: possible subdomain takeover' && i.severity === 'high'),
  );
  assert.equal(res.checks[0].status, 'fail');
});

// ─── Head integrity ─────────────────────────────────────────────────────────

void test('findHeadBreak: valid head returns null', () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>T</title>
    <script>var a = "<div>";</script><noscript><link rel="stylesheet" href="x.css"></noscript>
    <link rel="canonical" href="https://example.com/"></head><body><div></div></body></html>`;
  assert.equal(findHeadBreak(html), null);
  assert.equal(HeadIntegrityAnalyzer.analyze(html).issues.length, 0);
});

void test('findHeadBreak: <img> before canonical displaces it (HIGH)', () => {
  const html = `<html><head><title>T</title><img src="pixel.gif"><link rel="canonical" href="/a"><meta name="robots" content="noindex"></head><body></body></html>`;
  const brk = findHeadBreak(html);
  assert.equal(brk?.breaker, 'img');
  assert.deepEqual(brk?.displaced.sort(), ['canonical', 'robots meta']);
  const { issues } = HeadIntegrityAnalyzer.analyze(html);
  assert.equal(issues[0].message, 'Invalid element in HTML head hides SEO tags');
  assert.equal(issues[0].severity, 'high');
});

void test('findHeadBreak: GTM iframe inside head noscript breaks the head', () => {
  const html = `<html><head><noscript><iframe src="https://www.googletagmanager.com/ns.html"></iframe></noscript><link rel="alternate" hreflang="de" href="/de"></head><body></body></html>`;
  const brk = findHeadBreak(html);
  assert.equal(brk?.breaker, 'iframe inside noscript');
  assert.deepEqual(brk?.displaced, ['hreflang']);
});

void test('findHeadBreak: break with nothing after it is LOW', () => {
  const html = `<html><head><link rel="canonical" href="/a"><div>x</div></head><body></body></html>`;
  const { issues } = HeadIntegrityAnalyzer.analyze(html);
  assert.equal(issues[0].message, 'Invalid element in HTML head closes it early');
  assert.equal(issues[0].severity, 'low');
});

// ─── bfcache ────────────────────────────────────────────────────────────────

void test('bfcache: no-store and unload handlers', async () => {
  assert.equal(
    bfcacheIssues({ 'Cache-Control': 'private, no-store' }, 0)[0].message,
    'Page not eligible for back/forward cache (Cache-Control: no-store)',
  );
  assert.equal(
    bfcacheIssues({ 'cache-control': 'max-age=0' }, 2)[0].message,
    'unload event handler blocks back/forward cache',
  );
  assert.equal(bfcacheIssues({}, 0).length, 0);
  const res = await BfcacheAnalyzer.analyze(page(1), {});
  assert.equal(res.issues.length, 1);
});

// ─── JS libraries ───────────────────────────────────────────────────────────

void test('libraryFromUrl parses common CDN and file layouts', () => {
  assert.deepEqual(libraryFromUrl('https://code.jquery.com/jquery-3.4.1.min.js'), { lib: 'jquery', version: '3.4.1' });
  assert.deepEqual(libraryFromUrl('https://cdnjs.cloudflare.com/ajax/libs/jquery/2.2.4/jquery.min.js'), {
    lib: 'jquery',
    version: '2.2.4',
  });
  assert.deepEqual(libraryFromUrl('https://cdn.jsdelivr.net/npm/bootstrap@4.1.0/dist/js/bootstrap.min.js'), {
    lib: 'bootstrap',
    version: '4.1.0',
  });
  assert.deepEqual(libraryFromUrl('https://ajax.googleapis.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.js'), {
    lib: 'jquery-ui',
    version: '1.12.1',
  });
  assert.deepEqual(libraryFromUrl('https://ajax.googleapis.com/ajax/libs/angularjs/1.8.2/angular.min.js'), {
    lib: 'angularjs',
    version: '1.8.2',
  });
  assert.equal(libraryFromUrl('https://example.com/app.3.4.1.js'), null);
});

void test('advisoryFor applies version ranges', () => {
  assert.ok(advisoryFor('jquery', '3.4.1'));
  assert.equal(advisoryFor('jquery', '3.5.0'), null);
  assert.ok(advisoryFor('bootstrap', '4.1.0'));
  assert.equal(advisoryFor('bootstrap', '3.4.1'), null);
  assert.equal(advisoryFor('bootstrap', '5.3.0'), null);
  assert.equal(advisoryFor('underscore', '1.2.0'), null);
  assert.ok(advisoryFor('underscore', '1.9.1'));
  assert.equal(advisoryFor('lodash', '4.17.21'), null);
});

void test('jsLibraryIssues: one finding, worst severity, every library listed', async () => {
  const issues = jsLibraryIssues({ jquery: '1.12.4', moment: '2.24.0', vue: '3.4.0' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'medium');
  assert.match(issues[0].detail!, /jQuery 1\.12\.4.*Moment\.js 2\.24\.0/);
  assert.doesNotMatch(issues[0].detail!, /Vue/);
  // Runtime version wins over the URL version.
  const res = await JsLibraryAnalyzer.analyze(page({ jquery: '3.7.1' }), [
    'https://code.jquery.com/jquery-1.12.4.min.js',
  ]);
  assert.equal(res.issues.length, 0);
});

// ─── Consent Mode ───────────────────────────────────────────────────────────

void test('consentModeIssues: no Google tags, missing default, v1 only, v2 complete', async () => {
  assert.deepEqual(consentModeIssues(0, { hasGoogleTagGlobal: false, consentTypes: [] }), []);
  assert.equal(
    consentModeIssues(2, { hasGoogleTagGlobal: true, consentTypes: [] })[0].message,
    'Google tags run without Consent Mode',
  );
  assert.equal(
    consentModeIssues(1, { hasGoogleTagGlobal: true, consentTypes: ['ad_storage', 'analytics_storage'] })[0].message,
    'Google Consent Mode v2 signals missing',
  );
  assert.deepEqual(
    consentModeIssues(1, {
      hasGoogleTagGlobal: true,
      consentTypes: ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'],
    }),
    [],
  );
  const res = await ConsentModeAnalyzer.analyze(page({ hasGoogleTagGlobal: false, consentTypes: [] }), [
    'https://www.googletagmanager.com/gtag/js?id=G-1',
  ]);
  assert.equal(res.issues[0].message, 'Google tags run without Consent Mode');
});

// ─── Routing, verification, report ──────────────────────────────────────────

void test('new findings are recognised, routed and never machine-refuted', () => {
  const site = [
    'No DMARC record',
    'SPF record exceeds 10 DNS lookups',
    'Git repository exposed',
    '.env file exposed',
    'Dangling CNAME: possible subdomain takeover',
    'Missing pages return HTTP 200 instead of 404',
  ];
  const perPage = [
    'Invalid element in HTML head hides SEO tags',
    'unload event handler blocks back/forward cache',
    'Outdated JavaScript library with known vulnerabilities',
    'Google Consent Mode v2 signals missing',
  ];
  site.forEach((m) => assert.ok(isSiteCheckFinding(m), m));
  perPage.forEach((m) => assert.ok(isPageCheckFinding(m), m));
  assert.ok(!isSiteCheckFinding('Missing meta description'));

  assert.equal(scoredCategoryOf('Git repository exposed'), 'security');
  assert.equal(scoredCategoryOf('No DMARC record'), 'security');
  assert.equal(scoredCategoryOf('Outdated JavaScript library with known vulnerabilities'), 'security');
  assert.equal(scoredCategoryOf('Invalid element in HTML head hides SEO tags'), 'seo');
  assert.equal(scoredCategoryOf('Missing pages return HTTP 200 instead of 404'), 'seo');
  assert.equal(categorize('Outdated JavaScript library with known vulnerabilities'), 'technical');
  assert.equal(categorize('Invalid element in HTML head hides SEO tags'), 'seo');
  assert.equal(categorize('Google Consent Mode v2 signals missing'), 'privacy');

  const r = verifyFinding(
    'Git repository exposed',
    { count: 1, examples: ['https://example.com/.git/HEAD'] } as never,
    {} as never,
  );
  assert.equal(r.status, 'unchecked');
});

void test('Domain & Exposure section renders status table and findings, or nothing', () => {
  assert.equal(getDomainExposureSection(null, { 'Missing title': { severity: 'high' } }), '');
  const html = getDomainExposureSection(
    {
      checkedAt: '2026-11-12T00:00:00Z',
      domain: 'example.com',
      checks: [
        { id: 'spf', label: 'SPF', status: 'pass', note: 'v=spf1 -all <x>' },
        { id: 'dmarc', label: 'DMARC', status: 'fail', note: 'no valid record' },
      ],
    },
    {
      'No DMARC record': { severity: 'medium', count: 1 },
      'Git repository exposed': { severity: 'critical', count: 1 },
      'Missing title': { severity: 'high' },
    },
  );
  assert.match(html, /id="domain-exposure"/);
  assert.match(html, /v=spf1 -all &lt;x&gt;/);
  assert.ok(html.indexOf('Git repository exposed') < html.indexOf('No DMARC record'), 'sorted by severity');
  assert.doesNotMatch(html, /Missing title/);
  const clean = getDomainExposureSection(
    { checkedAt: '', domain: 'example.com', checks: [{ id: 'spf', label: 'SPF', status: 'pass' }] },
    {},
  );
  assert.match(clean, /No domain or exposure issues found/);
});

void test('isIpOrLocal skips DNS checks for IPs and local hosts', () => {
  for (const h of ['127.0.0.1', 'localhost', 'app.localhost', '[::1]', 'intranet']) assert.ok(isIpOrLocal(h), h);
  assert.ok(!isIpOrLocal('example.com'));
});
