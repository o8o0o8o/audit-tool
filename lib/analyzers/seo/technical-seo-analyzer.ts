/**
 * Technical SEO Analyzer
 * Detects technical SEO issues like meta refresh, JS frameworks, CMS, etc.
 */

import { SEVERITY, THRESHOLDS } from '../../constants';
import { incrementCounter, hasSSRIndicators, detectLazyLoading as sharedDetectLazyLoading, hasRobotsDirective, formatBytes } from '../../utils';
import { TechnologyDetector } from './technology-detector';
import type { ParsedPage, Issue, PageInfo } from '../../types';

class TechnicalSEOAnalyzer {
  /**
   * Analyze technical SEO signals
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data object
   * @returns {Object} Analysis results
   */
  static analyze(parsedPage: ParsedPage, url: string, pageData: PageInfo) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const technicalData = {
      metaRefresh: null as { delay: number; url: string | null } | null,
      jsFramework: null as string | null,
      cms: null as string | null,
      generator: null as string | null,
      amp: false,
      pwa: false,
      lazyLoading: false as boolean | { type: string; count?: number; pattern?: string } | null,
      preload: [] as { href: string; as: string | null }[],
      prefetch: [] as string[],
      dns_prefetch: [] as string[],
    };

    if (!parsedPage) {
      return { issues, warnings, technicalData };
    }

    // 0. Check DOCTYPE and charset
    this.checkDoctype(parsedPage, url, issues, warnings);

    // 1. Check for meta refresh (SEO anti-pattern)
    const metaRefresh = this.detectMetaRefresh(parsedPage);
    if (metaRefresh) {
      technicalData.metaRefresh = metaRefresh;
      if (metaRefresh.delay <= 5) {
        issues.push({
          message: 'Page uses meta refresh redirect',
          detail: `<a href="${url}">${url}</a> uses meta refresh (${metaRefresh.delay}s delay). Use 301/302 redirects instead for SEO.`,
          severity: SEVERITY.HIGH,
        });
      } else {
        warnings.push({
          message: 'Page uses delayed meta refresh',
          detail: `Page will redirect after ${metaRefresh.delay} seconds. This can confuse users and search engines.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // 2. Detect JavaScript framework
    technicalData.jsFramework = TechnologyDetector.quickDetectFramework(parsedPage.toString());
    if (technicalData.jsFramework) {
      const framework = technicalData.jsFramework;
      // Check for potential JS rendering issues
      const frameworkLower = framework.toLowerCase();
      if (['react', 'vue', 'angular'].some((f) => frameworkLower.includes(f))) {
        const hasSSR = hasSSRIndicators(parsedPage);
        if (!hasSSR) {
          warnings.push({
            message: `${framework} detected - verify server-side rendering`,
            detail: `Client-side rendered ${framework} apps may have indexing issues. Ensure SSR/prerendering is configured.`,
            severity: SEVERITY.MEDIUM,
          });
        }
      }
    }

    // 3. Detect CMS
    technicalData.cms = TechnologyDetector.quickDetectCMS(parsedPage.toString());
    technicalData.generator = this.getGenerator(parsedPage);

    // 4. Check for AMP
    technicalData.amp = this.detectAMP(parsedPage);

    // 5. Check for PWA signals
    technicalData.pwa = this.detectPWA(parsedPage);

    // 6. Check resource hints
    const hints = this.analyzeResourceHints(parsedPage);
    technicalData.preload = hints.preload;
    technicalData.prefetch = hints.prefetch;
    technicalData.dns_prefetch = hints.dnsPrefetch;

    if (hints.preload.length === 0 && (pageData.totalResponseSize ?? 0) > 500000) {
      warnings.push({
        message: 'No resource preloading detected on large page',
        detail: 'Consider using preload for critical resources to improve LCP',
        severity: SEVERITY.LOW,
      });
    }

    // 7. Check for lazy loading implementation
    technicalData.lazyLoading = sharedDetectLazyLoading(parsedPage);

    // 8. Check for inline CSS/JS that could be external
    const inlineAnalysis = this.analyzeInlineResources(parsedPage);
    if (inlineAnalysis.inlineCssSize > THRESHOLDS.INLINE_CSS_SIZE_WARNING) {
      warnings.push({
        message: 'Large amount of inline CSS',
        detail: `${formatBytes(inlineAnalysis.inlineCssSize)} of inline CSS. Consider extracting to external files for caching.`,
        severity: SEVERITY.LOW,
      });
    }
    if (inlineAnalysis.inlineJsSize > THRESHOLDS.INLINE_JS_SIZE_WARNING) {
      warnings.push({
        message: 'Large amount of inline JavaScript',
        detail: `${formatBytes(inlineAnalysis.inlineJsSize)} of inline JS. Consider extracting to external files.`,
        severity: SEVERITY.LOW,
      });
    }

    // 9. Check for noscript content
    const hasNoscript = this.checkNoscriptContent(parsedPage);
    if (technicalData.jsFramework && !hasNoscript) {
      warnings.push({
        message: 'No noscript fallback content',
        detail: 'Consider adding noscript content for users/crawlers with JavaScript disabled',
        severity: SEVERITY.LOW,
      });
    }

    // 10. Check for X-Robots-Tag conflicts
    this.checkRobotsTagConflicts(pageData, issues);

    // 11. Check for iframes with content
    this.checkIframes(parsedPage, url, warnings);

    // 12. Check HTML document size
    this.checkHTMLSize(pageData, url, issues, warnings);

    // Store in pageData
    pageData.technical = technicalData;

    return { issues, warnings, technicalData };
  }

  /**
   * Detect meta refresh redirect
   */
  static detectMetaRefresh(parsedPage: ParsedPage) {
    const metaRefresh = parsedPage.querySelector('meta[http-equiv="refresh"]');
    if (!metaRefresh) return null;

    const content = metaRefresh.getAttribute('content') ?? '';
    const match = content.match(/^(\d+)(?:\s*;\s*url\s*=\s*['"]?([^'">\s]+))?/i);

    if (match) {
      return {
        delay: parseInt(match[1], 10),
        url: match[2] || null,
      };
    }

    return null;
  }

  /**
   * Get generator meta tag
   */
  static getGenerator(parsedPage: ParsedPage) {
    const generator = parsedPage.querySelector('meta[name="generator"]');
    return generator ? (generator.getAttribute('content') ?? null) : null;
  }

  /**
   * Detect AMP page
   */
  static detectAMP(parsedPage: ParsedPage) {
    const html = parsedPage.querySelector('html');
    if (!html) return false;

    const attrs = html.rawAttrs || '';
    return attrs.includes('amp') || attrs.includes('⚡');
  }

  /**
   * Detect PWA signals
   */
  static detectPWA(parsedPage: ParsedPage) {
    // Check for manifest
    const manifest = parsedPage.querySelector('link[rel="manifest"]');
    if (!manifest) return false;

    // Check for service worker registration in scripts
    const scripts = parsedPage.querySelectorAll('script');
    for (const script of scripts) {
      const content = script.textContent || '';
      if (content.includes('serviceWorker.register')) {
        return true;
      }
    }

    return !!manifest;
  }

  /**
   * Analyze resource hints (preload, prefetch, dns-prefetch)
   */
  static analyzeResourceHints(parsedPage: ParsedPage) {
    const preload: { href: string; as: string | null }[] = [];
    const prefetch: string[] = [];
    const dnsPrefetch: string[] = [];

    const links = parsedPage.querySelectorAll('link');
    for (const link of links) {
      const rel = link.getAttribute('rel');
      const href = link.getAttribute('href');

      if (!href) continue;

      if (rel === 'preload') {
        preload.push({
          href,
          as: link.getAttribute('as') ?? null,
        });
      } else if (rel === 'prefetch') {
        prefetch.push(href);
      } else if (rel === 'dns-prefetch') {
        dnsPrefetch.push(href);
      }
    }

    return { preload, prefetch, dnsPrefetch };
  }

  /**
   * Analyze inline CSS and JS sizes
   */
  static analyzeInlineResources(parsedPage: ParsedPage) {
    let inlineCssSize = 0;
    let inlineJsSize = 0;

    // Inline styles
    const styles = parsedPage.querySelectorAll('style');
    for (const style of styles) {
      inlineCssSize += (style.textContent || '').length;
    }

    // Inline scripts (excluding JSON-LD)
    const scripts = parsedPage.querySelectorAll('script:not([src]):not([type="application/ld+json"])');
    for (const script of scripts) {
      inlineJsSize += (script.textContent || '').length;
    }

    return { inlineCssSize, inlineJsSize };
  }

  /**
   * Check for noscript content
   */
  static checkNoscriptContent(parsedPage: ParsedPage) {
    const noscript = parsedPage.querySelectorAll('noscript');
    for (const ns of noscript) {
      const content = ns.textContent.trim();
      // Check if noscript has meaningful content (not just tracking pixels)
      if (content.length > 50 && !content.includes('iframe') && !content.includes('img')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check for DOCTYPE and charset declarations
   */
  static checkDoctype(parsedPage: ParsedPage, url: string, issues: Issue[], warnings: Issue[]) {
    const html = parsedPage.toString();

    // Check DOCTYPE - should be at the very beginning
    const hasDoctype = /<!doctype\s+html/i.test(html);
    if (!hasDoctype) {
      warnings.push({
        message: 'Missing <!DOCTYPE html> declaration',
        detail: `<a href="${url}">${url}</a> has no DOCTYPE declaration. This may cause browsers to render in quirks mode.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check charset (already partially covered by international-seo-analyzer,
    // but this checks from a rendering/technical perspective)
    const hasCharset =
      parsedPage.querySelector('meta[charset]') ?? parsedPage.querySelector('meta[http-equiv="Content-Type"]');
    if (!hasCharset) {
      warnings.push({
        message: 'Missing character encoding declaration',
        detail: `<a href="${url}">${url}</a> has no <meta charset> or Content-Type meta tag. Declare UTF-8 encoding for proper rendering.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }

  /**
   * Check for iframes that may hide content from crawlers
   */
  static checkIframes(parsedPage: ParsedPage, url: string, warnings: Issue[]) {
    // Check for deprecated <frame> / <frameset> elements
    const frames = parsedPage.querySelectorAll('frame, frameset');
    if (frames.length > 0) {
      warnings.push({
        message: 'Deprecated <frame>/<frameset> elements detected',
        detail: `<a href="${url}">${url}</a> uses deprecated frame elements. Content inside frames is not reliably indexed by search engines. Migrate to modern HTML.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Check for iframes with significant content
    const iframes = parsedPage.querySelectorAll('iframe');
    const contentIframes: string[] = [];

    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') ?? '';
      const width = iframe.getAttribute('width');
      const height = iframe.getAttribute('height');

      // Skip small iframes (tracking pixels, widgets)
      if ((width && parseInt(width) < 100) || (height && parseInt(height) < 100)) continue;
      // Skip known non-content iframes
      if (/google.*maps|youtube|vimeo|recaptcha|facebook.*plugin|twitter/i.test(src)) continue;

      contentIframes.push(src || '(no src)');
    }

    if (contentIframes.length > 0) {
      warnings.push({
        message: 'Content may be hidden in iframes',
        detail: `<a href="${url}">${url}</a> has ${contentIframes.length} iframe(s) that may contain indexable content: ${contentIframes.slice(0, 3).join(', ')}. Content inside iframes is not indexed as part of the parent page.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }

  /**
   * Check HTML document size
   */
  static checkHTMLSize(pageData: PageInfo, url: string, issues: Issue[], warnings: Issue[]) {
    const htmlSize = pageData.htmlSize ?? pageData.totalResponseSize;
    if (!htmlSize) return;

    // Flag very large HTML documents (>3MB)
    if (htmlSize > 3 * 1024 * 1024) {
      issues.push({
        message: 'HTML document exceeds 3MB',
        detail: `<a href="${url}">${url}</a> HTML is ${formatBytes(htmlSize)}. Very large HTML slows parsing, wastes crawl budget, and may hit Google's 15MB rendering limit.`,
        severity: SEVERITY.HIGH,
      });
    } else if (htmlSize > 1 * 1024 * 1024) {
      warnings.push({
        message: 'Large HTML document',
        detail: `<a href="${url}">${url}</a> HTML is ${formatBytes(htmlSize)}. Consider reducing HTML size by removing unnecessary inline resources.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }

  /**
   * Check for robots tag conflicts
   */
  static checkRobotsTagConflicts(pageData: PageInfo, issues: Issue[]) {
    const metaRobots =
      (pageData.meta?.find((m: unknown) => (m as Record<string, unknown>).robots) as Record<string, string> | undefined)
        ?.robots ?? '';
    const xRobotsTag = pageData.response?.headers?.['x-robots-tag'] ?? '';

    if (metaRobots && xRobotsTag) {
      // Check for conflicts
      const metaNoindex = hasRobotsDirective(metaRobots, 'noindex');
      const headerNoindex = hasRobotsDirective(xRobotsTag, 'noindex');
      const metaIndex = hasRobotsDirective(metaRobots, 'index') && !metaNoindex;
      const headerIndex = hasRobotsDirective(xRobotsTag, 'index') && !headerNoindex;

      if ((metaNoindex && headerIndex) || (metaIndex && headerNoindex)) {
        issues.push({
          message: 'Conflicting robots directives',
          detail: `Meta robots: "${metaRobots}" vs X-Robots-Tag header: "${xRobotsTag}". Search engines typically follow the most restrictive directive.`,
          severity: SEVERITY.HIGH,
        });
      }
    }
  }

  /**
   * Site-wide technical analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let metaRefreshCount = 0;
    const frameworks = new Map();
    const cmsCount = new Map();
    let ampPages = 0;
    let pwaEnabled = 0;
    let lazyLoadingPages = 0;

    for (const [_url, page] of Object.entries(pages)) {
      if (page.technical) {
        if (page.technical.metaRefresh) metaRefreshCount++;

        if (page.technical.jsFramework) {
          const fw = page.technical.jsFramework;
          incrementCounter(frameworks, fw);
        }

        if (page.technical.cms) {
          const cms = page.technical.cms;
          incrementCounter(cmsCount, cms);
        }

        if (page.technical.amp) ampPages++;

        if (page.technical.pwa) pwaEnabled++;

        if (page.technical.lazyLoading) lazyLoadingPages++;
      }
    }

    const totalPages = Object.keys(pages).length;

    // Report meta refresh issues
    if (metaRefreshCount > 0) {
      issues.push({
        message: `${metaRefreshCount} pages use meta refresh redirects`,
        detail: 'Replace meta refresh with proper HTTP redirects for better SEO',
        severity: SEVERITY.HIGH,
      });
    }

    // Report mixed frameworks
    if (frameworks.size > 1) {
      warnings.push({
        message: 'Multiple JavaScript frameworks detected',
        detail: `Found: ${Array.from(frameworks.entries())
          .map(([f, c]) => `${f} (${c})`)
          .join(', ')}. Consider standardizing.`,
        severity: SEVERITY.LOW,
      });
    }

    // Report lazy loading adoption
    if (lazyLoadingPages < totalPages * 0.5 && totalPages > 5) {
      warnings.push({
        message: 'Low lazy loading adoption',
        detail: `Only ${lazyLoadingPages} of ${totalPages} pages use lazy loading. Consider implementing for performance.`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      issues,
      warnings,
      metrics: {
        metaRefreshCount,
        frameworks: Object.fromEntries(frameworks),
        cms: Object.fromEntries(cmsCount),
        ampPages,
        pwaEnabled,
        lazyLoadingPages,
      },
    };
  }
}

export { TechnicalSEOAnalyzer };
