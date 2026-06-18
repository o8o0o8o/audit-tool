/**
 * Crawler Engine
 * Handles page crawling, browser lifecycle, and orchestration
 */

import { parse } from 'node-html-parser';
import { chromium } from 'playwright';
import type { Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';
import type {
  ChromePage,
  PageInfo,
  NetworkCondition,
  CpuCondition,
  CrawlProfile,
  CrawlerEngineOptions,
  CrawlerCallbacks,
} from '../types';
import type { CollectedVitals, CLSEntry, LongTaskEntry } from './vitals-collector';

import type {
  CrawlerInternalOptions,
  QueryParamConfig,
  FailureTracker,
  BackoffState,
  RequestInfo,
  RedirectEntry,
  BasicTestResult,
  PerformanceMetrics,
  CrawlPagesParams,
  CrawlSinglePageParams,
  ProcessPageDataParams,
  CrawlPageResult,
  CrawlResults,
} from './crawler-types';

import { SEVERITY, THRESHOLDS, VIEWPORT, CRAWL_SETTINGS, DEFAULT_USER_AGENT } from '../constants';
import { analyzeUrlStructure } from '../utils';
import { computeContentHash } from '../utils/content-hash';
import { escapeHtml } from '../reports/html-utils';
import { loadConfig } from '../config-loader';
import { ProgressReporter } from '../utils/progress-reporter';
import { VitalsCollector } from './vitals-collector';
import { CrUXAPI } from './crux-api';
import { isFetchAllowed } from '../../validators';

/** Hostname for the SSRF same-host allowance; '' if unparseable. */
function hostFromUrl(urlString: string): string | undefined {
  try {
    return new URL(urlString).hostname;
  } catch {
    return undefined;
  }
}

/** Resource types whose body we're willing to buffer (text-ish, bounded) when a
 *  response carries no content-length — large media/binary streams are skipped
 *  to avoid OOM from an unbounded or decompression-bomb response. */
const BUFFERABLE_RESOURCE_TYPES = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);

// Extracted modules
import {
  getBackoffDelay,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  recordPaginationNotFound,
  worstPaginationStreak,
  withTimeout,
  categorizeError,
  handlePageError,
} from './resilience';
import {
  processTitle,
  processMetaTags,
  processLinkTags,
  processRedirects,
  collectLinks,
  checkVitalsThresholds,
  optimizePageDataMemory,
  saveHtmlSnapshot,
  saveScreenshot,
  captureRepresentativeEvidence,
  populateIncomingLinksCount,
} from './page-data-builder';
import { runAnalyzers, ConsoleErrorAnalyzer, CodeCoverageAnalyzer } from './analyzer-runner';
import { PaginationAnalyzer } from '../analyzers/seo/pagination-analyzer';
import { RepresentativeSampler } from './representative-sampler';

import type { Issue } from '../types';

class CrawlerEngine {
  #options: CrawlerInternalOptions;
  #callbacks: CrawlerCallbacks;
  #failureTracker: FailureTracker;
  #backoffState: Map<string, BackoffState>;
  /** Decides which URLs get full evidence capture (screenshots, HAR). Cap defaults to 10; the constructor overrides with options.evidenceCap when supplied. */
  #sampler: RepresentativeSampler = new RepresentativeSampler();

  /** URLs the sampler authorised for evidence capture. Read after crawl completes. */
  getSampledUrls(): string[] {
    return this.#sampler.getSampledUrls();
  }

  /**
   * Call PageSpeed Insights for each sampled URL in both mobile and desktop
   * strategies, writing the lab summary to `evidence/<page>/psi.<strategy>.json`.
   *
   * No-op when `--perf` is off, when no `evidenceDir` is configured, or when
   * the sampler captured no pages. Failures (network, non-200, throttled) are
   * swallowed silently so they don't block the audit.
   */
  async capturePSIForSampled(): Promise<{ attempted: number; succeeded: number }> {
    if (!this.#options.perf || !this.#options.evidenceDir) {
      return { attempted: 0, succeeded: 0 };
    }
    const sampled = this.#sampler.getSampledUrls();
    if (sampled.length === 0) return { attempted: 0, succeeded: 0 };

    const apiKey = process.env.CRUX_API_KEY ?? this.#options.cruxApiKey ?? null;
    const strategies: Array<'mobile' | 'desktop'> = ['mobile', 'desktop'];
    const tasks: Array<{ url: string; strategy: 'mobile' | 'desktop' }> = [];
    for (const url of sampled) for (const strategy of strategies) tasks.push({ url, strategy });

    console.log(`\n📈 Fetching PSI lab scores for ${sampled.length} representative page(s) × 2 strategies…`);

    let attempted = 0;
    let succeeded = 0;
    const concurrency = 4;
    const fs = await import('fs');
    const path = await import('path');
    const { createSafeFilename } = await import('../utils');
    const { CrUXAPI } = await import('./crux-api');

    // Simple worker pool
    let index = 0;
    const next = async (): Promise<void> => {
      while (index < tasks.length) {
        const task = tasks[index++];
        attempted++;
        // Guard the whole task body: a throw from fetchPSILabSummary /
        // createSafeFilename would otherwise kill this worker lane and abandon
        // every queued task (Promise.all rejects). Isolate per-task failures.
        try {
          const summary = await CrUXAPI.fetchPSILabSummary(task.url, { strategy: task.strategy, apiKey });
          if (summary) {
            succeeded++;
            const evidenceDir = this.#options.evidenceDir;
            if (!evidenceDir) continue;
            const pageDir = path.join(evidenceDir, createSafeFilename(task.url));
            fs.mkdirSync(pageDir, { recursive: true });
            // Self-describing meta in case captureRepresentativeEvidence didn't run.
            const metaPath = path.join(pageDir, '_meta.json');
            if (!fs.existsSync(metaPath)) {
              fs.writeFileSync(metaPath, JSON.stringify({ url: task.url, capturedAt: new Date().toISOString() }, null, 2));
            }
            fs.writeFileSync(path.join(pageDir, `psi.${task.strategy}.json`), JSON.stringify(summary, null, 2));
          }
        } catch (error: unknown) {
          if (this.#options.verbose) {
            console.error(`PSI capture failed for ${task.url} (${task.strategy}): ${(error as Error).message}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));

    console.log(`   ✓ PSI lab data captured: ${succeeded}/${attempted} call(s) succeeded`);
    return { attempted, succeeded };
  }

  /**
   * Create a CrawlerEngine
   * @param {Object} options - Crawler options
   * @param {number} options.concurrency - Number of pages to process in parallel
   * @param {boolean} options.saveHtml - Whether to save HTML snapshots
   * @param {boolean} options.perf - Whether to collect performance metrics
   * @param {string} options.origin - Site origin URL
   * @param {Object} options.networkConditions - Network throttling conditions
   * @param {Object} options.cpuConditions - CPU throttling conditions
   * @param {Object} callbacks - Callback functions for state management
   * @param {Function} callbacks.saveError - Function to save errors
   * @param {Function} callbacks.saveData - Function to save checkpoint data
   * @param {Function} callbacks.checkAttempts - Function to check retry attempts
   * @param {Function} callbacks.saveAttempt - Function to save retry attempt
   */
  constructor(
    options: CrawlerEngineOptions & {
      config?: Record<string, unknown>;
      queryParams?: QueryParamConfig;
      cruxApiKey?: string | null;
    },
    callbacks: CrawlerCallbacks,
  ) {
    // Use config from options if provided, otherwise load fresh (for backward compat)
    const config = (options.config ?? loadConfig()) as Record<string, Record<string, unknown>>;

    this.#options = {
      concurrency: options.concurrency || 5,
      saveHtml: options.saveHtml || false,
      screenshots: options.screenshots || false,
      analysis: (config.analysis || {}) as Record<string, unknown>,
      perf: options.perf || false,
      origin: options.origin ?? '',
      networkConditions: options.networkConditions,
      cpuConditions: options.cpuConditions,
      verbose: options.verbose || false,
      userAgent: ((config.crawl as Record<string, unknown> | undefined)?.userAgent as string | null) ?? null,
      headers: ((config.crawl as Record<string, unknown> | undefined)?.headers as Record<string, string> | null) ?? null,
      cruxApiKey: options.cruxApiKey ?? null,
      evidenceDir: options.evidenceDir,
      evidenceCap: options.evidenceCap,
      queryParams: options.queryParams ??
        (config.queryParams as unknown as QueryParamConfig | undefined) ?? {
          mode: 'strip_tracking',
          whitelist: [],
          blacklist: [
            // Pagination
            'page',
            'p',
            'pg',
            'paged',
            'offset',
            'limit',
            'per_page',
            'pagesize',
            // Sorting
            'sort',
            'sortby',
            'sort_by',
            'order',
            'orderby',
            'order_by',
            'dir',
            'direction',
            // Filtering
            'filter',
            'filters',
            'type',
            'category',
            'cat',
            'tag',
            'tags',
            'color',
            'size',
            'brand',
            'price',
            'min_price',
            'max_price',
            'q',
            'query',
            'search',
            's',
            'keyword',
            'keywords',
            // View options
            'view',
            'display',
            'layout',
            'columns',
            'grid',
            'list',
            // Session/state
            'ref',
            'source',
            'from',
            'return',
            'redirect',
            'callback',
          ],
        },
    };
    this.#callbacks = callbacks;

    // Initialize circuit breaker state
    this.#failureTracker = {
      consecutiveFailures: 0,
      lastFailureTime: 0,
      circuitOpen: false,
      circuitOpenTime: 0,
      paginationNotFoundStreak: new Map<string, number>(),
    };

    // Initialize backoff state per error type
    this.#backoffState = new Map<string, BackoffState>();

    // Override sampler cap when caller supplied one (default 10 is in the sampler)
    if (typeof options.evidenceCap === 'number' && options.evidenceCap > 0) {
      this.#sampler = new RepresentativeSampler(options.evidenceCap);
    }
  }

  /**
   * Helper to create a reportIssue function bound to saveError callback
   */
  #reportIssue = (message: string, detail: string, severity: string) => {
    this.#callbacks.saveError(message, detail, severity);
  };

  /**
   * Perform basic page test - navigate and collect metrics
   * @private
   */
  async #basicTest(
    page: ChromePage,
    network: NetworkCondition,
    cpu: CpuCondition,
    url: string,
  ): Promise<BasicTestResult> {
    const requests: Record<string, RequestInfo> = {};
    let totalResponseSize = 0;
    // Accurate page transfer size is the sum of actual bytes received per request
    // (`request.sizes().responseBodySize`, resolved on 'requestfinished'), NOT the
    // declared `content-length`. A range/streamed media response (video/audio)
    // advertises the FULL asset length in content-length while transferring only a
    // slice, so summing content-length inflated totalResponseSize into the hundreds
    // of MB and tripped the 6 MB threshold falsely. responseBodySize reflects what
    // was really transferred (encoded, incl. chunked). Mirrors lib/phase3 captureOne.
    const sizings: Promise<void>[] = [];

    // Set up console error tracking
    const consoleTracker = ConsoleErrorAnalyzer.createConsoleTracker(page);

    // Define handlers so we can remove them later
    const requestHandler = async (request: PlaywrightRequest) => {
      requests[request.url()] = {
        resourceType: request.resourceType(),
        method: request.method(),
        startTime: Date.now(),
      };
    };

    const responseHandler = async (response: PlaywrightResponse) => {
      let size: number | null = null;

      try {
        // Provisional per-request size for the `requests` map (consumed by the
        // compression / font / critical-path / third-party analyzers): use the
        // declared content-length so we never buffer the body just to measure it.
        // Only fall back to reading the body when the header is absent AND the
        // resource is one we'd parse anyway (document/script/stylesheet) —
        // buffering a large media/asset stream, or a gzip bomb with no
        // content-length, would OOM the crawler. NOTE: this is a PROVISIONAL
        // value — `requestFinishedHandler` overwrites it with the real
        // transferred bytes (`request.sizes().responseBodySize`) once the request
        // finishes, so streamed/ranged media isn't counted at its full length.
        const declared = Number(response.headers()['content-length']);
        if (Number.isFinite(declared) && declared >= 0) {
          size = declared;
        } else if (BUFFERABLE_RESOURCE_TYPES.has(response.request().resourceType())) {
          const body = await response.body();
          if (body.length <= THRESHOLDS.MAX_BUFFERED_RESPONSE) size = body.length;
        }
      } catch {
        // Body read failed - ignore
      }

      const resUrl = response.url();

      const now = Date.now();
      requests[response.url()] = {
        ...requests[resUrl],
        status: response.status(),
        endTime: now,
        duration: requests[resUrl]?.startTime ? now - requests[resUrl].startTime : 0,
        size,
      };
    };

    // Accumulate the true page transfer size from per-request transfer bytes.
    // `request.sizes()` resolves only after the request finishes; collect the
    // pending lookups and await them before reading totalResponseSize.
    const requestFinishedHandler = (request: PlaywrightRequest) => {
      sizings.push(
        (async () => {
          try {
            const s = await request.sizes();
            if (s.responseBodySize > 0) {
              totalResponseSize += s.responseBodySize;
              // Overwrite the per-request `size` (set from content-length by the
              // response handler) with the real transferred bytes. A range/
              // streamed media response advertises the FULL asset length in
              // content-length while transferring only a slice, so the declared
              // value inflated per-request size into tens/hundreds of MB and
              // skewed every consumer that sums it (third-party payload, network
              // breakdown, total transfer). `request.sizes()` accounts the bytes
              // actually received without buffering the body. Leave cached/
              // redirected requests (responseBodySize 0) on their declared size.
              const entry = requests[request.url()];
              if (entry) entry.size = s.responseBodySize;
            }
          } catch {
            // Request had no recordable size (cached, aborted, redirect) - ignore.
          }
        })(),
      );
    };

    page.on('request', requestHandler);
    page.on('response', responseHandler);
    page.on('requestfinished', requestFinishedHandler);

    let response: PlaywrightResponse | null | undefined,
      status: number | undefined,
      redirectChain: RedirectEntry[],
      vitals: Partial<CollectedVitals>,
      metrics: PerformanceMetrics,
      firstLoadShot: Buffer | undefined;

    try {
      if (this.#options.perf) {
        const session = await page.context().newCDPSession(page);

        // Enable performance metrics collection
        await session.send('Performance.enable');

        // Apply CPU throttling if needed
        if (!cpu.noThrottle && cpu.rate) {
          await session.send('Emulation.setCPUThrottlingRate', {
            rate: cpu.rate,
          });
        }

        // Apply network throttling if needed
        if (!network.noThrottle) {
          await session.send('Network.enable');

          await session.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: network.download ?? -1,
            uploadThroughput: network.upload ?? -1,
            latency: network.latency ?? 0,
          });
        }

        // Start code coverage collection before navigation
        // Reuse the same CDP session to avoid conflicts from multiple sessions on one page
        await CodeCoverageAnalyzer.startCoverage(page, session).catch((e) => {
          if (this.#options.verbose)
            console.warn(`[coverage] Failed to start coverage for ${url}: ${e instanceof Error ? e.message : e}`);
        });
      }

      // SSRF guard: a hostile target's sitemap/links could point at private/
      // internal hosts (cloud metadata, localhost services). Block before goto;
      // same-host-as-origin and SEO_AUDIT_ALLOW_PRIVATE=1 are allowed.
      const gate = isFetchAllowed(url, { originHost: hostFromUrl(this.#options.origin) });
      if (!gate.allowed) {
        throw new Error(`Blocked by SSRF guard: ${gate.reason}`);
      }

      // Navigate to the page with explicit timeout
      response = await page.goto(url, {
        waitUntil: 'load',
        timeout: THRESHOLDS.PAGE_TIMEOUT,
      });

      status = response?.status();

      // First-load viewport screenshot — taken before vitals settle, auto-
      // scroll, and lazy hydration, so post-load layout shifts (fonts, ads,
      // hydration) are visible when paired with the settled evidence shot.
      // Only for pages the sampler is expected to pick (cheap non-consuming
      // peek; the authoritative shouldSample decision happens post-analysis).
      if (status === 200 && this.#options.evidenceDir && this.#sampler.wouldSample(url)) {
        try {
          firstLoadShot = await page.screenshot({ fullPage: false, timeout: 5_000 });
        } catch {
          // Non-critical — the evidence pair simply won't render for this page.
        }
      }

      // Track redirects
      redirectChain = [];
      let currentRequest = response?.request();
      while (currentRequest) {
        const redirectedFrom = currentRequest.redirectedFrom();
        if (redirectedFrom) {
          // Get the response for the redirected request
          const redirectResponse = await redirectedFrom.response();
          redirectChain.unshift({
            url: redirectedFrom.url(),
            status: redirectResponse?.status() ?? 'unknown',
          });
          currentRequest = redirectedFrom;
        } else {
          break;
        }
      }

      // Add final URL to chain
      if (redirectChain.length > 0) {
        redirectChain.push({
          url: response?.url() ?? url,
          status: status ?? 0,
        });
      }

      vitals = {};

      if (this.#options.perf) {
        if (status === 200) {
          if (this.#options.verbose) console.log(`Collect vitals: ${status} ${url}`);

          // Collect performance metrics with error handling
          try {
            vitals = await VitalsCollector.collectVitals(page);
          } catch (vitalsError: unknown) {
            console.log(`⚠️  Vitals collection failed for ${url}: ${(vitalsError as Error).message}`);
            vitals = {};
          }
        } else {
          console.log(`Error: ${status} ${url}`);
        }
      }

      metrics = await page.evaluate(() => {
        return {
          nav: performance.getEntriesByType('navigation'),
          resources: performance.getEntriesByType('resource'),
          paint: performance.getEntriesByType('paint'),
        };
      });
    } finally {
      // Remove event listeners to prevent memory leaks - always runs even on error
      page.off('request', requestHandler);
      page.off('response', responseHandler);
      page.off('requestfinished', requestFinishedHandler);
    }

    // Resolve any in-flight request.sizes() lookups so totalResponseSize is
    // complete before we return it.
    await Promise.all(sizings);

    // Get console data and cleanup
    const consoleData = consoleTracker.getResults();
    consoleTracker.cleanup();

    // Capture response headers for freshness analysis
    const responseHeaders: Record<string, string | undefined> = {};
    if (response) {
      const headers = response.headers();
      responseHeaders['last-modified'] = headers['last-modified'];
      responseHeaders['cache-control'] = headers['cache-control'];
      responseHeaders['etag'] = headers['etag'];
      responseHeaders['age'] = headers['age'];
      responseHeaders['date'] = headers['date'];
      responseHeaders['expires'] = headers['expires'];
    }

    // Capture the served HTML (pre-JS response body) — the floor of what every
    // crawler sees. Used by the pagination analyzer to tell server-rendered list
    // content (crawlable) apart from content injected client-side on scroll.
    let servedHtml: string | undefined;
    try {
      const text = await response?.text();
      // Cap retained HTML so a pathologically large document can't blow memory.
      servedHtml = text !== undefined && text.length > THRESHOLDS.MAX_SERVED_HTML ? text.slice(0, THRESHOLDS.MAX_SERVED_HTML) : text;
    } catch {
      // Body unavailable (e.g. already consumed / non-text) — leave undefined.
    }

    return {
      ...vitals,
      status,
      requests,
      totalResponseSize,
      metrics,
      redirectChain,
      responseHeaders,
      consoleData,
      servedHtml,
      firstLoadShot,
    };
  }

  /**
   * Crawl pages and collect data
   * @param {Object} params - Crawl parameters
   * @param {Array} params.pagesToCrawl - URLs to crawl
   * @param {Set} params.collectedURLs - Set of discovered URLs
   * @param {Set} params.uniquePages - Set of unique pages from sitemap
   * @param {boolean} params.addMissing - Whether to add discovered URLs to crawl queue
   * @param {Object} params.results - Results object reference
   * @param {Map} params.incomingLinksTracking - Map for tracking incoming links
   * @param {Object} params.sitemapUrls - Sitemap URLs reference
   * @returns {Object} Crawl results { alternatesErrors, isMultiLang, failedPages }
   */
  async crawlPages({
    pagesToCrawl,
    collectedURLs,
    uniquePages,
    crawlFrontierKeys,
    addMissing,
    results,
    incomingLinksTracking,
    sitemapUrls,
  }: CrawlPagesParams) {
    // Record the effective network/CPU/perf profile so the live --verify pass
    // can re-fetch under the same conditions (TTFB/CLS/TBT need parity). Store
    // the SINGLE selected conditions actually applied per page (slow4g/normal —
    // see #basicTest call site), NOT the full condition maps.
    results.crawlProfile = {
      perf: !!this.#options.perf,
      network: this.#options.networkConditions?.slow4g ?? null,
      cpu: this.#options.cpuConditions?.normal ?? null,
    };
    let browser;
    let sigintHandler: (() => void) | undefined;
    try {
      browser = await chromium.launch();
      const contextOptions: Record<string, unknown> = {
        viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
        // Always send a realistic UA. Falling back to Playwright's default
        // "HeadlessChrome" UA gets the crawler 403'd by bot-protection on many
        // sites, silently dropping pages from the audit.
        userAgent: this.#options.userAgent || DEFAULT_USER_AGENT,
      };
      // Custom request headers (auth tokens, or a vendor protection-bypass
      // token for auditing your own protected site) — applied to every request.
      if (this.#options.headers && Object.keys(this.#options.headers).length > 0) {
        contextOptions.extraHTTPHeaders = this.#options.headers;
      }
      const context = await browser.newContext(
        contextOptions as { viewport: { width: number; height: number }; userAgent?: string },
      );

      // Inject __name polyfill for tsx/esbuild compatibility.
      // tsx compiles with keepNames:true, injecting __name() calls into serialized
      // page.evaluate() callbacks. This polyfill ensures __name exists in the browser.
      await context.addInitScript(() => {
        if (typeof (globalThis as unknown as Record<string, unknown>).__name === 'undefined') {
          (globalThis as unknown as Record<string, unknown>).__name = (target: unknown, _value: unknown) => target;
        }
      });

      const alternatesErrors: Issue[] = [];
      const uniqueTitles = new Set<string>();
      const uniqueDescriptions = new Set<string>();
      const failedPages: string[] = [];
      const discoveredLinksSource = new Map<string, string>();
      const paginationSeriesCounts = new Map<string, number>();
      PaginationAnalyzer.resetProbeState(); // reset per-audit JS-"next" probe budget

      let isMultiLang = false;
      let saveCounter = 0; // Track saves to reduce frequency

      // Fetch CrUX data for the origin (only once at start)
      if (this.#options.perf && !results.cruxData) {
        const cruxApiKey = process.env.CRUX_API_KEY ?? this.#options.cruxApiKey ?? null;
        console.log(`\n📊 Fetching Chrome UX Report (CrUX) field data...${cruxApiKey ? ' (API key found)' : ''}`);
        try {
          results.cruxData = await CrUXAPI.fetchCrUXData(this.#options.origin, cruxApiKey);
          if (results.cruxData) {
            console.log(`   ✓ CrUX data available (${results.cruxData.targetType}-level)`);
            const cwvMetrics = ['LCP', 'CLS', 'INP'];
            for (const metric of cwvMetrics) {
              const data = results.cruxData.metrics?.[metric];
              if (data?.percentiles?.p75 !== undefined) {
                const p75 =
                  metric === 'CLS'
                    ? Number(data.percentiles.p75).toFixed(2)
                    : `${Math.round(Number(data.percentiles.p75))}ms`;
                console.log(`     ${metric}: p75=${p75} (${data.distribution?.good ?? 0}% good)`);
              }
            }
          } else if (!cruxApiKey) {
            console.log('   ⚠️  CrUX requires a Google API key. Set CRUX_API_KEY env variable:');
            console.log('      1. Go to https://console.cloud.google.com/apis/credentials');
            console.log('      2. Enable "Chrome UX Report API"');
            console.log('      3. Create an API key');
            console.log('      4. export CRUX_API_KEY=your_key');
          } else {
            console.log('   ⚠️  No CrUX data available (origin may lack sufficient Chrome traffic)');
          }
        } catch (e: unknown) {
          console.log(`   ⚠️  Could not fetch CrUX data: ${(e as Error).message}`);
        }
      }

      // Track pages already processed at start (for resume) to avoid double-counting in progress
      // Only count pages that are BOTH processed AND in the current crawl list
      const alreadyProcessedAtStart = new Set<string>();
      const pagesToCrawlSet = new Set(pagesToCrawl);
      for (const url of results.pageData.processedPages) {
        if (pagesToCrawlSet.has(url)) {
          alreadyProcessedAtStart.add(url);
        }
      }
      const alreadyProcessedCount = alreadyProcessedAtStart.size;

      // Initialize progress reporter with already processed count for resume
      // Use different color scheme for discovered links phase (addMissing=false)
      const colorScheme = addMissing ? 'default' : 'discovered';
      const progress = new ProgressReporter(
        pagesToCrawl.length,
        CRAWL_SETTINGS.PROGRESS_REPORT_INTERVAL_MS,
        alreadyProcessedCount,
        colorScheme,
        this.#options.verbose,
      );

      // Graceful shutdown on SIGINT (Ctrl+C)
      let abortRequested = false;
      let forceQuit = false;
      sigintHandler = () => {
        if (abortRequested) {
          // Second Ctrl+C: abandon the in-flight batch too. Do NOT process.exit()
          // from this library method — that skips the `finally` (browser close,
          // listener removal) and the top-level handler in robots.ts that
          // actually persists progress, while falsely printing "Progress saved".
          // Set a flag and let the loop unwind to `finally`; the caller saves.
          forceQuit = true;
          console.log('\n\n⚠️  Force quit — stopping as soon as the current batch settles; progress will be saved by the caller.');
          return;
        }
        abortRequested = true;
        console.log('\n\n⚠️  Graceful shutdown requested (Ctrl+C again to force quit)...');
        console.log('   Finishing current batch and saving progress...');
      };
      process.on('SIGINT', sigintHandler);

      // Process pages in batches for parallel execution
      const concurrency = this.#options.concurrency;

      for (let batchStart = 0; batchStart < pagesToCrawl.length; batchStart += concurrency) {
        // Check for graceful / force shutdown
        if (abortRequested || forceQuit) {
          console.log('   Saving checkpoint before exit...');
          break;
        }

        // Check circuit breaker before processing batch
        if (isCircuitOpen(this.#failureTracker)) {
          const cooldownRemaining =
            CRAWL_SETTINGS.CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - this.#failureTracker.circuitOpenTime);
          console.warn(`⚡ Circuit breaker open. Waiting ${Math.ceil(cooldownRemaining / 1000)}s before retrying...`);
          await new Promise((resolve) => setTimeout(resolve, Math.min(cooldownRemaining, 10000)));
          continue; // Re-check circuit state
        }

        // Update total in case new pages were discovered (only happens when addMissing=true)
        progress.updateTotal(pagesToCrawl.length);

        const batchEnd = Math.min(batchStart + concurrency, pagesToCrawl.length);
        const batch = pagesToCrawl.slice(batchStart, batchEnd);

        // Process batch in parallel using Promise.allSettled to isolate failures
        // Add overall batch timeout to prevent indefinite hangs (5 minutes per batch)
        const BATCH_TIMEOUT = CRAWL_SETTINGS.BATCH_TIMEOUT || 300000;
        const batchPromise = Promise.allSettled(
          batch.map(async (url: string) => {
            if (results.pageData.processedPages.has(url)) {
              // Only count as skip if it wasn't already counted at start (prevents double-counting on resume)
              if (!alreadyProcessedAtStart.has(url)) {
                progress.skip(url);
              }
              return { url, skipped: true };
            }

            const startTime = Date.now();
            const pageResult = await this.#crawlSinglePage({
              url,
              context,
              results,
              incomingLinksTracking,
              sitemapUrls,
              collectedURLs,
              uniquePages,
              crawlFrontierKeys,
              pagesToCrawl,
              addMissing,
              discoveredLinksSource,
              uniqueTitles,
              uniqueDescriptions,
              paginationSeriesCounts,
            });
            const duration = Date.now() - startTime;

            if (pageResult) {
              if (pageResult.isMultiLang) {
                isMultiLang = true;
              }
              if (pageResult.failed) {
                failedPages.push(url);
                progress.fail(url, 'crawl error');
                recordFailure(this.#failureTracker, pageResult.errorType ?? 'unknown');

                // Apply exponential backoff after failure
                const backoffDelay = getBackoffDelay(pageResult.errorType ?? 'unknown', this.#backoffState);
                if (backoffDelay > 1000) {
                  await new Promise((resolve) => setTimeout(resolve, backoffDelay));
                }
              } else {
                progress.success(url, duration);
                recordSuccess(this.#failureTracker, this.#backoffState);
              }
            } else {
              progress.success(url, duration);
              recordSuccess(this.#failureTracker, this.#backoffState);
            }

            return { url, pageResult, duration };
          }),
        );

        // Wrap batch with timeout to prevent indefinite hangs
        let batchResults;
        try {
          batchResults = await withTimeout(
            batchPromise,
            BATCH_TIMEOUT,
            `Batch timeout after ${BATCH_TIMEOUT / 1000}s for ${batch.length} URLs`,
          );
        } catch (timeoutError: unknown) {
          console.warn(`⚠️  ${(timeoutError as Error).message}`);
          // On timeout, mark remaining URLs as failed and continue
          for (const url of batch) {
            if (!results.pageData.processedPages.has(url)) {
              failedPages.push(url);
              progress.fail(url, 'batch timeout');
              recordFailure(this.#failureTracker, 'batch_timeout');
            }
          }
          continue; // Move to next batch
        }

        // Force quit (2nd Ctrl+C) hit during this batch: stop now and let the
        // loop unwind to `finally` so the caller can persist what we have.
        if (forceQuit) {
          console.log('   Force quit — saving checkpoint before exit...');
          break;
        }

        // Handle any rejected promises (unexpected errors not caught by #crawlSinglePage)
        for (const result of batchResults) {
          if (result.status === 'rejected') {
            const error = result.reason;
            console.error(`Unexpected batch error: ${error.message}`);
            // The URL is not directly available from rejected promise, but page is already marked as failed
          }
        }

        // Abort crawl on broken-pagination signal: any single pagination series
        // with too many consecutive not-found responses (hard 404 status or
        // soft 404 content on 200 pages). Counting per-series — not globally —
        // means the abort fires for a genuinely runaway "next" link, not for a
        // scattering of dead URLs across the site.
        const { series: worstSeries, count: worstCount } = worstPaginationStreak(this.#failureTracker);
        if (worstCount >= CRAWL_SETTINGS.CONSECUTIVE_404_THRESHOLD) {
          const lastUrl = this.#failureTracker.last404Url;
          const reason = `Crawl stopped: ${worstCount} consecutive not-found pages in the "${worstSeries}" pagination series (likely broken pagination)`;
          console.warn(`\n⚠️  ${reason}${lastUrl ? ` — last URL: ${lastUrl}` : ''}`);
          results.pageData.crawlAborted = {
            reason,
            threshold: CRAWL_SETTINGS.CONSECUTIVE_404_THRESHOLD,
            lastUrl,
            series: worstSeries,
          };
          this.#callbacks.saveError(
            'Crawl aborted: broken pagination detected',
            `${escapeHtml(worstCount.toString())} consecutive not-found responses (HTTP 404 or soft 404) were detected in the <code>${escapeHtml(
              worstSeries ?? '',
            )}</code> pagination series${
              lastUrl ? ` — last: <a href="${escapeHtml(lastUrl)}">${escapeHtml(lastUrl)}</a>` : ''
            }. The crawl was stopped to avoid wasting time on a broken pagination series. Verify that this series' "next" links point to existing pages.`,
            SEVERITY.HIGH,
          );
          abortRequested = true;
        }

        // Save checkpoint frequently to flush pages to disk and free memory
        // Save every 5 batches (~25 pages) to reduce data loss on crash
        saveCounter++;
        if (saveCounter % CRAWL_SETTINGS.CHECKPOINT_SAVE_INTERVAL === 0) {
          await this.#callbacks.saveData();
        }
      }

      // Retry failed pages (separate queue, reduced concurrency)
      if (failedPages.length > 0 && !abortRequested) {
        const maxRetries = THRESHOLDS.RETRY_ATTEMPTS || 3;
        const retryPages = failedPages.filter((url) => {
          const attempts = results.pageData.attempts[url] || 0;
          return attempts < maxRetries;
        });

        if (retryPages.length > 0) {
          console.log(
            `\n🔄 Retrying ${retryPages.length} failed page(s) (max ${maxRetries} attempts, concurrency: 1)...`,
          );

          for (const url of retryPages) {
            if (abortRequested) break;
            if (results.pageData.processedPages.has(url)) continue;

            const attempt = (results.pageData.attempts[url] || 0) + 1;
            console.log(`   Retry ${attempt}/${maxRetries}: ${url}`);

            // Wait before retry with increasing delay
            await new Promise((r) => setTimeout(r, CRAWL_SETTINGS.RETRY_DELAY_BASE_MS * attempt));

            const startTime = Date.now();
            const pageResult = await this.#crawlSinglePage({
              url,
              context,
              results,
              incomingLinksTracking,
              sitemapUrls,
              collectedURLs,
              uniquePages,
              crawlFrontierKeys,
              pagesToCrawl,
              addMissing,
              discoveredLinksSource,
              uniqueTitles,
              uniqueDescriptions,
              paginationSeriesCounts,
            });
            const duration = Date.now() - startTime;

            if (pageResult?.failed) {
              console.log(`   ✗ Retry failed: ${url}`);
              // failedPages already tracked by #crawlSinglePage
            } else {
              console.log(`   ✓ Retry succeeded: ${url} (${(duration / 1000).toFixed(1)}s)`);
              // Remove from failedPages
              const idx = failedPages.indexOf(url);
              if (idx !== -1) failedPages.splice(idx, 1);
              progress.success(url, duration);
            }
          }

          await this.#callbacks.saveData();
        }
      }

      // Print crawl summary
      progress.printSummary();

      // Fetch per-URL CrUX field data (only in perf mode with API key)
      if (this.#options.perf && !abortRequested) {
        const cruxApiKey = process.env.CRUX_API_KEY ?? this.#options.cruxApiKey ?? null;
        if (cruxApiKey) {
          const processedUrls = Array.from(results.pageData.processedPages);
          const successUrls = processedUrls.filter(
            (u) => results.pageData.pages[u] && !results.pageData.pages[u].error,
          );
          console.log(`\n🌐 Fetching per-URL CrUX field data for ${successUrls.length} page(s)...`);
          let cruxFound = 0;
          // Fetch in small batches to respect rate limits
          for (let i = 0; i < successUrls.length; i += CRAWL_SETTINGS.CRUX_BATCH_SIZE) {
            const urlBatch = successUrls.slice(i, i + CRAWL_SETTINGS.CRUX_BATCH_SIZE);
            const cruxResults = await Promise.allSettled(
              urlBatch.map((url) => CrUXAPI.fetchCrUXForUrl(url, cruxApiKey)),
            );
            for (let j = 0; j < urlBatch.length; j++) {
              const cruxResult = cruxResults[j];
              if (cruxResult.status === 'fulfilled' && cruxResult.value) {
                const fieldData = cruxResult.value;
                const page = results.pageData.pages[urlBatch[j]];
                if (page) {
                  page.cruxFieldData = {
                    targetType: fieldData.targetType,
                    metrics: {},
                  };
                  for (const [metric, data] of Object.entries(fieldData.metrics)) {
                    if (data.percentiles?.p75 != null) {
                      page.cruxFieldData.metrics[metric] = {
                        p75: data.percentiles.p75,
                        distribution: data.distribution,
                      };
                    }
                  }
                  cruxFound++;
                }
              }
            }
            // Small delay between batches to avoid rate limiting
            if (i + CRAWL_SETTINGS.CRUX_BATCH_SIZE < successUrls.length) {
              await new Promise((r) => setTimeout(r, CRAWL_SETTINGS.CRUX_BATCH_DELAY_MS));
            }
          }
          console.log(`   ✓ CrUX URL-level data found for ${cruxFound}/${successUrls.length} page(s)`);
        }
      }

      // Final save of crawled pages for this pass. The incoming-links Map is
      // intentionally NOT converted here: crawlPages can be invoked more than
      // once (sitemap pass + discovered-URL pass), and each pass keeps adding
      // to the same Map. Converting/clearing per pass would discard earlier
      // passes' data. The orchestrator calls finalizeIncomingLinks() once after
      // all passes complete.
      await this.#callbacks.saveData();

      return { alternatesErrors, isMultiLang, failedPages };
    } catch (error: unknown) {
      console.error('Crawl error:', (error as Error).message);
      throw error;
    } finally {
      // Remove SIGINT handler to prevent leaks across retries
      if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
      if (browser) {
        try {
          await browser.close();
        } catch (closeError: unknown) {
          console.error('Failed to close browser:', closeError);
        }
      }
    }
  }

  /**
   * Convert the accumulated incoming-links tracking Map into the serialisable
   * `results.pageData.incomingLinks` object and populate per-page counts.
   *
   * Must be called exactly once, after all crawl passes complete. The tracking
   * Map is keyed by normalised target URLs and accumulates across every
   * crawlPages() invocation; this method finalises it and frees the Map.
   */
  finalizeIncomingLinks(results: CrawlResults, incomingLinksTracking: Map<string, Set<string>>): void {
    // Process in chunks to prevent memory spikes on large sites
    const MAX_INCOMING_LINKS = CRAWL_SETTINGS.MAX_INCOMING_LINKS;
    const CHUNK_SIZE = 1000;

    results.pageData.incomingLinks = {};
    let processedCount = 0;
    let skippedCount = 0;
    let gcCounter = 0;

    // Iterate Map directly instead of copying to array (saves ~2x memory on large sites)
    for (const [target, sources] of incomingLinksTracking) {
      if (processedCount >= MAX_INCOMING_LINKS) {
        skippedCount++;
        continue;
      }
      // Limit sources per target to prevent memory explosion
      const sourcesArray = Array.from(sources);
      results.pageData.incomingLinks[target] =
        sourcesArray.length > CRAWL_SETTINGS.INCOMING_LINKS_PER_TARGET_MAX
          ? sourcesArray.slice(0, CRAWL_SETTINGS.INCOMING_LINKS_PER_TARGET_MAX)
          : sourcesArray;
      processedCount++;

      // Allow garbage collection periodically
      gcCounter++;
      if (gcCounter % (CHUNK_SIZE * 10) === 0 && global.gc) {
        global.gc();
      }
    }

    if (skippedCount > 0) {
      console.log(
        `  ⚠️  Truncated incoming links: kept ${processedCount}, skipped ${skippedCount} (limit: ${MAX_INCOMING_LINKS})`,
      );
    }

    // Clear the tracking map to free memory
    incomingLinksTracking.clear();

    // Populate incoming-links counts on any pages still in memory. Note: pages
    // flushed to disk during the crawl are evicted from memory, so the report
    // derives counts from the persisted incomingLinks map at render time. This
    // in-memory pass keeps still-resident pages (and orphan detection) correct.
    populateIncomingLinksCount(results, this.#options.queryParams);
  }

  /**
   * Crawl a single page
   * @private
   */
  async #crawlSinglePage(params: CrawlSinglePageParams): Promise<CrawlPageResult> {
    const {
      url,
      context,
      results,
      incomingLinksTracking,
      sitemapUrls,
      collectedURLs,
      uniquePages,
      crawlFrontierKeys,
      pagesToCrawl,
      addMissing,
      discoveredLinksSource,
      uniqueTitles,
      uniqueDescriptions,
      paginationSeriesCounts,
    } = params;

    const chromePage = await context.newPage();
    let isMultiLang = false;
    let failed: boolean;

    try {
      const page = await withTimeout<BasicTestResult | null>(
        this.#basicTest(chromePage, this.#options.networkConditions.slow4g, this.#options.cpuConditions.normal, url)
          .then(async (data): Promise<BasicTestResult> => ({ ...data, url }))
          .catch((error: Error): null => {
            handlePageError(
              error,
              url,
              results,
              this.#options.verbose,
              this.#reportIssue,
              this.#callbacks.saveAttempt,
              this.#callbacks.checkAttempts,
            );
            return null;
          }),
        THRESHOLDS.PAGE_TIMEOUT,
        'Core Web Vitals test failed. Page failed to load ' + url,
      );

      if (!page) {
        await chromePage.close();
        return { failed: true, errorType: 'page_load_failed' };
      }

      // Process successful page load
      const processResult = await this.#processPageData({
        page,
        chromePage,
        url,
        results,
        incomingLinksTracking,
        sitemapUrls,
        collectedURLs,
        uniquePages,
        crawlFrontierKeys,
        pagesToCrawl,
        addMissing,
        discoveredLinksSource,
        uniqueTitles,
        uniqueDescriptions,
        paginationSeriesCounts,
      });

      isMultiLang = processResult.isMultiLang;
      failed = processResult.failed;
    } catch (error: unknown) {
      const errorType = categorizeError(error as Error);
      console.error(`Error processing page ${url} [${errorType}]:`, (error as Error).message);
      this.#callbacks.saveAttempt(url);
      this.#callbacks.checkAttempts(url);
      failed = true;
      await chromePage.close();
      return { isMultiLang, failed, errorType };
    }

    await chromePage.close();
    return { isMultiLang, failed };
  }

  /**
   * Process page data after successful load
   * @private
   */
  async #processPageData(params: ProcessPageDataParams) {
    const {
      page,
      chromePage,
      url,
      results,
      incomingLinksTracking,
      sitemapUrls,
      collectedURLs,
      uniquePages,
      crawlFrontierKeys,
      pagesToCrawl,
      addMissing,
      discoveredLinksSource,
      uniqueTitles,
      uniqueDescriptions,
      paginationSeriesCounts,
    } = params;

    const {
      status,
      TTFB,
      FCP,
      LCP,
      CLS,
      INP,
      TBT,
      TTI,
      speedIndex,
      lcpElement,
      lcpUrl,
      lcpSize,
      lcpSubParts,
      lcpSelector,
      lcpRect,
      clsEntries,
      clsLargestShift,
      clsShiftCount,
      inpEvent,
      longTasks,
      domContentLoaded,
      domComplete,
      loadEvent,
      requests,
      totalResponseSize,
      metrics,
      blockers,
      redirectChain,
      responseHeaders,
      consoleData,
      servedHtml,
      firstLoadShot,
    } = page;

    // Defensive check for corrupted state
    if (!results.pageData?.pages) {
      throw new Error(`Corrupted results state: pageData or pages is undefined for URL ${url}`);
    }

    results.pageData.pages[url] = { url } as PageInfo;
    const pageData = results.pageData.pages[url];

    // Store redirect chain info
    processRedirects(pageData, redirectChain, url, this.#reportIssue);

    pageData.status = status;
    pageData.url = url;
    pageData.foundIn = sitemapUrls[url] ? 'sitemap' : 'discovered';
    if (pageData.foundIn === 'discovered' && discoveredLinksSource.has(url)) {
      pageData.discoveredOn = discoveredLinksSource.get(url);
    }

    // Analyze URL structure
    pageData.urlAnalysis = analyzeUrlStructure(url, this.#options.origin);
    for (const issue of pageData.urlAnalysis.issues) {
      const escapedUrl = escapeHtml(url);
      const msg = issue.message ?? '';
      this.#callbacks.saveError(
        msg.split('(')[0].trim(),
        `<a href="${escapedUrl}">${escapedUrl}</a>: ${escapeHtml(msg)}`,
        issue.severity,
      );
    }

    // Core Web Vitals
    pageData.TTFB = TTFB;
    pageData.FCP = FCP;
    pageData.LCP = LCP;
    pageData.CLS = CLS;
    pageData.INP = INP;

    // Advanced lab metrics
    pageData.TBT = TBT;
    pageData.TTI = TTI;
    pageData.speedIndex = speedIndex;

    // Navigation timing
    pageData.domContentLoaded = domContentLoaded;
    pageData.domComplete = domComplete;
    pageData.loadEvent = loadEvent;

    // Vitals attribution (for debugging)
    pageData.vitals = {
      lcpElement,
      lcpUrl,
      lcpSize,
      lcpSubParts,
      clsEntries: clsEntries?.slice(0, 5), // Limit to top 5
      clsLargestShift,
      clsShiftCount,
      inpEvent,
      longTasks: longTasks?.slice(0, 5), // Limit to top 5
    };

    // Analyze LCP sub-parts if available
    if (lcpSubParts && LCP != null && LCP > THRESHOLDS.LCP) {
      const lcpAnalysis = VitalsCollector.analyzeLCPSubParts(lcpSubParts, LCP);
      pageData.vitals.lcpAnalysis = lcpAnalysis;
    }

    // Analyze CLS sources if available
    if (clsEntries && CLS != null && CLS > THRESHOLDS.CLS) {
      const clsAnalysis = VitalsCollector.analyzeCLSSources(clsEntries as CLSEntry[]);
      pageData.vitals.clsAnalysis = clsAnalysis;
    }

    // Analyze long tasks if TBT is high
    if (longTasks && TBT != null && TBT > THRESHOLDS.TBT) {
      const tbtAnalysis = VitalsCollector.analyzeLongTasks(longTasks as LongTaskEntry[]);
      pageData.vitals.tbtAnalysis = tbtAnalysis;
    }

    // Other metrics
    pageData.requests = requests;
    pageData.metrics = metrics as unknown as Record<string, unknown>;
    pageData.blockers = blockers as Record<string, unknown>;
    pageData.totalResponseSize = totalResponseSize;
    pageData.responseHeaders = (responseHeaders || {}) as Record<string, string>;
    pageData.response = { headers: pageData.responseHeaders };

    // Check page size threshold
    if (totalResponseSize > THRESHOLDS.PAGE_SIZE) {
      const escapedUrl = escapeHtml(url);
      this.#callbacks.saveError(
        `Some pages size is too big`,
        `This page has size of ${totalResponseSize} bytes <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM,
      );
    }

    const totalNumberOfRequests = Object.keys(requests).length;
    pageData.totalNumberOfRequests = totalNumberOfRequests;

    if (totalNumberOfRequests > THRESHOLDS.REQUEST_COUNT) {
      const escapedUrl = escapeHtml(url);
      this.#callbacks.saveError(
        `Some pages have too many requests`,
        `This page has ${totalNumberOfRequests} requests <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM,
      );
    }

    // Handle non-200 status
    if (status !== 200) {
      results.pageData.totalWithError += 1;

      const statusKey = String(status ?? 'unknown');
      if (!results.pageData.byError[statusKey]) {
        results.pageData.byError[statusKey] = [];
        results.pageData.byError[`total${statusKey}`] = 0;
      }

      (results.pageData.byError[statusKey] as string[]).push(url);
      results.pageData.byError[`total${statusKey}`] = (results.pageData.byError[`total${statusKey}`] as number) + 1;

      // Track consecutive not-found responses per pagination series to detect
      // broken pagination (see recordPaginationNotFound). A non-404 response
      // (200, 301, 500, …) on a pagination URL ends that series' streak.
      recordPaginationNotFound(this.#failureTracker, url, status === 404);

      results.pageData.processedPages.add(url);

      return { isMultiLang: false, failed: false };
    }

    // Note: the consecutive-404 streak is NOT reset here. We defer the decision
    // until after runAnalyzers, because pages that return HTTP 200 but are
    // actually "not found" (soft 404, common on Next.js / SPA sites) should
    // also count toward the broken-pagination signal.

    results.pageData.totalWithoutError += 1;

    // Get page content
    const pageContent = await chromePage.content();
    const parsedPage = parse(pageContent);

    // Stable content hash — used by the comparison classifier to tell apart
    // "the site changed" from "measurement noise". Normalised so cache-busters,
    // CSRF tokens, and timestamps don't trigger spurious diffs.
    pageData.contentHash = computeContentHash(pageContent);

    // Save HTML snapshot if enabled
    saveHtmlSnapshot(pageContent, url, this.#options);

    // Save viewport screenshot if enabled
    await saveScreenshot(chromePage, url, this.#options);

    // Decide once per page whether this URL gets the full evidence capture
    // (screenshots, request log, accessibility dump). The actual capture
    // happens after runAnalyzers so accessibility data is available.
    const captureEvidence = !!this.#options.evidenceDir && this.#sampler.shouldSample(url);

    // Collect links and track incoming links
    const linksResult = collectLinks(
      {
        parsedPage,
        url,
        results,
        incomingLinksTracking,
        collectedURLs,
        uniquePages,
        crawlFrontierKeys,
        pagesToCrawl,
        addMissing,
        discoveredLinksSource,
        sitemapUrls,
        paginationSeriesCounts,
      },
      this.#options.origin,
      this.#options.queryParams,
      this.#reportIssue,
    );
    pageData.links = linksResult.links;
    pageData.httpLinksCount = linksResult.httpLinksCount;

    // Run all analyzers with error isolation
    // Wrap in try-catch to prevent analyzer failures from losing all page data
    try {
      await runAnalyzers(
        chromePage,
        parsedPage,
        url,
        pageData,
        pageContent,
        requests,
        consoleData,
        this.#options,
        this.#reportIssue,
        servedHtml,
      );
    } catch (analyzerError: unknown) {
      // Log the error but don't fail the entire page
      const err = analyzerError as Error;
      console.error(`Analyzer error for ${url}: ${err.message}`);
      pageData.analyzerError = {
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n'),
      };
      this.#callbacks.saveError(
        'Analyzer error occurred',
        `Some analyzers failed for <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>: ${escapeHtml(err.message)}`,
        SEVERITY.MEDIUM,
      );
    }

    // Representative-page evidence capture (after analyzers so accessibility
    // data and the final request log are available).
    if (captureEvidence) {
      await captureRepresentativeEvidence(chromePage, url, this.#options, requests, pageData.accessibility, {
        firstLoadShot,
        clsEntries: clsEntries as CLSEntry[] | undefined,
        clsValue: CLS,
        codeCoverage: pageData.codeCoverage,
        lcp:
          typeof LCP === 'number' && LCP > 0
            ? { selector: lcpSelector ?? null, rect: lcpRect ?? null, value: LCP, subParts: lcpSubParts }
            : undefined,
        missingHeaders: (pageData.security as { missingHeaders?: string[] } | undefined)?.missingHeaders,
      });
    }

    // Update the broken-pagination streak using soft-404 detection from the
    // analyzers. A page that returned HTTP 200 but is actually a soft 404 (e.g.
    // a Next.js SPA catch-all) still indicates broken pagination within its
    // series, so count it the same way (recordPaginationNotFound scopes it to
    // pagination URLs — a soft 404 on a one-off page is a content finding, not
    // a reason to abort).
    recordPaginationNotFound(this.#failureTracker, url, !!pageData.soft404?.isSoft404);

    // Check Core Web Vitals thresholds
    checkVitalsThresholds(pageData, url, TTFB ?? 0, FCP ?? 0, LCP ?? 0, CLS ?? 0, this.#reportIssue);

    // Process title
    const title = await chromePage.evaluate(() => document.querySelector('title')?.innerText);
    const titleResult = processTitle(title, url, uniqueTitles, this.#reportIssue);
    if (titleResult.title) {
      pageData.title = titleResult.title;
      pageData.titleLength = titleResult.titleLength;
    }

    // Process meta tags
    const metaTags = await chromePage.evaluate(() =>
      Array.from(document.querySelectorAll('meta')).map((meta) => ({
        name: meta.name || meta.getAttribute('property'),
        content: meta.content,
      })),
    );
    processMetaTags(metaTags, pageData, url, uniqueDescriptions, this.#reportIssue);

    // Process link tags (canonical, alternates)
    const linkTags = await chromePage.evaluate(() =>
      Array.from(document.querySelectorAll('link')).map((link) => ({
        rel: link.rel,
        hrefLang: (link as unknown as { hrefLang: string }).hrefLang,
        href: link.href,
      })),
    );
    const linkResult = processLinkTags(linkTags, pageData, url, sitemapUrls, this.#options.origin, this.#reportIssue);
    const isMultiLang = linkResult.isMultiLang;

    results.pageData.processedPages.add(url);

    // Memory optimization: strip data after all processing is complete
    optimizePageDataMemory(pageData);

    return { isMultiLang, failed: false };
  }
}

export { CrawlerEngine };
