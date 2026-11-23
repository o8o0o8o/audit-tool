/**
 * Tries the production FileStore against the real private Blob store: put, get, list, a presigned
 * upload done the way the worker does it (a plain HTTP request with the headers the app names), an
 * overwrite, and delete. Everything is written under `checks/` and removed again.
 *   PLATFORM_BLOB_READ_WRITE_TOKEN=… yarn --cwd web tsx scripts/check-blob-store.ts
 *   (or PLATFORM_BLOB_STORE_ID with VERCEL_OIDC_TOKEN)
 */
import { BlobFileStore } from '../lib/platform/production/blob-file-store';

async function main(): Promise<void> {
  const token = process.env.PLATFORM_BLOB_READ_WRITE_TOKEN;
  const storeId = process.env.PLATFORM_BLOB_STORE_ID;
  if (!token && !storeId) throw new Error('set PLATFORM_BLOB_READ_WRITE_TOKEN or PLATFORM_BLOB_STORE_ID');
  const store = new BlobFileStore({ ...(token ? { token } : { storeId: storeId! }), appUrl: 'https://check.invalid' });
  const prefix = `checks/${Date.now()}/`;
  const text = (s: string) => new TextEncoder().encode(s);
  const read = async (key: string) => {
    const got = await store.get(key);
    return got ? { text: await new Response(got.body).text(), type: got.contentType, bytes: got.bytes } : null;
  };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      console.log(`ok    ${name}${r === undefined ? '' : `: ${JSON.stringify(r)}`}`);
    } catch (err) {
      console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };
  const expect = (cond: unknown, what: string) => {
    if (!cond) throw new Error(what);
  };

  console.log(`store ${store.storeId}, prefix ${prefix}`);
  await step('put', () => store.put(`${prefix}a.json`, text('{"n":1}'), { contentType: 'application/json' }));
  await step('get', async () => {
    const got = await read(`${prefix}a.json`);
    expect(got?.text === '{"n":1}', `read back ${JSON.stringify(got)}`);
    return { type: got!.type, bytes: got!.bytes };
  });
  await step(
    'a large text file reports its real size (the service sends it compressed, without a length)',
    async () => {
      const html = `<html><body>${'<p>the same line again</p>'.repeat(20_000)}</body></html>`;
      await store.put(`${prefix}report.html`, text(html), { contentType: 'text/html' });
      const got = await store.get(`${prefix}report.html`);
      const read = got ? (await new Response(got.body).arrayBuffer()).byteLength : -1;
      expect(
        got?.bytes === html.length && read === html.length,
        `bytes ${got?.bytes}, read ${read}, wrote ${html.length}`,
      );
      return { bytes: got!.bytes };
    },
  );
  await step('get a missing file gives null', async () =>
    expect((await read(`${prefix}missing`)) === null, 'not null'),
  );
  await step('presigned upload (as the worker sends it)', async () => {
    const up = await store.presignUpload(`${prefix}evidence/shot.png`, 900, 'image/png');
    const res = await fetch(up.url, { method: up.method, headers: up.headers, body: Buffer.from([1, 2, 3, 4]) });
    expect(res.ok, `${res.status} ${(await res.text()).slice(0, 300)}`);
    const got = await store.get(`${prefix}evidence/shot.png`);
    expect(got?.bytes === 4, `stored ${got?.bytes} bytes`);
    return { status: res.status, type: got!.contentType };
  });
  await step('presigned upload overwrites (snapshot manifests)', async () => {
    for (const body of ['one', 'second']) {
      const up = await store.presignUpload(`${prefix}manifest.json`, 900, 'application/json');
      const res = await fetch(up.url, { method: up.method, headers: up.headers, body });
      expect(res.ok, `${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const got = await read(`${prefix}manifest.json`);
    expect(got?.text === 'second', `read back ${JSON.stringify(got)}`);
  });
  await step('a presigned address does not accept another pathname', async () => {
    const up = await store.presignUpload(`${prefix}mine.txt`, 900);
    const other = new URL(up.url);
    other.searchParams.set('pathname', `${prefix}someone-elses.txt`);
    const res = await fetch(other, { method: up.method, headers: up.headers, body: 'x' });
    expect(!res.ok, `accepted with ${res.status}`);
    return { status: res.status };
  });
  await step('list', async () => {
    const keys: string[] = [];
    for await (const f of store.list(prefix)) keys.push(f.key.slice(prefix.length));
    expect(
      keys.includes('a.json') && keys.includes('evidence/shot.png') && keys.includes('report.html'),
      `listed ${keys.join(', ')}`,
    );
    return keys.sort();
  });
  await step('delete', async () => {
    const keys: string[] = [];
    for await (const f of store.list(prefix)) keys.push(f.key);
    await store.delete(keys);
    const left: string[] = [];
    for await (const f of store.list(prefix)) left.push(f.key);
    expect(left.length === 0, `left ${left.join(', ')}`);
    return { deleted: keys.length };
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
