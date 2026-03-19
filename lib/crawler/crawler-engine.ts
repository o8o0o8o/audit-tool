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
} from './crawler-types';

import {
  SEVERITY,
  THRESHOLDS,
  VIEWPORT,
  CRAWL_SETTINGS,
} from '../constants';
import { analyzeUrlStructure } from '../utils';
import { escapeHtml } from '../reports/html-utils';
import { loadConfig } from '../config-loader';
import { ProgressReporter } from '../utils/progress-reporter';
import { VitalsCollector } from './vitals-collector';
import { CrUXAPI } from './crux-api';

// Extracted modules
import {
  getBackoffDelay,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
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
  populateIncomingLinksCount,
} from './page-data-builder';
import { runAnalyzers, ConsoleErrorAnalyzer, CodeCoverageAnalyzer } from './analyzer-runner';

import type { Issue } from '../types';

class CrawlerEngine {
  #options: CrawlerInternalOptions;
  #callbacks: CrawlerCallbacks;
  #failureTracker: FailureTracker;
  #backoffState: Map<string, BackoffState>;

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
      cruxApiKey: options.cruxApiKey ?? null,
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
    };

    // Initialize backoff state per error type
    this.#backoffState = new Map<string, BackoffState>();
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
        const body = await response.body();
        size = body.length;
        totalResponseSize += size;
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

    page.on('request', requestHandler);
    page.on('response', responseHandler);

    let response: PlaywrightResponse | null | undefined,
      status: number | undefined,
      redirectChain: RedirectEntry[],
      vitals: Partial<CollectedVitals>,
      metrics: PerformanceMetrics;

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
          if (this.#options.verbose) console.warn(`[coverage] Failed to start coverage for ${url}: ${e instanceof Error ? e.message : e}`);
        });
      }

      // Navigate to the page with explicit timeout
      response = await page.goto(url, {
        waitUntil: 'load',
        timeout: THRESHOLDS.PAGE_TIMEOUT,
      });

      status = response?.status();

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
    }

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

    return {
      ...vitals,
      status,
      requests,
      totalResponseSize,
      metrics,
      redirectChain,
      responseHeaders,
      consoleData,
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
    addMissing,
    results,
    incomingLinksTracking,
    sitemapUrls,
  }: CrawlPagesParams) {
    let browser;
    let sigintHandler: (() => void) | undefined;
    try {
      browser = await chromium.launch();
      const contextOptions: Record<string, unknown> = {
        viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
      };
      if (this.#options.userAgent) {
        contextOptions.userAgent = this.#options.userAgent;
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

      let isMultiLang = false;
      let saveCounter = 0; // Track saves to reduce frequency

      // Fetch CrUX data for the origin (only once at start)
      if (this.#options.perf && !results.cruxData) {
        const cruxApiKey = (process.env.CRUX_API_KEY || this.#options.cruxApiKey) ?? null;
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
        2000,
        alreadyProcessedCount,
        colorScheme,
        this.#options.verbose,
      );

      // Graceful shutdown on SIGINT (Ctrl+C)
      let abortRequested = false;
      sigintHandler = () => {
        if (abortRequested) {
          console.log('\n\nForce quit. Progress has been saved.');
          process.exit(1);
        }
        abortRequested = true;
        console.log('\n\n⚠️  Graceful shutdown requested (Ctrl+C again to force quit)...');
        console.log('   Finishing current batch and saving progress...');
      };
      process.on('SIGINT', sigintHandler);

      // Process pages in batches for parallel execution
      const concurrency = this.#options.concurrency;

      for (let batchStart = 0; batchStart < pagesToCrawl.length; batchStart += concurrency) {
        // Check for graceful shutdown
        if (abortRequested) {
          console.log('   Saving checkpoint before exit...');
          break;
        }

        // Check circuit breaker before processing batch
        if (isCircuitOpen(this.#failureTracker)) {
          const cooldownRemaining = 60000 - (Date.now() - this.#failureTracker.circuitOpenTime);
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
              pagesToCrawl,
              addMissing,
              discoveredLinksSource,
              uniqueTitles,
              uniqueDescriptions,
            });
            const duration = Date.now() - startTime;

            if (pageResult) {
              if (pageResult.isMultiLang) {
                isMultiLang = true;
              }
              if (pageResult.failed) {
                failedPages.push(url);
                progress.fail(url, 'crawl error');
                recordFailure(this.#failureTracker, pageResult.errorType || 'unknown');

                // Apply exponential backoff after failure
                const backoffDelay = getBackoffDelay(pageResult.errorType || 'unknown', this.#backoffState);
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

        // Handle any rejected promises (unexpected errors not caught by #crawlSinglePage)
        for (const result of batchResults) {
          if (result.status === 'rejected') {
            const error = result.reason;
            console.error(`Unexpected batch error: ${error.message}`);
            // The URL is not directly available from rejected promise, but page is already marked as failed
          }
        }

        // Save checkpoint frequently to flush pages to disk and free memory
        // Save every 5 batches (~25 pages) to reduce data loss on crash
        saveCounter++;
        if (saveCounter % 5 === 0) {
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
            await new Promise((r) => setTimeout(r, 2000 * attempt));

            const startTime = Date.now();
            const pageResult = await this.#crawlSinglePage({
              url,
              context,
              results,
              incomingLinksTracking,
              sitemapUrls,
              collectedURLs,
              uniquePages,
              pagesToCrawl,
              addMissing,
              discoveredLinksSource,
              uniqueTitles,
              uniqueDescriptions,
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
        const cruxApiKey = (process.env.CRUX_API_KEY || this.#options.cruxApiKey) ?? null;
        if (cruxApiKey) {
          const processedUrls = Array.from(results.pageData.processedPages);
          const successUrls = processedUrls.filter(
            (u) => results.pageData.pages[u] && !results.pageData.pages[u].error,
          );
          console.log(`\n🌐 Fetching per-URL CrUX field data for ${successUrls.length} page(s)...`);
          let cruxFound = 0;
          // Fetch in small batches to respect rate limits
          const CRUX_BATCH_SIZE = 5;
          for (let i = 0; i < successUrls.length; i += CRUX_BATCH_SIZE) {
            const urlBatch = successUrls.slice(i, i + CRUX_BATCH_SIZE);
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
            if (i + CRUX_BATCH_SIZE < successUrls.length) {
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          console.log(`   ✓ CrUX URL-level data found for ${cruxFound}/${successUrls.length} page(s)`);
        }
      }

      // Final save before converting data structures
      await this.#callbacks.saveData();

      // Convert incomingLinksTracking Map to results.pageData.incomingLinks
      // Process in chunks to prevent memory spikes on large sites
      const MAX_INCOMING_LINKS = CRAWL_SETTINGS.MAX_INCOMING_LINKS || 100000;
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
        results.pageData.incomingLinks[target] = sourcesArray.length > 100 ? sourcesArray.slice(0, 100) : sourcesArray;
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

      // After all pages are crawled, populate incoming links count for each page
      populateIncomingLinksCount(results);

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
      pagesToCrawl,
      addMissing,
      discoveredLinksSource,
      uniqueTitles,
      uniqueDescriptions,
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
        pagesToCrawl,
        addMissing,
        discoveredLinksSource,
        uniqueTitles,
        uniqueDescriptions,
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
      pagesToCrawl,
      addMissing,
      discoveredLinksSource,
      uniqueTitles,
      uniqueDescriptions,
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

      results.pageData.processedPages.add(url);

      return { isMultiLang: false, failed: false };
    }

    results.pageData.totalWithoutError += 1;

    // Get page content
    const pageContent = await chromePage.content();
    const parsedPage = parse(pageContent);

    // Save HTML snapshot if enabled
    saveHtmlSnapshot(pageContent, url, this.#options);

    // Save viewport screenshot if enabled
    await saveScreenshot(chromePage, url, this.#options);

    // Collect links and track incoming links
    const linksResult = collectLinks(
      {
        parsedPage,
        url,
        results,
        incomingLinksTracking,
        collectedURLs,
        uniquePages,
        pagesToCrawl,
        addMissing,
        discoveredLinksSource,
        sitemapUrls,
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
      await runAnalyzers(chromePage, parsedPage, url, pageData, pageContent, requests, consoleData, this.#options, this.#reportIssue);
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
