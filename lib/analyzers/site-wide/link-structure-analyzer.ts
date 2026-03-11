import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

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
  static analyzeLinkStructure(allPages: Record<string, PageInfo>, incomingLinks: Record<string, any>) {
    console.log('\nAnalyzing site-wide link structure...');

    const linkStats: Record<string, any> = {
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
        : (typeof linkData.brokenLinks === 'number' ? linkData.brokenLinks : 0);
      if (brokenCount > 0) {
        linkStats.totalBrokenLinks += brokenCount;
        linkStats.brokenLinksByPage.set(url, brokenCount);
        linkStats.pagesWithBrokenLinks++;
      }

      // Track hub pages (pages with many outbound links)
      if (linkData.internalLinks > 20) {
        linkStats.hubPages.push({
          url,
          internalLinks: linkData.internalLinks,
          externalLinks: linkData.externalLinks,
          totalLinks: (linkData.internalLinks || 0) + (linkData.externalLinks || 0),
        });
      }

      // Track pages with excessive total links
      const totalPageLinks = (linkData.internalLinks || 0) + (linkData.externalLinks || 0);
      if (totalPageLinks > 150) {
        if (!linkStats.excessiveLinkPages) linkStats.excessiveLinkPages = [];
        linkStats.excessiveLinkPages.push({
          url,
          totalLinks: totalPageLinks,
          internalLinks: linkData.internalLinks,
          externalLinks: linkData.externalLinks,
        });
      }

      // Track internal nofollow links
      if (linkData.internalNofollowLinks?.length > 0) {
        if (!linkStats.totalInternalNofollow) linkStats.totalInternalNofollow = 0;
        linkStats.totalInternalNofollow += linkData.internalNofollowLinks.length;
        if (!linkStats.pagesWithInternalNofollow) linkStats.pagesWithInternalNofollow = 0;
        linkStats.pagesWithInternalNofollow++;
      }

      // Track anchor text diversity
      // Handle both Map (fresh data) and plain object (restored from JSON)
      const anchorTextEntries = linkData.anchorTextMap instanceof Map
        ? linkData.anchorTextMap
        : Object.entries(linkData.anchorTextMap || {});

      for (const [anchorText, count] of anchorTextEntries) {
        if (!linkStats.anchorTextDiversity.has(anchorText)) {
          linkStats.anchorTextDiversity.set(anchorText, new Set());
        }
        linkStats.anchorTextDiversity.get(anchorText).add(url);
      }

      // Track external domains
      // Handle both Map (fresh data) and plain object (restored from JSON)
      const externalDomainEntries = linkData.externalDomains instanceof Map
        ? linkData.externalDomains
        : Object.entries(linkData.externalDomains || {});

      for (const [domain, count] of externalDomainEntries) {
        linkStats.externalDomains.set(
          domain,
          (linkStats.externalDomains.get(domain) || 0) + count
        );
      }

      // Sum up for averages
      totalInternalLinks += linkData.internalLinks || 0;
      totalExternalLinks += linkData.externalLinks || 0;
      linkStats.totalGenericAnchors += linkData.genericAnchorLinks?.length || 0;
    }

    // Calculate averages
    if (pagesAnalyzed > 0) {
      linkStats.avgInternalLinks = Math.round(totalInternalLinks / pagesAnalyzed);
      linkStats.avgExternalLinks = Math.round(totalExternalLinks / pagesAnalyzed);
    }

    // Sort hub pages by outbound link count
    linkStats.hubPages.sort((a: any, b: any) => b.internalLinks - a.internalLinks);

    // Get most linked pages from existing incoming links data
    const mostLinked = [];
    for (const url in allPages) {
      const incomingCount = incomingLinks[url] || 0;
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
      const topBrokenPages = (Array.from(linkStats.brokenLinksByPage.entries()) as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([url, count]: [string, number]) => `<li><a href="${url}">${url}</a> (${count} broken links)</li>`)
        .join('');

      issues.push({
        title: `Site has broken internal links`,
        description: `Total of ${linkStats.totalBrokenLinks} broken link(s) found across ${linkStats.pagesWithBrokenLinks} page(s). Pages with most broken links:<ul>${topBrokenPages}</ul>`,
        severity: SEVERITY.HIGH
      });
    }

    // Report 2: Hub pages (potential link equity distribution issues)
    if (linkStats.hubPages.length > 10) {
      const topHubs = linkStats.hubPages.slice(0, 5).map((hub: any) =>
        `<li><a href="${hub.url}">${hub.url}</a> (${hub.internalLinks} internal links)</li>`
      ).join('');

      issues.push({
        title: `Many hub pages with excessive outbound links`,
        description: `${linkStats.hubPages.length} page(s) have more than 20 internal links. Consider if these pages are diluting link equity:<ul>${topHubs}</ul>`,
        severity: SEVERITY.LOW
      });
    }

    // Report 3: Generic anchor text usage
    if (linkStats.totalGenericAnchors > pagesAnalyzed * 2) {
      issues.push({
        title: `Excessive use of generic anchor text site-wide`,
        description: `${linkStats.totalGenericAnchors} links use generic anchor text (click here, read more, etc.) across the site. Use descriptive, keyword-rich anchor text instead.`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 4: External link concentration
    const topExternalDomains = (Array.from(linkStats.externalDomains.entries()) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topExternalDomains.length > 0 && topExternalDomains[0][1] > pagesAnalyzed * 0.5) {
      const domainList = topExternalDomains.map(([domain, count]: [string, number]) =>
        `<li>${domain}: ${count} links</li>`
      ).join('');

      issues.push({
        title: `High concentration of external links to few domains`,
        description: `Most external links point to just a few domains. Top external domains:<ul>${domainList}</ul>`,
        severity: SEVERITY.LOW
      });
    }

    // Report 5: Pages with excessive total links (>150)
    if (linkStats.excessiveLinkPages?.length > 0) {
      const topExcessive = linkStats.excessiveLinkPages
        .sort((a: any, b: any) => b.totalLinks - a.totalLinks)
        .slice(0, 5)
        .map((p: any) => `<li><a href="${p.url}">${p.url}</a> (${p.totalLinks} total links)</li>`)
        .join('');

      issues.push({
        title: `${linkStats.excessiveLinkPages.length} page(s) have more than 150 links`,
        description: `Pages with too many links dilute link equity and may signal low quality to search engines:<ul>${topExcessive}</ul>`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 6: Internal nofollow links
    if (linkStats.totalInternalNofollow > 0) {
      issues.push({
        title: `Internal links using nofollow attribute`,
        description: `${linkStats.totalInternalNofollow} internal link(s) across ${linkStats.pagesWithInternalNofollow} page(s) use rel="nofollow". Internal nofollow wastes crawl budget and prevents PageRank flow to your own pages. Remove nofollow from internal links unless intentionally blocking low-value pages.`,
        severity: SEVERITY.MEDIUM
      });
    }

    // Report 7: Anchor text over-optimization (renamed from 5)
    const overOptimizedAnchors = [];
    for (const [anchorText, pagesUsing] of linkStats.anchorTextDiversity) {
      if (pagesUsing.size > pagesAnalyzed * 0.3 && anchorText.length > 3) {
        overOptimizedAnchors.push({
          anchorText,
          pageCount: pagesUsing.size
        });
      }
    }

    if (overOptimizedAnchors.length > 0) {
      const anchorList = overOptimizedAnchors.slice(0, 5).map(item =>
        `<li>"${item.anchorText}" (used on ${item.pageCount} pages)</li>`
      ).join('');

      issues.push({
        title: `Potential anchor text over-optimization`,
        description: `${overOptimizedAnchors.length} anchor text(s) are used on >30% of pages, which may appear unnatural:<ul>${anchorList}</ul>`,
        severity: SEVERITY.MEDIUM
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
      }
    };
  }
}

export { LinkStructureAnalyzer };