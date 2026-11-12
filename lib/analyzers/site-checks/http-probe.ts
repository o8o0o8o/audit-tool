/**
 * Shared, injectable HTTP fetcher for the security probes in this folder
 * (JS secrets, open buckets, CORS, WordPress plugins, staging hosts). Every
 * request has a timeout and a capped body read; network errors and timeouts
 * resolve to `null` so callers can mark the check 'skipped' instead of
 * reporting a finding.
 */

export interface HttpProbeResponse {
  status: number;
  /** Final URL after redirects (same as the request URL with `redirect: 'manual'`). */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export interface HttpProbeOptions {
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual';
  maxBytes?: number;
  timeoutMs?: number;
}

export type HttpProbeFetcher = (url: string, opts?: HttpProbeOptions) => Promise<HttpProbeResponse | null>;

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body || maxBytes <= 0) {
    await res.body?.cancel().catch(() => undefined);
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - off);
    bytes.set(c.subarray(0, take), off);
    off += take;
    if (off >= bytes.length) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export const defaultHttpFetcher: HttpProbeFetcher = async (url, opts = {}) => {
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      redirect: opts.redirect ?? 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    return { status: res.status, url: res.url || url, headers, body };
  } catch {
    return null;
  }
};

/** Runs `fn` over `items` with at most `concurrency` in flight. */
export async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

export const looksHtml = (s: string) => /^\s*(?:<!doctype|<html|<head|<body)/i.test(s);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
