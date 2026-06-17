import { SEVERITY } from '../../constants';
import { formatUrlList, calcPercent, escapeHtml, normalizeUrlForComparison } from '../../utils';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Indexability Validator
 * Checks for indexability and crawlability issues across all pages.
 */
class IndexabilityValidator {
  /**
   * Validate indexability and crawlability across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @param {Object} sitemapUrls - Object with URLs from sitemap { url: true }
   * @returns {Object} { issues: [], noindexPages: [], redirectPages: [], slowPages: [] }
   */
  static validateIndexabilityCrawlability(
    allPages: Record<string, PageInfo>,
    sitemapUrls: Record<string, unknown> = {},
  ) {
    console.log('\nChecking indexability and crawlability across pages...');

    const stats = {
      indexable: 0,
      nonIndexable: 0,
      noindexPages: [] as { url: string; reason: string }[],
      nofollowPages: [] as string[],
      redirectChains: [] as { url: string; chain: string[]; length: number }[],
      authRequired: [] as string[],
      statusErrors: new Map<number, string[]>(),
      canonicalConflicts: [] as { url: string; canonical: string | undefined }[],
      crawlabilityWarnings: [] as { url: string; warnings: string[] }[],
      indexabilityWarnings: [] as { url: string; warnings: string[] }[],
    };

    const issues: Issue[] = [];

    // Normalized sitemap membership test. Sitemap entries and crawled page
    // keys can differ only by a trailing slash (or hash); comparing raw strings
    // wrongly reports every page as "missing from sitemap". An empty sitemap
    // map (e.g. caller didn't supply one) disables the not-in-sitemap report
    // rather than flagging the whole site.
    const sitemapSet = new Set(Object.keys(sitemapUrls).map(normalizeUrlForComparison));
    const haveSitemap = sitemapSet.size > 0;
    const inSitemap = (u: string): boolean => sitemapSet.has(normalizeUrlForComparison(u));

    // Analyze each page
    for (const url in allPages) {
      const page = allPages[url];

      // Track indexability
      if (page.indexability) {
        if (page.indexability.isIndexable) {
          stats.indexable++;
        } else {
          stats.nonIndexable++;

          // Categorize non-indexable pages
          if (page.indexability.hasNoindexTag) {
            stats.noindexPages.push({
              url,
              reason: (page.indexability.blockingFactors || []).join(', '),
            });
          }

          if (page.indexability.statusCode >= 400) {
            const statusCode = page.indexability.statusCode;
            if (!stats.statusErrors.has(statusCode)) {
              stats.statusErrors.set(statusCode, []);
            }
            stats.statusErrors.get(statusCode)!.push(url);
          }
        }

        if (page.indexability.hasNofollowTag) {
          stats.nofollowPages.push(url);
        }

        if (page.indexability.canonicalPointsElsewhere) {
          stats.canonicalConflicts.push({
            url,
            canonical: page.canonical,
          });
        }

        // Collect warnings
        if (page.indexability.warnings?.length > 0) {
          stats.indexabilityWarnings.push({
            url,
            warnings: page.indexability.warnings,
          });
        }
      }

      // Track crawlability
      if (page.crawlability) {
        if (page.crawlability.redirectChain?.length > 0) {
          stats.redirectChains.push({
            url,
            chain: page.crawlability.redirectChain,
            length: page.crawlability.redirectChain.length,
          });
        }

        if (page.crawlability.hasAuthRequired) {
          stats.authRequired.push(url);
        }

        if (page.crawlability.warnings?.length > 0) {
          stats.crawlabilityWarnings.push({
            url,
            warnings: page.crawlability.warnings,
          });
        }
      }
    }

    const totalPages = Object.keys(allPages).length;
    const indexablePercent = calcPercent(stats.indexable, totalPages);

    console.log(`Indexability: ${stats.indexable}/${totalPages} pages indexable (${indexablePercent}%)`);
    console.log(`Non-indexable: ${stats.nonIndexable} pages`);

    // Report 1: Pages with noindex in sitemap (critical issue)
    const noindexInSitemap = stats.noindexPages.filter((p) => inSitemap(p.url));

    if (noindexInSitemap.length > 0) {
      const urlList = noindexInSitemap
        .slice(0, 10)
        .map((p) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a> (${escapeHtml(p.reason)})</li>`)
        .join('');
      const moreCount = noindexInSitemap.length > 10 ? ` (showing 10 of ${noindexInSitemap.length})` : '';

      issues.push({
        message: `Pages in sitemap are marked noindex`,
        detail: `${noindexInSitemap.length} page(s) are listed in sitemap but have noindex directive${moreCount}:<ul>${urlList}</ul>`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 2: Indexable pages not in sitemap. Skipped entirely when no
    // sitemap was supplied — otherwise we'd report 100% of pages as missing.
    let indexableNotInSitemap = 0;
    if (haveSitemap) {
      for (const url in allPages) {
        const page = allPages[url];
        if (page.hasRedirects) continue; // redirect source, not a real indexable page
        if (page.indexability?.isIndexable && !inSitemap(url)) {
          indexableNotInSitemap++;
        }
      }
    }

    if (indexableNotInSitemap > 0) {
      issues.push({
        message: `Indexable pages missing from sitemap`,
        detail: `${indexableNotInSitemap} indexable page(s) are not listed in the sitemap`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 3: Status code errors summary
    if (stats.statusErrors.size > 0) {
      for (const [statusCode, urls] of stats.statusErrors) {
        const urlList = formatUrlList(urls, 5);
        const moreCount = urls.length > 5 ? ` (showing 5 of ${urls.length})` : '';

        issues.push({
          message: `Pages with HTTP ${statusCode} errors`,
          detail: `${urls.length} page(s) return HTTP ${statusCode}${moreCount}:<ul>${urlList}</ul>`,
          severity: statusCode >= 500 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
        });
      }
    }

    // Report 4: Canonical conflicts summary
    if (stats.canonicalConflicts.length > 5) {
      issues.push({
        message: `Many pages with non-self-referencing canonicals`,
        detail: `${stats.canonicalConflicts.length} page(s) have canonical tags pointing to different URLs. This may indicate duplicate content issues.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 5: Pages with nofollow
    if (stats.nofollowPages.length > 0 && stats.nofollowPages.length < totalPages * 0.1) {
      const urlList = formatUrlList(stats.nofollowPages, 5);
      const moreCount = stats.nofollowPages.length > 5 ? ` (showing 5 of ${stats.nofollowPages.length})` : '';

      issues.push({
        message: `Pages have nofollow directive`,
        detail: `${stats.nofollowPages.length} page(s) have nofollow in meta robots${moreCount}:<ul>${urlList}</ul>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 6: Authentication required pages
    if (stats.authRequired.length > 0) {
      const urlList = formatUrlList(stats.authRequired, 5);
      issues.push({
        message: `Pages require authentication`,
        detail: `${stats.authRequired.length} page(s) require authentication and cannot be crawled:<ul>${urlList}</ul>`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 7: Low indexability percentage
    if (indexablePercent < 70 && totalPages > 10) {
      issues.push({
        message: `Low site indexability`,
        detail: `Only ${indexablePercent}% of pages (${stats.indexable}/${totalPages}) are indexable. This may significantly impact search visibility.`,
        severity: SEVERITY.CRITICAL,
      });
    }

    console.log(`Found ${stats.noindexPages.length} pages with noindex`);
    console.log(`Found ${stats.redirectChains.length} redirect chains`);
    console.log(`Found ${stats.statusErrors.size} different HTTP error types`);

    return {
      issues,
      noindexPages: stats.noindexPages,
      redirectPages: stats.redirectChains,
      slowPages: [], // Could be populated from performance data
      stats: {
        indexablePercent,
        indexable: stats.indexable,
        nonIndexable: stats.nonIndexable,
        totalPages: totalPages,
        noindexCount: stats.noindexPages.length,
        nofollowCount: stats.nofollowPages.length,
        redirectChainCount: stats.redirectChains.length,
        statusErrorCount: Array.from(stats.statusErrors.values()).reduce((sum, urls) => sum + urls.length, 0),
      },
    };
  }
}

export { IndexabilityValidator };
