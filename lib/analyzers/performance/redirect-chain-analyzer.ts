/**
 * Redirect Chain Analyzer
 * Detects redirect chains, loops, and inefficient redirect patterns
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class RedirectChainAnalyzer {
  /**
   * Analyze redirect chain for a page
   * @param {object} pageData - Page data with redirect information
   * @param {string} url - Original URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      redirectCount: 0,
      redirectChain: [] as Record<string, any>[],
      finalUrl: url,
      hasHttpToHttps: false,
      hasWwwRedirect: false,
      totalRedirectTime: 0,
    };

    // Extract redirect chain from page data
    const redirectChain = pageData.redirectChain || [];
    info.redirectCount = redirectChain.length;
    info.redirectChain = redirectChain;
    info.finalUrl = pageData.finalUrl || url;

    if (redirectChain.length === 0) {
      return { issues, warnings, info };
    }

    // Analyze the redirect chain

    for (let i = 0; i < redirectChain.length; i++) {
      const redirect = redirectChain[i];
      const fromUrl = i === 0 ? url : redirectChain[i - 1].url;
      const toUrl = redirect.url;

      // Check for HTTP to HTTPS redirect
      if (fromUrl.startsWith('http://') && toUrl.startsWith('https://')) {
        info.hasHttpToHttps = true;
      }

      // Check for www redirect
      try {
        const fromHost = new URL(fromUrl).hostname;
        const toHost = new URL(toUrl).hostname;
        if (
          (fromHost.startsWith('www.') && !toHost.startsWith('www.')) ||
          (!fromHost.startsWith('www.') && toHost.startsWith('www.'))
        ) {
          info.hasWwwRedirect = true;
        }
      } catch {
        // Invalid URL
      }

      // Track redirect time if available
      if (redirect.timing) {
        info.totalRedirectTime += redirect.timing;
      }

      // previousUrl tracking removed - not currently used
    }

    // Check for redirect chain length
    const chainStr = redirectChain.map((r: any) => `${r.url} (${r.status})`).join(' → ');
    if (redirectChain.length > 3) {
      issues.push({
        message: 'Long redirect chain detected',
        detail: `${redirectChain.length} redirects — each adds latency and wastes crawl budget. Chain: ${chainStr}`,
        severity: SEVERITY.HIGH,
      });
    } else if (redirectChain.length > 1) {
      warnings.push({
        message: 'Multiple redirects detected',
        detail: `${redirectChain.length} redirects — consider reducing to a single redirect. Chain: ${chainStr}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for separate HTTP→HTTPS and www redirects (should be combined)
    if (info.hasHttpToHttps && info.hasWwwRedirect && redirectChain.length >= 2) {
      issues.push({
        message: 'HTTP→HTTPS and www redirects not combined',
        detail: `Separate redirects for protocol and www. Configure server to redirect directly to final canonical URL in one hop.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check redirect status codes
    for (const redirect of redirectChain) {
      if (redirect.status === 302 || redirect.status === 307) {
        warnings.push({
          message: 'Temporary redirect used instead of permanent',
          detail: `Status ${redirect.status} redirect to ${redirect.url}. Use 301 for permanent redirects to pass link equity.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for redirect loops (same URL appears twice in chain, excluding the expected original→final structure)
    const urlCounts = new Map();
    for (const redirect of redirectChain) {
      urlCounts.set(redirect.url, (urlCounts.get(redirect.url) || 0) + 1);
    }
    const loopUrls = [...urlCounts.entries()].filter(([, count]) => count > 1);
    if (loopUrls.length > 0) {
      const chainStr = redirectChain.map((r: any) => `${r.url} (${r.status})`).join(' → ');
      issues.push({
        message: 'Redirect loop detected',
        detail: `Redirect chain: ${chainStr}`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Check if final URL differs significantly from original
    try {
      const originalUrl = new URL(url);
      const finalUrl = new URL(info.finalUrl);

      // Different domain entirely
      if (
        originalUrl.hostname !== finalUrl.hostname &&
        originalUrl.hostname.replace(/^www\./, '') !== finalUrl.hostname.replace(/^www\./, '')
      ) {
        warnings.push({
          message: 'Redirect to different domain',
          detail: `Original: ${originalUrl.hostname} → Final: ${finalUrl.hostname}`,
          severity: SEVERITY.LOW,
        });
      }
    } catch {
      // Invalid URL
    }

    return { issues, warnings, info };
  }

  /**
   * Analyze redirect patterns across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      totalRedirects: 0,
      pagesWithRedirects: 0,
      avgRedirectsPerPage: 0,
      longestChain: 0,
      redirectTypes: { 301: 0, 302: 0, 307: 0, 308: 0, other: 0 } as Record<string | number, number>,
      httpToHttps: 0,
      wwwRedirects: 0,
    };

    const pagesWithLongChains: Record<string, any>[] = [];

    for (const [url, pageData] of Object.entries(pages)) {
      const chain = pageData.redirectChain || [];

      if (chain.length > 0) {
        stats.pagesWithRedirects++;
        stats.totalRedirects += chain.length;

        if (chain.length > stats.longestChain) {
          stats.longestChain = chain.length;
        }

        if (chain.length > 2) {
          pagesWithLongChains.push({ url, length: chain.length });
        }

        // Count redirect types
        for (const redirect of chain) {
          const status = redirect.status;
          if (stats.redirectTypes[status] !== undefined) {
            stats.redirectTypes[status]++;
          } else {
            stats.redirectTypes.other++;
          }
        }

        // Check for HTTP to HTTPS
        if (url.startsWith('http://') && pageData.finalUrl?.startsWith('https://')) {
          stats.httpToHttps++;
        }
      }
    }

    if (stats.pagesWithRedirects > 0) {
      stats.avgRedirectsPerPage = parseFloat((stats.totalRedirects / stats.pagesWithRedirects).toFixed(2));
    }

    // Site-wide issues
    const totalPages = Object.keys(pages).length;
    const redirectPercentage = totalPages > 0 ? ((stats.pagesWithRedirects / totalPages) * 100).toFixed(1) : 0;

    if (parseFloat(redirectPercentage as string) > 30) {
      issues.push({
        message: 'High percentage of pages have redirects',
        detail: `${redirectPercentage}% of crawled pages (${stats.pagesWithRedirects}/${totalPages}) have redirects. Review internal linking to use final URLs.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (pagesWithLongChains.length > 0) {
      const examples = pagesWithLongChains
        .slice(0, 5)
        .map((p: any) => `${p.url} (${p.length} hops)`)
        .join(', ');
      issues.push({
        message: 'Pages with long redirect chains',
        detail: `${pagesWithLongChains.length} pages have >2 redirects. Examples: ${examples}`,
        severity: SEVERITY.HIGH,
      });
    }

    if (stats.redirectTypes[302] > stats.redirectTypes[301]) {
      warnings.push({
        message: 'More temporary redirects than permanent',
        detail: `Found ${stats.redirectTypes[302]} 302 redirects vs ${stats.redirectTypes[301]} 301 redirects. Consider using 301 for permanent redirects.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, stats };
  }
}

export { RedirectChainAnalyzer };
