/**
 * Route-Sitemap Comparator
 * Compares extracted file-based routes against sitemap URLs to find coverage gaps
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

class RouteSitemapComparator {
  /**
   * Compare routes extracted from code with sitemap URLs
   * @param {Array<{ pattern: string, file: string, isDynamic: boolean }>} routes - Extracted routes
   * @param {Object} sitemapUrls - Sitemap URLs object (keys are full URLs)
   * @param {string} origin - Site origin (e.g., https://example.com)
   * @returns {{ issues: Array, warnings: Array, stats: object, details: object }}
   */
  static compare(routes: any[], sitemapUrls: Record<string, any>, origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!routes || routes.length === 0) {
      return {
        issues,
        warnings,
        stats: { totalRoutes: 0, coveredRoutes: 0, uncoveredRoutes: 0, dynamicRoutes: 0, unmatchedUrls: 0 },
        details: { coveredRoutes: [], uncoveredRoutes: [], unmatchedUrls: [], dynamicRouteStats: [] },
      };
    }

    const urlPaths = new Set<string>();

    // Extract URL paths from sitemap (strip origin, normalize trailing slashes)
    for (const url of Object.keys(sitemapUrls || {})) {
      try {
        const parsed = new URL(url);
        // Normalize: strip trailing slash unless it's the root path
        const rawPath = parsed.pathname;
        const urlPath = rawPath === '/' ? '/' : rawPath.replace(/\/$/, '');
        urlPaths.add(urlPath);
      } catch {
        // Skip invalid URLs
      }
    }

    const staticRoutes = routes.filter(r => !r.isDynamic);
    const dynamicRoutes = routes.filter(r => r.isDynamic);

    const coveredRoutes = [];
    const uncoveredRoutes = [];

    // Check static routes against sitemap
    for (const route of staticRoutes) {
      const normalizedPattern = route.pattern.replace(/\/$/, '') || '/';
      if (urlPaths.has(normalizedPattern)) {
        coveredRoutes.push(route);
      } else {
        uncoveredRoutes.push(route);
      }
    }

    // Check dynamic routes - see how many sitemap URLs match each pattern
    const dynamicRouteStats = [];
    const matchedByDynamic = new Set();

    for (const route of dynamicRoutes) {
      const regex = this.#routePatternToRegex(route.pattern);
      let matchCount = 0;
      for (const urlPath of urlPaths) {
        if (regex.test(urlPath)) {
          matchCount++;
          matchedByDynamic.add(urlPath);
        }
      }
      dynamicRouteStats.push({ ...route, matchCount });
      if (matchCount > 0) {
        coveredRoutes.push(route);
      } else {
        uncoveredRoutes.push(route);
      }
    }

    // Find sitemap URLs that don't match any route
    const allMatchedPaths = new Set([
      ...staticRoutes.filter(r => urlPaths.has(r.pattern.replace(/\/$/, '') || '/')).map(r => r.pattern.replace(/\/$/, '') || '/'),
      ...matchedByDynamic,
    ]);

    const unmatchedUrls = [];
    for (const urlPath of urlPaths) {
      if (!allMatchedPaths.has(urlPath)) {
        unmatchedUrls.push(urlPath);
      }
    }

    // Generate issues

    // Uncovered static routes
    if (uncoveredRoutes.length > 0) {
      const staticUncovered = uncoveredRoutes.filter(r => !r.isDynamic);
      if (staticUncovered.length > 0) {
        issues.push({
          message: 'Static routes not found in sitemap',
          detail: `${staticUncovered.length} static route(s) defined in code have no matching sitemap URL:<br>${staticUncovered.slice(0, 10).map(r => `<code>${r.pattern}</code> (<code>${r.file}</code>)`).join('<br>')}${staticUncovered.length > 10 ? `<br>...and ${staticUncovered.length - 10} more` : ''}`,
          severity: SEVERITY.MEDIUM,
        });
      }

      const dynamicUncovered = uncoveredRoutes.filter(r => r.isDynamic);
      if (dynamicUncovered.length > 0) {
        warnings.push({
          message: 'Dynamic routes with no sitemap entries',
          detail: `${dynamicUncovered.length} dynamic route(s) have zero matching sitemap URLs:<br>${dynamicUncovered.slice(0, 10).map(r => `<code>${r.pattern}</code> (<code>${r.file}</code>)`).join('<br>')}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Dynamic routes with very few entries
    for (const ds of dynamicRouteStats) {
      if (ds.matchCount > 0 && ds.matchCount < 3) {
        warnings.push({
          message: 'Dynamic route may be under-indexed',
          detail: `Route <code>${ds.pattern}</code> (<code>${ds.file}</code>) only has ${ds.matchCount} URL(s) in the sitemap. This may indicate missing content or incomplete sitemap generation.`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Unmatched sitemap URLs (only warn if significant number)
    if (unmatchedUrls.length > 0 && routes.length > 0) {
      const pct = Math.round((unmatchedUrls.length / urlPaths.size) * 100);
      if (pct > 20 || unmatchedUrls.length > 50) {
        warnings.push({
          message: 'Sitemap URLs not matching any code route',
          detail: `${unmatchedUrls.length} sitemap URL(s) (${pct}%) don't match any detected route pattern. These may be generated by a CMS, API routes, or stale entries. Examples: ${unmatchedUrls.slice(0, 5).map(u => `<code>${u}</code>`).join(', ')}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    const stats = {
      totalRoutes: routes.length,
      staticRoutes: staticRoutes.length,
      dynamicRoutes: dynamicRoutes.length,
      coveredRoutes: coveredRoutes.length,
      uncoveredRoutes: uncoveredRoutes.length,
      sitemapUrlCount: urlPaths.size,
      unmatchedUrls: unmatchedUrls.length,
    };

    return {
      issues,
      warnings,
      stats,
      details: {
        coveredRoutes,
        uncoveredRoutes,
        unmatchedUrls: unmatchedUrls.slice(0, 50), // Limit for report size
        dynamicRouteStats,
      },
    };
  }

  /**
   * Convert a route pattern with dynamic segments to a regex
   * e.g., /blog/[slug] -> /blog/[^/]+
   *        /[...slug]  -> /.+
   *        /shop/[category]/[id] -> /shop/[^/]+/[^/]+
   *        /feed.xml -> /feed\.xml
   * @param {string} pattern
   * @returns {RegExp}
   */
  static #routePatternToRegex(pattern: string) {
    // Split the pattern into segments and convert each one
    const segments = pattern.split('/');
    const regexSegments = segments.map(seg => {
      // Catch-all: [...slug] or [[...slug]]
      if (/^\[\[?\.\.\.\w+\]?\]$/.test(seg)) return '.+';
      // Dynamic segment: [slug], [id]
      if (/^\[\w+\]$/.test(seg)) return '[^/]+';
      // Gatsby dynamic: {Model.field}
      if (/^\{[^}]+\}$/.test(seg)) return '[^/]+';
      // Literal segment - escape regex special chars
      return seg.replace(/[.*+?^${}()|\\]/g, '\\$&');
    });

    let regexStr = regexSegments.join('/');
    // Normalize: strip trailing slash unless root
    regexStr = regexStr.replace(/\/$/, '') || '/';

    return new RegExp(`^${regexStr}$`);
  }
}

export { RouteSitemapComparator };