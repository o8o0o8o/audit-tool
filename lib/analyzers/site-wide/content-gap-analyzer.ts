import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Content Gap Analyzer
 * Identifies content gaps and opportunities by analyzing keyword coverage across pages.
 * Similar to Ahrefs' content gap analysis feature.
 */
class ContentGapAnalyzer {
  /**
   * Analyze content gaps across all pages
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { gaps: [], coverage: {}, stats: {}, issues: [] }
   */
  static analyze(allPages: Record<string, PageInfo>) {
    console.log('\nAnalyzing content gaps...');

    // Step 1: Aggregate all keywords from pages
    const keywordIndex = this.buildKeywordIndex(allPages);

    // Step 2: Cluster related keywords
    const clusters = this.clusterKeywords(keywordIndex);

    // Step 3: Identify coverage levels
    const coverage = this.analyzeCoverage(clusters);

    // Step 4: Identify content gaps (low coverage topics)
    const gaps = this.identifyGaps(clusters, allPages);

    // Step 5: Generate issues
    const issues = this.generateIssues(gaps, coverage);

    // Step 6: Calculate stats
    const stats = {
      totalKeywords: keywordIndex.size,
      totalClusters: clusters.size,
      highCoverage: coverage.high.length,
      mediumCoverage: coverage.medium.length,
      lowCoverage: coverage.low.length,
      orphanKeywords: coverage.orphan.length,
    };

    console.log(`Keywords indexed: ${stats.totalKeywords}`);
    console.log(`Topic clusters: ${stats.totalClusters}`);
    console.log(`Content gaps identified: ${gaps.length}`);

    return {
      gaps,
      coverage,
      clusters: this.clustersToObject(clusters),
      stats,
      issues,
    };
  }

  /**
   * Build keyword index: keyword -> Set of URLs
   * @param {Object} allPages - All page data
   * @returns {Map} Keyword index
   */
  static buildKeywordIndex(allPages: Record<string, PageInfo>) {
    const keywordIndex = new Map();

    for (const url in allPages) {
      const page = allPages[url];
      const topKeywords = page.contentQuality?.topKeywords || [];

      topKeywords.forEach((kw: any) => {
        const word = kw.word.toLowerCase();
        if (word.length < 3) return; // Skip very short words

        if (!keywordIndex.has(word)) {
          keywordIndex.set(word, {
            word,
            urls: new Set(),
            totalDensity: 0,
            avgDensity: 0,
          });
        }

        const entry = keywordIndex.get(word);
        entry.urls.add(url);
        entry.totalDensity += parseFloat(kw.density) || 0;
      });
    }

    // Calculate average density
    keywordIndex.forEach((entry) => {
      entry.avgDensity = entry.urls.size > 0 ? (entry.totalDensity / entry.urls.size).toFixed(2) : 0;
    });

    return keywordIndex;
  }

  /**
   * Cluster related keywords using simple prefix matching and semantic similarity
   * @param {Map} keywordIndex - Keyword index
   * @returns {Map} Clusters: topic -> { keywords: [], pages: Set, avgDensity: number }
   */
  static clusterKeywords(keywordIndex: Map<string, any>) {
    const clusters = new Map();
    const processed = new Set<string>();

    // Sort keywords by frequency for better clustering
    const sortedKeywords = Array.from(keywordIndex.entries()).sort((a, b) => b[1].urls.size - a[1].urls.size);

    for (const [keyword, data] of sortedKeywords as [string, any][]) {
      if (processed.has(keyword)) continue;

      // Find related keywords
      const relatedKeywords = this.findRelatedKeywords(keyword, keywordIndex, processed);

      // Create cluster
      const clusterName = keyword; // Use most frequent keyword as cluster name
      const clusterPages = new Set(data.urls);
      const clusterKeywords = [keyword];

      relatedKeywords.forEach((related: any) => {
        processed.add(related);
        clusterKeywords.push(related);
        keywordIndex.get(related).urls.forEach((url: any) => clusterPages.add(url));
      });

      processed.add(keyword);

      clusters.set(clusterName, {
        topic: clusterName,
        keywords: clusterKeywords,
        pages: clusterPages,
        pageCount: clusterPages.size,
        avgDensity: data.avgDensity,
      });
    }

    return clusters;
  }

  /**
   * Find keywords related to a given keyword
   * @param {string} keyword - The keyword to find relations for
   * @param {Map} keywordIndex - Full keyword index
   * @param {Set} processed - Already processed keywords
   * @returns {Array} Related keywords
   */
  static findRelatedKeywords(keyword: string, keywordIndex: Map<string, any>, processed: Set<string>) {
    const related: string[] = [];

    // Method 1: Prefix matching (first 4 characters)
    const prefix = keyword.substring(0, Math.min(4, keyword.length));

    // Method 2: Substring matching (one word contains another)
    keywordIndex.forEach((data, otherKeyword) => {
      if (processed.has(otherKeyword) || otherKeyword === keyword) return;

      // Prefix match
      if (otherKeyword.startsWith(prefix) && otherKeyword.length >= 4) {
        related.push(otherKeyword);
        return;
      }

      // Substring match (for compound words)
      if (keyword.length >= 4 && otherKeyword.includes(keyword)) {
        related.push(otherKeyword);
        return;
      }
      if (otherKeyword.length >= 4 && keyword.includes(otherKeyword)) {
        related.push(otherKeyword);
        return;
      }

      // Common word overlap (for multi-word keywords)
      const keywordWords = keyword.split(/[\s-_]+/);
      const otherWords = otherKeyword.split(/[\s-_]+/);
      const commonWords = keywordWords.filter((w) => otherWords.includes(w) && w.length > 3);
      if (commonWords.length > 0 && commonWords.length >= keywordWords.length / 2) {
        related.push(otherKeyword);
      }
    });

    return related;
  }

  /**
   * Analyze coverage levels for clusters
   * @param {Map} clusters - Keyword clusters
   * @returns {Object} Coverage levels
   */
  static analyzeCoverage(clusters: Map<string, any>) {
    const coverage: Record<string, Record<string, any>[]> = {
      high: [], // 5+ pages
      medium: [], // 2-4 pages
      low: [], // 1 page only
      orphan: [], // 0 pages (shouldn't happen but for safety)
    };

    clusters.forEach((data, topic) => {
      const entry = {
        topic,
        keywords: data.keywords,
        pageCount: data.pageCount,
        avgDensity: data.avgDensity,
      };

      if (data.pageCount >= 5) {
        coverage.high.push(entry);
      } else if (data.pageCount >= 2) {
        coverage.medium.push(entry);
      } else if (data.pageCount === 1) {
        coverage.low.push(entry);
      } else {
        coverage.orphan.push(entry);
      }
    });

    // Sort each by page count descending
    ['high', 'medium', 'low', 'orphan'].forEach((level) => {
      coverage[level].sort((a: any, b: any) => b.pageCount - a.pageCount);
    });

    return coverage;
  }

  /**
   * Identify content gaps (low coverage topics that could be expanded)
   * @param {Map} clusters - Keyword clusters
   * @param {Object} allPages - All page data
   * @returns {Array} Content gap opportunities
   */
  static identifyGaps(clusters: Map<string, any>, allPages: Record<string, PageInfo>) {
    const gaps: Record<string, any>[] = [];
    const totalPages = Object.keys(allPages).length;

    clusters.forEach((data, topic) => {
      // Only consider clusters with 1-2 pages as gaps
      if (data.pageCount > 2 || data.pageCount === 0) return;

      // Calculate opportunity score based on keyword density and uniqueness
      const opportunityScore = this.calculateOpportunityScore(data, totalPages);

      if (opportunityScore > 30) {
        // Only include significant gaps
        gaps.push({
          topic,
          keywords: data.keywords.slice(0, 5), // Limit to top 5 keywords
          currentPages: data.pageCount,
          opportunityScore,
          suggestion: this.generateSuggestion(topic, data.keywords, data.pageCount),
          examples: Array.from(data.pages).slice(0, 3), // Example URLs
        });
      }
    });

    // Sort by opportunity score
    gaps.sort((a, b) => b.opportunityScore - a.opportunityScore);

    return gaps.slice(0, 20); // Return top 20 gaps
  }

  /**
   * Calculate opportunity score for a content gap
   * @param {Object} clusterData - Cluster data
   * @param {number} totalPages - Total number of pages
   * @returns {number} Score 0-100
   */
  static calculateOpportunityScore(clusterData: Record<string, any>, _totalPages: number) {
    let score = 0;

    // Higher density = more important keyword
    const density = parseFloat(clusterData.avgDensity) || 0;
    score += Math.min(density * 10, 30); // Max 30 points for density

    // More keywords in cluster = bigger topic
    const keywordCount = clusterData.keywords.length;
    score += Math.min(keywordCount * 5, 25); // Max 25 points for keyword breadth

    // Single page coverage = higher opportunity
    if (clusterData.pageCount === 1) {
      score += 25;
    } else if (clusterData.pageCount === 2) {
      score += 15;
    }

    // Keyword length bonus (longer keywords = more specific = higher value)
    const avgKeywordLength =
      clusterData.keywords.reduce((sum: any, k: any) => sum + k.length, 0) / clusterData.keywords.length;
    if (avgKeywordLength >= 8) {
      score += 10;
    } else if (avgKeywordLength >= 5) {
      score += 5;
    }

    return Math.min(Math.round(score), 100);
  }

  /**
   * Generate a content suggestion for a gap
   * @param {string} topic - Main topic keyword
   * @param {Array} keywords - Related keywords
   * @param {number} currentPages - Current page count
   * @returns {string} Suggestion text
   */
  static generateSuggestion(topic: string, keywords: string[], currentPages: number) {
    const relatedWords = keywords.slice(1, 4).join(', ');

    if (currentPages === 1) {
      return `Create more content about "${topic}"${relatedWords ? ` covering aspects like ${relatedWords}` : ''}. Currently only 1 page covers this topic.`;
    } else {
      return `Expand your coverage of "${topic}"${relatedWords ? ` and related topics: ${relatedWords}` : ''}. Consider creating comprehensive guides or pillar content.`;
    }
  }

  /**
   * Generate issues for the report
   * @param {Array} gaps - Content gaps
   * @param {Object} coverage - Coverage data
   * @returns {Array} Issues array
   */
  static generateIssues(gaps: Record<string, any>[], coverage: Record<string, any>) {
    const issues: Issue[] = [];

    // Issue 1: Many low-coverage topics
    if (coverage.low.length > 10) {
      issues.push({
        message: 'Many topics with thin coverage',
        detail: `${coverage.low.length} topic clusters are covered by only 1 page each. Consider creating more in-depth content or pillar pages to improve topical authority.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Issue 2: High-opportunity gaps
    const highOpportunityGaps = gaps.filter((g) => g.opportunityScore >= 60);
    if (highOpportunityGaps.length > 0) {
      const topTopics = highOpportunityGaps
        .slice(0, 5)
        .map((g) => g.topic)
        .join(', ');
      issues.push({
        message: 'High-opportunity content gaps identified',
        detail: `${highOpportunityGaps.length} topics have high opportunity scores but limited page coverage. Top opportunities: ${topTopics}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Issue 3: Keyword concentration
    if (coverage.high.length < coverage.low.length * 0.2) {
      issues.push({
        message: 'Content may lack topical focus',
        detail: `Most topics (${coverage.low.length}) are covered by single pages, while only ${coverage.high.length} topics have deep coverage. Consider building out topic clusters with supporting content.`,
        severity: SEVERITY.LOW,
      });
    }

    return issues;
  }

  /**
   * Convert clusters Map to object for JSON serialization
   * @param {Map} clusters - Clusters map
   * @returns {Object} Serializable clusters object
   */
  static clustersToObject(clusters: Map<string, any>) {
    const obj: Record<string, any> = {};
    clusters.forEach((data, topic) => {
      obj[topic] = {
        keywords: data.keywords.slice(0, 10), // Limit for storage
        pageCount: data.pageCount,
        avgDensity: data.avgDensity,
        pages: Array.from(data.pages).slice(0, 10), // Limit for storage
      };
    });
    return obj;
  }
}

export { ContentGapAnalyzer };
