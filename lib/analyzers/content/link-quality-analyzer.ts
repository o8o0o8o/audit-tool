import { THRESHOLDS, GENERIC_ANCHORS } from '../../constants';
import { getHostname, calcPercent } from '../../utils';
import type { ChromePage, ParsedPage, PageInfo } from '../../types';

class LinkQualityAnalyzer {
  static async analyzeLinkQuality(
    chromePage: ChromePage | null,
    parsedPage: ParsedPage,
    url: string,
    origin: string,
    allPages: Record<string, PageInfo>,
  ) {
    const linkAnalysis = {
      totalLinks: 0,
      internalLinks: 0,
      externalLinks: 0,
      nofollowLinks: 0,
      followLinks: 0,
      brokenLinks: [] as { href: string; statusCode: number; anchorText: string }[],
      redirectLinks: [] as { href: string; redirectsTo: string }[],
      emptyAnchorLinks: [] as { href: string; rel: string }[],
      genericAnchorLinks: [] as { href: string; anchorText: string }[],
      anchorTextMap: {} as Record<string, number>, // anchor text -> count
      externalDomains: {} as Record<string, number>, // domain -> count
      linksToNonIndexable: [] as { href: string; reason: string }[],
      linkDepth: null as number | null,
      issues: [] as { message: string; count?: number; severity: string; details?: string[] }[],
      warnings: [] as { message: string; details?: { anchorText: string; count: number }[] }[],
      internalLinkRatio: 0,
      externalLinkRatio: 0,
      nofollowRatio: 0,
      internalNofollowLinks: [] as { href: string; anchorText: string }[],
    };

    // Get all links with detailed information. In no-playwright mode read the
    // same set from the parsed HTML, resolving hrefs to absolute (mirroring the
    // browser's `link.href`) — faithful for server-rendered anchors.
    const linkElements = chromePage
      ? await chromePage.evaluate(
          ({ currentUrl: _currentUrl, origin }) => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.map((link) => {
              const href = (link as HTMLAnchorElement).href;
              const anchorText = link.textContent?.trim() ?? link.getAttribute('aria-label') ?? '';
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
          },
          { currentUrl: url, origin },
        )
      : parsedPage.querySelectorAll('a[href]').map((link) => {
          const rawHref = link.getAttribute('href') ?? '';
          let href = rawHref;
          try {
            href = rawHref ? new URL(rawHref, url).href : '';
          } catch {
            /* leave raw */
          }
          const anchorText = (link.text?.trim() || link.getAttribute('aria-label') || '').trim();
          const rel = link.getAttribute('rel') ?? '';
          const isNofollow = rel.includes('nofollow');
          const isExternal = !!href && !href.startsWith(origin) && !rawHref.startsWith('/') && !rawHref.startsWith('#');
          const isInternal = !!href && (href.startsWith(origin) || rawHref.startsWith('/')) && !rawHref.startsWith('#');
          const classAttr = link.getAttribute('class') ?? '';
          return {
            href,
            anchorText,
            rel,
            isNofollow,
            isExternal,
            isInternal,
            target: link.getAttribute('target') ?? '',
            classList: classAttr ? classAttr.split(/\s+/).filter(Boolean) : [],
          };
        });

    linkAnalysis.totalLinks = linkElements.length;

    // Analyze each link
    for (const link of linkElements) {
      // Count internal vs external
      if (link.isInternal) {
        linkAnalysis.internalLinks++;
      } else if (link.isExternal) {
        linkAnalysis.externalLinks++;

        // Track external domains
        const domain = getHostname(link.href);
        if (domain) {
          linkAnalysis.externalDomains[domain] = (linkAnalysis.externalDomains[domain] || 0) + 1;
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
          rel: link.rel,
        });
      } else {
        // Track anchor text
        const anchorKey = link.anchorText.toLowerCase();
        linkAnalysis.anchorTextMap[anchorKey] = (linkAnalysis.anchorTextMap[anchorKey] || 0) + 1;

        // Check for generic anchor text
        if ((GENERIC_ANCHORS as readonly string[]).includes(link.anchorText.toLowerCase())) {
          linkAnalysis.genericAnchorLinks.push({
            href: link.href,
            anchorText: link.anchorText,
          });
        }
      }

      // Check if link points to non-indexable page
      if (link.isInternal && allPages[link.href]) {
        const targetPage = allPages[link.href];
        if (targetPage.indexability && !targetPage.indexability.isIndexable) {
          linkAnalysis.linksToNonIndexable.push({
            href: link.href,
            reason: targetPage.indexability.blockingFactors.join(', '),
          });
        }

        // Check if link points to a redirect
        if (targetPage.crawlability && targetPage.crawlability.redirectChain.length > 0) {
          linkAnalysis.redirectLinks.push({
            href: link.href,
            redirectsTo: targetPage.crawlability.redirectChain[targetPage.crawlability.redirectChain.length - 1],
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
            anchorText: link.anchorText,
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
        message: 'Duplicate anchor text',
        details: duplicateAnchors,
      });
    }

    // Report issues
    if (linkAnalysis.emptyAnchorLinks.length > 0) {
      linkAnalysis.issues.push({
        message: 'Empty anchor text',
        count: linkAnalysis.emptyAnchorLinks.length,
        severity: 'medium',
      });
    }

    if (linkAnalysis.genericAnchorLinks.length > 3) {
      linkAnalysis.issues.push({
        message: 'Generic anchor text',
        count: linkAnalysis.genericAnchorLinks.length,
        severity: 'low',
      });
    }

    if (linkAnalysis.brokenLinks.length > 0) {
      linkAnalysis.issues.push({
        message: 'Broken internal links',
        count: linkAnalysis.brokenLinks.length,
        severity: 'high',
      });
    }

    if (linkAnalysis.linksToNonIndexable.length > 0) {
      linkAnalysis.issues.push({
        message: 'Links to non-indexable pages',
        count: linkAnalysis.linksToNonIndexable.length,
        severity: 'medium',
      });
    }

    if (linkAnalysis.redirectLinks.length > 0) {
      linkAnalysis.issues.push({
        message: 'Links pointing to redirects',
        count: linkAnalysis.redirectLinks.length,
        details: linkAnalysis.redirectLinks.slice(0, 5).map((l) => `${l.href} -> ${l.redirectsTo}`),
        severity: linkAnalysis.redirectLinks.length > 5 ? 'medium' : 'low',
      });
    }

    // Check for nofollow on internal links
    const internalNofollowLinks = linkElements.filter((l) => l.isInternal && l.isNofollow);
    linkAnalysis.internalNofollowLinks = internalNofollowLinks.map((l) => ({
      href: l.href,
      anchorText: l.anchorText,
    }));

    if (internalNofollowLinks.length > 0) {
      linkAnalysis.issues.push({
        message: 'Internal links with nofollow',
        count: internalNofollowLinks.length,
        details: internalNofollowLinks.slice(0, 5).map((l) => l.href),
        severity: internalNofollowLinks.length > 3 ? 'medium' : 'low',
      });
    }

    // Check for too many on-page links
    if (linkAnalysis.totalLinks > THRESHOLDS.LINKS_PER_PAGE_WARNING) {
      linkAnalysis.issues.push({
        message: 'Too many on-page links',
        count: linkAnalysis.totalLinks,
        severity: linkAnalysis.totalLinks > THRESHOLDS.LINKS_PER_PAGE_MAX ? 'high' : 'medium',
      });
    }

    // Calculate link ratios
    if (linkAnalysis.totalLinks > 0) {
      linkAnalysis.internalLinkRatio = calcPercent(linkAnalysis.internalLinks, linkAnalysis.totalLinks);
      linkAnalysis.externalLinkRatio = calcPercent(linkAnalysis.externalLinks, linkAnalysis.totalLinks);
      linkAnalysis.nofollowRatio = calcPercent(linkAnalysis.nofollowLinks, linkAnalysis.totalLinks);
    }

    return linkAnalysis;
  }
}

export { LinkQualityAnalyzer };
