/**
 * Internal PageRank Analyzer
 * Simulates PageRank on the internal link graph to estimate page importance.
 * Uses the link graph from LinkDepthAnalyzer.buildLinkGraph().
 */

import { SEVERITY } from '../../constants';
import { formatUrlList } from '../../utils';
import type { Issue, PageInfo } from '../../types';
import { LinkDepthAnalyzer } from './link-depth-analyzer';

class InternalPageRankAnalyzer {
  /**
   * Calculate Internal PageRank for all pages
   * @param {object} allPages - All page data { url: pageData }
   * @param {object} incomingLinks - Incoming links mapping
   * @param {string} origin - Site origin URL
   * @returns {object} Analysis results with issues and page scores
   */
  static analyze(
    allPages: Record<string, PageInfo>,
    incomingLinks: Record<string, string[] | unknown>,
    origin: string,
  ) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.keys(allPages);

    if (pages.length < 2) {
      return { issues, warnings, pageRank: {} };
    }

    // Build link graph using existing infrastructure
    const graph = LinkDepthAnalyzer.buildLinkGraph(allPages, origin);

    // Run PageRank algorithm
    const scores = InternalPageRankAnalyzer.#computePageRank(graph, pages);

    // Store scores on page data
    for (const [url, score] of Object.entries(scores)) {
      if (allPages[url]) {
        allPages[url].internalPageRank = score;
      }
    }

    // Sort by PageRank
    const ranked = (Object.entries(scores) as [string, number][]).sort((a, b) => b[1] - a[1]);

    // Identify pages with very low PageRank (potential orphans or poorly linked)
    const lowThreshold = (1 / pages.length) * 0.5; // Below half of uniform distribution
    const lowRankPages = ranked.filter(([, score]) => score < lowThreshold);

    if (lowRankPages.length > pages.length * 0.2 && lowRankPages.length > 5) {
      const examples = formatUrlList(lowRankPages.slice(0, 5).map(([url]) => url));
      warnings.push({
        message: `${lowRankPages.length} pages have very low internal link equity`,
        detail: `These pages receive minimal internal link equity, reducing their ranking potential:<ul>${examples}</ul>${lowRankPages.length > 5 ? `<p>...and ${lowRankPages.length - 5} more</p>` : ''}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for extreme concentration (top page has disproportionate share)
    if (ranked.length > 10) {
      const topScore = ranked[0][1] as number;
      const medianScore = ranked[Math.floor(ranked.length / 2)][1] as number;
      if (medianScore > 0 && topScore / medianScore > 20) {
        warnings.push({
          message: 'Internal link equity is highly concentrated',
          detail: `The top page (<a href="${ranked[0][0]}">${ranked[0][0]}</a>) has ${Math.round(topScore / medianScore)}x more internal link equity than the median page. Consider distributing links more evenly.`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Compute distribution stats
    const scoreValues = ranked.map(([, s]) => s as number);
    const distribution = {
      topPages: ranked
        .slice(0, 10)
        .map(([url, score]) => ({ url, score: Math.round((score as number) * 10000) / 10000 })),
      bottomPages: ranked
        .slice(-5)
        .map(([url, score]) => ({ url, score: Math.round((score as number) * 10000) / 10000 })),
      mean: scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length,
      median: scoreValues[Math.floor(scoreValues.length / 2)],
      max: scoreValues[0],
      min: scoreValues[scoreValues.length - 1],
    };

    return { issues, warnings, pageRank: scores, distribution };
  }

  /**
   * Iterative PageRank computation
   * @param {Map<string, Set<string>>} graph - Adjacency list (url -> set of outbound URLs)
   * @param {string[]} pages - All page URLs
   * @param {number} damping - Damping factor (default 0.85)
   * @param {number} iterations - Max iterations (default 50)
   * @param {number} tolerance - Convergence threshold (default 1e-6)
   * @returns {object} { url: score }
   * @private
   */
  static #computePageRank(
    graph: Map<string, Set<string>>,
    pages: string[],
    damping = 0.85,
    iterations = 50,
    tolerance = 1e-6,
  ) {
    const n = pages.length;
    const initialScore = 1 / n;

    // Initialize scores
    let scores: Record<string, number> = {};
    for (const url of pages) {
      scores[url] = initialScore;
    }

    // Build reverse graph (incoming links) for efficient computation
    const inbound: Record<string, string[]> = {};
    for (const url of pages) {
      inbound[url] = [];
    }
    for (const [source, targets] of graph.entries()) {
      if (!targets) continue;
      for (const target of targets) {
        if (inbound[target]) {
          inbound[target].push(source);
        }
      }
    }

    // Iterate until convergence or max iterations
    for (let i = 0; i < iterations; i++) {
      const newScores: Record<string, number> = {};
      let diff = 0;

      // Calculate dangling node contribution (pages with no outbound links)
      let danglingSum = 0;
      for (const url of pages) {
        const outLinks = graph.get(url);
        if (!outLinks || outLinks.size === 0) {
          danglingSum += scores[url];
        }
      }

      for (const url of pages) {
        let rank = (1 - damping) / n;
        rank += damping * (danglingSum / n); // Distribute dangling node rank

        // Sum contributions from incoming links
        for (const source of inbound[url] || []) {
          const outDegree = graph.get(source)?.size ?? 1;
          rank += damping * (scores[source] / outDegree);
        }

        newScores[url] = rank;
        diff += Math.abs(rank - scores[url]);
      }

      scores = newScores;

      // Check convergence
      if (diff < tolerance) {
        break;
      }
    }

    return scores;
  }
}

export { InternalPageRankAnalyzer };
