/**
 * Sitemap URLs the crawl never reached (a `--limit` cut, or a sitemap on another host such as
 * www vs the bare domain) are checked directly: an even sample of up to 50, a HEAD/GET that
 * follows redirects through the SSRF guard, and a 404/410 confirmed by a second GET. Only those
 * confirmed answers count; blocked, 5xx and unreachable URLs stay "not crawled". Main audit only:
 * a lead scan has a fixed request budget.
 */

import { THRESHOLDS } from '../constants';
import { fetchWithTimeout } from '../utils';
import { isFetchAllowed } from '../../validators';
import { probeUrl, requestFollowing, runLimited, type SitemapMediaFetch } from './sitemap-media-probe';

export const SITEMAP_URL_PROBE_CAP = 50;

/** Up to `cap` URLs spread evenly over the list, so one dead section does not fill the sample. */
export function evenSample<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const step = items.length / cap;
  return Array.from({ length: cap }, (_, i) => items[Math.floor(i * step)]);
}

export interface SitemapUrlProbeResult {
  checked: number;
  /** URL → 404/410, confirmed by GET. */
  missing: Map<string, number>;
}

export async function probeUncrawledSitemapUrls(
  urls: string[],
  origin: string,
  fetchFn: SitemapMediaFetch = fetchWithTimeout,
): Promise<SitemapUrlProbeResult> {
  let originHost: string | undefined;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    originHost = undefined;
  }
  const allowed = urls.filter((u) => isFetchAllowed(u, { originHost }).allowed);
  const sample = evenSample(allowed, SITEMAP_URL_PROBE_CAP);
  const missing = new Map<string, number>();
  await runLimited(sample, THRESHOLDS.SITEMAP_MEDIA_PROBE_CONCURRENCY, async (url) => {
    const outcome = await probeUrl(url, originHost, fetchFn);
    if (outcome.kind !== '4xx' || (outcome.status !== 404 && outcome.status !== 410)) return;
    const confirm = await requestFollowing(url, 'GET', originHost, fetchFn).catch(() => undefined);
    if (confirm === 404 || confirm === 410) missing.set(url, confirm);
  });
  return { checked: sample.length, missing };
}
