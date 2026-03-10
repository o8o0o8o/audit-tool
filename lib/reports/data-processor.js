/**
 * Report Data Processor
 * Handles loading and processing audit data for HTML reports
 */

const fs = require('fs');
const path = require('path');
const { FileManager } = require('../storage/file-manager');
const { HistoryManager } = require('../../historyManager');
const { PageSegmentAnalyzer } = require('../analyzers/site-wide/page-segment-analyzer');

class ReportDataProcessor {
  /**
   * Load audit data from multi-file format or legacy single file
   * @param {string} file - Path to manifest.json.gz or legacy JSON file
   * @param {string} domainName - Domain name
   * @returns {Object} Loaded and merged audit data
   */
  static loadAuditData(file, domainName) {
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
  static #loadMultiFileData(manifestPath, runDir) {
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

    console.log(`  - Loaded manifest (${manifest.files.pageBatches?.length || 0} batches)`);

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
    const batches = manifest.files.pageBatches || [];
    const failedBatches = [];
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
      } catch (error) {
        console.warn(`    ⚠️  Could not load ${batchInfo.file}: ${error.message}`);
        failedBatches.push({
          file: batchInfo.file,
          error: error.message,
          expectedCount: batchInfo.count || 0,
        });
      }
    }

    // Report batch loading summary
    const totalExpectedFromFailed = failedBatches.reduce((sum, b) => sum + b.expectedCount, 0);
    if (failedBatches.length > 0) {
      console.warn(`\n⚠️  WARNING: ${failedBatches.length} batch file(s) could not be loaded`);
      console.warn(`   Approximately ${totalExpectedFromFailed} pages may be missing from the report`);
      failedBatches.forEach(b => console.warn(`   - ${b.file}: ${b.error}`));
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
    } catch {
      // No repo analysis available
    }

    // Reconstruct the data structure expected by report generators
    return {
      robots: metadata.robots,
      sitemaps: metadata.sitemaps,
      isMultiLang: metadata.isMultiLang,
      timing: metadata.timing,
      cruxData: metadata.cruxData || null,
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
  static #loadLegacyData(file, domainName, fileDir) {
    console.log(`Loading audit data from legacy format...`);
    const jsonData = FileManager.readJsonFile(file);

    // Load and merge archived pages if they exist
    if (jsonData.archiveInfo && jsonData.archiveInfo.lastArchivePart) {
      console.log(`Loading ${jsonData.archiveInfo.lastArchivePart} archive file(s)...`);

      for (let i = 1; i <= jsonData.archiveInfo.lastArchivePart; i++) {
        const archiveFile = path.join(fileDir, `SEOAnalysis__${domainName}__archive_part${i}.json`);
        try {
          console.log(`  - Loading archive part ${i}...`);
          const archiveData = FileManager.readJsonFile(archiveFile);

          if (!jsonData.pageData) {
            jsonData.pageData = { pages: {} };
          }
          if (!jsonData.pageData.pages) {
            jsonData.pageData.pages = {};
          }

          jsonData.pageData.pages = {
            ...jsonData.pageData.pages,
            ...archiveData.pages,
          };

          console.log(`    Loaded ${Object.keys(archiveData.pages).length} pages from archive part ${i}`);
        } catch (error) {
          console.warn(`  ⚠️  Could not load archive part ${i}: ${error.message}`);
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
  static loadHistory(domainName) {
    try {
      const historyManager = new HistoryManager(domainName);
      const audits = historyManager.getAllAudits();

      if (!audits || audits.length === 0) {
        return null;
      }

      // Use HistoryManager's generateTrendData which includes issueTrends
      const fullTrendData = historyManager.generateTrendData();

      // Map to expected field names for compatibility
      const trendData = fullTrendData ? {
        labels: fullTrendData.labels,
        scores: fullTrendData.overallScores,
        issues: fullTrendData.totalIssues,
        critical: fullTrendData.criticalIssues,
        high: fullTrendData.highIssues,
        categoryScores: fullTrendData.categoryScores,
        performance: fullTrendData.performance,
        issueTrends: fullTrendData.issueTrends,
      } : null;

      const previousAudit = audits.length >= 2
        ? audits[audits.length - 2]
        : null;

      return { trendData, previousAudit, audits };
    } catch (e) {
      console.log('Could not load history data:', e.message);
      return null;
    }
  }

  /**
   * Calculate statistics for an array of values
   * @param {number[]} values - Array of numeric values
   * @returns {Object} Statistics (avg, median, p75, p95, min, max)
   */
  static calculateStats(values) {
    if (!values || values.length === 0) {
      return { avg: 0, median: 0, p75: 0, p95: 0, min: 0, max: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
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
  static aggregateMetrics(pages) {
    const pagesWithMetrics = pages.filter(p => p.TTFB !== undefined);

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

    const ttfbValues = pagesWithMetrics.map(p => p.TTFB).filter(v => v !== undefined && v !== null);
    const fcpValues = pagesWithMetrics.map(p => p.FCP).filter(v => v !== undefined && v !== null);
    const lcpValues = pagesWithMetrics.map(p => p.LCP).filter(v => v !== undefined && v !== null);
    const clsValues = pagesWithMetrics.map(p => p.CLS).filter(v => v !== undefined && v !== null);
    const pageSizeValues = pagesWithMetrics.map(p => p.totalResponseSize).filter(v => v !== undefined && v !== null);
    const requestCountValues = pagesWithMetrics.map(p => p.totalNumberOfRequests || Object.keys(p.requests || {}).length).filter(v => v !== undefined && v !== null);

    return {
      ttfb: this.calculateStats(ttfbValues),
      fcp: this.calculateStats(fcpValues),
      lcp: this.calculateStats(lcpValues),
      cls: this.calculateStats(clsValues.map(v => Math.round(v * 1000))), // Convert to integer for easier calculation
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
  static countPages(pages) {
    return {
      total: pages.length,
      fromSitemap: pages.filter(p => p.foundIn === 'sitemap').length,
      discovered: pages.filter(p => p.foundIn === 'discovered').length,
      withMetrics: pages.filter(p => p.TTFB !== undefined).length,
      withErrors: pages.filter(p => p.status >= 400).length,
      redirected: pages.filter(p => p.hasRedirects).length,
    };
  }

  /**
   * Get top issues sorted by count
   * @param {Object} analysisDetails - Analysis details object
   * @param {number} limit - Maximum number of issues to return
   * @returns {Array} Sorted array of issues
   */
  static getTopIssues(analysisDetails, limit = 10) {
    if (!analysisDetails) return [];

    return Object.entries(analysisDetails)
      .map(([issue, data]) => ({
        issue,
        severity: data.severity,
        count: data.count || data.examples?.length || 0,
        examples: data.examples || [],
      }))
      .sort((a, b) => {
        // Sort by severity first, then by count
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const severityDiff = (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4);
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
  static prepareReportData(file, domainName) {
    const jsonData = this.loadAuditData(file, domainName);
    const historyData = this.loadHistory(domainName);

    const pageData = jsonData.pageData || { pages: {}, totalWithoutError: 0, totalWithError: 0 };
    const pages = Object.values(pageData.pages || {});
    const timing = jsonData.timing || {};
    const analysis = jsonData.analysis || {};

    // Assign segments to pages if not already set (handles multi-file format)
    this.#assignSegments(pageData.pages || {});

    return {
      jsonData,
      pageData,
      pages,
      timing,
      analysis,
      metrics: this.aggregateMetrics(pages),
      pageCounts: this.countPages(pages),
      topIssues: this.getTopIssues(analysis.details),
      trendData: historyData?.trendData || null,
      previousAudit: historyData?.previousAudit || null,
      sitemaps: jsonData.sitemaps || {},
      robots: jsonData.robots || {},
      isMultiLang: jsonData.isMultiLang || false,
    };
  }

  /**
   * Assign URL segments to pages if not already set
   * @private
   */
  static #assignSegments(pages) {
    for (const url in pages) {
      if (!pages[url].segment) {
        pages[url].segment = PageSegmentAnalyzer.classifyUrl(url);
      }
    }
  }
}

module.exports = { ReportDataProcessor };
