import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalFileStore, verifyUploadToken } from '../../web/lib/platform/local/file-store';
import { createPlatform } from '../../web/lib/platform';

const SECRET = 'x'.repeat(32);

async function withStore(fn: (s: LocalFileStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fs-store-'));
  try {
    await fn(new LocalFileStore(dir, { appUrl: 'http://localhost:3000', secret: SECRET }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('local FileStore: put, get, list, delete', () =>
  withStore(async (s) => {
    const put = await s.put('audits/a/1/report.html', new TextEncoder().encode('<h1>hi</h1>'), { contentType: 'text/html' });
    assert.equal(put.bytes, 11);
    assert.match(put.sha256, /^[0-9a-f]{64}$/);
    await s.put('audits/a/1/model/site.json.gz', new Blob(['zz']).stream());
    await s.put('audits/b/1/x.txt', new Uint8Array([1]));

    const got = await s.get('audits/a/1/report.html');
    assert.ok(got);
    assert.equal(got.contentType, 'text/html');
    assert.equal(await new Response(got.body).text(), '<h1>hi</h1>');
    assert.equal(await s.get('audits/a/1/missing'), null);

    const keys: string[] = [];
    for await (const e of s.list('audits/a/')) keys.push(e.key);
    assert.deepEqual(keys, ['audits/a/1/model/site.json.gz', 'audits/a/1/report.html']);

    await s.delete(['audits/a/1/report.html']);
    assert.equal(await s.get('audits/a/1/report.html'), null);
  }));

test('local FileStore: a key that leaves the folder is refused', () =>
  withStore(async (s) => {
    for (const key of ['../x', 'audits/../../x', '/etc/passwd', '']) {
      await assert.rejects(s.put(key, new Uint8Array([1])), /invalid file key/);
    }
    await assert.rejects(s.issueUpload('../', 60), /invalid file key/);
  }));

test('local FileStore: upload token names its prefix and expires', () =>
  withStore(async (s) => {
    const { url, headers } = await s.issueUpload('audits/a/1/', 60);
    assert.equal(url, 'http://localhost:3000/api/worker/upload');
    const token = headers.authorization!.replace('Bearer ', '');
    assert.equal(verifyUploadToken(token, SECRET), 'audits/a/1/');
    assert.equal(verifyUploadToken(token, SECRET, Date.now() + 120_000), null);
    assert.equal(verifyUploadToken(token.slice(0, -2) + 'aa', SECRET), null);
  }));

test('PLATFORM_MODE: local is refused in Vercel production', () => {
  const env = { PLATFORM_MODE: 'local', APP_URL: 'http://localhost:3000', LOCAL_WORKER_SECRET: SECRET, FILES_DIR: os.tmpdir() };
  assert.equal(createPlatform(env).mode, 'local');
  assert.throws(() => createPlatform({ ...env, VERCEL_ENV: 'production' }), /refused/);
  assert.throws(() => createPlatform({ ...env, PLATFORM_MODE: undefined }), /PLATFORM_MODE/);
});
