/**
 * Locale redirect probe: requests the homepage (no cookies, redirects not
 * followed) with several Accept-Language values and with none. When the
 * redirect target depends on the language header, crawlers — which mostly
 * fetch without Accept-Language from US IPs — only ever see one locale.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { BROWSER_UA, defaultRawFetcher, type RawFetcher } from './bot-parity-probe';
import type { SiteProbeResult } from './site-checks-types';

/** `null` = request sent without an Accept-Language header. */
export const LOCALE_VARIANTS: (string | null)[] = ['en-US', 'de-DE', 'fr-FR', 'ja-JP', null];

export interface LocaleVariantResult {
  acceptLanguage: string | null;
  status: number;
  /** Absolute redirect target, or null when the homepage did not redirect. */
  target: string | null;
}

const label = (v: string | null) => v ?? 'no Accept-Language';

/** Pure verdict from the per-language results (failed requests already dropped). */
export function localeRedirectVerdict(homeUrl: string, results: LocaleVariantResult[]): Issue | null {
  if (results.length < 2) return null;
  const targets = new Set(results.map((r) => r.target ?? ''));
  if (targets.size < 2) return null;
  const rows = results
    .map(
      (r) =>
        `${escapeHtml(label(r.acceptLanguage))} → ${r.target ? escapeHtml(r.target) : `no redirect (HTTP ${r.status})`}`,
    )
    .join('; ');
  return {
    message: 'Homepage redirects by browser language',
    detail: `${escapeHtml(homeUrl)} sends visitors to different URLs depending on the Accept-Language header: ${rows}. Googlebot mostly crawls without Accept-Language from US IP addresses, so the other language versions may never be discovered or may be treated as duplicates. Instead of redirecting, show a language suggestion banner or link, and declare every version with hreflang.`,
    severity: SEVERITY.MEDIUM,
  };
}

export class LocaleRedirectProbe {
  static async probe(origin: string, fetcher: RawFetcher = defaultRawFetcher): Promise<SiteProbeResult> {
    const home = `${origin.replace(/\/$/, '')}/`;
    const results: LocaleVariantResult[] = [];
    for (const lang of LOCALE_VARIANTS) {
      const headers: Record<string, string> = { 'User-Agent': BROWSER_UA, Accept: 'text/html' };
      if (lang) headers['Accept-Language'] = `${lang},${lang.split('-')[0]};q=0.9`;
      const res = await fetcher(home, headers);
      if (!res) continue; // network failure: no finding from this variant
      let target: string | null = null;
      if (res.status >= 300 && res.status < 400 && res.location) {
        try {
          target = new URL(res.location, home).href;
        } catch {
          target = res.location;
        }
      }
      results.push({ acceptLanguage: lang, status: res.status, target });
    }
    const issue = localeRedirectVerdict(home, results);
    return {
      issues: issue ? [issue] : [],
      checks: [
        {
          id: 'locale-redirect',
          label: 'Language-based homepage redirect',
          status: results.length < 2 ? 'skipped' : issue ? 'fail' : 'pass',
          note:
            results.length < 2
              ? 'requests failed'
              : issue
                ? 'redirect target depends on Accept-Language'
                : 'same response for every Accept-Language',
        },
      ],
    };
  }
}
