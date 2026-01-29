class LinkQualityAnalyzer {
  static async analyzeLinkQuality(chromePage, parsedPage, url, origin, allPages) {
    const linkAnalysis = {
      totalLinks: 0,
      internalLinks: 0,
      externalLinks: 0,
      nofollowLinks: 0,
      followLinks: 0,
      brokenLinks: [],
      redirectLinks: [],
      emptyAnchorLinks: [],
      genericAnchorLinks: [],
      anchorTextMap: new Map(), // anchor text -> count
      externalDomains: new Map(), // domain -> count
      linksToNonIndexable: [],
      linkDepth: null,
      issues: [],
      warnings: [],
    };

    // Get all links with detailed information
    const linkElements = await chromePage.evaluate(({ currentUrl, origin }) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links.map(link => {
        const href = link.href;
        const anchorText = link.textContent?.trim() || link.getAttribute('aria-label') || '';
        const rel = link.rel || '';
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
          target: link.target,
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
          linkAnalysis.externalDomains.set(domain, (linkAnalysis.externalDomains.get(domain) || 0) + 1);
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
        linkAnalysis.anchorTextMap.set(
          link.anchorText.toLowerCase(),
          (linkAnalysis.anchorTextMap.get(link.anchorText.toLowerCase()) || 0) + 1
        );

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
    for (const [anchorText, count] of linkAnalysis.anchorTextMap) {
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
        severity: 'MEDIUM'
      });
    }

    if (linkAnalysis.genericAnchorLinks.length > 3) {
      linkAnalysis.issues.push({
        type: 'Generic anchor text',
        count: linkAnalysis.genericAnchorLinks.length,
        severity: 'LOW'
      });
    }

    if (linkAnalysis.brokenLinks.length > 0) {
      linkAnalysis.issues.push({
        type: 'Broken internal links',
        count: linkAnalysis.brokenLinks.length,
        severity: 'HIGH'
      });
    }

    if (linkAnalysis.linksToNonIndexable.length > 0) {
      linkAnalysis.issues.push({
        type: 'Links to non-indexable pages',
        count: linkAnalysis.linksToNonIndexable.length,
        severity: 'MEDIUM'
      });
    }

    if (linkAnalysis.redirectLinks.length > 2) {
      linkAnalysis.issues.push({
        type: 'Links to redirects',
        count: linkAnalysis.redirectLinks.length,
        severity: 'LOW'
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

module.exports = { LinkQualityAnalyzer };
