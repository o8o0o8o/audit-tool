/**
 * URL Architecture Analyzer
 * Checks URL structure, parameters, and consistency issues
 */

import { SEVERITY } from '../../constants';
import { TRACKING_PARAMS, analyzeUrlStructure, getPathSegments, shortenUrl, formatSampleList } from '../../utils';
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

    // Use shared URL analysis for basic structure checks (length, depth, uppercase, underscores, etc.)
    // The crawler engine already calls analyzeUrlStructure() and stores it in pageData.urlAnalysis,
    // but we ensure it's available here too.
    if (!pageData.urlAnalysis) {
      pageData.urlAnalysis = analyzeUrlStructure(url, origin);
    }

    try {
      const parsedUrl = new URL(url);
      const parsedOrigin = new URL(origin);

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

      // Check for multiple consecutive slashes
      if (/\/\/+/.test(parsedUrl.pathname.slice(1))) {
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

      // Enrich urlAnalysis with tracking param data
      if (pageData.urlAnalysis) {
        pageData.urlAnalysis.hasTrackingParams = foundTracking.length > 0;
        pageData.urlAnalysis.trackingParams = foundTracking;
        pageData.urlAnalysis.paramCount = pageData.urlAnalysis.queryParamCount;
      }
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
    const longUrls: string[] = [];
    const urlDepths: number[] = [];
    const trailingSlashCount = { with: 0, without: 0 };
    const protocolCounts = { http: 0, https: 0 };

    for (const url of Object.keys(pages)) {
      try {
        const parsed = new URL(url);

        // Track URL lengths (and the offending URLs themselves, so the finding
        // can name them instead of only reporting a count).
        urlLengths.push(url.length);
        if (url.length > 100) longUrls.push(url);

        // Track URL depths
        const depth = getPathSegments(parsed.pathname).length;
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

      if (longUrls.length > 0) {
        const percent = ((longUrls.length / urlLengths.length) * 100).toFixed(1);
        // List the actual offending URLs (the longest first) so the reader can
        // see which ones to shorten — not just a count.
        const sample = formatSampleList(
          [...longUrls]
            .sort((a, b) => b.length - a.length)
            .map((u) => `<a href="${u}">${shortenUrl(u)}</a> (${u.length} chars)`),
          5,
        );
        warnings.push({
          message: 'Some URLs are too long',
          detail: `${longUrls.length} URLs (${percent}%) exceed 100 characters. Average URL length: ${avgLength.toFixed(0)} characters. Examples: ${sample}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings };
  }
}

export { UrlArchitectureAnalyzer };
