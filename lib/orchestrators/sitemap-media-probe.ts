/**
 * Sitemap media load probe — checks that image/video URLs listed in the
 * sitemap's image/video extensions actually load. Main audit only: the
 * competitor crawl reuses parseSitemaps() and must never probe.
 */

import { SEVERITY, THRESHOLDS } from '../constants';
import type { SitemapMediaTargets } from '../types';
import { fetchWithTimeout } from '../utils';
import { isFetchAllowed } from '../../validators';

export type SitemapMediaFetch = (url: string, timeout: number, options?: RequestInit) => Promise<Response>;
type SaveError = (message: string, detail: string, severity: string) => void;

type MediaKind = 'image' | 'video';
type Outcome = { kind: 'ok' } | { kind: 'blocked' } | { kind: '4xx' | '5xx'; status: number } | { kind: 'unreachable' };
type FailureBucket = '4xx' | '5xx' | 'unreachable';

const MAX_REDIRECTS = 5;
const EXAMPLE_LIMIT = 5;
const BLOCKED_STATUSES = new Set([401, 403, 429]);
const HEAD_UNSUPPORTED = new Set([405, 501]);

export const SITEMAP_MEDIA_PROBE_TITLES: Record<MediaKind, string> = {
  image: 'Sitemap image URLs fail to load',
  video: 'Sitemap video URLs fail to load',
};

const BUCKET_SEVERITY: Record<FailureBucket, string> = {
  '4xx': SEVERITY.MEDIUM,
  '5xx': SEVERITY.MEDIUM,
  unreachable: SEVERITY.LOW,
};

/** Follows redirects by hand so every hop passes the SSRF guard; returns the final status. */
async function requestFollowing(
  url: string,
  method: 'HEAD' | 'GET',
  originHost: string | undefined,
  fetchFn: SitemapMediaFetch,
): Promise<number> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(current, THRESHOLDS.SITEMAP_MEDIA_PROBE_TIMEOUT, { method, redirect: 'manual' });
    if (method === 'GET') await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response.status;
    current = new URL(location, current).href;
    if (!isFetchAllowed(current, { originHost }).allowed) throw new Error(`redirect to blocked URL ${current}`);
  }
  throw new Error('too many redirects');
}

async function probeOnce(url: string, originHost: string | undefined, fetchFn: SitemapMediaFetch): Promise<number> {
  try {
    const status = await requestFollowing(url, 'HEAD', originHost, fetchFn);
    if (!HEAD_UNSUPPORTED.has(status)) return status;
  } catch {
    // Some CDNs drop HEAD outright; GET below decides.
  }
  return requestFollowing(url, 'GET', originHost, fetchFn);
}

async function probeUrl(url: string, originHost: string | undefined, fetchFn: SitemapMediaFetch): Promise<Outcome> {
  let status: number | undefined;
  for (let attempt = 0; attempt < 2 && status === undefined; attempt++) {
    status = await probeOnce(url, originHost, fetchFn).catch(() => undefined);
  }
  if (status === undefined) return { kind: 'unreachable' };
  if (BLOCKED_STATUSES.has(status)) return { kind: 'blocked' };
  if (status >= 500) return { kind: '5xx', status };
  if (status >= 400) return { kind: '4xx', status };
  return { kind: 'ok' };
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Probe the image/video URLs collected from the sitemap and report the ones
 * that fail to load, one finding per media kind per status bucket.
 * Redirects are followed (normal on CDNs); 401/403/429 count as blocked, not failed.
 */
export async function probeSitemapMedia(
  media: Record<string, SitemapMediaTargets> | undefined,
  origin: string,
  saveError: SaveError,
  fetchFn: SitemapMediaFetch = fetchWithTimeout,
): Promise<void> {
  const originHost = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return undefined;
    }
  })();

  const kindByUrl = new Map<string, MediaKind>();
  for (const targets of Object.values(media ?? {})) {
    for (const url of targets.images) if (!kindByUrl.has(url)) kindByUrl.set(url, 'image');
    for (const url of targets.videos) if (!kindByUrl.has(url)) kindByUrl.set(url, 'video');
  }
  const allowed = [...kindByUrl.keys()].filter((url) => isFetchAllowed(url, { originHost }).allowed);
  if (!allowed.length) return;
  const checked = allowed.slice(0, THRESHOLDS.SITEMAP_MEDIA_PROBE_CAP);

  const failures = new Map<string, string[]>();
  const blocked: Record<MediaKind, number> = { image: 0, video: 0 };
  await runLimited(checked, THRESHOLDS.SITEMAP_MEDIA_PROBE_CONCURRENCY, async (url) => {
    const kind = kindByUrl.get(url) ?? 'image';
    const outcome = await probeUrl(url, originHost, fetchFn);
    if (outcome.kind === 'ok') return;
    if (outcome.kind === 'blocked') {
      blocked[kind]++;
      return;
    }
    const key = `${kind}|${outcome.kind}`;
    const label = outcome.kind === 'unreachable' ? url : `${url} (HTTP ${outcome.status})`;
    failures.set(key, [...(failures.get(key) ?? []), label]);
  });

  for (const [key, examples] of failures) {
    const [kind, bucket] = key.split('|') as [MediaKind, FailureBucket];
    const shown = examples.slice(0, EXAMPLE_LIMIT).join('; ');
    const more = examples.length > EXAMPLE_LIMIT ? ` (+${examples.length - EXAMPLE_LIMIT} more)` : '';
    const blockedNote = blocked[kind] ? `; ${blocked[kind]} blocked by bot/hotlink protection (401/403/429)` : '';
    saveError(
      SITEMAP_MEDIA_PROBE_TITLES[kind],
      `${examples.length} ${kind} URL(s) ${bucket === 'unreachable' ? 'unreachable' : `returned ${bucket}`} ` +
        `(checked ${checked.length} of ${allowed.length}${blockedNote}). Examples: ${shown}${more}`,
      BUCKET_SEVERITY[bucket],
    );
  }
}
