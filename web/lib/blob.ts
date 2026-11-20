// Run files are uploaded as public blobs without a random suffix, so each one's URL is known
// from its pathname. Building it here replaces `list()` lookups, which Vercel bills as
// advanced operations, with a plain read.

const RUN_ID_STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

/** Store id from the read-write token (`vercel_blob_rw_<storeId>_<secret>`) or `BLOB_STORE_ID`. */
export function blobStoreId(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token) {
    const storeId = token.split('_')[3];
    if (storeId) return storeId;
  }
  const storeId = env.BLOB_STORE_ID?.trim();
  if (!storeId) return null;
  return storeId.startsWith('store_') ? storeId.slice('store_'.length) : storeId;
}

export function publicBlobUrl(pathname: string, env?: Record<string, string | undefined>): string {
  const storeId = blobStoreId(env);
  if (!storeId) throw new Error('No Blob store configured (BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID)');
  return `https://${storeId}.public.blob.vercel-storage.com/${pathname}`;
}

/**
 * Reads a public blob. `fresh` adds a query string so the Blob CDN cannot answer with an older
 * copy (status/progress are overwritten during a run). Returns null when the blob does not exist.
 */
export async function fetchBlob(pathname: string, { fresh = false } = {}): Promise<Response | null> {
  const url = publicBlobUrl(pathname);
  const res = await fetch(fresh ? `${url}?t=${Date.now()}` : url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`blob read failed: ${res.status} ${pathname}`);
  return res;
}

/** Start time encoded in a run id (`YYYYMMDD-HHMMSS-xxxxxx`, UTC), or null for other ids. */
export function runIdStartedAt(runId: string): Date | null {
  const m = RUN_ID_STAMP.exec(runId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}
