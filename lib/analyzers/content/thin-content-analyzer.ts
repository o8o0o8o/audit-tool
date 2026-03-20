/**
 * Thin Content Analyzer
 * Detects pages with insufficient content for SEO
 */

import { SEVERITY, THRESHOLDS as GLOBAL_THRESHOLDS } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class ThinContentAnalyzer {
  // Minimum thresholds
  static THRESHOLDS = {
    MIN_WORDS: GLOBAL_THRESHOLDS.THIN_CONTENT_BARE_MIN,
    LOW_WORDS: GLOBAL_THRESHOLDS.THIN_CONTENT_LOW,
    RECOMMENDED_WORDS: GLOBAL_THRESHOLDS.THIN_CONTENT_RECOMMENDED,
    MIN_PARAGRAPHS: 2,
    MIN_TEXT_RATIO: GLOBAL_THRESHOLDS.THIN_CONTENT_TEXT_RATIO_MIN,
  };

  // Content score point allocations per tier
  static SCORING = {
    WORD_COUNT: { RECOMMENDED: 50, LOW: 35, MIN: 20, ANY: 5 },
    TEXT_RATIO: { GOOD: 25, MODERATE: 20, MIN: 10, GOOD_THRESHOLD: 25, MODERATE_THRESHOLD: 15 },
    STRUCTURE: { GOOD: 25, MODERATE: 15, MIN: 10, GOOD_THRESHOLD: 5, MODERATE_THRESHOLD: 3 },
  };

  /**
   * Analyze page for thin content
   * @param {Object} pageData - Page data
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const metrics = {
      wordCount: 0,
      paragraphCount: 0,
      textToHtmlRatio: 0,
      isThinContent: false,
      contentScore: 0,
    };

    // Get content quality data if available
    const cq =
      pageData.contentQuality ?? ({} as { wordCount?: number; paragraphCount?: number; textToHtmlRatio?: number });

    metrics.wordCount = cq.wordCount ?? 0;
    metrics.paragraphCount = cq.paragraphCount ?? 0;
    metrics.textToHtmlRatio = cq.textToHtmlRatio ?? 0;

    // Skip non-content pages
    if (this.isNonContentPage(url)) {
      const extendedMetrics = { ...metrics, isNonContentPage: true };
      return { issues, warnings, metrics: extendedMetrics };
    }

    // Check word count
    if (metrics.wordCount < this.THRESHOLDS.MIN_WORDS) {
      issues.push({
        message: 'Page has very thin content',
        detail: `<a href="${url}">${this.shortenUrl(url)}</a> has only ${metrics.wordCount} words (minimum: ${this.THRESHOLDS.MIN_WORDS})`,
        severity: SEVERITY.HIGH,
      });
      metrics.isThinContent = true;
    } else if (metrics.wordCount < this.THRESHOLDS.LOW_WORDS) {
      warnings.push({
        message: 'Page has low content',
        detail: `<a href="${url}">${this.shortenUrl(url)}</a> has ${metrics.wordCount} words (recommended: ${this.THRESHOLDS.RECOMMENDED_WORDS}+)`,
        severity: SEVERITY.MEDIUM,
      });
      metrics.isThinContent = true;
    } else if (metrics.wordCount < this.THRESHOLDS.RECOMMENDED_WORDS) {
      warnings.push({
        message: 'Page content could be expanded',
        detail: `<a href="${url}">${this.shortenUrl(url)}</a> has ${metrics.wordCount} words (recommended: ${this.THRESHOLDS.RECOMMENDED_WORDS}+)`,
        severity: SEVERITY.LOW,
      });
    }

    // Check text to HTML ratio
    if (metrics.textToHtmlRatio < this.THRESHOLDS.MIN_TEXT_RATIO && metrics.wordCount > 0) {
      warnings.push({
        message: 'Low text-to-HTML ratio',
        detail: `<a href="${url}">${this.shortenUrl(url)}</a> has ${metrics.textToHtmlRatio.toFixed(1)}% text ratio (recommended: >${this.THRESHOLDS.MIN_TEXT_RATIO}%)`,
        severity: SEVERITY.LOW,
      });
    }

    // Check paragraph count
    if (metrics.paragraphCount < this.THRESHOLDS.MIN_PARAGRAPHS && metrics.wordCount > this.THRESHOLDS.MIN_WORDS) {
      warnings.push({
        message: 'Content lacks paragraph structure',
        detail: `<a href="${url}">${this.shortenUrl(url)}</a> has only ${metrics.paragraphCount} paragraphs. Break content into more paragraphs for readability.`,
        severity: SEVERITY.LOW,
      });
    }

    // Calculate content score
    metrics.contentScore = this.calculateContentScore(metrics);

    return { issues, warnings, metrics };
  }

  /**
   * Check if URL is a non-content page type
   */
  static isNonContentPage(url: string) {
    const nonContentPatterns = [
      /\/(cart|checkout|basket|login|register|account|search|404|error)/i,
      /\/(tag|category|archive|author)\/[^/]+\/?$/i,
      /\?(s|q|query|search)=/i,
      /\/page\/\d+\/?$/i,
    ];

    if (nonContentPatterns.some((pattern) => pattern.test(url))) return true;

    // Exclude homepage — it's navigational, not a long-form content page
    try {
      const path = new URL(url).pathname.replace(/\/+$/, '');
      if (path === '') return true;
    } catch {
      /* ignore */
    }

    return false;
  }

  /**
   * Calculate content quality score (0-100)
   */
  static calculateContentScore(metrics: { wordCount: number; paragraphCount: number; textToHtmlRatio: number }) {
    const { WORD_COUNT, TEXT_RATIO, STRUCTURE } = this.SCORING;
    let score = 0;

    // Word count scoring (0-50 points)
    if (metrics.wordCount >= this.THRESHOLDS.RECOMMENDED_WORDS) {
      score += WORD_COUNT.RECOMMENDED;
    } else if (metrics.wordCount >= this.THRESHOLDS.LOW_WORDS) {
      score += WORD_COUNT.LOW;
    } else if (metrics.wordCount >= this.THRESHOLDS.MIN_WORDS) {
      score += WORD_COUNT.MIN;
    } else if (metrics.wordCount > 0) {
      score += WORD_COUNT.ANY;
    }

    // Text ratio scoring (0-25 points)
    if (metrics.textToHtmlRatio >= TEXT_RATIO.GOOD_THRESHOLD) {
      score += TEXT_RATIO.GOOD;
    } else if (metrics.textToHtmlRatio >= TEXT_RATIO.MODERATE_THRESHOLD) {
      score += TEXT_RATIO.MODERATE;
    } else if (metrics.textToHtmlRatio >= this.THRESHOLDS.MIN_TEXT_RATIO) {
      score += TEXT_RATIO.MIN;
    }

    // Structure scoring (0-25 points)
    if (metrics.paragraphCount >= STRUCTURE.GOOD_THRESHOLD) {
      score += STRUCTURE.GOOD;
    } else if (metrics.paragraphCount >= STRUCTURE.MODERATE_THRESHOLD) {
      score += STRUCTURE.MODERATE;
    } else if (metrics.paragraphCount >= this.THRESHOLDS.MIN_PARAGRAPHS) {
      score += STRUCTURE.MIN;
    }

    return Math.min(score, 100);
  }

  /**
   * Shorten URL for display
   */
  static shortenUrl(url: string) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > 50) {
        return '...' + path.slice(-47);
      }
      return path || '/';
    } catch {
      return url.slice(-50);
    }
  }

  /**
   * Site-wide thin content analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let thinPages = 0;
    let lowContentPages = 0;
    let totalWords = 0;
    let analyzedPages = 0;
    const thinPagesList = [];

    for (const [url, page] of Object.entries(pages)) {
      if (this.isNonContentPage(url)) continue;

      const wordCount = page.contentQuality?.wordCount ?? 0;
      analyzedPages++;
      totalWords += wordCount;

      if (wordCount < this.THRESHOLDS.MIN_WORDS) {
        thinPages++;
        thinPagesList.push({ url, wordCount });
      } else if (wordCount < this.THRESHOLDS.LOW_WORDS) {
        lowContentPages++;
      }
    }

    const avgWords = analyzedPages > 0 ? totalWords / analyzedPages : 0;
    const thinPercent = analyzedPages > 0 ? (thinPages / analyzedPages) * 100 : 0;
    const lowPercent = analyzedPages > 0 ? (lowContentPages / analyzedPages) * 100 : 0;

    // Report site-wide issues
    if (thinPercent > 20) {
      issues.push({
        message: `${thinPercent.toFixed(1)}% of pages have very thin content`,
        detail: `${thinPages} pages have fewer than ${this.THRESHOLDS.MIN_WORDS} words. Thin content can harm rankings.`,
        severity: SEVERITY.HIGH,
      });
    } else if (thinPages > 0) {
      warnings.push({
        message: `${thinPages} pages have very thin content`,
        detail: `These pages have fewer than ${this.THRESHOLDS.MIN_WORDS} words`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (lowPercent > 30) {
      warnings.push({
        message: `${(thinPercent + lowPercent).toFixed(1)}% of pages have insufficient content`,
        detail: `Consider expanding content on pages with fewer than ${this.THRESHOLDS.LOW_WORDS} words`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (avgWords < this.THRESHOLDS.LOW_WORDS && analyzedPages > 5) {
      warnings.push({
        message: 'Average content length is low',
        detail: `Average ${Math.round(avgWords)} words per page. Consider creating more comprehensive content.`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      issues,
      warnings,
      metrics: {
        analyzedPages,
        thinPages,
        lowContentPages,
        thinPercent: Math.round(thinPercent),
        averageWords: Math.round(avgWords),
      },
      thinPagesList: thinPagesList.slice(0, 20), // Top 20 thinnest
    };
  }
}

export { ThinContentAnalyzer };
