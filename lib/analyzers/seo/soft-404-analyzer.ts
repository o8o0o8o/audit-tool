/**
 * Soft 404 Analyzer
 * Detects pages that return HTTP 200 but display "not found" content
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, ParsedPage, Issue, PageInfo } from '../../types';

class Soft404Analyzer {
  // Common patterns indicating a soft 404
  static #notFoundPatterns = [
    // English
    /page\s*(not|wasn't|could not be)\s*found/i,
    /404\s*(error|not found|page)/i,
    /not\s*found/i,
    /doesn't\s*exist/i,
    /does\s*not\s*exist/i,
    /no\s*longer\s*(exists|available)/i,
    /couldn't\s*find/i,
    /could\s*not\s*(find|be found)/i,
    /we\s*can't\s*find/i,
    /cannot\s*be\s*found/i,
    /this\s*page\s*(is|has been)\s*(missing|removed|deleted)/i,
    /page\s*(has been|was)\s*(moved|removed|deleted)/i,
    /nothing\s*(here|found)/i,
    /oops.*not\s*found/i,
    /sorry.*not\s*(found|exist)/i,
    /the\s*requested\s*(page|url|resource)\s*(was|is|could)\s*not/i,
    /error\s*404/i,
    /http\s*404/i,

    // German
    /seite\s*nicht\s*gefunden/i,
    /nicht\s*gefunden/i,

    // French
    /page\s*non\s*trouv[ée]e/i,
    /introuvable/i,

    // Spanish
    /p[áa]gina\s*no\s*encontrada/i,
    /no\s*encontrado/i,

    // Italian
    /pagina\s*non\s*trovata/i,

    // Portuguese
    /p[áa]gina\s*n[ãa]o\s*encontrada/i,
  ];

  // Title patterns that indicate soft 404
  static #notFoundTitlePatterns = [
    /^404/i,
    /404\s*-/i,
    /not\s*found/i,
    /page\s*not\s*found/i,
    /error\s*404/i,
    /fehler\s*404/i,
    /erreur\s*404/i,
  ];

  // Elements that commonly contain 404 messages
  static #errorSelectors = [
    '.error-404',
    '.page-404',
    '.not-found',
    '#error-404',
    '#not-found',
    '[class*="404"]',
    '[class*="not-found"]',
    '[class*="error-page"]',
    '.error-content',
    '.error-message',
  ];

  /**
   * Analyze a page for soft 404 indicators
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data object
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, url: string, pageData: PageInfo) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const soft404Data = {
      isSoft404: false,
      confidence: 0,
      signals: [] as string[],
    };

    // Only check pages with 200 status
    if (pageData.status !== 200) {
      return { issues, warnings, soft404Data };
    }

    const signals: string[] = [];
    let confidence = 0;

    // 1. Check page title for 404 patterns
    const title = pageData.title || '';
    for (const pattern of this.#notFoundTitlePatterns) {
      if (pattern.test(title)) {
        signals.push(`Title contains 404 indicator: "${title}"`);
        confidence += 40;
        break;
      }
    }

    // 2. Check body content for not found patterns
    const bodyText = await this.#getBodyText(chromePage);
    let contentMatches = 0;
    for (const pattern of this.#notFoundPatterns) {
      if (pattern.test(bodyText)) {
        contentMatches++;
        if (contentMatches === 1) {
          signals.push(`Content contains "not found" pattern`);
          confidence += 30;
        }
      }
    }

    // Multiple content matches increase confidence
    if (contentMatches > 2) {
      confidence += 15;
      signals.push(`Multiple (${contentMatches}) "not found" patterns detected`);
    }

    // 3. Check for error-specific CSS classes/IDs
    const hasErrorElements = await this.#checkErrorElements(chromePage);
    if (hasErrorElements) {
      signals.push('Page contains error-specific HTML elements');
      confidence += 25;
    }

    // 4. Check for very thin content (common in soft 404s)
    const wordCount = pageData.contentQuality?.wordCount || 0;
    if (wordCount < 50 && signals.length > 0) {
      signals.push(`Very thin content (${wordCount} words) combined with error signals`);
      confidence += 15;
    }

    // 5. Check H1 for 404 patterns
    const h1Text = this.#getH1Text(parsedPage);
    for (const pattern of this.#notFoundPatterns) {
      if (pattern.test(h1Text)) {
        signals.push(`H1 contains "not found" pattern: "${h1Text}"`);
        confidence += 35;
        break;
      }
    }

    // 6. Check meta robots for noindex (often set on soft 404s)
    const metaRobots = pageData.metaMap?.robots || '';
    if (metaRobots.toLowerCase().includes('noindex') && signals.length > 0) {
      signals.push('Page has noindex combined with error signals');
      confidence += 10;
    }

    // Cap confidence at 100
    confidence = Math.min(confidence, 100);

    // Determine if this is a soft 404
    const isSoft404 = confidence >= 50;

    soft404Data.isSoft404 = isSoft404;
    soft404Data.confidence = confidence;
    soft404Data.signals = signals;

    // Report issues
    if (isSoft404) {
      issues.push({
        message: 'Soft 404 detected - page returns 200 but shows error content',
        detail: `<a href="${url}">${url}</a> appears to be a soft 404 (confidence: ${confidence}%). Signals: ${signals.join('; ')}. This wastes crawl budget and can hurt SEO.`,
        severity: confidence >= 70 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    } else if (confidence >= 30) {
      // Warn about potential soft 404
      warnings.push({
        message: 'Potential soft 404 detected',
        detail: `<a href="${url}">${url}</a> may be a soft 404 (confidence: ${confidence}%). Signals: ${signals.join('; ')}`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, soft404Data };
  }

  /**
   * Get visible body text
   * @private
   */
  static async #getBodyText(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        // Get text from main content areas, excluding nav/footer
        const main = document.querySelector('main, article, .content, #content, .main');
        if (main) {
          return (main as Record<string, any>).innerText.substring(0, 5000); // Limit for performance
        }
        return document.body?.innerText?.substring(0, 5000) || '';
      });
    } catch (e) {
      return '';
    }
  }

  /**
   * Check for error-specific HTML elements
   * @private
   */
  static async #checkErrorElements(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate((selectors) => {
        for (const selector of selectors) {
          try {
            if (document.querySelector(selector)) {
              return true;
            }
          } catch (e) {
            // Invalid selector, skip
          }
        }
        return false;
      }, this.#errorSelectors);
    } catch (e) {
      return false;
    }
  }

  /**
   * Get H1 text from parsed page
   * @private
   */
  static #getH1Text(parsedPage: ParsedPage) {
    const h1 = parsedPage.querySelector('h1');
    return h1 ? h1.textContent.trim() : '';
  }

  /**
   * Site-wide soft 404 analysis
   * @param {Object} pages - All pages object
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let soft404Count = 0;
    let potentialSoft404Count = 0;
    const soft404Urls: string[] = [];

    for (const [url, page] of Object.entries(pages)) {
      if (page.soft404?.isSoft404) {
        soft404Count++;
        soft404Urls.push(url);
      } else if (page.soft404?.confidence >= 30) {
        potentialSoft404Count++;
      }
    }

    if (soft404Count > 0) {
      issues.push({
        message: `${soft404Count} soft 404 pages detected`,
        detail: `These pages return HTTP 200 but display "not found" content. This wastes crawl budget. Consider returning proper 404 status or redirecting: ${soft404Urls.slice(0, 5).join(', ')}${soft404Urls.length > 5 ? ` and ${soft404Urls.length - 5} more` : ''}`,
        severity: SEVERITY.HIGH,
      });
    }

    if (potentialSoft404Count > 0) {
      warnings.push({
        message: `${potentialSoft404Count} potential soft 404 pages need review`,
        detail: 'Some pages show signs of being soft 404s. Review these pages to ensure they return appropriate status codes.',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }
}

export { Soft404Analyzer };