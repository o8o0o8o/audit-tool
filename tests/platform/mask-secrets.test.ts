/** Secrets masking of stored files (design §8.14), checkpoint snapshots, process control, the audit's env. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createTestDb, SKIP_DB, type TestDb } from './db-harness';
import { SECRET, tempStore, writeFixtureRun } from './helpers';
import { audits } from '../../web/db/schema';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { deleteFinishedCheckpoints } from '../../web/lib/core/retention';
import { LocalDispatcher } from '../../web/lib/platform/local/dispatcher';
import { LocalWorkerIdentity } from '../../web/lib/platform/local/identity';
import { maskBytes, maskSecretsInRun, maskText, readMaskRecord } from '../../lib/platform-worker/mask-secrets';
import { restoreSnapshot, Snapshotter } from '../../lib/platform-worker/snapshot';
import { uploadRun } from '../../lib/platform-worker/files';
import { auditChildEnv, scrubPlatformSecrets } from '../../lib/platform-worker/env';
import { descendantsOf, killTree, processStart } from '../../lib/platform-worker/proc-tree';
import { writeRawArchive } from '../../lib/model/build/build-audit-model';
import type { AppClient, SnapshotManifest } from '../../lib/platform-worker/client';

const JWT_VALUE = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'s1gnatureS1gnature'.repeat(2)}`;
const S = {
  stripe: 'sk_live_' + '51H8xQ2eZvKYlo2C9vWbV0qa',
  bearer: 'bearerTOKEN0123456789abcdefXYZ',
  basic: Buffer.from('admin:Sup3rS3cretPassw0rd').toString('base64'),
  cookie: 'sessionCookieValue0123456789',
  setCookie: 'setCookieValue9876543210abc',
  jwt: JWT_VALUE,
  urlPassword: 'urlPassw0rdInUserinfo',
  token: 'tokenParamValue12345',
  accessToken: 'accessTokenValue0987654321',
  apiKey: 'apiKeyValue1234567890',
  apikey: 'apikeyValue0987654321',
  key: 'keyParam0123456789abcdef',
  secret: 'secretParamValue123',
  password: 'hunter2pw',
  passwd: 'passwdValue1',
  clientSecret: 'clientSecretValue123456',
  sig: 'sigvalue0123456789abcdef',
  signature: 'signatureValue0123456789',
  bodyPassword: 'jsonBodyPassw0rd',
  bodyToken: 'jsonBodyToken0123456789',
};
const PUBLIC = ['G-TEST123XY', 'GTM-ABC123', 'key=homepage'];

const query =
  `token=${S.token}&access_token=${S.accessToken}&api_key=${S.apiKey}&apikey=${S.apikey}&key=${S.key}` +
  `&secret=${S.secret}&password=${S.password}&passwd=${S.passwd}&client_secret=${S.clientSecret}` +
  `&sig=${S.sig}&signature=${S.signature}&tid=G-TEST123XY`;

function requestsDoc() {
  return {
    url: 'https://fixture.example/',
    requests: {
      [`https://api.fixture.example/v1/data?${query}`]: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${S.bearer}`,
          'proxy-authorization': `Basic ${S.basic}`,
          cookie: `sid=${S.cookie}; _ga=GA1.2.3; theme=dark`,
          'set-cookie': `sid=${S.setCookie}; Path=/; HttpOnly; Max-Age=3600`,
          'content-type': 'application/json',
          etag: '"46ff2-pX2ihc"',
        },
        postData: JSON.stringify({ user: 'a', password: S.bodyPassword, token: S.bodyToken, note: 'say "hi"' }),
      },
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123&key=homepage': {
        method: 'POST',
        postData: `grant_type=password&password=${S.password}&client_secret=${S.clientSecret}`,
        requestHeaders: [{ name: 'Cookie', value: `sid=${S.cookie}` }],
      },
      [`https://user:${S.urlPassword}@db.fixture.example/x`]: { jwt: S.jwt, stripe: S.stripe },
    },
  };
}

const html = () =>
  `<html><head><script>var stripe = Stripe("${S.stripe}"); fetch("/api?access_token=${S.accessToken}&amp;sig=${S.sig}", {headers: {Authorization: "Bearer ${S.bearer}"}});</script></head>` +
  `<body><a href="https://user:${S.urlPassword}@fixture.example/">x</a><p>${S.jwt}</p><p>id G-TEST123XY GTM-ABC123</p></body></html>`;

function assertClean(bytes: Uint8Array, where: string) {
  const text = Buffer.from(bytes).toString('latin1');
  for (const [name, value] of Object.entries(S)) assert.ok(!text.includes(value), `${name} survives in ${where}`);
}

void test('masking: every kind of secret is masked, public ids are kept, JSON stays JSON', () => {
  const src = JSON.stringify(requestsDoc(), null, 2);
  const { text, masked, patterns } = maskText(src);
  assertClean(Buffer.from(text), 'requests.json');
  const doc = JSON.parse(text) as ReturnType<typeof requestsDoc>;
  assert.equal(Object.keys(doc.requests).length, 3);
  for (const p of PUBLIC) assert.ok(text.includes(p), `${p} is kept`);
  assert.ok(text.includes('Path=/; HttpOnly; Max-Age=3600'), 'cookie attributes are kept');
  assert.ok(text.includes('"46ff2-pX2ihc"') || text.includes('46ff2-pX2ihc'), 'other headers are kept');
  assert.ok(text.includes(`${S.bearer.slice(0, 4)}…${S.bearer.slice(-4)}`), 'first four and last four');
  assert.ok(text.includes('password=…&'), 'a short value is masked whole');
  assert.ok(masked >= 20);
  for (const id of ['jwt', 'authorization', 'cookie', 'set-cookie', 'url-password', 'parameter']) {
    assert.ok(patterns.includes(id), id);
  }
  // A second pass changes nothing.
  assert.equal(maskText(text).text, text);
  assertClean(Buffer.from(maskText(html()).text), 'html');
});

void test('masking: a secret on a window border is masked, and non-UTF-8 bytes survive', () => {
  const filler = (n: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);
  for (let shift = 0; shift < 40; shift += 3) {
    // Window 256, overlap 128: the secret starts a few bytes before each possible border.
    const text = `${filler(240 + shift)} "authorization": "Bearer ${S.bearer}" ${filler(300)} ?token=${S.token}& ${filler(260)}`;
    const out = maskBytes(Buffer.from(text), 256, 128);
    assertClean(out.body, `shift ${shift}`);
    assert.equal(out.masked, 2);
    assert.equal(out.body.toString(), maskText(text).text);
  }
  const latin = Buffer.concat([
    Buffer.from([0xe9, 0xff, 0xa0]),
    Buffer.from(` token=${S.token} `),
    Buffer.from([0xfe]),
  ]);
  const out = maskBytes(latin).body;
  assert.deepEqual([...out.subarray(0, 3)], [0xe9, 0xff, 0xa0]);
  assert.equal(out[out.length - 1], 0xfe);
  assertClean(out, 'latin1 file');
});

class FakeClient {
  uploads = new Map<string, Buffer>();
  uploadGrant = async () => ({ prefix: '', url: 'x', headers: {} });
  upload = async (_g: unknown, key: string, body: Uint8Array) => void this.uploads.set(key, Buffer.from(body));
  snapshotObject = async (attempt: number, sha: string) => {
    const got = [...this.uploads].find(([k]) => k.endsWith(`/${attempt}/objects/${sha}`));
    if (!got) throw new Error('missing object');
    return new Uint8Array(got[1]);
  };
}

function plant(runDir: string) {
  const ev = path.join(runDir, 'evidence', 'home');
  mkdirSync(ev, { recursive: true });
  writeFileSync(path.join(ev, '_meta.json'), JSON.stringify({ url: 'https://fixture.example/' }));
  writeFileSync(path.join(ev, 'requests.json'), JSON.stringify(requestsDoc(), null, 2));
  writeFileSync(path.join(ev, 'snapshot.html'), html());
  writeFileSync(path.join(ev, 'screenshot.mobile.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(path.join(runDir, 'pages', 'batch_0002.json.gz'), gzipSync(JSON.stringify(requestsDoc())));
  writeFileSync(path.join(runDir, 'extra.json.gz'), gzipSync(JSON.stringify({ a: requestsDoc() })));
  // Over 20 MB, one line, with secrets at the start, deep inside and at the very end.
  const pad = JSON.stringify('x'.repeat(1024 * 1024 - 3));
  const parts = [JSON.stringify(requestsDoc())];
  for (let i = 0; i < 21; i++) parts.push(pad, JSON.stringify({ authorization: `Bearer ${S.bearer}`, n: i }));
  parts.push(JSON.stringify(`https://x.example/?token=${S.token}`));
  writeFileSync(path.join(ev, 'large.json'), `[${parts.join(',')}]`);
  writeFileSync(path.join(ev, 'broken.json.gz'), 'not gzip at all');
}

function untar(archive: Buffer): Map<string, Buffer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'untar-'));
  try {
    writeFileSync(path.join(dir, 'a.tar.gz'), archive);
    mkdirSync(path.join(dir, 'out'));
    execFileSync('tar', ['-xzf', path.join(dir, 'a.tar.gz'), '-C', path.join(dir, 'out')]);
    const out = new Map<string, Buffer>();
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out.set(path.relative(path.join(dir, 'out'), full), readFileSync(full));
      }
    };
    walk(path.join(dir, 'out'));
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const opened = (name: string, body: Buffer) =>
  name.endsWith('.gz') && !name.endsWith('.tar.gz') ? gunzipSync(body) : body;

void test('masking: nothing unmasked is uploaded — requests.json, gzip, HTML, a file over 20 MB, the raw archive', async () => {
  const { runDir, cleanup } = writeFixtureRun();
  try {
    plant(runDir);
    const before = readFileSync(path.join(runDir, 'evidence', 'home', 'requests.json'));
    const record = maskSecretsInRun(runDir);
    assert.equal(
      record['evidence/home/requests.json']!.sha256Original,
      createHash('sha256').update(before).digest('hex'),
    );
    assert.ok(record['pages/batch_0002.json.gz']!.masked > 0);
    assert.ok(record['evidence/home/large.json']!.masked >= 22);
    assert.match(record['evidence/home/broken.json.gz']!.notMasked ?? '', /./);
    assert.deepEqual(readMaskRecord(runDir), record);
    // The raw archive is built after masking (run.ts: mask, then build).
    mkdirSync(path.join(runDir, 'model'), { recursive: true });
    writeRawArchive(runDir, path.join(runDir, 'model', 'raw-archive.tar.gz'));

    const client = new FakeClient();
    const rows = await uploadRun(client as unknown as AppClient, runDir, 'a1', 1);
    assert.ok(rows.some((r) => r.kind === 'raw_archive'));
    const keys = [...client.uploads.keys()];
    assert.ok(keys.includes('audits/a1/1/evidence/home/large.json'));
    assert.ok(!keys.some((k) => k.endsWith('broken.json.gz')), 'a file that could not be masked is not uploaded');
    for (const [key, body] of client.uploads) {
      if (key.endsWith('raw-archive.tar.gz')) {
        const inner = untar(body);
        assert.ok(inner.has('pages/batch_0002.json.gz') && inner.has('extra.json.gz'));
        for (const [name, b] of inner) assertClean(opened(name, b), `raw archive ${name}`);
        continue;
      }
      const plain = opened(key, body);
      assertClean(plain, key);
      if (/\.json(\.gz)?$/.test(key)) JSON.parse(plain.toString('utf8'));
    }
    const large = client.uploads.get('audits/a1/1/evidence/home/large.json')!;
    assert.ok(large.byteLength > 20 * 1024 * 1024);
    // Masking again finds nothing new and keeps the first hashes.
    assert.deepEqual(maskSecretsInRun(runDir), record);
  } finally {
    cleanup();
  }
});

void test('snapshots: masked copies are uploaded, hashes are of the stored bytes, the live files are untouched', async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  const restored = mkdtempSync(path.join(os.tmpdir(), 'snap-restore-'));
  try {
    const dir = path.join(work, 'lead-results', 'fixture.example', '2026-11-20_10-00-00');
    mkdirSync(path.join(dir, 'evidence', 'home'), { recursive: true });
    const live = {
      'manifest.json.gz': gzipSync(JSON.stringify({ progress: { processedPages: ['https://fixture.example/'] } })),
      'pages.json.gz': gzipSync(JSON.stringify(requestsDoc())),
      'evidence/home/requests.json': Buffer.from(JSON.stringify(requestsDoc())),
      'evidence/home/shot.png': Buffer.from([0x89, 0x50, 0, 1]),
    };
    for (const [rel, body] of Object.entries(live)) writeFileSync(path.join(dir, rel), body);
    const client = new FakeClient();
    const snap = new Snapshotter(client as unknown as AppClient, work, 'lead-results', 'a1', 1);
    assert.equal(await snap.take(() => true), true);
    for (const [rel, body] of Object.entries(live)) assert.deepEqual(readFileSync(path.join(dir, rel)), body, rel);
    const manifest = JSON.parse(client.uploads.get('checkpoints/a1/1/manifest.json')!.toString()) as SnapshotManifest;
    assert.equal(manifest.files.length, 4);
    for (const f of manifest.files) {
      const stored = client.uploads.get(`checkpoints/a1/1/objects/${f.sha256}`)!;
      assert.equal(createHash('sha256').update(stored).digest('hex'), f.sha256);
      assert.equal(stored.byteLength, f.bytes);
      assertClean(opened(f.path, stored), `snapshot ${f.path}`);
    }
    // A second snapshot uploads only the manifest again.
    const n = client.uploads.size;
    assert.equal(await snap.take(() => true), true);
    assert.equal(client.uploads.size, n);
    // The restore checks each object against the manifest's hash, and the checkpoint still reads.
    assert.equal(await restoreSnapshot(client as unknown as AppClient, restored, { attempt: 1, manifest }), 4);
    const back = path.join(restored, 'lead-results', 'fixture.example', '2026-11-20_10-00-00');
    assert.deepEqual(readFileSync(path.join(back, 'manifest.json.gz')), live['manifest.json.gz']);
    JSON.parse(gunzipSync(readFileSync(path.join(back, 'pages.json.gz'))).toString());
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(restored, { recursive: true, force: true });
  }
});

void test('worker env: the audit gets no platform secret, token or nonce, and .env cannot bring them back', () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/bin',
    CRUX_API_KEY: 'crux',
    WPSCAN_API_TOKEN: 'wp',
    ANTHROPIC_API_KEY: 'llm',
    PLATFORM_WORKER_TOKEN: 'tok',
    DISPATCH_NONCE: 'nonce',
    SESSION_SECRET: 's',
    DATABASE_URL: 'postgres://x',
    DATABASE_URL_UNPOOLED: 'postgres://y',
  };
  const off = { llm: false, verify: false, contentResearch: false };
  const child = auditChildEnv(env, off, { AUDIT_PROGRESS_FILE: '/p' });
  assert.equal(child.CRUX_API_KEY, 'crux');
  assert.equal(child.WPSCAN_API_TOKEN, 'wp');
  assert.equal(child.AUDIT_PROGRESS_FILE, '/p');
  // Empty, not absent: loadDotEnv only fills names that are not set.
  for (const k of [
    'PLATFORM_WORKER_TOKEN',
    'DISPATCH_NONCE',
    'SESSION_SECRET',
    'REPORT_TOKEN_SECRET',
    'LOCAL_WORKER_SECRET',
    'DATABASE_URL',
    'DATABASE_URL_TEST',
    'DATABASE_URL_UNPOOLED',
    'INTERNAL_PASSWORD_HASH',
    'ANTHROPIC_API_KEY',
  ]) {
    assert.equal(child[k], '', k);
  }
  assert.equal(auditChildEnv(env, { ...off, llm: true }, {}).ANTHROPIC_API_KEY, 'llm');
  scrubPlatformSecrets(env);
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.DATABASE_URL_UNPOOLED, undefined);
  assert.equal(env.CRUX_API_KEY, 'crux');
});

const isAlive = (pid: number) => processStart(pid) !== null && !/^Z/.test(stat(pid));
const stat = (pid: number) => {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return 'Z';
  }
};
const sleeper = 'setInterval(() => {}, 1000)';

async function waitFor(fn: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

void test('process control: the whole tree is killed, a process group of its own included', async () => {
  // parent → child in its own process group (as Playwright starts Chromium) → grandchild.
  const grand = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore' }); ${sleeper}`;
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { detached: true, stdio: 'ignore' }); ${sleeper}`,
    ],
    { stdio: 'ignore', detached: true },
  );
  try {
    assert.ok(await waitFor(() => (descendantsOf(parent.pid!)?.length ?? 0) >= 2), 'the tree started');
    const tree = descendantsOf(parent.pid!)!;
    assert.equal(await killTree(parent.pid!), true);
    assert.ok(await waitFor(() => ![parent.pid!, ...tree].some(isAlive)), 'nothing is left');
  } finally {
    parent.kill('SIGKILL');
  }
});

void test('local dispatcher: a reused pid is not the worker — state is gone and cancel does nothing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dispatcher-'));
  const other = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore' });
  try {
    const d = new LocalDispatcher(new LocalWorkerIdentity(SECRET), { appUrl: 'http://127.0.0.1:9', repoRoot: root });
    const write = (attempt: number, info: object) => {
      mkdirSync(d.workDir('a1', attempt), { recursive: true });
      writeFileSync(path.join(d.workDir('a1', attempt), 'worker.json'), JSON.stringify(info));
    };
    assert.ok(await waitFor(() => processStart(other.pid!) !== null));
    // Attempt 1: the pid now belongs to a process started at another time.
    write(1, { pid: other.pid, runId: '1', startedAt: '', procStart: 'Thu Jan  1 00:00:00 1970' });
    assert.equal(await d.state('a1', 1), 'gone');
    await d.cancel('a1', 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(isAlive(other.pid!), 'an unrelated process is not signalled');
    // Attempt 2: the same process with its real start time is the worker.
    write(2, { pid: other.pid, runId: '2', startedAt: '', procStart: processStart(other.pid!) });
    assert.equal(await d.state('a1', 2), 'running');
    await d.cancel('a1', 2);
    assert.ok(await waitFor(() => !isAlive(other.pid!)));
    assert.equal(await d.state('a1', 2), 'gone');
    assert.equal(await d.state('a1', 3), 'gone');
  } finally {
    other.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
});

void test(
  'retention: checkpoints of a finished audit are deleted, those of a running one are kept',
  { skip: SKIP_DB },
  async () => {
    const files = tempStore();
    try {
      const make = async (status: string) => {
        const site = await findOrCreateSite(t.db, `c${randomUUID().slice(0, 8)}.example`);
        const id = randomUUID();
        await t.db.insert(audits).values({
          id,
          siteId: site.id,
          mode: 'quick',
          targetUrl: `https://${site.host}`,
          profile: 'standard',
          profileHash: id,
          comparableKey: 'k',
          source: 'internal',
          status,
        });
        await files.store.put(`checkpoints/${id}/1/manifest.json`, new Uint8Array([1]), {
          contentType: 'application/json',
        });
        await files.store.put(`checkpoints/${id}/1/objects/${'a'.repeat(64)}`, new Uint8Array([2]));
        await files.store.put(`audits/${id}/1/report.html`, new Uint8Array([3]));
        return id;
      };
      const ids = {
        running: await make('running'),
        stalled: await make('stalled'),
        done: await make('succeeded'),
        failed: await make('failed'),
      };
      const orphan = randomUUID();
      await files.store.put(`checkpoints/${orphan}/2/manifest.json`, new Uint8Array([1]));
      assert.equal(await deleteFinishedCheckpoints(t.db, files.store), 5);
      const left: string[] = [];
      for await (const f of files.store.list('')) left.push(f.key);
      for (const id of [ids.running, ids.stalled]) assert.ok(left.includes(`checkpoints/${id}/1/manifest.json`));
      for (const id of [ids.done, ids.failed, orphan]) assert.ok(!left.some((k) => k.startsWith(`checkpoints/${id}/`)));
      assert.equal(left.filter((k) => k.startsWith('audits/')).length, 4, 'stored results are not touched');
      assert.equal(await deleteFinishedCheckpoints(t.db, files.store), 0);
    } finally {
      files.cleanup();
    }
  },
);
