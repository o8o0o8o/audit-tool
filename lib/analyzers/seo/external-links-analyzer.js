/**
 * External Links Analyzer
 * Analyzes outbound link quality, nofollow usage, and link equity management
 */

const { SEVERITY } = require('../../constants');

// Known spam/low-quality domains (simplified list)
const SUSPICIOUS_PATTERNS = [
  /^(?:www\.)?(?:bit\.ly|tinyurl|goo\.gl|t\.co)/i, // URL shorteners
  /casino|gambling|poker|slots|betting/i,
  /payday|loan|credit|forex|bitcoin|crypto/i,
  /pharma|viagra|cialis|pills/i,
  /adult|xxx|porn/i,
];

// Domains that should typically have nofollow
const NOFOLLOW_RECOMMENDED = [
  /^(?:www\.)?(?:facebook|twitter|instagram|linkedin|youtube|tiktok)\./i,
  /^(?:www\.)?(?:amazon|ebay|aliexpress)\./i,
  /^(?:www\.)?(?:wikipedia|reddit)\./i,
];

// Trusted domains that don't need nofollow
const TRUSTED_DOMAINS = [
  /^(?:www\.)?(?:google|microsoft|apple|github)\./i,
  /\.gov$/i,
  /\.edu$/i,
];

class ExternalLinksAnalyzer {
  /**
   * Analyze external links for a page
   * @param {object} pageData - Page data with links
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData, url) {
    const issues = [];
    const warnings = [];
    const info = {
      totalExternalLinks: 0,
      followedLinks: 0,
      nofollowLinks: 0,
      ugcLinks: 0,
      sponsoredLinks: 0,
      newTabLinks: 0,
      brokenLinks: [],
      suspiciousLinks: [],
      linksByDomain: {},
      affiliateLinks: [],
      socialLinks: [],
    };

    const links = pageData.links || [];
    const pageOrigin = this.getOrigin(url);

    for (const link of links) {
      const href = link.href || link.url || link;
      const rel = (link.rel || '').toLowerCase();
      const target = link.target || '';

      // Skip internal links
      if (this.isInternalLink(href, pageOrigin)) {
        continue;
      }

      // Skip non-http links
      if (!href.startsWith('http://') && !href.startsWith('https://')) {
        continue;
      }

      info.totalExternalLinks++;

      // Get domain
      let domain;
      try {
        domain = new URL(href).hostname;
      } catch {
        continue;
      }

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
      const isSuspicious = SUSPICIOUS_PATTERNS.some(pattern => pattern.test(href));
      if (isSuspicious) {
        info.suspiciousLinks.push({ href, anchor: link.text || link.anchor });

        if (!hasNofollow) {
          issues.push({
            message: 'Suspicious external link without nofollow',
            detail: `Link to "${domain}" appears suspicious and lacks nofollow. Add rel="nofollow" to avoid passing link equity.`,
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Check if link should have nofollow
      const shouldNofollow = NOFOLLOW_RECOMMENDED.some(pattern => pattern.test(domain));
      const isTrusted = TRUSTED_DOMAINS.some(pattern => pattern.test(domain));

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
        info.brokenLinks.push({ href, status: link.status });
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
        detail: `${info.brokenLinks.length} external links return errors: ${info.brokenLinks.slice(0, 3).map(l => l.href).join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Check if link is internal
   */
  static isInternalLink(href, origin) {
    if (!href) return true;
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return true;
    }

    try {
      const linkOrigin = new URL(href, origin).origin;
      return linkOrigin === origin;
    } catch {
      return href.startsWith('/');
    }
  }

  /**
   * Get origin from URL
   */
  static getOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  /**
   * Check if link is an affiliate link
   */
  static isAffiliateLink(href) {
    const affiliatePatterns = [
      /[?&](ref|affiliate|aff|partner|tag|utm_source=affiliate)/i,
      /\/(ref|aff|affiliate|partner)\//i,
      /amazon\..*[?&]tag=/i,
      /shareasale|cj\.com|rakuten|awin|impact\.com/i,
    ];

    return affiliatePatterns.some(pattern => pattern.test(href));
  }

  /**
   * Check if link is a social media link
   */
  static isSocialLink(href) {
    const socialPatterns = [
      /facebook\.com|fb\.com/i,
      /twitter\.com|x\.com/i,
      /instagram\.com/i,
      /linkedin\.com/i,
      /youtube\.com/i,
      /tiktok\.com/i,
      /pinterest\.com/i,
    ];

    return socialPatterns.some(pattern => pattern.test(href));
  }

  /**
   * Analyze external links across the site
   * @param {object} pages - All pages data
   * @param {string} origin - Site origin
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages, origin) {
    const issues = [];
    const warnings = [];
    const stats = {
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
      const analysis = this.analyze(pageData, url);

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
    delete stats.uniqueDomains;

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
    const followedRatio = stats.totalExternalLinks > 0
      ? (stats.totalFollowed / stats.totalExternalLinks * 100).toFixed(1)
      : 0;

    if (parseFloat(followedRatio) > 80 && stats.totalExternalLinks > 50) {
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
      const domainSummary = topDomains.slice(0, 5)
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

module.exports = { ExternalLinksAnalyzer };
