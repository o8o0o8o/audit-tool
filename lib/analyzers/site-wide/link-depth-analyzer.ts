/**
 * Link Depth Analyzer
 * Analyzes link depth, orphan pages, and site architecture
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class LinkDepthAnalyzer {
  /**
   * Analyze link depth and site architecture
   * @param {Object} pages - All pages data
   * @param {Object} incomingLinks - Map of incoming links { targetUrl: [sourceUrls] }
   * @param {string} origin - Site origin URL
   * @returns {Object} Analysis results with issues and metrics
   */
  static analyze(pages: Record<string, PageInfo>, incomingLinks: Record<string, any>, origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const pageUrls = Object.keys(pages);
    const totalPages = pageUrls.length;

    // Build link graph for depth calculation
    const linkGraph = this.buildLinkGraph(pages, origin);

    // Calculate link depth from homepage
    const depths = this.calculateLinkDepths(linkGraph, origin);

    // Identify orphan pages (no incoming internal links)
    const orphanPages = [];
    const deadEndPages = [];
    const deepPages = [];

    for (const url of pageUrls) {
      const page = pages[url];
      const incoming = incomingLinks[url] || [];
      const incomingCount = Array.isArray(incoming) ? incoming.length : 0;

      // Orphan page detection
      if (incomingCount === 0 && url !== origin && url !== origin + '/') {
        orphanPages.push(url);
      }

      // Dead-end page detection (no outgoing internal links)
      // After data stripping, page.links may only contain problematic links
      // Use linksCount/internalLinksCount if available (set by stripping), otherwise count from array
      const hasInternalLinks = page.internalLinksCount > 0 ||
        (Array.isArray(page.links) && page.links.some((link: any) => {
          try {
            const linkUrl = new URL(link.href, origin);
            return linkUrl.origin === new URL(origin).origin;
          } catch {
            return false;
          }
        }));

      if (!hasInternalLinks && url !== origin && url !== origin + '/') {
        deadEndPages.push(url);
      }

      // Deep page detection
      const depth = depths.get(url);
      if (depth !== undefined && depth > 4) {
        deepPages.push({ url, depth });
      }

      // Store depth in page data
      if (page && depth !== undefined) {
        page.linkDepth = depth;
      }
    }

    // Report orphan pages
    if (orphanPages.length > 0) {
      const sampleOrphans = orphanPages.slice(0, 5);
      issues.push({
        message: `${orphanPages.length} orphan pages detected (no internal links pointing to them)`,
        detail: `Example orphan pages: ${sampleOrphans.map(u => `<a href="${u}">${this.shortenUrl(u)}</a>`).join(', ')}${orphanPages.length > 5 ? ` and ${orphanPages.length - 5} more` : ''}`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report dead-end pages
    if (deadEndPages.length > 0) {
      const percent = ((deadEndPages.length / totalPages) * 100).toFixed(1);
      if (deadEndPages.length > totalPages * 0.1) { // More than 10%
        const sampleDeadEnds = deadEndPages.slice(0, 5);
        issues.push({
          message: `${deadEndPages.length} dead-end pages (${percent}%) have no outgoing internal links`,
          detail: `Dead-end pages don't pass link equity. Examples: ${sampleDeadEnds.map(u => `<a href="${u}">${this.shortenUrl(u)}</a>`).join(', ')}`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Report deep pages
    if (deepPages.length > 0) {
      const deepPagesSorted = deepPages.sort((a, b) => b.depth - a.depth);
      const maxDepth = deepPagesSorted[0].depth;
      const sampleDeep = deepPagesSorted.slice(0, 5);

      warnings.push({
        message: `${deepPages.length} pages are more than 4 clicks from homepage`,
        detail: `Maximum depth: ${maxDepth} clicks. Deep pages may be crawled less frequently. Examples: ${sampleDeep.map(p => `<a href="${p.url}">${this.shortenUrl(p.url)}</a> (${p.depth} clicks)`).join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    // Check for unreachable pages
    const unreachablePages = pageUrls.filter(url => !depths.has(url) && url !== origin && url !== origin + '/');
    if (unreachablePages.length > 0) {
      const sampleUnreachable = unreachablePages.slice(0, 5);
      issues.push({
        message: `${unreachablePages.length} pages are unreachable from homepage via internal links`,
        detail: `These pages can only be accessed via sitemap or external links. Examples: ${sampleUnreachable.map(u => `<a href="${u}">${this.shortenUrl(u)}</a>`).join(', ')}`,
        severity: SEVERITY.HIGH,
      });
    }

    // Calculate metrics
    const depthValues = Array.from(depths.values());
    const avgDepth = depthValues.length > 0
      ? depthValues.reduce((a, b) => a + b, 0) / depthValues.length
      : 0;

    const depthDistribution: Record<string, number> = {};
    for (const depth of depthValues) {
      depthDistribution[depth] = (depthDistribution[depth] || 0) + 1;
    }

    return {
      issues,
      warnings,
      metrics: {
        totalPages,
        orphanPages: orphanPages.length,
        deadEndPages: deadEndPages.length,
        deepPages: deepPages.length,
        unreachablePages: unreachablePages.length,
        averageDepth: Math.round(avgDepth * 10) / 10,
        maxDepth: depthValues.length > 0 ? Math.max(...depthValues) : 0,
        depthDistribution,
      },
      orphanPagesList: orphanPages,
      deadEndPagesList: deadEndPages,
    };
  }

  /**
   * Build a link graph from page data
   * @param {Object} pages - Pages data
   * @param {string} origin - Site origin
   * @returns {Map} Link graph (url -> Set of linked urls)
   */
  static buildLinkGraph(pages: Record<string, PageInfo>, origin: string) {
    const graph = new Map();
    const originHost = new URL(origin).host;
    const allPageUrls = new Set(Object.keys(pages));

    for (const [url, page] of Object.entries(pages)) {
      const links = new Set();

      // After data stripping, page.links may only contain problematic links (no text).
      // Try to use the full links array first, but if it looks stripped (few entries
      // but page reports many links), we can't build an accurate graph for this page.

      if (Array.isArray(page.links)) {
  
        for (const link of page.links) {
          try {
            const linkUrl = new URL(link.href, url);
            // Only include internal links
            if (linkUrl.host === originHost) {
              // Normalize URL (remove hash, trailing slash consistency)
              let normalizedUrl = linkUrl.origin + linkUrl.pathname;
              if (normalizedUrl.endsWith('/') && normalizedUrl !== origin + '/') {
                normalizedUrl = normalizedUrl.slice(0, -1);
              }
              links.add(normalizedUrl);
            }
          } catch {
            // Invalid URL, skip
          }
        }
      }

      graph.set(url, links);
    }

    // Second pass: use incoming links data to fill gaps
    // If page A links to page B, then B should appear in A's outgoing links
    // This helps when page A's links were stripped
    for (const [url, page] of Object.entries(pages)) {

      if (page.hasIncomingLinks && !graph.has(url)) {
        graph.set(url, new Set());
      }
    }

    return graph;
  }

  /**
   * Calculate link depth from homepage using BFS
   * @param {Map} graph - Link graph
   * @param {string} origin - Site origin (homepage)
   * @returns {Map} URL to depth mapping
   */
  static calculateLinkDepths(graph: Map<string, Set<string>>, origin: string) {
    const depths = new Map();
    const visited = new Set();
    const queue: Array<{ url: string; depth: number }> = [];

    // Start from homepage (both with and without trailing slash)
    const homepages = [origin, origin + '/', origin.replace(/\/$/, '')];

    for (const homepage of homepages) {
      if (graph.has(homepage) && !visited.has(homepage)) {
        queue.push({ url: homepage, depth: 0 });
        visited.add(homepage);
        depths.set(homepage, 0);
      }
    }

    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;
      const links: Set<string> = graph.get(url) || new Set();

      for (const linkedUrl of links) {
        if (!visited.has(linkedUrl)) {
          visited.add(linkedUrl);
          depths.set(linkedUrl, depth + 1);
          queue.push({ url: linkedUrl, depth: depth + 1 });
        }
      }
    }

    return depths;
  }

  /**
   * Shorten URL for display
   * @param {string} url - Full URL
   * @returns {string} Shortened URL
   */
  static shortenUrl(url: string) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > 40) {
        return '...' + path.slice(-37);
      }
      return path || '/';
    } catch {
      return url.slice(-40);
    }
  }
}

export { LinkDepthAnalyzer };