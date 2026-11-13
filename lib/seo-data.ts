/**
 * SEOData Class
 * Core audit orchestration class - extracted to avoid circular dependencies
 */

import * as fs from 'fs';
import * as path from 'path';

// Import modularized components
import type { NetworkCondition, CpuCondition, SEODataOptions } from './types';
import { SEVERITY, THRESHOLDS, NETWORK_CONDITIONS, CPU_CONDITIONS } from './constants';
import { validateUrl, formatElapsedTime, removeTrailingSlash } from './utils';
import { sanitizeDomainName } from '../validators';
import { FileManager } from './storage/file-manager';
import { ScoreCalculator } from './scoring/score-calculator';
import { ErrorAggregator, isDefectivePageOwnerFinding } from './utils/error-aggregator';
import { ProgressManager, resolveResumeVisual } from './orchestrators/progress-manager';
import { AuditOrchestrator } from './orchestrators/audit-orchestrator';
import { CrawlerEngine } from './crawler/crawler-engine';
import { RobotsParser } from './parsers/robots-parser';
import { SitemapParser } from './parsers/sitemap-parser';
import { probeSitemapMedia } from './orchestrators/sitemap-media-probe';
import { AEOAnalyzer } from './analyzers/seo/aeo-analyzer';
import { SiteTextFilesAnalyzer } from './analyzers/seo/site-text-files-analyzer';
import { runSiteProbes } from './analyzers/site-checks/site-probes';
import { parse } from 'node-html-parser';

/**
 * On `--proceed` the checkpoint's pages decide whether agentic checks keep running,
 * so every page in one audit is checked the same way; an empty checkpoint keeps the requested value.
 */
export function resolveResumeAgentic(requested: boolean, pages: Record<string, unknown> | undefined): boolean {
  const restored = Object.values(pages ?? {});
  if (restored.length === 0) return requested;
  return restored.some((page) => typeof page === 'object' && page !== null && 'agentic' in page);
}

class SEOData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Results object is intentionally dynamic; analyzers attach arbitrary keys at runtime
  #results: Record<string, any>;
  #proceed: boolean;
  #perf: boolean;
  #saveHtml: boolean;
  #concurrency: number;
  #sitemapFile: string | null; // Path to local sitemap XML file
  #incomingLinksTracking: Map<string, Set<string>>; // Map to track unique source->target links during processing
  #errorAggregator: ErrorAggregator;
  #progressManager: ProgressManager | undefined;
  #crawlerEngine: CrawlerEngine | undefined;
  #verbose: boolean;
  #open: boolean;
  #exclude: string[];
  #limit: number | null;
  #dryRun: boolean;
  #cruxApiKey: string | null;
  #screenshots: boolean;
  #evidence: boolean;
  #evidenceCap: number;
  #visual: boolean;
  #agentic: boolean;

  origin: string | null;
  domainName: string | null;
  networkConditions: Record<string, NetworkCondition>;
  cpuConditions: Record<string, CpuCondition>;
  fileManager!: FileManager;
  resultsDir!: string;
  file!: string;
  _currentPhase: { label: string; startMs: number } | null = null;

  constructor(
    origin: string | null,
    proceed = false,
    perf = false,
    saveHtml = false,
    concurrency = 5,
    sitemapFile: string | null = null,
    options: SEODataOptions & { agentic?: boolean } = {},
  ) {
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
    this.#verbose = options.verbose ?? false;
    this.#open = options.open ?? false;
    this.#exclude = options.exclude ?? [];
    this.#limit = options.limit ?? null;
    this.#dryRun = options.dryRun ?? false;
    this.#cruxApiKey = options.cruxApiKey ?? null;
    this.#screenshots = options.screenshots ?? false;
    this.#evidence = options.evidence ?? true;
    this.#evidenceCap = options.evidenceCap ?? 10;
    this.#visual = options.visual ?? false;
    this.#agentic = options.agentic ?? true;

    // Initialize incoming links tracking (Map<target, Set<source>>)
    this.#incomingLinksTracking = new Map();

    if (validatedUrl) {
      this.origin = removeTrailingSlash(validatedUrl.replace(/\s/g, ''));
    } else {
      // Origin will be derived from sitemap URLs in #parseSitemapFile()
      this.origin = null;
    }
    // Use centralized domain sanitization for consistent naming
    this.domainName = this.origin ? sanitizeDomainName(this.origin) : null;

    this.#errorAggregator = new ErrorAggregator();

    this.#results = {
      robots: { sitemaps: [], 'user-agent': {} },
      sitemaps: { urls: {}, total: 0 },
      isMultiLang: false,
      visual: this.#visual,
      agentic: this.#agentic,
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
        phases: [], // Array of { name, duration, durationMs }
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
    if (!this.origin || !this.domainName) {
      throw new Error('Cannot initialize managers: origin and domainName must be set');
    }

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
    this.#progressManager = new ProgressManager(this.fileManager, { verbose: this.#verbose });

    // Initialize crawler engine with callbacks for state management
    this.#crawlerEngine = new CrawlerEngine(
      {
        concurrency: this.#concurrency,
        saveHtml: this.#saveHtml,
        screenshots: this.#screenshots,
        perf: this.#perf,
        origin: this.origin,
        networkConditions: this.networkConditions,
        cpuConditions: this.cpuConditions,
        verbose: this.#verbose,
        cruxApiKey: this.#cruxApiKey,
        evidenceDir: this.#evidence ? path.join(this.resultsDir, 'evidence') : undefined,
        evidenceCap: this.#evidenceCap,
        visual: this.#visual,
        agentic: this.#agentic,
      },
      {
        saveError: this.saveError.bind(this),
        saveData: this.saveData.bind(this),
        checkAttempts: this.#checkAttempts.bind(this),
        saveAttempt: this.#saveAttempt.bind(this),
      },
    );
  }

  // Getter for results data (used by history manager and other external consumers)
  get data() {
    return this.#results;
  }

  // Getter for --open flag
  get shouldOpenReport() {
    return this.#open;
  }

  /** Require initialized ProgressManager or throw */
  get #pm(): ProgressManager {
    if (!this.#progressManager) throw new Error('ProgressManager not initialized — call #initializeManagers() first');
    return this.#progressManager;
  }

  /** Require initialized CrawlerEngine or throw */
  get #crawler(): CrawlerEngine {
    if (!this.#crawlerEngine) throw new Error('CrawlerEngine not initialized — call #initializeManagers() first');
    return this.#crawlerEngine;
  }

  saveError(generalError: string, detailedError: string, severity: string = SEVERITY.MEDIUM) {
    this.#errorAggregator.addError(generalError, detailedError, severity);
  }

  #checkAttempts(url: string) {
    if (this.#results.pageData.attempts[url] >= THRESHOLDS.RETRY_ATTEMPTS) {
      this.#results.pageData.processedPages.add(url);
    }
  }

  #saveAttempt(url: string) {
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
      this.#results.pageData.pages,
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
    // Finalize the last phase timing
    if (this._currentPhase) {
      const elapsed = Date.now() - this._currentPhase.startMs;
      this.#results.timing.phases.push({
        name: this._currentPhase.label,
        duration: formatElapsedTime(elapsed),
        durationMs: elapsed,
      });
      this._currentPhase = null;
    }

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
      const restored = await this.#pm.loadProgress(this.domainName ?? '', this.resultsDir);

      // Update instance state from restored data
      this.#results = restored.results;

      // Ensure processedPages is always a Set (defensive check)
      if (!(this.#results.pageData.processedPages instanceof Set)) {
        console.log(`  ⚠️  Converting processedPages to Set (was ${typeof this.#results.pageData.processedPages})`);
        this.#results.pageData.processedPages = new Set(
          Array.isArray(this.#results.pageData.processedPages) ? this.#results.pageData.processedPages : [],
        );
      }

      this.#errorAggregator = restored.errorAggregator;
      this.#incomingLinksTracking = restored.incomingLinksTracking;

      const { visual, warning } = resolveResumeVisual(this.#visual, restored.results.visual);
      if (warning) console.warn(`  ⚠️  ${warning}`);
      this.#visual = visual;
      this.#results.visual = visual;
      if (this.#crawlerEngine) this.#crawlerEngine.visual = visual;
      const agentic = resolveResumeAgentic(this.#agentic, restored.results.pageData?.pages);
      this.#agentic = agentic;
      this.#results.agentic = agentic;
      if (this.#crawlerEngine) this.#crawlerEngine.agentic = agentic;
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`\n❌ ERROR restoring progress:`, err.message);
      console.error(`File: ${this.file}`);

      if (err.message.includes('JSON') || err.message.includes('parse')) {
        console.error(`\nThe progress file appears to be corrupted.`);
        console.error(`Consider removing it and starting fresh:\n`);
        console.error(`  mv "${this.file}" "${this.file}.backup"`);
        console.error(`  node start.js --origin=... --perf\n`);
      }

      throw error;
    }
  }

  async saveData() {
    await this.#pm.waitForPendingFlush();
    this.#pm.saveProgress(this.#results as Parameters<ProgressManager['saveProgress']>[0]);
  }

  async #analyzeRobotsTxt() {
    // Use RobotsParser module to parse robots.txt
    const result = await RobotsParser.parseRobotsTxt(this.origin ?? '');

    // Update results with parsed data
    this.#results.robots.sitemaps = result.sitemaps;
    this.#results.robots['user-agent'] = result.userAgents;

    // Register any errors found during parsing
    result.errors.forEach((error: { message: string; detail: string | null; severity: string }) => {
      this.saveError(error.message, error.detail ?? '', error.severity);
    });

    // Analyze AI crawler rules in robots.txt
    const aeoRobotsResult = AEOAnalyzer.analyzeRobotsTxt(result, this.origin ?? '');
    aeoRobotsResult.issues.forEach((i) => this.saveError(i.message!, i.detail!, i.severity));
    aeoRobotsResult.warnings.forEach((w) => this.saveError(w.message!, w.detail!, w.severity));
    this.#results.aeo = { robotsTxt: aeoRobotsResult.info };

    // Check for llms.txt
    try {
      const llmsResult = await AEOAnalyzer.analyzeLlmsTxt(this.origin ?? '');
      this.#results.aeo.llmsTxt = llmsResult.info;
      if (this.#agentic)
        AuditOrchestrator.reportLlmsTxtFinding(llmsResult.info, this.origin ?? '', (m, d, sev) =>
          this.saveError(m, d ?? '', sev),
        );
    } catch (e: unknown) {
      console.log('llms.txt check skipped:', (e as Error).message);
    }

    const securityResult = await SiteTextFilesAnalyzer.analyzeSecurityTxt(this.origin ?? '');
    securityResult.issues.forEach((i) => this.saveError(i.message!, i.detail!, i.severity));
    const adsResult = await SiteTextFilesAnalyzer.analyzeAdsTxt(this.origin ?? '');
    adsResult.issues.forEach((i) => this.saveError(i.message!, i.detail!, i.severity));
    this.#results.siteTextFiles = { securityTxt: securityResult.info, ...adsResult.info };
  }

  /**
   * Parse a local sitemap XML file and derive origin from its URLs
   */
  async #parseSitemapFile() {
    console.log(`📄 Parsing local sitemap file: ${this.#sitemapFile}`);

    const xml = fs.readFileSync(this.#sitemapFile ?? '', 'utf-8');
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
    const result: {
      sitemaps: Record<string, unknown>;
      urls: Record<string, unknown>;
      total: number;
      errors: { message: string; detail: string; severity: string }[];
      media?: Parameters<typeof probeSitemapMedia>[0];
    } = {
      sitemaps: {},
      urls: {},
      total: 0,
      errors: [],
    };

    SitemapParser.processSitemap(urls as any, this.origin ?? '', this.#sitemapFile ?? '', result as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Store sitemap data
    Object.assign(this.#results.sitemaps, result.sitemaps);
    this.#results.sitemaps.urls = result.urls;
    this.#results.sitemaps.total = result.total;

    // Register any errors
    result.errors.forEach((error: { message: string; detail: string; severity: string }) => {
      this.saveError(error.message, error.detail, error.severity);
    });
    // On --proceed the probe's findings are already in the restored checkpoint.
    if (!this.#proceed) await probeSitemapMedia(result.media, this.origin ?? '', this.saveError.bind(this));

    console.log(`✅ Parsed ${result.total} URLs from sitemap file`);
  }

  async #analyzeSitemaps() {
    // Use SitemapParser module
    const result = await SitemapParser.parseSitemaps(this.origin ?? '', this.#results.robots.sitemaps);

    // Store sitemap data
    Object.assign(this.#results.sitemaps, result.sitemaps);
    this.#results.sitemaps.urls = result.urls;
    this.#results.sitemaps.total = result.total;

    // Register all errors
    result.errors.forEach((error: { message: string; detail: string; severity: string }) => {
      this.saveError(error.message, error.detail, error.severity);
    });
    await probeSitemapMedia(result.media, this.origin ?? '', this.saveError.bind(this));
  }

  async #analyzePages() {
    // Apply --exclude patterns and --limit before crawling
    if (this.#exclude.length > 0 || this.#limit) {
      const urls = Object.keys(this.#results.sitemaps.urls);
      let filtered = urls;

      if (this.#exclude.length > 0) {
        const patterns = this.#exclude.map((p) => new RegExp(p, 'i'));
        filtered = filtered.filter((url) => !patterns.some((re) => re.test(url)));
        const excluded = urls.length - filtered.length;
        if (excluded > 0) console.log(`  Excluded ${excluded} URLs matching --exclude patterns`);
      }

      if (this.#limit && filtered.length > this.#limit) {
        console.log(`  Limiting to first ${this.#limit} of ${filtered.length} URLs`);
        filtered = filtered.slice(0, this.#limit);
      }

      // Rebuild sitemaps.urls with only filtered URLs
      const newUrls: Record<string, Record<string, unknown>> = {};
      for (const url of filtered) {
        newUrls[url] = this.#results.sitemaps.urls[url];
      }
      this.#results.sitemaps.urls = newUrls;
      this.#results.sitemaps.total = filtered.length;
    }

    // Bridge internal results to the orchestrator's expected shape
    await AuditOrchestrator.analyzePages({
      results: this.#results as Parameters<typeof AuditOrchestrator.analyzePages>[0]['results'],
      crawlerEngine: this.#crawler as unknown as Parameters<typeof AuditOrchestrator.analyzePages>[0]['crawlerEngine'],
      incomingLinksTracking: this.#incomingLinksTracking,
      saveError: this.saveError.bind(this) as Parameters<typeof AuditOrchestrator.analyzePages>[0]['saveError'],
      resultsDir: this.resultsDir,
      origin: this.origin,
    });
  }

  /**
   * Print estimated crawl time based on URL count and concurrency
   */
  #printEstimatedTime() {
    const totalUrls = this.#results.sitemaps?.total ?? 0;
    if (totalUrls === 0) return;

    const AVG_TIME_PER_PAGE_SEC = 3; // Conservative estimate
    const estimatedSec = Math.ceil((totalUrls / this.#concurrency) * AVG_TIME_PER_PAGE_SEC);
    const minutes = Math.floor(estimatedSec / 60);
    const seconds = estimatedSec % 60;
    const timeStr = minutes > 0 ? `~${minutes}m ${seconds}s` : `~${seconds}s`;

    console.log(`  ${totalUrls} URLs to crawl (concurrency: ${this.#concurrency}). Estimated time: ${timeStr}`);

    // Warn about large sites
    if (totalUrls > 1000 && this.#concurrency < 10) {
      console.log(`  \x1b[33mTip: Large site detected. Use --concurrency=10 to speed up.\x1b[0m`);
    }
  }

  /**
   * Print a phase indicator and track phase timing
   * @param {number} phase - Phase number
   * @param {number} total - Total phases
   * @param {string} label - Phase description
   */
  #printPhase(phase: number, total: number, label: string) {
    // Record end time for previous phase
    if (this._currentPhase) {
      const elapsed = Date.now() - this._currentPhase.startMs;
      this.#results.timing.phases.push({
        name: this._currentPhase.label,
        duration: formatElapsedTime(elapsed),
        durationMs: elapsed,
      });
    }
    this._currentPhase = { label, startMs: Date.now() };

    const CYAN = '\x1b[36m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';
    console.log(`\n${CYAN}${BOLD}[${phase}/${total}]${RESET} ${label}`);
  }

  async audit() {
    try {
      if (this.#sitemapFile && !this.origin) {
        // Sitemap file mode: parse local file to derive origin and init managers
        await this.#parseSitemapFile();
      }

      if (this.#proceed) {
        this.#printPhase(1, 3, 'Restoring progress...');

        await this.#restoreProgress();

        // Keep the original start time from previous run
        if (!this.#results.timing.startTime) {
          this.#startTiming();
        } else {
          console.log(`  Resuming audit started at: ${this.#results.timing.startTime}`);
        }

        this.#printPhase(2, 3, 'Crawling pages...');
        this.#printEstimatedTime();
        await this.#analyzePages();

        this.#printPhase(3, 3, 'Running site-wide validation...');
      } else if (this.#sitemapFile) {
        // Sitemap file mode: already parsed above, just crawl pages
        this.#startTiming();

        this.#printPhase(1, 2, 'Crawling pages...');
        this.#printEstimatedTime();
        await this.#analyzePages();

        this.#printPhase(2, 2, 'Running site-wide validation...');
      } else {
        // Standard mode: robots.txt → sitemaps → pages
        this.#startTiming();

        this.#printPhase(1, 4, 'Analyzing robots.txt...');
        await this.#analyzeRobotsTxt();

        this.#printPhase(2, 4, 'Parsing sitemaps...');
        await this.#analyzeSitemaps();

        // Dry run: stop after sitemap parsing
        if (this.#dryRun) return;

        this.#printPhase(3, 4, 'Crawling pages...');
        this.#printEstimatedTime();
        await this.#analyzePages();

        this.#printPhase(4, 4, 'Running site-wide validation...');
      }
    } catch (error: unknown) {
      const err = error as Error;
      // Save error with full details including stack trace
      const errorMessage = err.message || String(error);
      const errorDetail = err.stack ?? errorMessage;
      this.saveError(`Audit failed: ${errorMessage}`, errorDetail, SEVERITY.HIGH);

      // Stop timing before exit
      this.#stopTiming();

      // Calculate summary even on error
      this.#calculateSummary();

      // Save data before exiting
      await this.saveData();

      console.error('Audit failed with error:', err.message);
      // Re-throw to let the error propagate and trigger restart via start.js
      throw error;
    }

    // Reload evicted pages before site-wide validation
    // (saveProgress() evicts pages from memory to prevent OOM during crawling,
    // but site-wide validators need the complete dataset)
    console.log('\nReloading pages for site-wide analysis...');
    this.#pm.reloadEvictedPages(this.#results.pageData.pages);

    // Run all site-wide validations
    // Bridge internal pageData to the orchestrator's expected shape
    const { defectivePageUrls } = await AuditOrchestrator.runSiteWideValidation(
      this.#results.pageData as Parameters<typeof AuditOrchestrator.runSiteWideValidation>[0],
      this.origin ?? '',
      this.#results.isMultiLang,
      this.saveError.bind(this) as Parameters<typeof AuditOrchestrator.runSiteWideValidation>[3],
      this.#results.sitemaps?.urls ?? {},
      this.#results.siteTextFiles,
    );

    // Site-level Domain & Exposure checks: email/DNS, exposed files, missing-page
    // status, dangling CNAMEs. After the crawl so a WAF block can't affect it.
    console.log('Running domain & exposure checks...');
    try {
      this.#results.siteChecks = await runSiteProbes(
        this.origin ?? '',
        this.#results.pageData.pages,
        this.saveError.bind(this),
        {
          robotsUserAgents: this.#results.robots?.['user-agent'],
          sitemapUrls: this.#results.sitemaps?.urls ?? {},
          discoveredUrls: Object.keys(this.#results.pageData.incomingLinks ?? {}),
        },
      );
    } catch (e: unknown) {
      console.log('Domain & exposure checks skipped:', (e as Error).message);
    }

    // Defective/non-real pages (broken-pagination tails + soft 404s) are phantom
    // pages whose fix is to remove/repair the page — not to add canonicals/alt/
    // etc. Drop them from every OTHER finding so they stop inflating occurrence
    // counts (and scores). The findings that identify them as defective (broken
    // pagination, soft 404) keep them.
    if (defectivePageUrls.length > 0) {
      const removed = this.#errorAggregator.suppressExamplesByUrl(
        new Set(defectivePageUrls),
        isDefectivePageOwnerFinding,
      );
      if (removed > 0) {
        console.log(
          `Suppressed ${removed} finding reference(s) to ${defectivePageUrls.length} defective page(s) (broken pagination / soft 404).`,
        );
      }
    }

    // Site-level facts emitted once per page (missing headers, PWA, the footer form…) become one
    // site-wide entry each instead of hundreds of identical per-page rows.
    // totalWithoutError counts analysed HTML pages (redirect stubs and files are not counted);
    // the pages map itself may be partly evicted to disk at this point.
    const crawledPages = this.#results.pageData.totalWithoutError ?? 0;
    const collapsed = this.#errorAggregator.collapseSiteLevelFindings(crawledPages);
    if (collapsed.length > 0) console.log(`Collapsed ${collapsed.length} site-level finding(s) into site-wide entries.`);

    // Stop timing
    this.#stopTiming();

    // Calculate final summary statistics
    this.#calculateSummary();

    await this.saveData();
  }
}

export { SEOData };
