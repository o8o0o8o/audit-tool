/**
 * DOM Complexity Analyzer
 * Measures DOM node count, tree depth, and max children per element
 * Lighthouse thresholds: >800 warning, >1400 failure for total nodes
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

          // Check children count
          const childCount = el.children.length;
          if (childCount > maxChildren) {
            maxChildren = childCount;
            widestTag = getSelector(el);
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

    // Report issues based on Lighthouse thresholds. Messages are kept stable
    // (the page-specific count lives in the detail, not the title) so the same
    // finding across pages aggregates into one entry with a correct count and
    // page examples — instead of fragmenting into "(312 elements)", "(287
    // elements)", … one row per page.
    const pageRef = `<a href="${url}">${url}</a>`;
    if (info.totalNodes > THRESHOLDS.TOTAL_NODES_FAILURE) {
      issues.push({
        message: `Excessive DOM size`,
        detail: `${pageRef} has ${info.totalNodes} DOM elements (Lighthouse threshold: ${THRESHOLDS.TOTAL_NODES_FAILURE}). Large DOMs increase memory usage, slow style calculations, and cause layout thrashing. Most common elements: ${Object.entries(
          info.elementCounts,
        )
          .slice(0, 5)
          .map(([tag, count]) => `<${tag}>: ${count}`)
          .join(', ')}.`,
        severity: SEVERITY.HIGH,
      });
    } else if (info.totalNodes > THRESHOLDS.TOTAL_NODES_WARNING) {
      warnings.push({
        message: `Large DOM size`,
        detail: `${pageRef} has ${info.totalNodes} DOM elements (warning threshold: ${THRESHOLDS.TOTAL_NODES_WARNING}). Consider simplifying the page structure.`,
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
