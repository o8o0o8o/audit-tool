import type { ChromePage, ParsedPage, PageInfo } from '../../types';

class LinkQualityAnalyzer {
  static async analyzeLinkQuality(chromePage: ChromePage, parsedPage: ParsedPage, url: string, origin: string, allPages: Record<string, PageInfo>) {
    const linkAnalysis = {
      totalLinks: 0,
      internalLinks: 0,
      externalLinks: 0,
      nofollowLinks: 0,
      followLinks: 0,
      brokenLinks: [] as Record<string, any>[],
      redirectLinks: [] as Record<string, any>[],
      emptyAnchorLinks: [] as Record<string, any>[],
      genericAnchorLinks: [] as Record<string, any>[],
      anchorTextMap: {} as Record<string, number>, // anchor text -> count
      externalDomains: {} as Record<string, number>, // domain -> count
      linksToNonIndexable: [] as Record<string, any>[],
      linkDepth: null as number | null,
      issues: [] as Record<string, any>[],
      warnings: [] as Record<string, any>[],
      internalLinkRatio: 0,
      externalLinkRatio: 0,
      nofollowRatio: 0,
    };

    // Get all links with detailed information
    const linkElements = await chromePage.evaluate(({ currentUrl, origin }) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links.map(link => {
        const href = (link as HTMLAnchorElement).href;
        const anchorText = link.textContent?.trim() || link.getAttribute('aria-label') || '';
        const rel = (link as HTMLAnchorElement).rel || '';
        const isNofollow = rel.includes('nofollow');
        const isExternal = href && !href.startsWith(origin) && !href.startsWith('/') && !href.startsWith('#');
        const isInternal = href && (href.startsWith(origin) || href.startsWith('/')) && !href.startsWith('#');

        return {
          href,
          anchorText,
          rel,
          isNofollow,
          isExternal,
          isInternal,
          target: (link as HTMLAnchorElement).target,
          classList: Array.from(link.classList),
        };
      });
    }, { currentUrl: url, origin });

    linkAnalysis.totalLinks = linkElements.length;

    // Analyze each link
    for (const link of linkElements) {
      // Count internal vs external
      if (link.isInternal) {
        linkAnalysis.internalLinks++;
      } else if (link.isExternal) {
        linkAnalysis.externalLinks++;

        // Track external domains
        try {
          const domain = new URL(link.href).hostname;
          linkAnalysis.externalDomains[domain] = (linkAnalysis.externalDomains[domain] || 0) + 1;
        } catch (e) {
          // Invalid URL, skip
        }
      }

      // Count nofollow vs follow
      if (link.isNofollow) {
        linkAnalysis.nofollowLinks++;
      } else {
        linkAnalysis.followLinks++;
      }

      // Check anchor text quality
      if (!link.anchorText || link.anchorText.length === 0) {
        linkAnalysis.emptyAnchorLinks.push({
          href: link.href,
          rel: link.rel
        });
      } else {
        // Track anchor text
        const anchorKey = link.anchorText.toLowerCase();
        linkAnalysis.anchorTextMap[anchorKey] = (linkAnalysis.anchorTextMap[anchorKey] || 0) + 1;

        // Check for generic anchor text
        const genericPhrases = [
          'click here', 'read more', 'learn more', 'more info', 'more information',
          'here', 'this', 'link', 'website', 'page', 'more', 'continue reading',
          'find out more', 'see more', 'view more', 'download', 'click'
        ];

        if (genericPhrases.includes(link.anchorText.toLowerCase())) {
          linkAnalysis.genericAnchorLinks.push({
            href: link.href,
            anchorText: link.anchorText
          });
        }
      }

      // Check if link points to non-indexable page
      if (link.isInternal && allPages[link.href]) {
        const targetPage = allPages[link.href];
        if (targetPage.indexability && !targetPage.indexability.isIndexable) {
          linkAnalysis.linksToNonIndexable.push({
            href: link.href,
            reason: targetPage.indexability.blockingFactors.join(', ')
          });
        }

        // Check if link points to a redirect
        if (targetPage.crawlability && targetPage.crawlability.redirectChain.length > 0) {
          linkAnalysis.redirectLinks.push({
            href: link.href,
            redirectsTo: targetPage.crawlability.redirectChain[targetPage.crawlability.redirectChain.length - 1]
          });
        }
      }
    }

    // Check broken links by looking at already crawled pages
    for (const link of linkElements) {
      if (link.isInternal && allPages[link.href]) {
        const targetPage = allPages[link.href];
        if (targetPage.statusCode && targetPage.statusCode >= 400) {
          linkAnalysis.brokenLinks.push({
            href: link.href,
            statusCode: targetPage.statusCode,
            anchorText: link.anchorText
          });
        }
      }
    }

    // Detect anchor text over-optimization
    const duplicateAnchors = [];
    for (const [anchorText, count] of Object.entries(linkAnalysis.anchorTextMap) as [string, number][]) {
      if (count > 5 && anchorText.length > 3) {
        duplicateAnchors.push({ anchorText, count });
      }
    }

    if (duplicateAnchors.length > 0) {
      linkAnalysis.warnings.push({
        type: 'Duplicate anchor text',
        details: duplicateAnchors
      });
    }

    // Report issues
    if (linkAnalysis.emptyAnchorLinks.length > 0) {
      linkAnalysis.issues.push({
        type: 'Empty anchor text',
        count: linkAnalysis.emptyAnchorLinks.length,
        severity: 'medium'
      });
    }

    if (linkAnalysis.genericAnchorLinks.length > 3) {
      linkAnalysis.issues.push({
        type: 'Generic anchor text',
        count: linkAnalysis.genericAnchorLinks.length,
        severity: 'low'
      });
    }

    if (linkAnalysis.brokenLinks.length > 0) {
      linkAnalysis.issues.push({
        type: 'Broken internal links',
        count: linkAnalysis.brokenLinks.length,
        severity: 'high'
      });
    }

    if (linkAnalysis.linksToNonIndexable.length > 0) {
      linkAnalysis.issues.push({
        type: 'Links to non-indexable pages',
        count: linkAnalysis.linksToNonIndexable.length,
        severity: 'medium'
      });
    }

    if (linkAnalysis.redirectLinks.length > 0) {
      linkAnalysis.issues.push({
        type: 'Links pointing to redirects',
        count: linkAnalysis.redirectLinks.length,
        details: linkAnalysis.redirectLinks.slice(0, 5).map(l => `${l.href} -> ${l.redirectsTo}`),
        severity: linkAnalysis.redirectLinks.length > 5 ? 'medium' : 'low'
      });
    }

    // Check for nofollow on internal links
    const internalNofollowLinks = linkElements.filter(l => l.isInternal && l.isNofollow);
    (linkAnalysis as Record<string, any>).internalNofollowLinks = internalNofollowLinks.map(l => ({
      href: l.href,
      anchorText: l.anchorText,
    }));

    if (internalNofollowLinks.length > 0) {
      linkAnalysis.issues.push({
        type: 'Internal links with nofollow',
        count: internalNofollowLinks.length,
        details: internalNofollowLinks.slice(0, 5).map(l => l.href),
        severity: internalNofollowLinks.length > 3 ? 'medium' : 'low'
      });
    }

    // Check for too many on-page links
    if (linkAnalysis.totalLinks > 150) {
      linkAnalysis.issues.push({
        type: 'Too many on-page links',
        count: linkAnalysis.totalLinks,
        severity: linkAnalysis.totalLinks > 300 ? 'high' : 'medium'
      });
    }

    // Calculate link ratios
    if (linkAnalysis.totalLinks > 0) {
      linkAnalysis.internalLinkRatio = Math.round((linkAnalysis.internalLinks / linkAnalysis.totalLinks) * 100);
      linkAnalysis.externalLinkRatio = Math.round((linkAnalysis.externalLinks / linkAnalysis.totalLinks) * 100);
      linkAnalysis.nofollowRatio = Math.round((linkAnalysis.nofollowLinks / linkAnalysis.totalLinks) * 100);
    }

    return linkAnalysis;
  }
}

export { LinkQualityAnalyzer };