/**
 * The production implementations of the three platform interfaces, against stand-ins for Vercel Blob
 * and GitHub. What only the real services can show (build guide §8) is not covered here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createPlatform } from '../../web/lib/platform';
import { BlobFileStore, type BlobApi } from '../../web/lib/platform/production/blob-file-store';
import { GitHubDispatcher, runTitle } from '../../web/lib/platform/production/github-dispatcher';
import { GITHUB_OIDC_ISSUER, GitHubWorkerIdentity } from '../../web/lib/platform/production/github-identity';
import { DispatchUnavailable } from '../../web/lib/platform/types';
import { githubOidcToken } from '../../lib/platform-worker/github-oidc';
import { AppClient, type UploadGrant } from '../../lib/platform-worker/client';
import { auditChildEnv, scrubWorkerIdentity } from '../../lib/platform-worker/env';

const TOKEN = 'vercel_blob_rw_store123_secretsecret';
const ID = '0b0e7f0a-1111-4222-8333-444455556666';

// ── Blob FileStore ───────────────────────────────────────────────────────────

function fakeBlob() {
  const blobs = new Map<string, { body: Uint8Array; contentType: string }>();
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let issued = 0;
  const api = {
    put: async (pathname: string, body: unknown, options: Record<string, unknown>) => {
      calls.push({ fn: 'put', args: [pathname, options] });
      blobs.set(pathname, { body: new Uint8Array(body as Buffer), contentType: String(options.contentType) });
      return {};
    },
    get: async (pathname: string, options: Record<string, unknown>) => {
      calls.push({ fn: 'get', args: [pathname, options] });
      const b = blobs.get(pathname);
      if (!b) return null;
      return {
        statusCode: 200,
        stream: new Blob([Buffer.from(b.body)]).stream(),
        headers: new Headers(),
        blob: { contentType: b.contentType, size: b.body.byteLength },
      };
    },
    list: async (options: { prefix?: string; cursor?: string }) => {
      const keys = [...blobs.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
      const from = options.cursor ? Number(options.cursor) : 0;
      const page = keys.slice(from, from + 2);
      const more = from + 2 < keys.length;
      return {
        blobs: page.map((k) => ({ pathname: k, size: blobs.get(k)!.body.byteLength })),
        hasMore: more,
        ...(more ? { cursor: String(from + 2) } : {}),
      };
    },
    del: async (keys: string[]) => {
      for (const k of keys) blobs.delete(k);
    },
    issueSignedToken: async (options: Record<string, unknown>) => {
      calls.push({ fn: 'issueSignedToken', args: [options] });
      issued++;
      return { delegationToken: `d${issued}`, clientSigningToken: `c${issued}`, validUntil: options.validUntil };
    },
    presignUrl: async (token: { delegationToken: string }, options: Record<string, unknown>) => {
      calls.push({ fn: 'presignUrl', args: [token, options] });
      return {
        presignedUrl: `https://blob.example/?pathname=${options.pathname}&d=${token.delegationToken}&until=${options.validUntil}`,
      };
    },
  };
  return { api: api as unknown as BlobApi, blobs, calls, issued: () => issued };
}

void test('Blob FileStore: put, get, list across pages, delete; private and never a random suffix', async () => {
  const f = fakeBlob();
  const s = new BlobFileStore({ token: TOKEN, appUrl: 'https://app.example', api: f.api });
  const put = await s.put('audits/a/1/report.html', new TextEncoder().encode('<h1>hi</h1>'), {
    contentType: 'text/html',
  });
  assert.equal(put.bytes, 11);
  assert.match(put.sha256, /^[0-9a-f]{64}$/);
  await s.put('audits/a/1/model/site.json.gz', new Blob(['zz']).stream());
  await s.put('audits/a/1/x.bin', new Uint8Array([1]));
  await s.put('audits/b/1/x.txt', new Uint8Array([1]));
  for (const c of f.calls.filter((c) => c.fn === 'put')) {
    const o = c.args[1] as Record<string, unknown>;
    assert.equal(o.access, 'private');
    assert.equal(o.addRandomSuffix, false);
    assert.equal(o.allowOverwrite, true);
    assert.equal(o.token, TOKEN);
  }

  const got = await s.get('audits/a/1/report.html');
  assert.ok(got);
  assert.equal(got.contentType, 'text/html');
  assert.equal(got.bytes, 11);
  assert.equal(await new Response(got.body).text(), '<h1>hi</h1>');
  assert.equal((await s.get('audits/a/1/x.bin'))?.contentType, undefined, 'no type was given');
  assert.equal(await s.get('audits/a/1/missing'), null);

  const keys: string[] = [];
  for await (const e of s.list('audits/a/')) keys.push(e.key);
  assert.deepEqual(keys, ['audits/a/1/model/site.json.gz', 'audits/a/1/report.html', 'audits/a/1/x.bin']);

  await s.delete(['audits/a/1/report.html']);
  assert.equal(await s.get('audits/a/1/report.html'), null);
});

void test('Blob FileStore: files that are overwritten are read past the cache', async () => {
  const f = fakeBlob();
  const s = new BlobFileStore({ token: TOKEN, appUrl: 'https://app.example', api: f.api });
  await s.put('signals/work-raised', new TextEncoder().encode('1'));
  await s.put('audits/a/1/x', new Uint8Array([1]));
  await s.get('signals/work-raised');
  await s.get('checkpoints/a/1/manifest.json');
  await s.get('audits/a/1/x');
  const cache = f.calls.filter((c) => c.fn === 'get').map((c) => (c.args[1] as { useCache: boolean }).useCache);
  assert.deepEqual(cache, [false, false, true]);
  const puts = f.calls
    .filter((c) => c.fn === 'put')
    .map((c) => (c.args[1] as { cacheControlMaxAge?: number }).cacheControlMaxAge);
  assert.deepEqual(puts, [60, undefined]);
});

void test('Blob FileStore: a key that leaves the store is refused', async () => {
  const s = new BlobFileStore({ token: TOKEN, appUrl: 'https://app.example', api: fakeBlob().api });
  for (const key of ['../x', 'audits/../../x', '/etc/passwd', '']) {
    await assert.rejects(s.put(key, new Uint8Array([1])), /invalid file key/);
    await assert.rejects(s.presignUpload(key, 60), /invalid file key/);
  }
  await assert.rejects(s.issueUpload('../', 60), /invalid file key/);
  assert.throws(() => new BlobFileStore({ token: 'nonsense', appUrl: 'https://app.example' }), /store id/);
});

void test('Blob FileStore: an upload address is for one file, and the worker never gets the store token', async () => {
  const f = fakeBlob();
  let clock = 1_000_000_000_000;
  const s = new BlobFileStore({ token: TOKEN, appUrl: 'https://app.example', api: f.api, now: () => clock });
  const grant = await s.issueUpload('audits/a/1/', 3600);
  assert.deepEqual(grant, { url: 'https://app.example/api/worker/upload-url', headers: {} });

  const up = await s.presignUpload('audits/a/1/evidence/p/shot.png', 900, 'image/png');
  assert.equal(up.method, 'PUT');
  assert.match(up.url, /pathname=audits\/a\/1\/evidence\/p\/shot\.png/);
  assert.equal(up.headers['x-vercel-blob-access'], 'private');
  assert.equal(up.headers['x-content-type'], 'image/png');
  assert.equal(up.headers['x-vercel-blob-store-id'], 'store123');
  assert.ok(!JSON.stringify(up).includes('secretsecret'), 'the read-write token is not in the answer');
  const presign = f.calls.find((c) => c.fn === 'presignUrl')!.args[1] as Record<string, unknown>;
  assert.equal(presign.operation, 'put');
  assert.equal(presign.pathname, 'audits/a/1/evidence/p/shot.png');
  assert.equal(presign.validUntil, clock + 900_000);
  const issue = f.calls.find((c) => c.fn === 'issueSignedToken')!.args[0] as Record<string, unknown>;
  assert.deepEqual(issue.operations, ['put']);

  // The delegation is reused, and replaced before it runs out.
  await s.presignUpload('audits/a/1/b', 900);
  assert.equal(f.issued(), 1);
  clock += 55 * 60_000;
  const late = await s.presignUpload('audits/a/1/c', 900);
  assert.equal(f.issued(), 2);
  assert.match(late.url, /d=d2/);
});

// ── GitHub Dispatcher ────────────────────────────────────────────────────────

const WORKER = { repository: 'acme/audit-tool', workflow: 'platform-worker.yml', ref: 'main' };

function fakeGitHub(handler: (method: string, url: string, body: unknown) => Response | Promise<Response>) {
  const seen: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? 'GET', url, body, auth: new Headers(init?.headers).get('authorization') });
    return handler(init?.method ?? 'GET', url, body);
  }) as typeof fetch;
  return { fetchFn, seen };
}

void test('GitHub Dispatcher: starts the worker workflow with the attempt and no secret', async () => {
  const gh = fakeGitHub(() => new Response(null, { status: 204 }));
  const d = new GitHubDispatcher({ ...WORKER, token: 'ghp_x', appUrl: 'https://app.example', fetch: gh.fetchFn });
  await d.dispatch({
    kind: 'audit',
    id: ID,
    attempt: 2,
    nonce: 'nonce-12345',
    inputs: { mode: 'full', url: 'https://x.example' },
  });
  assert.equal(gh.seen.length, 1);
  const call = gh.seen[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(
    call.url,
    'https://api.github.com/repos/acme/audit-tool/actions/workflows/platform-worker.yml/dispatches',
  );
  assert.equal(call.auth, 'Bearer ghp_x');
  assert.deepEqual(call.body, {
    ref: 'main',
    inputs: { kind: 'audit', id: ID, attempt: '2', nonce: 'nonce-12345', app_url: 'https://app.example' },
  });
});

void test('GitHub Dispatcher: a refusal or a network error leaves the audit queued', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const status of [401, 404, 422, 429, 500, 503]) {
      const gh = fakeGitHub(() => new Response('no', { status }));
      const d = new GitHubDispatcher({ ...WORKER, token: 't', appUrl: 'https://app.example', fetch: gh.fetchFn });
      await assert.rejects(
        d.dispatch({ kind: 'audit', id: ID, attempt: 1, nonce: 'nonce-12345', inputs: {} }),
        DispatchUnavailable,
      );
    }
    const down = new GitHubDispatcher({
      ...WORKER,
      token: 't',
      appUrl: 'https://app.example',
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch,
    });
    await assert.rejects(
      down.dispatch({ kind: 'audit', id: ID, attempt: 1, nonce: 'nonce-12345', inputs: {} }),
      DispatchUnavailable,
    );
  } finally {
    console.error = quiet;
  }
});

void test('GitHub Dispatcher: state and cancel find the run by its name', async () => {
  const runs = [
    { id: 11, status: 'completed', display_title: runTitle('audit', ID, 1) },
    { id: 12, status: 'in_progress', display_title: runTitle('audit', ID, 2) },
    { id: 13, status: 'queued', display_title: runTitle('render-pdf', ID, 1).replace('#1', '#3') },
    { id: 14, status: 'in_progress', display_title: 'platform audit other #1' },
  ];
  const gh = fakeGitHub((method, url) => {
    if (method === 'GET') return Response.json({ workflow_runs: runs });
    if (url.endsWith('/actions/runs/12/cancel')) return new Response(null, { status: 202 });
    return new Response('unexpected', { status: 500 });
  });
  const d = new GitHubDispatcher({ ...WORKER, token: 't', appUrl: 'https://app.example', fetch: gh.fetchFn });
  assert.equal(await d.state(ID, 1), 'gone', 'completed');
  assert.equal(await d.state(ID, 2), 'running');
  assert.equal(await d.state(ID, 3), 'waiting', 'queued, and a PDF job is found too');
  assert.equal(await d.state(ID, 4), 'gone', 'no such run');

  await d.cancel(ID, 2);
  assert.ok(gh.seen.some((c) => c.method === 'POST' && c.url.endsWith('/actions/runs/12/cancel')));
  const before = gh.seen.filter((c) => c.method === 'POST').length;
  await d.cancel(ID, 1); // already completed
  await d.cancel(ID, 4); // never existed
  assert.equal(gh.seen.filter((c) => c.method === 'POST').length, before);
});

void test('GitHub Dispatcher: when GitHub cannot be read the attempt is left alone', async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const gh = fakeGitHub(() => new Response('down', { status: 502 }));
    const d = new GitHubDispatcher({ ...WORKER, token: 't', appUrl: 'https://app.example', fetch: gh.fetchFn });
    assert.equal(await d.state(ID, 1), 'waiting');
  } finally {
    console.warn = quiet;
  }
});

// ── GitHub OIDC identity ─────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}) {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = enc({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' });
  const body = enc(claims);
  const sig = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(opts.key ?? privateKey)
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

const goodClaims = () => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: 'audit-platform',
  exp: NOW / 1000 + 300,
  nbf: NOW / 1000 - 10,
  repository: 'acme/audit-tool',
  repository_id: '4242',
  event_name: 'workflow_dispatch',
  ref: 'refs/heads/main',
  workflow_ref: 'acme/audit-tool/.github/workflows/platform-worker.yml@refs/heads/main',
  run_id: '9876543210',
  run_attempt: '1',
});

function identity(extra: { repositoryId?: string } = {}) {
  let fetches = 0;
  const id = new GitHubWorkerIdentity({
    ...WORKER,
    audience: 'audit-platform',
    ...extra,
    now: () => NOW,
    fetch: (async () => {
      fetches++;
      return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    }) as typeof fetch,
  });
  return { id, fetches: () => fetches };
}

void test('GitHub identity: a token from our workflow run is accepted, with the run it names', async () => {
  const { id, fetches } = identity();
  assert.deepEqual(await id.verify(jwt(goodClaims())), { runId: '9876543210', runAttempt: 1 });
  assert.deepEqual(await id.verify(jwt({ ...goodClaims(), run_attempt: '2', aud: ['x', 'audit-platform'] })), {
    runId: '9876543210',
    runAttempt: 2,
  });
  assert.equal(fetches(), 1, 'keys are fetched once');
});

void test('GitHub identity: anything else is refused', async () => {
  const { id, fetches } = identity({ repositoryId: '4242' });
  assert.ok(await id.verify(jwt(goodClaims())));
  const bad: Array<[string, string]> = [
    ['another audience', jwt({ ...goodClaims(), aud: 'someone-else' })],
    ['another issuer', jwt({ ...goodClaims(), iss: 'https://evil.example' })],
    ['expired', jwt({ ...goodClaims(), exp: NOW / 1000 - 1 })],
    ['not valid yet', jwt({ ...goodClaims(), nbf: NOW / 1000 + 600 })],
    ['another repository', jwt({ ...goodClaims(), repository: 'evil/audit-tool' })],
    ['same name, another repository id', jwt({ ...goodClaims(), repository_id: '1' })],
    ['a push, not a dispatch', jwt({ ...goodClaims(), event_name: 'push' })],
    ['another branch', jwt({ ...goodClaims(), ref: 'refs/heads/feature' })],
    [
      'another workflow',
      jwt({ ...goodClaims(), workflow_ref: 'acme/audit-tool/.github/workflows/audit.yml@refs/heads/main' }),
    ],
    [
      'the workflow from another branch',
      jwt({ ...goodClaims(), workflow_ref: 'acme/audit-tool/.github/workflows/platform-worker.yml@refs/heads/x' }),
    ],
    ['no run id', jwt({ ...goodClaims(), run_id: undefined })],
    ['signed with another key', jwt(goodClaims(), { key: other.privateKey })],
    ['unknown key id', jwt(goodClaims(), { kid: 'k9' })],
    ['alg none', jwt(goodClaims(), { alg: 'none' })],
    ['not a token', 'abc'],
    ['a local token', 'eyJ4IjoxfQ.c2ln'],
  ];
  for (const [name, token] of bad) assert.equal(await id.verify(token), null, name);
  // A changed payload under a good signature.
  const [h, , s] = jwt(goodClaims()).split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...goodClaims(), run_id: '1' })).toString('base64url')}.${s}`;
  assert.equal(await id.verify(forged), null, 'altered payload');
  assert.equal(fetches(), 1, 'an unknown key id does not fetch the keys on every call');
});

// ── The switch ───────────────────────────────────────────────────────────────

void test('PLATFORM_MODE=production needs every setting, and builds the production parts', () => {
  const env = {
    PLATFORM_MODE: 'production',
    VERCEL_ENV: 'production',
    APP_URL: 'https://app.example',
    WORKER_REPOSITORY: 'acme/audit-tool',
    WORKER_OIDC_AUDIENCE: 'audit-platform',
    PLATFORM_BLOB_READ_WRITE_TOKEN: TOKEN,
    GITHUB_DISPATCH_TOKEN: 'ghp_x',
  };
  const p = createPlatform(env);
  assert.equal(p.mode, 'production');
  assert.ok(p.files instanceof BlobFileStore);
  assert.ok(p.dispatcher instanceof GitHubDispatcher);
  assert.ok(p.identity instanceof GitHubWorkerIdentity);
  for (const name of Object.keys(env).filter((k) => !['PLATFORM_MODE', 'VERCEL_ENV'].includes(k))) {
    assert.throws(() => createPlatform({ ...env, [name]: '' }), new RegExp(name), name);
  }
  assert.throws(() => createPlatform({ ...env, APP_URL: 'http://app.example' }), /https/);
  assert.throws(() => createPlatform({ ...env, WORKER_REPOSITORY: 'just-a-name' }), /owner\/name/);
  // A public store's default token is never picked up by itself.
  assert.throws(
    () => createPlatform({ ...env, PLATFORM_BLOB_READ_WRITE_TOKEN: undefined, BLOB_READ_WRITE_TOKEN: TOKEN }),
    /PLATFORM_BLOB_READ_WRITE_TOKEN/,
  );
});

// ── The worker's side ────────────────────────────────────────────────────────

void test('worker: asks GitHub for an identity token with the platform audience', async () => {
  assert.equal(await githubOidcToken({}), null, 'not on a GitHub runner');
  let asked = '';
  let auth = '';
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    asked = String(input);
    auth = new Headers(init?.headers).get('authorization') ?? '';
    return Response.json({ value: 'the.jwt.token' });
  }) as typeof fetch;
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.example/token?api-version=2',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-bearer',
    PLATFORM_OIDC_AUDIENCE: 'audit-platform',
  };
  assert.equal(await githubOidcToken(env, fetchFn), 'the.jwt.token');
  assert.equal(asked, 'https://gh.example/token?api-version=2&audience=audit-platform');
  assert.equal(auth, 'Bearer request-bearer');
  await assert.rejects(githubOidcToken({ ...env, PLATFORM_OIDC_AUDIENCE: '' }, fetchFn), /PLATFORM_OIDC_AUDIENCE/);

  // The audit never gets what could mint another token.
  const child = auditChildEnv({ ...env, PATH: '/bin' }, { llm: false, verify: false, contentResearch: false }, {});
  assert.equal(child.ACTIONS_ID_TOKEN_REQUEST_TOKEN, '');
  assert.equal(child.ACTIONS_ID_TOKEN_REQUEST_URL, '');
  assert.equal(child.PATH, '/bin');
  const own: NodeJS.ProcessEnv = { ...env, PLATFORM_WORKER_TOKEN: 't' };
  scrubWorkerIdentity(own);
  assert.equal(own.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(own.PLATFORM_WORKER_TOKEN, undefined);
});

void test('worker: with a presign grant each file gets its own address and goes straight to storage', async () => {
  const seen: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body });
    if (url === 'https://app.example/api/worker/upload-url') {
      return Response.json({
        method: 'PUT',
        url: 'https://blob.example/put?sig=1',
        headers: { 'x-vercel-blob-access': 'private' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const client = new AppClient('https://app.example');
    client.session = 'session-token';
    const grant: { current: UploadGrant; area: 'checkpoint' } = {
      current: {
        prefix: `checkpoints/${ID}/1/`,
        url: 'https://app.example/api/worker/upload-url',
        headers: {},
        presign: true,
      },
      area: 'checkpoint',
    };
    await client.upload(grant, `checkpoints/${ID}/1/manifest.json`, new TextEncoder().encode('{}'), 'application/json');
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.headers.get('authorization'), 'Bearer session-token');
    assert.deepEqual(JSON.parse(String(seen[0]!.body)), {
      area: 'checkpoint',
      key: `checkpoints/${ID}/1/manifest.json`,
      content_type: 'application/json',
    });
    assert.equal(seen[1]!.url, 'https://blob.example/put?sig=1');
    assert.equal(seen[1]!.method, 'PUT');
    assert.equal(seen[1]!.headers.get('x-vercel-blob-access'), 'private');
    assert.equal(seen[1]!.headers.get('authorization'), null, 'the session is not sent to storage');
  } finally {
    globalThis.fetch = real;
  }
});
