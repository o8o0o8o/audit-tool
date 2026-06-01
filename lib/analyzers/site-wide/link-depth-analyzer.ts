/**
 * Link Depth Analyzer
 * Analyzes link depth, orphan pages, and site architecture
 */

import { SEVERITY } from '../../constants';
import {
  shortenUrl,
  getIncomingLinkCount,
  formatSampleList,
  normalizeUrlForComparison,
} from '../../utils';
import type { Issue, PageInfo } from '../../types';

class LinkDepthAnalyzer {
  /**
   * Analyze link depth and site architecture
   * @param {Object} pages - All pages data
   * @param {Object} incomingLinks - Map of incoming links { targetUrl: [sourceUrls] }
   * @param {string} origin - Site origin URL
   * @returns {Object} Analysis results with issues and metrics
   */
  static analyze(pages: Record<string, PageInfo>, incomingLinks: Record<string, string[] | unknown>, origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const pageUrls = Object.keys(pages);
    const totalPages = pageUrls.length;

    // Build link graph for depth calculation. Seeded from both per-page link
    // arrays and the authoritative incomingLinks map (inverted) so reachability
    // survives the link-stripping that the memory optimizer applies to
    // page.links — without it, almost every page looks "unreachable".
    const linkGraph = this.buildLinkGraph(pages, origin, incomingLinks);

    // Calculate link depth from homepage
    const depths = this.calculateLinkDepths(linkGraph, origin);

    // Identify orphan pages (no incoming internal links)
    const orphanPages = [];
    const deadEndPages = [];
    const deepPages = [];

    for (const url of pageUrls) {
      const page = pages[url];
      const incomingCount = getIncomingLinkCount(incomingLinks as Record<string, unknown>, url);

      // Orphan page detection
      if (incomingCount === 0 && url !== origin && url !== origin + '/') {
        orphanPages.push(url);
      }

      // Dead-end page detection (no outgoing internal links)
      // After data stripping, page.links may only contain problematic links
      // Use linksCount/internalLinksCount if available (set by stripping), otherwise count from array
      const hasInternalLinks =
        (page.internalLinksCount ?? 0) > 0 ||
        (Array.isArray(page.links) &&
          page.links.some((link: { href: string }) => {
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
      issues.push({
        message: `${orphanPages.length} orphan pages detected (no internal links pointing to them)`,
        detail: `Example orphan pages: ${formatSampleList(orphanPages.map((u) => `<a href="${u}">${shortenUrl(u)}</a>`), 5)}`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report dead-end pages
    if (deadEndPages.length > 0) {
      const percent = ((deadEndPages.length / totalPages) * 100).toFixed(1);
      if (deadEndPages.length > totalPages * 0.1) {
        // More than 10%
        issues.push({
          message: `${deadEndPages.length} dead-end pages (${percent}%) have no outgoing internal links`,
          detail: `Dead-end pages don't pass link equity. Examples: ${formatSampleList(deadEndPages.map((u) => `<a href="${u}">${shortenUrl(u)}</a>`), 5)}`,
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
        detail: `Maximum depth: ${maxDepth} clicks. Deep pages may be crawled less frequently. Examples: ${sampleDeep.map((p) => `<a href="${p.url}">${shortenUrl(p.url)}</a> (${p.depth} clicks)`).join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    // Check for unreachable pages. Compare on normalized URLs so a trailing
    // slash difference between the page key and a graph node isn't mistaken
    // for unreachability.
    const originNorm = normalizeUrlForComparison(origin);
    const unreachablePages = pageUrls.filter(
      (url) => !depths.has(normalizeUrlForComparison(url)) && normalizeUrlForComparison(url) !== originNorm,
    );
    if (unreachablePages.length > 0) {
      // Guard against a degraded link graph: if the homepage's outgoing links
      // weren't captured (SPA / client-rendered nav), BFS reaches almost
      // nothing and the whole site looks orphaned. When the unreachable share
      // is implausibly high we can't trust the signal, so we report it as a
      // low-severity caveat rather than a high-severity site defect.
      const unreachableFraction = totalPages > 0 ? unreachablePages.length / totalPages : 0;
      const likelyDegraded = unreachableFraction > 0.5;
      if (likelyDegraded) {
        warnings.push({
          message: `Internal link graph could not be fully resolved`,
          detail: `${unreachablePages.length} of ${totalPages} pages were not reachable from the homepage in the captured link graph. This usually means client-rendered navigation wasn't captured rather than a genuine orphan problem — verify internal linking manually.`,
          severity: SEVERITY.LOW,
        });
      } else {
        issues.push({
          message: `${unreachablePages.length} pages are unreachable from homepage via internal links`,
          detail: `These pages can only be accessed via sitemap or external links. Examples: ${formatSampleList(unreachablePages.map((u) => `<a href="${u}">${shortenUrl(u)}</a>`), 5)}`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Calculate metrics
    const depthValues = Array.from(depths.values());
    const avgDepth = depthValues.length > 0 ? depthValues.reduce((a, b) => a + b, 0) / depthValues.length : 0;

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
  static buildLinkGraph(
    pages: Record<string, PageInfo>,
    origin: string,
    incomingLinks: Record<string, string[] | unknown> = {},
  ) {
    const graph = new Map<string, Set<string>>();
    const originHost = new URL(origin).host;

    // All graph nodes/edges are keyed on the normalized form (hash + trailing
    // slash stripped) so the page key, link target, and incomingLinks entries
    // line up regardless of trailing-slash inconsistencies.
    const edge = (from: string, to: string) => {
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from)!.add(to);
    };
    const internalNorm = (href: string, base: string): string | null => {
      try {
        const u = new URL(href, base);
        if (u.host !== originHost) return null;
        return normalizeUrlForComparison(u.origin + u.pathname + u.search);
      } catch {
        return null;
      }
    };

    for (const [url, page] of Object.entries(pages)) {
      const fromNorm = normalizeUrlForComparison(url);
      if (!graph.has(fromNorm)) graph.set(fromNorm, new Set());

      // After data stripping, page.links may only contain problematic links;
      // the incomingLinks pass below backfills the missing edges.
      if (Array.isArray(page.links)) {
        for (const link of page.links) {
          const to = internalNorm(link.href, url);
          if (to) edge(fromNorm, to);
        }
      }
    }

    // Second pass: invert the authoritative incomingLinks map. An entry
    // { target: [source, …] } means each source links to target, i.e. an
    // edge source → target. This is the reliable graph source after stripping.
    for (const [target, sources] of Object.entries(incomingLinks)) {
      if (!Array.isArray(sources)) continue;
      const toNorm = normalizeUrlForComparison(target);
      if (!graph.has(toNorm)) graph.set(toNorm, new Set());
      for (const source of sources as string[]) {
        if (typeof source !== 'string') continue;
        edge(normalizeUrlForComparison(source), toNorm);
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

    // Graph nodes are normalized; seed BFS from the normalized homepage.
    const homepage = normalizeUrlForComparison(origin);
    if (graph.has(homepage)) {
      queue.push({ url: homepage, depth: 0 });
      visited.add(homepage);
      depths.set(homepage, 0);
    }

    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;
      const links: Set<string> = graph.get(url) ?? new Set();

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

}

export { LinkDepthAnalyzer };
