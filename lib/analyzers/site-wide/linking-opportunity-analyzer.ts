import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Internal Linking Opportunity Analyzer
 * Identifies pages that should link to each other based on content similarity.
 * Similar to Ahrefs' internal linking opportunities feature.
 */
class LinkingOpportunityAnalyzer {
  /**
   * Analyze internal linking opportunities across all pages
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @param {string} origin - Site origin URL
   * @returns {Object} { opportunities: [], stats: {}, issues: [] }
   */
  static analyze(allPages: Record<string, PageInfo>, origin: string) {
    console.log('\nAnalyzing internal linking opportunities...');

    // Step 1: Build keyword-to-pages index
    const keywordIndex = this.buildKeywordIndex(allPages);

    // Step 2: Build existing links index
    const existingLinks = this.buildExistingLinksIndex(allPages);

    // Step 3: Find linking opportunities
    const opportunities = this.findOpportunities(allPages, keywordIndex, existingLinks, origin);

    // Step 4: Calculate stats
    const stats = {
      totalOpportunities: opportunities.length,
      avgRelevanceScore: opportunities.length > 0
        ? (opportunities.reduce((sum, o) => sum + o.relevanceScore, 0) / opportunities.length).toFixed(2)
        : 0,
      pagesWithOpportunities: new Set(opportunities.map(o => o.sourcePage)).size,
      potentialNewLinks: opportunities.reduce((sum, o) => sum + o.suggestedLinks.length, 0),
    };

    // Step 5: Generate issues
    const issues = this.generateIssues(opportunities, allPages);

    console.log(`Linking opportunities found: ${stats.totalOpportunities}`);
    console.log(`Potential new internal links: ${stats.potentialNewLinks}`);

    return {
      opportunities: opportunities.slice(0, 50), // Limit to top 50 for report
      stats,
      issues,
    };
  }

  /**
   * Build keyword index: keyword -> Set of URLs with context
   * @param {Object} allPages - All page data
   * @returns {Map} Keyword index
   */
  static buildKeywordIndex(allPages: Record<string, PageInfo>) {
    const keywordIndex = new Map();

    for (const url in allPages) {
      const page = allPages[url];
      const topKeywords = page.contentQuality?.topKeywords || [];
      const title = (page.title || '').toLowerCase();

      // Index top keywords
      topKeywords.forEach((kw: any) => {
        const word = kw.word.toLowerCase();
        if (word.length < 4) return; // Skip very short words

        if (!keywordIndex.has(word)) {
          keywordIndex.set(word, new Map());
        }

        keywordIndex.get(word).set(url, {
          density: parseFloat(kw.density) || 0,
          count: kw.count || 1,
          inTitle: title.includes(word),
        });
      });

      // Also index significant words from title
      const titleWords = title.split(/\s+/).filter((w: any) => w.length >= 4);
      titleWords.forEach((word: any) => {
        if (!keywordIndex.has(word)) {
          keywordIndex.set(word, new Map());
        }
        if (!keywordIndex.get(word).has(url)) {
          keywordIndex.get(word).set(url, {
            density: 0,
            count: 0,
            inTitle: true,
          });
        } else {
          keywordIndex.get(word).get(url).inTitle = true;
        }
      });
    }

    return keywordIndex;
  }

  /**
   * Build existing links index: sourceUrl -> Set of targetUrls
   * @param {Object} allPages - All page data
   * @returns {Map} Existing links index
   */
  static buildExistingLinksIndex(allPages: Record<string, PageInfo>) {
    const existingLinks = new Map();

    for (const url in allPages) {
      const page = allPages[url];
      const links = new Set();

      // Get outbound links from the page
      if (page.links && Array.isArray(page.links)) {
        page.links.forEach((link: any) => {
          if (link.href) {
            links.add(this.normalizeUrl(link.href));
          }
        });
      }

      // Also check linkAnalysis if available
      if (page.linkAnalysis?.internalLinkUrls) {
        page.linkAnalysis.internalLinkUrls.forEach((href: any) => {
          links.add(this.normalizeUrl(href));
        });
      }

      existingLinks.set(this.normalizeUrl(url), links);
    }

    return existingLinks;
  }

  /**
   * Normalize URL for comparison
   * @param {string} url - URL to normalize
   * @returns {string} Normalized URL
   */
  static normalizeUrl(url: string) {
    try {
      const parsed = new URL(url);
      // Remove trailing slash, lowercase, remove query params for comparison
      return parsed.origin + parsed.pathname.replace(/\/$/, '').toLowerCase();
    } catch {
      return url.toLowerCase().replace(/\/$/, '');
    }
  }

  /**
   * Find linking opportunities between pages
   * @param {Object} allPages - All page data
   * @param {Map} keywordIndex - Keyword index
   * @param {Map} existingLinks - Existing links index
   * @param {string} origin - Site origin
   * @returns {Array} Linking opportunities
   */
  static findOpportunities(allPages: Record<string, PageInfo>, keywordIndex: Map<string, any>, existingLinks: Map<string, Set<string>>, origin: string) {
    const opportunities = [];
    const urlList = Object.keys(allPages);

    // For each page, find related pages that aren't linked
    for (const sourceUrl of urlList) {
      const sourcePage = allPages[sourceUrl];
      const sourceNormalized = this.normalizeUrl(sourceUrl);
      const sourceLinks = existingLinks.get(sourceNormalized) || new Set();

      // Get source page keywords
      const sourceKeywords = new Set();
      (sourcePage.contentQuality?.topKeywords || []).forEach((kw: any) => {
        if (kw.word.length >= 4) sourceKeywords.add(kw.word.toLowerCase());
      });

      if (sourceKeywords.size === 0) continue;

      // Find related pages
      const relatedPages = new Map(); // targetUrl -> { sharedKeywords, relevanceScore }

      sourceKeywords.forEach(keyword => {
        const pagesWithKeyword = keywordIndex.get(keyword as string);
        if (!pagesWithKeyword) return;

        pagesWithKeyword.forEach((keywordData: Record<string, any>, targetUrl: string) => {
          // Skip same page and pages we already link to
          if (targetUrl === sourceUrl) return;
          const targetNormalized = this.normalizeUrl(targetUrl);
          if (targetNormalized === sourceNormalized) return;
          if (sourceLinks.has(targetNormalized)) return;

          // Check if target is in same origin
          try {
            if (!targetUrl.startsWith(origin)) return;
          } catch {
            return;
          }

          if (!relatedPages.has(targetUrl)) {
            relatedPages.set(targetUrl, {
              sharedKeywords: [],
              relevanceScore: 0,
            });
          }

          const entry = relatedPages.get(targetUrl);
          entry.sharedKeywords.push({
            keyword,
            inTargetTitle: keywordData.inTitle,
            targetDensity: keywordData.density,
          });
        });
      });

      // Calculate relevance scores and filter
      const suggestedLinks: Record<string, any>[] = [];

      relatedPages.forEach((data, targetUrl) => {
        if (data.sharedKeywords.length < 2) return; // Require at least 2 shared keywords

        // Calculate relevance score
        let score = 0;

        // Points for number of shared keywords
        score += Math.min(data.sharedKeywords.length * 10, 40);

        // Points for keywords in target title
        const titleMatches = data.sharedKeywords.filter((k: any) => k.inTargetTitle).length;
        score += titleMatches * 15;

        // Points for high density keywords
        const avgDensity = data.sharedKeywords.reduce((sum: any, k: any) => sum + k.targetDensity, 0) / data.sharedKeywords.length;
        score += Math.min(avgDensity * 5, 20);

        // Store if score is significant
        if (score >= 30) {
          suggestedLinks.push({
            targetUrl,
            sharedKeywords: data.sharedKeywords.slice(0, 5).map((k: any) => k.keyword),
            relevanceScore: Math.min(Math.round(score), 100),
            anchorTextSuggestion: this.suggestAnchorText(data.sharedKeywords, allPages[targetUrl]),
          });
        }
      });

      // Add opportunity if we found good links
      if (suggestedLinks.length > 0) {
        // Sort by relevance score
        suggestedLinks.sort((a, b) => b.relevanceScore - a.relevanceScore);

        opportunities.push({
          sourcePage: sourceUrl,
          sourceTitle: sourcePage.title || 'Untitled',
          suggestedLinks: suggestedLinks.slice(0, 5), // Top 5 per source page
          relevanceScore: suggestedLinks[0].relevanceScore, // Use top link score
          totalMissedLinks: suggestedLinks.length,
        });
      }
    }

    // Sort by opportunity score (sum of all suggested link scores)
    opportunities.sort((a, b) => {
      const scoreA = a.suggestedLinks.reduce((sum, l) => sum + l.relevanceScore, 0);
      const scoreB = b.suggestedLinks.reduce((sum, l) => sum + l.relevanceScore, 0);
      return scoreB - scoreA;
    });

    return opportunities;
  }

  /**
   * Suggest anchor text for a link based on shared keywords and target page
   * @param {Array} sharedKeywords - Shared keywords data
   * @param {Object} targetPage - Target page data
   * @returns {string} Suggested anchor text
   */
  static suggestAnchorText(sharedKeywords: Record<string, any>[], _targetPage: PageInfo) {
    // Prefer keyword that's in target title
    const titleKeyword = sharedKeywords.find(k => k.inTargetTitle);
    if (titleKeyword) {
      return titleKeyword.keyword;
    }

    // Use highest density keyword
    const sortedByDensity = [...sharedKeywords].sort((a, b) => b.targetDensity - a.targetDensity);
    if (sortedByDensity.length > 0) {
      return sortedByDensity[0].keyword;
    }

    // Fallback to first shared keyword
    return sharedKeywords[0]?.keyword || 'related content';
  }

  /**
   * Generate issues for the report
   * @param {Array} opportunities - Linking opportunities
   * @param {Object} allPages - All page data
   * @returns {Array} Issues array
   */
  static generateIssues(opportunities: Record<string, any>[], allPages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const totalPages = Object.keys(allPages).length;

    // Issue 1: Many pages with linking opportunities
    if (opportunities.length > totalPages * 0.3) {
      const highValueOpps = opportunities.filter(o => o.relevanceScore >= 60);
      issues.push({
        message: 'Significant internal linking opportunities',
        detail: `${opportunities.length} pages could benefit from additional internal links. ${highValueOpps.length} have high-value opportunities (score ≥60). Improving internal linking can boost page authority and help search engines discover content.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Issue 2: Very high-value opportunities
    const excellentOpps = opportunities.filter(o => o.relevanceScore >= 80);
    if (excellentOpps.length > 5) {
      const topPages = excellentOpps.slice(0, 3).map(o => o.sourcePage.split('/').pop() || 'homepage').join(', ');
      issues.push({
        message: 'High-impact linking opportunities available',
        detail: `${excellentOpps.length} pages have excellent internal linking opportunities (score ≥80). Top pages: ${topPages}. These links would significantly improve content discoverability.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Issue 3: Potential orphan pages (pages with opportunities to link TO but not FROM)
    const targetedPages = new Set();
    opportunities.forEach(o => {
      o.suggestedLinks.forEach((l: any) => targetedPages.add(l.targetUrl));
    });

    const orphanCandidates = [];
    for (const url in allPages) {
      const page = allPages[url];
      const incomingCount = page.incomingLinksCount || 0;
      if (incomingCount <= 1 && targetedPages.has(url)) {
        orphanCandidates.push(url);
      }
    }

    if (orphanCandidates.length > 5) {
      issues.push({
        message: 'Pages with few links could receive more',
        detail: `${orphanCandidates.length} pages have very few incoming links but share content themes with other pages. Adding links to these pages would improve their visibility.`,
        severity: SEVERITY.LOW,
      });
    }

    return issues;
  }
}

export { LinkingOpportunityAnalyzer };