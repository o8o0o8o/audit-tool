/**
 * Requests a URL that cannot exist and checks the site answers 404/410.
 * A 200 means every mistyped or removed URL is indexable duplicate content;
 * a redirect (usually to the homepage) is treated by Google as a soft 404.
 */

import { randomBytes } from 'node:crypto';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import type { SiteProbeResult } from './site-checks-types';

export interface NotFoundResponse {
  status: number;
  location?: string | null;
}

export type NotFoundFetcher = (url: string) => Promise<NotFoundResponse | null>;

const defaultFetcher: NotFoundFetcher = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, location: res.headers.get('location') };
  } catch {
    return null;
  }
};

export function notFoundVerdict(probeUrl: string, res: NotFoundResponse | null): Issue | null {
  if (!res) return null;
  const link = `<a href="${probeUrl}">${probeUrl}</a>`;
  if (res.status >= 200 && res.status < 300) {
    return {
      message: 'Missing pages return HTTP 200 instead of 404',
      detail: `${link} does not exist but returned HTTP ${res.status}. Search engines treat such pages as soft 404s and may index them as duplicates. Return 404 (or 410) for unknown URLs.`,
      severity: SEVERITY.MEDIUM,
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      message: 'Missing pages redirect instead of returning 404',
      detail: `${link} does not exist but redirected (HTTP ${res.status}) to ${res.location ?? 'another URL'}. Redirecting unknown URLs (often to the homepage) is treated as a soft 404. Return 404 instead.`,
      severity: SEVERITY.LOW,
    };
  }
  if (res.status >= 500) {
    return {
      message: 'Missing pages return HTTP 5xx instead of 404',
      detail: `${link} does not exist but returned HTTP ${res.status}. A server error for unknown URLs wastes crawl budget and can slow crawling of the whole site.`,
      severity: SEVERITY.MEDIUM,
    };
  }
  return null;
}

/**
 * True when `location` only normalises `from` (trailing slash, http→https,
 * apex↔www, letter case) — the same resource, not a soft-404 redirect.
 */
export function isNormalizingRedirect(from: string, location: string | null | undefined): boolean {
  if (!location) return false;
  try {
    const a = new URL(from);
    const b = new URL(location, from);
    const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
    const path = (p: string) => p.toLowerCase().replace(/\/+$/, '');
    return host(a.hostname) === host(b.hostname) && path(a.pathname) === path(b.pathname) && a.search === b.search;
  } catch {
    return false;
  }
}

const MAX_NORMALIZING_HOPS = 3;

export class NotFoundProbe {
  static async probe(origin: string, fetcher: NotFoundFetcher = defaultFetcher): Promise<SiteProbeResult> {
    const probeUrl = `${origin.replace(/\/$/, '')}/seo-audit-missing-${randomBytes(6).toString('hex')}`;
    let res = await fetcher(probeUrl);
    // Follow canonicalising redirects (e.g. `/missing` → `/missing/`) and judge
    // where they land: a slash redirect followed by a 404 is correct behaviour.
    let current = probeUrl;
    for (let hop = 0; hop < MAX_NORMALIZING_HOPS && res && res.status >= 300 && res.status < 400; hop++) {
      if (!isNormalizingRedirect(current, res.location)) break;
      current = new URL(res.location as string, current).href;
      res = await fetcher(current);
    }
    const issue = notFoundVerdict(probeUrl, res);
    return {
      issues: issue ? [issue] : [],
      checks: [
        {
          id: 'not-found',
          label: 'Missing-page status',
          status: !res
            ? 'skipped'
            : issue
              ? issue.severity === SEVERITY.LOW
                ? 'warn'
                : 'fail'
              : res.status === 404 || res.status === 410
                ? 'pass'
                : 'warn',
          note: res ? `unknown URL returns HTTP ${res.status}` : 'request failed',
        },
      ],
    };
  }
}
