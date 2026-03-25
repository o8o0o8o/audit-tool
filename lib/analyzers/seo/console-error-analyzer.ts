/**
 * Console Error Analyzer
 * Captures and analyzes JavaScript console errors during page load
 */

import { SEVERITY } from '../../constants';
import { incrementCounter, calcPercent, getTopEntries } from '../../utils';
import type { ChromePage, Issue, PageInfo } from '../../types';
import type { ConsoleMessage } from 'playwright';

interface ConsoleEntry {
  type: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
  name?: string;
  stack?: string;
}

class ConsoleErrorAnalyzer {
  // Patterns to categorize console errors
  static #criticalPatterns = [
    /uncaught\s*(type)?error/i,
    /reference\s*error/i,
    /syntax\s*error/i,
    /cannot\s*read\s*propert/i,
    /is\s*not\s*defined/i,
    /is\s*not\s*a\s*function/i,
    /loading\s*chunk\s*\d+\s*failed/i, // Webpack chunk loading failure
    /hydration/i, // React hydration errors
  ];

  // Patterns to ignore (noise)
  static #ignorePatterns = [
    /favicon\.ico/i,
    /fb_xd_fragment/i, // Facebook SDK noise
    /recaptcha/i,
    /googletagmanager/i,
    /google-analytics/i,
    /hotjar/i,
    /intercom/i,
    /zendesk/i,
    /clarity\.ms/i,
  ];

  /**
   * Create console listeners for a page
   * @param {Object} chromePage - Playwright page object
   * @returns {Object} Console tracking object with methods
   */
  static createConsoleTracker(chromePage: ChromePage) {
    const errors: ConsoleEntry[] = [];
    const warnings: ConsoleEntry[] = [];
    const pageerrors: ConsoleEntry[] = [];

    // Console message handler
    const consoleHandler = (msg: ConsoleMessage) => {
      const type = msg.type();
      const text = msg.text();
      const location = msg.location();

      // Skip ignored patterns
      for (const pattern of this.#ignorePatterns) {
        if (pattern.test(text)) {
          return;
        }
      }

      const entry = {
        type,
        text: text.substring(0, 500), // Limit length
        url: location?.url || '',
        line: location?.lineNumber,
        column: location?.columnNumber,
        timestamp: Date.now(),
      };

      if (type === 'error') {
        errors.push(entry);
      } else if (type === 'warning') {
        warnings.push(entry);
      }
    };

    // Page error handler (uncaught exceptions)
    const pageerrorHandler = (error: Error) => {
      const text = error.message || error.toString();

      // Skip ignored patterns
      for (const pattern of this.#ignorePatterns) {
        if (pattern.test(text)) {
          return;
        }
      }

      pageerrors.push({
        type: 'pageerror',
        text: text.substring(0, 500),
        name: error.name,
        stack: error.stack?.substring(0, 1000),
        timestamp: Date.now(),
      });
    };

    // Attach listeners
    chromePage.on('console', consoleHandler);
    chromePage.on('pageerror', pageerrorHandler);

    return {
      errors,
      warnings,
      pageerrors,
      // Method to remove listeners
      cleanup: () => {
        chromePage.off('console', consoleHandler);
        chromePage.off('pageerror', pageerrorHandler);
      },
      // Method to get results
      getResults: () => ({
        errors: [...errors],
        warnings: [...warnings],
        pageerrors: [...pageerrors],
      }),
    };
  }

  /**
   * Analyze collected console data
   * @param {Object} consoleData - Data from console tracker
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static analyze(consoleData: unknown, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const data = consoleData as { errors?: ConsoleEntry[]; warnings?: ConsoleEntry[]; pageerrors?: ConsoleEntry[] };
    const errors = data.errors ?? [];
    const consoleWarnings = data.warnings ?? [];
    const pageerrors = data.pageerrors ?? [];

    // Combine errors and page errors
    const allErrors = [...errors, ...pageerrors];

    // Categorize errors
    const criticalErrors: ConsoleEntry[] = [];
    const otherErrors: ConsoleEntry[] = [];

    for (const error of allErrors) {
      let isCritical = false;
      for (const pattern of this.#criticalPatterns) {
        if (pattern.test(error.text)) {
          isCritical = true;
          break;
        }
      }

      if (isCritical) {
        criticalErrors.push(error);
      } else {
        otherErrors.push(error);
      }
    }

    // Report critical JS errors
    if (criticalErrors.length > 0) {
      const examples = criticalErrors
        .slice(0, 3)
        .map((e) => `"${e.text.substring(0, 100)}${e.text.length > 100 ? '...' : ''}"`)
        .join('<br>');

      issues.push({
        message: 'Critical JavaScript errors detected',
        detail: `<a href="${url}">${url}</a> has ${criticalErrors.length} critical JS error(s) that may affect functionality:<br>${examples}`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report other JS errors
    if (otherErrors.length > 0) {
      const examples = otherErrors
        .slice(0, 2)
        .map((e) => `"${e.text.substring(0, 80)}..."`)
        .join('<br>');

      issues.push({
        message: 'JavaScript console errors detected',
        detail: `<a href="${url}">${url}</a> has ${otherErrors.length} JS error(s):<br>${examples}`,
        severity: otherErrors.length > 5 ? SEVERITY.MEDIUM : SEVERITY.LOW,
      });
    }

    // Report console warnings (only if significant)
    if (consoleWarnings.length > 10) {
      warnings.push({
        message: 'Many console warnings detected',
        detail: `<a href="${url}">${url}</a> has ${consoleWarnings.length} console warnings. Review for potential issues.`,
        severity: SEVERITY.LOW,
      });
    }

    // Prepare console data for storage
    const consoleAnalysis = {
      errorCount: allErrors.length,
      criticalErrorCount: criticalErrors.length,
      warningCount: consoleWarnings.length,
      errors: allErrors.slice(0, 10).map((e) => ({
        text: e.text,
        type: e.type,
        url: e.url ?? '',
        isCritical: criticalErrors.includes(e),
      })),
      hasErrors: allErrors.length > 0,
      hasCriticalErrors: criticalErrors.length > 0,
    };

    return { issues, warnings, consoleAnalysis };
  }

  /**
   * Site-wide console error analysis
   * @param {Object} pages - All pages object
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithErrors = 0;
    let pagesWithCriticalErrors = 0;
    let totalErrors = 0;
    const commonErrors = new Map();

    for (const [_url, page] of Object.entries(pages)) {
      if (page.consoleAnalysis?.hasErrors) {
        pagesWithErrors++;

        totalErrors += page.consoleAnalysis.errorCount ?? 0;

        if (page.consoleAnalysis.hasCriticalErrors) {
          pagesWithCriticalErrors++;
        }

        // Track common errors

        for (const error of page.consoleAnalysis.errors ?? []) {
          // Normalize error text for grouping
          const normalized = error.text
            .replace(/https?:\/\/[^\s]+/g, '[URL]')
            .replace(/\d+/g, 'N')
            .substring(0, 100);

          incrementCounter(commonErrors, normalized);
        }
      }
    }

    const totalPages = Object.keys(pages).length;
    const errorPercentage = calcPercent(pagesWithErrors, totalPages);

    if (pagesWithCriticalErrors > 0) {
      issues.push({
        message: `${pagesWithCriticalErrors} pages have critical JavaScript errors`,
        detail: `Critical JS errors can break page functionality, affect user experience, and prevent proper crawling. Fix these errors as a priority.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (errorPercentage >= 50) {
      issues.push({
        message: `${errorPercentage}% of pages have JavaScript errors`,
        detail: `${pagesWithErrors} of ${totalPages} pages have JS console errors. This indicates a widespread issue that should be investigated.`,
        severity: SEVERITY.MEDIUM,
      });
    } else if (pagesWithErrors > 0) {
      warnings.push({
        message: `${pagesWithErrors} pages have JavaScript console errors`,
        detail: `${totalErrors} total JS errors detected across the site. Review and fix to improve functionality.`,
        severity: SEVERITY.LOW,
      });
    }

    // Report most common errors
    const topErrors = getTopEntries(commonErrors.entries(), 3);

    if (topErrors.length > 0 && topErrors[0][1] > 3) {
      warnings.push({
        message: 'Recurring JavaScript errors detected',
        detail: `Most common errors: ${topErrors.map(([e, c]) => `"${e}" (${c} occurrences)`).join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return {
      issues,
      warnings,
      metrics: {
        pagesWithErrors,
        pagesWithCriticalErrors,
        totalErrors,
        errorPercentage,
        topErrors: topErrors.map(([error, count]) => ({ error, count })),
      },
    };
  }
}

export { ConsoleErrorAnalyzer };
