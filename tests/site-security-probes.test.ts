import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpProbeFetcher, HttpProbeResponse } from '../lib/analyzers/site-checks/http-probe';
import {
  JsSecretsScanner,
  collectScriptUrls,
  findFirebaseDatabases,
  findSecrets,
  maskSecret,
} from '../lib/analyzers/site-checks/js-secrets-scanner';
import {
  OpenBucketProbe,
  bucketFromUrl,
  extractBuckets,
  listingObjectCount,
} from '../lib/analyzers/site-checks/open-bucket-probe';
import { CORS_TEST_ORIGIN, CorsProbe, corsVerdict, selectApiUrls } from '../lib/analyzers/site-checks/cors-probe';
import { AbandonedScriptDomains, groupThirdPartyHosts } from '../lib/analyzers/site-checks/abandoned-script-domains';
import {
  WordPressPluginsAnalyzer,
  affectingVulns,
  compareVersions,
  extractWpPlugins,
  parseStableTag,
} from '../lib/analyzers/site-checks/wordpress-plugins';
import {
  StagingHostsAnalyzer,
  isNoindex,
  robotsDisallowsAll,
  stagingHostsFromCt,
} from '../lib/analyzers/site-checks/staging-hosts';
import { SEVERITY } from '../lib/constants';

// ─── helpers ────────────────────────────────────────────────────────────────

type Route =
  | Partial<HttpProbeResponse>
  | null
  | ((headers: Record<string, string>) => Partial<HttpProbeResponse> | null);

function fakeFetcher(routes: Record<string, Route>, calls: string[] = []): HttpProbeFetcher {
  return async (url, opts) => {
    calls.push(url);
    if (!(url in routes)) return { status: 404, url, headers: {}, body: '' };
    const r = routes[url];
    const v = typeof r === 'function' ? r(opts?.headers ?? {}) : r;
    return v ? { status: 200, url, headers: {}, body: '', ...v } : null;
  };
}

// Built by concatenation so the repo itself does not contain secret-shaped literals.
const STRIPE = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const AWS_ID = 'AKIA' + 'Z7QPLMWN3RT5YB2K';
const AWS_SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYq3Lz9Vk2Hd8A';
const GOOGLE = 'AIza' + 'SyD3m0kL9pQ8rT7uV6wX5yZ4aB3cD2eF1gH';

// ─── JS secrets ─────────────────────────────────────────────────────────────

void test('findSecrets: detects keys, grades AWS by nearby secret, skips placeholders', () => {
  const src = `const a="${STRIPE}";const g="${GOOGLE}";const k="${AWS_ID}";`;
  const found = findSecrets(src);
  assert.equal(found.find((f) => f.patternId === 'stripe')?.severity, SEVERITY.CRITICAL);
  assert.equal(found.find((f) => f.patternId === 'google')?.severity, SEVERITY.LOW);
  assert.equal(found.find((f) => f.patternId === 'aws')?.severity, SEVERITY.MEDIUM);
  const withSecret = findSecrets(`{accessKeyId:"${AWS_ID}",secretAccessKey:"${AWS_SECRET}"}`);
  assert.equal(withSecret.find((f) => f.patternId === 'aws')?.severity, SEVERITY.HIGH);
  assert.equal(findSecrets('apiKey: "sk_' + 'live_xxxxxxxxxxxxxxxxxxxxxxxx"').length, 0);
  assert.equal(findSecrets('// your_api_key: AKIA' + 'IOSFODNN7EXAMPLE').length, 0);
  assert.ok(findSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE').some((f) => f.patternId === 'private-key'));
});

void test('maskSecret / firebase / collectScriptUrls', () => {
  assert.equal(maskSecret(STRIPE), 'sk_l…p7dc');
  assert.deepEqual(findFirebaseDatabases('{databaseURL:"https://my-app-default-rtdb.firebaseio.com",x:1}'), [
    'https://my-app-default-rtdb.firebaseio.com',
  ]);
  assert.deepEqual(
    collectScriptUrls('https://www.example.com', [
      'https://cdn.example.com/a.js#x',
      'https://cdn.example.com/a.js',
      'https://evil.com/b.js',
      '/c.js',
    ]),
    ['https://cdn.example.com/a.js', 'https://www.example.com/c.js'],
  );
});

void test('JsSecretsScanner: aggregates findings, masks, flags open Firebase DB', async () => {
  const db = 'https://my-app-default-rtdb.firebaseio.com';
  const fetcher = fakeFetcher({
    'https://example.com/a.js': { body: `x="${STRIPE}";cfg={databaseURL:"${db}"}` },
    'https://example.com/b.js': { body: `y="${STRIPE}"` },
    [`${db}/.json?shallow=true`]: { body: '{"users":true}' },
  });
  const r = await JsSecretsScanner.scan(['https://example.com/a.js', 'https://example.com/b.js'], fetcher);
  const stripe = r.issues.find((i) => i.message === 'Stripe live secret key leaked in public JavaScript');
  assert.ok(stripe && !stripe.detail!.includes(STRIPE) && stripe.detail!.includes('sk_l…p7dc'));
  assert.ok(r.issues.some((i) => i.message === 'Firebase Realtime Database is publicly readable'));
  assert.equal(r.checks[0].status, 'fail');

  const locked = await JsSecretsScanner.scan(
    ['https://example.com/a.js'],
    fakeFetcher({
      'https://example.com/a.js': { body: `cfg={databaseURL:"${db}"}` },
      [`${db}/.json?shallow=true`]: { status: 401, body: '{"error":"Permission denied"}' },
    }),
  );
  assert.equal(locked.issues.length, 0);
  assert.equal(locked.checks[0].status, 'pass');

  const offline = await JsSecretsScanner.scan(
    ['https://example.com/a.js'],
    fakeFetcher({ 'https://example.com/a.js': null }),
  );
  assert.equal(offline.checks[0].status, 'skipped');
});

// ─── Buckets ────────────────────────────────────────────────────────────────

void test('bucketFromUrl: S3/GCS/Azure styles', () => {
  assert.equal(bucketFromUrl('https://assets.s3.amazonaws.com/x.png')?.listUrl, 'https://assets.s3.amazonaws.com/');
  assert.equal(
    bucketFromUrl('https://assets.s3.eu-west-1.amazonaws.com/x.png')?.listUrl,
    'https://assets.s3.eu-west-1.amazonaws.com/',
  );
  assert.equal(
    bucketFromUrl('https://s3.amazonaws.com/my.bucket/x.png')?.listUrl,
    'https://s3.amazonaws.com/my.bucket/',
  );
  assert.equal(bucketFromUrl('http://site.s3-website-us-east-1.amazonaws.com/')?.name, 'site');
  assert.equal(bucketFromUrl('https://storage.googleapis.com/bk1/x.js')?.listUrl, 'https://storage.googleapis.com/bk1');
  assert.equal(bucketFromUrl('https://b2.storage.googleapis.com/x.js')?.name, 'b2');
  assert.equal(
    bucketFromUrl('https://acct.blob.core.windows.net/media/x.jpg')?.listUrl,
    'https://acct.blob.core.windows.net/media?restype=container&comp=list',
  );
  assert.equal(bucketFromUrl('https://example.com/x.png'), null);
  assert.equal(extractBuckets(['https://a.s3.amazonaws.com/1', 'https://a.s3.amazonaws.com/2']).length, 1);
  assert.equal(listingObjectCount('<ListBucketResult><Contents><Key>a</Key></Contents></ListBucketResult>'), 1);
  assert.equal(listingObjectCount('<Error><Code>AccessDenied</Code></Error>'), -1);
});

void test('OpenBucketProbe: listing => HIGH, AccessDenied => pass', async () => {
  const r = await OpenBucketProbe.probe(
    ['https://open.s3.amazonaws.com/a.png', 'https://storage.googleapis.com/closed/a.png'],
    fakeFetcher({
      'https://open.s3.amazonaws.com/': {
        body: '<?xml version="1.0"?><ListBucketResult><Key>a</Key></ListBucketResult>',
      },
      'https://storage.googleapis.com/closed': { status: 403, body: '<Error>AccessDenied</Error>' },
    }),
  );
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, 'Cloud storage bucket allows public listing');
  assert.equal(r.issues[0].severity, SEVERITY.HIGH);
  assert.ok(r.issues[0].detail!.includes('open') && !r.issues[0].detail!.includes('closed'));
  const none = await OpenBucketProbe.probe(['https://example.com/a.png'], fakeFetcher({}));
  assert.equal(none.checks[0].status, 'skipped');
});

// ─── CORS ───────────────────────────────────────────────────────────────────

void test('corsVerdict and selectApiUrls', () => {
  assert.equal(corsVerdict({ 'access-control-allow-origin': CORS_TEST_ORIGIN }, CORS_TEST_ORIGIN), 'reflect');
  assert.equal(
    corsVerdict({ 'access-control-allow-origin': 'null', 'access-control-allow-credentials': 'true' }, 'null'),
    'credentials',
  );
  assert.equal(
    corsVerdict({ 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }, CORS_TEST_ORIGIN),
    null,
  );
  assert.deepEqual(
    selectApiUrls('https://example.com', [
      { url: 'https://api.example.com/v1/me?x=1', resourceType: 'fetch', method: 'GET' },
      { url: 'https://api.example.com/v1/me?x=2', resourceType: 'xhr' },
      { url: 'https://api.example.com/v1/post', resourceType: 'fetch', method: 'POST' },
      { url: 'https://example.com/a.js', resourceType: 'script' },
      { url: 'https://other.com/api', resourceType: 'fetch' },
    ]),
    ['https://api.example.com/v1/me?x=1'],
  );
});

void test('CorsProbe: credentialed reflection => HIGH; plain reflection => LOW', async () => {
  const reflect = (creds: boolean) => (h: Record<string, string>) => ({
    headers: {
      'access-control-allow-origin': h.Origin,
      ...(creds ? { 'access-control-allow-credentials': 'true' } : {}),
    },
  });
  const r = await CorsProbe.probe(
    'https://example.com',
    ['https://api.example.com/me', 'https://api.example.com/public'],
    fakeFetcher({
      'https://example.com': { headers: {} },
      'https://api.example.com/me': reflect(true),
      'https://api.example.com/public': reflect(false),
    }),
  );
  const high = r.issues.find((i) => i.message === 'CORS reflects arbitrary origins with credentials');
  const low = r.issues.find((i) => i.message === 'CORS reflects arbitrary origins');
  assert.equal(high?.severity, SEVERITY.HIGH);
  assert.ok(high!.detail!.includes('/me') && !high!.detail!.includes('/public'));
  assert.equal(low?.severity, SEVERITY.LOW);
  assert.equal(r.checks[0].status, 'fail');
  const off = await CorsProbe.probe('https://example.com', [], async () => null);
  assert.equal(off.checks[0].status, 'skipped');
});

// ─── Abandoned script domains ───────────────────────────────────────────────

void test('AbandonedScriptDomains: NXDOMAIN registrable domain => HIGH; timeouts ignored', async () => {
  const groups = groupThirdPartyHosts('https://www.example.com', [
    'cdn.example.com',
    'a.dead-cdn.com',
    'b.dead-cdn.com',
    'www.googletagmanager.com',
    'slow.net',
  ]);
  assert.deepEqual([...groups.keys()], ['dead-cdn.com', 'googletagmanager.com', 'slow.net']);
  const r = await AbandonedScriptDomains.analyze(
    'https://www.example.com',
    ['a.dead-cdn.com', 'b.dead-cdn.com', 'www.googletagmanager.com', 'slow.net'],
    {
      resolveNs: async (n) => {
        if (n === 'dead-cdn.com') throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
        if (n === 'slow.net') throw Object.assign(new Error('t'), { code: 'ETIMEOUT' });
        return ['ns1'];
      },
    },
  );
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, 'Script loaded from a domain that no longer resolves');
  assert.ok(r.issues[0].detail!.includes('a.dead-cdn.com, b.dead-cdn.com'));
  assert.equal(r.checks[0].status, 'fail');
});

// ─── WordPress plugins ──────────────────────────────────────────────────────

void test('WordPress helpers', () => {
  const p = extractWpPlugins([
    'https://ex.com/wp-content/plugins/contact-form-7/includes/css/styles.css?ver=5.1',
    'https://ex.com/wp-content/plugins/elementor/assets/a.js',
    'https://ex.com/wp-content/plugins/elementor/assets/b.js?ver=3.0.0',
    'https://ex.com/wp-content/themes/x/style.css?ver=1',
  ]);
  assert.deepEqual(
    [...p],
    [
      ['contact-form-7', '5.1'],
      ['elementor', '3.0.0'],
    ],
  );
  assert.equal(parseStableTag('=== X ===\nStable tag: 5.8.2\n'), '5.8.2');
  assert.equal(parseStableTag('Stable tag: trunk'), null);
  assert.equal(parseStableTag('<!doctype html><p>Stable tag: 1.0</p>'), null);
  assert.equal(compareVersions('5.10', '5.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  const json = {
    cf7: {
      vulnerabilities: [
        { title: 'XSS', fixed_in: '5.3.2' },
        { title: 'Old', fixed_in: '4.0' },
      ],
    },
  };
  assert.deepEqual(
    affectingVulns(json, 'cf7', '5.1').map((v) => v.title),
    ['XSS'],
  );
});

void test('WordPressPluginsAnalyzer: no token => note only; token => HIGH for vulnerable', async () => {
  const plugins = new Map<string, string | null>([['cf7', '5.0']]);
  const routes = {
    'https://ex.com/wp-content/plugins/cf7/readme.txt': { body: 'Stable tag: 5.1' },
    'https://wpscan.com/api/v3/plugins/cf7': (h: Record<string, string>) =>
      h.Authorization === 'Token token=T'
        ? { body: JSON.stringify({ cf7: { vulnerabilities: [{ title: 'XSS', fixed_in: '5.3.2' }] } }) }
        : { status: 401 },
  };
  const noToken = await WordPressPluginsAnalyzer.analyze('https://ex.com/', plugins, fakeFetcher(routes), '');
  assert.equal(noToken.issues.length, 0);
  assert.match(noToken.checks[0].note!, /cf7 5\.1.*WPSCAN_API_TOKEN/);
  const r = await WordPressPluginsAnalyzer.analyze('https://ex.com', plugins, fakeFetcher(routes), 'T');
  assert.equal(r.issues[0].message, 'WordPress plugin with known vulnerabilities');
  assert.equal(r.issues[0].severity, SEVERITY.HIGH);
  assert.match(r.issues[0].detail!, /cf7 5\.1.*XSS \(fixed in 5\.3\.2\)/);
});

// ─── Staging hosts ──────────────────────────────────────────────────────────

void test('staging helpers', () => {
  const ct = JSON.stringify([
    { name_value: 'staging.example.com\n*.dev.example.com' },
    { name_value: 'dev2.example.com' },
    { name_value: 'www.example.com' },
    { name_value: 'devices.example.com' },
    { name_value: 'qa-api.example.com' },
  ]);
  assert.deepEqual(stagingHostsFromCt(ct, 'example.com'), [
    'dev2.example.com',
    'qa-api.example.com',
    'staging.example.com',
  ]);
  assert.equal(stagingHostsFromCt('not json', 'example.com').length, 0);
  assert.ok(isNoindex({ 'x-robots-tag': 'noindex, nofollow' }, ''));
  assert.ok(isNoindex({}, '<meta name="robots" content="noindex">'));
  assert.ok(!isNoindex({}, '<meta name="description" content="noindex">'));
  assert.ok(robotsDisallowsAll('User-agent: *\nDisallow: /\n'));
  assert.ok(!robotsDisallowsAll('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin'));
});

void test('StagingHostsAnalyzer: indexable/noindex/protected/crt.sh failure', async () => {
  const ctUrl = 'https://crt.sh/?q=%25.example.com&output=json';
  const ct = JSON.stringify([
    { name_value: 'staging.example.com\ndev.example.com\nqa.example.com\nuat.example.com\ntest.example.com' },
  ]);
  const html = '<!doctype html><html><head></head><body>hi</body></html>';
  const r = await StagingHostsAnalyzer.analyze(
    'example.com',
    fakeFetcher({
      [ctUrl]: { body: ct },
      'https://staging.example.com/': { body: html, headers: { 'content-type': 'text/html' } },
      'https://dev.example.com/': { body: html, headers: { 'x-robots-tag': 'noindex' } },
      'https://qa.example.com/': { status: 401 },
      'https://uat.example.com/': { body: html, url: 'https://login.microsoftonline.com/x' },
      'https://test.example.com/': { body: `<form><input type="password"></form>` },
    }),
  );
  const med = r.issues.find((i) => i.message === 'Staging or development host is publicly indexable');
  const low = r.issues.find((i) => i.message === 'Staging or development host is publicly reachable');
  assert.equal(med?.severity, SEVERITY.MEDIUM);
  assert.ok(med!.detail!.includes('staging.example.com') && !med!.detail!.includes('uat.'));
  assert.equal(low?.severity, SEVERITY.LOW);
  assert.ok(low!.detail!.includes('dev.example.com'));
  assert.equal(r.checks[0].status, 'fail');

  const down = await StagingHostsAnalyzer.analyze('example.com', fakeFetcher({ [ctUrl]: null }));
  assert.equal(down.checks[0].status, 'skipped');
});
