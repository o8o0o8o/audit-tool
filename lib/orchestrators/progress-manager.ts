/**
 * Progress Manager
 * Handles checkpoint persistence and restoration for SEO audits
 * Uses multi-file format: manifest + metadata + analysis + page batches
 */

import { ErrorAggregator } from '../utils/error-aggregator';
import type { PageInfo } from '../types';
import type { FileManager } from '../storage/file-manager';

interface BatchInfo {
  file: string;
  count: number;
  urls: string[];
  stats?: { compressedSizeMB: number };
}

interface ManifestData {
  version: number;
  format: string;
  domain: string;
  created: string;
  progress: {
    processedPages: string[];
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, number>;
    attempts: Record<string, number>;
  };
  files: {
    metadata: string;
    analysis: string;
    incomingLinks: string;
    pageBatches: Array<{ file: string; count: number; urls?: string[] }>;
  };
}

interface MetadataData {
  robots: Record<string, unknown>;
  sitemaps: Record<string, unknown> & { total?: number };
  isMultiLang: boolean;
  timing: Record<string, unknown>;
  cruxData?: unknown;
}

interface ProgressResults {
  robots: Record<string, unknown>;
  sitemaps: Record<string, unknown> & { total?: number };
  isMultiLang?: boolean;
  timing?: Record<string, unknown>;
  cruxData?: unknown;
  pageData: {
    pages: Record<string, PageInfo>;
    processedPages: Set<string> | string[];
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, number>;
    attempts: Record<string, number>;
    incomingLinks?: Record<string, string[]>;
  };
  analysis: {
    overall: Set<string> | string[];
    details: Record<string, unknown>;
    bySeverity: Record<string, string[]>;
    summary: Record<string, number>;
  };
}

interface LinkData {
  isInternal?: boolean;
  text?: string;
  [key: string]: unknown;
}

interface ImageData {
  alt?: string;
  [key: string]: unknown;
}

interface RequestData {
  resourceType?: string;
  size?: number;
  [key: string]: unknown;
}

class ProgressManager {
  #pendingPages: Record<string, PageInfo> = {};
  #writtenBatches: BatchInfo[] = [];
  #isWriting = false;
  #writeQueue: ProgressResults[] = [];
  #flushWaiters: Array<() => void> = [];
  #pendingFlush: Promise<void> | null = null;

  fileManager: FileManager;
  verbose: boolean;

  /**
   * Create a new ProgressManager
   * @param {FileManager} fileManager - FileManager instance for I/O operations
   */
  constructor(fileManager: FileManager, { verbose = false } = {}) {
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
  async loadProgress(domainName: string, resultsDir: string) {
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
    const pages: Record<string, PageInfo> = {};
    const batches = (manifest as ManifestData).files?.pageBatches || [];

    for (const batchInfo of batches) {
      try {
        const batchData = this.fileManager.readBatchByPath(batchInfo.file);
        Object.assign(pages, batchData.pages);
        console.log(`    Loaded ${Object.keys(batchData.pages).length} pages from ${batchInfo.file}`);
      } catch (error: unknown) {
        console.warn(`    ⚠️  Could not load batch ${batchInfo.file}: ${(error as Error).message}`);
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
    const manifestData = manifest as ManifestData;
    const processedPagesArray = Array.isArray(manifestData.progress.processedPages)
      ? manifestData.progress.processedPages
      : [];
    const processedPagesSet = new Set(processedPagesArray);

    const metadataTyped = metadata as MetadataData;
    const restoredResults = {
      robots: metadataTyped.robots,
      sitemaps: metadataTyped.sitemaps,
      isMultiLang: metadataTyped.isMultiLang,
      timing: metadataTyped.timing,
      pageData: {
        pages,
        processedPages: processedPagesSet,
        totalWithoutError: manifestData.progress.totalWithoutError,
        totalWithError: manifestData.progress.totalWithError,
        byError: manifestData.progress.byError,
        attempts: manifestData.progress.attempts,
        incomingLinks: incomingLinksData.incomingLinks,
      },
      analysis: errorAggregator.getRawData(),
    };

    // Set written batches for resume
    this.#writtenBatches = batches.map((b) => ({
      file: b.file,
      count: b.count,
      urls: b.urls ?? [],
    }));
    this.fileManager.setCurrentBatchNumber(batches.length);

    console.log(`✓ Progress restored successfully`);
    console.log(`  - Processed pages: ${restoredResults.pageData.processedPages.size}`);
    console.log(`  - Total pages in memory: ${Object.keys(pages).length}`);
    console.log(`  - Total URLs in sitemap: ${restoredResults.sitemaps?.total ?? 0}\n`);

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
  addPage(url: string, pageData: PageInfo) {
    // Validate and truncate oversized page data to prevent memory issues
    const MAX_PAGE_SIZE_BYTES = 500 * 1024; // 500KB per page max
    const MAX_ARRAY_LENGTH = 100; // Max items in arrays
    const MAX_PENDING_PAGES = 500; // Max pages in memory before auto-flush

    try {
      const estimatedSize = JSON.stringify(pageData).length;

      if (estimatedSize > MAX_PAGE_SIZE_BYTES) {
        console.warn(`⚠️  Page data for ${url} is large (${Math.round(estimatedSize / 1024)}KB), truncating...`);

        // Truncate large arrays to reduce size
        const truncatedPage = this.#truncateLargeArrays(pageData, MAX_ARRAY_LENGTH) as PageInfo;

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
    } catch (error: unknown) {
      // If JSON.stringify fails (circular refs, etc.), store minimal data
      console.warn(`⚠️  Could not validate page size for ${url}: ${(error as Error).message}`);
      this.#pendingPages[url] = {
        url: pageData.url,
        statusCode: pageData.statusCode,
        title: pageData.title,
        error: 'Page data could not be serialized',
      } as PageInfo;
    }

    // Auto-flush if pending pages exceed memory threshold
    const pendingCount = Object.keys(this.#pendingPages).length;
    if (pendingCount >= MAX_PENDING_PAGES) {
      console.log(`  📦 Auto-flushing ${pendingCount} pending pages to prevent memory issues...`);
      // Track the flush promise so saveProgress() can await it before writing
      this.#pendingFlush = this.flushPendingPages(true)
        .then(() => {})
        .catch((err) => {
          console.warn(`  ⚠️  Auto-flush failed: ${err.message}`);
        })
        .finally(() => {
          this.#pendingFlush = null;
        });
      return true;
    }
    return false;
  }

  /**
   * Truncate large arrays in an object recursively
   * @private
   */
  #truncateLargeArrays(obj: unknown, maxLength: number, depth: number = 0): unknown {
    if (depth > 5) return obj; // Prevent infinite recursion

    if (Array.isArray(obj)) {
      return obj.slice(0, maxLength);
    }

    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
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
   * Wait for any in-progress auto-flush to complete.
   * Call before saveProgress() to ensure no data is lost.
   */
  async waitForPendingFlush() {
    if (this.#pendingFlush) {
      await this.#pendingFlush;
    }
  }

  /**
   * Flush pending pages to batch files if threshold reached
   * Uses write lock with queuing to prevent concurrent disk operations
   * @param {boolean} force - Force flush even if below threshold
   * @returns {Promise<Array>} Written batch info
   */
  async flushPendingPages(force: boolean = false) {
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
          this.#flushWaiters.push(() => {
            clearTimeout(timeoutId);
            resolve(undefined);
          });
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
        notify!();
      }
    }
  }

  /**
   * Internal method that performs the actual flush
   * @private
   */
  #doFlushPendingPages(force: boolean, batchSize: number) {
    const pendingEntries = Object.entries(this.#pendingPages);

    if (pendingEntries.length === 0) {
      return [];
    }

    const newBatches: BatchInfo[] = [];

    // Write complete batches
    for (let i = 0; i < pendingEntries.length; i += batchSize) {
      const batchEntries = pendingEntries.slice(i, i + batchSize);

      // Only write if we have a full batch or force flush
      if (batchEntries.length < batchSize && !force) {
        break;
      }

      const batchPages: Record<string, PageInfo> = {};
      for (const [url, page] of batchEntries) {
        // Optimize page before writing
        batchPages[url] = this.#optimizePageInMemory({ ...page });
        delete this.#pendingPages[url];
      }

      const batchNum = this.fileManager.getNextBatchNumber();
      const batchInfo = this.fileManager.writeBatch(batchNum, batchPages);

      console.log(
        `  📦 Wrote batch ${batchNum}: ${batchInfo.count} pages (${batchInfo.stats.compressedSizeMB.toFixed(2)} MB)`,
      );

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
  saveProgress(results: ProgressResults) {
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
        const queuedResults = this.#writeQueue.pop()!;
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
  #doSaveProgress(results: ProgressResults) {
    // Get URLs that have already been written to batches
    const writtenUrls = new Set<string>();
    for (const batch of this.#writtenBatches) {
      for (const url of batch.urls || []) {
        writtenUrls.add(url);
      }
    }

    // Find pages that need to be written (not yet in any batch)
    const pagesToWrite: Record<string, PageInfo> = {};
    const allPages = results.pageData.pages || {};
    for (const url in allPages) {
      if (!writtenUrls.has(url)) {
        pagesToWrite[url] = allPages[url];
      }
    }

    // Write new pages to batches
    const batchSize = this.fileManager.batchSize;
    const pageEntries = Object.entries(pagesToWrite);
    const urlsWritten: string[] = [];

    if (pageEntries.length > 0) {
      for (let i = 0; i < pageEntries.length; i += batchSize) {
        const batchEntries = pageEntries.slice(i, i + batchSize);
        const batchPages: Record<string, PageInfo> = {};

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
        Object.entries(results.pageData.pages).filter(([url]) => !urlsToRemove.has(url)),
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
      cruxData: results.cruxData ?? null,
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
    const incomingLinks = results.pageData.incomingLinks ?? {};
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
        pageBatches: this.#writtenBatches.map((b) => ({
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
  reloadEvictedPages(pages: Record<string, PageInfo>) {
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
      } catch (error: unknown) {
        console.warn(`  ⚠️  Could not reload batch ${batch.file}: ${(error as Error).message}`);
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
  #processIncomingLinks(incomingLinks: Record<string, string[] | number>) {
    const tracking = new Map<string, Set<string>>();
    const processed: Record<string, string[]> = {};

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

  #optimizePageInMemory(page: PageInfo): PageInfo {
    // Strip raw schema data but preserve key fields needed by site-wide validators
    if (page.structuredData?.jsonLdSchemas) {
      for (const schema of page.structuredData.jsonLdSchemas) {
        if (schema.raw) {
          schema.raw = {
            name: schema.raw['name'],
            headline: schema.raw['headline'],
            ...(schema.raw['@type'] ? { '@type': schema.raw['@type'] } : {}),
          };
        }
      }
    }

    // Reduce requests to summary
    if (page.requests && !(page.requests as Record<string, unknown>)['totalRequests']) {
      const entries = Object.entries(page.requests as Record<string, RequestData>);
      const byType: Record<string, number> = {};
      let totalSize = 0;
      for (const [, req] of entries) {
        byType[req.resourceType ?? 'other'] = (byType[req.resourceType ?? 'other'] ?? 0) + 1;
        if (req.size) totalSize += req.size;
      }
      page.requests = { totalRequests: entries.length, byType, totalSize };
    }

    // Reduce links to only problematic ones
    if (Array.isArray(page.links) && page.links.length > 0) {
      page.linksCount = (page.linksCount ?? 0) || page.links.length;
      page.internalLinksCount =
        (page.internalLinksCount ?? 0) || page.links.filter((l: LinkData) => l.isInternal).length;
      page.externalLinksCount =
        (page.externalLinksCount ?? 0) || page.links.filter((l: LinkData) => !l.isInternal).length;
      page.links = page.links.filter((l: LinkData) => !l.text || l.text.trim() === '').slice(0, 20);
    }

    // Reduce images to only problematic ones
    if (page.images && 'totalImages' in page.images && Array.isArray((page.images as unknown as Record<string, unknown>)['images'])) {
      // images is ImageAnalysis but may have raw image array from crawler
    } else if (Array.isArray(page.images)) {
      const imgArr = page.images as unknown as ImageData[];
      page.imagesCount = (page.imagesCount ?? 0) || imgArr.length;
      page.imagesWithoutAltCount =
        (page.imagesWithoutAltCount ?? 0) || imgArr.filter((i) => !i.alt || i.alt.trim() === '').length;
      (page as unknown as Record<string, unknown>).images = imgArr.filter((i) => !i.alt || i.alt.trim() === '').slice(0, 10);
    }

    // Strip vitals detail
    if (page.vitals) {
      delete page.vitals['lcpSubParts'];
      delete page.vitals['clsEntries'];
      delete page.vitals['longTasks'];
      const lcpAnalysis = page.vitals['lcpAnalysis'] as Record<string, unknown> | undefined;
      if (lcpAnalysis) {
        page.vitals['lcpAnalysis'] = {
          bottleneck: lcpAnalysis['bottleneck'],
          recommendation: lcpAnalysis['recommendation'],
        };
      }
    }

    // Delete heavy objects
    delete page.metrics;
    delete page.blockers;

    // Strip linkAnalysis to summary
    if (page.linkAnalysis) {
      page.linkAnalysis = {
        internalLinks: page.linkAnalysis.internalLinks ?? 0,
        externalLinks: page.linkAnalysis.externalLinks ?? 0,
        brokenLinks: typeof page.linkAnalysis.brokenLinks === 'number' ? page.linkAnalysis.brokenLinks : 0,
        issues: page.linkAnalysis.issues,
        warnings: page.linkAnalysis.warnings,
      };
    }

    // Strip contentQuality keywords
    if (page.contentQuality) {
      delete (page.contentQuality as unknown as Record<string, unknown>)['keywords'];
      if (page.contentQuality.topKeywords) {
        page.contentQuality.topKeywords = page.contentQuality.topKeywords.slice(0, 5);
      }
    }

    // Strip third-party data to summary
    if (page.thirdPartyData?.scripts) {
      page.thirdPartyData = {
        totalScripts: page.thirdPartyData.scripts.length,
        totalSize: page.thirdPartyData.totalSize ?? 0,
        issues: page.thirdPartyData.issues,
        warnings: page.thirdPartyData.warnings,
      };
    }

    // Strip timing data to summary
    if (page.timingData?.resourceTimings) {
      page.timingData = {
        slowResources: (page.timingData.slowResources ?? []).slice(0, 5),
        issues: page.timingData.issues,
        warnings: page.timingData.warnings,
      };
    }

    // Strip critical path data to counts
    if (page.criticalPathData?.blockingCSS) {
      page.criticalPathData = {
        blockingCSSCount: page.criticalPathData.blockingCSS.length,
        blockingJSCount: page.criticalPathData.blockingJS?.length ?? 0,
        issues: page.criticalPathData.issues,
        warnings: page.criticalPathData.warnings,
      };
    }

    // Strip font data to count
    if (page.fontData) {
      const fonts = page.fontData['fonts'] as unknown[] | undefined;
      if (fonts) {
        page.fontData = {
          totalFonts: fonts.length,
          issues: page.fontData['issues'],
          warnings: page.fontData['warnings'],
        };
      }
    }

    // Strip compression data to issues only
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

    // Strip console analysis to counts
    if (page.consoleAnalysis?.errors) {
      page.consoleAnalysis = {
        errorCount: page.consoleAnalysis.errors.length,
        warningCount: (page.consoleAnalysis.warnings as unknown[] | undefined)?.length ?? 0,
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
        renderBlockingCount: page.resourceOptimization.renderBlockingResources.length,
        renderBlocking: page.resourceOptimization.renderBlocking,
        compression: page.resourceOptimization.compression,
        minification: page.resourceOptimization.minification,
        issues: page.resourceOptimization.issues,
        warnings: page.resourceOptimization.warnings,
      };
    }

    // Strip headings (preserve counts for pages-table)
    if (page.headings?.h1) {
      page.headings = {
        h1Count: page.headings.h1.length,
        h2Count: page.headings.h2?.length ?? 0,
        h3Count: page.headings.h3?.length ?? 0,
        h4Count: page.headings.h4?.length ?? 0,
        h5Count: page.headings.h5?.length ?? 0,
        h6Count: page.headings.h6?.length ?? 0,
        h1: page.headings.h1.map((h) => (typeof h === 'string' ? h.substring(0, 100) : h)),
        issues: page.headings.issues,
        warnings: page.headings.warnings,
      };
    }

    // Strip accessibility data (preserve a11yScore for score-calculator)
    if (page.accessibility?.violations) {
      page.accessibility = {
        a11yScore: page.accessibility.a11yScore,
        violationCount: page.accessibility.violations.length,
        issues: page.accessibility.issues,
        warnings: page.accessibility.warnings,
      };
    }

    // Strip caching data (preserve cacheScore, CDN info for reports)
    if (page.caching?.resources) {
      page.caching = {
        cacheScore: page.caching.cacheScore,
        cachedCount: page.caching.cachedCount ?? 0,
        uncachedCount: page.caching.uncachedCount ?? 0,
        hasCDN: page.caching.hasCDN,
        cdnProvider: page.caching.cdnProvider,
        hasServiceWorker: page.caching.hasServiceWorker,
        staticCached: page.caching.staticCached,
        staticUncached: page.caching.staticUncached,
        issues: page.caching.issues,
        warnings: page.caching.warnings,
      };
    }

    // Strip media data to counts
    if (page.mediaData?.videos || page.mediaData?.audios) {
      page.mediaData = {
        videoCount: page.mediaData.videos?.length ?? 0,
        audioCount: page.mediaData.audios?.length ?? 0,
        issues: page.mediaData.issues,
        warnings: page.mediaData.warnings,
      };
    }

    // Strip web component data to count
    if (page.webComponentData?.components) {
      page.webComponentData = {
        componentCount: page.webComponentData.components.length,
        issues: page.webComponentData.issues,
        warnings: page.webComponentData.warnings,
      };
    }

    // Strip above-fold data to key metrics
    if (page.aboveFoldData?.aboveFoldElements) {
      page.aboveFoldData = {
        lcpInViewport: page.aboveFoldData.lcpInViewport,
        renderBlockingResources: page.aboveFoldData.renderBlockingResources,
        aboveFoldImageSize: page.aboveFoldData.aboveFoldImageSize,
        issues: page.aboveFoldData.issues,
        warnings: page.aboveFoldData.warnings,
      };
    }

    // Strip anchor text data to count
    if (page.anchorTextData?.anchors) {
      page.anchorTextData = {
        anchorCount: page.anchorTextData.anchors.length,
        issues: page.anchorTextData.issues,
        warnings: page.anchorTextData.warnings,
      };
    }

    // Strip external links data to count
    if (page.externalLinksData?.links) {
      page.externalLinksData = {
        externalLinkCount: page.externalLinksData.links.length,
        issues: page.externalLinksData.issues,
        warnings: page.externalLinksData.warnings,
      };
    }

    // Strip meta array (metaMap is sufficient)
    if (Array.isArray(page.meta) && page.metaMap) {
      delete page.meta;
    }

    // Strip URL analysis to key fields
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
      page.redirectCount = page.redirectCount ?? Math.max(0, page.redirectChain.length - 1);
      page.hasRedirects = page.redirectChain.length > 0;
      delete page.redirectChain;
    }

    // Strip security details (keep score and issue counts)
    if (page.security) {
      page.security = {
        isHttps: page.security.isHttps,
        headers: {},
        securityScore: page.security.securityScore,
        missingHeaders: page.security.missingHeaders?.slice(0, 5),
        mixedContent: page.security.mixedContent,
        insecureCookies: page.security.insecureCookies,
        issues: page.security.issues.slice(0, 10),
      };
    }

    // Limit issues/warnings arrays on all analyzer outputs
    const limitArrays = (obj: { issues?: unknown[]; warnings?: unknown[] }) => {
      if (obj.issues && obj.issues.length > 20) obj.issues = obj.issues.slice(0, 20);
      if (obj.warnings && obj.warnings.length > 20) obj.warnings = obj.warnings.slice(0, 20);
    };

    const analyzerFields = [
      page.linkAnalysis, page.accessibility, page.caching,
      page.contentQuality, page.imageOptimization, page.resourceOptimization,
      page.structuredData, page.headings, page.internationalSEO,
      page.thirdPartyData, page.timingData, page.criticalPathData,
      page.fontData as { issues?: unknown[]; warnings?: unknown[] } | undefined,
      page.compressionData, page.consoleAnalysis, page.formData,
      page.mediaData, page.webComponentData, page.aboveFoldData,
      page.anchorTextData, page.externalLinksData,
    ];
    for (const field of analyzerFields) {
      if (field) limitArrays(field);
    }

    return page;
  }
}

export { ProgressManager };
