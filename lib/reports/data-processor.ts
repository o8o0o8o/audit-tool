/**
 * Report Data Processor
 * Handles loading and processing audit data for HTML reports
 */

import * as fs from 'fs';
import * as path from 'path';
import { FileManager } from '../storage/file-manager';
import { HistoryManager } from '../../historyManager';
import { PageSegmentAnalyzer } from '../analyzers/site-wide/page-segment-analyzer';
import { PageMatcher } from '../comparison/page-matcher';
import type { PageInfo, PageData, AnalysisDetail, FailedBatch, ComparisonData } from '../types';

class ReportDataProcessor {
  /**
   * Load audit data from multi-file format or legacy single file
   * @param {string} file - Path to manifest.json.gz or legacy JSON file
   * @param {string} domainName - Domain name
   * @returns {Object} Loaded and merged audit data
   */
  static loadAuditData(file: string, domainName: string) {
    const fileDir = path.dirname(file);
    const fileName = path.basename(file);

    // Check if this is a manifest file (multi-file format)
    if (fileName === 'manifest.json.gz' || fileName === 'manifest.json') {
      return this.#loadMultiFileData(file, fileDir);
    }

    // Fallback: treat as legacy single-file format
    return this.#loadLegacyData(file, domainName, fileDir);
  }

  /**
   * Load data from multi-file format
   * @private
   */
  static #loadMultiFileData(manifestPath: string, runDir: string) {
    console.log(`Loading audit data from multi-file format...`);

    // Load manifest
    const manifest = FileManager.readJsonFile(manifestPath);

    // Validate manifest structure
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid manifest: file is empty or not a valid JSON object');
    }
    if (!manifest.files) {
      throw new Error('Invalid manifest: missing "files" section');
    }
    if (!manifest.progress) {
      throw new Error('Invalid manifest: missing "progress" section');
    }
    if (typeof manifest.files.metadata !== 'string') {
      throw new Error('Invalid manifest: missing or invalid "files.metadata" path');
    }
    if (typeof manifest.files.analysis !== 'string') {
      throw new Error('Invalid manifest: missing or invalid "files.analysis" path');
    }

    console.log(`  - Loaded manifest (${manifest.files.pageBatches?.length ?? 0} batches)`);

    // Load metadata
    const metadataPath = path.join(runDir, manifest.files.metadata);
    const metadata = FileManager.readJsonFile(metadataPath);
    console.log(`  - Loaded metadata`);

    // Load analysis
    const analysisPath = path.join(runDir, manifest.files.analysis);
    const analysis = FileManager.readJsonFile(analysisPath);
    console.log(`  - Loaded analysis`);

    // Load incoming links
    let incomingLinks = {};
    try {
      const linksPath = path.join(runDir, manifest.files.incomingLinks);
      incomingLinks = FileManager.readJsonFile(linksPath);
      console.log(`  - Loaded incoming links`);
    } catch {
      console.log(`  - No incoming links file`);
    }

    // Load all page batches
    const pages = {};
    const batches = manifest.files.pageBatches ?? [];
    const failedBatches: FailedBatch[] = [];
    let loadedBatchCount = 0;

    console.log(`  - Loading ${batches.length} page batches...`);

    for (const batchInfo of batches) {
      try {
        const batchPath = path.join(runDir, batchInfo.file);
        const batchData = FileManager.readJsonFile(batchPath);

        // Validate batch structure
        if (!batchData || typeof batchData !== 'object') {
          throw new Error('Batch file is empty or invalid');
        }
        if (!batchData.pages || typeof batchData.pages !== 'object') {
          throw new Error('Batch file missing "pages" object');
        }

        Object.assign(pages, batchData.pages);
        loadedBatchCount++;
      } catch (error: unknown) {
        const errMsg = (error as Error).message;
        console.warn(`    ⚠️  Could not load ${batchInfo.file}: ${errMsg}`);
        failedBatches.push({
          file: batchInfo.file,
          error: errMsg,
          expectedCount: batchInfo.count ?? 0,
        });
      }
    }

    // Report batch loading summary
    const totalExpectedFromFailed = failedBatches.reduce((sum: number, b: FailedBatch) => sum + b.expectedCount, 0);
    if (failedBatches.length > 0) {
      console.warn(`\n⚠️  WARNING: ${failedBatches.length} batch file(s) could not be loaded`);
      console.warn(`   Approximately ${totalExpectedFromFailed} pages may be missing from the report`);
      failedBatches.forEach((b: FailedBatch) => console.warn(`   - ${b.file}: ${b.error}`));
      console.warn('');
    }

    console.log(`✓ Loaded ${Object.keys(pages).length} pages from ${loadedBatchCount}/${batches.length} batches\n`);

    // Load repo analysis if available
    let repoAnalysis = null;
    try {
      const repoPath = path.join(runDir, 'repo-analysis.json.gz');
      if (fs.existsSync(repoPath)) {
        repoAnalysis = FileManager.readJsonFile(repoPath);
        console.log(`  - Loaded repo analysis`);
      }
    } catch (e: unknown) {
      console.debug('Could not load repo analysis:', (e as Error).message);
    }

    // Reconstruct the data structure expected by report generators
    return {
      robots: metadata.robots,
      sitemaps: metadata.sitemaps,
      isMultiLang: metadata.isMultiLang,
      timing: metadata.timing,
      cruxData: metadata.cruxData ?? null,
      repoAnalysis,
      pageData: {
        pages,
        processedPages: manifest.progress.processedPages,
        totalWithoutError: manifest.progress.totalWithoutError,
        totalWithError: manifest.progress.totalWithError,
        byError: manifest.progress.byError,
        incomingLinks,
      },
      analysis: {
        overall: analysis.overall,
        details: analysis.details,
        bySeverity: analysis.bySeverity,
        summary: analysis.summary,
      },
    };
  }

  /**
   * Load data from legacy single-file format
   * @private
   */
  static #loadLegacyData(file: string, domainName: string, fileDir: string) {
    console.log(`Loading audit data from legacy format...`);
    const jsonData = FileManager.readJsonFile(file);

    // Load and merge archived pages if they exist
    if (jsonData.archiveInfo?.lastArchivePart) {
      console.log(`Loading ${jsonData.archiveInfo.lastArchivePart} archive file(s)...`);

      for (let i = 1; i <= jsonData.archiveInfo.lastArchivePart; i++) {
        const archiveFile = path.join(fileDir, `SEOAnalysis__${domainName}__archive_part${i}.json`);
        try {
          console.log(`  - Loading archive part ${i}...`);
          const archiveData = FileManager.readJsonFile(archiveFile);

          jsonData.pageData ??= { pages: {} };
          jsonData.pageData.pages ??= {};

          jsonData.pageData.pages = {
            ...jsonData.pageData.pages,
            ...archiveData.pages,
          };

          console.log(`    Loaded ${Object.keys(archiveData.pages).length} pages from archive part ${i}`);
        } catch (error: unknown) {
          console.warn(`  ⚠️  Could not load archive part ${i}: ${(error as Error).message}`);
        }
      }

      console.log(`✓ All archived pages loaded. Total pages: ${Object.keys(jsonData.pageData.pages).length}\n`);
    }

    return jsonData;
  }

  /**
   * Load audit history for trend data
   * @param {string} domainName - Domain name
   * @returns {Object|null} History data with trendData and previousAudit, or null
   */
  static loadHistory(domainName: string) {
    try {
      const historyManager = new HistoryManager(domainName);
      const audits = historyManager.getAllAudits();

      if (!audits || audits.length === 0) {
        return null;
      }

      // Use HistoryManager's generateTrendData which includes issueTrends
      const fullTrendData = historyManager.generateTrendData();

      // Map to expected field names for compatibility
      const trendData = fullTrendData
        ? {
            labels: fullTrendData.labels,
            scores: fullTrendData.overallScores,
            issues: fullTrendData.totalIssues,
            critical: fullTrendData.criticalIssues,
            high: fullTrendData.highIssues,
            categoryScores: fullTrendData.categoryScores,
            performance: fullTrendData.performance,
            issueTrends: fullTrendData.issueTrends,
          }
        : null;

      const previousAudit = audits.length >= 2 ? audits[audits.length - 2] : null;

      return { trendData, previousAudit, audits };
    } catch (e: unknown) {
      console.log('Could not load history data:', (e as Error).message);
      return null;
    }
  }

  /**
   * Calculate statistics for an array of values
   * @param {number[]} values - Array of numeric values
   * @returns {Object} Statistics (avg, median, p75, p95, min, max)
   */
  static calculateStats(values: number[]) {
    if (!values || values.length === 0) {
      return { avg: 0, median: 0, p75: 0, p95: 0, min: 0, max: 0 };
    }

    const sorted = [...values].sort((a: number, b: number) => a - b);
    const sum = sorted.reduce((acc: number, val: number) => acc + val, 0);
    const len = sorted.length;

    return {
      avg: Math.round(sum / len),
      median: sorted[Math.floor(len / 2)],
      p75: sorted[Math.floor(len * 0.75)],
      p95: sorted[Math.floor(len * 0.95)],
      min: sorted[0],
      max: sorted[len - 1],
    };
  }

  /**
   * Aggregate metrics across all pages
   * @param {Object[]} pages - Array of page data objects
   * @returns {Object} Aggregated metrics
   */
  static aggregateMetrics(pages: PageInfo[]) {
    const pagesWithMetrics = pages.filter((p: PageInfo) => p.TTFB !== undefined);

    if (pagesWithMetrics.length === 0) {
      return {
        ttfb: { avg: 0, median: 0, p75: 0, p95: 0 },
        fcp: { avg: 0, median: 0, p75: 0, p95: 0 },
        lcp: { avg: 0, median: 0, p75: 0, p95: 0 },
        cls: { avg: 0, median: 0, p75: 0, p95: 0 },
        pageSize: { avg: 0, median: 0, p75: 0, p95: 0 },
        requestCount: { avg: 0, median: 0, p75: 0, p95: 0 },
        pagesWithMetrics: 0,
      };
    }

    const ttfbValues = pagesWithMetrics
      .map((p: PageInfo) => p.TTFB)
      .filter((v): v is number => v !== undefined && v !== null);
    const fcpValues = pagesWithMetrics
      .map((p: PageInfo) => p.FCP)
      .filter((v): v is number => v !== undefined && v !== null);
    const lcpValues = pagesWithMetrics
      .map((p: PageInfo) => p.LCP)
      .filter((v): v is number => v !== undefined && v !== null);
    const clsValues = pagesWithMetrics
      .map((p: PageInfo) => p.CLS)
      .filter((v): v is number => v !== undefined && v !== null);
    const pageSizeValues = pagesWithMetrics
      .map((p: PageInfo) => p.totalResponseSize as number | undefined)
      .filter((v): v is number => v !== undefined && v !== null);
    const requestCountValues = pagesWithMetrics
      .map(
        (p: PageInfo) =>
          (p.totalNumberOfRequests as number) || Object.keys((p.requests as Record<string, unknown>) || {}).length,
      )
      .filter((v): v is number => v !== undefined && v !== null);

    return {
      ttfb: this.calculateStats(ttfbValues),
      fcp: this.calculateStats(fcpValues),
      lcp: this.calculateStats(lcpValues),
      cls: this.calculateStats(clsValues.map((v: number) => Math.round(v * 1000))), // Convert to integer for easier calculation
      pageSize: this.calculateStats(pageSizeValues),
      requestCount: this.calculateStats(requestCountValues),
      pagesWithMetrics: pagesWithMetrics.length,
    };
  }

  /**
   * Count pages by various criteria
   * @param {Object[]} pages - Array of page data objects
   * @returns {Object} Page counts
   */
  static countPages(pages: PageInfo[]) {
    return {
      total: pages.length,
      fromSitemap: pages.filter((p: PageInfo) => p.foundIn === 'sitemap').length,
      discovered: pages.filter((p: PageInfo) => p.foundIn === 'discovered').length,
      withMetrics: pages.filter((p: PageInfo) => p.TTFB !== undefined).length,
      withErrors: pages.filter((p: PageInfo) => (p.status as number) >= 400).length,
      redirected: pages.filter((p: PageInfo) => p.hasRedirects).length,
    };
  }

  /**
   * Get top issues sorted by count
   * @param {Object} analysisDetails - Analysis details object
   * @param {number} limit - Maximum number of issues to return
   * @returns {Array} Sorted array of issues
   */
  static getTopIssues(analysisDetails: Record<string, AnalysisDetail> | undefined, limit: number = 10) {
    if (!analysisDetails) return [];

    return Object.entries(analysisDetails)
      .map(([issue, data]: [string, AnalysisDetail]) => ({
        issue,
        severity: data.severity,
        count: data.count ?? data.examples?.length ?? 0,
        examples: data.examples ?? [],
      }))
      .sort((a, b) => {
        // Sort by severity first, then by count
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const severityDiff = (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
        if (severityDiff !== 0) return severityDiff;
        return b.count - a.count;
      })
      .slice(0, limit);
  }

  /**
   * Prepare data for HTML report generation
   * @param {string} file - Path to audit JSON file
   * @param {string} domainName - Domain name
   * @returns {Object} Prepared report data
   */
  static prepareReportData(file: string, domainName: string) {
    const jsonData = this.loadAuditData(file, domainName);
    const historyData = this.loadHistory(domainName);

    const pageData = (jsonData.pageData ?? { pages: {}, totalWithoutError: 0, totalWithError: 0 }) as PageData & {
      incomingLinks?: Record<string, string[]>;
    };
    const pages: PageInfo[] = Object.values(pageData.pages ?? {});
    const timing = (jsonData.timing ?? {}) as Record<string, unknown>;
    const analysis = (jsonData.analysis ?? {}) as Record<string, unknown>;

    // Assign segments to pages if not already set (handles multi-file format)
    this.#assignSegments(pageData.pages ?? {});

    return {
      jsonData,
      pageData,
      pages,
      timing,
      analysis,
      metrics: this.aggregateMetrics(pages),
      pageCounts: this.countPages(pages),
      topIssues: this.getTopIssues(analysis.details as Record<string, AnalysisDetail> | undefined),
      trendData: historyData?.trendData ?? null,
      previousAudit: historyData?.previousAudit ?? null,
      sitemaps: jsonData.sitemaps ?? {},
      robots: jsonData.robots ?? {},
      isMultiLang: jsonData.isMultiLang ?? false,
    };
  }

  /**
   * Prepare data for comparison HTML report (two origins side by side)
   * @param originFile - Path to origin audit JSON file
   * @param compareFile - Path to compare audit JSON file
   * @param originDomain - Origin domain name
   * @param compareDomain - Compare domain name
   * @returns Prepared report data with comparison field populated
   */
  static prepareComparisonReportData(
    originFile: string,
    compareFile: string,
    originDomain: string,
    compareDomain: string,
  ) {
    // Load origin data as the primary report data
    const baseData = this.prepareReportData(originFile, originDomain);

    // Load compare data
    const compareJsonData = this.loadAuditData(compareFile, compareDomain);
    const comparePageData = (compareJsonData.pageData ?? {
      pages: {},
      totalWithoutError: 0,
      totalWithError: 0,
    }) as PageData & {
      incomingLinks?: Record<string, string[]>;
    };
    const comparePages: PageInfo[] = Object.values(comparePageData.pages ?? {});

    // Assign segments to compare pages
    this.#assignSegments(comparePageData.pages ?? {});

    // Match pages by URL path
    const originPagesMap = (baseData.pageData.pages ?? {}) as Record<string, PageInfo>;
    const comparePagesMap = (comparePageData.pages ?? {}) as Record<string, PageInfo>;
    const matchResult = PageMatcher.matchPages(originPagesMap, comparePagesMap);

    const comparison: ComparisonData = {
      compareJsonData,
      comparePages,
      comparePageData,
      compareDomainName: compareDomain,
      originDomainName: originDomain,
      matchedPaths: matchResult.matched.map((m) => ({
        path: m.path,
        originUrl: m.originUrl,
        compareUrl: m.compareUrl,
      })),
      originOnlyPaths: matchResult.originOnly.map((m) => m.path),
      compareOnlyPaths: matchResult.compareOnly.map((m) => m.path),
    };

    return {
      ...baseData,
      comparison,
    };
  }

  /**
   * Assign URL segments to pages if not already set
   * @private
   */
  static #assignSegments(pages: Record<string, PageInfo>) {
    for (const url in pages) {
      pages[url].segment ??= PageSegmentAnalyzer.classifyUrl(url);
    }
  }
}

/**
 * Extract analysis object from jsonData.
 * Avoids repeating `(jsonData.analysis ?? {}) as Record<string, unknown>` across report sections.
 */
function extractAnalysis(jsonData: Record<string, unknown>): Record<string, unknown> {
  return (jsonData.analysis ?? {}) as Record<string, unknown>;
}

/**
 * Extract analysis details map from audit data.
 */
function extractDetails(jsonData: Record<string, unknown>): Record<string, AnalysisDetail> {
  const analysisObj = extractAnalysis(jsonData);
  return (analysisObj.details ?? {}) as Record<string, AnalysisDetail>;
}

/**
 * Extract issues grouped by severity from audit data.
 */
function extractBySeverity(jsonData: Record<string, unknown>): Record<string, string[]> {
  const analysisObj = extractAnalysis(jsonData);
  return (analysisObj.bySeverity ?? {}) as Record<string, string[]>;
}

/**
 * Extract summary object from jsonData.analysis.summary.
 */
function extractSummary(jsonData: Record<string, unknown>): Record<string, unknown> {
  const analysis = extractAnalysis(jsonData);
  return (analysis.summary ?? {}) as Record<string, unknown>;
}

/**
 * Extract insight metrics from an array of pages.
 * Shared between executive-summary (report) and historyManager (snapshots).
 */
function extractPageInsights(pages: PageInfo[]) {
  const langMismatches = pages.filter((p) => p.languageDetection?.match === false).length;
  const brokenOutbound = pages.reduce((s, p) => s + (p.outboundLinkHealth?.broken?.length ?? 0), 0);
  const similarPages = pages.filter(
    (p) => ((p.contentSimilarity?.similarPages as unknown[] | undefined)?.length ?? 0) > 0,
  ).length;
  const noCta = pages.filter((p) => p.ctaData?.summary?.total === 0).length;

  const coveragePages = pages.filter((p) => p.codeCoverage?.js?.ratio != null);
  const avgJsUnused =
    coveragePages.length > 0
      ? +(coveragePages.reduce((s, p) => s + (p.codeCoverage?.js?.ratio ?? 0), 0) / coveragePages.length).toFixed(1)
      : null;
  const avgCssUnused =
    coveragePages.length > 0 && coveragePages.some((p) => p.codeCoverage?.css?.ratio != null)
      ? +(
          coveragePages
            .filter((p) => p.codeCoverage?.css?.ratio != null)
            .reduce((s, p) => s + (p.codeCoverage?.css?.ratio ?? 0), 0) /
          coveragePages.filter((p) => p.codeCoverage?.css?.ratio != null).length
        ).toFixed(1)
      : null;

  return {
    languageMismatches: langMismatches,
    brokenOutboundLinks: brokenOutbound,
    nearDuplicatePages: similarPages,
    pagesWithoutCTAs: noCta,
    avgJsUnused,
    avgCssUnused,
  };
}

export { ReportDataProcessor, extractAnalysis, extractDetails, extractBySeverity, extractSummary, extractPageInsights };
