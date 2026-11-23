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

/** How the app proves itself to the store: a read-write token, or the store's id with Vercel's OIDC token. */
export type BlobAuth = { token: string } | { storeId: string };

/**
 * FileStore on a private Vercel Blob store. The app reads and writes either with the store's
 * read-write token or, for a store connected to the Vercel project, with the store id and the OIDC
 * token Vercel gives each function (the SDK finds that token itself). A worker never gets either:
 * for each file it asks the app (`/api/worker/upload-url`), and the app answers with a presigned URL
 * for that one pathname.
 */
export class BlobFileStore implements FileStore {
  private delegation: { clientSigningToken: string; delegationToken: string; validUntil: number } | null = null;
  private readonly auth: BlobAuth;
  readonly storeId: string;

  constructor(private readonly opts: BlobAuth & { appUrl: string; api?: BlobApi; now?: () => number }) {
    if ('token' in opts && opts.token) {
      this.auth = { token: opts.token };
      this.storeId = storeIdOf(opts.token);
    } else if ('storeId' in opts && opts.storeId) {
      this.storeId = opts.storeId.replace(/^store_/, '');
      if (!/^[A-Za-z0-9]+$/.test(this.storeId)) throw new Error('the Blob store id is not valid');
      this.auth = { storeId: this.storeId };
    } else throw new Error('a Blob token or store id is needed');
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
      ...this.auth,
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
      ...this.auth,
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
      const page = await this.api.list({ prefix, cursor, limit: 1000, ...this.auth });
      for (const b of page.blobs) yield { key: b.pathname, bytes: b.size };
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  async delete(keys: string[]) {
    for (const key of keys) checkKey(key);
    for (let i = 0; i < keys.length; i += 500) {
      await this.api.del(keys.slice(i, i + 500), { ...this.auth });
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
        ...this.auth,
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
        'x-vercel-blob-store-id': this.storeId,
        'x-vercel-blob-access': 'private',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-content-type': contentType ?? 'application/octet-stream',
      },
    };
  }
}
