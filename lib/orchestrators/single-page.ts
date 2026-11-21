/**
 * Single-page audit (`--page=<url>`): the pure rules. The crawl itself lives in
 * `AuditOrchestrator`, the wiring in `SEOData`.
 */

import { RobotsParser } from '../parsers/robots-parser';
import { SEVERITY } from '../constants';
import { escapeHtml } from '../reports/html-utils';
import { normalizeUrlForComparison } from '../utils';

/** What `metadata.json` records about a single-page audit; the report reads it to label the run. */
export interface SinglePageInfo {
  /** The URL that was asked for. */
  url: string;
  /** Where it landed after same-site redirects, when that differs. */
  finalUrl?: string;
  /** Whether the page (or its final URL) is listed in a sitemap; null when no sitemap was found. */
  inSitemap?: boolean | null;
}

/**
 * Site-wide validators that compare pages with each other, or read the link graph. On one page
 * they either say nothing or say something false ("no page links here" because nothing else was
 * crawled), so a single-page audit skips them.
 */
export const MULTI_PAGE_VALIDATORS: ReadonlySet<string> = new Set([
  'Duplicate Content',
  'Link Structure',
  'Link Depth & Architecture',
  'Keyword Cannibalisation',
  'Pagination SEO (Site-Wide)',
  'Broken Pagination (Site-Wide)',
  'Crawl Budget (Site-Wide)',
  'Content Similarity',
  'Internal PageRank',
  // Data-storing validators (`#runDataStoringValidators`)
  'DNS & IPv6',
  'Page Segments',
  'Content Gap',
  'Linking Opportunities',
  'Favicon & Web Manifest (Site-Wide)',
]);

type RobotsRules = Parameters<typeof RobotsParser.isPathAllowed>[2];

/** HIGH finding when robots.txt keeps Google (or every crawler) away from the page. */
export function robotsBlockedPageFinding(
  pageUrl: string,
  robots: { userAgents?: Record<string, unknown> } | null | undefined,
): { message: string; detail: string; severity: string } | null {
  const userAgents = robots?.userAgents;
  if (!userAgents || Object.keys(userAgents).length === 0) return null;
  let target: URL;
  try {
    target = new URL(pageUrl);
  } catch {
    return null;
  }
  const path = `${target.pathname}${target.search}`;
  const rules = { userAgents } as unknown as RobotsRules;
  const googleAgent = Object.keys(userAgents).find((ua) => ua.toLowerCase() === 'googlebot') ?? 'Googlebot';
  if (RobotsParser.isPathAllowed(path, googleAgent, rules)) return null;
  const escaped = escapeHtml(pageUrl);
  return {
    message: 'Page is blocked by robots.txt',
    detail: `robots.txt disallows <a href="${escaped}">${escaped}</a> for Googlebot, so search engines will not crawl it.`,
    severity: SEVERITY.HIGH,
  };
}

/**
 * The sitemap entries a single-page audit keeps: only the page's own (requested or final URL),
 * so the site-wide checks do not report every other sitemap URL as "not crawled".
 */
export function keepSinglePageSitemapEntries<T>(
  sitemapUrls: Record<string, T>,
  pageUrls: string[],
): { kept: Record<string, T>; inSitemap: boolean | null } {
  const all = Object.keys(sitemapUrls);
  const wanted = new Set(pageUrls.map((u) => normalizeUrlForComparison(u)));
  const kept: Record<string, T> = {};
  for (const url of all) {
    if (wanted.has(normalizeUrlForComparison(url))) kept[url] = sitemapUrls[url];
  }
  return { kept, inSitemap: all.length === 0 ? null : Object.keys(kept).length > 0 };
}
