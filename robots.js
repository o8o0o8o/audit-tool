const fs = require("fs");
const path = require("path");
const { generateHTML } = require("./generateHTML");

// Import modularized components
const { parseArgs } = require("./lib/args-parser");
const { SEVERITY, THRESHOLDS, NETWORK_CONDITIONS, CPU_CONDITIONS } = require("./lib/constants");
const { validateUrl, formatElapsedTime } = require("./lib/utils");
const { FileManager } = require("./lib/storage/file-manager");
const { ScoreCalculator } = require("./lib/scoring/score-calculator");
const { ErrorAggregator } = require("./lib/utils/error-aggregator");
const { printAuditSummary } = require("./lib/utils/cli-summary");
const { loadConfig, generateSampleConfig } = require("./lib/config-loader");
const { ProgressManager } = require("./lib/orchestrators/progress-manager");
const { AuditOrchestrator } = require("./lib/orchestrators/audit-orchestrator");
const { CrawlerEngine } = require("./lib/crawler/crawler-engine");
const { RobotsParser } = require("./lib/parsers/robots-parser");
const { SitemapParser } = require("./lib/parsers/sitemap-parser");


class SEOData {
  #results;
  #proceed;
  #perf;
  #saveHtml;
  #concurrency;
  #incomingLinksTracking; // Map to track unique source->target links during processing
  #errorAggregator;
  #progressManager;
  #crawlerEngine;

  constructor(origin, proceed = false, perf = false, saveHtml = false, concurrency = 5) {
    // Validate URL first
    const validatedUrl = validateUrl(origin);

    // Store flags as booleans
    this.#proceed = proceed;
    this.#perf = perf;
    this.#saveHtml = saveHtml;
    this.#concurrency = concurrency;

    // Initialize incoming links tracking (Map<target, Set<source>>)
    this.#incomingLinksTracking = new Map();

    this.origin = validatedUrl.replace(/\s/g, "").replace(/\/$/, "");
    this.domainName = this.origin.replace(/^https?:\/\//, "");

    // Initialize FileManager
    // If proceeding, find and use the latest run's timestamp
    let timestamp = null;
    if (proceed) {
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

    // Initialize progress manager and error aggregator
    this.#progressManager = new ProgressManager(this.fileManager);
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
      } else {
        // Start timing for new audit
        this.#startTiming();

        await this.#analyzeRobotsTxt();

        await this.#analyzeSitemaps();

        await this.#analyzePages();
      }
    } catch (error) {
      this.saveError(error, null, SEVERITY.HIGH);

      // Stop timing before exit
      this.#stopTiming();

      // Calculate summary even on error
      this.#calculateSummary();

      // Save data before exiting
      this.saveData();

      console.error('Audit failed with error:', error.message);
      process.exit(1); // Exit with error code to trigger automatic restart
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

async function audit() {
  try {
    const { validateArguments, validateURL } = require('./validators');

    // Parse command-line arguments
    const args = parseArgs(process.argv.slice(2));

    // Handle --init-config: generate sample config and exit
    if (args.initConfig) {
      const configPath = '.seoauditrc';
      if (fs.existsSync(configPath)) {
        console.error(`❌ Config file already exists: ${configPath}`);
        process.exit(1);
      }
      fs.writeFileSync(configPath, generateSampleConfig());
      console.log(`✅ Created sample config: ${configPath}`);
      console.log('Edit this file to customize thresholds and settings.');
      process.exit(0);
    }

    // Validate arguments
    const validation = validateArguments(args);
    if (!validation.valid) {
      console.error("");
      console.error(`❌ ${validation.error}`);
      console.error("");
      console.error("Usage: node robots.js --origin=<website-url> [OPTIONS]");
      console.error("");
      console.error("Options:");
      console.error("  --origin=<url>          Website URL to audit (required)");
      console.error("  --proceed               Resume from saved progress");
      console.error("  --perf                  Enable performance metrics collection");
      console.error("  --save-html             Save HTML snapshots of pages");
      console.error("  --concurrency=<number>  Parallel pages (1-20, default: 5)");
      console.error("  --config=<path>         Path to config file");
      console.error("  --init-config           Generate sample .seoauditrc file");
      console.error("");
      console.error("Examples:");
      console.error("  node robots.js --origin=https://example.com");
      console.error("  node robots.js --origin=https://example.com --perf");
      console.error("  node robots.js --origin=https://example.com --config=my-config.json");
      console.error("  node robots.js --init-config");
      console.error("");
      process.exit(1);
    }

    // Load configuration (from file or defaults)
    const config = loadConfig(args.config);

    // Apply config to concurrency if not overridden by CLI
    if (args.concurrency === 5 && config.crawl && config.crawl.concurrency) {
      args.concurrency = config.crawl.concurrency;
    }

    // Additional URL validation
    const urlValidation = validateURL(args.origin);
    if (!urlValidation.valid) {
      console.error("");
      console.error(`❌ Invalid URL: ${urlValidation.error}`);
      console.error("");
      process.exit(1);
    }

    console.log(`✅ URL validated: ${args.origin}`);
    console.log(`🔄 Concurrency: ${args.concurrency} pages at a time`);
    if (args.perf) console.log(`📊 Performance metrics: enabled`);

    const seo = new SEOData(args.origin, args.proceed, args.perf, args.saveHtml, args.concurrency);

    await seo.audit();

    // Save to history for tracking
    try {
      const { HistoryManager } = require('./historyManager');
      const manager = new HistoryManager(seo.domainName);
      manager.addAuditSnapshot(seo.data, seo.fileManager.timestamp);
    } catch (error) {
      console.log('⚠️  Could not save audit history:', error.message);
    }

    // Generate HTML report in the same directory as the JSON file
    const htmlOutputPath = seo.fileManager.getHtmlFilePath();
    generateHTML(seo.file, seo.domainName, htmlOutputPath);

    // Print CLI summary
    printAuditSummary(seo.data, seo.domainName, htmlOutputPath);
  } catch (error) {
    console.error("Error during audit:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Export SEOData class for programmatic use
module.exports = { SEOData };

// CLI entry point - only run when executed directly
if (require.main === module) {
  audit();
}
