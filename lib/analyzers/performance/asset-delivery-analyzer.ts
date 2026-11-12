/**
 * Asset delivery: redirected assets, long-cached assets without cache-busting,
 * duplicate JavaScript libraries, and (site level) a CDN that never caches the
 * HTML documents.
 *
 * Input is the crawler's request log. Fields beyond the current RequestInfo
 * (`headers`, `count`) are optional: the checks that need them are skipped
 * when they are absent.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';
import { libraryFromUrl } from '../security/js-library-analyzer';

export const REDIRECTED_ASSETS_MESSAGE = 'Assets are served through redirects';
export const NO_CACHE_BUSTING_MESSAGE = 'Long-cached assets without cache-busting';
export const DUPLICATE_LIBRARY_MESSAGE = 'Same JavaScript library loaded more than once';
export const CDN_HTML_MISS_MESSAGE = 'CDN does not cache HTML pages';

export interface AssetRequestInfo {
  resourceType?: string;
  method?: string;
  status?: number;
  /** Lower-cased response header map (needed for check b and the CDN classifier). */
  headers?: Record<string, string>;
  /** How many times this exact URL was requested on the page (needed for exact-duplicate detection). */
  count?: number;
}

const ASSET_TYPES = new Set(['script', 'stylesheet', 'image', 'font']);
const SEVEN_DAYS = 7 * 24 * 3600;

const examples = (urls: string[]) =>
  urls
    .slice(0, 5)
    .map((u) => escapeHtml(u.length > 120 ? `${u.slice(0, 117)}...` : u))
    .join(', ');

function header(h: Record<string, string> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  if (name in h) return h[name];
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : undefined;
}

/** True when the URL carries a content hash or version (path or query). */
export function hasCacheBuster(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true; // unknown → don't flag
  }
  if (/[?&](v|ver|version|rev|hash|h|build|t|ts|cb|_)=[^&]+/i.test(u.search)) return true;
  if (u.search.length > 1 && /^\?[a-f0-9]{6,}$/i.test(u.search)) return true;
  const path = u.pathname;
  // hash segment: app.3f9a1c2b.js, main-AB12cd34.css, chunk_9f8e7d6c5b.js, /_next/static/<buildId>/
  if (/[.\-_~][a-zA-Z0-9]{8,}\.(?:m?js|css)$/.test(path) && /\d/.test(path.split('/').pop() ?? '')) return true;
  if (/\/[a-f0-9]{8,}\//i.test(path)) return true;
  // version: jquery-3.6.0.min.js, /v2.1/, @1.2.3
  if (/(?:^|[\-.@/_v])\d+\.\d+(?:\.\d+)?(?:[.\-/]|$)/.test(path)) return true;
  return false;
}

function maxAge(cacheControl: string | undefined): number | null {
  if (!cacheControl || /no-store|no-cache/i.test(cacheControl)) return null;
  const m = /\bmax-age\s*=\s*(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) : null;
}

/** Pure per-page checks (a)-(c). `pageUrl` is excluded from asset checks. */
export function assetDeliveryIssues(requests: Record<string, AssetRequestInfo>, pageUrl?: string): Issue[] {
  const issues: Issue[] = [];
  const entries = Object.entries(requests).filter(([u]) => u !== pageUrl && /^https?:/i.test(u));

  // (a) redirected assets: the redirect hop is logged under its own URL with a 3xx status.
  const redirected = entries
    .filter(
      ([, r]) =>
        ASSET_TYPES.has(r.resourceType ?? '') && (r.status ?? 0) >= 300 && (r.status ?? 0) < 400 && r.status !== 304,
    )
    .map(([u]) => u);
  if (redirected.length > 0) {
    issues.push({
      message: REDIRECTED_ASSETS_MESSAGE,
      detail: `${redirected.length} script, stylesheet, image or font request(s) answered with a redirect before the real file: ${examples(redirected)}. Each redirect adds a round trip before the asset can load. Reference the final URL directly.`,
      severity: SEVERITY.LOW,
    });
  }

  // (b) long max-age without a hash/version in the URL
  const stale = entries
    .filter(([u, r]) => {
      if (r.resourceType !== 'script' && r.resourceType !== 'stylesheet') return false;
      if ((r.status ?? 0) < 200 || (r.status ?? 0) >= 300) return false;
      const age = maxAge(header(r.headers, 'cache-control'));
      return age !== null && age >= SEVEN_DAYS && !hasCacheBuster(u);
    })
    .map(([u]) => u);
  if (stale.length > 0) {
    issues.push({
      message: NO_CACHE_BUSTING_MESSAGE,
      detail: `${stale.length} script/stylesheet file(s) are cached for 7 days or more but their URL has no content hash or version: ${examples(stale)}. After a deploy, returning visitors can keep running the old file (or a mix of old and new files) until the cache expires. Add a content hash or version to the file name or query string, or shorten max-age.`,
      severity: SEVERITY.MEDIUM,
    });
  }

  // (c) duplicate libraries
  const dupes: string[] = [];
  const byLib = new Map<string, Set<string>>();
  for (const [u, r] of entries) {
    if (r.resourceType !== 'script') continue;
    if ((r.count ?? 1) > 1) dupes.push(`${escapeHtml(u)} requested ${r.count} times`);
    const lib = libraryFromUrl(u);
    if (lib) {
      const set = byLib.get(lib.lib) ?? new Set<string>();
      set.add(u);
      byLib.set(lib.lib, set);
    }
  }
  for (const [lib, urls] of byLib) {
    if (urls.size > 1) {
      const versions = [...urls].map((u) => libraryFromUrl(u)?.version ?? '?');
      dupes.push(
        `${escapeHtml(lib)} from ${urls.size} URLs (versions ${[...new Set(versions)].join(', ')}): ${examples([...urls])}`,
      );
    }
  }
  if (dupes.length > 0) {
    issues.push({
      message: DUPLICATE_LIBRARY_MESSAGE,
      detail: `${dupes.slice(0, 5).join('; ')}. Loading a library twice wastes bandwidth and parse time, and two versions on one page can override each other's globals and break plugins. Load one copy from one URL.`,
      severity: SEVERITY.MEDIUM,
    });
  }
  return issues;
}

export type CdnCacheState = 'hit' | 'miss' | 'none';

/** Pure: classify the HTML document's CDN cache status from its response headers. */
export function classifyCdnCache(headers: Record<string, string> | undefined): CdnCacheState {
  if (!headers) return 'none';
  const h = (n: string) => header(headers, n)?.toLowerCase();
  const states: string[] = [];
  const cf = h('cf-cache-status');
  if (cf) states.push(cf);
  const vercel = h('x-vercel-cache');
  if (vercel) states.push(vercel);
  for (const n of ['x-cache', 'x-cache-status', 'cdn-cache', 'x-proxy-cache', 'x-fastly-cache', 'cache-status']) {
    const v = h(n);
    if (v) states.push(v);
  }
  const akamai = h('x-akamai-cache-status') ?? h('x-check-cacheable');
  if (akamai) states.push(akamai);
  const cdnPresent =
    states.length > 0 || !!h('x-served-by') || !!h('x-nf-request-id') || !!h('x-amz-cf-id') || !!h('akamai-grn');
  if (!cdnPresent) return 'none';
  const text = states.join(' ');
  if (/\b(hit|stale|revalidated|updating)\b|fwd=(?:hit|stale)|;\s*hit\b/.test(text)) return 'hit';
  if (/\b(miss|bypass|dynamic|expired|pass)\b|fwd=(?:uri-)?miss/.test(text)) return 'miss';
  // Netlify / Fastly without an explicit status: a positive Age means it came from cache.
  const age = Number(h('age'));
  if (Number.isFinite(age) && age > 0) return 'hit';
  return 'none'; // CDN seen but cache state unknown: don't guess
}

/** Pure site-level reducer over per-page classifications. */
export function cdnHtmlCacheIssues(states: CdnCacheState[]): Issue[] {
  const cdnPages = states.filter((s) => s !== 'none');
  const misses = cdnPages.filter((s) => s === 'miss').length;
  if (cdnPages.length < 5 || misses / cdnPages.length < 0.8) return [];
  return [
    {
      message: CDN_HTML_MISS_MESSAGE,
      detail: `${misses} of ${cdnPages.length} HTML pages served through a CDN were cache misses or bypasses (cf-cache-status / x-cache / x-vercel-cache and similar headers). This is deliberate for personalised or logged-in pages; otherwise every visitor waits for the origin server, which raises TTFB. Allow the CDN to cache public HTML (Cache-Control s-maxage, stale-while-revalidate or a cache rule).`,
      severity: SEVERITY.LOW,
    },
  ];
}

export class AssetDeliveryAnalyzer {
  static analyze(
    requests: Record<string, AssetRequestInfo>,
    pageUrl: string,
    documentHeaders?: Record<string, string>,
  ) {
    let issues: Issue[];
    try {
      issues = assetDeliveryIssues(requests, pageUrl);
    } catch {
      issues = [];
    }
    return {
      issues,
      warnings: [] as Issue[],
      info: { cdnCache: classifyCdnCache(documentHeaders) },
    };
  }
}
