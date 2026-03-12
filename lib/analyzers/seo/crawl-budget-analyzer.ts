/**
 * Crawl Budget Analyzer
 * Analyzes crawl efficiency based on redirects, errors, duplicates
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class CrawlBudgetAnalyzer {
  /**
   * Analyze crawl budget efficiency for the site
   * @param {object} pages - All pages data
   * @param {object} sitemaps - Sitemap data
   * @param {object} robots - Robots.txt data
   * @returns {object} Analysis results
   */
  static analyze(
    pages: Record<string, PageInfo>,
    _sitemaps: Record<string, any> = {},
    _robots: Record<string, any> = {},
  ) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      totalPages: 0,
      indexablePages: 0,
      nonIndexablePages: 0,
      redirects: 0,
      errors: {
        total: 0,
        '4xx': 0,
        '5xx': 0,
        timeout: 0,
      },
      duplicates: {
        byTitle: 0,
        byContent: 0,
        byCanonical: 0,
      },
      crawlWaste: {
        percentage: 0 as number | string,
        redirectWaste: 0,
        errorWaste: 0,
        duplicateWaste: 0,
        blockedWaste: 0,
      },
      efficiency: {
        score: 100,
        grade: 'A',
      },
      recommendations: [] as string[],
    };

    const pagesList = Object.entries(pages) as [string, any][];
    stats.totalPages = pagesList.length;

    // Track issues
    const redirectedUrls: string[] = [];
    const errorUrls: Record<string, any>[] = [];
    const duplicateTitles = new Map();
    const canonicalTargets = new Map();
    const blockedUrls: string[] = [];

    for (const [url, pageData] of pagesList) {
      // Check indexability
      const isIndexable = this.isPageIndexable(pageData);
      if (isIndexable) {
        stats.indexablePages++;
      } else {
        stats.nonIndexablePages++;
      }

      // Check redirects
      if (pageData.redirectChain?.length > 0 || pageData.statusCode === 301 || pageData.statusCode === 302) {
        stats.redirects++;
        redirectedUrls.push(url);
      }

      // Check errors
      const statusCode = pageData.statusCode || pageData.status;
      if (statusCode >= 400 && statusCode < 500) {
        stats.errors['4xx']++;
        stats.errors.total++;
        errorUrls.push({ url, status: statusCode });
      } else if (statusCode >= 500) {
        stats.errors['5xx']++;
        stats.errors.total++;
        errorUrls.push({ url, status: statusCode });
      } else if (pageData.error?.includes('timeout') || pageData.error?.includes('TIMEOUT')) {
        stats.errors.timeout++;
        stats.errors.total++;
        errorUrls.push({ url, status: 'timeout' });
      }

      // Track duplicate titles
      if (pageData.title) {
        const title = pageData.title.toLowerCase().trim();
        if (!duplicateTitles.has(title)) {
          duplicateTitles.set(title, []);
        }
        duplicateTitles.get(title).push(url);
      }

      // Track canonical targets
      if (pageData.canonical && pageData.canonical !== url) {
        if (!canonicalTargets.has(pageData.canonical)) {
          canonicalTargets.set(pageData.canonical, []);
        }
        canonicalTargets.get(pageData.canonical).push(url);
      }

      // Check if blocked by robots.txt
      if (pageData.blockedByRobots || pageData.robotsBlocked) {
        blockedUrls.push(url);
      }
    }

    // Count duplicates
    for (const [_title, urls] of duplicateTitles) {
      if (urls.length > 1) {
        stats.duplicates.byTitle += urls.length - 1;
      }
    }

    for (const [_canonical, urls] of canonicalTargets) {
      stats.duplicates.byCanonical += urls.length;
    }

    // Calculate crawl waste
    const wastedCrawls = stats.redirects + stats.errors.total + stats.duplicates.byCanonical + blockedUrls.length;
    stats.crawlWaste.redirectWaste = stats.redirects;
    stats.crawlWaste.errorWaste = stats.errors.total;
    stats.crawlWaste.duplicateWaste = stats.duplicates.byCanonical;
    stats.crawlWaste.blockedWaste = blockedUrls.length;
    stats.crawlWaste.percentage =
      stats.totalPages > 0 ? parseFloat(((wastedCrawls / stats.totalPages) * 100).toFixed(1)) : 0;

    // Calculate efficiency score
    const efficiencyPenalties = {
      redirects: Math.min(stats.redirects * 2, 20),
      errors: Math.min(stats.errors.total * 5, 30),
      duplicates: Math.min(stats.duplicates.byCanonical * 1, 15),
      blocked: Math.min(blockedUrls.length * 3, 15),
      nonIndexable: Math.min((stats.nonIndexablePages / stats.totalPages) * 20, 20),
    };

    stats.efficiency.score = Math.max(
      0,
      100 -
        efficiencyPenalties.redirects -
        efficiencyPenalties.errors -
        efficiencyPenalties.duplicates -
        efficiencyPenalties.blocked -
        efficiencyPenalties.nonIndexable,
    );

    // Assign grade
    if (stats.efficiency.score >= 90) stats.efficiency.grade = 'A';
    else if (stats.efficiency.score >= 80) stats.efficiency.grade = 'B';
    else if (stats.efficiency.score >= 70) stats.efficiency.grade = 'C';
    else if (stats.efficiency.score >= 60) stats.efficiency.grade = 'D';
    else stats.efficiency.grade = 'F';

    // Generate issues and recommendations
    // Redirects
    if (stats.redirects > stats.totalPages * 0.1) {
      issues.push({
        message: 'High number of redirects wasting crawl budget',
        detail: `${stats.redirects} URLs (${((stats.redirects / stats.totalPages) * 100).toFixed(1)}%) redirect. Update internal links to point directly to final URLs.`,
        severity: SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Update internal links to use final destination URLs instead of redirecting URLs');
    }

    // Errors
    if (stats.errors.total > 0) {
      issues.push({
        message: 'Error pages wasting crawl budget',
        detail: `${stats.errors.total} pages return errors (${stats.errors['4xx']} 4xx, ${stats.errors['5xx']} 5xx, ${stats.errors.timeout} timeouts). Fix or remove links to these pages.`,
        severity: stats.errors['5xx'] > 0 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Fix or remove broken links to error pages');
    }

    // Duplicates
    if (stats.duplicates.byTitle > 5) {
      warnings.push({
        message: 'Duplicate titles detected',
        detail: `${stats.duplicates.byTitle} pages share titles with other pages. Use unique titles or consolidate content.`,
        severity: SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Create unique title tags for each page');
    }

    if (stats.duplicates.byCanonical > 10) {
      warnings.push({
        message: 'Many pages canonicalized to other URLs',
        detail: `${stats.duplicates.byCanonical} pages point canonical to different URLs. Consider consolidating or removing duplicate pages.`,
        severity: SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Consolidate duplicate content or implement proper pagination');
    }

    // Non-indexable pages in sitemap
    if (stats.nonIndexablePages > stats.totalPages * 0.2) {
      warnings.push({
        message: 'High percentage of non-indexable pages',
        detail: `${stats.nonIndexablePages} pages (${((stats.nonIndexablePages / stats.totalPages) * 100).toFixed(1)}%) are non-indexable (noindex, canonical elsewhere, blocked). Review if these should be in sitemap.`,
        severity: SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Remove non-indexable pages from sitemap');
    }

    // Blocked by robots
    if (blockedUrls.length > 0) {
      warnings.push({
        message: 'Pages blocked by robots.txt in sitemap',
        detail: `${blockedUrls.length} pages are blocked by robots.txt but appear to be crawled. Remove from sitemap or unblock.`,
        severity: SEVERITY.MEDIUM,
      });
      stats.recommendations.push('Remove robots-blocked pages from sitemap');
    }

    // Overall efficiency warning
    if (stats.crawlWaste.percentage > 20) {
      issues.push({
        message: 'Significant crawl budget waste detected',
        detail: `${stats.crawlWaste.percentage}% of crawl budget wasted on redirects, errors, and duplicates. Efficiency score: ${stats.efficiency.score}/100 (${stats.efficiency.grade})`,
        severity: SEVERITY.HIGH,
      });
    }

    // Large site specific recommendations
    if (stats.totalPages > 1000) {
      warnings.push({
        message: 'Large site - crawl budget optimization important',
        detail: `With ${stats.totalPages} pages, optimizing crawl budget is critical. Consider XML sitemap prioritization and crawl rate optimization.`,
        severity: SEVERITY.LOW,
      });
      stats.recommendations.push('Prioritize important pages in XML sitemap');
      stats.recommendations.push('Monitor Google Search Console for crawl stats');
    }

    return { issues, warnings, stats };
  }

  /**
   * Check if a page is indexable
   * @param {object} pageData
   * @returns {boolean}
   */
  static isPageIndexable(pageData: PageInfo) {
    // Check noindex
    if (pageData.noindex || pageData.metaRobots?.includes('noindex')) {
      return false;
    }

    // Check canonical pointing elsewhere
    if (pageData.canonical && pageData.canonical !== pageData.url && pageData.canonical !== pageData.finalUrl) {
      return false;
    }

    // Check status code
    const status = pageData.statusCode || pageData.status;
    if (status && (status < 200 || status >= 300)) {
      return false;
    }

    // Check robots.txt blocking
    if (pageData.blockedByRobots) {
      return false;
    }

    return true;
  }

  /**
   * Analyze crawl budget for site-wide validation
   * This is the main entry point called by AuditOrchestrator
   * @param {object} pages - All pages data
   * @returns {object}
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    return this.analyze(pages);
  }
}

export { CrawlBudgetAnalyzer };
