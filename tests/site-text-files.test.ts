import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SiteTextFilesAnalyzer, validateAdsTxtLines } from '../lib/analyzers/seo/site-text-files-analyzer';
import { AuditOrchestrator } from '../lib/orchestrators/audit-orchestrator';
import { categorize } from '../lib/phase2/categorize';
import { scoredCategoryOf } from '../lib/phase2/score-impact';
import { securityTxtVerdict, adsTxtVerdict, checkFindingSignals } from '../lib/phase3/live-verifier';
import type { PageInfo } from '../lib/types';

const ORIGIN = 'https://example.com';
const NOW = new Date('2026-11-12T00:00:00Z');
const realFetch = globalThis.fetch;

type Route = { status?: number; body?: string; type?: string; url?: string } | 'error';

function stubFetch(routes: Record<string, Route>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const r = routes[url] ?? { status: 404, body: 'nope', type: 'text/plain' };
    if (r === 'error') throw new TypeError('fetch failed');
    const res = new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: { 'content-type': r.type ?? 'text/plain; charset=utf-8' },
    });
    Object.defineProperty(res, 'url', { value: r.url ?? url });
    return res;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const WK = `${ORIGIN}/.well-known/security.txt`;
const LEGACY = `${ORIGIN}/security.txt`;
const VALID_SEC = 'Contact: mailto:security@example.com\nExpires: 2027-06-01T00:00:00Z\n';

async function secMessages(routes: Record<string, Route>): Promise<string[]> {
  stubFetch(routes);
  const r = await SiteTextFilesAnalyzer.analyzeSecurityTxt(ORIGIN, NOW);
  return r.issues.map((i) => `${i.severity}:${i.message}`);
}

void test('securitytxt: missing file', async () => {
  assert.deepEqual(await secMessages({}), ['low:security.txt missing']);
});

void test('securitytxt: no Contact', async () => {
  const m = await secMessages({ [WK]: { body: 'Expires: 2027-06-01T00:00:00Z\n' } });
  assert.deepEqual(m, ['medium:security.txt has no Contact field']);
});

void test('securitytxt: bad Expires', async () => {
  for (const body of [
    'Contact: mailto:a@b.c\nExpires: 2020-01-01T00:00:00Z\n',
    'Contact: mailto:a@b.c\n',
    'Contact: mailto:a@b.c\nExpires: someday\n',
  ]) {
    const m = await secMessages({ [WK]: { body } });
    assert.deepEqual(m, ['medium:security.txt Expires field is missing, invalid or in the past'], body);
  }
});

void test('securitytxt: Expires too far ahead', async () => {
  const m = await secMessages({ [WK]: { body: 'Contact: mailto:a@b.c\nExpires: 2029-01-01T00:00:00Z\n' } });
  assert.deepEqual(m, ['low:security.txt Expires is more than a year ahead']);
});

void test('securitytxt: wrong content type', async () => {
  const m = await secMessages({ [WK]: { body: VALID_SEC, type: 'application/octet-stream' } });
  assert.deepEqual(m, ['low:security.txt is not served as text/plain']);
});

void test('securitytxt: legacy location only', async () => {
  const m = await secMessages({ [LEGACY]: { body: VALID_SEC } });
  assert.deepEqual(m, ['low:security.txt found only at the legacy /security.txt location']);
});

void test('securitytxt: valid file clean', async () => {
  assert.deepEqual(await secMessages({ [WK]: { body: VALID_SEC } }), []);
});

void test('securitytxt: signed file clean', async () => {
  const body = [
    '-----BEGIN PGP SIGNED MESSAGE-----',
    'Hash: SHA256',
    '',
    '- Contact: mailto:security@example.com',
    'Expires: 2027-06-01T00:00:00Z',
    '-----BEGIN PGP SIGNATURE-----',
    '',
    'iQIzBAEBCAAdFiEE',
    '-----END PGP SIGNATURE-----',
  ].join('\n');
  assert.deepEqual(await secMessages({ [WK]: { body } }), []);
});

void test('securitytxt: soft-404 is missing', async () => {
  const html = { body: '<!doctype html><html><body>Not found</body></html>', type: 'text/html' };
  assert.deepEqual(await secMessages({ [WK]: html, [LEGACY]: html }), ['low:security.txt missing']);
});

void test('securitytxt: cross-host redirect is missing', async () => {
  const m = await secMessages({
    [WK]: { body: VALID_SEC, url: 'https://other.com/.well-known/security.txt' },
    [LEGACY]: { body: VALID_SEC, url: 'https://other.com/security.txt' },
  });
  assert.deepEqual(m, ['low:security.txt missing']);
  const www = await secMessages({ [WK]: { body: VALID_SEC, url: 'https://www.example.com/.well-known/security.txt' } });
  assert.deepEqual(www, []);
});

void test('securitytxt: network error silent', async () => {
  const m = await secMessages({ [WK]: 'error', [LEGACY]: 'error' });
  assert.deepEqual(m, []);
});

const ADS = `${ORIGIN}/ads.txt`;
const APP_ADS = `${ORIGIN}/app-ads.txt`;
const VALID_ADS = [
  '# comment',
  'contact=ads@example.com',
  'subdomain=news.example.com',
  '',
  'google.com, pub-1234567890, DIRECT, f08c47fec0942fa0',
  'appnexus.com, 12345, RESELLER # trailing comment',
].join('\n');

void test('adstxt: invalid lines flagged', async () => {
  stubFetch({ [ADS]: { body: `${VALID_ADS}\ngoogle.com pub-1 DIRECT\nfoo.com, 1, OWNER\n` } });
  const r = await SiteTextFilesAnalyzer.analyzeAdsTxt(ORIGIN);
  assert.deepEqual(
    r.issues.map((i) => `${i.severity}:${i.message}`),
    ['low:ads.txt has invalid record lines'],
  );
  assert.equal(r.info.adsTxt.invalidLines, 2);
});

void test('adstxt: valid lines clean', async () => {
  assert.deepEqual(validateAdsTxtLines(VALID_ADS), []);
  stubFetch({ [ADS]: { body: VALID_ADS }, [APP_ADS]: { body: VALID_ADS } });
  const r = await SiteTextFilesAnalyzer.analyzeAdsTxt(ORIGIN);
  assert.deepEqual(r.issues, []);
});

void test('adstxt: app-ads invalid lines flagged', async () => {
  stubFetch({ [APP_ADS]: { body: 'garbage line\n' } });
  const r = await SiteTextFilesAnalyzer.analyzeAdsTxt(ORIGIN);
  assert.deepEqual(
    r.issues.map((i) => i.message),
    ['app-ads.txt has invalid record lines'],
  );
  assert.equal(r.info.adsTxt.found, false);
});

void test('adstxt: soft-404 is missing', async () => {
  stubFetch({ [ADS]: { body: '<html><body>home</body></html>', type: 'text/html' } });
  const r = await SiteTextFilesAnalyzer.analyzeAdsTxt(ORIGIN);
  assert.equal(r.info.adsTxt.found, false);
  assert.deepEqual(r.issues, []);
});

function pagesWith(adNetworks: string[], totalAds = 3): Record<string, PageInfo> {
  return {
    [`${ORIGIN}/a`]: {
      adDensityData: { totalAds, adAreaPercent: 5, stickyAds: 0, adNetworks, adElements: [] },
    } as unknown as PageInfo,
  };
}

async function gate(
  pages: Record<string, PageInfo>,
  stored: Parameters<typeof AuditOrchestrator.checkAdsTxtGate>[3],
): Promise<string[]> {
  const saved: string[] = [];
  await AuditOrchestrator.checkAdsTxtGate(pages, ORIGIN, (m, _d, s) => saved.push(`${s}:${m}`), stored);
  return saved;
}

void test('adstxt: missing with ads flagged', async () => {
  const m = await gate(pagesWith(['Google AdSense']), { adsTxt: { found: false } });
  assert.deepEqual(m, ['medium:ads.txt missing on a site that shows ads']);
});

void test('adstxt: missing without ads silent', async () => {
  assert.deepEqual(await gate(pagesWith([], 0), { adsTxt: { found: false } }), []);
  assert.deepEqual(await gate(pagesWith([], 7), { adsTxt: { found: false } }), []);
  assert.deepEqual(await gate(pagesWith(['Google AdSense']), { adsTxt: { found: true } }), []);
});

void test('adstxt: resume without stored info refetches', async () => {
  stubFetch({});
  assert.deepEqual(await gate(pagesWith(['Google AdSense']), undefined), [
    'medium:ads.txt missing on a site that shows ads',
  ]);
  stubFetch({ [ADS]: { body: VALID_ADS } });
  assert.deepEqual(await gate(pagesWith(['Google AdSense']), undefined), []);
});

void test('adstxt: resume refetch network error silent', async () => {
  stubFetch({ [ADS]: 'error', [APP_ADS]: 'error' });
  assert.deepEqual(await gate(pagesWith(['Google AdSense']), undefined), []);
});

const SEC_TITLES = [
  'security.txt missing',
  'security.txt has no Contact field',
  'security.txt Expires field is missing, invalid or in the past',
  'security.txt Expires is more than a year ahead',
  'security.txt is not served as text/plain',
  'security.txt found only at the legacy /security.txt location',
];
const ADS_TITLES = [
  'ads.txt has invalid record lines',
  'app-ads.txt has invalid record lines',
  'ads.txt missing on a site that shows ads',
];

void test('sitetextfiles-routing: categorize technical', () => {
  for (const t of [...SEC_TITLES, ...ADS_TITLES]) assert.equal(categorize(t), 'technical', t);
});

void test('sitetextfiles-routing: score impact', () => {
  for (const t of SEC_TITLES) assert.equal(scoredCategoryOf(t), 'security', t);
  for (const t of ADS_TITLES) assert.equal(scoredCategoryOf(t), 'technical', t);
});

void test('sitetextfiles-routing: securityTxtVerdict', () => {
  assert.equal(securityTxtVerdict(null, '', NOW, 'security.txt missing').status, 'confirmed');
  assert.equal(securityTxtVerdict(VALID_SEC, 'text/plain', NOW, 'security.txt missing').status, 'refuted');
  assert.equal(
    securityTxtVerdict('Expires: 2027-06-01T00:00:00Z', 'text/plain', NOW, 'security.txt has no Contact field').status,
    'confirmed',
  );
  assert.equal(
    securityTxtVerdict(VALID_SEC, 'text/plain', NOW, 'security.txt has no Contact field').status,
    'refuted',
  );
});

void test('sitetextfiles-routing: adsTxtVerdict', () => {
  assert.equal(adsTxtVerdict(null, 'ads.txt missing on a site that shows ads').status, 'confirmed');
  assert.equal(adsTxtVerdict(VALID_ADS, 'ads.txt missing on a site that shows ads').status, 'refuted');
  assert.equal(adsTxtVerdict('bad line', 'ads.txt has invalid record lines').status, 'confirmed');
  assert.equal(adsTxtVerdict(VALID_ADS, 'ads.txt has invalid record lines').status, 'refuted');
});

void test('sitetextfiles-routing: owned checker', () => {
  for (const t of [...SEC_TITLES, ...ADS_TITLES]) {
    const r = checkFindingSignals(t, {} as never);
    assert.doesNotMatch(r.reason, /no live checker/, t);
    assert.match(r.reason, /special verifier/, t);
  }
});

const ROOT = path.resolve(__dirname, '..');
for (const file of ['CLAUDE.md', 'README.md', 'docs/architecture.md']) {
  void test(`sitetextfiles-docs: ${file}`, () => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    assert.ok(text.includes('security.txt'), `${file} mentions security.txt`);
    assert.ok(text.includes('ads.txt'), `${file} mentions ads.txt`);
  });
}
