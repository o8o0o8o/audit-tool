import { SEVERITY, THRESHOLDS } from '../../constants';
import { incrementCounter, getTopEntries, escapeHtml, getIncomingLinkCount, normalizeToEntries } from '../../utils';
import type { Issue, PageInfo } from '../../types';

interface HubPage {
  url: string;
  internalLinks: number;
  externalLinks: number;
  totalLinks: number;
}

interface ExcessiveLinkPage {
  url: string;
  totalLinks: number;
  internalLinks: number;
  externalLinks: number;
}

interface LinkStats {
  totalBrokenLinks: number;
  brokenLinksByPage: Map<string, number>;
  mostLinkedPages: Map<string, number>;
  hubPages: HubPage[];
  anchorTextDiversity: Map<string, Set<string>>;
  externalDomains: Map<string, number>;
  orphanedPages: string[];
  avgInternalLinks: number;
  avgExternalLinks: number;
  totalGenericAnchors: number;
  pagesWithBrokenLinks: number;
  excessiveLinkPages?: ExcessiveLinkPage[];
  totalInternalNofollow?: number;
  pagesWithInternalNofollow?: number;
}

/**
 * Site-wide Link Structure Analyzer
 * Analyzes internal and external link patterns across all pages.
 */
class LinkStructureAnalyzer {
  /**
   * Analyze link structure across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @param {Object} incomingLinks - Object with incoming link counts { url: count }
   * @returns {Object} { issues: [], hubPages: [], orphanedPages: [], mostLinkedPages: [] }
   */
  static analyzeLinkStructure(allPages: Record<string, PageInfo>, incomingLinks: Record<string, string[] | number>) {
    console.log('\nAnalyzing site-wide link structure...');

    const linkStats: LinkStats = {
      totalBrokenLinks: 0,
      brokenLinksByPage: new Map(), // URL -> count
      mostLinkedPages: new Map(), // URL -> incoming link count (already tracked)
      hubPages: [], // Pages with most outbound links
      anchorTextDiversity: new Map(), // anchor text -> pages using it
      externalDomains: new Map(), // domain -> count across all pages
      orphanedPages: [],
      avgInternalLinks: 0,
      avgExternalLinks: 0,
      totalGenericAnchors: 0,
      pagesWithBrokenLinks: 0,
    };

    const issues: Issue[] = [];
    let totalInternalLinks = 0;
    let totalExternalLinks = 0;
    let pagesAnalyzed = 0;

    // Analyze each page's link data
    for (const url in allPages) {
      const page = allPages[url];

      if (!page.linkAnalysis) continue;

      pagesAnalyzed++;
      const linkData = page.linkAnalysis;

      // Track broken links (handle both array and number after data stripping)
      const brokenCount = Array.isArray(linkData.brokenLinks)
        ? linkData.brokenLinks.length
        : typeof linkData.brokenLinks === 'number'
          ? linkData.brokenLinks
          : 0;
      if (brokenCount > 0) {
        linkStats.totalBrokenLinks += brokenCount;
        linkStats.brokenLinksByPage.set(url, brokenCount);
        linkStats.pagesWithBrokenLinks++;
      }

      // Track hub pages (pages with many outbound links)
      if ((linkData.internalLinks ?? 0) > 20) {
        linkStats.hubPages.push({
          url,
          internalLinks: linkData.internalLinks ?? 0,
          externalLinks: linkData.externalLinks ?? 0,
          totalLinks: (linkData.internalLinks ?? 0) + (linkData.externalLinks ?? 0),
        });
      }

      // Track pages with excessive total links
      const totalPageLinks = (linkData.internalLinks ?? 0) + (linkData.externalLinks ?? 0);
      if (totalPageLinks > THRESHOLDS.LINKS_PER_PAGE_WARNING) {
        linkStats.excessiveLinkPages ??= [];
        linkStats.excessiveLinkPages.push({
          url,
          totalLinks: totalPageLinks,
          internalLinks: linkData.internalLinks ?? 0,
          externalLinks: linkData.externalLinks ?? 0,
        });
      }

      // Track internal nofollow links
      if ((linkData.internalNofollowLinks?.length ?? 0) > 0) {
        linkStats.totalInternalNofollow ??= 0;
        linkStats.totalInternalNofollow += linkData.internalNofollowLinks!.length;
        linkStats.pagesWithInternalNofollow ??= 0;
        linkStats.pagesWithInternalNofollow++;
      }

      // Track anchor text diversity
      // Handle both Map (fresh data) and plain object (restored from JSON)
      for (const [anchorText, _count] of normalizeToEntries(linkData.anchorTextMap as Record<string, number> | Map<string, number> | undefined)) {
        if (!linkStats.anchorTextDiversity.has(anchorText)) {
          linkStats.anchorTextDiversity.set(anchorText, new Set());
        }
        linkStats.anchorTextDiversity.get(anchorText)!.add(url);
      }

      // Track external domains
      // Handle both Map (fresh data) and plain object (restored from JSON)
      for (const [domain, count] of normalizeToEntries(linkData.externalDomains as Record<string, number> | Map<string, number> | undefined)) {
        incrementCounter(linkStats.externalDomains, domain, count);
      }

      // Sum up for averages
      totalInternalLinks += linkData.internalLinks ?? 0;
      totalExternalLinks += linkData.externalLinks ?? 0;
      linkStats.totalGenericAnchors += linkData.genericAnchorLinks?.length ?? 0;
    }

    // Calculate averages
    if (pagesAnalyzed > 0) {
      linkStats.avgInternalLinks = Math.round(totalInternalLinks / pagesAnalyzed);
      linkStats.avgExternalLinks = Math.round(totalExternalLinks / pagesAnalyzed);
    }

    // Sort hub pages by outbound link count
    linkStats.hubPages.sort((a: HubPage, b: HubPage) => b.internalLinks - a.internalLinks);

    // Get most linked pages from existing incoming links data
    const mostLinked = [];
    for (const url in allPages) {
      const incomingCount = getIncomingLinkCount(incomingLinks as Record<string, unknown>, url);
      if (incomingCount > 0) {
        mostLinked.push({ url, incomingLinks: incomingCount });
      }
    }
    mostLinked.sort((a, b) => b.incomingLinks - a.incomingLinks);

    console.log(`Total broken links across site: ${linkStats.totalBrokenLinks}`);
    console.log(`Average internal links per page: ${linkStats.avgInternalLinks}`);
    console.log(`Hub pages found: ${linkStats.hubPages.length}`);

    // Report 1: Site-wide broken links summary
    if (linkStats.totalBrokenLinks > 0) {
      const topBrokenPages = getTopEntries(linkStats.brokenLinksByPage.entries(), 10)
        .map(([url, count]) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a> (${count} broken links)</li>`)
        .join('');

      issues.push({
        message: `Site has broken internal links`,
        detail: `Total of ${linkStats.totalBrokenLinks} broken link(s) found across ${linkStats.pagesWithBrokenLinks} page(s). Pages with most broken links:<ul>${topBrokenPages}</ul>`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 2: Hub pages (potential link equity distribution issues)
    if (linkStats.hubPages.length > 10) {
      const topHubs = linkStats.hubPages
        .slice(0, 5)
        .map((hub: HubPage) => `<li><a href="${escapeHtml(hub.url)}">${escapeHtml(hub.url)}</a> (${hub.internalLinks} internal links)</li>`)
        .join('');

      issues.push({
        message: `Many hub pages with excessive outbound links`,
        detail: `${linkStats.hubPages.length} page(s) have more than 20 internal links. Consider if these pages are diluting link equity:<ul>${topHubs}</ul>`,
        severity: SEVERITY.LOW,
      });
    }

    // Report 3: Generic anchor text usage
    if (linkStats.totalGenericAnchors > pagesAnalyzed * 2) {
      issues.push({
        message: `Excessive use of generic anchor text site-wide`,
        detail: `${linkStats.totalGenericAnchors} links use generic anchor text (click here, read more, etc.) across the site. Use descriptive, keyword-rich anchor text instead.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 4: External link concentration
    const topExternalDomains = getTopEntries(linkStats.externalDomains.entries(), 5);

    if (topExternalDomains.length > 0 && topExternalDomains[0][1] > pagesAnalyzed * 0.5) {
      const domainList = topExternalDomains
        .map(([domain, count]: [string, number]) => `<li>${escapeHtml(domain)}: ${count} links</li>`)
        .join('');

      issues.push({
        message: `High concentration of external links to few domains`,
        detail: `Most external links point to just a few domains. Top external domains:<ul>${domainList}</ul>`,
        severity: SEVERITY.LOW,
      });
    }

    // Report 5: Pages with excessive total links
    if ((linkStats.excessiveLinkPages?.length ?? 0) > 0) {
      const topExcessive = linkStats
        .excessiveLinkPages!.sort((a: ExcessiveLinkPage, b: ExcessiveLinkPage) => b.totalLinks - a.totalLinks)
        .slice(0, 5)
        .map((p: ExcessiveLinkPage) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a> (${p.totalLinks} total links)</li>`)
        .join('');

      issues.push({
        message: `${linkStats.excessiveLinkPages!.length} page(s) have more than ${THRESHOLDS.LINKS_PER_PAGE_WARNING} links`,
        detail: `Pages with too many links dilute link equity and may signal low quality to search engines:<ul>${topExcessive}</ul>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 6: Internal nofollow links
    if ((linkStats.totalInternalNofollow ?? 0) > 0) {
      issues.push({
        message: `Internal links using nofollow attribute`,
        detail: `${linkStats.totalInternalNofollow} internal link(s) across ${linkStats.pagesWithInternalNofollow} page(s) use rel="nofollow". Internal nofollow wastes crawl budget and prevents PageRank flow to your own pages. Remove nofollow from internal links unless intentionally blocking low-value pages.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 7: Anchor text over-optimization (renamed from 5)
    const overOptimizedAnchors = [];
    for (const [anchorText, pagesUsing] of linkStats.anchorTextDiversity) {
      if (pagesUsing.size > pagesAnalyzed * 0.3 && anchorText.length > 3) {
        overOptimizedAnchors.push({
          anchorText,
          pageCount: pagesUsing.size,
        });
      }
    }

    if (overOptimizedAnchors.length > 0) {
      const anchorList = overOptimizedAnchors
        .slice(0, 5)
        .map((item) => `<li>"${escapeHtml(item.anchorText)}" (used on ${item.pageCount} pages)</li>`)
        .join('');

      issues.push({
        message: `Potential anchor text over-optimization`,
        detail: `${overOptimizedAnchors.length} anchor text(s) are used on >30% of pages, which may appear unnatural:<ul>${anchorList}</ul>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    console.log(`Pages with broken links: ${linkStats.pagesWithBrokenLinks}`);
    console.log(`Most linked page: ${mostLinked[0]?.url} (${mostLinked[0]?.incomingLinks} links)`);

    return {
      issues,
      hubPages: linkStats.hubPages,
      orphanedPages: linkStats.orphanedPages,
      mostLinkedPages: mostLinked.slice(0, 10),
      stats: {
        totalBrokenLinks: linkStats.totalBrokenLinks,
        pagesWithBrokenLinks: linkStats.pagesWithBrokenLinks,
        avgInternalLinks: linkStats.avgInternalLinks,
        avgExternalLinks: linkStats.avgExternalLinks,
        hubPagesCount: linkStats.hubPages.length,
        topExternalDomains: topExternalDomains.map(([domain, count]) => ({ domain, count })),
        totalGenericAnchors: linkStats.totalGenericAnchors,
      },
    };
  }
}

export { LinkStructureAnalyzer };
