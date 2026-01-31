/**
 * Crawler Engine
 * Handles page crawling, analysis orchestration, and data collection
 */

const { parse } = require("node-html-parser");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const { KNOWN_ERRORS, SEVERITY, THRESHOLDS, META_TAGS, META_TAGS_CONFIG, getMetaTagSeverity } = require("../constants");
const { stripHashFragment, createSafeFilename, analyzeUrlStructure } = require("../utils");
const { ProgressReporter } = require("../utils/progress-reporter");
const { VitalsCollector } = require("./vitals-collector");
const { CrUXAPI } = require("./crux-api");

// SEO analyzers
const { HeadingAnalyzer } = require('../analyzers/seo/heading-analyzer');
const { ImageAnalyzer } = require('../analyzers/seo/image-analyzer');
const { StructuredDataAnalyzer } = require('../analyzers/seo/structured-data-analyzer');
const { IndexabilityAnalyzer } = require('../analyzers/seo/indexability-analyzer');
const { CrawlabilityAnalyzer } = require('../analyzers/seo/crawlability-analyzer');
const { UrlArchitectureAnalyzer } = require('../analyzers/seo/url-architecture-analyzer');
const { EEATAnalyzer } = require('../analyzers/seo/eeat-analyzer');
const { AdvancedSchemaValidator } = require('../analyzers/seo/advanced-schema-validator');
const { TechnicalSEOAnalyzer } = require('../analyzers/seo/technical-seo-analyzer');
const { ThinContentAnalyzer } = require('../analyzers/content/thin-content-analyzer');
const { Soft404Analyzer } = require('../analyzers/seo/soft-404-analyzer');
const { ConsoleErrorAnalyzer } = require('../analyzers/seo/console-error-analyzer');
const { PaginationAnalyzer } = require('../analyzers/seo/pagination-analyzer');
const { MediaSEOAnalyzer } = require('../analyzers/seo/media-seo-analyzer');
const { WebComponentAnalyzer } = require('../analyzers/seo/web-component-analyzer');

// Performance analyzers
const { ImageOptimizationAnalyzer } = require('../analyzers/performance/image-optimization-analyzer');
const { ResourceOptimizationAnalyzer } = require('../analyzers/performance/resource-optimization-analyzer');
const { CachingAnalyzer } = require('../analyzers/performance/caching-analyzer');
const { FontLoadingAnalyzer } = require('../analyzers/performance/font-loading-analyzer');
const { ThirdPartyAnalyzer } = require('../analyzers/performance/third-party-analyzer');
const { CriticalPathAnalyzer } = require('../analyzers/performance/critical-path-analyzer');
const { ConnectionTimingAnalyzer } = require('../analyzers/performance/connection-timing-analyzer');

// Content analyzers
const { LinkQualityAnalyzer } = require('../analyzers/content/link-quality-analyzer');
const { ContentQualityAnalyzer } = require('../analyzers/content/content-quality-analyzer');
const { FreshnessAnalyzer } = require('../analyzers/content/freshness-analyzer');

// Accessibility analyzers
const { AccessibilityAnalyzer } = require('../analyzers/accessibility/accessibility-analyzer');
const { MobileFriendlyAnalyzer } = require('../analyzers/accessibility/mobile-friendly-analyzer');
const { FormAccessibilityAnalyzer } = require('../analyzers/accessibility/form-accessibility-analyzer');

// International, Social, Analytics, Security
const { InternationalSEOAnalyzer } = require('../analyzers/international/international-seo-analyzer');
const { SocialMediaAnalyzer } = require('../analyzers/social/social-media-analyzer');
const { AnalyticsTrackingAnalyzer } = require('../analyzers/analytics/analytics-tracking-analyzer');
const { SecurityAnalyzer } = require('../analyzers/security/security-analyzer');
const { CookieConsentAnalyzer } = require('../analyzers/security/cookie-consent-analyzer');
const { MixedContentAnalyzer } = require('../analyzers/security/mixed-content-analyzer');

// New analyzers
const { RedirectChainAnalyzer } = require('../analyzers/performance/redirect-chain-analyzer');
const { CompressionAnalyzer } = require('../analyzers/performance/compression-analyzer');
const { ResourceHintsAnalyzer } = require('../analyzers/performance/resource-hints-analyzer');
const { HTTPProtocolAnalyzer } = require('../analyzers/performance/http-protocol-analyzer');
const { PWAAnalyzer } = require('../analyzers/performance/pwa-analyzer');
const { AboveFoldAnalyzer } = require('../analyzers/performance/above-fold-analyzer');
const { JavaScriptRenderingAnalyzer } = require('../analyzers/seo/javascript-rendering-analyzer');
const { AnchorTextAnalyzer } = require('../analyzers/seo/anchor-text-analyzer');
const { ExternalLinksAnalyzer } = require('../analyzers/seo/external-links-analyzer');

class CrawlerEngine {
  #options;
  #callbacks;

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
  constructor(options, callbacks) {
    this.#options = {
      concurrency: options.concurrency || 5,
      saveHtml: options.saveHtml || false,
      perf: options.perf || false,
      origin: options.origin,
      networkConditions: options.networkConditions,
      cpuConditions: options.cpuConditions,
    };
    this.#callbacks = callbacks;
  }

  /**
   * Wrap a promise with a timeout
   * @private
   */
  async #withTimeout(promise, timeoutMs, message = "Observer timeout") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs)
      ),
    ]);
  }

  /**
   * Perform basic page test - navigate and collect metrics
   * @private
   */
  async #basicTest(page, network, cpu, url) {
    const requests = {};
    let totalResponseSize = 0;

    // Set up console error tracking
    const consoleTracker = ConsoleErrorAnalyzer.createConsoleTracker(page);

    // Define handlers so we can remove them later
    const requestHandler = async (request) => {
      requests[request.url()] = {
        resourceType: request.resourceType(),
        method: request.method(),
        startTime: Date.now(),
      };
    };

    const responseHandler = async (response) => {
      let size = null;

      try {
        const body = await response.body();
        size = body.length;
        totalResponseSize += size;
      } catch (e) {
        // Body read failed - ignore
      }

      const resUrl = response.url();

      requests[response.url()] = {
        ...requests[resUrl],
        status: response.status(),
        endTime: Date.now(),
        duration: requests[resUrl]?.endTime && requests[resUrl]?.startTime
          ? requests[resUrl].endTime - requests[resUrl].startTime
          : 0,
        size,
      };
    };

    page.on("request", requestHandler);
    page.on("response", responseHandler);

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
          downloadThroughput: network.download,
          uploadThroughput: network.upload,
          latency: network.latency,
        });
      }
    }

    // Navigate to the page
    const response = await page.goto(url, { waitUntil: "load" });

    const status = response?.status();

    // Track redirects
    const redirectChain = [];
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
        status: status,
      });
    }

    let vitals = {};

    if (this.#options.perf) {
      if (status === 200) {
        console.log(`Collect vitals: ${status} ${url}`);

        // Collect performance metrics
        vitals = await VitalsCollector.collectVitals(page);
      } else {
        console.log(`Error: ${status} ${url}`);
      }
    }

    const metrics = await page.evaluate(() => {
      return {
        nav: performance.getEntriesByType("navigation"),
        resources: performance.getEntriesByType("resource"),
        paint: performance.getEntriesByType("paint"),
      };
    });

    // Remove event listeners to prevent memory leaks
    page.off("request", requestHandler);
    page.off("response", responseHandler);

    // Get console data and cleanup
    const consoleData = consoleTracker.getResults();
    consoleTracker.cleanup();

    // Capture response headers for freshness analysis
    const responseHeaders = {};
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
  async crawlPages({ pagesToCrawl, collectedURLs, uniquePages, addMissing, results, incomingLinksTracking, sitemapUrls }) {
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 414, height: 896 },
      });

      const alternatesErrors = [];
      const uniqueTitles = new Set();
      const uniqueDescriptions = new Set();
      const failedPages = [];
      const discoveredLinksSource = new Map();

      let isMultiLang = false;
      let saveCounter = 0; // Track saves to reduce frequency

      // Track pages already processed at start (for resume) to avoid double-counting in progress
      const alreadyProcessedAtStart = new Set(results.pageData.processedPages);
      const alreadyProcessedCount = alreadyProcessedAtStart.size;

      // Initialize progress reporter with already processed count for resume
      const progress = new ProgressReporter(pagesToCrawl.length, 2000, alreadyProcessedCount);

      // Process pages in batches for parallel execution
      const concurrency = this.#options.concurrency;

      for (let batchStart = 0; batchStart < pagesToCrawl.length; batchStart += concurrency) {
        const batchEnd = Math.min(batchStart + concurrency, pagesToCrawl.length);
        const batch = pagesToCrawl.slice(batchStart, batchEnd);

        // Process batch in parallel
        await Promise.all(batch.map(async (url) => {
          if (results.pageData.processedPages.has(url)) {
            // Only count as skip if it wasn't already counted at start (prevents double-counting on resume)
            if (!alreadyProcessedAtStart.has(url)) {
              progress.skip(url);
            }
            return;
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
            } else {
              progress.success(url, duration);
            }
          } else {
            progress.success(url, duration);
          }
        }));

        // Save checkpoint less frequently (every 4 batches = ~20 pages)
        saveCounter++;
        if (saveCounter % 4 === 0) {
          this.#callbacks.saveData();
          // Hint GC if available (run with --expose-gc flag)
          if (global.gc) {
            global.gc();
          }
        }
      }

      // Print crawl summary
      progress.printSummary();

      // Final save before converting data structures
      this.#callbacks.saveData();

      // Convert incomingLinksTracking Map to results.pageData.incomingLinks
      results.pageData.incomingLinks = {};
      for (const [target, sources] of incomingLinksTracking) {
        results.pageData.incomingLinks[target] = Array.from(sources);
      }
      // Clear the tracking map to free memory
      incomingLinksTracking.clear();

      // After all pages are crawled, populate incoming links count for each page
      this.#populateIncomingLinksCount(results);

      return { alternatesErrors, isMultiLang, failedPages };
    } catch (error) {
      console.log(error);
      throw error;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error("Failed to close browser:", closeError);
        }
      }
    }
  }

  /**
   * Crawl a single page
   * @private
   */
  async #crawlSinglePage(params) {
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
      const page = await this.#withTimeout(
        this.#basicTest(
          chromePage,
          this.#options.networkConditions.slow4g,
          this.#options.cpuConditions.normal,
          url
        )
          .then(async (data) => ({ ...data, url }))
          .catch((error) => {
            this.#handlePageError(error, url, results);
            return null;
          }),
        THRESHOLDS.PAGE_TIMEOUT,
        "Core Web Vitals test failed. Page failed to load " + url
      );

      if (!page) {
        await chromePage.close();
        return { failed: true };
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

    } catch (error) {
      console.error(`Error processing page ${url}:`, error.message);
      this.#callbacks.saveAttempt(url);
      this.#callbacks.checkAttempts(url);
      failed = true;
    }

    await chromePage.close();
    return { isMultiLang, failed };
  }

  /**
   * Handle page load error
   * @private
   */
  #handlePageError(error, url, results) {
    const messageOverall = `${error.name} ${error.message} ${error.cause}`;
    const messageDetailed = `${url} ${messageOverall}`;

    // Log the error but don't save it as an SEO issue - crawl errors are infrastructure
    // issues, not website problems. They're tracked separately in pageData.byError.
    console.log(messageDetailed);

    results.pageData.totalWithError += 1;

    if (!results.pageData.byError.crashed) {
      results.pageData.byError.crashed = [];
      results.pageData.byError.totalCrashed = 0;
    }

    results.pageData.byError.crashed.push(url);
    results.pageData.byError.totalCrashed += 1;

    this.#callbacks.saveAttempt(url);
    this.#callbacks.checkAttempts(url);
  }

  /**
   * Process page data after successful load
   * @private
   */
  async #processPageData(params) {
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

    results.pageData.pages[url] = {};
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
      this.#callbacks.saveError(
        issue.message.split('(')[0].trim(),
        `<a href="${url}">${url}</a>: ${issue.message}`,
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
    if (lcpSubParts && LCP > THRESHOLDS.LCP) {
      const lcpAnalysis = VitalsCollector.analyzeLCPSubParts(lcpSubParts, LCP);
      pageData.vitals.lcpAnalysis = lcpAnalysis;
    }

    // Analyze CLS sources if available
    if (clsEntries && CLS > THRESHOLDS.CLS) {
      const clsAnalysis = VitalsCollector.analyzeCLSSources(clsEntries);
      pageData.vitals.clsAnalysis = clsAnalysis;
    }

    // Analyze long tasks if TBT is high
    if (longTasks && TBT > THRESHOLDS.TBT) {
      const tbtAnalysis = VitalsCollector.analyzeLongTasks(longTasks);
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
      this.#callbacks.saveError(
        `Some pages size is too big`,
        `This page has size of ${totalResponseSize} bytes <a href="${url}">${url}</a>`,
        SEVERITY.MEDIUM
      );
    }

    const totalNumberOfRequests = Object.keys(requests).length;
    pageData.totalNumberOfRequests = totalNumberOfRequests;

    if (totalNumberOfRequests > THRESHOLDS.REQUEST_COUNT) {
      this.#callbacks.saveError(
        `Some pages have too many requests`,
        `This page has ${totalNumberOfRequests} requests <a href="${url}">${url}</a>`,
        SEVERITY.MEDIUM
      );
    }

    // Handle non-200 status
    if (status !== 200) {
      results.pageData.totalWithError += 1;

      if (!results.pageData.byError[status]) {
        results.pageData.byError[status] = [];
        results.pageData.byError[`total${status}`] = 0;
      }

      results.pageData.byError[status].push(url);
      results.pageData.byError[`total${status}`] += 1;

      results.pageData.processedPages.add(url);

      return { isMultiLang: false, failed: false };
    }

    results.pageData.totalWithoutError += 1;

    // Get page content
    const pageContent = await chromePage.content();
    const parsedPage = parse(pageContent);

    // Save HTML snapshot if enabled
    this.#saveHtmlSnapshot(pageContent, url);

    // Collect links and track incoming links
    const linksResult = await this.#collectLinks({
      parsedPage, url, results, incomingLinksTracking,
      collectedURLs, uniquePages, pagesToCrawl, addMissing, discoveredLinksSource, sitemapUrls
    });
    pageData.links = linksResult.links;
    pageData.httpLinksCount = linksResult.httpLinksCount;

    // Run all analyzers
    await this.#runAnalyzers(chromePage, parsedPage, url, pageData, pageContent, requests, consoleData);

    // Check Core Web Vitals thresholds
    this.#checkVitalsThresholds(pageData, url, TTFB, FCP, LCP, CLS);

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
        hrefLang: link.hrefLang,
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
  #optimizePageDataMemory(pageData) {
    // 1. Strip raw schema data (can be huge for e-commerce Product schemas)
    if (pageData.structuredData?.jsonLdSchemas) {
      for (const schema of pageData.structuredData.jsonLdSchemas) {
        delete schema.raw;
      }
    }

    // 2. Reduce requests object to summary (keeps type breakdown for report)
    if (pageData.requests && typeof pageData.requests === 'object' && !pageData.requests.totalRequests) {
      const entries = Object.entries(pageData.requests);
      const byType = {};
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
      pageData.internalLinksCount = pageData.links.filter(l => l.isInternal).length;
      pageData.externalLinksCount = pageData.links.filter(l => !l.isInternal).length;
      pageData.links = pageData.links.filter(l => !l.text || l.text.trim() === '').slice(0, 20);
    }

    // 4. Reduce images array (keep problematic ones)
    if (Array.isArray(pageData.images)) {
      pageData.imagesCount = pageData.images.length;
      pageData.imagesWithoutAltCount = pageData.images.filter(i => !i.alt || i.alt.trim() === '').length;
      pageData.images = pageData.images.filter(i => !i.alt || i.alt.trim() === '').slice(0, 10);
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

    // 7. Strip linkAnalysis (keep counts and issues)
    if (pageData.linkAnalysis) {
      pageData.linkAnalysis = {
        internalLinks: pageData.linkAnalysis.internalLinks || 0,
        externalLinks: pageData.linkAnalysis.externalLinks || 0,
        brokenLinks: pageData.linkAnalysis.brokenLinks || 0,
        issues: pageData.linkAnalysis.issues,
        warnings: pageData.linkAnalysis.warnings,
      };
    }

    // 8. Strip contentQuality (keep scores and top keywords)
    if (pageData.contentQuality) {
      delete pageData.contentQuality.keywords;
      if (pageData.contentQuality.topKeywords) {
        pageData.contentQuality.topKeywords = pageData.contentQuality.topKeywords.slice(0, 5);
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

    // 14. Strip image optimization data (keep count)
    if (pageData.imageOptimization?.images) {
      pageData.imageOptimization = {
        totalImages: pageData.imageOptimization.images.length,
        issues: pageData.imageOptimization.issues,
        warnings: pageData.imageOptimization.warnings,
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

    // 16. Strip form data (keep count)
    if (pageData.formData?.forms) {
      pageData.formData = {
        formCount: pageData.formData.forms.length,
        issues: pageData.formData.issues,
        warnings: pageData.formData.warnings,
      };
    }

    // 17. Strip resource optimization
    if (pageData.resourceOptimization?.renderBlockingResources) {
      pageData.resourceOptimization = {
        renderBlockingCount: pageData.resourceOptimization.renderBlockingResources?.length || 0,
        issues: pageData.resourceOptimization.issues,
        warnings: pageData.resourceOptimization.warnings,
      };
    }

    // 18. Strip headings (keep counts and first h1)
    if (pageData.headings?.h1 && Array.isArray(pageData.headings.h1)) {
      pageData.headings = {
        h1Count: pageData.headings.h1.length,
        h2Count: pageData.headings.h2?.length || 0,
        h1: pageData.headings.h1.map(h => typeof h === 'string' ? h.substring(0, 100) : h),
        issues: pageData.headings.issues,
        warnings: pageData.headings.warnings,
      };
    }

    // 19. Strip accessibility data (keep issues only)
    if (pageData.accessibility?.violations) {
      pageData.accessibility = {
        violationCount: pageData.accessibility.violations?.length || 0,
        issues: pageData.accessibility.issues,
        warnings: pageData.accessibility.warnings,
      };
    }

    // 20. Strip caching data
    if (pageData.caching?.resources) {
      pageData.caching = {
        cachedCount: pageData.caching.cachedCount || 0,
        uncachedCount: pageData.caching.uncachedCount || 0,
        issues: pageData.caching.issues,
        warnings: pageData.caching.warnings,
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
    if (pageData.urlAnalysis?.components) {
      pageData.urlAnalysis = {
        depth: pageData.urlAnalysis.depth,
        length: pageData.urlAnalysis.length,
        hasParameters: pageData.urlAnalysis.hasParameters,
        issues: pageData.urlAnalysis.issues,
      };
    }

    // 28. Strip response object (headers are large and rarely needed after analysis)
    if (pageData.response?.headers) {
      delete pageData.response;
    }

    // 29. Strip redirect chain (keep only count)
    if (pageData.redirectChain && Array.isArray(pageData.redirectChain) && pageData.redirectChain.length > 0) {
      pageData.redirectCount = pageData.redirectChain.length;
      delete pageData.redirectChain;
    }

    // 30. Limit issues/warnings arrays on all analyzers to 20 each
    const limitArrays = (obj) => {
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
  #processRedirects(pageData, redirectChain, url) {
    pageData.redirectChain = redirectChain;
    pageData.hasRedirects = redirectChain.length > 0;
    pageData.redirectCount = redirectChain.length;

    if (redirectChain.length > 0) {
      const redirectCount = redirectChain.length - 1;
      if (redirectCount > 2) {
        this.#callbacks.saveError(
          `Some pages have too many redirects`,
          `<a href="${url}">${url}</a> has ${redirectCount} redirect(s): ${redirectChain.map(r => r.url).join(' → ')}`,
          SEVERITY.HIGH
        );
      } else if (redirectCount > 0) {
        this.#callbacks.saveError(
          `Some pages have redirects`,
          `<a href="${url}">${url}</a> has ${redirectCount} redirect(s): ${redirectChain.map(r => r.url).join(' → ')}`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Collect links from page
   * @private
   */
  async #collectLinks(params) {
    const {
      parsedPage, url, results, incomingLinksTracking,
      collectedURLs, uniquePages, pagesToCrawl, addMissing, discoveredLinksSource, sitemapUrls
    } = params;

    const links = [];
    let httpLinksCount = 0;

    for (const link of parsedPage.querySelectorAll("a")) {
      const href = link.attributes.href;
      const text = link.innerText || link.attributes["aria-label"];

      // Skip pure anchor links
      if (href?.startsWith('#')) {
        continue;
      }

      const isInternal = href?.startsWith(this.#options.origin) || href?.startsWith('/');

      if (isInternal) {
        let fullHref = href;
        if (href?.startsWith('/')) {
          try {
            const baseUrl = new URL(url);
            fullHref = `${baseUrl.protocol}//${baseUrl.host}${href}`;
          } catch (e) {
            continue;
          }
        }

        // Check HTTPS consistency
        if (this.#options.origin.startsWith('https://') && fullHref?.startsWith('http://')) {
          httpLinksCount++;
        }

        const hrefWithoutHash = stripHashFragment(fullHref);

        // Track incoming links (store in Map, defer Array conversion to save time)
        if (!incomingLinksTracking.has(hrefWithoutHash)) {
          incomingLinksTracking.set(hrefWithoutHash, new Set());
        }
        incomingLinksTracking.get(hrefWithoutHash).add(url);

        // Handle URL discovery
        if (addMissing) {
          if (!collectedURLs.has(hrefWithoutHash)) {
            pagesToCrawl.push(hrefWithoutHash);
            collectedURLs.add(hrefWithoutHash);
            uniquePages.add(hrefWithoutHash);

            if (!sitemapUrls[hrefWithoutHash]) {
              discoveredLinksSource.set(hrefWithoutHash, url);
            }
          }
        } else if (!uniquePages.has(hrefWithoutHash)) {
          collectedURLs.add(hrefWithoutHash);

          if (!sitemapUrls[hrefWithoutHash]) {
            discoveredLinksSource.set(hrefWithoutHash, url);
          }
        }
      }

      links.push({ text, href, isInternal });

      if (!text) {
        this.#callbacks.saveError(
          `Some pages have links without any text`,
          `The page <a href="${url}">${url}</a> has a link without text "${href}"`,
          SEVERITY.MEDIUM
        );
      }
    }

    // Report HTTPS consistency issues
    if (httpLinksCount > 0) {
      this.#callbacks.saveError(
        `Some pages have HTTP links on HTTPS site`,
        `<a href="${url}">${url}</a> has ${httpLinksCount} internal HTTP link(s) (should use HTTPS)`,
        SEVERITY.HIGH
      );
    }

    return { links, httpLinksCount };
  }

  /**
   * Run all analyzers on the page
   * @private
   */
  async #runAnalyzers(chromePage, parsedPage, url, pageData, pageContent, requests, consoleData) {
    // Heading analysis
    const headingResult = await HeadingAnalyzer.analyzeHeadings(parsedPage, url);
    pageData.headings = headingResult;
    this.#reportIssues(headingResult);

    // Image analysis
    pageData.images = await ImageAnalyzer.extractImageAlts(parsedPage);

    // Link Quality analysis
    const linkQualityResult = await LinkQualityAnalyzer.analyzeLinkQuality(
      chromePage, parsedPage, url, this.#options.origin, {}
    );
    pageData.linkAnalysis = linkQualityResult;
    this.#reportIssues(linkQualityResult);

    // Structured Data analysis
    const structuredDataResult = await StructuredDataAnalyzer.analyzeStructuredData(chromePage, url);
    pageData.structuredData = structuredDataResult;
    this.#reportIssues(structuredDataResult);

    // Mobile Friendly analysis
    const mobileFriendlyResult = await MobileFriendlyAnalyzer.analyzeMobileFriendly(chromePage, url);
    pageData.mobileFriendly = mobileFriendlyResult;
    this.#reportIssues(mobileFriendlyResult);

    // Security analysis
    const securityResult = await SecurityAnalyzer.analyzeSecurity(chromePage, parsedPage, url);
    pageData.security = securityResult;
    this.#reportIssues(securityResult);

    // Indexability analysis
    const indexabilityResult = await IndexabilityAnalyzer.analyzeIndexability(chromePage, parsedPage, url, pageData.status);
    pageData.indexability = indexabilityResult;
    this.#reportIssues(indexabilityResult);

    // Crawlability analysis
    const crawlabilityResult = await CrawlabilityAnalyzer.analyzeCrawlability(chromePage, parsedPage, url);
    pageData.crawlability = crawlabilityResult;
    this.#reportIssues(crawlabilityResult);

    // International SEO analysis
    const internationalSEOResult = await InternationalSEOAnalyzer.analyzeInternationalSEO(chromePage, parsedPage, url);
    pageData.internationalSEO = internationalSEOResult;
    this.#reportIssues(internationalSEOResult);

    // Social Media analysis
    const socialMediaResult = await SocialMediaAnalyzer.analyzeSocialMediaTags(chromePage, parsedPage, url);
    pageData.socialMedia = socialMediaResult;
    this.#reportIssues(socialMediaResult);

    // Analytics analysis
    const analyticsResult = await AnalyticsTrackingAnalyzer.analyzeAnalyticsTracking(chromePage, parsedPage, url);
    pageData.analytics = analyticsResult;
    this.#reportIssues(analyticsResult);

    // Caching analysis
    const cachingResult = await CachingAnalyzer.analyzeCaching(chromePage, requests, url);
    pageData.caching = cachingResult;
    this.#reportIssues(cachingResult);

    // Image Optimization analysis
    const imageOptimizationResult = await ImageOptimizationAnalyzer.analyzeImageOptimization(chromePage, requests, url);
    pageData.imageOptimization = imageOptimizationResult;
    this.#reportIssues(imageOptimizationResult);

    // Resource Optimization analysis
    const resourceOptimizationResult = await ResourceOptimizationAnalyzer.analyzeResourceOptimization(chromePage, requests, url);
    pageData.resourceOptimization = resourceOptimizationResult;
    this.#reportIssues(resourceOptimizationResult);

    // Accessibility analysis
    const accessibilityResult = await AccessibilityAnalyzer.analyzeAccessibility(chromePage, url);
    pageData.accessibility = accessibilityResult;
    this.#reportIssues(accessibilityResult);

    // Content Quality analysis
    const contentQualityResult = await ContentQualityAnalyzer.analyzeContentQuality(chromePage, url, pageContent);
    pageData.contentQuality = contentQualityResult;
    this.#reportIssues(contentQualityResult);

    // URL Architecture analysis
    const urlArchResult = UrlArchitectureAnalyzer.analyze(url, pageData, this.#options.origin);
    this.#reportIssues(urlArchResult);

    // Content Freshness analysis
    const freshnessResult = FreshnessAnalyzer.analyze(pageData, pageData.response || {}, parsedPage);
    pageData.freshnessData = freshnessResult.freshnessData;
    this.#reportIssues(freshnessResult);

    // E-E-A-T signals analysis
    const eeatResult = EEATAnalyzer.analyze(parsedPage, url, pageData);
    this.#reportIssues(eeatResult);

    // Advanced Schema validation
    const schemaResult = AdvancedSchemaValidator.validate(pageData, url);
    this.#reportIssues(schemaResult);

    // Technical SEO analysis
    const technicalResult = TechnicalSEOAnalyzer.analyze(parsedPage, url, pageData);
    this.#reportIssues(technicalResult);

    // Thin content analysis
    const thinContentResult = ThinContentAnalyzer.analyze(pageData, url);
    this.#reportIssues(thinContentResult);

    // Console error analysis
    if (consoleData) {
      const consoleResult = ConsoleErrorAnalyzer.analyze(consoleData, url);
      pageData.consoleAnalysis = consoleResult.consoleAnalysis;
      this.#reportIssues(consoleResult);
    }

    // Soft 404 detection (must run after contentQuality for word count)
    const soft404Result = await Soft404Analyzer.analyze(chromePage, parsedPage, url, pageData);
    pageData.soft404 = soft404Result.soft404Data;
    this.#reportIssues(soft404Result);

    // Pagination SEO analysis
    const paginationResult = await PaginationAnalyzer.analyze(chromePage, parsedPage, url);
    pageData.paginationData = paginationResult.paginationData;
    this.#reportIssues(paginationResult);

    // Media SEO analysis (video, audio)
    const mediaResult = await MediaSEOAnalyzer.analyze(chromePage, parsedPage, pageData, url);
    pageData.mediaData = mediaResult.mediaData;
    this.#reportIssues(mediaResult);

    // Web Component analysis (Shadow DOM)
    const webComponentResult = await WebComponentAnalyzer.analyze(chromePage, parsedPage, url);
    pageData.webComponentData = webComponentResult.webComponentData;
    this.#reportIssues(webComponentResult);

    // Font loading analysis
    const fontResult = await FontLoadingAnalyzer.analyze(chromePage, parsedPage, requests, url);
    pageData.fontData = fontResult.fontData;
    this.#reportIssues(fontResult);

    // Third-party script analysis
    const thirdPartyResult = await ThirdPartyAnalyzer.analyze(chromePage, requests, url, this.#options.origin);
    pageData.thirdPartyData = thirdPartyResult.thirdPartyData;
    this.#reportIssues(thirdPartyResult);

    // Critical rendering path analysis
    const criticalPathResult = await CriticalPathAnalyzer.analyze(chromePage, parsedPage, requests, pageData.metrics, url);
    pageData.criticalPathData = criticalPathResult.criticalPathData;
    this.#reportIssues(criticalPathResult);

    // Connection timing analysis
    const connectionResult = await ConnectionTimingAnalyzer.analyze(chromePage, requests, url);
    pageData.timingData = connectionResult.timingData;
    this.#reportIssues(connectionResult);

    // Form accessibility analysis
    const formResult = await FormAccessibilityAnalyzer.analyze(chromePage, parsedPage, url);
    pageData.formData = formResult.formData;
    this.#reportIssues(formResult);

    // Cookie consent / GDPR analysis
    const consentResult = await CookieConsentAnalyzer.analyze(chromePage, parsedPage, requests, url);
    pageData.consentData = consentResult.consentData;
    this.#reportIssues(consentResult);

    // Redirect chain analysis
    const redirectResult = RedirectChainAnalyzer.analyze(pageData, url);
    pageData.redirectAnalysis = redirectResult.info;
    this.#reportIssues(redirectResult);

    // Compression analysis
    const compressionResult = CompressionAnalyzer.analyze(pageData, url);
    pageData.compressionData = compressionResult.info;
    this.#reportIssues(compressionResult);

    // Resource hints analysis
    const hintsResult = ResourceHintsAnalyzer.analyze(pageData, url);
    pageData.resourceHintsData = hintsResult.info;
    this.#reportIssues(hintsResult);

    // Mixed content analysis
    const mixedResult = MixedContentAnalyzer.analyze(pageData, url);
    pageData.mixedContentData = mixedResult.info;
    this.#reportIssues(mixedResult);

    // HTTP protocol analysis
    const protocolResult = HTTPProtocolAnalyzer.analyze(pageData, url);
    pageData.protocolData = protocolResult.info;
    this.#reportIssues(protocolResult);

    // PWA analysis
    const pwaResult = PWAAnalyzer.analyze(pageData, url);
    pageData.pwaData = pwaResult.info;
    this.#reportIssues(pwaResult);

    // Above-the-fold analysis
    const aboveFoldResult = AboveFoldAnalyzer.analyze(pageData, url);
    pageData.aboveFoldData = aboveFoldResult.info;
    this.#reportIssues(aboveFoldResult);

    // JavaScript rendering analysis (only if raw HTML available)
    if (pageData.rawHtml) {
      const jsRenderResult = JavaScriptRenderingAnalyzer.analyze(pageData, url);
      pageData.jsRenderingData = jsRenderResult.info;
      this.#reportIssues(jsRenderResult);
    }

    // Anchor text analysis
    const anchorResult = AnchorTextAnalyzer.analyze(pageData, url);
    pageData.anchorTextData = anchorResult.info;
    this.#reportIssues(anchorResult);

    // External links analysis
    const externalLinksResult = ExternalLinksAnalyzer.analyze(pageData, url);
    pageData.externalLinksData = externalLinksResult.info;
    this.#reportIssues(externalLinksResult);
  }

  /**
   * Report issues and warnings from analyzer result
   * @private
   */
  #reportIssues(result) {
    for (const issue of result.issues || []) {
      this.#callbacks.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of result.warnings || []) {
      this.#callbacks.saveError(warning.message, warning.detail, warning.severity);
    }
  }

  /**
   * Check Core Web Vitals thresholds
   * @private
   */
  #checkVitalsThresholds(pageData, url, TTFB, FCP, LCP, CLS) {
    const vitals = pageData.vitals || {};

    if (TTFB > THRESHOLDS.TTFB) {
      this.#callbacks.saveError(
        `Some pages have TTFB more than ${THRESHOLDS.TTFB}ms`,
        `The page <a href="${url}">${url}</a> has TTFB ${Math.round(TTFB)}ms (threshold: ${THRESHOLDS.TTFB}ms)`,
        SEVERITY.HIGH
      );
    }

    if (FCP > THRESHOLDS.FCP) {
      this.#callbacks.saveError(
        `Some pages have FCP more than ${THRESHOLDS.FCP}ms`,
        `The page <a href="${url}">${url}</a> has FCP ${Math.round(FCP)}ms (threshold: ${THRESHOLDS.FCP}ms)`,
        SEVERITY.HIGH
      );
    }

    if (LCP > THRESHOLDS.LCP) {
      // Include LCP element attribution for debugging
      const lcpInfo = vitals.lcpElement ? ` (LCP element: ${vitals.lcpElement}${vitals.lcpUrl ? ', ' + vitals.lcpUrl : ''})` : '';
      this.#callbacks.saveError(
        `Some pages have LCP more than ${THRESHOLDS.LCP}ms`,
        `The page <a href="${url}">${url}</a> has LCP ${Math.round(LCP)}ms (threshold: ${THRESHOLDS.LCP}ms)${lcpInfo}`,
        SEVERITY.HIGH
      );
    }

    if (CLS > THRESHOLDS.CLS) {
      // Include CLS shift count for debugging
      const clsInfo = vitals.clsShiftCount ? ` (${vitals.clsShiftCount} layout shifts)` : '';
      this.#callbacks.saveError(
        `Some pages have CLS more than ${THRESHOLDS.CLS}`,
        `The page <a href="${url}">${url}</a> has CLS ${CLS.toFixed(3)} (threshold: ${THRESHOLDS.CLS})${clsInfo}`,
        SEVERITY.HIGH
      );
    }

    // INP check (only if measured - requires user interaction)
    const INP = pageData.INP;
    if (INP && INP > THRESHOLDS.INP) {
      const inpInfo = vitals.inpEvent ? ` (slowest interaction: ${vitals.inpEvent})` : '';
      this.#callbacks.saveError(
        `Some pages have INP more than ${THRESHOLDS.INP}ms`,
        `The page <a href="${url}">${url}</a> has INP ${Math.round(INP)}ms (threshold: ${THRESHOLDS.INP}ms)${inpInfo}`,
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
        `The page <a href="${url}">${url}</a> has Total Blocking Time ${Math.round(TBT)}ms (threshold: ${THRESHOLDS.TBT}ms)${tbtInfo}`,
        TBT > 600 ? SEVERITY.HIGH : SEVERITY.MEDIUM
      );
    }

    // TTI check (Time to Interactive)
    const TTI = pageData.TTI;
    if (TTI && TTI > THRESHOLDS.TTI) {
      this.#callbacks.saveError(
        `Some pages have TTI more than ${THRESHOLDS.TTI}ms`,
        `The page <a href="${url}">${url}</a> has Time to Interactive ${Math.round(TTI)}ms (threshold: ${THRESHOLDS.TTI}ms)`,
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
          `LCP bottleneck: ${bottleneckNames[bottleneck] || bottleneck}`,
          `<a href="${url}">${url}</a> ${breakdown}${rec}`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Process title
   * @private
   */
  #processTitle(title, url, uniqueTitles) {
    if (!title) {
      this.#callbacks.saveError(
        `Title is missing`,
        `Title is missing for this page <a href="${url}">${url}</a>`,
        SEVERITY.CRITICAL
      );
      return { title: null, titleLength: 0 };
    }

    const titleLength = title.length;

    if (titleLength < THRESHOLDS.TITLE_MIN) {
      this.#callbacks.saveError(
        `Some pages have titles that are too short`,
        `The page <a href="${url}">${url}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
        SEVERITY.MEDIUM
      );
    } else if (titleLength > THRESHOLDS.TITLE_MAX) {
      this.#callbacks.saveError(
        `Some pages have titles that are too long`,
        `The page <a href="${url}">${url}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
        SEVERITY.MEDIUM
      );
    }

    if (uniqueTitles.has(title)) {
      this.#callbacks.saveError(
        `Some pages have identical titles`,
        `Title "${title}" is duplicated for this page <a href="${url}">${url}</a>`,
        SEVERITY.HIGH
      );
    }

    uniqueTitles.add(title);
    return { title, titleLength };
  }

  /**
   * Process meta tags
   * @private
   */
  #processMetaTags(metaTags, pageData, url, uniqueDescriptions) {
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
      if (META_TAGS.includes(name) || META_TAGS_CONFIG.optional.includes(name)) {
        pageData.meta.push({ [name]: content });
      }

      // Special handling for description
      if (name === "description") {
        pageData.description = content;
        const descLength = content ? content.length : 0;
        pageData.descriptionLength = descLength;

        if (descLength < THRESHOLDS.DESCRIPTION_MIN) {
          this.#callbacks.saveError(
            `Some pages have descriptions that are too short`,
            `The page <a href="${url}">${url}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
            SEVERITY.MEDIUM
          );
        } else if (descLength > THRESHOLDS.DESCRIPTION_MAX) {
          this.#callbacks.saveError(
            `Some pages have descriptions that are too long`,
            `The page <a href="${url}">${url}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
            SEVERITY.MEDIUM
          );
        }

        if (content && uniqueDescriptions.has(content)) {
          this.#callbacks.saveError(
            `Some pages have identical descriptions`,
            `Description "${content.substring(0, 50)}..." is duplicated for this page <a href="${url}">${url}</a>`,
            SEVERITY.HIGH
          );
        }

        if (content) {
          uniqueDescriptions.add(content);
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
  #checkMissingMetaTags(pageData, url) {
    const presentTags = new Set(Object.keys(pageData.metaMap));

    // Check critical tags only - description
    // (Social tags are handled by SocialMediaAnalyzer to avoid duplicate errors)
    // (Viewport is handled by MobileFriendlyAnalyzer with detailed validation)
    for (const tag of META_TAGS_CONFIG.critical) {
      if (!presentTags.has(tag)) {
        if (tag === 'description' && !pageData.description) {
          this.#callbacks.saveError(
            `Description meta tag is missing`,
            `Meta description is missing for this page <a href="${url}">${url}</a>`,
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
  #processLinkTags(linkTags, pageData, url, sitemapUrls) {
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
        `Canonical link is missing for this page <a href="${url}">${url}</a>`,
        SEVERITY.HIGH
      );
    }

    // Validate alternates
    if (isMultiLang && !pageData.alternates) {
      this.#callbacks.saveError(
        `Alternates are not set for some pages`,
        `Alternates links are missing for this page <a href="${url}">${url}</a>`,
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
  #checkAlternateDuplicates(alternates, url) {
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
          `Alternate ${alternate.href} is duplicated for this page <a href="${url}">${url}</a>`,
          SEVERITY.MEDIUM
        );
      }
    }
  }

  /**
   * Validate canonical matches sitemap
   * @private
   */
  #validateCanonicalMatchesSitemap(pageData, url, sitemapUrls) {
    const matchingCanonical =
      sitemapUrls[pageData.canonical] ||
      sitemapUrls[`${this.#options.origin}/${pageData.canonical}`];

    if (matchingCanonical) {
      if (matchingCanonical.alternates) {
        if (pageData.alternates) {
          for (const pageAlternate of pageData.alternates) {
            if (!matchingCanonical.alternates[pageAlternate.href]) {
              this.#callbacks.saveError(
                `Some alternates from sitemap don't match alternates from pages`,
                `Alternate ${pageAlternate.href} has no match in sitemap for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`,
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
                  `Alternate hreflangs ${pageAlternate.hreflang} doesn't match sitemap hreflang ${sitemapAlternate.hreflang} for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`,
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
        `No matching loc corresponding canonical ${pageData.canonical} is found for this page <a href="${url}">${url}</a>`,
        SEVERITY.HIGH
      );
    }
  }

  /**
   * Save HTML snapshot
   * @private
   */
  #saveHtmlSnapshot(pageContent, url) {
    if (!this.#options.saveHtml) {
      return;
    }

    const folderName = `audit_${createSafeFilename(this.#options.origin)}`;
    const folder = path.join(process.cwd(), folderName);

    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${folder}:`, error.message);
      return;
    }

    const safeFilename = createSafeFilename(url);
    const filePath = path.join(folder, `${safeFilename}.html`);

    try {
      fs.writeFileSync(filePath, pageContent);
    } catch (error) {
      console.error(`Failed to write file ${filePath}:`, error.message);
    }
  }

  /**
   * Populate incoming links count for each page
   * @private
   */
  #populateIncomingLinksCount(results) {
    for (const url in results.pageData.pages) {
      const incomingLinksArray = results.pageData.incomingLinks[url] || [];
      const incomingLinksCount = Array.isArray(incomingLinksArray) ? incomingLinksArray.length : 0;
      results.pageData.pages[url].incomingLinksCount = incomingLinksCount;
      results.pageData.pages[url].hasIncomingLinks = incomingLinksCount > 0;
    }
  }
}

module.exports = { CrawlerEngine };
