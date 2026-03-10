/**
 * Progress Manager
 * Handles checkpoint persistence and restoration for SEO audits
 * Uses multi-file format: manifest + metadata + analysis + page batches
 */

const fs = require('fs');
const path = require('path');
const { ErrorAggregator } = require('../utils/error-aggregator');

class ProgressManager {
  #pendingPages = {};
  #writtenBatches = [];
  #isWriting = false;
  #writeQueue = [];
  #flushWaiters = [];

  /**
   * Create a new ProgressManager
   * @param {FileManager} fileManager - FileManager instance for I/O operations
   */
  constructor(fileManager, { verbose = false } = {}) {
    this.fileManager = fileManager;
    this.verbose = verbose;
    this.#pendingPages = {};
    this.#writtenBatches = [];
    this.#isWriting = false;
    this.#writeQueue = [];
    this.#flushWaiters = [];
  }

  /**
   * Load progress from multi-file checkpoint
   * @param {string} domainName - Domain name
   * @param {string} resultsDir - Directory containing checkpoint files
   * @returns {Object} Restored data with processedPages as Set, analysis, pageData, etc.
   */
  async loadProgress(domainName, resultsDir) {
    console.log(`\nRestoring progress from ${resultsDir}`);

    // Load manifest (small file with progress state)
    console.log(`  - Loading manifest...`);
    const manifest = this.fileManager.readManifest();

    // Load metadata (robots, sitemaps, timing)
    console.log(`  - Loading metadata...`);
    const metadata = this.fileManager.readMetadata();

    // Load analysis (issues, summary)
    console.log(`  - Loading analysis...`);
    const analysis = this.fileManager.readAnalysis();

    // Load incoming links
    console.log(`  - Loading incoming links...`);
    let incomingLinksData = { incomingLinks: {}, tracking: new Map() };
    try {
      const rawIncomingLinks = this.fileManager.readIncomingLinks();
      incomingLinksData = this.#processIncomingLinks(rawIncomingLinks);
    } catch {
      console.log(`    (no incoming links file found)`);
    }

    // Create ErrorAggregator with restored data
    const errorAggregator = new ErrorAggregator(analysis);

    // Load pages from batch files
    console.log(`  - Loading page batches...`);
    const pages = {};
    const batches = manifest.files?.pageBatches || [];

    for (const batchInfo of batches) {
      try {
        const batchData = this.fileManager.readBatchByPath(batchInfo.file);
        Object.assign(pages, batchData.pages);
        console.log(`    Loaded ${Object.keys(batchData.pages).length} pages from ${batchInfo.file}`);
      } catch (error) {
        console.warn(`    ⚠️  Could not load batch ${batchInfo.file}: ${error.message}`);
      }
    }

    // Optimize restored page data to reduce memory footprint
    console.log(`  - Optimizing restored page data...`);
    let optimizedCount = 0;
    for (const url in pages) {
      pages[url] = this.#optimizePageInMemory(pages[url]);
      optimizedCount++;
    }
    console.log(`    Optimized ${optimizedCount} pages`);

    // Build restored results
    // Ensure processedPages is converted to Set (defensive check for corrupted data)
    const processedPagesArray = Array.isArray(manifest.progress.processedPages)
      ? manifest.progress.processedPages
      : [];
    const processedPagesSet = new Set(processedPagesArray);

    const restoredResults = {
      robots: metadata.robots,
      sitemaps: metadata.sitemaps,
      isMultiLang: metadata.isMultiLang,
      timing: metadata.timing,
      pageData: {
        pages,
        processedPages: processedPagesSet,
        totalWithoutError: manifest.progress.totalWithoutError,
        totalWithError: manifest.progress.totalWithError,
        byError: manifest.progress.byError,
        attempts: manifest.progress.attempts,
        incomingLinks: incomingLinksData.incomingLinks,
      },
      analysis: errorAggregator.getRawData(),
    };

    // Set written batches for resume
    this.#writtenBatches = batches.map(b => ({
      file: b.file,
      count: b.count,
      urls: b.urls || [],
    }));
    this.fileManager.setCurrentBatchNumber(batches.length);

    console.log(`✓ Progress restored successfully`);
    console.log(`  - Processed pages: ${restoredResults.pageData.processedPages.size}`);
    console.log(`  - Total pages in memory: ${Object.keys(pages).length}`);
    console.log(`  - Total URLs in sitemap: ${restoredResults.sitemaps?.total || 0}\n`);

    return {
      results: restoredResults,
      errorAggregator,
      incomingLinksTracking: incomingLinksData.tracking,
    };
  }

  /**
   * Add a page to pending writes with size validation
   * @param {string} url - Page URL
   * @param {Object} pageData - Page data
   * @returns {boolean} True if auto-flush was triggered
   */
  addPage(url, pageData) {
    // Validate and truncate oversized page data to prevent memory issues
    const MAX_PAGE_SIZE_BYTES = 500 * 1024; // 500KB per page max
    const MAX_ARRAY_LENGTH = 100; // Max items in arrays
    const MAX_PENDING_PAGES = 500; // Max pages in memory before auto-flush

    try {
      const estimatedSize = JSON.stringify(pageData).length;

      if (estimatedSize > MAX_PAGE_SIZE_BYTES) {
        console.warn(`⚠️  Page data for ${url} is large (${Math.round(estimatedSize / 1024)}KB), truncating...`);

        // Truncate large arrays to reduce size
        const truncatedPage = this.#truncateLargeArrays(pageData, MAX_ARRAY_LENGTH);

        // Re-check size after truncation
        const newSize = JSON.stringify(truncatedPage).length;
        if (newSize > MAX_PAGE_SIZE_BYTES) {
          // Still too large - apply aggressive optimization
          const optimizedPage = this.#optimizePageInMemory({ ...truncatedPage });
          this.#pendingPages[url] = optimizedPage;
        } else {
          this.#pendingPages[url] = truncatedPage;
        }
      } else {
        this.#pendingPages[url] = pageData;
      }
    } catch (error) {
      // If JSON.stringify fails (circular refs, etc.), store minimal data
      console.warn(`⚠️  Could not validate page size for ${url}: ${error.message}`);
      this.#pendingPages[url] = {
        url: pageData.url,
        status: pageData.status,
        title: pageData.title,
        error: 'Page data could not be serialized',
      };
    }

    // Auto-flush if pending pages exceed memory threshold
    const pendingCount = Object.keys(this.#pendingPages).length;
    if (pendingCount >= MAX_PENDING_PAGES) {
      console.log(`  📦 Auto-flushing ${pendingCount} pending pages to prevent memory issues...`);
      // Note: flushPendingPages is async but we don't await here to avoid blocking
      // The write lock in flushPendingPages handles concurrency
      this.flushPendingPages(true).catch(err => {
        console.warn(`  ⚠️  Auto-flush failed: ${err.message}`);
      });
      return true;
    }
    return false;
  }

  /**
   * Truncate large arrays in an object recursively
   * @private
   */
  #truncateLargeArrays(obj, maxLength, depth = 0) {
    if (depth > 5) return obj; // Prevent infinite recursion

    if (Array.isArray(obj)) {
      return obj.slice(0, maxLength);
    }

    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value) && value.length > maxLength) {
          result[key] = value.slice(0, maxLength);
        } else if (value && typeof value === 'object') {
          result[key] = this.#truncateLargeArrays(value, maxLength, depth + 1);
        } else {
          result[key] = value;
        }
      }
      return result;
    }

    return obj;
  }

  /**
   * Get count of pending pages
   * @returns {number} Number of pending pages
   */
  getPendingCount() {
    return Object.keys(this.#pendingPages).length;
  }

  /**
   * Flush pending pages to batch files if threshold reached
   * Uses write lock with queuing to prevent concurrent disk operations
   * @param {boolean} force - Force flush even if below threshold
   * @returns {Promise<Array>} Written batch info
   */
  async flushPendingPages(force = false) {
    const pendingCount = Object.keys(this.#pendingPages).length;
    const batchSize = this.fileManager.batchSize;

    if (!force && pendingCount < batchSize) {
      return [];
    }

    // If a write is already in progress, wait for it using a promise (no spin-wait)
    if (this.#isWriting) {
      try {
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('Write lock timeout')), 30000);
          this.#flushWaiters.push(() => { clearTimeout(timeoutId); resolve(); });
        });
      } catch {
        console.warn(`  ⚠️  Write lock timeout after 30s, skipping flush`);
        return [];
      }

      // Re-check if flush is still needed after waiting
      const newPendingCount = Object.keys(this.#pendingPages).length;
      if (!force && newPendingCount < batchSize) {
        return [];
      }
    }

    this.#isWriting = true;

    try {
      return this.#doFlushPendingPages(force, batchSize);
    } finally {
      this.#isWriting = false;
      // Notify any waiting flush calls
      if (this.#flushWaiters.length > 0) {
        const notify = this.#flushWaiters.shift();
        notify();
      }
    }
  }

  /**
   * Internal method that performs the actual flush
   * @private
   */
  #doFlushPendingPages(force, batchSize) {
    const pendingEntries = Object.entries(this.#pendingPages);

    if (pendingEntries.length === 0) {
      return [];
    }

    const newBatches = [];

    // Write complete batches
    for (let i = 0; i < pendingEntries.length; i += batchSize) {
      const batchEntries = pendingEntries.slice(i, i + batchSize);

      // Only write if we have a full batch or force flush
      if (batchEntries.length < batchSize && !force) {
        break;
      }

      const batchPages = {};
      for (const [url, page] of batchEntries) {
        // Optimize page before writing
        batchPages[url] = this.#optimizePageInMemory({ ...page });
        delete this.#pendingPages[url];
      }

      const batchNum = this.fileManager.getNextBatchNumber();
      const batchInfo = this.fileManager.writeBatch(batchNum, batchPages);

      console.log(`  📦 Wrote batch ${batchNum}: ${batchInfo.count} pages (${batchInfo.stats.compressedSizeMB.toFixed(2)} MB)`);

      newBatches.push(batchInfo);
      this.#writtenBatches.push(batchInfo);
    }

    return newBatches;
  }

  /**
   * Save progress with multi-file format
   * Uses a write lock to prevent concurrent writes that could cause data corruption
   * Queues save requests if a write is already in progress
   * @param {Object} results - Current results object
   * @returns {void}
   */
  saveProgress(results) {
    // Prevent concurrent writes - if already writing, queue this request
    if (this.#isWriting) {
      // Actually queue the request instead of dropping it
      // Only keep the latest queued request to avoid redundant saves
      this.#writeQueue = [results];
      console.log(`  ⏳ Write in progress, save request queued...`);
      return;
    }

    this.#isWriting = true;

    try {
      this.#doSaveProgress(results);
    } finally {
      this.#isWriting = false;

      // Process queued save request if any
      if (this.#writeQueue.length > 0) {
        const queuedResults = this.#writeQueue.pop();
        this.#writeQueue = []; // Clear queue
        console.log(`  📝 Processing queued save request...`);
        this.saveProgress(queuedResults);
      }
    }
  }

  /**
   * Internal method that performs the actual save
   * @private
   */
  #doSaveProgress(results) {
    // Get URLs that have already been written to batches
    const writtenUrls = new Set();
    for (const batch of this.#writtenBatches) {
      for (const url of (batch.urls || [])) {
        writtenUrls.add(url);
      }
    }

    // Find pages that need to be written (not yet in any batch)
    const pagesToWrite = {};
    const allPages = results.pageData.pages || {};
    for (const url in allPages) {
      if (!writtenUrls.has(url)) {
        pagesToWrite[url] = allPages[url];
      }
    }

    // Write new pages to batches
    const batchSize = this.fileManager.batchSize;
    const pageEntries = Object.entries(pagesToWrite);
    const urlsWritten = [];

    if (pageEntries.length > 0) {
      for (let i = 0; i < pageEntries.length; i += batchSize) {
        const batchEntries = pageEntries.slice(i, i + batchSize);
        const batchPages = {};

        for (const [url, page] of batchEntries) {
          batchPages[url] = this.#optimizePageInMemory({ ...page });
          urlsWritten.push(url);
        }

        const batchNum = this.fileManager.getNextBatchNumber();
        const batchInfo = this.fileManager.writeBatch(batchNum, batchPages);
        this.#writtenBatches.push(batchInfo);
      }

      // Clear written pages from memory to prevent OOM
      const urlsToRemove = new Set(urlsWritten);
      results.pageData.pages = Object.fromEntries(
        Object.entries(results.pageData.pages).filter(([url]) => !urlsToRemove.has(url))
      );

      // Trigger garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }

    // Write metadata
    const metadata = {
      robots: results.robots,
      sitemaps: results.sitemaps,
      isMultiLang: results.isMultiLang,
      timing: results.timing,
      cruxData: results.cruxData || null,
    };
    this.fileManager.writeMetadata(metadata);

    // Write analysis
    const analysisData = {
      overall: Array.from(results.analysis.overall),
      details: results.analysis.details,
      bySeverity: results.analysis.bySeverity,
      summary: results.analysis.summary,
    };
    this.fileManager.writeAnalysis(analysisData);

    // Write incoming links
    const incomingLinks = results.pageData.incomingLinks || {};
    this.fileManager.writeIncomingLinks(incomingLinks);

    // Build and write manifest
    const manifest = {
      version: 2,
      format: 'multi-file',
      domain: this.fileManager.domainName,
      created: new Date().toISOString(),

      progress: {
        processedPages: Array.from(results.pageData.processedPages),
        totalWithoutError: results.pageData.totalWithoutError,
        totalWithError: results.pageData.totalWithError,
        byError: results.pageData.byError,
        attempts: results.pageData.attempts,
      },

      files: {
        metadata: 'metadata.json.gz',
        analysis: 'analysis.json.gz',
        incomingLinks: 'incoming-links.json.gz',
        pageBatches: this.#writtenBatches.map(b => ({
          file: b.file,
          count: b.count,
          urls: b.urls,
        })),
      },
    };

    this.fileManager.writeManifest(manifest);

    const totalBatches = this.#writtenBatches.length;
    const totalPages = this.#writtenBatches.reduce((sum, b) => sum + b.count, 0);
    if (this.verbose) {
      console.log(`💾 Saved: ${totalPages} pages in ${totalBatches} batches`);
    }
  }

  /**
   * Reload all evicted pages from batch files back into memory.
   * Call this before site-wide validation to ensure validators see complete data.
   * @param {Object} pages - Current pages object (will be mutated with reloaded pages)
   * @returns {number} Number of pages reloaded
   */
  reloadEvictedPages(pages) {
    let reloaded = 0;

    for (const batch of this.#writtenBatches) {
      try {
        const batchData = this.fileManager.readBatchByPath(batch.file);
        for (const url in batchData.pages) {
          if (!pages[url]) {
            pages[url] = batchData.pages[url];
            reloaded++;
          }
        }
      } catch (error) {
        console.warn(`  ⚠️  Could not reload batch ${batch.file}: ${error.message}`);
      }
    }

    // Also include any pending pages not yet flushed
    for (const url in this.#pendingPages) {
      if (!pages[url]) {
        pages[url] = this.#pendingPages[url];
        reloaded++;
      }
    }

    if (reloaded > 0) {
      console.log(`  📦 Reloaded ${reloaded} evicted pages for site-wide analysis`);
    }

    return reloaded;
  }

  /**
   * Get written batches info
   * @returns {Array} Written batch info
   */
  getWrittenBatches() {
    return [...this.#writtenBatches];
  }

  /**
   * Process incoming links format
   * @private
   */
  #processIncomingLinks(incomingLinks) {
    const tracking = new Map();
    const processed = {};

    for (const target in incomingLinks) {
      if (Array.isArray(incomingLinks[target])) {
        tracking.set(target, new Set(incomingLinks[target]));
        processed[target] = incomingLinks[target];
      } else if (typeof incomingLinks[target] === 'number') {
        tracking.set(target, new Set());
        processed[target] = [];
      }
    }

    return { tracking, incomingLinks: processed };
  }

  /**
   * Optimize page data in memory to reduce footprint
   * @private
   */
  #optimizePageInMemory(page) {
    // Strip raw schema data but preserve key fields needed by site-wide validators
    if (page.structuredData?.jsonLdSchemas) {
      for (const schema of page.structuredData.jsonLdSchemas) {
        if (schema.raw) {
          // Keep only fields used by StructuredDataValidator for consistency checks
          schema.raw = {
            name: schema.raw.name,
            headline: schema.raw.headline,
            ...(schema.raw['@type'] ? { '@type': schema.raw['@type'] } : {}),
          };
        }
      }
    }

    // Reduce requests to summary
    if (page.requests && typeof page.requests === 'object' && !page.requests.totalRequests) {
      const entries = Object.entries(page.requests);
      const byType = {};
      let totalSize = 0;
      for (const [, req] of entries) {
        byType[req.resourceType || 'other'] = (byType[req.resourceType || 'other'] || 0) + 1;
        if (req.size) totalSize += req.size;
      }
      page.requests = { totalRequests: entries.length, byType, totalSize };
    }

    // Reduce links to only problematic ones
    if (Array.isArray(page.links) && page.links.length > 0) {
      page.linksCount = page.linksCount || page.links.length;
      page.internalLinksCount = page.internalLinksCount || page.links.filter(l => l.isInternal).length;
      page.externalLinksCount = page.externalLinksCount || page.links.filter(l => !l.isInternal).length;
      page.links = page.links.filter(l => !l.text || l.text.trim() === '').slice(0, 20);
    }

    // Reduce images to only problematic ones
    if (Array.isArray(page.images) && page.images.length > 0) {
      page.imagesCount = page.imagesCount || page.images.length;
      page.imagesWithoutAltCount = page.imagesWithoutAltCount || page.images.filter(i => !i.alt || i.alt.trim() === '').length;
      page.images = page.images.filter(i => !i.alt || i.alt.trim() === '').slice(0, 10);
    }

    // Strip vitals detail
    if (page.vitals) {
      delete page.vitals.lcpSubParts;
      delete page.vitals.clsEntries;
      delete page.vitals.longTasks;
      if (page.vitals.lcpAnalysis) {
        page.vitals.lcpAnalysis = {
          bottleneck: page.vitals.lcpAnalysis.bottleneck,
          recommendation: page.vitals.lcpAnalysis.recommendation,
        };
      }
    }

    // Delete heavy objects
    delete page.metrics;
    delete page.blockers;

    // Strip linkAnalysis
    if (page.linkAnalysis?.links) {
      page.linkAnalysis = {
        internalLinks: page.linkAnalysis.internalLinks || 0,
        externalLinks: page.linkAnalysis.externalLinks || 0,
        brokenLinks: page.linkAnalysis.brokenLinks || 0,
        issues: page.linkAnalysis.issues,
        warnings: page.linkAnalysis.warnings,
      };
    }

    // Strip contentQuality
    if (page.contentQuality?.keywords) {
      delete page.contentQuality.keywords;
      if (page.contentQuality.topKeywords) {
        page.contentQuality.topKeywords = page.contentQuality.topKeywords.slice(0, 5);
      }
    }

    // Strip third-party data
    if (page.thirdPartyData?.scripts) {
      page.thirdPartyData = {
        totalScripts: page.thirdPartyData.scripts.length,
        totalSize: page.thirdPartyData.totalSize || 0,
        issues: page.thirdPartyData.issues,
        warnings: page.thirdPartyData.warnings,
      };
    }

    // Strip timing data
    if (page.timingData?.resourceTimings) {
      page.timingData = {
        slowResources: (page.timingData.slowResources || []).slice(0, 5),
        issues: page.timingData.issues,
        warnings: page.timingData.warnings,
      };
    }

    // Strip critical path data
    if (page.criticalPathData?.blockingCSS) {
      page.criticalPathData = {
        blockingCSSCount: page.criticalPathData.blockingCSS?.length || 0,
        blockingJSCount: page.criticalPathData.blockingJS?.length || 0,
        issues: page.criticalPathData.issues,
        warnings: page.criticalPathData.warnings,
      };
    }

    // Strip font data
    if (page.fontData?.fonts) {
      page.fontData = {
        totalFonts: page.fontData.fonts.length,
        issues: page.fontData.issues,
        warnings: page.fontData.warnings,
      };
    }

    // Strip compression data
    if (page.compressionData?.resources) {
      page.compressionData = {
        issues: page.compressionData.issues,
        warnings: page.compressionData.warnings,
      };
    }

    // Strip image optimization data (preserve fields for reports)
    if (page.imageOptimization?.images) {
      page.imageOptimization = {
        totalImages: page.imageOptimization.images.length,
        withLazyLoading: page.imageOptimization.withLazyLoading,
        modernFormats: page.imageOptimization.modernFormats,
        legacyFormats: page.imageOptimization.legacyFormats,
        totalImageSize: page.imageOptimization.totalImageSize,
        issues: page.imageOptimization.issues,
        warnings: page.imageOptimization.warnings,
      };
    }

    // Strip console analysis
    if (page.consoleAnalysis?.errors) {
      page.consoleAnalysis = {
        errorCount: page.consoleAnalysis.errors?.length || 0,
        warningCount: page.consoleAnalysis.warnings?.length || 0,
        issues: page.consoleAnalysis.issues,
      };
    }

    // Strip form data (preserve accessibilityScore for score-calculator)
    if (page.formData?.forms) {
      page.formData = {
        formCount: page.formData.forms.length,
        accessibilityScore: page.formData.accessibilityScore,
        issues: page.formData.issues,
        warnings: page.formData.warnings,
      };
    }

    // Strip resource optimization (preserve fields for reports)
    if (page.resourceOptimization?.renderBlockingResources) {
      page.resourceOptimization = {
        renderBlockingCount: page.resourceOptimization.renderBlockingResources?.length || 0,
        renderBlocking: page.resourceOptimization.renderBlocking,
        compression: page.resourceOptimization.compression,
        minification: page.resourceOptimization.minification,
        issues: page.resourceOptimization.issues,
        warnings: page.resourceOptimization.warnings,
      };
    }

    // Strip headings (preserve h3-h6 counts for pages-table)
    if (page.headings?.h1 && Array.isArray(page.headings.h1)) {
      page.headings = {
        h1Count: page.headings.h1.length,
        h2Count: page.headings.h2?.length || 0,
        h3Count: page.headings.h3?.length || 0,
        h4Count: page.headings.h4?.length || 0,
        h5Count: page.headings.h5?.length || 0,
        h6Count: page.headings.h6?.length || 0,
        h1: page.headings.h1.map(h => (typeof h === 'string' ? h.substring(0, 100) : h)),
        issues: page.headings.issues,
        warnings: page.headings.warnings,
      };
    }

    // Strip accessibility data (preserve a11yScore for score-calculator)
    if (page.accessibility?.violations) {
      page.accessibility = {
        a11yScore: page.accessibility.a11yScore,
        violationCount: page.accessibility.violations?.length || 0,
        issues: page.accessibility.issues,
        warnings: page.accessibility.warnings,
      };
    }

    // Strip caching data (preserve cacheScore, CDN info for reports)
    if (page.caching?.resources) {
      page.caching = {
        cacheScore: page.caching.cacheScore,
        cachedCount: page.caching.cachedCount || 0,
        uncachedCount: page.caching.uncachedCount || 0,
        hasCDN: page.caching.hasCDN,
        cdnProvider: page.caching.cdnProvider,
        hasServiceWorker: page.caching.hasServiceWorker,
        staticCached: page.caching.staticCached,
        staticUncached: page.caching.staticUncached,
        issues: page.caching.issues,
        warnings: page.caching.warnings,
      };
    }

    // Strip media data
    if (page.mediaData?.videos || page.mediaData?.audios) {
      page.mediaData = {
        videoCount: page.mediaData.videos?.length || 0,
        audioCount: page.mediaData.audios?.length || 0,
        issues: page.mediaData.issues,
        warnings: page.mediaData.warnings,
      };
    }

    // Strip web component data
    if (page.webComponentData?.components) {
      page.webComponentData = {
        componentCount: page.webComponentData.components?.length || 0,
        issues: page.webComponentData.issues,
        warnings: page.webComponentData.warnings,
      };
    }

    // Strip above-fold data
    if (page.aboveFoldData?.aboveFoldElements) {
      page.aboveFoldData = {
        lcpInViewport: page.aboveFoldData.lcpInViewport,
        renderBlockingResources: page.aboveFoldData.renderBlockingResources,
        aboveFoldImageSize: page.aboveFoldData.aboveFoldImageSize,
        issues: page.aboveFoldData.issues,
        warnings: page.aboveFoldData.warnings,
      };
    }

    // Strip anchor text data
    if (page.anchorTextData?.anchors) {
      page.anchorTextData = {
        anchorCount: page.anchorTextData.anchors?.length || 0,
        issues: page.anchorTextData.issues,
        warnings: page.anchorTextData.warnings,
      };
    }

    // Strip external links data
    if (page.externalLinksData?.links) {
      page.externalLinksData = {
        externalLinkCount: page.externalLinksData.links?.length || 0,
        issues: page.externalLinksData.issues,
        warnings: page.externalLinksData.warnings,
      };
    }

    // Strip meta array (metaMap is sufficient)
    if (Array.isArray(page.meta) && page.metaMap) {
      delete page.meta;
    }

    // Strip URL analysis
    if (page.urlAnalysis?.components) {
      page.urlAnalysis = {
        depth: page.urlAnalysis.depth,
        length: page.urlAnalysis.length,
        hasParameters: page.urlAnalysis.hasParameters,
        issues: page.urlAnalysis.issues,
      };
    }

    // Strip response object (headers are large and rarely used)
    if (page.response?.headers) {
      delete page.response;
    }

    // Strip redirect chain (keep only count and final status)
    if (page.redirectChain && Array.isArray(page.redirectChain)) {
      // redirectCount should already be set correctly (length - 1) by crawler-engine
      page.redirectCount = page.redirectCount ?? Math.max(0, page.redirectChain.length - 1);
      page.hasRedirects = page.redirectChain.length > 0;
      delete page.redirectChain;
    }

    // Strip security details (keep score and issue counts)
    if (page.security) {
      page.security = {
        securityScore: page.security.securityScore,
        missingHeaders: page.security.missingHeaders?.slice(0, 5),
        mixedContent: page.security.mixedContent,
        insecureCookies: page.security.insecureCookies,
        issues: page.security.issues?.slice(0, 10),
        warnings: page.security.warnings?.slice(0, 10),
      };
    }

    // Limit issues/warnings arrays on all analyzers
    const limitIssuesWarnings = (obj) => {
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
     'anchorTextData', 'externalLinksData'].forEach(key => {
      if (page[key]) {
        limitIssuesWarnings(page[key]);
      }
    });

    return page;
  }
}

module.exports = { ProgressManager };
