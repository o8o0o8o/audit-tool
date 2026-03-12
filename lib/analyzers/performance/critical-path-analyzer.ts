/**
 * Critical Rendering Path Analyzer
 * Identifies resources that block first paint
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage, PageInfo, NetworkRequest } from '../../types';

class CriticalPathAnalyzer {
  /**
   * Analyze critical rendering path
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {Object} requests - Network requests
   * @param {Object} metrics - Performance metrics
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, requests: NetworkRequest[], metrics: Record<string, any>, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const criticalPathData: Record<string, any> = {
      blockingCSS: [],
      blockingJS: [],
      criticalCSSSize: 0,
      criticalJSSize: 0,
      totalBlockingTime: 0,
      documentSize: 0,
      htmlParseTime: 0,
      domContentLoaded: 0,
      firstPaint: 0,
      recommendations: [],
    };

    // 1. Find render-blocking CSS
    criticalPathData.blockingCSS = this.#findBlockingCSS(parsedPage, requests);
    criticalPathData.criticalCSSSize = criticalPathData.blockingCSS.reduce((sum: number, r: any) => sum + (r.size || 0), 0);

    // 2. Find render-blocking JavaScript
    criticalPathData.blockingJS = this.#findBlockingJS(parsedPage, requests);
    criticalPathData.criticalJSSize = criticalPathData.blockingJS.reduce((sum: number, r: any) => sum + (r.size || 0), 0);

    // 3. Get timing metrics
    const timings = await this.#getTimingMetrics(chromePage);
    criticalPathData.htmlParseTime = timings.htmlParseTime;
    criticalPathData.domContentLoaded = timings.domContentLoaded;
    criticalPathData.firstPaint = timings.firstPaint;

    // 4. Calculate document size
    const docRequest = Object.entries(requests).find(([reqUrl]) =>
      reqUrl === url || reqUrl === url + '/'
    );
    if (docRequest) {
      criticalPathData.documentSize = (docRequest[1] as Record<string, any>).size || 0;
    }

    // 5. Analyze inline styles/scripts
    const inlineAnalysis = this.#analyzeInlineResources(parsedPage);
    criticalPathData.inlineCSS = inlineAnalysis.inlineCSS;
    criticalPathData.inlineJS = inlineAnalysis.inlineJS;
    criticalPathData.inlineCSSSize = inlineAnalysis.inlineCSSSize;
    criticalPathData.inlineJSSize = inlineAnalysis.inlineJSSize;

    // 6. Check for critical CSS implementation
    criticalPathData.hasCriticalCSS = this.#detectCriticalCSS(parsedPage);

    // Generate issues

    // Too many blocking CSS files
    if (criticalPathData.blockingCSS.length > 3) {
      issues.push({
        message: 'Too many render-blocking stylesheets',
        detail: `<a href="${url}">${url}</a> has ${criticalPathData.blockingCSS.length} blocking CSS files. Consider inlining critical CSS and deferring non-critical styles.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Large blocking CSS
    if (criticalPathData.criticalCSSSize > 100000) { // 100KB
      issues.push({
        message: 'Large render-blocking CSS',
        detail: `<a href="${url}">${url}</a> blocks rendering with ${(criticalPathData.criticalCSSSize / 1024).toFixed(0)}KB of CSS. Extract and inline critical CSS.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Blocking JavaScript in head
    const headBlockingJS = criticalPathData.blockingJS.filter((js: any) => js.inHead);
    if (headBlockingJS.length > 0) {
      issues.push({
        message: 'Render-blocking JavaScript in <head>',
        detail: `<a href="${url}">${url}</a> has ${headBlockingJS.length} blocking script(s) in <head>: ${headBlockingJS.slice(0, 3).map((s: any) => s.src?.split('/').pop() || 'inline').join(', ')}. Move to end of body or add async/defer.`,
        severity: SEVERITY.HIGH,
      });
    }

    // No critical CSS implementation
    if (!criticalPathData.hasCriticalCSS && criticalPathData.blockingCSS.length > 0) {
      warnings.push({
        message: 'No critical CSS implementation detected',
        detail: `Consider extracting and inlining above-the-fold CSS for faster first paint.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Large inline CSS (may indicate critical CSS, but check size)
    if (criticalPathData.inlineCSSSize > 50000) { // 50KB inline is too much
      warnings.push({
        message: 'Large inline CSS',
        detail: `${(criticalPathData.inlineCSSSize / 1024).toFixed(0)}KB of inline CSS. Critical CSS should be ~14KB or less for optimal performance.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Large HTML document
    if (criticalPathData.documentSize > 100000) { // 100KB
      warnings.push({
        message: 'Large HTML document',
        detail: `HTML document is ${(criticalPathData.documentSize / 1024).toFixed(0)}KB. Large documents increase time to first byte and parsing time.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Generate recommendations
    criticalPathData.recommendations = this.#generateRecommendations(criticalPathData);

    return { issues, warnings, criticalPathData };
  }

  /**
   * Find render-blocking CSS
   * @private
   */
  static #findBlockingCSS(parsedPage: ParsedPage, requests: NetworkRequest[]) {
    const blocking: Record<string, any>[] = [];

    // External stylesheets without media="print" or disabled
    const stylesheets = parsedPage.querySelectorAll('link[rel="stylesheet"]');

    for (const link of stylesheets) {
      const href = link.getAttribute('href');
      const media = link.getAttribute('media');
      const disabled = link.getAttribute('disabled');

      // Skip print stylesheets and disabled
      if (media === 'print' || disabled !== null) {
        continue;
      }

      // Check if it's loaded with preload (non-blocking)
      const isPreloaded = link.getAttribute('rel')?.includes('preload');
      if (isPreloaded) {
        continue;
      }

      const size = href ? ((requests as unknown as Record<string, Record<string, any>>)[href]?.size || 0) : 0;

      blocking.push({
        href,
        media: media || 'all',
        size,
        isBlocking: true,
      });
    }

    return blocking;
  }

  /**
   * Find render-blocking JavaScript
   * @private
   */
  static #findBlockingJS(parsedPage: ParsedPage, requests: NetworkRequest[]) {
    const blocking: Record<string, any>[] = [];

    const scripts = parsedPage.querySelectorAll('script');
    const head = parsedPage.querySelector('head');

    for (const script of scripts) {
      const src = script.getAttribute('src');
      const async = script.getAttribute('async');
      const defer = script.getAttribute('defer');
      const type = script.getAttribute('type');

      // Skip module scripts (deferred by default) and JSON
      if (type === 'module' || type === 'application/json' || type === 'application/ld+json') {
        continue;
      }

      // Script is blocking if it doesn't have async or defer
      const isBlocking = async === null && defer === null;

      if (!isBlocking) {
        continue;
      }

      const inHead = (head as unknown as Element | null)?.contains(script as unknown as Node) || false;
      const size = src ? ((requests as unknown as Record<string, Record<string, any>>)[src]?.size || 0) : (script.textContent?.length || 0);

      blocking.push({
        src: src || '(inline)',
        size,
        inHead,
        isBlocking: true,
        isInline: !src,
      });
    }

    return blocking;
  }

  /**
   * Get timing metrics
   * @private
   */
  static async #getTimingMetrics(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const paintEntries = performance.getEntriesByType('paint');
        const firstPaint = paintEntries.find(e => e.name === 'first-paint');

        return {
          htmlParseTime: navEntry ? (navEntry.domInteractive - navEntry.responseEnd) : 0,
          domContentLoaded: navEntry ? (navEntry.domContentLoadedEventEnd - navEntry.startTime) : 0,
          firstPaint: firstPaint?.startTime || 0,
        };
      });
    } catch {
      return { htmlParseTime: 0, domContentLoaded: 0, firstPaint: 0 };
    }
  }

  /**
   * Analyze inline styles and scripts
   * @private
   */
  static #analyzeInlineResources(parsedPage: ParsedPage) {
    let inlineCSSSize = 0;
    let inlineJSSize = 0;
    const inlineCSS: Record<string, any>[] = [];
    const inlineJS: Record<string, any>[] = [];

    // Inline styles
    const styles = parsedPage.querySelectorAll('style');
    for (const style of styles) {
      const size = style.textContent?.length || 0;
      inlineCSSSize += size;
      inlineCSS.push({ size });
    }

    // Inline scripts (excluding JSON-LD)
    const scripts = parsedPage.querySelectorAll('script:not([src]):not([type="application/ld+json"]):not([type="application/json"])');
    for (const script of scripts) {
      const size = script.textContent?.length || 0;
      inlineJSSize += size;
      inlineJS.push({ size });
    }

    return { inlineCSS, inlineJS, inlineCSSSize, inlineJSSize };
  }

  /**
   * Detect critical CSS implementation
   * @private
   */
  static #detectCriticalCSS(parsedPage: ParsedPage) {
    // Check for common critical CSS patterns

    // 1. Inline style in head that's reasonably sized
    const headStyles = parsedPage.querySelectorAll('head style');
    for (const style of headStyles) {
      const size = style.textContent?.length || 0;
      // Critical CSS is typically 5-20KB
      if (size > 1000 && size < 30000) {
        return true;
      }
    }

    // 2. Check for loadCSS pattern (rel="preload" with onload)
    const preloadStyles = parsedPage.querySelectorAll('link[rel="preload"][as="style"]');
    if (preloadStyles.length > 0) {
      return true;
    }

    // 3. Check for noscript fallback pattern
    const noscriptStyles = parsedPage.querySelectorAll('noscript link[rel="stylesheet"]');
    if (noscriptStyles.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Generate recommendations
   * @private
   */
  static #generateRecommendations(data: Record<string, any>) {
    const recommendations: string[] = [];

    if (data.blockingCSS.length > 2) {
      recommendations.push('Combine CSS files to reduce blocking requests');
    }

    if (data.criticalCSSSize > 50000 && !data.hasCriticalCSS) {
      recommendations.push('Extract and inline critical (above-the-fold) CSS');
    }

    if (data.blockingJS.filter((js: any) => js.inHead).length > 0) {
      recommendations.push('Move scripts to end of body or add defer attribute');
    }

    if (data.documentSize > 50000) {
      recommendations.push('Reduce HTML document size - consider lazy loading content');
    }

    return recommendations;
  }

  /**
   * Site-wide critical path analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Record<string, any>[] = [];
    const warnings: Record<string, any>[] = [];

    let pagesWithBlockingCSS = 0;
    let pagesWithBlockingJS = 0;
    for (const [_url, page] of Object.entries(pages)) {
      if (page.criticalPathData) {
        if ((page.criticalPathData.blockingCSS?.length ?? 0) > 2) {
          pagesWithBlockingCSS++;
        }
        if ((page.criticalPathData.blockingJS?.filter((js: any) => js.inHead).length ?? 0) > 0) {
          pagesWithBlockingJS++;
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    if (pagesWithBlockingJS > totalPages * 0.5) {
      issues.push({
        message: 'Most pages have render-blocking JavaScript in head',
        detail: `${pagesWithBlockingJS} of ${totalPages} pages have blocking scripts in <head>. Use defer or async attributes.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (pagesWithBlockingCSS > totalPages * 0.5) {
      warnings.push({
        message: 'Most pages have multiple blocking stylesheets',
        detail: `${pagesWithBlockingCSS} of ${totalPages} pages have 3+ blocking CSS files. Consider implementing critical CSS.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { CriticalPathAnalyzer };