/**
 * Technical SEO Analyzer
 * Detects technical SEO issues like meta refresh, JS frameworks, CMS, etc.
 */

const { SEVERITY } = require('../../constants');

class TechnicalSEOAnalyzer {
  /**
   * Analyze technical SEO signals
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data object
   * @returns {Object} Analysis results
   */
  static analyze(parsedPage, url, pageData) {
    const issues = [];
    const warnings = [];
    const technicalData = {
      metaRefresh: null,
      jsFramework: null,
      cms: null,
      generator: null,
      amp: false,
      pwa: false,
      lazyLoading: false,
      preload: [],
      prefetch: [],
      dns_prefetch: [],
    };

    if (!parsedPage) {
      return { issues, warnings, technicalData };
    }

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
    technicalData.jsFramework = this.detectJSFramework(parsedPage);
    if (technicalData.jsFramework) {
      const framework = technicalData.jsFramework;
      // Check for potential JS rendering issues
      if (['react', 'vue', 'angular'].includes(framework.toLowerCase())) {
        const hasSSR = this.checkForSSR(parsedPage);
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
    technicalData.cms = this.detectCMS(parsedPage);
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

    if (hints.preload.length === 0 && pageData.totalResponseSize > 500000) {
      warnings.push({
        message: 'No resource preloading detected on large page',
        detail: 'Consider using preload for critical resources to improve LCP',
        severity: SEVERITY.LOW,
      });
    }

    // 7. Check for lazy loading implementation
    technicalData.lazyLoading = this.detectLazyLoading(parsedPage);

    // 8. Check for inline CSS/JS that could be external
    const inlineAnalysis = this.analyzeInlineResources(parsedPage);
    if (inlineAnalysis.inlineCssSize > 50000) {
      warnings.push({
        message: 'Large amount of inline CSS',
        detail: `${(inlineAnalysis.inlineCssSize / 1024).toFixed(1)}KB of inline CSS. Consider extracting to external files for caching.`,
        severity: SEVERITY.LOW,
      });
    }
    if (inlineAnalysis.inlineJsSize > 50000) {
      warnings.push({
        message: 'Large amount of inline JavaScript',
        detail: `${(inlineAnalysis.inlineJsSize / 1024).toFixed(1)}KB of inline JS. Consider extracting to external files.`,
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

    // Store in pageData
    pageData.technical = technicalData;

    return { issues, warnings, technicalData };
  }

  /**
   * Detect meta refresh redirect
   */
  static detectMetaRefresh(parsedPage) {
    const metaRefresh = parsedPage.querySelector('meta[http-equiv="refresh"]');
    if (!metaRefresh) return null;

    const content = metaRefresh.getAttribute('content') || '';
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
   * Detect JavaScript framework
   */
  static detectJSFramework(parsedPage) {
    const html = parsedPage.toString();

    // React
    if (html.includes('__NEXT_DATA__') || html.includes('_next/')) {
      return 'Next.js (React)';
    }
    if (html.includes('data-reactroot') || html.includes('react-root')) {
      return 'React';
    }

    // Vue
    if (html.includes('__NUXT__') || html.includes('/_nuxt/')) {
      return 'Nuxt.js (Vue)';
    }
    if (html.includes('data-v-') || html.includes('v-cloak')) {
      return 'Vue.js';
    }

    // Angular
    if (html.includes('ng-version') || html.includes('_ngcontent')) {
      return 'Angular';
    }

    // Svelte
    if (html.includes('__svelte')) {
      return 'Svelte';
    }

    // Gatsby
    if (html.includes('___gatsby')) {
      return 'Gatsby (React)';
    }

    // Generic SPA indicators
    if (parsedPage.querySelector('#app') && html.includes('bundle.js')) {
      return 'SPA (Unknown Framework)';
    }

    return null;
  }

  /**
   * Check for server-side rendering indicators
   */
  static checkForSSR(parsedPage) {
    // Check for meaningful content in initial HTML
    const mainContent = parsedPage.querySelector('main, article, .content, #content');
    if (mainContent) {
      const text = mainContent.textContent.trim();
      if (text.length > 100) {
        return true;
      }
    }

    // Check for SSR frameworks
    const html = parsedPage.toString();
    if (html.includes('__NEXT_DATA__') || html.includes('__NUXT__')) {
      return true;
    }

    return false;
  }

  /**
   * Detect CMS
   */
  static detectCMS(parsedPage) {
    const html = parsedPage.toString();

    // WordPress
    if (html.includes('wp-content') || html.includes('wp-includes')) {
      return 'WordPress';
    }

    // Shopify
    if (html.includes('cdn.shopify.com') || html.includes('Shopify.theme')) {
      return 'Shopify';
    }

    // Wix
    if (html.includes('wix.com') || html.includes('wixstatic.com')) {
      return 'Wix';
    }

    // Squarespace
    if (html.includes('squarespace.com') || html.includes('squarespace-cdn.com')) {
      return 'Squarespace';
    }

    // Drupal
    if (html.includes('drupal.org') || html.includes('Drupal.settings')) {
      return 'Drupal';
    }

    // Joomla
    if (html.includes('/media/jui/') || html.includes('Joomla!')) {
      return 'Joomla';
    }

    // Magento
    if (html.includes('mage/') || html.includes('Magento')) {
      return 'Magento';
    }

    // Webflow
    if (html.includes('webflow.com')) {
      return 'Webflow';
    }

    // Ghost
    if (html.includes('ghost.org') || html.includes('ghost-')) {
      return 'Ghost';
    }

    // HubSpot
    if (html.includes('hubspot.com') || html.includes('hs-scripts')) {
      return 'HubSpot';
    }

    return null;
  }

  /**
   * Get generator meta tag
   */
  static getGenerator(parsedPage) {
    const generator = parsedPage.querySelector('meta[name="generator"]');
    return generator ? generator.getAttribute('content') : null;
  }

  /**
   * Detect AMP page
   */
  static detectAMP(parsedPage) {
    const html = parsedPage.querySelector('html');
    if (!html) return false;

    const attrs = html.rawAttrs || '';
    return attrs.includes('amp') || attrs.includes('⚡');
  }

  /**
   * Detect PWA signals
   */
  static detectPWA(parsedPage) {
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
  static analyzeResourceHints(parsedPage) {
    const preload = [];
    const prefetch = [];
    const dnsPrefetch = [];

    const links = parsedPage.querySelectorAll('link');
    for (const link of links) {
      const rel = link.getAttribute('rel');
      const href = link.getAttribute('href');

      if (!href) continue;

      if (rel === 'preload') {
        preload.push({
          href,
          as: link.getAttribute('as'),
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
   * Detect lazy loading implementation
   */
  static detectLazyLoading(parsedPage) {
    // Check for native lazy loading
    const lazyImages = parsedPage.querySelectorAll('img[loading="lazy"]');
    if (lazyImages.length > 0) {
      return { type: 'native', count: lazyImages.length };
    }

    // Check for common lazy loading libraries
    const html = parsedPage.toString();
    if (html.includes('data-src') || html.includes('data-lazy')) {
      return { type: 'library', pattern: 'data-src' };
    }
    if (html.includes('lazyload') || html.includes('lazy-load')) {
      return { type: 'library', pattern: 'class-based' };
    }

    return null;
  }

  /**
   * Analyze inline CSS and JS sizes
   */
  static analyzeInlineResources(parsedPage) {
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
  static checkNoscriptContent(parsedPage) {
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
   * Check for robots tag conflicts
   */
  static checkRobotsTagConflicts(pageData, issues) {
    const metaRobots = pageData.meta?.find(m => m.robots)?.robots || '';
    const xRobotsTag = pageData.response?.headers?.['x-robots-tag'] || '';

    if (metaRobots && xRobotsTag) {
      // Check for conflicts
      const metaNoindex = metaRobots.toLowerCase().includes('noindex');
      const headerNoindex = xRobotsTag.toLowerCase().includes('noindex');
      const metaIndex = metaRobots.toLowerCase().includes('index') && !metaNoindex;
      const headerIndex = xRobotsTag.toLowerCase().includes('index') && !headerNoindex;

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
  static analyzeSiteWide(pages) {
    const issues = [];
    const warnings = [];

    let metaRefreshCount = 0;
    const frameworks = new Map();
    const cmsCount = new Map();
    let ampPages = 0;
    let pwaEnabled = 0;
    let lazyLoadingPages = 0;

    for (const [url, page] of Object.entries(pages)) {
      if (page.technical) {
        if (page.technical.metaRefresh) metaRefreshCount++;
        if (page.technical.jsFramework) {
          const fw = page.technical.jsFramework;
          frameworks.set(fw, (frameworks.get(fw) || 0) + 1);
        }
        if (page.technical.cms) {
          const cms = page.technical.cms;
          cmsCount.set(cms, (cmsCount.get(cms) || 0) + 1);
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
        detail: `Found: ${Array.from(frameworks.entries()).map(([f, c]) => `${f} (${c})`).join(', ')}. Consider standardizing.`,
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

module.exports = { TechnicalSEOAnalyzer };
