const { SEVERITY } = require('../../constants');

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
  static validateIndexabilityCrawlability(allPages, sitemapUrls = {}) {
    console.log('\nChecking indexability and crawlability across pages...');

    const stats = {
      indexable: 0,
      nonIndexable: 0,
      noindexPages: [],
      nofollowPages: [],
      redirectChains: [],
      authRequired: [],
      statusErrors: new Map(), // status code -> URLs
      canonicalConflicts: [],
      crawlabilityWarnings: [],
      indexabilityWarnings: [],
    };

    const issues = [];

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
              reason: page.indexability.blockingFactors.join(', ')
            });
          }

          if (page.indexability.statusCode >= 400) {
            const statusCode = page.indexability.statusCode;
            if (!stats.statusErrors.has(statusCode)) {
              stats.statusErrors.set(statusCode, []);
            }
            stats.statusErrors.get(statusCode).push(url);
          }
        }

        if (page.indexability.hasNofollowTag) {
          stats.nofollowPages.push(url);
        }

        if (page.indexability.canonicalPointsElsewhere) {
          stats.canonicalConflicts.push({
            url,
            canonical: page.canonical
          });
        }

        // Collect warnings
        if (page.indexability.warnings.length > 0) {
          stats.indexabilityWarnings.push({
            url,
            warnings: page.indexability.warnings
          });
        }
      }

      // Track crawlability
      if (page.crawlability) {
        if (page.crawlability.redirectChain.length > 0) {
          stats.redirectChains.push({
            url,
            chain: page.crawlability.redirectChain,
            length: page.crawlability.redirectChain.length
          });
        }

        if (page.crawlability.hasAuthRequired) {
          stats.authRequired.push(url);
        }

        if (page.crawlability.warnings.length > 0) {
          stats.crawlabilityWarnings.push({
            url,
            warnings: page.crawlability.warnings
          });
        }
      }
    }

    const totalPages = Object.keys(allPages).length;
    const indexablePercent = totalPages > 0 ? Math.round((stats.indexable / totalPages) * 100) : 0;

    console.log(`Indexability: ${stats.indexable}/${totalPages} pages indexable (${indexablePercent}%)`);
    console.log(`Non-indexable: ${stats.nonIndexable} pages`);

    // Report 1: Pages with noindex in sitemap (critical issue)
    const noindexInSitemap = stats.noindexPages.filter(p =>
      sitemapUrls[p.url]
    );

    if (noindexInSitemap.length > 0) {
      const urlList = noindexInSitemap.slice(0, 10).map(p =>
        `<li><a href="${p.url}">${p.url}</a> (${p.reason})</li>`
      ).join('');
      const moreCount = noindexInSitemap.length > 10 ? ` (showing 10 of ${noindexInSitemap.length})` : '';

      issues.push({
        title: `Pages in sitemap are marked noindex`,
        description: `${noindexInSitemap.length} page(s) are listed in sitemap but have noindex directive${moreCount}:<ul>${urlList}</ul>`,
        severity: SEVERITY.CRITICAL
      });
    }

    // Report 2: Indexable pages not in sitemap
    let indexableNotInSitemap = 0;
    for (const url in allPages) {
      const page = allPages[url];
      if (page.indexability?.isIndexable && !sitemapUrls[url]) {
        indexableNotInSitemap++;
      }
    }

    if (indexableNotInSitemap > 0) {
      issues.push({
        title: `Indexable pages missing from sitemap`,
        description: `${indexableNotInSitemap} indexable page(s) are not listed in the sitemap`,
        severity: SEVERITY.HIGH
      });
    }

    // Report 3: Status code errors summary
    if (stats.statusErrors.size > 0) {
      for (const [statusCode, urls] of stats.statusErrors) {
        const urlList = urls.slice(0, 5).map(u => `<li><a href="${u}">${u}</a></li>`).join('');
        const moreCount = urls.length > 5 ? ` (showing 5 of ${urls.length})` : '';

        issues.push({
          title: `Pages with HTTP ${statusCode} errors`,
          description: `${urls.length} page(s) return HTTP ${statusCode}${moreCount}:<ul>${urlList}</ul>`,
          severity: statusCode >= 500 ? SEVERITY.CRITICAL : SEVERITY.HIGH
        });
      }
    }

    // Report 4: Canonical conflicts summary
    if (stats.canonicalConflicts.length > 5) {
      issues.push({
        title: `Many pages with non-self-referencing canonicals`,
        description: `${stats.canonicalConflicts.length} page(s) have canonical tags pointing to different URLs. This may indicate duplicate content issues.`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 5: Pages with nofollow
    if (stats.nofollowPages.length > 0 && stats.nofollowPages.length < totalPages * 0.1) {
      const urlList = stats.nofollowPages.slice(0, 5).map(u => `<li><a href="${u}">${u}</a></li>`).join('');
      const moreCount = stats.nofollowPages.length > 5 ? ` (showing 5 of ${stats.nofollowPages.length})` : '';

      issues.push({
        title: `Pages have nofollow directive`,
        description: `${stats.nofollowPages.length} page(s) have nofollow in meta robots${moreCount}:<ul>${urlList}</ul>`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 6: Authentication required pages
    if (stats.authRequired.length > 0) {
      const urlList = stats.authRequired.slice(0, 5).map(u => `<li><a href="${u}">${u}</a></li>`).join('');
      issues.push({
        title: `Pages require authentication`,
        description: `${stats.authRequired.length} page(s) require authentication and cannot be crawled:<ul>${urlList}</ul>`,
        severity: SEVERITY.CRITICAL
      });
    }

    // Report 7: Low indexability percentage
    if (indexablePercent < 70 && totalPages > 10) {
      issues.push({
        title: `Low site indexability`,
        description: `Only ${indexablePercent}% of pages (${stats.indexable}/${totalPages}) are indexable. This may significantly impact search visibility.`,
        severity: SEVERITY.CRITICAL
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
      }
    };
  }
}

module.exports = { IndexabilityValidator };
