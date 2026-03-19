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
    // Use a dynamic view for mutation operations on arbitrary fields
    const dyn = page as unknown as Record<string, unknown>;
    // Strip raw schema data but preserve key fields needed by site-wide validators
    if (page.structuredData?.jsonLdSchemas) {
      for (const schema of page.structuredData.jsonLdSchemas) {
        const raw = schema.raw as Record<string, unknown> | undefined;
        if (raw) {
          // Keep only fields used by StructuredDataValidator for consistency checks
          schema.raw = {
            name: raw['name'],
            headline: raw['headline'],
            ...(raw['@type'] ? { '@type': raw['@type'] } : {}),
          } as typeof schema.raw;
        }
      }
    }

    // Reduce requests to summary
    if (
      page.requests &&
      typeof page.requests === 'object' &&
      !(page.requests as Record<string, unknown>)['totalRequests']
    ) {
      const entries = Object.entries(page.requests as Record<string, RequestData>);
      const byType: Record<string, number> = {};
      let totalSize = 0;
      for (const [, req] of entries) {
        byType[req.resourceType ?? 'other'] = (byType[req.resourceType ?? 'other'] ?? 0) + 1;
        if (req.size) totalSize += req.size;
      }
      dyn['requests'] = { totalRequests: entries.length, byType, totalSize };
    }

    // Reduce links to only problematic ones
    if (Array.isArray(page.links) && page.links.length > 0) {
      dyn['linksCount'] = (page.linksCount ?? 0) || page.links.length;
      dyn['internalLinksCount'] =
        (page.internalLinksCount ?? 0) || page.links.filter((l: LinkData) => l.isInternal).length;
      dyn['externalLinksCount'] =
        (page.externalLinksCount ?? 0) || page.links.filter((l: LinkData) => !l.isInternal).length;
      dyn['links'] = page.links.filter((l: LinkData) => !l.text || l.text.trim() === '').slice(0, 20);
    }

    // Reduce images to only problematic ones
    if (Array.isArray(page.images) && page.images.length > 0) {
      dyn['imagesCount'] = (page.imagesCount ?? 0) || page.images.length;
      dyn['imagesWithoutAltCount'] =
        (page.imagesWithoutAltCount ?? 0) || page.images.filter((i: ImageData) => !i.alt || i.alt.trim() === '').length;
      dyn['images'] = page.images.filter((i: ImageData) => !i.alt || i.alt.trim() === '').slice(0, 10);
    }

    // Strip vitals detail
    if (page.vitals) {
      const vitals = page.vitals as unknown as Record<string, unknown>;
      delete vitals['lcpSubParts'];
      delete vitals['clsEntries'];
      delete vitals['longTasks'];
      const lcpAnalysis = vitals['lcpAnalysis'] as Record<string, unknown> | undefined;
      if (lcpAnalysis) {
        vitals['lcpAnalysis'] = {
          bottleneck: lcpAnalysis['bottleneck'],
          recommendation: lcpAnalysis['recommendation'],
        };
      }
    }

    // Delete heavy objects
    delete dyn['metrics'];
    delete dyn['blockers'];

    // Strip linkAnalysis
    if (page.linkAnalysis) {
      const la = page.linkAnalysis as unknown as Record<string, unknown>;
      if (la['links']) {
        dyn['linkAnalysis'] = {
          internalLinks: (la['internalLinks'] as number) || 0,
          externalLinks: (la['externalLinks'] as number) || 0,
          brokenLinks: (la['brokenLinks'] as number) || 0,
          issues: la['issues'],
          warnings: la['warnings'],
        };
      }
    }

    // Strip contentQuality
    if (page.contentQuality) {
      const cq = page.contentQuality as unknown as Record<string, unknown>;
      if (cq['keywords']) {
        delete cq['keywords'];
        const topKw = cq['topKeywords'] as unknown[] | undefined;
        if (topKw) cq['topKeywords'] = topKw.slice(0, 5);
      }
    }

    // Strip third-party data
    if (page.thirdPartyData) {
      const tpd = page.thirdPartyData as unknown as Record<string, unknown>;
      if (tpd['scripts']) {
        dyn['thirdPartyData'] = {
          totalScripts: (tpd['scripts'] as unknown[]).length,
          totalSize: (tpd['totalSize'] as number) || 0,
          issues: tpd['issues'],
          warnings: tpd['warnings'],
        };
      }
    }

    // Strip timing data
    if (page.timingData) {
      const td = page.timingData as unknown as Record<string, unknown>;
      if (td['resourceTimings']) {
        dyn['timingData'] = {
          slowResources: ((td['slowResources'] as unknown[]) || []).slice(0, 5),
          issues: td['issues'],
          warnings: td['warnings'],
        };
      }
    }

    // Strip critical path data
    if (page.criticalPathData) {
      const cpd = page.criticalPathData as unknown as Record<string, unknown>;
      if (cpd['blockingCSS']) {
        dyn['criticalPathData'] = {
          blockingCSSCount: (cpd['blockingCSS'] as unknown[])?.length || 0,
          blockingJSCount: (cpd['blockingJS'] as unknown[])?.length || 0,
          issues: cpd['issues'],
          warnings: cpd['warnings'],
        };
      }
    }

    // Strip font data
    if (page.fontData) {
      const fd = page.fontData as unknown as Record<string, unknown>;
      if (fd['fonts']) {
        dyn['fontData'] = {
          totalFonts: (fd['fonts'] as unknown[]).length,
          issues: fd['issues'],
          warnings: fd['warnings'],
        };
      }
    }

    // Strip compression data
    if (page.compressionData) {
      const cd = page.compressionData as unknown as Record<string, unknown>;
      if (cd['resources']) {
        dyn['compressionData'] = {
          issues: cd['issues'],
          warnings: cd['warnings'],
        };
      }
    }

    // Strip image optimization data (preserve fields for reports)
    if (page.imageOptimization) {
      const io = page.imageOptimization as unknown as Record<string, unknown>;
      if (io['images']) {
        dyn['imageOptimization'] = {
          totalImages: (io['images'] as unknown[]).length,
          withLazyLoading: io['withLazyLoading'],
          modernFormats: io['modernFormats'],
          legacyFormats: io['legacyFormats'],
          totalImageSize: io['totalImageSize'],
          issues: io['issues'],
          warnings: io['warnings'],
        };
      }
    }

    // Strip console analysis
    if (page.consoleAnalysis) {
      const ca = page.consoleAnalysis as unknown as Record<string, unknown>;
      if (ca['errors']) {
        dyn['consoleAnalysis'] = {
          errorCount: (ca['errors'] as unknown[])?.length || 0,
          warningCount: (ca['warnings'] as unknown[])?.length || 0,
          issues: ca['issues'],
        };
      }
    }

    // Strip form data (preserve accessibilityScore for score-calculator)
    if (page.formData) {
      const form = page.formData as unknown as Record<string, unknown>;
      if (form['forms']) {
        dyn['formData'] = {
          formCount: (form['forms'] as unknown[]).length,
          accessibilityScore: form['accessibilityScore'],
          issues: form['issues'],
          warnings: form['warnings'],
        };
      }
    }

    // Strip resource optimization (preserve fields for reports)
    if (page.resourceOptimization) {
      const ro = page.resourceOptimization as unknown as Record<string, unknown>;
      if (ro['renderBlockingResources']) {
        dyn['resourceOptimization'] = {
          renderBlockingCount: (ro['renderBlockingResources'] as unknown[])?.length || 0,
          renderBlocking: ro['renderBlocking'],
          compression: ro['compression'],
          minification: ro['minification'],
          issues: ro['issues'],
          warnings: ro['warnings'],
        };
      }
    }

    // Strip headings (preserve h3-h6 counts for pages-table)
    if (page.headings) {
      const h = page.headings as unknown as Record<string, unknown>;
      if (h['h1'] && Array.isArray(h['h1'])) {
        dyn['headings'] = {
          h1Count: (h['h1'] as unknown[]).length,
          h2Count: (h['h2'] as unknown[])?.length || 0,
          h3Count: (h['h3'] as unknown[])?.length || 0,
          h4Count: (h['h4'] as unknown[])?.length || 0,
          h5Count: (h['h5'] as unknown[])?.length || 0,
          h6Count: (h['h6'] as unknown[])?.length || 0,
          h1: (h['h1'] as string[]).map((hx) => (typeof hx === 'string' ? hx.substring(0, 100) : hx)),
          issues: h['issues'],
          warnings: h['warnings'],
        };
      }
    }

    // Strip accessibility data (preserve a11yScore for score-calculator)
    if (page.accessibility) {
      const acc = page.accessibility as unknown as Record<string, unknown>;
      if (acc['violations']) {
        dyn['accessibility'] = {
          a11yScore: acc['a11yScore'],
          violationCount: (acc['violations'] as unknown[])?.length || 0,
          issues: acc['issues'],
          warnings: acc['warnings'],
        };
      }
    }

    // Strip caching data (preserve cacheScore, CDN info for reports)
    if (page.caching) {
      const cach = page.caching as unknown as Record<string, unknown>;
      if (cach['resources']) {
        dyn['caching'] = {
          cacheScore: cach['cacheScore'],
          cachedCount: (cach['cachedCount'] as number) || 0,
          uncachedCount: (cach['uncachedCount'] as number) || 0,
          hasCDN: cach['hasCDN'],
          cdnProvider: cach['cdnProvider'],
          hasServiceWorker: cach['hasServiceWorker'],
          staticCached: cach['staticCached'],
          staticUncached: cach['staticUncached'],
          issues: cach['issues'],
          warnings: cach['warnings'],
        };
      }
    }

    // Strip media data
    if (page.mediaData) {
      const med = page.mediaData as unknown as Record<string, unknown>;
      if (med['videos'] || med['audios']) {
        dyn['mediaData'] = {
          videoCount: (med['videos'] as unknown[])?.length || 0,
          audioCount: (med['audios'] as unknown[])?.length || 0,
          issues: med['issues'],
          warnings: med['warnings'],
        };
      }
    }

    // Strip web component data
    if (page.webComponentData) {
      const wcd = page.webComponentData as unknown as Record<string, unknown>;
      if (wcd['components']) {
        dyn['webComponentData'] = {
          componentCount: (wcd['components'] as unknown[])?.length || 0,
          issues: wcd['issues'],
          warnings: wcd['warnings'],
        };
      }
    }

    // Strip above-fold data
    if (page.aboveFoldData) {
      const afd = page.aboveFoldData as unknown as Record<string, unknown>;
      if (afd['aboveFoldElements']) {
        dyn['aboveFoldData'] = {
          lcpInViewport: afd['lcpInViewport'],
          renderBlockingResources: afd['renderBlockingResources'],
          aboveFoldImageSize: afd['aboveFoldImageSize'],
          issues: afd['issues'],
          warnings: afd['warnings'],
        };
      }
    }

    // Strip anchor text data
    if (page.anchorTextData) {
      const atd = page.anchorTextData as unknown as Record<string, unknown>;
      if (atd['anchors']) {
        dyn['anchorTextData'] = {
          anchorCount: (atd['anchors'] as unknown[])?.length || 0,
          issues: atd['issues'],
          warnings: atd['warnings'],
        };
      }
    }

    // Strip external links data
    if (page.externalLinksData) {
      const eld = page.externalLinksData as unknown as Record<string, unknown>;
      if (eld['links']) {
        dyn['externalLinksData'] = {
          externalLinkCount: (eld['links'] as unknown[])?.length || 0,
          issues: eld['issues'],
          warnings: eld['warnings'],
        };
      }
    }

    // Strip meta array (metaMap is sufficient)
    if (Array.isArray(page.meta) && page.metaMap) {
      delete dyn['meta'];
    }

    // Strip URL analysis
    if (page.urlAnalysis) {
      const ua = page.urlAnalysis as unknown as Record<string, unknown>;
      if (ua['components']) {
        dyn['urlAnalysis'] = {
          depth: ua['depth'],
          length: ua['length'],
          hasParameters: ua['hasParameters'],
          issues: ua['issues'],
        };
      }
    }

    // Strip response object (headers are large and rarely used)
    if (page.response?.headers) {
      delete dyn['response'];
    }

    // Strip redirect chain (keep only count and final status)
    if (page.redirectChain && Array.isArray(page.redirectChain)) {
      // redirectCount should already be set correctly (length - 1) by crawler-engine
      dyn['redirectCount'] = page.redirectCount ?? Math.max(0, page.redirectChain.length - 1);
      dyn['hasRedirects'] = page.redirectChain.length > 0;
      delete dyn['redirectChain'];
    }

    // Strip security details (keep score and issue counts)
    if (page.security) {
      const sec = page.security as unknown as Record<string, unknown>;
      dyn['security'] = {
        securityScore: sec['securityScore'],
        missingHeaders: (sec['missingHeaders'] as unknown[] | undefined)?.slice(0, 5),
        mixedContent: sec['mixedContent'],
        insecureCookies: sec['insecureCookies'],
        issues: (sec['issues'] as unknown[] | undefined)?.slice(0, 10),
        warnings: (sec['warnings'] as unknown[] | undefined)?.slice(0, 10),
      };
    }

    // Limit issues/warnings arrays on all analyzers
    const limitIssuesWarnings = (obj: { issues?: unknown[]; warnings?: unknown[]; [key: string]: unknown }) => {
      if (obj.issues && Array.isArray(obj.issues)) {
        obj.issues = obj.issues.slice(0, 20);
      }
      if (obj.warnings && Array.isArray(obj.warnings)) {
        obj.warnings = obj.warnings.slice(0, 20);
      }
    };

    // Apply limits to all analyzer outputs
    [
      'linkAnalysis',
      'accessibility',
      'caching',
      'contentQuality',
      'imageOptimization',
      'resourceOptimization',
      'structuredData',
      'headings',
      'internationalSEO',
      'thirdPartyData',
      'timingData',
      'criticalPathData',
      'fontData',
      'compressionData',
      'consoleAnalysis',
      'formData',
      'mediaData',
      'webComponentData',
      'aboveFoldData',
      'anchorTextData',
      'externalLinksData',
    ].forEach((key) => {
      const val = dyn[key];
      if (val && typeof val === 'object') {
        limitIssuesWarnings(val as { issues?: unknown[]; warnings?: unknown[]; [key: string]: unknown });
      }
    });

    return page;
  }
}

export { ProgressManager };
