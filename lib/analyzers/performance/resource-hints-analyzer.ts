/**
 * Resource Hints Analyzer
 * Analyzes preload, prefetch, preconnect, and dns-prefetch usage
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

interface ResourceHint {
  href?: string;
  as?: string;
  crossorigin?: string;
  [key: string]: unknown;
}

interface MissingHint {
  url: string;
  type: string;
  reason: string;
}

class ResourceHintsAnalyzer {
  /**
   * Analyze resource hints for a page
   * @param {object} pageData - Page data
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      preload: [] as ResourceHint[],
      prefetch: [] as ResourceHint[],
      preconnect: [] as ResourceHint[],
      dnsPrefetch: [] as ResourceHint[],
      modulePreload: [] as ResourceHint[],
      missingHints: [] as MissingHint[],
      unnecessaryHints: [] as MissingHint[],
    };

    // Extract resource hints from page data
    const hints = pageData.resourceHints ?? {};
    info.preload = hints.preload ?? [];
    info.prefetch = hints.prefetch ?? [];
    info.preconnect = hints.preconnect ?? [];
    info.dnsPrefetch = hints.dnsPrefetch ?? [];
    info.modulePreload = hints.modulePreload ?? [];

    // Analyze LCP element for preload opportunities
    const lcpUrl = pageData.lcpUrl ?? pageData.vitals?.lcpUrl;

    if (lcpUrl && !this.isPreloaded(lcpUrl, info.preload)) {
      const isImage = /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(lcpUrl);
      if (isImage) {
        info.missingHints.push({
          url: lcpUrl,
          type: 'preload',
          reason: 'LCP image not preloaded',
        });
        issues.push({
          message: 'LCP image not preloaded',
          detail: `The Largest Contentful Paint element (${this.getFileName(lcpUrl)}) should be preloaded for faster rendering. Add: <link rel="preload" as="image" href="${lcpUrl}">`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Check for critical fonts
    const fonts = (pageData.fonts ?? []) as { url: string; critical?: boolean; usedAboveFold?: boolean }[];
    const criticalFonts = fonts.filter((f) => f.critical || f.usedAboveFold);
    for (const font of criticalFonts) {
      if (!this.isPreloaded(font.url, info.preload)) {
        info.missingHints.push({
          url: font.url,
          type: 'preload',
          reason: 'Critical font not preloaded',
        });
        warnings.push({
          message: 'Critical font not preloaded',
          detail: `Font "${this.getFileName(font.url)}" is used above the fold but not preloaded. Add: <link rel="preload" as="font" href="${font.url}" crossorigin>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for third-party origins that should have preconnect
    const thirdPartyOrigins = this.extractThirdPartyOrigins(pageData, url);
    const criticalOrigins = thirdPartyOrigins.filter((o) => o.critical);
    const connectedOrigins = new Set([
      ...info.preconnect.map((p) => this.getOrigin(p.href ?? '')),
      ...info.dnsPrefetch.map((p) => this.getOrigin(p.href ?? '')),
    ]);

    for (const origin of criticalOrigins) {
      if (!connectedOrigins.has(origin.origin)) {
        info.missingHints.push({
          url: origin.origin,
          type: 'preconnect',
          reason: origin.reason,
        });
        warnings.push({
          message: 'Critical third-party origin lacks preconnect',
          detail: `${origin.origin} (${origin.reason}) should use preconnect. Add: <link rel="preconnect" href="${origin.origin}">`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for unnecessary preloads (not used within 3s)
    const unusedPreloads = info.preload.filter((p) => {
      const href = p.href ?? '';
      return pageData.unusedPreloads?.includes(href);
    });

    if (unusedPreloads.length > 0) {
      info.unnecessaryHints = unusedPreloads.map((p) => ({
        url: p.href ?? '',
        type: 'preload',
        reason: 'Not used within 3 seconds',
      }));
      warnings.push({
        message: 'Unused preload hints detected',
        detail: `${unusedPreloads.length} preloaded resources not used within 3 seconds: ${unusedPreloads
          .slice(0, 3)
          .map((p) => this.getFileName(p.href ?? ''))
          .join(', ')}. Remove or defer these preloads.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check preload 'as' attribute
    for (const preload of info.preload) {
      if (!preload.as && typeof preload === 'object') {
        warnings.push({
          message: 'Preload missing "as" attribute',
          detail: `Preload for "${this.getFileName(preload.href ?? '')}" lacks 'as' attribute. Browser may not prioritize correctly.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for crossorigin on font preloads
    for (const preload of info.preload) {
      if (preload.as === 'font' && !preload.crossorigin) {
        warnings.push({
          message: 'Font preload missing crossorigin',
          detail: `Font preload "${this.getFileName(preload.href ?? '')}" needs crossorigin attribute to work correctly.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Summary
    const hasAnyHints =
      info.preload.length + info.prefetch.length + info.preconnect.length + info.dnsPrefetch.length > 0;
    if (!hasAnyHints && pageData.resources?.length > 10) {
      warnings.push({
        message: 'No resource hints detected',
        detail:
          'Page has no preload, prefetch, preconnect, or dns-prefetch hints. Consider adding hints for critical resources.',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Check if URL is preloaded
   */
  static isPreloaded(url: string, preloads: ResourceHint[]) {
    return preloads.some((p) => {
      const href = p.href ?? '';
      return href === url || url.includes(href) || href.includes(url);
    });
  }

  /**
   * Extract third-party origins from page resources
   */
  static extractThirdPartyOrigins(pageData: PageInfo, pageUrl: string) {
    const origins = new Map();
    const pageOrigin = this.getOrigin(pageUrl);

    const resources = pageData.resources ?? [];
    for (const resource of resources) {
      const resourceOrigin = this.getOrigin(resource.url);
      if (resourceOrigin && resourceOrigin !== pageOrigin) {
        if (!origins.has(resourceOrigin)) {
          origins.set(resourceOrigin, {
            origin: resourceOrigin,
            count: 0,
            types: new Set(),
            critical: false,
            reason: '',
          });
        }
        const entry = origins.get(resourceOrigin);
        entry.count++;
        entry.types.add(resource.type || 'unknown');

        // Mark as critical if it's a render-blocking resource or font
        if (
          resource.renderBlocking ||
          resource.type === 'font' ||
          (resource.type === 'script' && !resource.async && !resource.defer)
        ) {
          entry.critical = true;
          entry.reason = resource.type === 'font' ? 'fonts' : 'render-blocking resources';
        }
      }
    }

    // Also check for analytics/tracking origins
    const knownCriticalDomains = [
      { pattern: /google-analytics\.com/, reason: 'analytics' },
      { pattern: /googletagmanager\.com/, reason: 'tag manager' },
      { pattern: /fonts\.googleapis\.com/, reason: 'Google Fonts' },
      { pattern: /fonts\.gstatic\.com/, reason: 'Google Fonts files' },
      { pattern: /cdnjs\.cloudflare\.com/, reason: 'CDN resources' },
      { pattern: /cdn\.jsdelivr\.net/, reason: 'CDN resources' },
      { pattern: /unpkg\.com/, reason: 'CDN resources' },
    ];

    for (const [origin, entry] of origins) {
      for (const known of knownCriticalDomains) {
        if (known.pattern.test(origin)) {
          entry.critical = true;
          entry.reason = known.reason;
          break;
        }
      }
    }

    return Array.from(origins.values());
  }

  /**
   * Get origin from URL
   */
  static getOrigin(url: string) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  /**
   * Get filename from URL
   */
  static getFileName(url: string) {
    try {
      const pathname = new URL(url).pathname;
      return pathname.split('/').pop() || pathname;
    } catch {
      return url?.substring(0, 50) || 'unknown';
    }
  }

  /**
   * Analyze resource hints across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      pagesWithHints: 0,
      pagesWithoutHints: 0,
      totalPreloads: 0,
      totalPrefetch: 0,
      totalPreconnect: 0,
      totalDnsPrefetch: 0,
      pagesWithLcpPreload: 0,
      pagesWithMissingLcpPreload: 0,
    };

    const commonMissingHints = new Map();

    for (const [_url, pageData] of Object.entries(pages)) {
      const hints = pageData.resourceHints ?? {};
      const hasHints =
        (hints.preload?.length ?? 0) +
          (hints.prefetch?.length ?? 0) +
          (hints.preconnect?.length ?? 0) +
          (hints.dnsPrefetch?.length ?? 0) >
        0;

      if (hasHints) {
        stats.pagesWithHints++;
        stats.totalPreloads += hints.preload?.length ?? 0;
        stats.totalPrefetch += hints.prefetch?.length ?? 0;
        stats.totalPreconnect += hints.preconnect?.length ?? 0;
        stats.totalDnsPrefetch += hints.dnsPrefetch?.length ?? 0;
      } else {
        stats.pagesWithoutHints++;
      }

      // Check LCP preload
      const lcpUrl = pageData.lcpUrl ?? pageData.vitals?.lcpUrl;
      if (lcpUrl) {
        const isPreloaded = hints.preload?.some((p: Record<string, unknown>) => {
          const href = (p.href as string) ?? '';
          return href === lcpUrl || lcpUrl.includes(href);
        });
        if (isPreloaded) {
          stats.pagesWithLcpPreload++;
        } else if (/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(lcpUrl)) {
          stats.pagesWithMissingLcpPreload++;
          // Track common missing hints
          const key = this.getFileName(lcpUrl);
          commonMissingHints.set(key, (commonMissingHints.get(key) ?? 0) + 1);
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    // Site-wide issues
    if (stats.pagesWithoutHints > totalPages * 0.5) {
      warnings.push({
        message: 'Most pages lack resource hints',
        detail: `${stats.pagesWithoutHints}/${totalPages} pages have no preload, prefetch, or preconnect hints. Consider adding hints for critical resources.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (stats.pagesWithMissingLcpPreload > 0) {
      issues.push({
        message: 'LCP images not preloaded across site',
        detail: `${stats.pagesWithMissingLcpPreload} pages have LCP images that could benefit from preloading. This can significantly improve LCP scores.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report commonly missing hints
    const topMissing = Array.from(commonMissingHints.entries())
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 5);

    if (topMissing.length > 0) {
      warnings.push({
        message: 'Common resources that could be preloaded',
        detail: `Frequently used resources without preload: ${topMissing.map(([name, count]) => `${name} (${count} pages)`).join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }
}

export { ResourceHintsAnalyzer };
