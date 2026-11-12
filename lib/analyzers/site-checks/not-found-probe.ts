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

export class NotFoundProbe {
  static async probe(origin: string, fetcher: NotFoundFetcher = defaultFetcher): Promise<SiteProbeResult> {
    const probeUrl = `${origin.replace(/\/$/, '')}/seo-audit-missing-${randomBytes(6).toString('hex')}`;
    const res = await fetcher(probeUrl);
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
