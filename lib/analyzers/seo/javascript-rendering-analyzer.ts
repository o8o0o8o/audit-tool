/**
 * JavaScript Rendering Analyzer
 * Compares raw HTML with JavaScript-rendered DOM to detect indexing issues
 */

import { SEVERITY } from '../../constants';
import { isInternalLink, countLazyLoadingPatterns, countWords, calcPercent } from '../../utils';
import { TechnologyDetector } from './technology-detector';
import type { Issue, PageInfo } from '../../types';

class JavaScriptRenderingAnalyzer {
  /**
   * Analyze JavaScript rendering for a page
   * @param {object} pageData - Page data with raw and rendered content
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      isJavaScriptDependent: false,
      rawContentLength: 0,
      renderedContentLength: 0,
      contentDifferencePercent: 0,
      missingInRaw: {
        title: false,
        description: false,
        h1: false,
        mainContent: false,
        links: false,
      },
      jsFramework: null as string | null,
      renderingTime: 0,
    };

    // Get raw and rendered content
    const rawHtml = pageData.rawHtml ?? '';
    const renderedHtml = pageData.renderedHtml ?? pageData.html ?? '';

    info.rawContentLength = rawHtml.length;
    info.renderedContentLength = renderedHtml.length;

    // Detect JS framework
    info.jsFramework = TechnologyDetector.quickDetectFramework(rawHtml);

    // Extract content from both versions
    const rawContent = this.extractContent(rawHtml);
    const renderedContent = this.extractContent(renderedHtml);

    // Calculate content difference
    if (info.rawContentLength > 0 && info.renderedContentLength > 0) {
      const diff = Math.abs(info.renderedContentLength - info.rawContentLength);
      info.contentDifferencePercent = calcPercent(diff, info.rawContentLength);
    }

    // Check for significant JS-dependent content
    if (info.contentDifferencePercent > 50) {
      info.isJavaScriptDependent = true;

      warnings.push({
        message: 'Page heavily relies on JavaScript for content',
        detail: `Rendered content is ${info.contentDifferencePercent}% different from raw HTML. Search engines may not index all content.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check critical SEO elements in raw HTML
    // Title
    if (!rawContent.title && renderedContent.title) {
      info.missingInRaw.title = true;
      issues.push({
        message: 'Title tag rendered by JavaScript',
        detail: `Title "${renderedContent.title.substring(0, 50)}..." is not in raw HTML. Google renders JS but other search engines may miss it.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Meta description
    if (!rawContent.description && renderedContent.description) {
      info.missingInRaw.description = true;
      warnings.push({
        message: 'Meta description rendered by JavaScript',
        detail: 'Meta description is added by JavaScript. Include it in server-rendered HTML for better compatibility.',
        severity: SEVERITY.MEDIUM,
      });
    }

    // H1
    if (!rawContent.h1 && renderedContent.h1) {
      info.missingInRaw.h1 = true;
      warnings.push({
        message: 'H1 heading rendered by JavaScript',
        detail: `H1 "${renderedContent.h1.substring(0, 50)}..." is not in raw HTML. Important for SEO - consider server-side rendering.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Main content
    const rawWordCount = countWords(rawContent.text);
    const renderedWordCount = countWords(renderedContent.text);
    const wordCountDiff = renderedWordCount - rawWordCount;

    if (wordCountDiff > 200) {
      info.missingInRaw.mainContent = true;
      issues.push({
        message: 'Significant content rendered by JavaScript',
        detail: `~${wordCountDiff} additional words added by JavaScript. Raw HTML has ${rawWordCount} words, rendered has ${renderedWordCount}. Consider SSR or pre-rendering.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Internal links
    const rawLinks = rawContent.links?.filter((l) => isInternalLink(l, url)) || [];
    const renderedLinks = renderedContent.links?.filter((l) => isInternalLink(l, url)) || [];
    const newLinks = renderedLinks.length - rawLinks.length;

    if (newLinks > 10) {
      info.missingInRaw.links = true;
      warnings.push({
        message: 'Internal links rendered by JavaScript',
        detail: `${newLinks} internal links added by JavaScript. These may not be discovered by all crawlers.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for common SPA patterns in raw HTML
    if (this.hasSpaPatterns(rawHtml)) {
      info.jsFramework ??= 'SPA (unknown)';

      // Check for SSR/hydration markers
      if (!this.hasSSRMarkers(rawHtml)) {
        warnings.push({
          message: 'Single Page Application without SSR detected',
          detail: `${info.jsFramework || 'SPA'} detected but no server-side rendering markers found. Consider implementing SSR for better SEO.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check for lazy-loaded content
    const lazyElements = countLazyLoadingPatterns(rawHtml);
    if (lazyElements.length > 0) {
      warnings.push({
        message: 'Lazy-loaded content detected',
        detail: `${lazyElements.length} elements use lazy loading. Ensure critical content is not deferred.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check rendering time if available
    if (pageData.renderingTime) {
      info.renderingTime = pageData.renderingTime;
      if (pageData.renderingTime > 5000) {
        warnings.push({
          message: 'Slow JavaScript rendering',
          detail: `Page takes ${(pageData.renderingTime / 1000).toFixed(1)}s to render. Google's rendering budget may timeout.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings, info };
  }

  /**
   * Extract SEO-relevant content from HTML
   * @param {string} html - HTML string
   * @returns {object} Extracted content
   */
  static extractContent(html: string) {
    const content: {
      title: string | null;
      description: string | null;
      h1: string | null;
      text: string;
      links: string[];
    } = {
      title: null,
      description: null,
      h1: null,
      text: '',
      links: [],
    };

    if (!html) return content;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) {
      content.title = titleMatch[1].trim();
    }

    // Extract meta description
    const descMatch =
      html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    if (descMatch) {
      content.description = descMatch[1].trim();
    }

    // Extract first H1
    const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
    if (h1Match) {
      content.h1 = h1Match[1].trim();
    }

    // Extract text content (simple version)
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    content.text = textContent;

    // Extract links
    const linkRegex = /<a[^>]*href=["']([^"']*)["']/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      content.links.push(linkMatch[1]);
    }

    return content;
  }

  /**
   * Detect SPA patterns in HTML
   * @param {string} html - HTML content
   * @returns {boolean}
   */
  static hasSpaPatterns(html: string) {
    const spaPatterns = [
      /<div[^>]*id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i,
      /noscript.*enable javascript/i,
      /<div[^>]*class=["'][^"']*app-shell/i,
    ];

    return spaPatterns.some((pattern) => pattern.test(html));
  }

  /**
   * Check for SSR markers in raw HTML
   */
  static hasSSRMarkers(html: string) {
    const ssrMarkers = ['data-reactroot', '__NEXT_DATA__', '__NUXT__', 'data-server-rendered', 'ng-state'];
    return ssrMarkers.some((marker) => html.includes(marker));
  }

  /**
   * Analyze JS rendering across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      pagesAnalyzed: 0,
      jsDependent: 0,
      missingTitleInRaw: 0,
      missingDescriptionInRaw: 0,
      missingH1InRaw: 0,
      missingContentInRaw: 0,
      frameworks: {} as Record<string, number>,
      avgContentDifference: 0,
    };

    let totalContentDiff = 0;

    for (const [url, pageData] of Object.entries(pages)) {
      // Skip if no raw HTML available
      if (!pageData.rawHtml) continue;

      stats.pagesAnalyzed++;

      const analysis = this.analyze(pageData, url);

      if (analysis.info.isJavaScriptDependent) {
        stats.jsDependent++;
      }

      if (analysis.info.missingInRaw.title) stats.missingTitleInRaw++;
      if (analysis.info.missingInRaw.description) stats.missingDescriptionInRaw++;
      if (analysis.info.missingInRaw.h1) stats.missingH1InRaw++;
      if (analysis.info.missingInRaw.mainContent) stats.missingContentInRaw++;

      if (analysis.info.jsFramework) {
        stats.frameworks[analysis.info.jsFramework] = (stats.frameworks[analysis.info.jsFramework] || 0) + 1;
      }

      totalContentDiff += analysis.info.contentDifferencePercent;
    }

    if (stats.pagesAnalyzed > 0) {
      stats.avgContentDifference = Math.round(totalContentDiff / stats.pagesAnalyzed);
    }

    // Site-wide issues
    if (stats.jsDependent > stats.pagesAnalyzed * 0.5) {
      issues.push({
        message: 'Site heavily relies on JavaScript rendering',
        detail: `${stats.jsDependent}/${stats.pagesAnalyzed} pages (${Math.round((stats.jsDependent / stats.pagesAnalyzed) * 100)}%) are JavaScript-dependent. Consider implementing SSR.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (stats.missingTitleInRaw > 0) {
      issues.push({
        message: 'Page titles rendered by JavaScript',
        detail: `${stats.missingTitleInRaw} pages have titles that only appear after JavaScript execution.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (stats.missingContentInRaw > 0) {
      warnings.push({
        message: 'Main content rendered by JavaScript',
        detail: `${stats.missingContentInRaw} pages have significant content added by JavaScript. This may affect indexing.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Framework summary
    const frameworkList = Object.entries(stats.frameworks)
      .map(([fw, count]) => `${fw} (${count} pages)`)
      .join(', ');

    if (frameworkList) {
      warnings.push({
        message: 'JavaScript frameworks detected',
        detail: `Frameworks found: ${frameworkList}. Ensure proper SSR/pre-rendering is configured.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }
}

export { JavaScriptRenderingAnalyzer };
