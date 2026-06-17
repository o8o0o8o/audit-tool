/**
 * DOM Complexity Analyzer
 * Measures DOM node count, tree depth, and max children per element
 * Lighthouse thresholds: >800 warning, >1400 failure for total nodes.
 * Both bands report under one "Excessive DOM size" finding (the crossed band is
 * noted in the detail) rather than two tier-named findings — see the comment at
 * the reporting block below.
 */

import { SEVERITY, THRESHOLDS as GLOBAL_THRESHOLDS } from '../../constants';
import type { Issue, ChromePage } from '../../types';

// Lighthouse thresholds
const THRESHOLDS = {
  TOTAL_NODES_WARNING: GLOBAL_THRESHOLDS.DOM_NODES_WARNING,
  TOTAL_NODES_FAILURE: GLOBAL_THRESHOLDS.DOM_NODES_CRITICAL,
  MAX_DEPTH_WARNING: GLOBAL_THRESHOLDS.DOM_DEPTH_WARNING,
  MAX_CHILDREN_WARNING: GLOBAL_THRESHOLDS.DOM_CHILDREN_WARNING,
};

class DOMComplexityAnalyzer {
  static async analyze(chromePage: ChromePage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      totalNodes: number;
      maxDepth: number;
      maxChildren: number;
      deepestElement: string;
      widestElement: string;
      bodyChildren: number;
      elementCounts: Record<string, number>;
    } = {
      totalNodes: 0,
      maxDepth: 0,
      maxChildren: 0,
      deepestElement: '',
      widestElement: '',
      bodyChildren: 0,
      elementCounts: {},
    };

    try {
      const result = await chromePage.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        const totalNodes = allElements.length;

        let maxDepth = 0;
        let maxChildren = 0;
        let deepestTag = '';
        let widestTag = '';

        // Count elements by tag
        const tagCounts: Record<string, number> = {};

        // Measure depth efficiently by walking up
        const depthCache = new Map<Element, number>();

        function getDepth(el: Element): number {
          if (depthCache.has(el)) return depthCache.get(el)!;
          let depth = 0;
          let current: Element | null = el;
          while (current && current !== document.documentElement) {
            depth++;
            current = current.parentElement;
          }
          depthCache.set(el, depth);
          return depth;
        }

        for (const el of allElements) {
          const tag = el.tagName.toLowerCase();
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;

          // Check depth (sample to avoid performance issues)
          if (totalNodes < 3000 || Math.random() < 0.3) {
            const depth = getDepth(el);
            if (depth > maxDepth) {
              maxDepth = depth;
              deepestTag = getSelector(el);
            }
          }

          // Check children count. Exclude <head>: it legitimately holds many
          // <meta>/<link>/<script> children, but that is not the wide *content*
          // container this check targets, and the finding's fix ("virtualize or
          // paginate the long list") is nonsensical for head metadata.
          if (tag !== 'head') {
            const childCount = el.children.length;
            if (childCount > maxChildren) {
              maxChildren = childCount;
              widestTag = getSelector(el);
            }
          }
        }

        const bodyChildren = document.body?.children.length || 0;

        // Get top 10 most common elements
        const topTags: Record<string, number> = {};
        const sorted = Object.entries(tagCounts).sort(([, a], [, b]) => b - a);
        for (const [tag, count] of sorted.slice(0, 10)) {
          topTags[tag] = count;
        }

        return {
          totalNodes,
          maxDepth,
          maxChildren,
          deepestTag,
          widestTag,
          bodyChildren,
          topTags,
        };

        function getSelector(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';
          return `${tag}${id}${cls}`.substring(0, 80);
        }
      });

      info.totalNodes = result.totalNodes;
      info.maxDepth = result.maxDepth;
      info.maxChildren = result.maxChildren;
      info.deepestElement = result.deepestTag;
      info.widestElement = result.widestTag;
      info.bodyChildren = result.bodyChildren;
      info.elementCounts = result.topTags;
    } catch {
      return { issues, warnings, info };
    }

    // Report a single "Excessive DOM size" finding for any page over the warning
    // threshold. We deliberately do NOT split into two tier-named findings
    // ("Large DOM size" for the warning band, "Excessive DOM size" for the
    // failure band): site-wide aggregation surfaces both populations at once, so
    // two messages produce two redundant report rows for one underlying problem.
    // Instead the page lands under one message and the band it crossed (warning
    // vs Lighthouse failure) is spelled out in the detail. The severity is fixed
    // (the aggregator keys by message and keeps the first-seen severity, so a
    // per-page-varying severity would make the finding's severity depend on
    // non-deterministic crawl-completion order) — see docs/report-rules.md.
    // The count stays in the detail, not the title, so the finding aggregates
    // into one entry instead of fragmenting into "(312 elements)", … per page.
    const pageRef = `<a href="${url}">${url}</a>`;
    if (info.totalNodes > THRESHOLDS.TOTAL_NODES_WARNING) {
      const overFailure = info.totalNodes > THRESHOLDS.TOTAL_NODES_FAILURE;
      const thresholdNote = overFailure
        ? `over Lighthouse's failure threshold of ${THRESHOLDS.TOTAL_NODES_FAILURE}`
        : `over Lighthouse's warning threshold of ${THRESHOLDS.TOTAL_NODES_WARNING}`;
      // Render tag names WITHOUT angle brackets ("div ×401" not "<div>: 401").
      // The curated report's inlineExample() splits a detail on `<ul`/`<ol`/`</p>`
      // to drop list markup analyzers append — literal `<ul>:`/`<p>:` element
      // counts here would be mistaken for that markup and truncate the sentence
      // mid-list, leaving a dangling comma. Bracket-free is also correct for the
      // legacy HTML report, where `<div>: 401` would render as a real element.
      const topElements = Object.entries(info.elementCounts)
        .slice(0, 5)
        .map(([tag, count]) => `${tag} ×${count}`)
        .join(', ');
      warnings.push({
        message: `Excessive DOM size`,
        detail: `${pageRef} has ${info.totalNodes} DOM elements (${thresholdNote}). Large DOMs increase memory usage, slow style calculations, and cause layout thrashing.${
          topElements ? ` Most common elements: ${topElements}.` : ''
        }`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.maxDepth > THRESHOLDS.MAX_DEPTH_WARNING) {
      warnings.push({
        message: `Deep DOM nesting`,
        detail: `${pageRef} has a maximum DOM depth of ${info.maxDepth} levels (threshold: ${THRESHOLDS.MAX_DEPTH_WARNING}). Deepest path: ${info.deepestElement}. Deep nesting increases selector matching time and layout costs.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.maxChildren > THRESHOLDS.MAX_CHILDREN_WARNING) {
      warnings.push({
        message: `Element with too many children`,
        detail: `${pageRef}: element "${info.widestElement}" has ${info.maxChildren} child elements (threshold: ${THRESHOLDS.MAX_CHILDREN_WARNING}). Consider virtualization or pagination for long lists.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, info };
  }
}

export { DOMComplexityAnalyzer };
