/**
 * Response Header Analyzer
 * Analyzes HTTP response headers for SEO-relevant signals:
 * - Vary header (caching/content negotiation)
 * - Link header (preload hints, canonical, rel=alternate)
 * - X-Robots-Tag (indexing directives via HTTP header)
 * - Content-Language (language declaration via header)
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

class ResponseHeaderAnalyzer {
  /**
   * Analyze response headers for SEO signals
   * @param {object} pageData - Page data with responseHeaders
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: any, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const headers = pageData.response?.headers || pageData.responseHeaders || {};

    const info: Record<string, any> = {
      vary: null,
      linkHeader: null,
      xRobotsTag: null,
      contentLanguage: null,
      parsedLinks: [],
      varyDirectives: [],
    };

    // Analyze Vary header
    const vary = headers['vary'];
    if (vary) {
      info.vary = vary;
      info.varyDirectives = vary.split(',').map((d: any) => d.trim().toLowerCase());

      // Warn if Vary includes too many directives (cache fragmentation)
      if (info.varyDirectives.length > 3) {
        warnings.push({
          message: 'Excessive Vary header directives may fragment caching',
          detail: `<a href="${url}">${url}</a> has ${info.varyDirectives.length} Vary directives: ${vary}. This can reduce cache hit rate.`,
          severity: SEVERITY.LOW,
        });
      }

      // Check if Vary: User-Agent is used (mobile serving)
      if (info.varyDirectives.includes('user-agent')) {
        info.dynamicServing = true;
      }
    }

    // Analyze Link header (RFC 8288)
    const linkHeader = headers['link'];
    if (linkHeader) {
      info.linkHeader = linkHeader;
      info.parsedLinks = ResponseHeaderAnalyzer.#parseLinkHeader(linkHeader);

      // Check for preload hints
      const preloads = info.parsedLinks.filter((l: any) => l.rel === 'preload');
      if (preloads.length > 0) {
        info.preloadHints = preloads.map((p: any) => ({ url: p.url, as: p.as }));
      }

      // Check for canonical via Link header
      const canonical = info.parsedLinks.find((l: any) => l.rel === 'canonical');
      if (canonical) {
        info.httpCanonical = canonical.url;
      }

      // Check for alternate language links via Link header
      const alternates = info.parsedLinks.filter((l: any) => l.rel === 'alternate' && l.hreflang);
      if (alternates.length > 0) {
        info.httpAlternates = alternates.map((a: any) => ({ url: a.url, hreflang: a.hreflang }));
      }
    }

    // Analyze X-Robots-Tag
    const xRobotsTag = headers['x-robots-tag'];
    if (xRobotsTag) {
      info.xRobotsTag = xRobotsTag;
      // Directives may have user-agent prefix like "googlebot: noindex, nofollow"
      const directives = xRobotsTag.toLowerCase().split(',').map((d: any) => {
        const trimmed = d.trim();
        // Strip user-agent prefix if present (e.g., "googlebot: noindex" → "noindex")
        const colonIdx = trimmed.indexOf(':');
        return colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : trimmed;
      });

      if (directives.some((d: any) => d === 'noindex')) {
        info.noindexViaHeader = true;
      }
      if (directives.some((d: any) => d === 'nofollow')) {
        info.nofollowViaHeader = true;
      }
      if (directives.some((d: any) => d === 'nosnippet')) {
        info.nosnippetViaHeader = true;
      }
      if (directives.some((d: any) => d === 'noarchive')) {
        info.noarchiveViaHeader = true;
      }

      // Check for max-snippet, max-image-preview, max-video-preview
      for (const directive of directives) {
        if (directive.startsWith('max-snippet:')) {
          info.maxSnippet = parseInt(directive.split(':')[1], 10);
        }
        if (directive.startsWith('max-image-preview:')) {
          info.maxImagePreview = directive.split(':')[1].trim();
        }
      }
    }

    // Analyze Content-Language
    const contentLanguage = headers['content-language'];
    if (contentLanguage) {
      info.contentLanguage = contentLanguage;

      // Check for mismatch with html lang attribute
      const htmlLang = pageData.internationalSEO?.htmlLang || pageData.lang;
      if (htmlLang && contentLanguage) {
        const headerLang = contentLanguage.split(',')[0].trim().toLowerCase().split('-')[0];
        const htmlLangPrimary = htmlLang.toLowerCase().split('-')[0];
        if (headerLang !== htmlLangPrimary) {
          issues.push({
            message: 'Content-Language header mismatches html lang attribute',
            detail: `<a href="${url}">${url}</a>: Content-Language header "${contentLanguage}" does not match html lang="${htmlLang}". This can confuse search engines.`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }
    }

    // Check for missing security-related SEO headers
    if (!headers['x-content-type-options']) {
      info.missingXContentTypeOptions = true;
    }

    return { info, issues, warnings };
  }

  /**
   * Site-wide analysis of response headers
   * @param {object} allPages - All page data
   * @returns {object} Site-wide analysis results
   */
  static analyzeSiteWide(allPages: Record<string, any>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.values(allPages) as any[];

    let pagesWithXRobotsNoindex = 0;
    let pagesWithDynamicServing = 0;
    let pagesWithLinkCanonical = 0;
    const varyPatterns: Record<string, number> = {};

    for (const page of pages) {
      const headerData = page.responseHeaderAnalysis;
      if (!headerData) continue;

      if (headerData.noindexViaHeader) pagesWithXRobotsNoindex++;
      if (headerData.dynamicServing) pagesWithDynamicServing++;
      if (headerData.httpCanonical) pagesWithLinkCanonical++;

      const varyKey = headerData.vary || 'none';
      varyPatterns[varyKey] = (varyPatterns[varyKey] || 0) + 1;
    }

    if (pagesWithXRobotsNoindex > 0) {
      issues.push({
        title: `${pagesWithXRobotsNoindex} page(s) blocked via X-Robots-Tag: noindex`,
        description: `These pages are blocked from indexing via HTTP response headers rather than meta tags. Verify this is intentional.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (pagesWithDynamicServing > 0) {
      warnings.push({
        title: `${pagesWithDynamicServing} page(s) use Vary: User-Agent (dynamic serving)`,
        description: `Dynamic serving detected. Ensure Google can access both mobile and desktop versions.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check for inconsistent Vary patterns
    const varyKeys = Object.keys(varyPatterns).filter(k => k !== 'none');
    if (varyKeys.length > 2) {
      warnings.push({
        title: 'Inconsistent Vary header patterns across pages',
        description: `Found ${varyKeys.length} different Vary header configurations. This may cause inconsistent caching behavior.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }

  /**
   * Parse Link header (RFC 8288)
   * @param {string} header - Link header value
   * @returns {Array} Parsed links
   * @private
   */
  static #parseLinkHeader(header: string) {
    const links: Record<string, any>[] = [];
    // Split on comma but not within angle brackets
    const parts = header.split(/,(?=\s*<)/);

    for (const part of parts) {
      const urlMatch = part.match(/<([^>]+)>/);
      if (!urlMatch) continue;

      const link: Record<string, any> = { url: urlMatch[1] };

      // Extract parameters
      const params = part.substring(urlMatch[0].length);
      const relMatch = params.match(/rel="?([^";,]+)"?/i);
      if (relMatch) link.rel = relMatch[1].trim().toLowerCase();

      const hreflangMatch = params.match(/hreflang="?([^";,]+)"?/i);
      if (hreflangMatch) link.hreflang = hreflangMatch[1].trim();

      const asMatch = params.match(/as="?([^";,]+)"?/i);
      if (asMatch) link.as = asMatch[1].trim();

      const typeMatch = params.match(/type="?([^";,]+)"?/i);
      if (typeMatch) link.type = typeMatch[1].trim();

      links.push(link);
    }

    return links;
  }
}

export { ResponseHeaderAnalyzer };