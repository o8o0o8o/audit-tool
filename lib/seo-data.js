/**
 * SEOData Class
 * Core audit orchestration class - extracted to avoid circular dependencies
 */

const fs = require("fs");
const path = require("path");

// Import modularized components
const { SEVERITY, THRESHOLDS, NETWORK_CONDITIONS, CPU_CONDITIONS } = require("./constants");
const { validateUrl, formatElapsedTime } = require("./utils");
const { sanitizeDomainName } = require("../validators");
const { FileManager } = require("./storage/file-manager");
const { ScoreCalculator } = require("./scoring/score-calculator");
const { ErrorAggregator } = require("./utils/error-aggregator");
const { ProgressManager } = require("./orchestrators/progress-manager");
const { AuditOrchestrator } = require("./orchestrators/audit-orchestrator");
const { CrawlerEngine } = require("./crawler/crawler-engine");
const { RobotsParser } = require("./parsers/robots-parser");
const { SitemapParser } = require("./parsers/sitemap-parser");


class SEOData {
  #results;
  #proceed;
  #perf;
  #saveHtml;
  #concurrency;
  #sitemapFile; // Path to local sitemap XML file
  #incomingLinksTracking; // Map to track unique source->target links during processing
  #errorAggregator;
  #progressManager;
  #crawlerEngine;

  constructor(origin, proceed = false, perf = false, saveHtml = false, concurrency = 5, sitemapFile = null) {
    this.#sitemapFile = sitemapFile;

    // When sitemap file is provided, origin may be null (derived later)
    let validatedUrl;
    if (origin) {
      validatedUrl = validateUrl(origin);
    }

    // Store flags as booleans
    this.#proceed = proceed;
    this.#perf = perf;
    this.#saveHtml = saveHtml;
    this.#concurrency = concurrency;

    // Initialize incoming links tracking (Map<target, Set<source>>)
    this.#incomingLinksTracking = new Map();

    if (validatedUrl) {
      this.origin = validatedUrl.replace(/\s/g, "").replace(/\/$/, "");
    } else {
      // Origin will be derived from sitemap URLs in #parseSitemapFile()
      this.origin = null;
    }
    // Use centralized domain sanitization for consistent naming
    this.domainName = this.origin ? sanitizeDomainName(this.origin) : null;

    this.#errorAggregator = new ErrorAggregator();

    this.#results = {
      robots: { sitemaps: [], "user-agent": {} },
      sitemaps: { urls: {}, total: 0 },
      isMultiLang: false,
      pageData: {
        pages: {},
        processedPages: new Set(),
        totalWithoutError: 0,
        totalWithError: 0,
        byError: {},
        attempts: {},
        incomingLinks: {}, // Track incoming links count: { targetUrl: count }
      },
      analysis: this.#errorAggregator.getRawData(),
      timing: {
        startTime: null,
        endTime: null,
        elapsedTime: null, // in milliseconds
        elapsedTimeFormatted: null, // human readable format
      },
    };

    // Use imported network and CPU conditions from constants
    this.networkConditions = NETWORK_CONDITIONS;
    this.cpuConditions = CPU_CONDITIONS;

    // Defer full initialization when origin is not yet known (sitemap file mode)
    if (this.origin) {
      this.#initializeManagers();
    }
  }

  /**
   * Initialize FileManager, ProgressManager, and CrawlerEngine.
   * Called from constructor when origin is known, or after deriving origin from sitemap file.
   */
  #initializeManagers() {
    // Initialize FileManager
    // If proceeding, find and use the latest run's timestamp
    let timestamp = null;
    if (this.#proceed) {
      const latestRun = FileManager.findLatestRun(this.domainName);
      if (latestRun) {
        // Extract timestamp from path
        timestamp = path.basename(latestRun);

        // Check if manifest exists (multi-file format)
        const manifestPath = path.join(latestRun, 'manifest.json.gz');
        if (fs.existsSync(manifestPath)) {
          console.log(`📂 Resuming from previous run: ${timestamp}`);
        } else {
          console.log(`⚠️  No manifest found in ${timestamp}, starting fresh`);
          timestamp = null;
          this.#proceed = false;
        }
      } else {
        console.log(`⚠️  No previous run found for ${this.domainName}, starting fresh`);
        this.#proceed = false;
      }
    }

    this.fileManager = new FileManager(this.domainName, 'audit-results', timestamp);
    this.resultsDir = this.fileManager.resultsDir;
    this.file = this.fileManager.manifestFile; // Use manifest for multi-file format

    // Initialize progress manager
    this.#progressManager = new ProgressManager(this.fileManager);

    // Initialize crawler engine with callbacks for state management
    this.#crawlerEngine = new CrawlerEngine(
      {
        concurrency: this.#concurrency,
        saveHtml: this.#saveHtml,
        perf: this.#perf,
        origin: this.origin,
        networkConditions: this.networkConditions,
        cpuConditions: this.cpuConditions,
      },
      {
        saveError: this.saveError.bind(this),
        saveData: this.saveData.bind(this),
        checkAttempts: this.#checkAttempts.bind(this),
        saveAttempt: this.#saveAttempt.bind(this),
      }
    );
  }

  // Getter for results data (used by history manager and other external consumers)
  get data() {
    return this.#results;
  }

  saveError(generalError, detailedError, severity = SEVERITY.MEDIUM) {
    this.#errorAggregator.addError(generalError, detailedError, severity);
  }

  #checkAttempts(url) {
    if (this.#results.pageData.attempts[url] >= THRESHOLDS.RETRY_ATTEMPTS) {
      this.#results.pageData.processedPages.add(url);
    }
  }

  #saveAttempt(url) {
    if (!this.#results.pageData.attempts[url]) {
      this.#results.pageData.attempts[url] = 0;
    }

    this.#results.pageData.attempts[url] += 1;
  }

  /**
   * Calculate and finalize summary statistics using ScoreCalculator
   */
  #calculateSummary() {
    // Use ScoreCalculator module to calculate summary
    const summary = ScoreCalculator.calculateSummary(
      this.#results.analysis,
      this.#results.pageData,
      this.#results.pageData.pages
    );

    this.#results.analysis.summary = summary;

    // Log summary for debugging
    console.log('\n=== Audit Summary ===');
    console.log(`Total Issues: ${summary.totalIssues}`);
    console.log(`  Critical: ${summary.criticalCount}`);
    console.log(`  High: ${summary.highCount}`);
    console.log(`  Medium: ${summary.mediumCount}`);
    console.log(`  Low: ${summary.lowCount}`);
    console.log(`Overall SEO Score: ${summary.overallScore}/100`);
    console.log('====================\n');
  }

  /**
   * Start timing the audit
   */
  #startTiming() {
    this.#results.timing.startTime = new Date().toISOString();
    console.log(`Audit started at: ${this.#results.timing.startTime}`);
  }

  /**
   * Stop timing the audit and calculate elapsed time
   */
  #stopTiming() {
    this.#results.timing.endTime = new Date().toISOString();
    const startMs = new Date(this.#results.timing.startTime).getTime();
    const endMs = new Date(this.#results.timing.endTime).getTime();
    this.#results.timing.elapsedTime = endMs - startMs;
    this.#results.timing.elapsedTimeFormatted = formatElapsedTime(this.#results.timing.elapsedTime);

    console.log(`\nAudit completed at: ${this.#results.timing.endTime}`);
    console.log(`Total elapsed time: ${this.#results.timing.elapsedTimeFormatted}`);
  }

  async #restoreProgress() {
    try {
      const restored = await this.#progressManager.loadProgress(
        this.domainName,
        this.resultsDir
      );

      // Update instance state from restored data
      this.#results = restored.results;

      // Ensure processedPages is always a Set (defensive check)
      if (!(this.#results.pageData.processedPages instanceof Set)) {
        console.log(`  ⚠️  Converting processedPages to Set (was ${typeof this.#results.pageData.processedPages})`);
        this.#results.pageData.processedPages = new Set(
          Array.isArray(this.#results.pageData.processedPages)
            ? this.#results.pageData.processedPages
            : []
        );
      }

      this.#errorAggregator = restored.errorAggregator;
      this.#incomingLinksTracking = restored.incomingLinksTracking;
    } catch (error) {
      console.error(`\n❌ ERROR restoring progress:`, error.message);
      console.error(`File: ${this.file}`);

      if (error.message.includes('JSON') || error.message.includes('parse')) {
        console.error(`\nThe progress file appears to be corrupted.`);
        console.error(`Consider removing it and starting fresh:\n`);
        console.error(`  mv "${this.file}" "${this.file}.backup"`);
        console.error(`  node start.js --origin=... --perf\n`);
      }

      throw error;
    }
  }

  saveData() {
    this.#progressManager.saveProgress(this.#results);
  }

  async #analyzeRobotsTxt() {
    // Use RobotsParser module to parse robots.txt
    const result = await RobotsParser.parseRobotsTxt(this.origin);

    // Update results with parsed data
    this.#results.robots.sitemaps = result.sitemaps;
    this.#results.robots["user-agent"] = result.userAgents;

    // Register any errors found during parsing
    result.errors.forEach(error => {
      this.saveError(error.message, error.detail, error.severity);
    });
  }


  /**
   * Parse a local sitemap XML file and derive origin from its URLs
   */
  #parseSitemapFile() {
    console.log(`📄 Parsing local sitemap file: ${this.#sitemapFile}`);

    const xml = fs.readFileSync(this.#sitemapFile, 'utf-8');
    const { parse } = require('node-html-parser');
    const parsed = parse(xml);
    const urls = parsed.querySelectorAll('url');

    if (!urls.length) {
      throw new Error(`No <url> entries found in sitemap file: ${this.#sitemapFile}`);
    }

    // Derive origin from the first URL in the sitemap
    const firstLoc = urls[0].querySelector('loc')?.innerText?.trim();
    if (!firstLoc) {
      throw new Error('First <url> entry in sitemap has no <loc> element');
    }

    const parsedUrl = new URL(firstLoc);
    this.origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    this.domainName = sanitizeDomainName(this.origin);

    console.log(`🌐 Derived origin: ${this.origin}`);

    // Now that we have origin, initialize managers
    this.#initializeManagers();

    // Use SitemapParser.processSitemap to parse URLs with full validation
    const result = {
      sitemaps: {},
      urls: {},
      total: 0,
      errors: [],
    };

    SitemapParser.processSitemap(urls, this.origin, this.#sitemapFile, result);

    // Store sitemap data
    Object.assign(this.#results.sitemaps, result.sitemaps);
    this.#results.sitemaps.urls = result.urls;
    this.#results.sitemaps.total = result.total;

    // Register any errors
    result.errors.forEach(error => {
      this.saveError(error.message, error.detail, error.severity);
    });

    console.log(`✅ Parsed ${result.total} URLs from sitemap file`);
  }

  async #analyzeSitemaps() {
    // Use SitemapParser module
    const result = await SitemapParser.parseSitemaps(
      this.origin,
      this.#results.robots.sitemaps
    );

    // Store sitemap data
    Object.assign(this.#results.sitemaps, result.sitemaps);
    this.#results.sitemaps.urls = result.urls;
    this.#results.sitemaps.total = result.total;

    // Register all errors
    result.errors.forEach(error => {
      this.saveError(error.message, error.detail, error.severity);
    });
  }

  async #analyzePages() {
    await AuditOrchestrator.analyzePages({
      results: this.#results,
      crawlerEngine: this.#crawlerEngine,
      incomingLinksTracking: this.#incomingLinksTracking,
      saveError: this.saveError.bind(this),
      resultsDir: this.resultsDir,
    });
  }

  async audit() {
    try {
      if (this.#sitemapFile && !this.origin) {
        // Sitemap file mode: parse local file to derive origin and init managers
        this.#parseSitemapFile();
      }

      if (this.#proceed) {
        console.log("Proceeding...");

        await this.#restoreProgress();

        // Keep the original start time from previous run
        if (!this.#results.timing.startTime) {
          this.#startTiming();
        } else {
          console.log(`Resuming audit started at: ${this.#results.timing.startTime}`);
        }

        await this.#analyzePages();
      } else if (this.#sitemapFile) {
        // Sitemap file mode: already parsed above, just crawl pages
        this.#startTiming();

        await this.#analyzePages();
      } else {
        // Standard mode: robots.txt → sitemaps → pages
        this.#startTiming();

        await this.#analyzeRobotsTxt();

        await this.#analyzeSitemaps();

        await this.#analyzePages();
      }
    } catch (error) {
      // Save error with full details including stack trace
      const errorMessage = error.message || String(error);
      const errorDetail = error.stack || errorMessage;
      this.saveError(`Audit failed: ${errorMessage}`, errorDetail, SEVERITY.HIGH);

      // Stop timing before exit
      this.#stopTiming();

      // Calculate summary even on error
      this.#calculateSummary();

      // Save data before exiting
      this.saveData();

      console.error('Audit failed with error:', error.message);
      // Re-throw to let the error propagate and trigger restart via start.js
      throw error;
    }

    // Run all site-wide validations
    AuditOrchestrator.runSiteWideValidation(
      this.#results.pageData,
      this.origin,
      this.#results.isMultiLang,
      this.saveError.bind(this)
    );

    // Stop timing
    this.#stopTiming();

    // Calculate final summary statistics
    this.#calculateSummary();

    this.saveData();
  }
}

module.exports = { SEOData };
