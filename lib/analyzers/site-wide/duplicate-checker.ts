import { SEVERITY } from '../../constants';
import { formatUrlList, escapeHtml, truncateText, normalizeUrlForComparison, basePathForComparison } from '../../utils';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Duplicate Checker
 * Analyzes all pages to detect duplicate titles and meta descriptions.
 */
class DuplicateChecker {
  /**
   * Check for duplicate titles and descriptions across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { duplicateTitles: Map, duplicateDescriptions: Map, issues: [] }
   */
  static checkDuplicates(allPages: Record<string, PageInfo>) {
    console.log('\nChecking for duplicate titles and descriptions...');

    const titleMap: Record<string, string[]> = {}; // title -> array of URLs
    const descriptionMap: Record<string, string[]> = {}; // description -> array of URLs
    const issues: Issue[] = [];
    // Per-value sets of already-counted URLs (normalized), so a page that the
    // crawl reached under both its slash and no-slash form — `/x` and `/x/`,
    // when NEITHER redirects (both serve 200) — is counted once. Without this,
    // a single page (e.g. the homepage `https://site.com` vs `https://site.com/`)
    // is reported as a "duplicate title" of itself: a false positive that also
    // inflates every duplicate finding's occurrence count.
    const titleSeen: Record<string, Set<string>> = {};
    const descriptionSeen: Record<string, Set<string>> = {};

    // Build maps of titles and descriptions
    for (const url in allPages) {
      const page = allPages[url];

      // Skip redirect sources: a URL that redirected (e.g. the no-slash
      // `/x` → `/x/`, or an old path → new path) was followed to its final
      // page, so its title/description are the DESTINATION's, not a second
      // distinct page. Counting it would report the destination's own title as
      // a "duplicate" of itself — the classic trailing-slash twin inflation.
      // The redirect itself is already surfaced as a per-page redirect finding.
      if (page.hasRedirects) continue;

      const normUrl = normalizeUrlForComparison(url);

      // Track titles (skip empty ones as they're already reported)
      if (page.title?.trim()) {
        const title = page.title.trim();
        const seen = (titleSeen[title] ??= new Set());
        if (!seen.has(normUrl)) {
          seen.add(normUrl);
          (titleMap[title] ??= []).push(url);
        }
      }

      // Track descriptions (skip empty ones as they're already reported)
      if (page.description?.trim()) {
        const description = page.description.trim();
        const seen = (descriptionSeen[description] ??= new Set());
        if (!seen.has(normUrl)) {
          seen.add(normUrl);
          (descriptionMap[description] ??= []).push(url);
        }
      }
    }

    // Find and report duplicate titles. Genuine cross-page duplicates and
    // same-page parameterized variants get distinct findings (see emitDuplicateIssues).
    const duplicateTitles = new Map<string, string[]>();
    const duplicateTitleCount = DuplicateChecker.emitDuplicateIssues(titleMap, duplicateTitles, issues, {
      noun: 'title',
      crossPathMessage: 'Duplicate page titles found',
      paramMessage: 'Parameterized URLs share a title',
      format: (title) => escapeHtml(title),
    });

    // Find and report duplicate descriptions (same split as titles).
    const duplicateDescriptions = new Map<string, string[]>();
    const duplicateDescriptionCount = DuplicateChecker.emitDuplicateIssues(descriptionMap, duplicateDescriptions, issues, {
      noun: 'description',
      crossPathMessage: 'Duplicate meta descriptions found',
      paramMessage: 'Parameterized URLs share a description',
      format: (description) => escapeHtml(truncateText(description, 100)),
    });

    if (duplicateTitleCount > 0) {
      console.log(`Found ${duplicateTitleCount} duplicate titles`);
    }
    if (duplicateDescriptionCount > 0) {
      console.log(`Found ${duplicateDescriptionCount} duplicate descriptions`);
    }
    if (duplicateTitleCount === 0 && duplicateDescriptionCount === 0) {
      console.log('No duplicate titles or descriptions found');
    }

    return {
      duplicateTitles,
      duplicateDescriptions,
      issues,
    };
  }

  /**
   * Partition the URLs that share one title/description value into:
   *  - `paramGroups`: clusters of ≥2 URLs that collapse to a single base path
   *    (the same page seen through different query strings — faceted/sort/
   *    pagination params). Their SEO remedy is canonicalize-to-base or noindex,
   *    NOT a unique title.
   *  - `crossPathReps`: one representative URL per distinct base path. When ≥2
   *    distinct base paths share the value, those are GENUINE cross-page
   *    duplicates (two different pages with the same title).
   *
   * A single value can yield both (e.g. `/a`, `/a?x=1`, `/b` → param group
   * [`/a`, `/a?x=1`] plus cross-path reps [`/a`, `/b`]).
   */
  private static partitionByBasePath(urls: string[]): {
    paramGroups: string[][];
    crossPathReps: string[];
  } {
    const byBase = new Map<string, string[]>();
    for (const u of urls) {
      const base = basePathForComparison(u);
      const group = byBase.get(base);
      if (group) group.push(u);
      else byBase.set(base, [u]);
    }
    const paramGroups: string[][] = [];
    const crossPathReps: string[] = [];
    for (const group of byBase.values()) {
      if (group.length > 1) paramGroups.push(group);
      crossPathReps.push(group[0]);
    }
    return { paramGroups, crossPathReps };
  }

  /**
   * Emit duplicate-value findings for one value map (titles or descriptions),
   * splitting genuine cross-page duplicates from same-page parameterized
   * variants so each carries accurate framing and the correct fix. Populates
   * `duplicateMap` with every duplicated value (used downstream for counts).
   * Returns the number of distinct duplicated values.
   */
  private static emitDuplicateIssues(
    valueMap: Record<string, string[]>,
    duplicateMap: Map<string, string[]>,
    issues: Issue[],
    opts: {
      noun: 'title' | 'description';
      crossPathMessage: string;
      paramMessage: string;
      format: (value: string) => string;
    },
  ): number {
    let count = 0;
    for (const value in valueMap) {
      const urls = valueMap[value];
      if (urls.length <= 1) continue;
      count++;
      duplicateMap.set(value, urls);

      const display = opts.format(value);
      const { paramGroups, crossPathReps } = DuplicateChecker.partitionByBasePath(urls);

      // Genuine cross-page duplicate: ≥2 DISTINCT pages share the value.
      if (crossPathReps.length > 1) {
        issues.push({
          message: opts.crossPathMessage,
          detail: `The ${opts.noun} "${display}" is used on ${crossPathReps.length} pages:<ul>${formatUrlList(crossPathReps)}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Same-page parameterized variants: identical base path, different query
      // string — one page viewed through different filters. Canonicalize/noindex,
      // do not retitle.
      for (const group of paramGroups) {
        const base = basePathForComparison(group[0]);
        issues.push({
          message: opts.paramMessage,
          detail: `The ${opts.noun} "${display}" is shared by ${group.length} parameterized URLs of the same page (<code>${escapeHtml(base)}</code>) — these are one page viewed through different query strings, not separate pages:<ul>${formatUrlList(group)}</ul>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }
    return count;
  }
}

export { DuplicateChecker };
