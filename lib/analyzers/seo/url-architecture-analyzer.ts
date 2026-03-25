/**
 * URL Architecture Analyzer
 * Checks URL structure, parameters, and consistency issues
 */

import { SEVERITY } from '../../constants';
import { TRACKING_PARAMS } from '../../utils';
import type { Issue, PageInfo } from '../../types';

class UrlArchitectureAnalyzer {
  /**
   * Analyze URL architecture for SEO issues
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data object
   * @param {string} origin - Site origin
   * @returns {Object} Analysis results with issues array
   */
  static analyze(url: string, pageData: PageInfo, origin: string) {
    const issues: { type: string; message: string; detail?: string; severity: string; value?: number | string[] }[] =
      [];

    try {
      const parsedUrl = new URL(url);
      const parsedOrigin = new URL(origin);

      // URL length check
      const urlLength = url.length;
      if (urlLength > 200) {
        issues.push({
          type: 'url_too_long',
          message: 'URL exceeds 200 characters',
          detail: `URL has ${urlLength} characters. Very long URLs are truncated in SERPs and may cause crawling issues`,
          severity: SEVERITY.HIGH,
          value: urlLength,
        });
      } else if (urlLength > 100) {
        issues.push({
          type: 'url_too_long',
          message: 'URL is too long',
          detail: `URL has ${urlLength} characters (recommended: <100)`,
          severity: urlLength > 150 ? SEVERITY.MEDIUM : SEVERITY.LOW,
          value: urlLength,
        });
      }

      // URL depth check (number of path segments)
      const pathSegments = parsedUrl.pathname.split('/').filter((s) => s.length > 0);
      const depth = pathSegments.length;
      if (depth > 4) {
        issues.push({
          type: 'url_too_deep',
          message: 'URL structure is too deep',
          detail: `URL has ${depth} levels (recommended: ≤4)`,
          severity: depth > 6 ? SEVERITY.MEDIUM : SEVERITY.LOW,
          value: depth,
        });
      }

      // Check for tracking parameters (uses centralized TRACKING_PARAMS from utils)
      const foundTracking: string[] = [];
      for (const [key] of parsedUrl.searchParams) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) {
          foundTracking.push(key);
        }
      }
      if (foundTracking.length > 0) {
        issues.push({
          type: 'tracking_parameters_in_url',
          message: 'URL contains tracking parameters',
          detail: `Found parameters: ${foundTracking.join(', ')}. These should be handled via canonical tags or parameter handling in Search Console`,
          severity: SEVERITY.MEDIUM,
          value: foundTracking,
        });
      }

      // Check for session IDs in URL
      const sessionParams = ['sessionid', 'session_id', 'sid', 'phpsessid', 'jsessionid', 'aspsessionid'];
      for (const param of sessionParams) {
        if (parsedUrl.searchParams.has(param) || parsedUrl.pathname.toLowerCase().includes(param)) {
          issues.push({
            type: 'session_id_in_url',
            message: 'Session ID detected in URL',
            detail: `Session IDs in URLs create duplicate content issues and should be avoided`,
            severity: SEVERITY.HIGH,
          });
          break;
        }
      }

      // Check for uppercase characters in URL path
      if (parsedUrl.pathname !== parsedUrl.pathname.toLowerCase()) {
        issues.push({
          type: 'uppercase_in_url',
          message: 'URL contains uppercase characters',
          detail: `URLs should be lowercase for consistency. Current: ${parsedUrl.pathname}`,
          severity: SEVERITY.LOW,
        });
      }

      // Check for underscores vs hyphens
      if (parsedUrl.pathname.includes('_')) {
        issues.push({
          type: 'underscores_in_url',
          message: 'URL contains underscores',
          detail: `Google recommends using hyphens (-) instead of underscores (_) in URLs`,
          severity: SEVERITY.LOW,
        });
      }

      // Check for special characters
      const specialChars = /[!@#$%^&*()+=\[\]{}|\\:;"'<>,?]/;
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(parsedUrl.pathname);
      } catch {
        decodedPath = parsedUrl.pathname;
      }
      if (specialChars.test(decodedPath)) {
        issues.push({
          type: 'special_chars_in_url',
          message: 'URL contains special characters',
          detail: `Special characters in URLs can cause crawling issues`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check for multiple consecutive slashes
      if (/\/\/+/.test(parsedUrl.pathname.slice(1))) {
        // Skip protocol slashes
        issues.push({
          type: 'multiple_slashes',
          message: 'URL contains multiple consecutive slashes',
          detail: `Multiple slashes can create duplicate content: ${parsedUrl.pathname}`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Check for file extensions that might indicate non-SEO-friendly URLs
      const problematicExtensions = ['.php', '.asp', '.aspx', '.jsp', '.cgi'];
      for (const ext of problematicExtensions) {
        if (parsedUrl.pathname.toLowerCase().endsWith(ext)) {
          issues.push({
            type: 'dynamic_extension',
            message: 'URL has dynamic file extension',
            detail: `URLs with ${ext} extensions may appear less authoritative. Consider URL rewriting`,
            severity: SEVERITY.LOW,
          });
          break;
        }
      }

      // Check for numbers that might indicate pagination or sorting
      const paginationPattern = /[?&](page|p|pg|offset|start)=\d+/i;
      if (paginationPattern.test(url)) {
        issues.push({
          type: 'pagination_parameter',
          message: 'URL contains pagination parameters',
          detail: `Ensure proper canonical and rel="prev/next" tags are set for paginated content`,
          severity: SEVERITY.LOW,
        });
      }

      // Check for sorting/filtering parameters
      const sortingPattern = /[?&](sort|order|filter|category|tag)=/i;
      if (sortingPattern.test(url)) {
        issues.push({
          type: 'filtering_parameters',
          message: 'URL contains sorting/filtering parameters',
          detail: `These URLs may create duplicate content. Consider using canonical tags or noindex`,
          severity: SEVERITY.LOW,
        });
      }

      // Check for hash fragments with content
      if (parsedUrl.hash && parsedUrl.hash.length > 1) {
        // Check if it's not just an anchor
        if (parsedUrl.hash.includes('/') || parsedUrl.hash.includes('=')) {
          issues.push({
            type: 'hash_based_routing',
            message: 'URL uses hash-based routing',
            detail: `Content after # is not indexed by search engines. Consider using History API for SPA routing`,
            severity: SEVERITY.HIGH,
          });
        }
      }

      // Check subdomain consistency with origin
      if (parsedUrl.hostname !== parsedOrigin.hostname) {
        const isWwwVariant =
          parsedUrl.hostname === 'www.' + parsedOrigin.hostname ||
          parsedOrigin.hostname === 'www.' + parsedUrl.hostname;

        if (isWwwVariant) {
          issues.push({
            type: 'www_inconsistency',
            message: 'www/non-www inconsistency detected',
            detail: `URL ${parsedUrl.hostname} differs from origin ${parsedOrigin.hostname}. Ensure proper redirects`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }

      // Store URL metrics in pageData
      pageData.urlAnalysis = {
        length: urlLength,
        depth,
        hasTrackingParams: foundTracking.length > 0,
        trackingParams: foundTracking,
        hasUppercase: parsedUrl.pathname !== parsedUrl.pathname.toLowerCase(),
        hasUnderscores: parsedUrl.pathname.includes('_'),
        hasSpaces: parsedUrl.pathname.includes('%20') || parsedUrl.pathname.includes(' '),
        hasSpecialChars: /[^a-zA-Z0-9\-_/.]/.test(parsedUrl.pathname),
        hasQueryParams: parsedUrl.searchParams.toString().length > 0,
        queryParamCount: Array.from(parsedUrl.searchParams.keys()).length,
        paramCount: Array.from(parsedUrl.searchParams.keys()).length,
        isHttps: parsedUrl.protocol === 'https:',
        issues: [],
      };
    } catch (error: unknown) {
      issues.push({
        type: 'url_parse_error',
        message: 'Failed to parse URL',
        detail: (error as Error).message,
        severity: SEVERITY.LOW,
      });
    }

    return { issues };
  }

  /**
   * Site-wide URL architecture analysis
   * @param {Object} pages - All pages data
   * @param {string} origin - Site origin
   * @returns {Object} Site-wide issues
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>, _origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const urlLengths: number[] = [];
    const urlDepths: number[] = [];
    const trailingSlashCount = { with: 0, without: 0 };
    const protocolCounts = { http: 0, https: 0 };

    for (const url of Object.keys(pages)) {
      try {
        const parsed = new URL(url);

        // Track URL lengths
        urlLengths.push(url.length);

        // Track URL depths
        const depth = parsed.pathname.split('/').filter((s) => s.length > 0).length;
        urlDepths.push(depth);

        // Track trailing slashes
        if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
          trailingSlashCount.with++;
        } else if (parsed.pathname !== '/') {
          trailingSlashCount.without++;
        }

        // Track protocols
        if (parsed.protocol === 'https:') {
          protocolCounts.https++;
        } else {
          protocolCounts.http++;
        }
      } catch {
        // Skip invalid URLs
      }
    }

    // Check trailing slash consistency
    if (trailingSlashCount.with > 0 && trailingSlashCount.without > 0) {
      const total = trailingSlashCount.with + trailingSlashCount.without;
      const withPercent = ((trailingSlashCount.with / total) * 100).toFixed(1);
      const withoutPercent = ((trailingSlashCount.without / total) * 100).toFixed(1);

      issues.push({
        message: 'Inconsistent trailing slash usage across site',
        detail: `${trailingSlashCount.with} URLs (${withPercent}%) have trailing slashes, ${trailingSlashCount.without} (${withoutPercent}%) do not. Pick one convention and redirect the other`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check protocol consistency
    if (protocolCounts.http > 0 && protocolCounts.https > 0) {
      issues.push({
        message: 'Mixed HTTP/HTTPS URLs detected',
        detail: `Found ${protocolCounts.http} HTTP and ${protocolCounts.https} HTTPS URLs. All URLs should use HTTPS`,
        severity: SEVERITY.HIGH,
      });
    }

    // Check average URL depth
    if (urlDepths.length > 0) {
      const avgDepth = urlDepths.reduce((a, b) => a + b, 0) / urlDepths.length;
      const maxDepth = Math.max(...urlDepths);

      if (avgDepth > 3) {
        warnings.push({
          message: 'Site has deep URL structure',
          detail: `Average URL depth is ${avgDepth.toFixed(1)} levels (recommended: ≤3). Maximum depth: ${maxDepth}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Check average URL length
    if (urlLengths.length > 0) {
      const avgLength = urlLengths.reduce((a, b) => a + b, 0) / urlLengths.length;
      const longUrls = urlLengths.filter((l) => l > 100).length;

      if (longUrls > 0) {
        const percent = ((longUrls / urlLengths.length) * 100).toFixed(1);
        warnings.push({
          message: 'Some URLs are too long',
          detail: `${longUrls} URLs (${percent}%) exceed 100 characters. Average URL length: ${avgLength.toFixed(0)} characters`,
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings };
  }
}

export { UrlArchitectureAnalyzer };
