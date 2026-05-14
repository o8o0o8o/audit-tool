/**
 * External Links Analyzer
 * Analyzes outbound link quality, nofollow usage, and link equity management
 */

import { SEVERITY } from '../../constants';
import { isInternalLink, getOrigin, fetchWithTimeout, getHostname } from '../../utils';
import type { Issue, PageInfo } from '../../types';

// Known spam/low-quality domains (simplified list)
const SUSPICIOUS_PATTERNS = [
  /^(?:www\.)?(?:bit\.ly|tinyurl|goo\.gl|t\.co)/i, // URL shorteners
  /casino|gambling|poker|slots|betting/i,
  /payday|loan|credit|forex|bitcoin|crypto/i,
  /pharma|viagra|cialis|pills/i,
  /adult|xxx|porn/i,
];

// Domains that should typically have nofollow
const _NOFOLLOW_RECOMMENDED = [
  /^(?:www\.)?(?:facebook|twitter|instagram|linkedin|youtube|tiktok)\./i,
  /^(?:www\.)?(?:amazon|ebay|aliexpress)\./i,
  /^(?:www\.)?(?:wikipedia|reddit)\./i,
];

// Trusted domains that don't need nofollow
const _TRUSTED_DOMAINS = [/^(?:www\.)?(?:google|microsoft|apple|github)\./i, /\.gov$/i, /\.edu$/i];

class ExternalLinksAnalyzer {
  /**
   * Analyze external links for a page
   * @param {object} pageData - Page data with links
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      totalExternalLinks: 0,
      followedLinks: 0,
      nofollowLinks: 0,
      ugcLinks: 0,
      sponsoredLinks: 0,
      newTabLinks: 0,
      brokenLinks: [] as { href: string; status: number }[],
      suspiciousLinks: [] as { href: string; anchor: string }[],
      linksByDomain: {} as Record<string, { count: number; followed: number; nofollow: number }>,
      affiliateLinks: [] as { href: string; hasSponsored: boolean }[],
      socialLinks: [] as string[],
    };

    const links = Array.isArray(pageData.links)
      ? (pageData.links as {
          href?: string;
          url?: string;
          rel?: string;
          target?: string;
          text?: string;
          anchor?: string;
          status?: number;
        }[])
      : [];
    const pageOrigin = getOrigin(url);

    for (const link of links) {
      const href = String(link.href ?? link.url ?? '');
      const rel = (link.rel ?? '').toLowerCase();
      const target = link.target ?? '';

      // Skip internal links
      if (isInternalLink(href, pageOrigin)) {
        continue;
      }

      // Skip non-http links
      if (!href.startsWith('http://') && !href.startsWith('https://')) {
        continue;
      }

      info.totalExternalLinks++;

      // Get domain
      const domain = getHostname(href);
      if (!domain) continue;

      // Track by domain
      if (!info.linksByDomain[domain]) {
        info.linksByDomain[domain] = { count: 0, followed: 0, nofollow: 0 };
      }
      info.linksByDomain[domain].count++;

      // Check rel attributes
      const hasNofollow = rel.includes('nofollow');
      const hasUgc = rel.includes('ugc');
      const hasSponsored = rel.includes('sponsored');
      const hasOpener = rel.includes('noopener') || rel.includes('noreferrer');
      const opensNewTab = target === '_blank';

      if (hasNofollow) {
        info.nofollowLinks++;
        info.linksByDomain[domain].nofollow++;
      } else {
        info.followedLinks++;
        info.linksByDomain[domain].followed++;
      }

      if (hasUgc) info.ugcLinks++;
      if (hasSponsored) info.sponsoredLinks++;
      if (opensNewTab) info.newTabLinks++;

      // Check for security issue (target="_blank" without rel="noopener")
      if (opensNewTab && !hasOpener) {
        warnings.push({
          message: 'External link opens in new tab without noopener',
          detail: `Link to ${domain} uses target="_blank" without rel="noopener". This is a security risk.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check for suspicious links
      const isSuspicious = SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(href));
      if (isSuspicious) {
        info.suspiciousLinks.push({ href, anchor: link.text ?? link.anchor ?? '' });

        if (!hasNofollow) {
          issues.push({
            message: 'Suspicious external link without nofollow',
            detail: `Link to "${domain}" appears suspicious and lacks nofollow. Add rel="nofollow" to avoid passing link equity.`,
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Detect affiliate links
      if (this.isAffiliateLink(href)) {
        info.affiliateLinks.push({ href, hasSponsored });

        if (!hasSponsored && !hasNofollow) {
          warnings.push({
            message: 'Affiliate link without sponsored/nofollow',
            detail: `Link to ${domain} appears to be an affiliate link. Add rel="sponsored" per Google guidelines.`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }

      // Detect social links
      if (this.isSocialLink(href)) {
        info.socialLinks.push(href);
      }

      // Check broken links if status available
      if (link.status && link.status >= 400) {
        info.brokenLinks.push({ href, status: link.status! });
      }
    }

    // Analyze overall link patterns
    // Too many followed external links
    if (info.followedLinks > 50) {
      warnings.push({
        message: 'High number of followed external links',
        detail: `Page has ${info.followedLinks} followed external links. Consider using nofollow for less relevant links.`,
        severity: SEVERITY.LOW,
      });
    }

    // Link equity concentration
    const topDomains = Object.entries(info.linksByDomain)
      .sort((a, b) => b[1].followed - a[1].followed)
      .slice(0, 3);

    const topDomainFollowed = topDomains.reduce((sum, [_, data]) => sum + data.followed, 0);
    if (topDomainFollowed > info.followedLinks * 0.5 && info.followedLinks > 10) {
      const domainList = topDomains.map(([domain, data]) => `${domain} (${data.followed})`).join(', ');
      warnings.push({
        message: 'Link equity concentrated to few domains',
        detail: `Most followed links go to: ${domainList}. Diversify external linking.`,
        severity: SEVERITY.LOW,
      });
    }

    // Broken links
    if (info.brokenLinks.length > 0) {
      issues.push({
        message: 'Broken external links',
        detail: `${info.brokenLinks.length} external links return errors: ${info.brokenLinks
          .slice(0, 3)
          .map((l) => l.href)
          .join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Check if link is an affiliate link
   */
  static isAffiliateLink(href: string) {
    const affiliatePatterns = [
      /[?&](ref|affiliate|aff|partner|tag|utm_source=affiliate)/i,
      /\/(ref|aff|affiliate|partner)\//i,
      /amazon\..*[?&]tag=/i,
      /shareasale|cj\.com|rakuten|awin|impact\.com/i,
    ];

    return affiliatePatterns.some((pattern) => pattern.test(href));
  }

  /**
   * Check if link is a social media link
   */
  static isSocialLink(href: string) {
    const socialPatterns = [
      /facebook\.com|fb\.com/i,
      /twitter\.com|x\.com/i,
      /instagram\.com/i,
      /linkedin\.com/i,
      /youtube\.com/i,
      /tiktok\.com/i,
      /pinterest\.com/i,
    ];

    return socialPatterns.some((pattern) => pattern.test(href));
  }

  /**
   * Verify external links by making HTTP HEAD requests
   * Deduplicates URLs and checks in batches to avoid overwhelming targets
   * @param {object} pages - All pages data
   * @param {string} origin - Site origin
   * @param {object} options - { concurrency, timeout, maxUrls }
   * @returns {Promise<object>} Verification results
   */
  static async verifyExternalLinks(
    pages: Record<string, PageInfo>,
    origin: string,
    options: { concurrency?: number; timeout?: number; maxUrls?: number } = {},
  ) {
    const { concurrency = 5, timeout = 10000, maxUrls = 500 } = options;
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    // Collect unique external URLs with their source pages
    const externalUrlMap = new Map<string, Set<string>>(); // url -> Set of source pages
    const pageOrigin = getOrigin(origin);

    for (const [pageUrl, pageData] of Object.entries(pages)) {
      const links = (Array.isArray(pageData.links) ? pageData.links : []) as { href?: string; url?: string }[];
      for (const link of links) {
        const href = link.href ?? link.url ?? link;
        if (!href || typeof href !== 'string') continue;
        if (!href.startsWith('http://') && !href.startsWith('https://')) continue;
        if (isInternalLink(href, pageOrigin)) continue;

        // Normalize URL (remove fragment)
        let normalizedUrl;
        try {
          const parsed = new URL(href);
          parsed.hash = '';
          normalizedUrl = parsed.toString();
        } catch {
          continue;
        }

        if (!externalUrlMap.has(normalizedUrl)) {
          externalUrlMap.set(normalizedUrl, new Set());
        }
        externalUrlMap.get(normalizedUrl)!.add(pageUrl);
      }
    }

    const uniqueUrls = Array.from(externalUrlMap.keys());
    const urlsToCheck = uniqueUrls.slice(0, maxUrls);

    console.log(`Verifying ${urlsToCheck.length} unique external URLs (of ${uniqueUrls.length} total)...`);

    const results = {
      checked: 0,
      ok: 0,
      broken: [] as { url: string; status: number; foundOnPages: string[]; totalPages: number }[],
      redirected: [] as { url: string; status: number; finalUrl: string }[],
      timeout: [] as string[],
      errors: [] as { url: string; error: string }[],
    };

    // Process in batches
    for (let i = 0; i < urlsToCheck.length; i += concurrency) {
      const batch = urlsToCheck.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async (url: string) => {
          try {
            const response = await fetchWithTimeout(url, timeout, {
              method: 'HEAD',
              redirect: 'follow',
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
              },
            });

            return {
              url,
              status: response.status,
              redirected: response.redirected,
              finalUrl: response.url,
            };
          } catch (error: unknown) {
            if ((error as Error).name === 'AbortError') {
              return { url, status: 0, error: 'timeout' };
            }
            return { url, status: 0, error: (error as Error).message };
          }
        }),
      );

      for (const settled of batchResults) {
        results.checked++;
        if (settled.status === 'rejected') {
          results.errors.push({ url: 'unknown', error: settled.reason?.message });
          continue;
        }

        const result = settled.value;
        if (result.error === 'timeout') {
          results.timeout.push(result.url);
        } else if (result.status >= 400) {
          const sourcePages = Array.from(externalUrlMap.get(result.url) ?? []);
          results.broken.push({
            url: result.url,
            status: result.status,
            foundOnPages: sourcePages.slice(0, 5),
            totalPages: sourcePages.length,
          });
        } else if (result.status >= 200 && result.status < 400) {
          results.ok++;
        }
      }
    }

    // Generate issues
    if (results.broken.length > 0) {
      const brokenList = results.broken
        .sort((a, b) => b.totalPages - a.totalPages)
        .slice(0, 10)
        .map((b) => `${b.url} (HTTP ${b.status}, found on ${b.totalPages} page(s))`)
        .join('; ');

      issues.push({
        message: `${results.broken.length} broken external link(s) verified`,
        detail: `HTTP verification found ${results.broken.length} external URLs returning error status codes. Top broken: ${brokenList}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (results.timeout.length > 5) {
      warnings.push({
        message: `${results.timeout.length} external links timed out`,
        detail: `These external URLs did not respond within ${timeout / 1000}s. They may be slow or unreachable.`,
        severity: SEVERITY.LOW,
      });
    }

    if (uniqueUrls.length > maxUrls) {
      warnings.push({
        message: `Only checked ${maxUrls} of ${uniqueUrls.length} unique external URLs`,
        detail: `External link verification was limited to ${maxUrls} URLs for performance. Increase the limit for a full check.`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      issues,
      warnings,
      stats: {
        uniqueExternalUrls: uniqueUrls.length,
        checked: results.checked,
        ok: results.ok,
        broken: results.broken.length,
        timedOut: results.timeout.length,
        brokenLinks: results.broken,
      },
    };
  }

  /**
   * Analyze external links across the site
   * @param {object} pages - All pages data
   * @param {string} origin - Site origin
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>, _origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats: {
      totalExternalLinks: number;
      totalFollowed: number;
      totalNofollow: number;
      totalSponsored: number;
      uniqueDomains: Set<string>;
      domainLinkCounts: Record<string, { total: number; followed: number }>;
      pagesWithManyExternal: number;
      affiliateLinksTotal: number;
      suspiciousLinksTotal: number;
      brokenLinksTotal: number;
      uniqueDomainsCount?: number;
    } = {
      totalExternalLinks: 0,
      totalFollowed: 0,
      totalNofollow: 0,
      totalSponsored: 0,
      uniqueDomains: new Set(),
      domainLinkCounts: {},
      pagesWithManyExternal: 0,
      affiliateLinksTotal: 0,
      suspiciousLinksTotal: 0,
      brokenLinksTotal: 0,
    };

    for (const [url, pageData] of Object.entries(pages)) {
      const analysis =
        (pageData as PageInfo & { externalLinksAnalysis?: ReturnType<typeof ExternalLinksAnalyzer.analyze> })
          .externalLinksAnalysis ?? this.analyze(pageData, url);

      stats.totalExternalLinks += analysis.info.totalExternalLinks;
      stats.totalFollowed += analysis.info.followedLinks;
      stats.totalNofollow += analysis.info.nofollowLinks;
      stats.totalSponsored += analysis.info.sponsoredLinks;
      stats.affiliateLinksTotal += analysis.info.affiliateLinks.length;
      stats.suspiciousLinksTotal += analysis.info.suspiciousLinks.length;
      stats.brokenLinksTotal += analysis.info.brokenLinks.length;

      // Track domains
      for (const [domain, data] of Object.entries(analysis.info.linksByDomain)) {
        stats.uniqueDomains.add(domain);
        if (!stats.domainLinkCounts[domain]) {
          stats.domainLinkCounts[domain] = { total: 0, followed: 0 };
        }

        stats.domainLinkCounts[domain].total += data.count;

        stats.domainLinkCounts[domain].followed += data.followed;
      }

      if (analysis.info.totalExternalLinks > 100) {
        stats.pagesWithManyExternal++;
      }
    }

    // Convert Set to count
    stats.uniqueDomainsCount = stats.uniqueDomains.size;
    delete (stats as Partial<typeof stats>).uniqueDomains;

    // Site-wide issues
    if (stats.suspiciousLinksTotal > 0) {
      issues.push({
        message: 'Suspicious external links detected',
        detail: `${stats.suspiciousLinksTotal} potentially suspicious external links found across the site. Review and add nofollow where appropriate.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (stats.brokenLinksTotal > 0) {
      issues.push({
        message: 'Broken external links across site',
        detail: `${stats.brokenLinksTotal} broken external links found. Remove or update these links.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check followed/nofollow ratio
    const followedRatio =
      stats.totalExternalLinks > 0 ? ((stats.totalFollowed / stats.totalExternalLinks) * 100).toFixed(1) : 0;

    if (parseFloat(String(followedRatio)) > 80 && stats.totalExternalLinks > 50) {
      warnings.push({
        message: 'Most external links pass link equity',
        detail: `${followedRatio}% of ${stats.totalExternalLinks} external links are followed. Consider strategic use of nofollow.`,
        severity: SEVERITY.LOW,
      });
    }

    // Top linked domains
    const topDomains = Object.entries(stats.domainLinkCounts)
      .sort((a, b) => b[1].followed - a[1].followed)
      .slice(0, 10);

    if (topDomains.length > 0) {
      const domainSummary = topDomains
        .slice(0, 5)
        .map(([domain, data]) => `${domain} (${data.followed} followed)`)
        .join(', ');

      warnings.push({
        message: 'Top external link destinations',
        detail: `Most linked domains: ${domainSummary}`,
        severity: SEVERITY.LOW,
      });
    }

    // Affiliate disclosure check
    if (stats.affiliateLinksTotal > 5 && stats.totalSponsored < stats.affiliateLinksTotal * 0.5) {
      warnings.push({
        message: 'Affiliate links may need disclosure',
        detail: `${stats.affiliateLinksTotal} affiliate links found but only ${stats.totalSponsored} use rel="sponsored". FTC guidelines require disclosure.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, stats };
  }
}

export { ExternalLinksAnalyzer };
