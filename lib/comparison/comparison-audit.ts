/**
 * Comparison Audit
 * Orchestrates auditing two sites and comparing them page by page
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { exec } from 'child_process';
// Import SEOData from extracted module (avoids circular dependency with robots.js)
import { SEOData } from '../seo-data';
import { PageMatcher } from './page-matcher';
import { generateTimestamp } from '../utils';
import { formatElapsedTime } from '../utils';
import { generateHTML } from '../../generateHTML';
import type { PageInfo, Issue, AuditSummary } from '../types';

interface ComparisonOptions {
  proceed: boolean;
  perf: boolean;
  saveHtml: boolean;
  concurrency: number;
  sitemap: string | null;
  compareSitemap: string | null;
  open: boolean;
}

interface AuditSiteResult {
  data: Record<string, unknown>;
  domain: string | null;
  resultsDir: string;
  file: string;
  htmlPath: string;
}

interface PageDelta {
  path: string;
  originUrl: string;
  compareUrl: string;
  status: { origin: number; compare: number };
  deltas: Record<string, number>;
  changes: Record<string, { origin: string; compare: string; changed: boolean }>;
  issues: { fixed: string[]; new: string[]; persistent: string[] };
  metrics: { origin: Record<string, unknown>; compare: Record<string, unknown> };
}

interface UnmatchedPageInfo {
  url: string;
  title: string;
  status: number;
  issues: number;
}

interface MatchedPageEntry {
  path: string;
  originUrl: string;
  compareUrl: string;
  originPage: PageInfo;
  comparePage: PageInfo;
}

interface ScoreSet {
  overall: number;
  seo: number;
  performance: number;
  accessibility: number;
  security: number;
  technical: number;
}

interface IssueSet {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface ComparisonSummary {
  originTotalPages: number;
  compareTotalPages: number;
  matchedPages: number;
  originOnlyPages: number;
  compareOnlyPages: number;
  matchPercentage: number;
  scoreComparison: {
    origin: ScoreSet;
    compare: ScoreSet;
    delta: ScoreSet;
  };
  issueComparison: {
    origin: IssueSet;
    compare: IssueSet;
    delta: IssueSet;
  };
}

interface ComparisonResultData {
  meta: {
    originUrl: string | null;
    compareUrl: string | null;
    originDomain: string | null;
    compareDomain: string | null;
    timestamp: string;
    mode: string;
    duration: string;
  };
  summary: ComparisonSummary;
  pageComparisons: Record<string, PageDelta>;
  originOnly: Record<string, UnmatchedPageInfo>;
  compareOnly: Record<string, UnmatchedPageInfo>;
  originAuditPath: string;
  compareAuditPath: string;
}

class ComparisonAudit {
  #originUrl: string | null;
  #compareUrl: string | null;
  #options: ComparisonOptions;
  #originResults: AuditSiteResult | null;
  #compareResults: AuditSiteResult | null;
  #comparisonResults: ComparisonResultData | null;
  #startTime!: number;

  originDomain: string | null;
  compareDomain: string | null;
  comparisonDir!: string;
  timestamp!: string;

  /**
   * Create a comparison audit
   * @param {string|null} originUrl - Origin site URL (null when using sitemap file)
   * @param {string|null} compareUrl - Comparison site URL (null when using sitemap file)
   * @param {object} options - Options (perf, saveHtml, concurrency, sitemap, compareSitemap)
   */
  constructor(originUrl: string | null, compareUrl: string | null, options: Partial<ComparisonOptions> = {}) {
    this.#originUrl = originUrl;
    this.#compareUrl = compareUrl;
    this.#options = {
      proceed: options.proceed ?? false,
      perf: options.perf ?? false,
      saveHtml: options.saveHtml ?? false,
      concurrency: options.concurrency ?? 5,
      sitemap: options.sitemap ?? null,
      compareSitemap: options.compareSitemap ?? null,
      open: options.open ?? false,
    };
    this.#originResults = null;
    this.#compareResults = null;
    this.#comparisonResults = null;

    // Extract domain names (deferred when using sitemap files)
    this.originDomain = originUrl ? new URL(originUrl).hostname : null;
    this.compareDomain = compareUrl ? new URL(compareUrl).hostname : null;

    // Set up comparison directory (deferred if domains not yet known)
    if (this.originDomain && this.compareDomain) {
      this.comparisonDir = this.#setupComparisonDirectory();
    }
  }

  /**
   * Set up the comparison results directory
   * @returns {string} Path to comparison directory
   */
  #setupComparisonDirectory() {
    const timestamp = generateTimestamp(); // Use shared utility
    const comparisonName = `${this.originDomain}__vs__${this.compareDomain}`;
    const baseDir = path.join('audit-results', 'comparisons', comparisonName, timestamp);

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
      console.log(`\n📁 Created comparison directory: ${baseDir}`);
    }

    this.timestamp = timestamp;
    return baseDir;
  }

  /**
   * Run the comparison audit
   * Sequential crawling: origin first, then compare
   */
  async audit() {
    this.#startTime = Date.now();

    console.log('\n' + '='.repeat(60));
    console.log('         SITE COMPARISON AUDIT');
    console.log('='.repeat(60));
    console.log(`\nOrigin:  ${this.#originUrl ?? this.#options.sitemap}`);
    console.log(`Compare: ${this.#compareUrl ?? this.#options.compareSitemap}`);
    console.log('='.repeat(60) + '\n');

    // Phase 1: Audit origin site
    console.log('\n📊 PHASE 1: Auditing origin site...');
    console.log('-'.repeat(40));
    await this.#auditOrigin();

    // Phase 2: Audit compare site
    console.log('\n\n📊 PHASE 2: Auditing comparison site...');
    console.log('-'.repeat(40));
    await this.#auditCompare();

    // Set up comparison directory if deferred (sitemap mode)
    if (!this.comparisonDir) {
      this.comparisonDir = this.#setupComparisonDirectory();
    }

    // Phase 3: Compare results
    console.log('\n\n📊 PHASE 3: Comparing results...');
    console.log('-'.repeat(40));
    this.#performComparison();

    // Phase 4: Save results and generate report
    console.log('\n\n📊 PHASE 4: Generating comparison report...');
    console.log('-'.repeat(40));
    await this.#saveResults();

    // Print summary
    this.#printSummary();

    return this.#comparisonResults;
  }

  /**
   * Audit the origin site
   */
  async #auditOrigin() {
    const seo = new SEOData(
      this.#originUrl,
      this.#options.proceed,
      this.#options.perf,
      this.#options.saveHtml,
      this.#options.concurrency,
      this.#options.sitemap,
    );

    await seo.audit();
    this.#originResults = {
      data: seo.data,
      domain: seo.domainName,
      resultsDir: seo.resultsDir,
      file: seo.file,
      htmlPath: seo.fileManager.getHtmlFilePath(),
    };

    // Update domain if it was derived from sitemap
    this.originDomain ??= seo.domainName;

    console.log(`\n✅ Origin audit complete: ${Object.keys(seo.data.pageData.pages ?? {}).length} pages`);
  }

  /**
   * Audit the compare site
   */
  async #auditCompare() {
    const seo = new SEOData(
      this.#compareUrl,
      false, // Don't proceed for compare site, always fresh
      this.#options.perf,
      this.#options.saveHtml,
      this.#options.concurrency,
      this.#options.compareSitemap,
    );

    await seo.audit();
    this.#compareResults = {
      data: seo.data,
      domain: seo.domainName,
      resultsDir: seo.resultsDir,
      file: seo.file,
      htmlPath: seo.fileManager.getHtmlFilePath(),
    };

    // Update domain if it was derived from sitemap
    this.compareDomain ??= seo.domainName;

    console.log(`\n✅ Compare audit complete: ${Object.keys(seo.data.pageData.pages ?? {}).length} pages`);
  }

  /**
   * Load all pages from batch files on disk for a given audit result
   * Pages are cleared from memory after saving to prevent OOM,
   * so we need to reload them from the multi-file format.
   * @param {object} auditResult - { data, domain, resultsDir, file }
   * @returns {object} Pages keyed by URL
   */
  #loadPagesFromDisk(auditResult: AuditSiteResult): Record<string, PageInfo> {
    const data = auditResult.data as { pageData?: { pages?: Record<string, PageInfo> } };
    const pages = data.pageData?.pages ?? {};

    // If pages are already in memory, use them
    if (Object.keys(pages).length > 0) {
      return pages;
    }

    // Load from batch files
    const resultsDir = auditResult.resultsDir;
    const pagesDir = path.join(resultsDir, 'pages');

    if (!fs.existsSync(pagesDir)) {
      console.log(`  No pages directory found at ${pagesDir}`);
      return pages;
    }

    const batchFiles = fs
      .readdirSync(pagesDir)
      .filter((f) => f.startsWith('batch_') && f.endsWith('.json.gz'))
      .sort();

    const allPages: Record<string, PageInfo> = {};
    for (const batchFile of batchFiles) {
      try {
        const filePath = path.join(pagesDir, batchFile);
        const compressed = fs.readFileSync(filePath);
        const batchData = JSON.parse(zlib.gunzipSync(compressed).toString('utf-8')) as {
          pages?: Record<string, PageInfo>;
        };
        if (batchData.pages) {
          Object.assign(allPages, batchData.pages);
        }
      } catch (error: unknown) {
        console.warn(`  Warning: Could not load batch ${batchFile}: ${(error as Error).message}`);
      }
    }

    console.log(`  Loaded ${Object.keys(allPages).length} pages from ${batchFiles.length} batch files`);
    return allPages;
  }

  /**
   * Compare the results from both sites
   */
  #performComparison() {
    const originPages = this.#loadPagesFromDisk(this.#originResults!);
    const comparePages = this.#loadPagesFromDisk(this.#compareResults!);

    // Match pages by URL path
    const matchResult = PageMatcher.matchPages(originPages, comparePages);
    const matchStats = PageMatcher.getMatchStats(matchResult);

    console.log(`\nMatching results:`);
    console.log(`  Matched pages:    ${matchStats.matchedCount} (${matchStats.matchPercentage}%)`);
    console.log(`  Origin only:      ${matchStats.originOnlyCount}`);
    console.log(`  Compare only:     ${matchStats.compareOnlyCount}`);

    // Warn if low match rate
    if (matchStats.matchPercentage < 50 && matchStats.matchedCount > 0) {
      console.log(`\n⚠️  Warning: Low match rate (${matchStats.matchPercentage}%). Sites may be very different.`);
    }

    // Calculate page-level comparisons
    const pageComparisons: Record<string, PageDelta> = {};
    for (const match of matchResult.matched) {
      pageComparisons[match.path] = this.#calculatePageDelta(match);
    }

    // Calculate score comparisons
    const originData = this.#originResults!.data as { analysis?: { summary?: Partial<AuditSummary> } };
    const compareData = this.#compareResults!.data as { analysis?: { summary?: Partial<AuditSummary> } };
    const originSummary = originData.analysis?.summary ?? {};
    const compareSummary = compareData.analysis?.summary ?? {};

    this.#comparisonResults = {
      meta: {
        originUrl: this.#originUrl,
        compareUrl: this.#compareUrl,
        originDomain: this.originDomain,
        compareDomain: this.compareDomain,
        timestamp: new Date().toISOString(),
        mode: 'comparison',
        duration: formatElapsedTime(Date.now() - this.#startTime),
      },
      summary: {
        originTotalPages: matchStats.totalOrigin,
        compareTotalPages: matchStats.totalCompare,
        matchedPages: matchStats.matchedCount,
        originOnlyPages: matchStats.originOnlyCount,
        compareOnlyPages: matchStats.compareOnlyCount,
        matchPercentage: matchStats.matchPercentage,
        scoreComparison: {
          origin: {
            overall: originSummary.overallScore ?? 0,
            seo: originSummary.categoryScores?.seo ?? 0,
            performance: originSummary.categoryScores?.performance ?? 0,
            accessibility: originSummary.categoryScores?.accessibility ?? 0,
            security: originSummary.categoryScores?.security ?? 0,
            technical: originSummary.categoryScores?.technical ?? 0,
          },
          compare: {
            overall: compareSummary.overallScore ?? 0,
            seo: compareSummary.categoryScores?.seo ?? 0,
            performance: compareSummary.categoryScores?.performance ?? 0,
            accessibility: compareSummary.categoryScores?.accessibility ?? 0,
            security: compareSummary.categoryScores?.security ?? 0,
            technical: compareSummary.categoryScores?.technical ?? 0,
          },
          delta: {
            overall: (originSummary.overallScore ?? 0) - (compareSummary.overallScore ?? 0),
            seo: (originSummary.categoryScores?.seo ?? 0) - (compareSummary.categoryScores?.seo ?? 0),
            performance:
              (originSummary.categoryScores?.performance ?? 0) - (compareSummary.categoryScores?.performance ?? 0),
            accessibility:
              (originSummary.categoryScores?.accessibility ?? 0) - (compareSummary.categoryScores?.accessibility ?? 0),
            security: (originSummary.categoryScores?.security ?? 0) - (compareSummary.categoryScores?.security ?? 0),
            technical: (originSummary.categoryScores?.technical ?? 0) - (compareSummary.categoryScores?.technical ?? 0),
          },
        },
        issueComparison: {
          origin: {
            total: originSummary.totalIssues ?? 0,
            critical: originSummary.criticalCount ?? 0,
            high: originSummary.highCount ?? 0,
            medium: originSummary.mediumCount ?? 0,
            low: originSummary.lowCount ?? 0,
          },
          compare: {
            total: compareSummary.totalIssues ?? 0,
            critical: compareSummary.criticalCount ?? 0,
            high: compareSummary.highCount ?? 0,
            medium: compareSummary.mediumCount ?? 0,
            low: compareSummary.lowCount ?? 0,
          },
          delta: {
            total: (originSummary.totalIssues ?? 0) - (compareSummary.totalIssues ?? 0),
            critical: (originSummary.criticalCount ?? 0) - (compareSummary.criticalCount ?? 0),
            high: (originSummary.highCount ?? 0) - (compareSummary.highCount ?? 0),
            medium: (originSummary.mediumCount ?? 0) - (compareSummary.mediumCount ?? 0),
            low: (originSummary.lowCount ?? 0) - (compareSummary.lowCount ?? 0),
          },
        },
      },
      pageComparisons,
      originOnly: this.#formatUnmatchedPages(matchResult.originOnly),
      compareOnly: this.#formatUnmatchedPages(matchResult.compareOnly),
      originAuditPath: this.#originResults!.file,
      compareAuditPath: this.#compareResults!.file,
    };
  }

  /**
   * Calculate delta metrics for a matched page pair
   * @param {object} match - Match object with originPage and comparePage
   * @returns {object} Page comparison data
   */
  #calculatePageDelta(match: MatchedPageEntry): PageDelta {
    const origin = match.originPage;
    const compare = match.comparePage;

    // Get performance metrics
    const originPerf = origin.performanceMetrics ?? {};
    const comparePerf = compare.performanceMetrics ?? {};

    // Calculate metric deltas (positive = origin is worse)
    const deltas = {
      LCP: (originPerf.LCP ?? 0) - (comparePerf.LCP ?? 0),
      CLS: (originPerf.CLS ?? 0) - (comparePerf.CLS ?? 0),
      TTFB: (originPerf.TTFB ?? 0) - (comparePerf.TTFB ?? 0),
      FCP: (originPerf.FCP ?? 0) - (comparePerf.FCP ?? 0),
      pageSize: (origin.pageSize ?? 0) - (compare.pageSize ?? 0),
      requestCount: (origin.requestCount ?? 0) - (compare.requestCount ?? 0),
    };

    // Check for content changes
    const changes = {
      title: {
        origin: origin.title ?? '',
        compare: compare.title ?? '',
        changed: (origin.title ?? '') !== (compare.title ?? ''),
      },
      description: {
        origin: origin.description ?? '',
        compare: compare.description ?? '',
        changed: (origin.description ?? '') !== (compare.description ?? ''),
      },
      canonical: {
        origin: origin.canonical ?? '',
        compare: compare.canonical ?? '',
        changed: (origin.canonical ?? '') !== (compare.canonical ?? ''),
      },
      h1: {
        origin: Array.isArray(origin.h1) ? origin.h1.join(', ') : (origin.h1 ?? ''),
        compare: Array.isArray(compare.h1) ? compare.h1.join(', ') : (compare.h1 ?? ''),
        changed: String(origin.h1 ?? '') !== String(compare.h1 ?? ''),
      },
    };

    // Categorize issues
    const originIssues = new Set(origin.issues?.map((i: Issue) => i.message ?? String(i)) ?? []);
    const compareIssues = new Set(compare.issues?.map((i: Issue) => i.message ?? String(i)) ?? []);

    const issues = {
      fixed: [...compareIssues].filter((i) => !originIssues.has(i)), // In compare but not origin = fixed
      new: [...originIssues].filter((i) => !compareIssues.has(i)), // In origin but not compare = new
      persistent: [...originIssues].filter((i) => compareIssues.has(i)), // In both
    };

    return {
      path: match.path,
      originUrl: match.originUrl,
      compareUrl: match.compareUrl,
      status: {
        origin: origin.statusCode ?? 200,
        compare: compare.statusCode ?? 200,
      },
      deltas,
      changes,
      issues,
      metrics: {
        origin: {
          LCP: originPerf.LCP,
          CLS: originPerf.CLS,
          TTFB: originPerf.TTFB,
          FCP: originPerf.FCP,
          pageSize: origin.pageSize,
          requestCount: origin.requestCount,
        },
        compare: {
          LCP: comparePerf.LCP,
          CLS: comparePerf.CLS,
          TTFB: comparePerf.TTFB,
          FCP: comparePerf.FCP,
          pageSize: compare.pageSize,
          requestCount: compare.requestCount,
        },
      },
    };
  }

  /**
   * Format unmatched pages for output
   * @param {Array} pages - Array of unmatched page objects
   * @returns {object} Formatted pages keyed by path
   */
  #formatUnmatchedPages(
    pages: Array<{ path: string; url: string; page: PageInfo }>,
  ): Record<string, UnmatchedPageInfo> {
    const result: Record<string, UnmatchedPageInfo> = {};
    for (const page of pages) {
      result[page.path] = {
        url: page.url,
        title: page.page?.title ?? '',
        status: page.page?.statusCode ?? 200,
        issues: page.page?.issues?.length ?? 0,
      };
    }
    return result;
  }

  /**
   * Save comparison results and generate report
   */
  async #saveResults() {
    // Save comparison JSON
    const comparisonFile = path.join(this.comparisonDir, 'comparison.json.gz');
    const jsonString = JSON.stringify(this.#comparisonResults);
    const compressedData = zlib.gzipSync(jsonString);
    fs.writeFileSync(comparisonFile, compressedData);

    const sizeMB = compressedData.length / (1024 * 1024);
    console.log(`\n💾 Saved comparison data: ${comparisonFile} (${sizeMB.toFixed(2)} MB)`);

    // Generate individual HTML reports for each site
    try {
      generateHTML(this.#originResults!.file, this.#originResults!.domain!, this.#originResults!.htmlPath);
      console.log(`📄 Generated origin report: ${this.#originResults!.htmlPath}`);
    } catch (error) {
      console.warn(`⚠️  Could not generate origin HTML report: ${(error as Error).message}`);
    }

    try {
      generateHTML(this.#compareResults!.file, this.#compareResults!.domain!, this.#compareResults!.htmlPath);
      console.log(`📄 Generated compare report: ${this.#compareResults!.htmlPath}`);
    } catch (error) {
      console.warn(`⚠️  Could not generate compare HTML report: ${(error as Error).message}`);
    }

    // Generate rich comparison HTML report using the regular report with dual-origin mode
    const htmlFile = path.join(this.comparisonDir, 'comparison.html');
    try {
      generateHTML(this.#originResults!.file, this.#originResults!.domain!, htmlFile, {
        compareFile: this.#compareResults!.file,
        compareDomainName: this.#compareResults!.domain!,
      });
      console.log(`📄 Generated comparison report: ${htmlFile}`);
    } catch (error) {
      console.warn(`⚠️  Rich comparison report failed, falling back to simple report: ${(error as Error).message}`);
      this.#generateComparisonHtml(htmlFile);
      console.log(`📄 Generated fallback comparison report: ${htmlFile}`);
    }

    // Auto-open comparison report in browser if --open flag is set
    if (this.#options.open) {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      const absolutePath = path.resolve(htmlFile);
      exec(`${openCmd} "${absolutePath}"`, (err) => {
        if (err) console.log('Could not auto-open comparison report:', err.message);
      });
    }
  }

  /**
   * Generate comparison HTML report
   * @param {string} outputPath - Output file path
   */
  #generateComparisonHtml(outputPath: string) {
    const data = this.#comparisonResults!;
    const summary = data.summary;
    const scores = summary.scoreComparison;
    const issues = summary.issueComparison;

    // Count improvements and regressions
    let improvements = 0;
    let regressions = 0;
    let unchanged = 0;

    for (const comparison of Object.values(data.pageComparisons)) {
      const newIssues = comparison.issues.new.length;
      const fixedIssues = comparison.issues.fixed.length;

      if (newIssues > fixedIssues) regressions++;
      else if (fixedIssues > newIssues) improvements++;
      else unchanged++;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Site Comparison: ${this.originDomain} vs ${this.compareDomain}</title>
  <style>
    :root {
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --blue: #3b82f6;
      --gray: #6b7280;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: #1e293b;
      line-height: 1.6;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.25rem; margin-bottom: 1rem; color: #334155; }
    h3 { font-size: 1rem; margin-bottom: 0.5rem; color: #475569; }
    .header {
      background: linear-gradient(135deg, #1e40af, #7c3aed);
      color: white;
      padding: 2rem;
      border-radius: 1rem;
      margin-bottom: 2rem;
    }
    .header-sites {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-top: 1rem;
      flex-wrap: wrap;
    }
    .site-badge {
      background: rgba(255,255,255,0.2);
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-family: monospace;
      font-size: 0.875rem;
    }
    .vs { font-weight: bold; font-size: 1.25rem; }
    .meta { font-size: 0.875rem; opacity: 0.9; margin-top: 1rem; }
    .card {
      background: var(--card-bg);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: var(--bg);
      padding: 1rem;
      border-radius: 0.5rem;
      text-align: center;
    }
    .stat-value { font-size: 2rem; font-weight: bold; }
    .stat-label { font-size: 0.875rem; color: var(--gray); }
    .score-comparison {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
    }
    .score-item {
      text-align: center;
      padding: 1rem;
      background: var(--bg);
      border-radius: 0.5rem;
    }
    .score-label { font-size: 0.75rem; text-transform: uppercase; color: var(--gray); margin-bottom: 0.5rem; }
    .score-values { display: flex; justify-content: center; align-items: center; gap: 0.5rem; }
    .score-num { font-size: 1.5rem; font-weight: bold; }
    .score-arrow { font-size: 1.25rem; }
    .delta { font-size: 0.875rem; font-weight: 500; margin-top: 0.25rem; }
    .delta.positive { color: var(--green); }
    .delta.negative { color: var(--red); }
    .delta.neutral { color: var(--gray); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: var(--bg);
      font-weight: 600;
      position: sticky;
      top: 0;
    }
    tr:hover { background: #f1f5f9; }
    .path-cell { font-family: monospace; font-size: 0.8rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
    .metric-cell { text-align: right; font-family: monospace; }
    .delta-cell { text-align: right; font-weight: 500; }
    .delta-cell.better { color: var(--green); }
    .delta-cell.worse { color: var(--red); }
    .delta-cell.same { color: var(--gray); }
    .badge {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .badge-green { background: #dcfce7; color: #166534; }
    .badge-red { background: #fee2e2; color: #991b1b; }
    .badge-gray { background: #f1f5f9; color: #475569; }
    .table-container { overflow-x: auto; }
    .filter-bar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .filter-btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      background: white;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
    }
    .filter-btn:hover { background: var(--bg); }
    .filter-btn.active { background: var(--blue); color: white; border-color: var(--blue); }
    .summary-banner {
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      font-weight: 500;
    }
    .summary-banner.improved { background: #dcfce7; color: #166534; }
    .summary-banner.regressed { background: #fee2e2; color: #991b1b; }
    .summary-banner.mixed { background: #fef3c7; color: #92400e; }
    .collapsible-header {
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .collapsible-header:hover { opacity: 0.8; }
    .collapsible-content { display: none; margin-top: 1rem; }
    .collapsible-content.open { display: block; }
    .arrow { transition: transform 0.2s; }
    .arrow.open { transform: rotate(90deg); }
    @media (max-width: 768px) {
      .container { padding: 1rem; }
      .header { padding: 1.5rem; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Site Comparison Report</h1>
      <div class="header-sites">
        <span class="site-badge">${this.#escapeHtml(this.originDomain)}</span>
        <span class="vs">vs</span>
        <span class="site-badge">${this.#escapeHtml(this.compareDomain)}</span>
      </div>
      <div class="meta">
        Generated: ${new Date().toLocaleString()} | Duration: ${data.meta.duration}
      </div>
    </div>

    ${this.#getSummaryBanner(scores.delta.overall, improvements, regressions)}

    <div class="card">
      <h2>Page Matching Summary</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${summary.matchedPages}</div>
          <div class="stat-label">Matched Pages</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${summary.matchPercentage}%</div>
          <div class="stat-label">Match Rate</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${summary.originOnlyPages}</div>
          <div class="stat-label">Origin Only</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${summary.compareOnlyPages}</div>
          <div class="stat-label">Compare Only</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Score Comparison</h2>
      <div class="score-comparison">
        ${this.#getScoreCard('Overall', scores.origin.overall, scores.compare.overall, scores.delta.overall)}
        ${this.#getScoreCard('SEO', scores.origin.seo, scores.compare.seo, scores.delta.seo)}
        ${this.#getScoreCard('Performance', scores.origin.performance, scores.compare.performance, scores.delta.performance)}
        ${this.#getScoreCard('Accessibility', scores.origin.accessibility, scores.compare.accessibility, scores.delta.accessibility)}
        ${this.#getScoreCard('Security', scores.origin.security, scores.compare.security, scores.delta.security)}
      </div>
    </div>

    <div class="card">
      <h2>Issue Comparison</h2>
      <div class="stats-grid">
        ${this.#getIssueCard('Critical', issues.origin.critical, issues.compare.critical, issues.delta.critical)}
        ${this.#getIssueCard('High', issues.origin.high, issues.compare.high, issues.delta.high)}
        ${this.#getIssueCard('Medium', issues.origin.medium, issues.compare.medium, issues.delta.medium)}
        ${this.#getIssueCard('Low', issues.origin.low, issues.compare.low, issues.delta.low)}
      </div>
    </div>

    <div class="card">
      <h2>Page-by-Page Comparison</h2>
      <div class="filter-bar">
        <button class="filter-btn active" data-filter="all">All (${Object.keys(data.pageComparisons).length})</button>
        <button class="filter-btn" data-filter="improved">Improved (${improvements})</button>
        <button class="filter-btn" data-filter="regressed">Regressed (${regressions})</button>
        <button class="filter-btn" data-filter="unchanged">Unchanged (${unchanged})</button>
      </div>
      <div class="table-container">
        <table id="comparison-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Status</th>
              <th>LCP Delta</th>
              <th>CLS Delta</th>
              <th>TTFB Delta</th>
              <th>Fixed</th>
              <th>New Issues</th>
              <th>Changes</th>
            </tr>
          </thead>
          <tbody>
            ${this.#getPageRows(data.pageComparisons)}
          </tbody>
        </table>
      </div>
    </div>

    ${
      Object.keys(data.originOnly).length > 0
        ? `
    <div class="card">
      <div class="collapsible-header" onclick="toggleCollapsible(this)">
        <h2>Pages Only in Origin (${Object.keys(data.originOnly).length})</h2>
        <span class="arrow">▶</span>
      </div>
      <div class="collapsible-content">
        ${this.#getUnmatchedPagesTable(data.originOnly)}
      </div>
    </div>
    `
        : ''
    }

    ${
      Object.keys(data.compareOnly).length > 0
        ? `
    <div class="card">
      <div class="collapsible-header" onclick="toggleCollapsible(this)">
        <h2>Pages Only in Compare (${Object.keys(data.compareOnly).length})</h2>
        <span class="arrow">▶</span>
      </div>
      <div class="collapsible-content">
        ${this.#getUnmatchedPagesTable(data.compareOnly)}
      </div>
    </div>
    `
        : ''
    }
  </div>

  <script>
    // Filter functionality
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        document.querySelectorAll('#comparison-table tbody tr').forEach(row => {
          if (filter === 'all') {
            row.style.display = '';
          } else {
            row.style.display = row.dataset.status === filter ? '' : 'none';
          }
        });
      });
    });

    // Collapsible sections
    function toggleCollapsible(header) {
      const content = header.nextElementSibling;
      const arrow = header.querySelector('.arrow');
      content.classList.toggle('open');
      arrow.classList.toggle('open');
    }

    // Sort table by clicking headers
    document.querySelectorAll('#comparison-table th').forEach((th, index) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const table = document.getElementById('comparison-table');
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const isNumeric = index >= 2 && index <= 6;

        rows.sort((a, b) => {
          const aVal = a.cells[index].textContent;
          const bVal = b.cells[index].textContent;
          if (isNumeric) {
            const aNum = parseFloat(aVal.replace(/[^-\\d.]/g, '')) || 0;
            const bNum = parseFloat(bVal.replace(/[^-\\d.]/g, '')) || 0;
            return bNum - aNum;
          }
          return aVal.localeCompare(bVal);
        });

        rows.forEach(row => tbody.appendChild(row));
      });
    });
  </script>
</body>
</html>`;

    fs.writeFileSync(outputPath, html);
  }

  /**
   * Get summary banner HTML
   */
  #getSummaryBanner(scoreDelta: number, improvements: number, regressions: number) {
    if (scoreDelta > 5) {
      return `<div class="summary-banner improved">
        Origin scores ${scoreDelta} points higher overall with ${improvements} improved pages
      </div>`;
    } else if (scoreDelta < -5) {
      return `<div class="summary-banner regressed">
        Origin scores ${Math.abs(scoreDelta)} points lower overall with ${regressions} regressed pages
      </div>`;
    } else {
      return `<div class="summary-banner mixed">
        Sites are similar in overall score. ${improvements} pages improved, ${regressions} regressed.
      </div>`;
    }
  }

  /**
   * Get score card HTML
   */
  #getScoreCard(label: string, origin: number, compare: number, delta: number) {
    const deltaClass = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
    const deltaSign = delta > 0 ? '+' : '';
    return `
      <div class="score-item">
        <div class="score-label">${label}</div>
        <div class="score-values">
          <span class="score-num">${origin}</span>
          <span class="score-arrow">→</span>
          <span class="score-num">${compare}</span>
        </div>
        <div class="delta ${deltaClass}">${deltaSign}${delta}</div>
      </div>
    `;
  }

  /**
   * Get issue card HTML
   */
  #getIssueCard(label: string, origin: number, compare: number, delta: number) {
    const deltaClass = delta < 0 ? 'positive' : delta > 0 ? 'negative' : 'neutral';
    const deltaSign = delta > 0 ? '+' : '';
    return `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value" style="font-size: 1.5rem;">${origin} → ${compare}</div>
        <div class="delta ${deltaClass}">${deltaSign}${delta}</div>
      </div>
    `;
  }

  /**
   * Get page comparison rows HTML
   */
  #getPageRows(pageComparisons: Record<string, PageDelta>) {
    return Object.values(pageComparisons)
      .map((page: PageDelta) => {
        const fixedCount = page.issues.fixed.length;
        const newCount = page.issues.new.length;
        const status = newCount > fixedCount ? 'regressed' : fixedCount > newCount ? 'improved' : 'unchanged';

        const changesCount = Object.values(page.changes).filter(
          (c: { origin: string; compare: string; changed: boolean }) => c.changed,
        ).length;

        const getDeltaClass = (val: number, inverse: boolean = false) => {
          if (val === 0 || val === undefined) return 'same';
          if (inverse) return val < 0 ? 'worse' : 'better';
          return val > 0 ? 'worse' : 'better';
        };

        const formatDelta = (val: number | undefined | null, unit: string = '') => {
          if (val === undefined || val === null) return '-';
          const sign = val > 0 ? '+' : '';
          if (Math.abs(val) > 1000) return `${sign}${(val / 1000).toFixed(1)}s`;
          return `${sign}${val.toFixed(val < 1 ? 3 : 0)}${unit}`;
        };

        return `
        <tr data-status="${status}">
          <td class="path-cell" title="${this.#escapeHtml(page.path)}">${this.#escapeHtml(page.path)}</td>
          <td>${page.status.origin} / ${page.status.compare}</td>
          <td class="delta-cell ${getDeltaClass(page.deltas.LCP)}">${formatDelta(page.deltas.LCP, 'ms')}</td>
          <td class="delta-cell ${getDeltaClass(page.deltas.CLS)}">${formatDelta(page.deltas.CLS)}</td>
          <td class="delta-cell ${getDeltaClass(page.deltas.TTFB)}">${formatDelta(page.deltas.TTFB, 'ms')}</td>
          <td><span class="badge ${fixedCount > 0 ? 'badge-green' : 'badge-gray'}">${fixedCount}</span></td>
          <td><span class="badge ${newCount > 0 ? 'badge-red' : 'badge-gray'}">${newCount}</span></td>
          <td><span class="badge badge-gray">${changesCount}</span></td>
        </tr>
      `;
      })
      .join('');
  }

  /**
   * Get unmatched pages table HTML
   */
  #getUnmatchedPagesTable(pages: Record<string, UnmatchedPageInfo>) {
    const rows = Object.entries(pages)
      .map(
        ([path, page]: [string, UnmatchedPageInfo]) => `
      <tr>
        <td class="path-cell">${this.#escapeHtml(path)}</td>
        <td>${this.#escapeHtml(page.title || '-')}</td>
        <td>${page.status}</td>
        <td>${page.issues}</td>
      </tr>
    `,
      )
      .join('');

    return `
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Title</th>
            <th>Status</th>
            <th>Issues</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * Escape HTML special characters
   */
  #escapeHtml(str: string | null | undefined) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Print summary to console
   */
  #printSummary() {
    const data = this.#comparisonResults!;
    const scores = data.summary.scoreComparison;
    const issues = data.summary.issueComparison;

    console.log('\n' + '='.repeat(60));
    console.log('        SITE COMPARISON SUMMARY');
    console.log('='.repeat(60));
    console.log(`\nOrigin:  ${this.#originUrl}`);
    console.log(`Compare: ${this.#compareUrl}`);

    console.log('\nMATCHING RESULTS');
    console.log('-'.repeat(40));
    console.log(`  Matched Pages:    ${data.summary.matchedPages} (${data.summary.matchPercentage}%)`);
    console.log(`  Origin Only:      ${data.summary.originOnlyPages}`);
    console.log(`  Compare Only:     ${data.summary.compareOnlyPages}`);

    console.log('\nSCORE COMPARISON (Origin → Compare)');
    console.log('-'.repeat(40));
    const formatScore = (name: string, o: number, c: number, d: number) => {
      const sign = d > 0 ? '+' : '';
      return `  ${name.padEnd(15)} ${o} → ${c}  (${sign}${d})`;
    };
    console.log(formatScore('Overall:', scores.origin.overall, scores.compare.overall, scores.delta.overall));
    console.log(formatScore('SEO:', scores.origin.seo, scores.compare.seo, scores.delta.seo));
    console.log(
      formatScore('Performance:', scores.origin.performance, scores.compare.performance, scores.delta.performance),
    );
    console.log(formatScore('Security:', scores.origin.security, scores.compare.security, scores.delta.security));

    console.log('\nISSUE SUMMARY (Origin → Compare)');
    console.log('-'.repeat(40));
    const formatIssue = (name: string, o: number, c: number, d: number) => {
      const sign = d > 0 ? '+' : '';
      return `  ${name.padEnd(12)} ${o} → ${c}  (${sign}${d})`;
    };
    console.log(formatIssue('Critical:', issues.origin.critical, issues.compare.critical, issues.delta.critical));
    console.log(formatIssue('High:', issues.origin.high, issues.compare.high, issues.delta.high));
    console.log(formatIssue('Medium:', issues.origin.medium, issues.compare.medium, issues.delta.medium));
    console.log(formatIssue('Low:', issues.origin.low, issues.compare.low, issues.delta.low));

    console.log('\nREPORTS GENERATED');
    console.log('-'.repeat(40));
    console.log(`  Comparison: ${this.comparisonDir}/comparison.html`);
    console.log(`  Origin:     ${this.#originResults!.htmlPath}`);
    console.log(`  Compare:    ${this.#compareResults!.htmlPath}`);
    console.log('='.repeat(60) + '\n');
  }
}

export { ComparisonAudit };
