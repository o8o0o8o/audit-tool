/**
 * Code Coverage Analyzer
 * Uses CDP Profiler for JS and CDP CSS.startRuleUsageTracking for CSS coverage.
 * Must be started BEFORE page navigation and stopped AFTER page load.
 *
 * Integration note: This analyzer requires special handling in the crawler engine.
 * Coverage must be started before page.goto() and stopped after page load completes.
 * Call startCoverage() before navigation, and analyze() after page load.
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, PageInfo, NetworkRequest, CodeCoverageFile } from '../../types';

interface CDPClient {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  detach(): Promise<void>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
}

interface StyleSheetInfo {
  styleSheetId: string;
  sourceURL: string;
  length: number;
}

class CodeCoverageAnalyzer {
  /**
   * Start coverage collection on a page
   * Must be called BEFORE page.goto()
   * @param {object} chromePage - Playwright page object
   */
  static async startCoverage(
    chromePage: ChromePage & { __coverageClient?: unknown; __cssStyleSheets?: Map<string, StyleSheetInfo> },
    existingClient?: unknown,
  ) {
    try {
      // Reuse existing CDP session if provided, otherwise create a new one
      // Creating multiple CDP sessions on the same page can cause conflicts
      const client = (existingClient ?? (await chromePage.context().newCDPSession(chromePage))) as CDPClient;
      await client.send('Profiler.enable');
      await client.send('Profiler.startPreciseCoverage', {
        callCount: false,
        detailed: true,
      });

      // Use CDP CSS domain directly for CSS coverage.
      // Playwright's coverage.startCSSCoverage() uses a separate internal CDP connection
      // that fails to properly track rule usage for inline <style> tags (especially on
      // Next.js/CSS-in-JS sites), reporting near-zero used bytes.
      // Using the same CDP session as JS profiling gives accurate results.
      const styleSheets = new Map<string, StyleSheetInfo>();
      client.on('CSS.styleSheetAdded', (params: Record<string, unknown>) => {
        const header = params.header as Record<string, unknown>;
        styleSheets.set(header.styleSheetId as string, {
          styleSheetId: header.styleSheetId as string,
          sourceURL: (header.sourceURL as string) || '',
          length: (header.length as number) || 0,
        });
      });
      await client.send('DOM.enable');
      await client.send('CSS.enable');
      await client.send('CSS.startRuleUsageTracking');

      // Store client and stylesheet map on page for later retrieval
      chromePage.__coverageClient = client;
      chromePage.__cssStyleSheets = styleSheets;
    } catch {
      // Coverage API may not be available in all browser contexts
    }
  }

  /**
   * Analyze collected coverage data
   * Must be called AFTER page load completes
   * @param {object} chromePage - Playwright page object
   * @param {object} requests - Collected request data
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static async analyze(
    chromePage: ChromePage & { __coverageClient?: unknown; __cssStyleSheets?: Map<string, StyleSheetInfo> },
    requests: NetworkRequest[],
    url: string,
  ) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      js: { total: 0, used: 0, unused: 0, ratio: 0, files: [] as CodeCoverageFile[] },
      css: { total: 0, used: 0, unused: 0, ratio: 0, files: [] as CodeCoverageFile[] },
      totalUnusedBytes: 0,
      totalBytes: 0,
      unusedRatio: 0,
    };

    const client = chromePage.__coverageClient as CDPClient | undefined;
    const styleSheets = chromePage.__cssStyleSheets;
    if (!client) {
      return { info, issues, warnings };
    }

    try {
      // Collect JS coverage
      const jsCoverage = await client.send('Profiler.takePreciseCoverage');
      const jsCoverageResult = jsCoverage?.result as
        | { url: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[]
        | undefined;
      if (jsCoverageResult) {
        for (const entry of jsCoverageResult) {
          const scriptUrl = entry.url;
          if (!scriptUrl || scriptUrl.startsWith('data:')) continue;

          const totalLength = entry.functions.reduce(
            (sum: number, fn: { ranges: { startOffset: number; endOffset: number; count: number }[] }) => {
              return Math.max(sum, ...fn.ranges.map((r) => r.endOffset));
            },
            0,
          );

          // V8's detailed coverage uses nested ranges: each function's first range
          // covers the entire body (count > 0 if called). Inner ranges with count === 0
          // are the precise uncovered "holes". Summing count === 0 ranges gives actual unused bytes.
          const unusedRanges: { startOffset: number; endOffset: number }[] = [];
          for (const fn of entry.functions) {
            for (const range of fn.ranges) {
              if (range.count === 0) {
                unusedRanges.push(range);
              }
            }
          }

          const unusedBytes = CodeCoverageAnalyzer.#mergeAndSum(unusedRanges);
          const usedBytes = Math.max(0, totalLength - unusedBytes);

          info.js.total += totalLength;
          info.js.used += usedBytes;
          info.js.unused += unusedBytes;

          if (totalLength > 10000 && unusedBytes / totalLength > 0.5) {
            info.js.files.push({
              url: scriptUrl,
              total: totalLength,
              unused: unusedBytes,
              unusedPercent: Math.round((unusedBytes / totalLength) * 100),
            });
          }
        }
      }

      // Collect CSS coverage using CDP rule usage tracking directly.
      // CDP CSS.stopRuleUsageTracking returns per-rule byte offsets with used boolean.
      // We group by stylesheet, get the text, and compute used vs unused byte ranges.
      const ruleUsageResult = (await client.send('CSS.stopRuleUsageTracking')) as {
        ruleUsage?: { styleSheetId: string; startOffset: number; endOffset: number; used: boolean }[];
      };
      if (ruleUsageResult?.ruleUsage && styleSheets) {
        // Group rule usage by stylesheet
        const sheetUsage = new Map<
          string,
          { used: { start: number; end: number }[]; unused: { start: number; end: number }[] }
        >();
        for (const rule of ruleUsageResult.ruleUsage) {
          if (!sheetUsage.has(rule.styleSheetId)) {
            sheetUsage.set(rule.styleSheetId, { used: [], unused: [] });
          }
          const entry = sheetUsage.get(rule.styleSheetId)!;
          const range = { start: rule.startOffset, end: rule.endOffset };
          if (rule.used) {
            entry.used.push(range);
          } else {
            entry.unused.push(range);
          }
        }

        // Process each stylesheet
        for (const [sheetId, usage] of sheetUsage) {
          const sheetInfo = styleSheets.get(sheetId);
          // Get the actual text length for accurate total
          let textLength = 0;
          let sheetUrl = sheetInfo?.sourceURL ?? '';
          try {
            const textResult = (await client.send('CSS.getStyleSheetText', { styleSheetId: sheetId })) as {
              text?: string;
            };
            textLength = textResult?.text?.length ?? 0;
          } catch {
            // Stylesheet may have been removed; use length from header
            textLength = sheetInfo?.length ?? 0;
          }
          if (textLength === 0) continue;
          if (sheetUrl.startsWith('data:')) continue;

          // Use page URL for inline styles (empty sourceURL)
          if (!sheetUrl) sheetUrl = url;

          const usedBytes = CodeCoverageAnalyzer.#mergeAndSumRanges(usage.used);
          const unusedBytes = Math.max(0, textLength - usedBytes);

          info.css.total += textLength;
          info.css.used += usedBytes;
          info.css.unused += unusedBytes;

          if (textLength > 5000 && unusedBytes / textLength > 0.5) {
            info.css.files.push({
              url: sheetUrl,
              total: textLength,
              unused: unusedBytes,
              unusedPercent: Math.round((unusedBytes / textLength) * 100),
            });
          }
        }
      }

      // Stop JS coverage
      await client.send('Profiler.stopPreciseCoverage');
      await client.send('Profiler.disable');
      await client.send('CSS.disable');
      await client.send('DOM.disable');
    } catch {
      // Coverage collection can fail in various edge cases
      return { info, issues, warnings };
    } finally {
      // Clean up
      try {
        await client.detach();
      } catch {
        /* ignore */
      }
      delete chromePage.__coverageClient;
      delete chromePage.__cssStyleSheets;
    }

    // Calculate ratios
    if (info.js.total > 0) {
      info.js.ratio = Math.round((info.js.unused / info.js.total) * 100);
    }
    if (info.css.total > 0) {
      info.css.ratio = Math.round((info.css.unused / info.css.total) * 100);
    }

    info.totalBytes = info.js.total + info.css.total;
    info.totalUnusedBytes = info.js.unused + info.css.unused;
    if (info.totalBytes > 0) {
      info.unusedRatio = Math.round((info.totalUnusedBytes / info.totalBytes) * 100);
    }

    // Sort files by unused bytes
    info.js.files.sort((a, b) => b.unused - a.unused);
    info.js.files = info.js.files.slice(0, 10); // Top 10
    info.css.files.sort((a, b) => b.unused - a.unused);
    info.css.files = info.css.files.slice(0, 10);

    // Report issues with top offending files for actionable insights
    if (info.js.ratio > 70 && info.js.total > 50000) {
      const topFiles = info.js.files.slice(0, 3);
      const fileList =
        topFiles.length > 0
          ? '<br>Top unused scripts:<ul style="margin:4px 0;">' +
            topFiles
              .map(
                (f) =>
                  `<li><code>${f.url.split('/').pop() ?? f.url}</code> — ${f.unusedPercent}% unused (${(f.unused / 1024).toFixed(0)}KB)</li>`,
              )
              .join('') +
            '</ul>'
          : '';
      issues.push({
        message: 'High percentage of unused JavaScript',
        detail: `<a href="${url}">${url}</a>: ${info.js.ratio}% of JavaScript is unused (${(info.js.unused / 1024).toFixed(0)}KB of ${(info.js.total / 1024).toFixed(0)}KB).${fileList}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.css.ratio > 80 && info.css.total > 20000) {
      const topCssFiles = info.css.files.slice(0, 3);
      const cssFileList =
        topCssFiles.length > 0
          ? '<br>Top unused stylesheets:<ul style="margin:4px 0;">' +
            topCssFiles
              .map(
                (f) =>
                  `<li><code>${f.url.split('/').pop() ?? f.url}</code> — ${f.unusedPercent}% unused (${(f.unused / 1024).toFixed(0)}KB)</li>`,
              )
              .join('') +
            '</ul>'
          : '';
      issues.push({
        message: 'High percentage of unused CSS',
        detail: `<a href="${url}">${url}</a>: ${info.css.ratio}% of CSS is unused (${(info.css.unused / 1024).toFixed(0)}KB of ${(info.css.total / 1024).toFixed(0)}KB).${cssFileList}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.totalUnusedBytes > 500000) {
      const topFiles = info.js.files.slice(0, 5);
      const fileList =
        topFiles.length > 0
          ? '<br>Largest unused bundles:<ul style="margin:4px 0;">' +
            topFiles
              .map(
                (f) =>
                  `<li><code>${f.url.split('/').pop() ?? f.url}</code> — ${f.unusedPercent}% unused (${(f.unused / 1024).toFixed(0)}KB of ${(f.total / 1024).toFixed(0)}KB)</li>`,
              )
              .join('') +
            '</ul>'
          : '';
      warnings.push({
        message: 'Large amount of unused code',
        detail: `<a href="${url}">${url}</a>: ${(info.totalUnusedBytes / 1024).toFixed(0)}KB of unused code (${info.unusedRatio}% of total). This significantly impacts page load time.${fileList}`,
        severity: SEVERITY.HIGH,
      });
    }

    return { info, issues, warnings };
  }

  /**
   * Site-wide code coverage analysis
   * @param {object} allPages - All page data
   * @returns {object} Site-wide analysis results
   */
  static analyzeSiteWide(allPages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.values(allPages) as PageInfo[];

    let totalJS = 0;
    let totalUnusedJS = 0;
    let totalCSS = 0;
    let totalUnusedCSS = 0;
    let pagesWithData = 0;

    // Track commonly unused scripts across pages
    const unusedScripts: Record<string, { url: string; count: number; avgUnused: number }> = {};

    for (const page of pages) {
      const coverage = page.codeCoverage;
      if (!coverage) continue;

      pagesWithData++;
      totalJS += coverage.js?.total ?? 0;
      totalUnusedJS += coverage.js?.unused ?? 0;
      totalCSS += coverage.css?.total ?? 0;
      totalUnusedCSS += coverage.css?.unused ?? 0;

      // Track frequently unused scripts
      for (const file of coverage.js?.files ?? []) {
        if (file.unusedPercent > 60) {
          const key = file.url;
          if (!unusedScripts[key]) {
            unusedScripts[key] = { url: key, count: 0, avgUnused: 0 };
          }
          unusedScripts[key].count++;
          unusedScripts[key].avgUnused += file.unusedPercent;
        }
      }
    }

    if (pagesWithData === 0) return { issues, warnings };

    // Average across site
    const avgJSUnused = totalJS > 0 ? Math.round((totalUnusedJS / totalJS) * 100) : 0;
    const avgCSSUnused = totalCSS > 0 ? Math.round((totalUnusedCSS / totalCSS) * 100) : 0;

    if (avgJSUnused > 60) {
      issues.push({
        title: `Site-wide: ${avgJSUnused}% of JavaScript is unused on average`,
        description: `Across ${pagesWithData} pages, ${(totalUnusedJS / 1024 / 1024).toFixed(1)}MB of JavaScript went unused. Consider tree-shaking, code splitting, or lazy loading.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (avgCSSUnused > 70) {
      issues.push({
        title: `Site-wide: ${avgCSSUnused}% of CSS is unused on average`,
        description: `Across ${pagesWithData} pages, ${(totalUnusedCSS / 1024 / 1024).toFixed(1)}MB of CSS went unused. Consider CSS purging or critical CSS extraction.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report commonly unused scripts
    const frequentlyUnused = Object.values(unusedScripts)
      .filter((s) => s.count >= Math.min(3, pagesWithData * 0.5))
      .sort((a, b) => b.count - a.count);

    if (frequentlyUnused.length > 0) {
      const list = frequentlyUnused
        .slice(0, 5)
        .map((s) => {
          s.avgUnused = Math.round(s.avgUnused / s.count);
          return `<li>${s.url} - ${s.avgUnused}% unused on ${s.count} pages</li>`;
        })
        .join('');
      warnings.push({
        title: `${frequentlyUnused.length} script(s) consistently have high unused code`,
        description: `These scripts are frequently loaded but mostly unused:<ul>${list}</ul>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }

  /**
   * Merge overlapping ranges and sum total bytes
   * @param {Array} ranges - [{startOffset, endOffset}]
   * @returns {number} Total unique bytes covered
   * @private
   */
  static #mergeAndSum(ranges: { startOffset: number; endOffset: number }[]) {
    if (ranges.length === 0) return 0;

    const sorted = ranges.map((r) => ({ start: r.startOffset, end: r.endOffset })).sort((a, b) => a.start - b.start);

    let total = 0;
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start <= current.end) {
        current.end = Math.max(current.end, sorted[i].end);
      } else {
        total += current.end - current.start;
        current = sorted[i];
      }
    }
    total += current.end - current.start;

    return total;
  }

  /**
   * Merge overlapping ranges {start, end} and sum total bytes
   * @param {Array} ranges - [{start, end}]
   * @returns {number} Total unique bytes covered
   * @private
   */
  static #mergeAndSumRanges(ranges: { start: number; end: number }[]) {
    if (ranges.length === 0) return 0;

    const sorted = [...ranges].sort((a, b) => a.start - b.start);

    let total = 0;
    let current = { start: sorted[0].start, end: sorted[0].end };

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start <= current.end) {
        current.end = Math.max(current.end, sorted[i].end);
      } else {
        total += current.end - current.start;
        current = { start: sorted[i].start, end: sorted[i].end };
      }
    }
    total += current.end - current.start;

    return total;
  }
}

export { CodeCoverageAnalyzer };
