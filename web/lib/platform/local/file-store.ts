import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { signToken, verifyToken } from '../../core/tokens';
import type { FileStore } from '../types';

/** Disk-backed FileStore: the key is the path relative to `root`. */
export class LocalFileStore implements FileStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly opts: { appUrl: string; secret: string; now?: () => number },
  ) {
    this.root = path.resolve(root);
  }

  /** Absolute path for a key; throws for a key that would leave the root. */
  resolve(key: string): string {
    if (!key || key.includes('\0') || path.isAbsolute(key) || key.split(/[\\/]/).includes('..')) {
      throw new Error(`invalid file key: ${JSON.stringify(key)}`);
    }
    const abs = path.resolve(this.root, key);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`invalid file key: ${JSON.stringify(key)}`);
    return abs;
  }

  async put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: { contentType?: string }) {
    const abs = this.resolve(key);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, abs);
    if (opts?.contentType) await writeFile(`${abs}.meta.json`, JSON.stringify({ contentType: opts.contentType }));
    else await rm(`${abs}.meta.json`, { force: true });
    return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string) {
    const abs = this.resolve(key);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return null;
    const meta = await readFile(`${abs}.meta.json`, 'utf8').then(
      (s) => JSON.parse(s) as { contentType?: string },
      () => ({}) as { contentType?: string },
    );
    return {
      body: Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>,
      bytes: info.size,
      ...(meta.contentType ? { contentType: meta.contentType } : {}),
    };
  }

  async *list(prefix: string): AsyncIterable<{ key: string; bytes: number }> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true }).catch(() => []);
    const keys = entries
      .filter((e) => e.isFile() && !e.name.endsWith('.meta.json') && !e.name.endsWith('.tmp'))
      .map((e) => path.relative(this.root, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
      .filter((k) => k.startsWith(prefix))
      .sort();
    for (const key of keys) yield { key, bytes: (await stat(path.join(this.root, key))).size };
  }

  async delete(keys: string[]) {
    for (const key of keys) {
      const abs = this.resolve(key);
      await rm(abs, { force: true });
      await rm(`${abs}.meta.json`, { force: true });
    }
  }

  async issueUpload(prefix: string, ttlSeconds: number) {
    this.resolve(`${prefix.replace(/\/+$/, '')}/x`); // refuse a prefix that leaves the root
    const token = signUploadToken({ prefix }, this.opts.secret, ttlSeconds, this.now());
    return { url: `${this.opts.appUrl}/api/worker/upload`, headers: { authorization: `Bearer ${token}` } };
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}

export function signUploadToken(
  claims: { prefix: string },
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  return signToken('upload', claims, secret, ttlSeconds, nowMs);
}

/** Returns the prefix the token allows, or null when it is altered or expired. */
export function verifyUploadToken(token: string, secret: string, nowMs = Date.now()): string | null {
  return verifyToken<{ prefix: string }>('upload', token, secret, nowMs)?.prefix ?? null;
}
