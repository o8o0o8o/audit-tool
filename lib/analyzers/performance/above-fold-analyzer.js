/**
 * Above-the-Fold Analyzer
 * Analyzes critical content and resources in the initial viewport
 */

const { SEVERITY } = require('../../constants');

// Default viewport dimensions (mobile-first)
const DEFAULT_VIEWPORT = {
  width: 414,
  height: 896,
};

class AboveFoldAnalyzer {
  /**
   * Analyze above-the-fold content and resources
   * @param {object} pageData - Page data
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData, url) {
    const issues = [];
    const warnings = [];
    const info = {
      viewport: pageData.viewport || DEFAULT_VIEWPORT,
      hasContentAboveFold: false,
      aboveFoldElements: {
        headings: [],
        images: [],
        text: [],
        cta: [],
      },
      criticalResources: [],
      lcpInViewport: false,
      renderBlockingResources: 0,
      aboveFoldImageSize: 0,
      estimatedFoldPosition: null,
    };

    // Analyze LCP element position
    const lcpElement = pageData.lcpElement || pageData.vitals?.lcpElement;
    const lcpRect = pageData.lcpRect || pageData.vitals?.lcpRect;

    if (lcpRect) {
      info.lcpInViewport = this.isInViewport(lcpRect, info.viewport);

      if (!info.lcpInViewport) {
        issues.push({
          message: 'LCP element below the fold',
          detail: `The Largest Contentful Paint element starts at ${lcpRect.top}px, below viewport height of ${info.viewport.height}px. Consider moving important content higher.`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Analyze above-fold images
    const images = pageData.images || [];
    let aboveFoldImageCount = 0;
    let lazyLoadedAboveFold = 0;

    for (const image of images) {
      const rect = image.rect || image.boundingRect;
      if (rect && this.isInViewport(rect, info.viewport)) {
        aboveFoldImageCount++;
        info.aboveFoldElements.images.push({
          src: image.src,
          size: image.size || image.fileSize,
          loading: image.loading,
          fetchPriority: image.fetchPriority,
        });

        // Track size
        if (image.size) {
          info.aboveFoldImageSize += image.size;
        }

        // Check for lazy loading above fold (bad practice)
        if (image.loading === 'lazy') {
          lazyLoadedAboveFold++;
        }
      }
    }

    if (lazyLoadedAboveFold > 0) {
      issues.push({
        message: 'Above-fold images use lazy loading',
        detail: `${lazyLoadedAboveFold} images above the fold use loading="lazy". Remove lazy loading from above-fold images to improve LCP.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Check fetchpriority for LCP image
    const lcpImage = info.aboveFoldElements.images.find(img =>
      img.src === pageData.lcpUrl || img.src === pageData.vitals?.lcpUrl
    );
    if (lcpImage && lcpImage.fetchPriority !== 'high') {
      warnings.push({
        message: 'LCP image missing fetchpriority="high"',
        detail: 'Add fetchpriority="high" to the LCP image to prioritize its download.',
        severity: SEVERITY.MEDIUM,
      });
    }

    // Analyze headings presence
    // Note: headings structure is {h1: ["text", ...], h2: [...], ...} from HeadingAnalyzer
    // We don't have bounding rect data, so we can only note their existence
    const headings = pageData.headings || {};
    const hasH1 = headings.h1 && headings.h1.length > 0;

    if (hasH1) {
      // Add h1 headings to above-fold elements (assuming they're typically at the top)
      for (const text of headings.h1) {
        info.aboveFoldElements.headings.push({
          tag: 'h1',
          text: typeof text === 'string' ? text.substring(0, 100) : '',
        });
      }
    }

    // Analyze render-blocking resources
    const resources = pageData.resources || [];
    const renderBlocking = resources.filter(r =>
      r.renderBlocking ||
      (r.type === 'stylesheet' && !r.media) ||
      (r.type === 'script' && !r.async && !r.defer && r.inHead)
    );

    info.renderBlockingResources = renderBlocking.length;
    info.criticalResources = renderBlocking.slice(0, 10).map(r => ({
      url: r.url,
      type: r.type,
      size: r.size,
    }));

    if (renderBlocking.length > 5) {
      issues.push({
        message: 'Too many render-blocking resources',
        detail: `${renderBlocking.length} resources block rendering. Consider inlining critical CSS, deferring scripts, and using async loading.`,
        severity: SEVERITY.HIGH,
      });
    } else if (renderBlocking.length > 2) {
      warnings.push({
        message: 'Multiple render-blocking resources',
        detail: `${renderBlocking.length} resources block rendering. Consider optimizing for faster first paint.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check above-fold image size
    if (info.aboveFoldImageSize > 500000) { // 500KB
      issues.push({
        message: 'Large above-fold image payload',
        detail: `Above-fold images total ${this.formatBytes(info.aboveFoldImageSize)}. Optimize images for faster LCP.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for content above fold
    info.hasContentAboveFold = info.aboveFoldElements.headings.length > 0 ||
                               info.aboveFoldElements.images.length > 0;

    if (!info.hasContentAboveFold) {
      warnings.push({
        message: 'No significant content above the fold',
        detail: 'Initial viewport may appear empty or loading. Ensure meaningful content is visible immediately.',
        severity: SEVERITY.MEDIUM,
      });
    }

    // Analyze CTA buttons above fold
    const ctas = pageData.ctas || pageData.buttons || [];
    for (const cta of ctas) {
      const rect = cta.rect || cta.boundingRect;
      if (rect && this.isInViewport(rect, info.viewport)) {
        info.aboveFoldElements.cta.push({
          text: cta.text,
          type: cta.type,
        });
      }
    }

    return { issues, warnings, info };
  }

  /**
   * Check if element is in viewport
   * @param {object} rect - Element bounding rect
   * @param {object} viewport - Viewport dimensions
   * @returns {boolean}
   */
  static isInViewport(rect, viewport) {
    if (!rect) return false;

    // Element is in viewport if any part of it is visible
    return rect.top < viewport.height &&
           rect.bottom > 0 &&
           rect.left < viewport.width &&
           rect.right > 0;
  }

  /**
   * Format bytes to human readable
   * @param {number} bytes
   * @returns {string}
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Analyze above-fold content across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages) {
    const issues = [];
    const warnings = [];
    const stats = {
      pagesAnalyzed: 0,
      pagesWithLcpAboveFold: 0,
      pagesWithLcpBelowFold: 0,
      avgRenderBlockingResources: 0,
      avgAboveFoldImageSize: 0,
      pagesWithLazyAboveFold: 0,
    };

    let totalRenderBlocking = 0;
    let totalAboveFoldImageSize = 0;

    for (const [url, pageData] of Object.entries(pages)) {
      stats.pagesAnalyzed++;

      const analysis = this.analyze(pageData, url);

      if (analysis.info.lcpInViewport) {
        stats.pagesWithLcpAboveFold++;
      } else if (pageData.lcpRect || pageData.vitals?.lcpRect) {
        stats.pagesWithLcpBelowFold++;
      }

      totalRenderBlocking += analysis.info.renderBlockingResources;
      totalAboveFoldImageSize += analysis.info.aboveFoldImageSize;

      if (analysis.issues.some(i => i.message.includes('lazy loading'))) {
        stats.pagesWithLazyAboveFold++;
      }
    }

    if (stats.pagesAnalyzed > 0) {
      stats.avgRenderBlockingResources = (totalRenderBlocking / stats.pagesAnalyzed).toFixed(1);
      stats.avgAboveFoldImageSize = Math.round(totalAboveFoldImageSize / stats.pagesAnalyzed);
    }

    // Site-wide issues
    if (stats.pagesWithLcpBelowFold > stats.pagesAnalyzed * 0.3) {
      issues.push({
        message: 'LCP element below fold on many pages',
        detail: `${stats.pagesWithLcpBelowFold} pages have their LCP element below the initial viewport. Review page layouts.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (stats.pagesWithLazyAboveFold > 0) {
      issues.push({
        message: 'Lazy loading misused on above-fold images',
        detail: `${stats.pagesWithLazyAboveFold} pages have lazy-loaded images above the fold. Remove lazy loading from these images.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (parseFloat(stats.avgRenderBlockingResources) > 5) {
      warnings.push({
        message: 'High average render-blocking resources',
        detail: `Average of ${stats.avgRenderBlockingResources} render-blocking resources per page. Consider site-wide optimization.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (stats.avgAboveFoldImageSize > 300000) {
      warnings.push({
        message: 'Large average above-fold image payload',
        detail: `Average ${this.formatBytes(stats.avgAboveFoldImageSize)} in above-fold images. Optimize images site-wide.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, stats };
  }
}

module.exports = { AboveFoldAnalyzer };
