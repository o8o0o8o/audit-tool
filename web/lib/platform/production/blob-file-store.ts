import { createHash } from 'node:crypto';
import { del, get, issueSignedToken, list, presignUrl, put } from '@vercel/blob';
import type { FileStore, PresignedUpload } from '../types';

/** The part of `@vercel/blob` the store uses; tests pass a stand-in. */
export interface BlobApi {
  put: typeof put;
  get: typeof get;
  list: typeof list;
  del: typeof del;
  issueSignedToken: typeof issueSignedToken;
  presignUrl: typeof presignUrl;
}

const SDK: BlobApi = { put, get, list, del, issueSignedToken, presignUrl };

/** `x-api-version` of the Blob API the presigned upload is written for (`@vercel/blob` 2.8). */
const BLOB_API_VERSION = '12';
/** A store-wide upload delegation is reused until it has less than this left. */
const DELEGATION_MARGIN_MS = 10 * 60_000;
const DELEGATION_TTL_MS = 60 * 60_000;

/**
 * Keys that are written once: an attempt's files and rendered reports. Everything else (cron
 * markers, snapshot manifests) is overwritten, so it is read past the CDN cache.
 */
const IMMUTABLE = /^(audits|renders)\//;

function checkKey(key: string): string {
  if (!key || key.includes('\0') || key.startsWith('/') || key.split(/[\\/]/).includes('..')) {
    throw new Error(`invalid file key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Store id from a read-write token (`vercel_blob_rw_<storeId>_<secret>`). */
export function storeIdOf(token: string): string {
  const id = token.split('_')[3];
  if (!id) throw new Error('the Blob token has no store id');
  return id;
}

/**
 * FileStore on a private Vercel Blob store. The app reads and writes with the store's read-write
 * token. A worker never gets that token: for each file it asks the app (`/api/worker/upload-url`),
 * and the app answers with a presigned URL for that one pathname.
 */
export class BlobFileStore implements FileStore {
  private delegation: { clientSigningToken: string; delegationToken: string; validUntil: number } | null = null;

  constructor(private readonly opts: { token: string; appUrl: string; api?: BlobApi; now?: () => number }) {
    storeIdOf(opts.token);
  }

  private get api(): BlobApi {
    return this.opts.api ?? SDK;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: { contentType?: string }) {
    checkKey(key);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    await this.api.put(key, Buffer.from(bytes), {
      access: 'private',
      token: this.opts.token,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: opts?.contentType ?? 'application/octet-stream',
      ...(IMMUTABLE.test(key) ? {} : { cacheControlMaxAge: 60 }),
    });
    return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async get(key: string) {
    checkKey(key);
    const got = await this.api.get(key, {
      access: 'private',
      token: this.opts.token,
      useCache: IMMUTABLE.test(key),
    });
    if (!got || got.statusCode !== 200) return null;
    const type = got.blob.contentType;
    return {
      body: got.stream,
      bytes: got.blob.size,
      ...(type && type !== 'application/octet-stream' ? { contentType: type } : {}),
    };
  }

  async *list(prefix: string): AsyncIterable<{ key: string; bytes: number }> {
    let cursor: string | undefined;
    do {
      const page = await this.api.list({ prefix, cursor, limit: 1000, token: this.opts.token });
      for (const b of page.blobs) yield { key: b.pathname, bytes: b.size };
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  async delete(keys: string[]) {
    for (const key of keys) checkKey(key);
    for (let i = 0; i < keys.length; i += 500) {
      await this.api.del(keys.slice(i, i + 500), { token: this.opts.token });
    }
  }

  /** The worker asks the app for a URL per file; the app checks the key against the session's prefix. */
  async issueUpload(prefix: string, _ttlSeconds: number) {
    checkKey(`${prefix.replace(/\/+$/, '')}/x`);
    return { url: `${this.opts.appUrl}/api/worker/upload-url`, headers: {} };
  }

  async presignUpload(key: string, ttlSeconds: number, contentType?: string): Promise<PresignedUpload> {
    checkKey(key);
    const now = this.now();
    if (!this.delegation || this.delegation.validUntil - now < DELEGATION_MARGIN_MS) {
      this.delegation = await this.api.issueSignedToken({
        token: this.opts.token,
        pathname: '*',
        operations: ['put'],
        validUntil: now + DELEGATION_TTL_MS,
      });
    }
    const validUntil = Math.min(now + ttlSeconds * 1000, this.delegation.validUntil);
    const { presignedUrl } = await this.api.presignUrl(this.delegation, {
      operation: 'put',
      access: 'private',
      pathname: key,
      validUntil,
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    return {
      method: 'PUT',
      url: presignedUrl,
      headers: {
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-store-id': storeIdOf(this.opts.token),
        'x-vercel-blob-access': 'private',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-content-type': contentType ?? 'application/octet-stream',
      },
    };
  }
}
