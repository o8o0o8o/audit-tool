/**
 * A test stand-in for the app's /api/worker/* routes: the same lib/core calls the Next route
 * handlers make, on the test database and a temp file store. Lets slow tests run a real worker
 * (scripts/platform-worker.ts) without starting Next.
 */
import http from 'node:http';
import type { Db } from '../../web/db/client';
import { CoreError } from '../../web/lib/core/errors';
import {
  heartbeat,
  issueWorkerUpload,
  latestSnapshot,
  registerWorker,
  reportProgress,
  reportStatus,
  snapshotObject,
  workerGuard,
  workerSession,
} from '../../web/lib/core/worker';
import { verifyUploadToken } from '../../web/lib/platform/local/file-store';
import type { LocalFileStore } from '../../web/lib/platform/local/file-store';
import type { WorkerIdentity } from '../../web/lib/platform/types';

export async function startWorkerServer(deps: {
  db: Db;
  files: LocalFileStore;
  identity: WorkerIdentity;
  secret: string;
  onFinished?: (id: string) => Promise<void>;
}) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const json = () => (raw.length ? JSON.parse(raw.toString('utf8')) : {});
    const auth = req.headers.authorization ?? null;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (p === '/api/worker/register')
        return send(
          200,
          await registerWorker(deps.db, deps.identity, auth?.replace(/^Bearer\s+/i, '') ?? null, json()),
        );
      if (p === '/api/worker/upload') {
        const prefix = verifyUploadToken(auth?.replace(/^Bearer\s+/i, '') ?? '', deps.secret);
        const key = String(req.headers['x-file-key'] ?? '');
        if (!prefix) return send(401, { error: 'unauthorized' });
        if (!key.startsWith(prefix)) return send(403, { error: 'forbidden' });
        return send(200, await deps.files.put(key, new Uint8Array(raw)));
      }
      const s = await workerSession(deps.db, auth);
      if (p === '/api/worker/heartbeat') return send(200, (await heartbeat(deps.db, s), { ok: true }));
      if (p === '/api/worker/progress') return send(200, (await reportProgress(deps.db, s, json()), { ok: true }));
      if (p === '/api/worker/status')
        return send(200, await reportStatus(deps.db, s, json(), { onFinished: deps.onFinished }));
      if (p === '/api/worker/guard') return send(200, await workerGuard(deps.db, s, json().host));
      if (p === '/api/worker/upload-token')
        return send(200, await issueWorkerUpload(deps.files, s, json().area === 'checkpoint' ? 'checkpoint' : 'audit'));
      if (p === '/api/worker/snapshot') return send(200, await latestSnapshot(deps.files, s));
      const m = p.match(/^\/api\/worker\/snapshot\/(\d+)\/([0-9a-f]{64})$/);
      if (m) {
        const got = await snapshotObject(deps.files, s, Number(m[1]), m[2]!);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from(await new Response(got.body).arrayBuffer()));
        return;
      }
      send(404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof CoreError) return send(err.status, { error: err.code, message: err.message });
      console.error(err);
      send(500, { error: 'internal' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A small site on 127.0.0.1; each page answers after `delayMs`, so a crawl takes a while. */
export async function startFixtureSite(opts: { pages?: number; delayMs?: number; redirectTo?: string } = {}) {
  const n = opts.pages ?? 6;
  const links = Array.from({ length: n }, (_, i) => `<li><a href="/page-${i}">Page ${i}</a></li>`).join('');
  const page = (title: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Fixture Site for Platform Tests</title><meta name="description" content="A fixture page used by the platform's slow tests to check the run path end to end."><meta name="viewport" content="width=device-width"></head><body><header><nav><ul>${links}</ul></nav></header><main><h1>${title}</h1><p>${'Words for the content checks. '.repeat(40)}</p></main></body></html>`;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const url = new URL(req.url ?? '/', 'http://x');
    if (opts.redirectTo && url.pathname === '/') {
      res.writeHead(301, { location: opts.redirectTo });
      res.end();
      return;
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: http://${req.headers.host}/sitemap.xml\n`);
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      const locs = ['/', ...Array.from({ length: n }, (_, i) => `/page-${i}`)]
        .map((p) => `<url><loc>http://${req.headers.host}${p}</loc></url>`)
        .join('');
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
      return;
    }
    const known = url.pathname === '/' || /^\/page-\d+$/.test(url.pathname);
    setTimeout(
      () => {
        res.writeHead(known ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(known ? (url.pathname === '/' ? 'Home' : url.pathname.slice(1)) : 'Not found'));
      },
      known ? (opts.delayMs ?? 0) : 0,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    /** Requests received so far. */
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
