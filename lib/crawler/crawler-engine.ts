/**
 * Crawler Engine
 * Handles page crawling, analysis orchestration, and data collection
 */

import { parse } from 'node-html-parser';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import type { Request as PlaywrightRequest, Response as PlaywrightResponse, BrowserContext } from 'playwright';
import type { ParsedPage, ChromePage, PageInfo, NetworkCondition, CpuCondition, CrawlerEngineOptions, CrawlerCallbacks, SitemapUrl, Issue } from '../types';
import type { CollectedVitals } from './vitals-collector';
import type { CrUXFieldData } from './crux-api';

// ─── Crawler Engine internal interfaces ─────────────────────────────────────

interface CrawlerInternalOptions {
  concurrency: number;
  saveHtml: boolean;
  screenshots: boolean;
  analysis: Record<string, unknown>;
  perf: boolean;
  origin: string;
  networkConditions: Record<string, NetworkCondition>;
  cpuConditions: Record<string, CpuCondition>;
  verbose: boolean;
  userAgent: string | null;
  queryParams: QueryParamConfig;
  cruxApiKey?: string | null;
  config?: Record<string, unknown>;
}

interface QueryParamConfig {
  mode?: 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist';
  whitelist?: string[];
  blacklist?: string[];
}

interface FailureTracker {
  consecutiveFailures: number;
  lastFailureTime: number;
  circuitOpen: boolean;
  circuitOpenTime: number;
}

interface BackoffState {
  attempts: number;
  lastAttempt: number;
}

interface RequestInfo {
  resourceType?: string;
  method?: string;
  startTime?: number;
  status?: number;
  endTime?: number;
  duration?: number;
  size?: number | null;
}

interface RedirectEntry {
  url: string;
  status: number | string;
}

interface BasicTestResult {
  TTFB?: number;
  FCP?: number;
  LCP?: number;
  CLS?: number;
  INP?: number;
  TBT?: number;
  TTI?: number;
  speedIndex?: number;
  lcpElement?: string | null;
  lcpUrl?: string | null;
  lcpSize?: { width: number; height: number } | null;
  lcpSubParts?: { ttfb: number; resourceLoad: number; resourceDelay: number; renderDelay: number };
  clsEntries?: unknown[];
  clsLargestShift?: number | null;
  clsShiftCount?: number;
  inpEvent?: string | null;
  longTasks?: unknown[];
  domContentLoaded?: number;
  domComplete?: number;
  loadEvent?: number;
  status: number | undefined;
  requests: Record<string, RequestInfo>;
  totalResponseSize: number;
  metrics: PerformanceMetrics;
  redirectChain: RedirectEntry[];
  responseHeaders: Record<string, string | undefined>;
  consoleData: unknown;
  url?: string;
  blockers?: unknown;
}

interface PerformanceMetrics {
  nav: PerformanceEntryList;
  resources: PerformanceEntryList;
  paint: PerformanceEntryList;
}

interface CrawlPagesParams {
  pagesToCrawl: string[];
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  addMissing: boolean;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
}

interface CrawlResults {
  pageData: {
    pages: Record<string, PageInfo>;
    processedPages: Set<string>;
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, string[] | number>;
    attempts: Record<string, number>;
    incomingLinks?: Record<string, string[]>;
  };
  cruxData?: CrUXFieldData | null;
}

interface CrawlSinglePageParams {
  url: string;
  context: BrowserContext;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  uniqueTitles: Set<string>;
  uniqueDescriptions: Set<string>;
}

interface ProcessPageDataParams {
  page: BasicTestResult;
  chromePage: ChromePage;
  url: string;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  uniqueTitles: Set<string>;
  uniqueDescriptions: Set<string>;
}

interface CollectLinksParams {
  parsedPage: ParsedPage;
  url: string;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  sitemapUrls: Record<string, SitemapUrl>;
}

interface LinkEntry {
  text: string | undefined;
  href: string;
  isInternal: boolean;
}

interface MetaTag {
  name: string | null;
  content: string;
}

interface LinkTag {
  rel: string;
  hrefLang: string;
  href: string;
}

interface AlternateEntry {
  hreflang: string;
  href: string;
}

interface AnalyzerResult {
  issues?: Issue[];
  warnings?: Issue[];
  [key: string]: unknown;
}

interface CrawlPageResult {
  isMultiLang?: boolean;
  failed: boolean;
  errorType?: string;
}

type PerformanceEntryList = unknown[];

import { KNOWN_ERRORS, SEVERITY, THRESHOLDS, META_TAGS, META_TAGS_CONFIG, getMetaTagSeverity, VIEWPORT, normalizeTextForComparison, CRAWL_SETTINGS } from '../constants';
import { normalizeUrl, stripHashFragment, createSafeFilename, analyzeUrlStructure } from '../utils';
import { escapeHtml } from '../reports/html-utils';
import { loadConfig } from '../config-loader';
import { ProgressReporter } from '../utils/progress-reporter';
import { VitalsCollector } from './vitals-collector';
import { CrUXAPI } from './crux-api';

// SEO analyzers
import { HeadingAnalyzer } from '../analyzers/seo/heading-analyzer';
import { ImageAnalyzer } from '../analyzers/seo/image-analyzer';
import { StructuredDataAnalyzer } from '../analyzers/seo/structured-data-analyzer';
import { IndexabilityAnalyzer } from '../analyzers/seo/indexability-analyzer';
import { CrawlabilityAnalyzer } from '../analyzers/seo/crawlability-analyzer';
import { UrlArchitectureAnalyzer } from '../analyzers/seo/url-architecture-analyzer';
import { EEATAnalyzer } from '../analyzers/seo/eeat-analyzer';
import { AdvancedSchemaValidator } from '../analyzers/seo/advanced-schema-validator';
import { TechnicalSEOAnalyzer } from '../analyzers/seo/technical-seo-analyzer';
import { TechnologyDetector } from '../analyzers/seo/technology-detector';
import { ThinContentAnalyzer } from '../analyzers/content/thin-content-analyzer';
import { Soft404Analyzer } from '../analyzers/seo/soft-404-analyzer';
import { ConsoleErrorAnalyzer } from '../analyzers/seo/console-error-analyzer';
import { PaginationAnalyzer } from '../analyzers/seo/pagination-analyzer';
import { MediaSEOAnalyzer } from '../analyzers/seo/media-seo-analyzer';
import { WebComponentAnalyzer } from '../analyzers/seo/web-component-analyzer';

// Performance analyzers
import { ImageOptimizationAnalyzer } from '../analyzers/performance/image-optimization-analyzer';
import { ResourceOptimizationAnalyzer } from '../analyzers/performance/resource-optimization-analyzer';
import { CachingAnalyzer } from '../analyzers/performance/caching-analyzer';
import { FontLoadingAnalyzer } from '../analyzers/performance/font-loading-analyzer';
import { ThirdPartyAnalyzer } from '../analyzers/performance/third-party-analyzer';
import { CriticalPathAnalyzer } from '../analyzers/performance/critical-path-analyzer';
import { ConnectionTimingAnalyzer } from '../analyzers/performance/connection-timing-analyzer';

// Content analyzers
import { LinkQualityAnalyzer } from '../analyzers/content/link-quality-analyzer';
import { ContentQualityAnalyzer } from '../analyzers/content/content-quality-analyzer';
import { FreshnessAnalyzer } from '../analyzers/content/freshness-analyzer';

// Accessibility analyzers
import { AccessibilityAnalyzer } from '../analyzers/accessibility/accessibility-analyzer';
import { MobileFriendlyAnalyzer } from '../analyzers/accessibility/mobile-friendly-analyzer';
import { FormAccessibilityAnalyzer } from '../analyzers/accessibility/form-accessibility-analyzer';

// International, Social, Analytics, Security
import { InternationalSEOAnalyzer } from '../analyzers/international/international-seo-analyzer';
import { SocialMediaAnalyzer } from '../analyzers/social/social-media-analyzer';
import { AnalyticsTrackingAnalyzer } from '../analyzers/analytics/analytics-tracking-analyzer';
import { SecurityAnalyzer } from '../analyzers/security/security-analyzer';
import { CookieConsentAnalyzer } from '../analyzers/security/cookie-consent-analyzer';
import { MixedContentAnalyzer } from '../analyzers/security/mixed-content-analyzer';

// New analyzers
import { RedirectChainAnalyzer } from '../analyzers/performance/redirect-chain-analyzer';
import { CompressionAnalyzer } from '../analyzers/performance/compression-analyzer';
import { ResourceHintsAnalyzer } from '../analyzers/performance/resource-hints-analyzer';
import { HTTPProtocolAnalyzer } from '../analyzers/performance/http-protocol-analyzer';
import { PWAAnalyzer } from '../analyzers/performance/pwa-analyzer';
import { AboveFoldAnalyzer } from '../analyzers/performance/above-fold-analyzer';
import { JavaScriptRenderingAnalyzer } from '../analyzers/seo/javascript-rendering-analyzer';
import { AnchorTextAnalyzer } from '../analyzers/seo/anchor-text-analyzer';
import { ExternalLinksAnalyzer } from '../analyzers/seo/external-links-analyzer';
import { AEOAnalyzer } from '../analyzers/seo/aeo-analyzer';
import { ResponseHeaderAnalyzer } from '../analyzers/seo/response-header-analyzer';
import { CTADetectorAnalyzer } from '../analyzers/content/cta-detector-analyzer';
import { LanguageDetectionAnalyzer } from '../analyzers/content/language-detection-analyzer';
import { CodeCoverageAnalyzer } from '../analyzers/performance/code-coverage-analyzer';
import { OutboundLinkChecker } from '../analyzers/content/outbound-link-checker';

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
  constructor(options: CrawlerEngineOptions & { config?: Record<string, unknown>; queryParams?: QueryParamConfig; cruxApiKey?: string | null }, callbacks: CrawlerCallbacks) {
    // Use config from options if provided, otherwise load fresh (for backward compat)
    const config = (options.config || loadConfig()) as Record<string, Record<string, unknown>>;

    this.#options = {
      concurrency: options.concurrency || 5,
      saveHtml: options.saveHtml || false,
      screenshots: options.screenshots || false,
      analysis: (config.analysis || {}) as Record<string, unknown>,
      perf: options.perf || false,
      origin: options.origin || '',
      networkConditions: options.networkConditions,
      cpuConditions: options.cpuConditions,
      verbose: options.verbose || false,
      userAgent: (config.crawl as Record<string, unknown> | undefined)?.userAgent as string | null ?? null,
      cruxApiKey: options.cruxApiKey || null,
      queryParams: options.queryParams || (config.queryParams as unknown as QueryParamConfig | undefined) || {
        mode: 'strip_tracking',
        whitelist: [],
        blacklist: [
          // Pagination
          'page', 'p', 'pg', 'paged', 'offset', 'limit', 'per_page', 'pagesize',
          // Sorting
          'sort', 'sortby', 'sort_by', 'order', 'orderby', 'order_by', 'dir', 'direction',
          // Filtering
          'filter', 'filters', 'type', 'category', 'cat', 'tag', 'tags',
          'color', 'size', 'brand', 'price', 'min_price', 'max_price',
          'q', 'query', 'search', 's', 'keyword', 'keywords',
          // View options
          'view', 'display', 'layout', 'columns', 'grid', 'list',
          // Session/state
          'ref', 'source', 'from', 'return', 'redirect', 'callback',
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
   * Extract values from Promise.allSettled results with fallback for rejected promises
   * @private
   * @param results - Promise.allSettled results
   * @param fallbacks - Fallback values for rejected promises (same length as results)
   * @param {string} url - URL being processed (for logging)
   * @returns Extracted values
   */
  #extractSettledResults(results: PromiseSettledResult<unknown>[], fallbacks: unknown[], url: string): unknown[] {
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Log the failure but continue with fallback
      console.log(`⚠️  Analyzer ${index} failed for ${url}: ${result.reason?.message || result.reason}`);
      return fallbacks[index];
    });
  }

  /**
   * Get backoff delay for an error type using exponential backoff
   * @private
   * @param {string} errorType - Type of error
   * @returns {number} Delay in milliseconds
   */
  #getBackoffDelay(errorType: string) {
    const state = this.#backoffState.get(errorType) || { attempts: 0, lastAttempt: 0 };
    const now = Date.now();

    // Reset if last attempt was more than 5 minutes ago
    if (now - state.lastAttempt > 300000) {
      state.attempts = 0;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const baseDelay = 1000;
    const maxDelay = 30000;
    const delay = Math.min(baseDelay * Math.pow(2, state.attempts), maxDelay);

    // Update state
    state.attempts++;
    state.lastAttempt = now;
    this.#backoffState.set(errorType, state);

    return delay;
  }

  /**
   * Check if circuit breaker should prevent crawling
   * Opens circuit after 10 consecutive failures, closes after 60s cooldown
   * @private
   * @returns {boolean} True if circuit is open (should skip)
   */
  #isCircuitOpen() {
    const now = Date.now();
    const CIRCUIT_THRESHOLD = 10; // Open after 10 consecutive failures
    const CIRCUIT_COOLDOWN = 60000; // 60 second cooldown

    if (this.#failureTracker.circuitOpen) {
      // Check if cooldown has passed
      if (now - this.#failureTracker.circuitOpenTime > CIRCUIT_COOLDOWN) {
        console.log('🔌 Circuit breaker: Cooldown passed, closing circuit (half-open state)');
        this.#failureTracker.circuitOpen = false;
        this.#failureTracker.consecutiveFailures = Math.floor(CIRCUIT_THRESHOLD / 2); // Half-open: reduce threshold
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Record a failure for circuit breaker
   * @private
   * @param {string} errorType - Type of error
   */
  #recordFailure(errorType: string) {
    const CIRCUIT_THRESHOLD = 10;

    this.#failureTracker.consecutiveFailures++;
    this.#failureTracker.lastFailureTime = Date.now();

    if (this.#failureTracker.consecutiveFailures >= CIRCUIT_THRESHOLD && !this.#failureTracker.circuitOpen) {
      console.warn(`⚡ Circuit breaker: Opening after ${CIRCUIT_THRESHOLD} consecutive failures`);
      this.#failureTracker.circuitOpen = true;
      this.#failureTracker.circuitOpenTime = Date.now();
    }
  }

  /**
   * Record a success - resets failure counter
   * @private
   */
  #recordSuccess() {
    this.#failureTracker.consecutiveFailures = 0;
    // Clear backoff state on success
    this.#backoffState.clear();
  }

  /**
   * Wrap a promise with a timeout
   * Uses AbortController pattern for cleaner cancellation handling
   * @private
   * @param {Promise} promise - Promise to wrap
   * @param {number} timeoutMs - Timeout in milliseconds
   * @param {string} message - Error message on timeout
   * @returns {Promise} Result of promise or timeout error
   */
  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string = "Observer timeout"): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          reject(new Error(message));
        }
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      settled = true;
      return result;
    } catch (error: unknown) {
      settled = true;
      throw error;
    } finally {
      clearTimeout(timeoutId);
      // Attach catch to original promise to prevent unhandled rejection warning
      // Only ignore errors if we timed out - otherwise log unexpected errors
      // that occur after the race is settled
      promise.catch((err) => {
        if (timedOut) {
          // Expected: timeout won the race, original promise rejected later
          // Log at debug level for troubleshooting
          console.debug?.(`[withTimeout] Post-timeout rejection for "${message}": ${err.message}`);
        } else if (!settled) {
          // Unexpected: promise rejected but race somehow didn't catch it
          console.error(`[withTimeout] Unexpected unhandled rejection: ${err.message}`);
        }
        // If settled is true and not timedOut, the error was already thrown/handled
      });
    }
  }

  /**
   * Perform basic page test - navigate and collect metrics
   * @private
   */
  async #basicTest(page: ChromePage, network: NetworkCondition, cpu: CpuCondition, url: string): Promise<BasicTestResult> {
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
      } catch (e: unknown) {
        // Body read failed - ignore
      }

      const resUrl = response.url();

      const now = Date.now();
      requests[response.url()] = {
        ...requests[resUrl],
        status: response.status(),
        endTime: now,
        duration: requests[resUrl]?.startTime
          ? now - requests[resUrl].startTime
          : 0,
        size,
      };
    };

    page.on("request", requestHandler);
    page.on("response", responseHandler);

    let response: PlaywrightResponse | null | undefined, status: number | undefined, redirectChain: RedirectEntry[], vitals: Partial<CollectedVitals>, metrics: PerformanceMetrics;

    try {
      if (this.#options.perf) {
        const session = await page.context().newCDPSession(page);

        // Enable performance metrics collection
        await session.send("Performance.enable");

        // Apply CPU throttling if needed
        if (!cpu.noThrottle && cpu.rate) {
          await session.send("Emulation.setCPUThrottlingRate", {
            rate: cpu.rate,
          });
        }

        // Apply network throttling if needed
        if (!network.noThrottle) {
          await session.send("Network.enable");

          await session.send("Network.emulateNetworkConditions", {
            offline: false,
            downloadThroughput: network.download ?? -1,
            uploadThroughput: network.upload ?? -1,
            latency: network.latency ?? 0,
          });
        }
      }

      // Start code coverage collection before navigation
      if (this.#options.perf) {
        await CodeCoverageAnalyzer.startCoverage(page).catch(() => {});
      }

      // Navigate to the page with explicit timeout
      response = await page.goto(url, {
        waitUntil: "load",
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
            status: redirectResponse?.status() || 'unknown',
          });
          currentRequest = redirectedFrom;
        } else {
          break;
        }
      }

      // Add final URL to chain
      if (redirectChain.length > 0) {
        redirectChain.push({
          url: response?.url() || url,
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
          nav: performance.getEntriesByType("navigation"),
          resources: performance.getEntriesByType("resource"),
          paint: performance.getEntriesByType("paint"),
        };
      });
    } finally {
      // Remove event listeners to prevent memory leaks - always runs even on error
      page.off("request", requestHandler);
      page.off("response", responseHandler);
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
  async crawlPages({ pagesToCrawl, collectedURLs, uniquePages, addMissing, results, incomingLinksTracking, sitemapUrls }: CrawlPagesParams) {
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
      const context = await browser.newContext(contextOptions as { viewport: { width: number; height: number }; userAgent?: string });

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
        const cruxApiKey = process.env.CRUX_API_KEY || this.#options.cruxApiKey || null;
        console.log(`\n📊 Fetching Chrome UX Report (CrUX) field data...${cruxApiKey ? ' (API key found)' : ''}`);
        try {
          results.cruxData = await CrUXAPI.fetchCrUXData(this.#options.origin, cruxApiKey);
          if (results.cruxData) {
            console.log(`   ✓ CrUX data available (${results.cruxData.targetType}-level)`);
            const cwvMetrics = ['LCP', 'CLS', 'INP'];
            for (const metric of cwvMetrics) {
              const data = results.cruxData.metrics?.[metric];
              if (data?.percentiles?.p75 !== undefined) {
                const p75 = metric === 'CLS' ? Number(data.percentiles.p75).toFixed(2) : `${Math.round(Number(data.percentiles.p75))}ms`;
                console.log(`     ${metric}: p75=${p75} (${data.distribution?.good || 0}% good)`);
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
      const progress = new ProgressReporter(pagesToCrawl.length, 2000, alreadyProcessedCount, colorScheme, this.#options.verbose);

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
        if (this.#isCircuitOpen()) {
          const cooldownRemaining = 60000 - (Date.now() - this.#failureTracker.circuitOpenTime);
          console.warn(`⚡ Circuit breaker open. Waiting ${Math.ceil(cooldownRemaining / 1000)}s before retrying...`);
          await new Promise(resolve => setTimeout(resolve, Math.min(cooldownRemaining, 10000)));
          continue; // Re-check circuit state
        }

        // Update total in case new pages were discovered (only happens when addMissing=true)
        progress.updateTotal(pagesToCrawl.length);

        const batchEnd = Math.min(batchStart + concurrency, pagesToCrawl.length);
        const batch = pagesToCrawl.slice(batchStart, batchEnd);

        // Process batch in parallel using Promise.allSettled to isolate failures
        // Add overall batch timeout to prevent indefinite hangs (5 minutes per batch)
        const BATCH_TIMEOUT = (CRAWL_SETTINGS.BATCH_TIMEOUT || 300000);
        const batchPromise = Promise.allSettled(batch.map(async (url: string) => {
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
              this.#recordFailure(pageResult.errorType || 'unknown');

              // Apply exponential backoff after failure
              const backoffDelay = this.#getBackoffDelay(pageResult.errorType || 'unknown');
              if (backoffDelay > 1000) {
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
              }
            } else {
              progress.success(url, duration);
              this.#recordSuccess();
            }
          } else {
            progress.success(url, duration);
            this.#recordSuccess();
          }

          return { url, pageResult, duration };
        }));

        // Wrap batch with timeout to prevent indefinite hangs
        let batchResults;
        try {
          batchResults = await this.#withTimeout(
            batchPromise,
            BATCH_TIMEOUT,
            `Batch timeout after ${BATCH_TIMEOUT / 1000}s for ${batch.length} URLs`
          );
        } catch (timeoutError: unknown) {
          console.warn(`⚠️  ${(timeoutError as Error).message}`);
          // On timeout, mark remaining URLs as failed and continue
          for (const url of batch) {
            if (!results.pageData.processedPages.has(url)) {
              failedPages.push(url);
              progress.fail(url, 'batch timeout');
              this.#recordFailure('batch_timeout');
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
          this.#callbacks.saveData();
        }
      }

      // Retry failed pages (separate queue, reduced concurrency)
      if (failedPages.length > 0 && !abortRequested) {
        const maxRetries = THRESHOLDS.RETRY_ATTEMPTS || 3;
        const retryPages = failedPages.filter(url => {
          const attempts = results.pageData.attempts[url] || 0;
          return attempts < maxRetries;
        });

        if (retryPages.length > 0) {
          console.log(`\n🔄 Retrying ${retryPages.length} failed page(s) (max ${maxRetries} attempts, concurrency: 1)...`);

          for (const url of retryPages) {
            if (abortRequested) break;
            if (results.pageData.processedPages.has(url)) continue;

            const attempt = (results.pageData.attempts[url] || 0) + 1;
            console.log(`   Retry ${attempt}/${maxRetries}: ${url}`);

            // Wait before retry with increasing delay
            await new Promise(r => setTimeout(r, 2000 * attempt));

            const startTime = Date.now();
            const pageResult = await this.#crawlSinglePage({
              url, context, results, incomingLinksTracking, sitemapUrls,
              collectedURLs, uniquePages, pagesToCrawl, addMissing,
              discoveredLinksSource, uniqueTitles, uniqueDescriptions,
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

          this.#callbacks.saveData();
        }
      }

      // Print crawl summary
      progress.printSummary();

      // Fetch per-URL CrUX field data (only in perf mode with API key)
      if (this.#options.perf && !abortRequested) {
        const cruxApiKey = process.env.CRUX_API_KEY || this.#options.cruxApiKey || null;
        if (cruxApiKey) {
          const processedUrls = Array.from(results.pageData.processedPages);
          const successUrls = processedUrls.filter(u => results.pageData.pages[u] && !results.pageData.pages[u].error);
          console.log(`\n🌐 Fetching per-URL CrUX field data for ${successUrls.length} page(s)...`);
          let cruxFound = 0;
          // Fetch in small batches to respect rate limits
          const CRUX_BATCH_SIZE = 5;
          for (let i = 0; i < successUrls.length; i += CRUX_BATCH_SIZE) {
            const urlBatch = successUrls.slice(i, i + CRUX_BATCH_SIZE);
            const cruxResults = await Promise.allSettled(
              urlBatch.map(url => CrUXAPI.fetchCrUXForUrl(url, cruxApiKey))
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
              await new Promise(r => setTimeout(r, 200));
            }
          }
          console.log(`   ✓ CrUX URL-level data found for ${cruxFound}/${successUrls.length} page(s)`);
        }
      }

      // Final save before converting data structures
      this.#callbacks.saveData();

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
        results.pageData.incomingLinks[target] = sourcesArray.length > 100
          ? sourcesArray.slice(0, 100)
          : sourcesArray;
        processedCount++;

        // Allow garbage collection periodically
        gcCounter++;
        if (gcCounter % (CHUNK_SIZE * 10) === 0 && global.gc) {
          global.gc();
        }
      }

      if (skippedCount > 0) {
        console.log(`  ⚠️  Truncated incoming links: kept ${processedCount}, skipped ${skippedCount} (limit: ${MAX_INCOMING_LINKS})`);
      }

      // Clear the tracking map to free memory
      incomingLinksTracking.clear();

      // After all pages are crawled, populate incoming links count for each page
      this.#populateIncomingLinksCount(results);

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
          console.error("Failed to close browser:", closeError);
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
      url, context, results, incomingLinksTracking, sitemapUrls,
      collectedURLs, uniquePages, pagesToCrawl, addMissing,
      discoveredLinksSource, uniqueTitles, uniqueDescriptions
    } = params;

    const chromePage = await context.newPage();
    let pageData = null;
    let isMultiLang = false;
    let failed = false;

    try {
      const page = await this.#withTimeout<BasicTestResult | null>(
        this.#basicTest(
          chromePage,
          this.#options.networkConditions.slow4g,
          this.#options.cpuConditions.normal,
          url
        )
          .then(async (data): Promise<BasicTestResult> => ({ ...data, url }))
          .catch((error: Error): null => {
            this.#handlePageError(error, url, results);
            return null;
          }),
        THRESHOLDS.PAGE_TIMEOUT,
        "Core Web Vitals test failed. Page failed to load " + url
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
      const errorType = this.#categorizeError(error as Error);
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
   * Categorize error type for better debugging and reporting
   * @private
   */
  #categorizeError(error: Error): string {
    const message = (error.message || '').toLowerCase();
    const name = (error.name || '').toLowerCase();

    // Timeout errors
    if (message.includes('timeout') || message.includes('timed out') ||
        name.includes('timeout') || message.includes('observer timeout')) {
      return 'timeout';
    }

    // DNS/Network resolution errors
    if (message.includes('err_name_not_resolved') || message.includes('getaddrinfo') ||
        message.includes('dns')) {
      return 'dns_error';
    }

    // Connection errors
    if (message.includes('err_connection') || message.includes('econnrefused') ||
        message.includes('econnreset') || message.includes('connection refused')) {
      return 'connection_error';
    }

    // SSL/TLS errors
    if (message.includes('ssl') || message.includes('certificate') ||
        message.includes('err_cert')) {
      return 'ssl_error';
    }

    // Too many redirects
    if (message.includes('err_too_many_redirects') || message.includes('redirect')) {
      return 'redirect_error';
    }

    // Navigation errors
    if (message.includes('navigation') || message.includes('net::')) {
      return 'navigation_error';
    }

    // Default to crashed
    return 'crashed';
  }

  /**
   * Get a user-friendly error explanation
   * @private
   */
  #getFriendlyErrorMessage(errorType: string, url: string): string {
    const messages = {
      timeout: 'Page took too long to load (>30s). The server may be slow or blocking automated requests.',
      dns_error: 'Could not resolve domain. Check the URL spelling and DNS configuration.',
      connection_error: 'Connection refused. The server may be down or blocking the request.',
      ssl_error: 'SSL/TLS certificate error. The site may have an expired or invalid certificate.',
      redirect_error: 'Too many redirects. Check for redirect loops in server configuration.',
      navigation_error: 'Navigation failed. The page may have returned an unexpected response.',
      crashed: 'Page caused the browser to crash. It may have excessive JavaScript or memory usage.',
    };
    return (messages as Record<string, string>)[errorType] || 'Unknown error occurred.';
  }

  /**
   * Handle page load error with categorization
   * @private
   */
  #handlePageError(error: Error, url: string, results: CrawlResults) {
    const errorType = this.#categorizeError(error);
    const messageOverall = `${error.name} ${error.message} ${(error as Error & { cause?: string }).cause || ''}`.trim();
    const friendlyMessage = this.#getFriendlyErrorMessage(errorType, url);

    // Log user-friendly message, with raw error in verbose or non-TTY mode
    if (this.#options.verbose) {
      console.log(`\x1b[31m✗\x1b[0m ${url}\n  [${errorType}] ${friendlyMessage}\n  Raw: ${messageOverall}`);
    } else {
      console.log(`\x1b[31m✗\x1b[0m ${url} - ${friendlyMessage}`);
    }

    results.pageData.totalWithError += 1;

    // Track by specific error type for better reporting
    if (!results.pageData.byError[errorType]) {
      results.pageData.byError[errorType] = [];
      results.pageData.byError[`total_${errorType}`] = 0;
    }

    (results.pageData.byError[errorType] as string[]).push(url);
    results.pageData.byError[`total_${errorType}`] = (results.pageData.byError[`total_${errorType}`] as number) + 1;

    // Also track in legacy "crashed" category for backwards compatibility
    if (errorType !== 'crashed') {
      if (!results.pageData.byError.crashed) {
        results.pageData.byError.crashed = [];
        results.pageData.byError.totalCrashed = 0;
      }
      (results.pageData.byError.crashed as string[]).push(url);
      results.pageData.byError.totalCrashed = (results.pageData.byError.totalCrashed as number) + 1;
    }

    this.#callbacks.saveAttempt(url);
    this.#callbacks.checkAttempts(url);
  }

  /**
   * Process page data after successful load
   * @private
   */
  async #processPageData(params: ProcessPageDataParams) {
    const {
      page, chromePage, url, results, incomingLinksTracking, sitemapUrls,
      collectedURLs, uniquePages, pagesToCrawl, addMissing,
      discoveredLinksSource, uniqueTitles, uniqueDescriptions
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
    if (!results.pageData || !results.pageData.pages) {
      throw new Error(`Corrupted results state: pageData or pages is undefined for URL ${url}`);
    }

    results.pageData.pages[url] = { url } as PageInfo;
    const pageData = results.pageData.pages[url];

    // Store redirect chain info
    this.#processRedirects(pageData, redirectChain, url);

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
      const msg = issue.message || '';
      this.#callbacks.saveError(
        msg.split('(')[0].trim(),
        `<a href="${escapedUrl}">${escapedUrl}</a>: ${escapeHtml(msg)}`,
        issue.severity
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
      const clsAnalysis = VitalsCollector.analyzeCLSSources(clsEntries as import('./vitals-collector').CLSEntry[]);
      pageData.vitals.clsAnalysis = clsAnalysis;
    }

    // Analyze long tasks if TBT is high
    if (longTasks && TBT != null && TBT > THRESHOLDS.TBT) {
      const tbtAnalysis = VitalsCollector.analyzeLongTasks(longTasks as import('./vitals-collector').LongTaskEntry[]);
      pageData.vitals.tbtAnalysis = tbtAnalysis;
    }

    // Other metrics
    pageData.requests = requests;
    pageData.metrics = metrics;
    pageData.blockers = blockers;
    pageData.totalResponseSize = totalResponseSize;
    pageData.response = { headers: responseHeaders || {} };

    // Check page size threshold
    if (totalResponseSize > THRESHOLDS.PAGE_SIZE) {
      const escapedUrl = escapeHtml(url);
      this.#callbacks.saveError(
        `Some pages size is too big`,
        `This page has size of ${totalResponseSize} bytes <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM
      );
    }

    const totalNumberOfRequests = Object.keys(requests).length;
    pageData.totalNumberOfRequests = totalNumberOfRequests;

    if (totalNumberOfRequests > THRESHOLDS.REQUEST_COUNT) {
      const escapedUrl = escapeHtml(url);
      this.#callbacks.saveError(
        `Some pages have too many requests`,
        `This page has ${totalNumberOfRequests} requests <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM
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
    this.#saveHtmlSnapshot(pageContent, url);

    // Save viewport screenshot if enabled
    await this.#saveScreenshot(chromePage, url);

    // Collect links and track incoming links
    const linksResult = await this.#collectLinks({
      parsedPage, url, results, incomingLinksTracking,
      collectedURLs, uniquePages, pagesToCrawl, addMissing, discoveredLinksSource, sitemapUrls
    });
    pageData.links = linksResult.links;
    pageData.httpLinksCount = linksResult.httpLinksCount;

    // Run all analyzers with error isolation
    // Wrap in try-catch to prevent analyzer failures from losing all page data
    try {
      await this.#runAnalyzers(chromePage, parsedPage, url, pageData, pageContent, requests, consoleData);
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
        SEVERITY.MEDIUM
      );
    }

    // Check Core Web Vitals thresholds
    this.#checkVitalsThresholds(pageData, url, TTFB ?? 0, FCP ?? 0, LCP ?? 0, CLS ?? 0);

    // Process title
    const title = await chromePage.evaluate(
      () => document.querySelector("title")?.innerText
    );
    const titleResult = this.#processTitle(title, url, uniqueTitles);
    if (titleResult.title) {
      pageData.title = titleResult.title;
      pageData.titleLength = titleResult.titleLength;
    }

    // Process meta tags
    const metaTags = await chromePage.evaluate(() =>
      Array.from(document.querySelectorAll("meta")).map((meta) => ({
        name: meta.name || meta.getAttribute("property"),
        content: meta.content,
      }))
    );
    this.#processMetaTags(metaTags, pageData, url, uniqueDescriptions);

    // Process link tags (canonical, alternates)
    const linkTags = await chromePage.evaluate(() =>
      Array.from(document.querySelectorAll("link")).map((link) => ({
        rel: link.rel,
        hrefLang: (link as unknown as { hrefLang: string }).hrefLang,
        href: link.href,
      }))
    );
    const linkResult = this.#processLinkTags(linkTags, pageData, url, sitemapUrls);
    const isMultiLang = linkResult.isMultiLang;

    results.pageData.processedPages.add(url);

    // Memory optimization: strip data after all processing is complete
    this.#optimizePageDataMemory(pageData);

    return { isMultiLang, failed: false };
  }

  /**
   * Optimize page data memory footprint after all processing is complete
   * Converts detailed arrays to summaries while preserving all issues/warnings for the report
   * @private
   */
  #optimizePageDataMemory(pageData: PageInfo) {
    // PageInfo has [key: string]: any index signature, allowing dynamic property access
    // Analyzer results often have more fields than the strict type definitions

    // 1. Strip raw schema data (can be huge for e-commerce Product schemas)
    const sd = pageData.structuredData as Record<string, unknown> | undefined;
    if (sd?.jsonLdSchemas) {
      for (const schema of sd.jsonLdSchemas as Array<Record<string, unknown>>) {
        delete schema.raw;
      }
    }

    // 2. Reduce requests object to summary (keeps type breakdown for report)
    if (pageData.requests && typeof pageData.requests === 'object' && !pageData.requests.totalRequests) {
      const entries = Object.entries(pageData.requests) as Array<[string, RequestInfo]>;
      const byType: Record<string, number> = {};
      let totalSize = 0;
      for (const [, req] of entries) {
        byType[req.resourceType || 'other'] = (byType[req.resourceType || 'other'] || 0) + 1;
        if (req.size) totalSize += req.size;
      }
      pageData.requests = { totalRequests: entries.length, byType, totalSize };
    }

    // 3. Keep only problematic links (links without text)
    if (Array.isArray(pageData.links)) {
      pageData.linksCount = pageData.links.length;
      pageData.internalLinksCount = pageData.links.filter((l: LinkEntry) => l.isInternal).length;
      pageData.externalLinksCount = pageData.links.filter((l: LinkEntry) => !l.isInternal).length;
      pageData.links = pageData.links.filter((l: LinkEntry) => !l.text || l.text.trim() === '').slice(0, 20);
    }

    // 4. Reduce images array (keep problematic ones)
    const imagesArr = pageData.images as unknown;
    if (Array.isArray(imagesArr)) {
      pageData.imagesCount = imagesArr.length;
      pageData.imagesWithoutAltCount = imagesArr.filter((i: { alt?: string }) => !i.alt || i.alt.trim() === '').length;
      (pageData as Record<string, unknown>).images = imagesArr.filter((i: { alt?: string }) => !i.alt || i.alt.trim() === '').slice(0, 10);
    }

    // 5. Strip vitals detail arrays (keep analysis summaries)
    if (pageData.vitals) {
      delete pageData.vitals.lcpSubParts;
      delete pageData.vitals.clsEntries;
      delete pageData.vitals.longTasks;
      if (pageData.vitals.lcpAnalysis) {
        pageData.vitals.lcpAnalysis = {
          bottleneck: pageData.vitals.lcpAnalysis.bottleneck,
          recommendation: pageData.vitals.lcpAnalysis.recommendation,
        };
      }
    }

    // 6. Delete heavy objects not needed for report
    delete pageData.metrics;
    delete pageData.blockers;

    // 7. Strip linkAnalysis (keep counts, issues, and fields needed by site-wide LinkStructureAnalyzer)
    if (pageData.linkAnalysis) {
      pageData.linkAnalysis = {
        internalLinks: pageData.linkAnalysis.internalLinks || 0,
        externalLinks: pageData.linkAnalysis.externalLinks || 0,
        brokenLinks: pageData.linkAnalysis.brokenLinks || 0,
        anchorTextMap: pageData.linkAnalysis.anchorTextMap,
        externalDomains: pageData.linkAnalysis.externalDomains,
        genericAnchorLinks: pageData.linkAnalysis.genericAnchorLinks,
        internalNofollowLinks: pageData.linkAnalysis.internalNofollowLinks,
        issues: pageData.linkAnalysis.issues,
        warnings: pageData.linkAnalysis.warnings,
      };
    }

    // 8. Strip contentQuality (keep scores and top keywords)
    if (pageData.contentQuality) {
      const cq = pageData.contentQuality as unknown as Record<string, unknown>;
      delete cq.keywords;
      if (Array.isArray(cq.topKeywords)) {
        cq.topKeywords = (cq.topKeywords as unknown[]).slice(0, 5);
      }
    }

    // 9. Strip third-party data (keep summary)
    if (pageData.thirdPartyData?.scripts) {
      pageData.thirdPartyData = {
        totalScripts: pageData.thirdPartyData.scripts.length,
        totalSize: pageData.thirdPartyData.totalSize || 0,
        issues: pageData.thirdPartyData.issues,
        warnings: pageData.thirdPartyData.warnings,
      };
    }

    // 10. Strip timing data (keep slow resources sample)
    if (pageData.timingData?.resourceTimings) {
      pageData.timingData = {
        slowResources: (pageData.timingData.slowResources || []).slice(0, 5),
        issues: pageData.timingData.issues,
        warnings: pageData.timingData.warnings,
      };
    }

    // 11. Strip critical path data (keep counts)
    if (pageData.criticalPathData?.blockingCSS) {
      pageData.criticalPathData = {
        blockingCSSCount: pageData.criticalPathData.blockingCSS?.length || 0,
        blockingJSCount: pageData.criticalPathData.blockingJS?.length || 0,
        issues: pageData.criticalPathData.issues,
        warnings: pageData.criticalPathData.warnings,
      };
    }

    // 12. Strip font data (keep count)
    if (pageData.fontData?.fonts) {
      pageData.fontData = {
        totalFonts: pageData.fontData.fonts.length,
        issues: pageData.fontData.issues,
        warnings: pageData.fontData.warnings,
      };
    }

    // 13. Strip compression data
    if (pageData.compressionData?.resources) {
      pageData.compressionData = {
        issues: pageData.compressionData.issues,
        warnings: pageData.compressionData.warnings,
      };
    }

    // 14. Strip image optimization data (keep counts needed by report)
    if (pageData.imageOptimization?.images) {
      const imgOpt = pageData.imageOptimization;
      pageData.imageOptimization = {
        totalImages: imgOpt.images.length,
        withLazyLoading: imgOpt.withLazyLoading || 0,
        modernFormats: imgOpt.modernFormats || 0,
        legacyFormats: imgOpt.legacyFormats || 0,
        totalImageSize: imgOpt.totalImageSize || 0,
        issues: imgOpt.issues,
        warnings: imgOpt.warnings,
      };
    }

    // 15. Strip console analysis (keep count)
    if (pageData.consoleAnalysis?.errors) {
      pageData.consoleAnalysis = {
        errorCount: pageData.consoleAnalysis.errors?.length || 0,
        warningCount: pageData.consoleAnalysis.warnings?.length || 0,
        issues: pageData.consoleAnalysis.issues,
      };
    }

    // 16. Strip form data (keep count and accessibility score)
    if (pageData.formData?.forms) {
      pageData.formData = {
        formCount: pageData.formData.forms.length,
        accessibilityScore: pageData.formData.accessibilityScore,
        totalInputs: pageData.formData.totalInputs || 0,
        inputsWithoutLabels: pageData.formData.inputsWithoutLabels || 0,
        inputsWithoutAutocomplete: pageData.formData.inputsWithoutAutocomplete || 0,
        issues: pageData.formData.issues,
        warnings: pageData.formData.warnings,
      };
    }

    // 17. Strip resource optimization (keep counts needed by report)
    if (pageData.resourceOptimization?.renderBlockingResources) {
      const resOpt = pageData.resourceOptimization;
      pageData.resourceOptimization = {
        renderBlockingCount: resOpt.renderBlockingResources?.length || 0,
        renderBlocking: { totalBlocking: resOpt.renderBlocking?.totalBlocking || resOpt.renderBlockingResources?.length || 0 },
        compression: { uncompressed: resOpt.compression?.uncompressed || 0 },
        minification: {
          unminifiedJS: resOpt.minification?.unminifiedJS || 0,
          unminifiedCSS: resOpt.minification?.unminifiedCSS || 0,
        },
        issues: resOpt.issues,
        warnings: resOpt.warnings,
      };
    }

    // 18. Strip headings (keep counts for all levels and first h1)
    const hdg = pageData.headings as Record<string, unknown> | undefined;
    if (hdg?.h1 && Array.isArray(hdg.h1)) {
      const h1Arr = hdg.h1 as string[];
      const h2Arr = hdg.h2 as string[] | undefined;
      const h3Arr = hdg.h3 as string[] | undefined;
      const h4Arr = hdg.h4 as string[] | undefined;
      const h5Arr = hdg.h5 as string[] | undefined;
      const h6Arr = hdg.h6 as string[] | undefined;
      pageData.headings = {
        h1Count: h1Arr.length,
        h2Count: h2Arr?.length || 0,
        h3Count: h3Arr?.length || 0,
        h4Count: h4Arr?.length || 0,
        h5Count: h5Arr?.length || 0,
        h6Count: h6Arr?.length || 0,
        h1: h1Arr.map((h: string) => typeof h === 'string' ? h.substring(0, 100) : h),
        issues: hdg.issues,
        warnings: hdg.warnings,
      } as unknown as import('../types').HeadingAnalysis;
    }

    // 19. Strip accessibility data (keep scores and summary counts for report)
    if (pageData.accessibility?.aria || pageData.accessibility?.violations) {
      const a11y = pageData.accessibility;
      pageData.accessibility = {
        violationCount: a11y.violations?.length || 0,
        a11yScore: a11y.a11yScore ?? null,
        aria: a11y.aria ? {
          valid: a11y.aria.valid || 0,
          invalid: a11y.aria.invalid || 0,
        } : null,
        forms: a11y.forms ? {
          inputsWithLabels: a11y.forms.inputsWithLabels || 0,
          inputsWithoutLabels: a11y.forms.inputsWithoutLabels || 0,
        } : null,
        semantic: a11y.semantic ? {
          hasMain: a11y.semantic.hasMain || false,
          hasNav: a11y.semantic.hasNav || false,
          hasHeader: a11y.semantic.hasHeader || false,
          hasFooter: a11y.semantic.hasFooter || false,
        } : null,
        keyboard: a11y.keyboard ? {
          elementsWithoutFocus: a11y.keyboard.elementsWithoutFocus || 0,
          positiveTabindex: a11y.keyboard.positiveTabindex || 0,
        } : null,
        issues: a11y.issues,
        warnings: a11y.warnings,
      };
    }

    // 20. Strip caching data (keep scores and counts for report)
    if (pageData.caching?.resources || pageData.caching?.cacheScore != null) {
      const cache = pageData.caching;
      pageData.caching = {
        cacheScore: cache.cacheScore ?? null,
        hasCDN: cache.hasCDN || false,
        cdnProvider: cache.cdnProvider || null,
        staticCached: cache.staticCached || 0,
        staticUncached: cache.staticUncached || 0,
        dynamicCached: cache.dynamicCached || 0,
        dynamicUncached: cache.dynamicUncached || 0,
        hasServiceWorker: cache.hasServiceWorker || false,
        cachedCount: cache.cachedCount || 0,
        uncachedCount: cache.uncachedCount || 0,
        issues: cache.issues,
        warnings: cache.warnings,
      };
    }

    // 21. Strip media data (keep counts)
    if (pageData.mediaData?.videos || pageData.mediaData?.audios) {
      pageData.mediaData = {
        videoCount: pageData.mediaData.videos?.length || 0,
        audioCount: pageData.mediaData.audios?.length || 0,
        issues: pageData.mediaData.issues,
        warnings: pageData.mediaData.warnings,
      };
    }

    // 22. Strip web component data
    if (pageData.webComponentData?.components) {
      pageData.webComponentData = {
        componentCount: pageData.webComponentData.components?.length || 0,
        issues: pageData.webComponentData.issues,
        warnings: pageData.webComponentData.warnings,
      };
    }

    // 23. Strip above-fold data (keep key metrics)
    if (pageData.aboveFoldData?.aboveFoldElements) {
      pageData.aboveFoldData = {
        lcpInViewport: pageData.aboveFoldData.lcpInViewport,
        renderBlockingResources: pageData.aboveFoldData.renderBlockingResources,
        aboveFoldImageSize: pageData.aboveFoldData.aboveFoldImageSize,
        issues: pageData.aboveFoldData.issues,
        warnings: pageData.aboveFoldData.warnings,
      };
    }

    // 24. Strip anchor text data
    if (pageData.anchorTextData?.anchors) {
      pageData.anchorTextData = {
        anchorCount: pageData.anchorTextData.anchors?.length || 0,
        issues: pageData.anchorTextData.issues,
        warnings: pageData.anchorTextData.warnings,
      };
    }

    // 25. Strip external links data
    if (pageData.externalLinksData?.links) {
      pageData.externalLinksData = {
        externalLinkCount: pageData.externalLinksData.links?.length || 0,
        issues: pageData.externalLinksData.issues,
        warnings: pageData.externalLinksData.warnings,
      };
    }

    // 26. Strip meta array (metaMap is more useful and smaller)
    if (Array.isArray(pageData.meta) && pageData.metaMap) {
      delete pageData.meta;
    }

    // 27. Strip URL analysis (keep issues only)
    const urlA = pageData.urlAnalysis as Record<string, unknown> | undefined;
    if (urlA?.components) {
      pageData.urlAnalysis = {
        depth: urlA.depth as number,
        length: urlA.length as number,
        hasParameters: urlA.hasParameters as boolean,
        issues: urlA.issues as Issue[],
      } as unknown as import('../types').UrlAnalysis;
    }

    // 28. Strip response object (headers are large and rarely needed after analysis)
    if (pageData.response?.headers) {
      delete pageData.response;
    }

    // 29. Strip redirect chain (keep URLs for tooltip, limit to 10)
    const rc = pageData.redirectChain;
    if (rc && Array.isArray(rc) && rc.length > 0) {
      pageData.redirectCount = rc.length;
      pageData.redirectChain = rc.slice(0, 10).map((r: RedirectEntry) => ({ url: r.url, status: r.status }));
    }

    // 30. Limit issues/warnings arrays on all analyzers to 20 each
    const limitArrays = (obj: Record<string, unknown>) => {
      if (obj?.issues && Array.isArray(obj.issues)) {
        obj.issues = obj.issues.slice(0, 20);
      }
      if (obj?.warnings && Array.isArray(obj.warnings)) {
        obj.warnings = obj.warnings.slice(0, 20);
      }
    };

    // Apply limits to all analyzer outputs
    ['linkAnalysis', 'accessibility', 'caching', 'contentQuality', 'imageOptimization',
     'resourceOptimization', 'structuredData', 'headings', 'internationalSEO',
     'thirdPartyData', 'timingData', 'criticalPathData', 'fontData', 'compressionData',
     'consoleAnalysis', 'formData', 'mediaData', 'webComponentData', 'aboveFoldData',
     'anchorTextData', 'externalLinksData', 'security'].forEach(key => {
      if (pageData[key]) {
        limitArrays(pageData[key]);
      }
    });
  }

  /**
   * Process redirect chain
   * @private
   */
  #processRedirects(pageData: PageInfo, redirectChain: RedirectEntry[], url: string) {
    pageData.redirectChain = redirectChain;
    pageData.hasRedirects = redirectChain.length > 0;
    // Chain includes final URL, so actual redirect count is length - 1
    pageData.redirectCount = Math.max(0, redirectChain.length - 1);

    if (redirectChain.length > 0) {
      const redirectCount = redirectChain.length - 1;
      const escapedUrl = escapeHtml(url);
      const escapedChain = redirectChain.map(r => escapeHtml(r.url)).join(' → ');
      if (redirectCount > 2) {
        this.#callbacks.saveError(
          `Some pages have too many redirects`,
          `<a href="${escapedUrl}">${escapedUrl}</a> has ${redirectCount} redirect(s): ${escapedChain}`,
          SEVERITY.HIGH
        );
      } else if (redirectCount > 0) {
        this.#callbacks.saveError(
          `Some pages have redirects`,
          `<a href="${escapedUrl}">${escapedUrl}</a> has ${redirectCount} redirect(s): ${escapedChain}`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Collect links from page
   * @private
   */
  async #collectLinks(params: CollectLinksParams) {
    const {
      parsedPage, url, results, incomingLinksTracking,
      collectedURLs, uniquePages, pagesToCrawl, addMissing, discoveredLinksSource, sitemapUrls
    } = params;

    const links: LinkEntry[] = [];
    let httpLinksCount = 0;

    for (const link of parsedPage.querySelectorAll("a")) {
      const href = link.attributes.href;
      const text = link.innerText || link.attributes["aria-label"];

      // Skip links without a valid href string (e.g. <a href> with no value)
      if (typeof href !== 'string' || !href) continue;

      // Skip pure anchor links
      if (href.startsWith('#')) {
        continue;
      }

      const isInternal = href?.startsWith(this.#options.origin) || href?.startsWith('/');

      if (isInternal) {
        let fullHref = href;
        if (href?.startsWith('/')) {
          try {
            const baseUrl = new URL(url);
            fullHref = `${baseUrl.protocol}//${baseUrl.host}${href}`;
          } catch (e: unknown) {
            continue;
          }
        }

        // Check HTTPS consistency
        if (this.#options.origin.startsWith('https://') && fullHref?.startsWith('http://')) {
          httpLinksCount++;
        }

        // Normalize URL: strip hash, handle query params based on config
        const normalizedHref = normalizeUrl(fullHref, this.#options.queryParams);

        // Track incoming links (store in Map, defer Array conversion to save time)
        if (!incomingLinksTracking.has(normalizedHref)) {
          incomingLinksTracking.set(normalizedHref, new Set());
        }
        incomingLinksTracking.get(normalizedHref)!.add(url);

        // Handle URL discovery with limit to prevent unbounded growth
        const maxDiscoveredUrls = CRAWL_SETTINGS.MAX_DISCOVERED_URLS || 100000;

        if (addMissing) {
          if (!collectedURLs.has(normalizedHref)) {
            // Check limit before adding new URLs
            if (pagesToCrawl.length < maxDiscoveredUrls) {
              pagesToCrawl.push(normalizedHref);
              collectedURLs.add(normalizedHref);
              uniquePages.add(normalizedHref);

              if (!sitemapUrls[normalizedHref]) {
                discoveredLinksSource.set(normalizedHref, url);
              }
            }
            // Silently skip URLs beyond the limit to prevent OOM
          }
        } else if (!uniquePages.has(normalizedHref)) {
          // Only track in collectedURLs if under limit
          if (collectedURLs.size < maxDiscoveredUrls) {
            collectedURLs.add(normalizedHref);

            if (!sitemapUrls[normalizedHref]) {
              discoveredLinksSource.set(normalizedHref, url);
            }
          }
        }
      }

      links.push({ text, href, isInternal });

      if (!text) {
        const escapedUrl = escapeHtml(url);
        const escapedHref = escapeHtml(href);
        this.#callbacks.saveError(
          `Some pages have links without any text`,
          `The page <a href="${escapedUrl}">${escapedUrl}</a> has a link without text "${escapedHref}"`,
          SEVERITY.MEDIUM
        );
      }
    }

    // Report HTTPS consistency issues
    if (httpLinksCount > 0) {
      const escapedUrl = escapeHtml(url);
      this.#callbacks.saveError(
        `Some pages have HTTP links on HTTPS site`,
        `<a href="${escapedUrl}">${escapedUrl}</a> has ${httpLinksCount} internal HTTP link(s) (should use HTTPS)`,
        SEVERITY.HIGH
      );
    }

    return { links, httpLinksCount };
  }

  /**
   * Run all analyzers on the page using parallel execution
   * Each analyzer group has a timeout to prevent hung analyzers from freezing the crawl
   * @private
   */
  async #runAnalyzers(chromePage: ChromePage, parsedPage: ParsedPage, url: string, pageData: PageInfo, pageContent: string, requests: Record<string, RequestInfo>, consoleData: unknown) {
    const analyzerTimeout = CRAWL_SETTINGS.ANALYZER_TIMEOUT || 10000;
    // Cast requests for analyzer compatibility (analyzers use broader parameter types)
    const analyzerRequests = requests as unknown as import('../types').NetworkRequest[];

    // ============================================================
    // GROUP 1: Browser-based analyzers (can run in parallel)
    // These read from the browser/parsed page independently
    // Using Promise.allSettled to prevent single analyzer failure from crashing the crawl
    // ============================================================

    // Default fallback values for failed analyzers
    const group1Fallbacks = [
      // Core SEO
      { issues: [], warnings: [] },  // headingResult
      [],  // images
      { issues: [], warnings: [] },  // linkQualityResult
      { issues: [], warnings: [] },  // structuredDataResult
      { issues: [], warnings: [] },  // indexabilityResult
      { issues: [], warnings: [] },  // crawlabilityResult
      { issues: [], warnings: [] },  // internationalSEOResult
      // Content & UX
      { issues: [], warnings: [] },  // mobileFriendlyResult
      { issues: [], warnings: [] },  // accessibilityResult
      { issues: [], warnings: [] },  // contentQualityResult
      { formData: null, issues: [], warnings: [] },  // formResult
      // Social & Analytics
      { issues: [], warnings: [] },  // socialMediaResult
      { issues: [], warnings: [] },  // analyticsResult
      // Security
      { issues: [], warnings: [] },  // securityResult
      { consentData: null, issues: [], warnings: [] },  // consentResult
      // Performance
      { issues: [], warnings: [] },  // cachingResult
      { issues: [], warnings: [] },  // imageOptimizationResult
      { issues: [], warnings: [] },  // resourceOptimizationResult
      { fontData: null, issues: [], warnings: [] },  // fontResult
      { thirdPartyData: null, issues: [], warnings: [] },  // thirdPartyResult
      { criticalPathData: null, issues: [], warnings: [] },  // criticalPathResult
      { timingData: null, issues: [], warnings: [] },  // connectionResult
      // Advanced
      { paginationData: null, issues: [], warnings: [] },  // paginationResult
      { mediaData: null, issues: [], warnings: [] },  // mediaResult
      { webComponentData: null, issues: [], warnings: [] },  // webComponentResult
      // AEO / AI Search Readiness
      { issues: [], warnings: [], info: {} },  // aeoResult
      // Technology
      { technologies: [], frameworks: [], cms: null },  // technologies
      // CTA Detection
      { ctas: [], summary: {}, issues: [], warnings: [] },  // ctaResult
      // Language Detection
      { info: null, issues: [], warnings: [] },  // langDetectionResult
    ];

    const browserAnalyzersSettled = await this.#withTimeout(
      Promise.allSettled([
      // Core SEO
      HeadingAnalyzer.analyzeHeadings(parsedPage, url),
      ImageAnalyzer.extractImageAlts(parsedPage),
      LinkQualityAnalyzer.analyzeLinkQuality(chromePage, parsedPage, url, this.#options.origin, {}),
      StructuredDataAnalyzer.analyzeStructuredData(chromePage),
      IndexabilityAnalyzer.analyzeIndexability(chromePage, parsedPage, url, pageData.status, pageData.responseHeaders),
      CrawlabilityAnalyzer.analyzeCrawlability(chromePage, parsedPage, url, pageData),
      InternationalSEOAnalyzer.analyzeInternationalSEO(chromePage, parsedPage, url, pageData.responseHeaders),

      // Content & UX
      MobileFriendlyAnalyzer.analyzeMobileFriendly(chromePage),
      AccessibilityAnalyzer.analyzeAccessibility(chromePage),
      ContentQualityAnalyzer.analyzeContentQuality(chromePage, url, pageContent),
      FormAccessibilityAnalyzer.analyze(chromePage, parsedPage, url),

      // Social & Analytics
      SocialMediaAnalyzer.analyzeSocialMediaTags(chromePage, parsedPage, url),
      AnalyticsTrackingAnalyzer.analyzeAnalyticsTracking(chromePage, parsedPage, url),

      // Security
      SecurityAnalyzer.analyzeSecurity(chromePage, parsedPage, url, pageData.responseHeaders),
      CookieConsentAnalyzer.analyze(chromePage, parsedPage, analyzerRequests, url),

      // Performance
      CachingAnalyzer.analyzeCaching(chromePage, analyzerRequests, url),
      ImageOptimizationAnalyzer.analyzeImageOptimization(chromePage, analyzerRequests, url),
      ResourceOptimizationAnalyzer.analyzeResourceOptimization(chromePage, analyzerRequests, url),
      FontLoadingAnalyzer.analyze(chromePage, parsedPage, analyzerRequests, url),
      ThirdPartyAnalyzer.analyze(chromePage, analyzerRequests, url, this.#options.origin),
      CriticalPathAnalyzer.analyze(chromePage, parsedPage, analyzerRequests, pageData.metrics, url),
      ConnectionTimingAnalyzer.analyze(chromePage, analyzerRequests, url),

      // Advanced
      PaginationAnalyzer.analyze(chromePage, parsedPage, url),
      MediaSEOAnalyzer.analyze(chromePage, parsedPage, pageData, url),
      WebComponentAnalyzer.analyze(chromePage, parsedPage, url),

      // AEO / AI Search Readiness
      AEOAnalyzer.analyze(chromePage, parsedPage, url),

      // Technology detection (with error handling)
      TechnologyDetector.detect(chromePage, parsedPage, pageContent, pageData.responseHeaders || {}, analyzerRequests)
        .catch(() => {
          const scriptSrcs = Object.keys(requests || {}).filter(u => u.endsWith('.js'));
          return TechnologyDetector.detectFromHtml(pageContent, pageData.responseHeaders || {}, scriptSrcs);
        }),

      // CTA Detection
      CTADetectorAnalyzer.analyzeCTAs(chromePage, parsedPage, url),

      // Language Detection
      LanguageDetectionAnalyzer.analyzeLanguage(chromePage, parsedPage, url, pageData),
    ]),
    analyzerTimeout,
    `Analyzer timeout for ${url}`
    );

    // Extract results with fallbacks for failed analyzers
    const browserAnalyzers = this.#extractSettledResults(browserAnalyzersSettled, group1Fallbacks, url);

    // Assign results from Group 1
    // Results come from Promise.allSettled extraction, cast to AnalyzerResult for typed access
    const [
      headingResult, images, linkQualityResult, structuredDataResult,
      indexabilityResult, crawlabilityResult, internationalSEOResult,
      mobileFriendlyResult, accessibilityResult, contentQualityResult, formResult,
      socialMediaResult, analyticsResult,
      securityResult, consentResult,
      cachingResult, imageOptimizationResult, resourceOptimizationResult,
      fontResult, thirdPartyResult, criticalPathResult, connectionResult,
      paginationResult, mediaResult, webComponentResult,
      aeoResult,
      technologies,
      ctaResult,
      langDetectionResult,
    ] = browserAnalyzers as AnalyzerResult[];

    // Apply results to pageData
    // Using PageInfo's [key: string]: any index signature for analyzer-specific properties
    // that may not match the strict typed fields exactly
    const pd = pageData as Record<string, unknown>;
    pd.headings = headingResult;
    pd.images = images;
    pd.linkAnalysis = linkQualityResult;
    pd.structuredData = structuredDataResult;
    pd.indexability = indexabilityResult;
    pd.crawlability = crawlabilityResult;
    pd.internationalSEO = internationalSEOResult;
    pd.mobileFriendly = mobileFriendlyResult;
    pd.accessibility = accessibilityResult;
    pd.contentQuality = contentQualityResult;
    pd.formData = (formResult as AnalyzerResult & { formData: unknown }).formData;
    pd.socialMedia = socialMediaResult;
    pd.analytics = analyticsResult;
    pd.security = securityResult;
    pd.consentData = (consentResult as AnalyzerResult & { consentData: unknown }).consentData;
    pd.caching = cachingResult;
    pd.imageOptimization = imageOptimizationResult;
    pd.resourceOptimization = resourceOptimizationResult;
    pd.fontData = (fontResult as AnalyzerResult & { fontData: unknown }).fontData;
    pd.thirdPartyData = (thirdPartyResult as AnalyzerResult & { thirdPartyData: unknown }).thirdPartyData;
    pd.criticalPathData = (criticalPathResult as AnalyzerResult & { criticalPathData: unknown }).criticalPathData;
    pd.timingData = (connectionResult as AnalyzerResult & { timingData: unknown }).timingData;
    pd.paginationData = (paginationResult as AnalyzerResult & { paginationData: unknown }).paginationData;
    pd.mediaData = (mediaResult as AnalyzerResult & { mediaData: unknown }).mediaData;
    pd.webComponentData = (webComponentResult as AnalyzerResult & { webComponentData: unknown }).webComponentData;
    pd.aeo = (aeoResult as AnalyzerResult & { info: unknown }).info;
    pd.technologies = technologies;
    pd.ctas = (ctaResult as AnalyzerResult & { ctas: unknown }).ctas;
    pd.ctaData = { ctas: (ctaResult as AnalyzerResult & { ctas: unknown }).ctas, summary: (ctaResult as AnalyzerResult & { summary: unknown }).summary };
    pd.languageDetection = (langDetectionResult as AnalyzerResult & { info: unknown }).info;

    // Report issues from Group 1
    [
      headingResult, linkQualityResult, structuredDataResult,
      indexabilityResult, crawlabilityResult, internationalSEOResult,
      mobileFriendlyResult, accessibilityResult, contentQualityResult, formResult,
      socialMediaResult, analyticsResult,
      securityResult, consentResult,
      cachingResult, imageOptimizationResult, resourceOptimizationResult,
      fontResult, thirdPartyResult, criticalPathResult, connectionResult,
      paginationResult, mediaResult, webComponentResult,
      aeoResult,
      ctaResult,
      langDetectionResult,
    ].forEach(result => this.#reportIssues(result as AnalyzerResult));

    // ============================================================
    // GROUP 2: Data-based analyzers (depend on Group 1 results)
    // These analyze pageData populated by Group 1
    // ============================================================

    // Soft 404 detection (needs contentQuality.wordCount from Group 1)
    const soft404Result = await this.#withTimeout(
      Soft404Analyzer.analyze(chromePage, parsedPage, url, pageData),
      analyzerTimeout,
      `Soft404 analyzer timeout for ${url}`
    ).catch(() => ({ soft404Data: null, issues: [], warnings: [] }));
    pageData.soft404 = soft404Result.soft404Data;
    this.#reportIssues(soft404Result);

    // Synchronous analyzers - run in parallel since they only read pageData
    // Using Promise.allSettled to prevent single analyzer failure from crashing the crawl
    const group2Fallbacks = [
      { issues: [], warnings: [] },  // urlArchResult
      { freshnessData: null, issues: [], warnings: [] },  // freshnessResult
      { issues: [], warnings: [] },  // eeatResult
      { issues: [], warnings: [] },  // schemaResult
      { issues: [], warnings: [] },  // technicalResult
      { issues: [], warnings: [] },  // thinContentResult
      { info: null, issues: [], warnings: [] },  // redirectResult
      { info: null, issues: [], warnings: [] },  // compressionResult
      { info: null, issues: [], warnings: [] },  // hintsResult
      { info: null, issues: [], warnings: [] },  // mixedResult
      { info: null, issues: [], warnings: [] },  // protocolResult
      { info: null, issues: [], warnings: [] },  // pwaResult
      { info: null, issues: [], warnings: [] },  // aboveFoldResult
      { info: null, issues: [], warnings: [] },  // anchorResult
      { info: null, issues: [], warnings: [] },  // externalLinksResult
      { info: null, issues: [], warnings: [] },  // responseHeaderResult
    ];

    const syncResultsSettled = await this.#withTimeout(
      Promise.allSettled([
        UrlArchitectureAnalyzer.analyze(url, pageData, this.#options.origin),
        FreshnessAnalyzer.analyze(pageData, pageData.response || {}, parsedPage),
        EEATAnalyzer.analyze(parsedPage, url, pageData),
        AdvancedSchemaValidator.validate(pageData, url),
        TechnicalSEOAnalyzer.analyze(parsedPage, url, pageData),
        ThinContentAnalyzer.analyze(pageData, url),
        RedirectChainAnalyzer.analyze(pageData, url),
        CompressionAnalyzer.analyze(pageData, url),
        ResourceHintsAnalyzer.analyze(pageData, url),
        MixedContentAnalyzer.analyze(pageData, url),
        HTTPProtocolAnalyzer.analyze(pageData, url),
        PWAAnalyzer.analyze(pageData, url),
        AboveFoldAnalyzer.analyze(pageData, url),
        AnchorTextAnalyzer.analyze(pageData, url),
        ExternalLinksAnalyzer.analyze(pageData, url),
        ResponseHeaderAnalyzer.analyze(pageData, url),
      ]),
      analyzerTimeout,
      `Sync analyzers timeout for ${url}`
    );

    // Extract results with fallbacks for failed analyzers
    const syncResults = this.#extractSettledResults(syncResultsSettled, group2Fallbacks, url);

    const [
      urlArchResult, freshnessResult, eeatResult, schemaResult, technicalResult,
      thinContentResult, redirectResult, compressionResult, hintsResult,
      mixedResult, protocolResult, pwaResult, aboveFoldResult,
      anchorResult, externalLinksResult, responseHeaderResult,
    ] = syncResults as Array<AnalyzerResult & { freshnessData?: unknown; info?: unknown }>;

    // Apply data results
    pageData.freshnessData = freshnessResult.freshnessData;
    pageData.redirectAnalysis = redirectResult.info;
    pageData.compressionData = compressionResult.info;
    pageData.resourceHintsData = hintsResult.info;
    pageData.mixedContentData = mixedResult.info;
    pageData.protocolData = protocolResult.info;
    pageData.pwaData = pwaResult.info;
    pageData.aboveFoldData = aboveFoldResult.info;
    pageData.anchorTextData = anchorResult.info;
    pageData.externalLinksData = externalLinksResult.info;
    pageData.responseHeaderAnalysis = responseHeaderResult.info;

    // Report issues from Group 2
    syncResults.forEach(result => this.#reportIssues(result as AnalyzerResult));

    // Console error analysis (independent)
    if (consoleData) {
      const consoleResult = ConsoleErrorAnalyzer.analyze(consoleData, url);
      pageData.consoleAnalysis = consoleResult.consoleAnalysis;
      this.#reportIssues(consoleResult);
    }

    // JavaScript rendering analysis (only if raw HTML available)
    if (pageData.rawHtml) {
      const jsRenderResult = JavaScriptRenderingAnalyzer.analyze(pageData, url);
      pageData.jsRenderingData = jsRenderResult.info;
      this.#reportIssues(jsRenderResult);
    }

    // Code coverage analysis (requires perf flag, uses Coverage API started before navigation)
    if (this.#options.perf) {
      try {
        const coverageResult = await this.#withTimeout(
          CodeCoverageAnalyzer.analyze(chromePage, analyzerRequests, url),
          analyzerTimeout,
          `Coverage analyzer timeout for ${url}`
        );
        pageData.codeCoverage = coverageResult.info;
        this.#reportIssues(coverageResult);
      } catch {
        pageData.codeCoverage = null;
      }
    }

    // Outbound link health check (async, rate-limited)
    try {
      const outboundResult = await this.#withTimeout(
        OutboundLinkChecker.analyze(pageData, url, this.#options.origin, this.#options.analysis),
        analyzerTimeout * 3, // Allow more time for external requests
        `Outbound link checker timeout for ${url}`
      );
      pageData.outboundLinkHealth = outboundResult.info;
      this.#reportIssues(outboundResult);
    } catch {
      pageData.outboundLinkHealth = null;
    }
  }

  /**
   * Report issues and warnings from analyzer result
   * @private
   */
  #reportIssues(result: AnalyzerResult) {
    for (const issue of result.issues || []) {
      this.#callbacks.saveError(issue.message || '', issue.detail || '', issue.severity);
    }
    for (const warning of result.warnings || []) {
      this.#callbacks.saveError(warning.message || '', warning.detail || '', warning.severity);
    }
  }

  /**
   * Check Core Web Vitals thresholds
   * @private
   */
  #checkVitalsThresholds(pageData: PageInfo, url: string, TTFB: number, FCP: number, LCP: number, CLS: number) {
    const vitals = pageData.vitals || {};

    const escapedUrlForVitals = escapeHtml(url);

    if (TTFB > THRESHOLDS.TTFB) {
      this.#callbacks.saveError(
        `Some pages have TTFB more than ${THRESHOLDS.TTFB}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has TTFB ${Math.round(TTFB)}ms (threshold: ${THRESHOLDS.TTFB}ms)`,
        SEVERITY.HIGH
      );
    }

    if (FCP > THRESHOLDS.FCP) {
      this.#callbacks.saveError(
        `Some pages have FCP more than ${THRESHOLDS.FCP}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has FCP ${Math.round(FCP)}ms (threshold: ${THRESHOLDS.FCP}ms)`,
        SEVERITY.HIGH
      );
    }

    if (LCP > THRESHOLDS.LCP) {
      // Include LCP element attribution for debugging
      const lcpInfo = vitals.lcpElement ? ` (LCP element: ${escapeHtml(vitals.lcpElement)}${vitals.lcpUrl ? ', ' + escapeHtml(vitals.lcpUrl) : ''})` : '';
      this.#callbacks.saveError(
        `Some pages have LCP more than ${THRESHOLDS.LCP}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has LCP ${Math.round(LCP)}ms (threshold: ${THRESHOLDS.LCP}ms)${lcpInfo}`,
        SEVERITY.HIGH
      );
    }

    if (CLS > THRESHOLDS.CLS) {
      // Include CLS shift count for debugging
      const clsInfo = vitals.clsShiftCount ? ` (${vitals.clsShiftCount} layout shifts)` : '';
      this.#callbacks.saveError(
        `Some pages have CLS more than ${THRESHOLDS.CLS}`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has CLS ${CLS.toFixed(3)} (threshold: ${THRESHOLDS.CLS})${clsInfo}`,
        SEVERITY.HIGH
      );
    }

    // INP check (only if measured - requires user interaction)
    const INP = pageData.INP;
    if (INP && INP > THRESHOLDS.INP) {
      const inpInfo = vitals.inpEvent ? ` (slowest interaction: ${escapeHtml(vitals.inpEvent)})` : '';
      this.#callbacks.saveError(
        `Some pages have INP more than ${THRESHOLDS.INP}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has INP ${Math.round(INP)}ms (threshold: ${THRESHOLDS.INP}ms)${inpInfo}`,
        SEVERITY.HIGH
      );
    }

    // TBT check (Total Blocking Time)
    const TBT = pageData.TBT;
    if (TBT && TBT > THRESHOLDS.TBT) {
      const longTaskCount = vitals.longTasks?.length || 0;
      const tbtInfo = longTaskCount > 0 ? ` (${longTaskCount} long tasks detected)` : '';
      this.#callbacks.saveError(
        `Some pages have TBT more than ${THRESHOLDS.TBT}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has Total Blocking Time ${Math.round(TBT)}ms (threshold: ${THRESHOLDS.TBT}ms)${tbtInfo}`,
        TBT > 600 ? SEVERITY.HIGH : SEVERITY.MEDIUM
      );
    }

    // TTI check (Time to Interactive)
    const TTI = pageData.TTI;
    if (TTI && TTI > THRESHOLDS.TTI) {
      this.#callbacks.saveError(
        `Some pages have TTI more than ${THRESHOLDS.TTI}ms`,
        `The page <a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> has Time to Interactive ${Math.round(TTI)}ms (threshold: ${THRESHOLDS.TTI}ms)`,
        TTI > 7300 ? SEVERITY.HIGH : SEVERITY.MEDIUM
      );
    }

    // LCP sub-parts analysis for failed LCP
    if (LCP > THRESHOLDS.LCP && vitals.lcpAnalysis) {
      const { bottleneck, percentages, recommendations, recommendation } = vitals.lcpAnalysis;
      if (bottleneck && bottleneck !== 'none') {
        const bottleneckNames = {
          ttfb: 'Server Response (TTFB)',
          resourceDelay: 'Resource Discovery Delay',
          resourceLoad: 'Resource Load Time',
          renderDelay: 'Render Delay',
        };
        const rec = recommendation || recommendations?.[0] || '';
        // percentages may be undefined if memory optimization already ran
        const breakdown = percentages
          ? `LCP breakdown: TTFB ${percentages.ttfb}%, Resource Delay ${percentages.resourceDelay}%, Load ${percentages.resourceLoad}%, Render ${percentages.renderDelay}%. `
          : '';
        this.#callbacks.saveError(
          `LCP bottleneck: ${(bottleneckNames as Record<string, string>)[bottleneck] || bottleneck}`,
          `<a href="${escapedUrlForVitals}">${escapedUrlForVitals}</a> ${breakdown}${escapeHtml(rec)}`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Process title
   * @private
   */
  #processTitle(title: string | null | undefined, url: string, uniqueTitles: Set<string>) {
    const escapedUrl = escapeHtml(url);
    const maxTitleLength = CRAWL_SETTINGS.MAX_TITLE_LENGTH || 500;

    if (!title) {
      this.#callbacks.saveError(
        `Title is missing`,
        `Title is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.CRITICAL
      );
      return { title: null, titleLength: 0 };
    }

    // Truncate excessively long titles to prevent memory issues
    const originalLength = title.length;
    let processedTitle = title;
    if (originalLength > maxTitleLength) {
      processedTitle = title.substring(0, maxTitleLength) + '...';
    }

    const titleLength = originalLength;

    if (titleLength < THRESHOLDS.TITLE_MIN) {
      this.#callbacks.saveError(
        `Some pages have titles that are too short`,
        `The page <a href="${escapedUrl}">${escapedUrl}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
        SEVERITY.MEDIUM
      );
    } else if (titleLength > THRESHOLDS.TITLE_MAX) {
      this.#callbacks.saveError(
        `Some pages have titles that are too long`,
        `The page <a href="${escapedUrl}">${escapedUrl}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
        SEVERITY.MEDIUM
      );
    }

    // Normalize title for duplicate comparison (handles whitespace variations)
    const normalizedTitle = normalizeTextForComparison(title);
    if (uniqueTitles.has(normalizedTitle)) {
      this.#callbacks.saveError(
        `Some pages have identical titles`,
        `Title "${escapeHtml(title)}" is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.HIGH
      );
    }

    uniqueTitles.add(normalizedTitle);
    return { title: processedTitle, titleLength };
  }

  /**
   * Process meta tags
   * @private
   */
  #processMetaTags(metaTags: MetaTag[], pageData: PageInfo, url: string, uniqueDescriptions: Set<string>) {
    const escapedUrl = escapeHtml(url);

    // Store meta tags as both array (backwards compatible) and object (easier access)
    pageData.meta = [];
    pageData.metaMap = {};

    for (const metaTag of metaTags) {
      const name = metaTag.name;
      const content = metaTag.content;

      if (!name) continue;

      // Store in metaMap for easy access
      pageData.metaMap[name] = content;

      // Store in meta array for backwards compatibility
      if (META_TAGS.includes(name) || (META_TAGS_CONFIG.optional as readonly string[]).includes(name)) {
        pageData.meta.push({ [name]: content });
      }

      // Special handling for description
      if (name === "description") {
        const maxDescLength = CRAWL_SETTINGS.MAX_DESCRIPTION_LENGTH || 1000;
        const descLength = content ? content.length : 0;
        // Truncate excessively long descriptions to prevent memory issues
        const processedContent = content && content.length > maxDescLength
          ? content.substring(0, maxDescLength) + '...'
          : content;
        pageData.description = processedContent;
        pageData.descriptionLength = descLength;

        if (descLength < THRESHOLDS.DESCRIPTION_MIN) {
          this.#callbacks.saveError(
            `Some pages have descriptions that are too short`,
            `The page <a href="${escapedUrl}">${escapedUrl}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
            SEVERITY.MEDIUM
          );
        } else if (descLength > THRESHOLDS.DESCRIPTION_MAX) {
          this.#callbacks.saveError(
            `Some pages have descriptions that are too long`,
            `The page <a href="${escapedUrl}">${escapedUrl}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
            SEVERITY.MEDIUM
          );
        }

        // Normalize description for duplicate comparison (handles whitespace variations)
        const normalizedDesc = normalizeTextForComparison(content);
        if (content && uniqueDescriptions.has(normalizedDesc)) {
          this.#callbacks.saveError(
            `Some pages have identical descriptions`,
            `Description "${escapeHtml(content.substring(0, 50))}..." is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
            SEVERITY.HIGH
          );
        }

        if (content) {
          uniqueDescriptions.add(normalizedDesc);
        }
      }

      // Check for deprecated keywords meta tag
      if (name === "keywords" && content) {
        // Just note it in pageData, don't report as error (deprecated but not harmful)
        pageData.hasKeywords = true;
      }
    }

    // Check for missing critical and required meta tags
    this.#checkMissingMetaTags(pageData, url);
  }

  /**
   * Check for missing meta tags with appropriate severity levels
   * @private
   */
  #checkMissingMetaTags(pageData: PageInfo, url: string) {
    const escapedUrl = escapeHtml(url);
    const presentTags = new Set(Object.keys(pageData.metaMap));

    // Check critical tags only - description
    // (Social tags are handled by SocialMediaAnalyzer to avoid duplicate errors)
    // (Viewport is handled by MobileFriendlyAnalyzer with detailed validation)
    for (const tag of META_TAGS_CONFIG.critical) {
      if (!presentTags.has(tag)) {
        if (tag === 'description' && !pageData.description) {
          this.#callbacks.saveError(
            `Description meta tag is missing`,
            `Meta description is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
            SEVERITY.CRITICAL
          );
        }
      }
    }

    // Track viewport presence for reference (detailed check in MobileFriendlyAnalyzer)
    pageData.hasViewport = presentTags.has('viewport');
  }

  /**
   * Process link tags (canonical, alternates)
   * @private
   */
  #processLinkTags(linkTags: LinkTag[], pageData: PageInfo, url: string, sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>) {
    const escapedUrl = escapeHtml(url);
    let isMultiLang = false;

    for (const link of linkTags) {
      const rel = link.rel;

      if (rel === "canonical") {
        pageData.canonical = link.href;
      }

      if (rel === "alternate") {
        if (link.hrefLang && link.hrefLang !== "x-default") {
          isMultiLang = true;
        }

        if (!pageData.alternates) {
          pageData.alternates = [];
        }

        pageData.alternates.push({
          hreflang: link.hrefLang,
          href: link.href,
        });
      }
    }

    // Validate canonical
    if (!pageData.canonical) {
      this.#callbacks.saveError(
        `Canonicals are not set for some pages`,
        `Canonical link is missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.HIGH
      );
    }

    // Validate alternates
    if (isMultiLang && !pageData.alternates) {
      this.#callbacks.saveError(
        `Alternates are not set for some pages`,
        `Alternates links are missing for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.MEDIUM
      );
    } else if (pageData.alternates) {
      this.#checkAlternateDuplicates(pageData.alternates, url);
    }

    // Validate canonical matches sitemap
    this.#validateCanonicalMatchesSitemap(pageData, url, sitemapUrls);

    return { isMultiLang };
  }

  /**
   * Check for duplicate alternates
   * @private
   */
  #checkAlternateDuplicates(alternates: AlternateEntry[], url: string) {
    const escapedUrl = escapeHtml(url);
    for (const alternate of alternates) {
      const count = alternates.reduce((acc, cur) => {
        if (cur.href === alternate.href) {
          return (acc += 1);
        }
        return acc;
      }, 0);

      if (count > 1) {
        this.#callbacks.saveError(
          `Some alternates are duplicated in head links`,
          `Alternate ${escapeHtml(alternate.href)} is duplicated for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Validate canonical matches sitemap
   * @private
   */
  #validateCanonicalMatchesSitemap(pageData: PageInfo, url: string, sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>) {
    const escapedUrl = escapeHtml(url);
    const canonical = pageData.canonical || '';
    const escapedCanonical = escapeHtml(canonical);
    const matchingCanonical =
      sitemapUrls[canonical] ||
      sitemapUrls[`${this.#options.origin}/${canonical}`];

    if (matchingCanonical) {
      if (matchingCanonical.alternates) {
        if (pageData.alternates) {
          for (const pageAlternate of pageData.alternates) {
            if (!matchingCanonical.alternates[pageAlternate.href]) {
              this.#callbacks.saveError(
                `Some alternates from sitemap don't match alternates from pages`,
                `Alternate ${escapeHtml(pageAlternate.href)} has no match in sitemap for loc ${escapedCanonical} for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
                SEVERITY.MEDIUM
              );
            }
          }
        }

        if (Array.isArray(pageData.alternates)) {
          for (const pageAlternate of pageData.alternates) {
            const sitemapAlternate = matchingCanonical.alternates[pageAlternate.href];

            if (sitemapAlternate) {
              if (sitemapAlternate.hreflang !== pageAlternate.hreflang) {
                this.#callbacks.saveError(
                  `Some alternate hreflangs from sitemap don't match alternate hreflangs from pages`,
                  `Alternate hreflangs ${escapeHtml(pageAlternate.hreflang)} doesn't match sitemap hreflang ${escapeHtml(sitemapAlternate.hreflang)} for loc ${escapedCanonical} for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
                  SEVERITY.MEDIUM
                );
              }
            }
          }
        }
      }
    } else {
      this.#callbacks.saveError(
        `Some loc and canonical don't match`,
        `No matching loc corresponding canonical ${escapedCanonical} is found for this page <a href="${escapedUrl}">${escapedUrl}</a>`,
        SEVERITY.HIGH
      );
    }
  }

  /**
   * Save HTML snapshot
   * @private
   */
  #saveHtmlSnapshot(pageContent: string, url: string) {
    if (!this.#options.saveHtml) {
      return;
    }

    const folderName = `audit_${createSafeFilename(this.#options.origin)}`;
    const folder = path.join(process.cwd(), folderName);

    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error: unknown) {
      console.error(`Failed to create directory ${folder}:`, (error as Error).message);
      return;
    }

    const safeFilename = createSafeFilename(url);
    const filePath = path.join(folder, `${safeFilename}.html`);

    try {
      fs.writeFileSync(filePath, pageContent);
    } catch (error: unknown) {
      console.error(`Failed to write file ${filePath}:`, (error as Error).message);
    }
  }

  /**
   * Save viewport screenshot
   * @private
   */
  async #saveScreenshot(chromePage: ChromePage, url: string) {
    if (!this.#options.screenshots) {
      return;
    }

    const folderName = `audit_${createSafeFilename(this.#options.origin)}`;
    const folder = path.join(process.cwd(), folderName, 'screenshots');

    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error: unknown) {
      console.error(`Failed to create screenshots directory ${folder}:`, (error as Error).message);
      return;
    }

    const safeFilename = createSafeFilename(url);
    const filePath = path.join(folder, `${safeFilename}.png`);

    try {
      await chromePage.screenshot({ path: filePath, fullPage: false });
    } catch (error: unknown) {
      // Screenshot failures are non-critical
      if (this.#options.verbose) {
        console.error(`Failed to capture screenshot for ${url}:`, (error as Error).message);
      }
    }
  }

  /**
   * Populate incoming links count for each page
   * @private
   */
  #populateIncomingLinksCount(results: CrawlResults) {
    for (const url in results.pageData.pages) {
      const incomingLinksArray = results.pageData.incomingLinks?.[url] || [];
      const incomingLinksCount = Array.isArray(incomingLinksArray) ? incomingLinksArray.length : 0;
      results.pageData.pages[url].incomingLinksCount = incomingLinksCount;
      results.pageData.pages[url].hasIncomingLinks = incomingLinksCount > 0;
    }
  }
}

export { CrawlerEngine };