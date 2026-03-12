/**
 * Page Matcher
 * Utility for matching pages between two sites by URL path
 */

import type { PageInfo } from '../types';

interface PageEntry {
  url: string;
  page: PageInfo;
  path: string;
}

interface MatchedPage {
  path: string;
  originUrl: string;
  compareUrl: string;
  originPage: PageInfo;
  comparePage: PageInfo;
}

interface UnmatchedPage {
  path: string;
  url: string;
  page: PageInfo;
}

interface MatchResult {
  matched: MatchedPage[];
  originOnly: UnmatchedPage[];
  compareOnly: UnmatchedPage[];
}

interface MatchStats {
  totalOrigin: number;
  totalCompare: number;
  matchedCount: number;
  originOnlyCount: number;
  compareOnlyCount: number;
  matchPercentage: number;
}

class PageMatcher {
  /**
   * Extract and normalize URL path from full URL
   * @param {string} url - Full URL
   * @returns {string} Normalized path (lowercase, trailing slash removed, no query/fragment)
   */
  static extractPath(url: string) {
    try {
      const parsed = new URL(url);
      let path = parsed.pathname;

      // Normalize: lowercase and remove trailing slash (except for root)
      path = path.toLowerCase();
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }

      return path;
    } catch {
      // If URL parsing fails, try to extract path manually
      const match = url.match(/^https?:\/\/[^\/]+(\/[^?#]*)?/i);
      if (match && match[1]) {
        let path = match[1].toLowerCase();
        if (path.length > 1 && path.endsWith('/')) {
          path = path.slice(0, -1);
        }
        return path;
      }
      return '/';
    }
  }

  /**
   * Match pages from two sites by URL path
   * @param {Object} originPages - Pages from origin site { url: pageData }
   * @param {Object} comparePages - Pages from compare site { url: pageData }
   * @returns {Object} { matched: [], originOnly: [], compareOnly: [] }
   */
  static matchPages(originPages: Record<string, PageInfo>, comparePages: Record<string, PageInfo>): MatchResult {
    const result: MatchResult = {
      matched: [],
      originOnly: [],
      compareOnly: [],
    };

    // Build path maps for efficient lookup
    const originByPath = new Map<string, PageEntry>();
    const compareByPath = new Map<string, PageEntry>();

    // Index origin pages by path
    for (const [url, page] of Object.entries(originPages)) {
      const path = this.extractPath(url);
      // If multiple URLs map to same path, keep the first one
      if (!originByPath.has(path)) {
        originByPath.set(path, { url, page, path });
      }
    }

    // Index compare pages by path
    for (const [url, page] of Object.entries(comparePages)) {
      const path = this.extractPath(url);
      if (!compareByPath.has(path)) {
        compareByPath.set(path, { url, page, path });
      }
    }

    // Find matched pages
    for (const [path, originEntry] of originByPath) {
      const compareEntry = compareByPath.get(path);

      if (compareEntry) {
        result.matched.push({
          path,
          originUrl: originEntry.url,
          compareUrl: compareEntry.url,
          originPage: originEntry.page,
          comparePage: compareEntry.page,
        });
        // Remove from compare map so we can find compare-only pages
        compareByPath.delete(path);
      } else {
        result.originOnly.push({
          path,
          url: originEntry.url,
          page: originEntry.page,
        });
      }
    }

    // Remaining compare pages are compare-only
    for (const [path, compareEntry] of compareByPath) {
      result.compareOnly.push({
        path,
        url: compareEntry.url,
        page: compareEntry.page,
      });
    }

    // Sort results by path for consistent ordering
    result.matched.sort((a, b) => a.path.localeCompare(b.path));
    result.originOnly.sort((a, b) => a.path.localeCompare(b.path));
    result.compareOnly.sort((a, b) => a.path.localeCompare(b.path));

    return result;
  }

  /**
   * Calculate match statistics
   * @param {Object} matchResult - Result from matchPages()
   * @returns {Object} Statistics about the match
   */
  static getMatchStats(matchResult: MatchResult): MatchStats {
    const totalOrigin = matchResult.matched.length + matchResult.originOnly.length;
    const totalCompare = matchResult.matched.length + matchResult.compareOnly.length;
    const matchedCount = matchResult.matched.length;

    return {
      totalOrigin,
      totalCompare,
      matchedCount,
      originOnlyCount: matchResult.originOnly.length,
      compareOnlyCount: matchResult.compareOnly.length,
      matchPercentage: totalOrigin > 0 ? Math.round((matchedCount / totalOrigin) * 100) : 0,
    };
  }
}

export { PageMatcher };
