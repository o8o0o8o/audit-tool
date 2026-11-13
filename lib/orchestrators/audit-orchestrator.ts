/**
 * Audit Orchestrator
 * Handles site-wide validation and audit workflow coordination
 */

import { checkFaviconAndManifest } from '../analyzers/performance/favicon-manifest-validator';
import { detectLanguagePatternsInUrls } from './language-pattern-detector';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { SEVERITY, CRAWL_SETTINGS } from '../constants';
import { escapeHtml } from '../reports/html-utils';
import { loadConfig } from '../config-loader';
import { populateIncomingLinksCount } from '../crawler/page-data-builder';
import type { QueryParamConfig } from '../crawler/crawler-types';
import type { PageInfo, SitemapUrl, AlternateLink, Issue, SeverityLevel, SiteTextFilesData } from '../types';
import { SiteTextFilesAnalyzer } from '../analyzers/seo/site-text-files-analyzer';

interface AnalyzeContext {
  results: {
    sitemaps: { urls: Record<string, SitemapUrl> };
    isMultiLang?: boolean;
    pageData: {
      pages: Record<string, PageInfo>;
      processedPages: Set<string> | string[];
      totalWithoutError: number;
      totalWithError: number;
      byError: Record<string, number>;
      attempts: Record<string, number>;
      total?: number;
      isMultiLang?: boolean;
      incomingLinks?: Record<string, string[]>;
    };
  };
  crawlerEngine: {
    crawlPages: (opts: Record<string, unknown>) => Promise<{
      alternatesErrors: string[];
      isMultiLang: boolean;
      failedPages: string[];
    }>;
    capturePSIForSampled?: () => Promise<{ attempted: number; succeeded: number }>;
    getSampledUrls?: () => string[];
    finalizeIncomingLinks: (results: unknown, incomingLinksTracking: Map<string, Set<string>>) => void;
  };
  incomingLinksTracking: Map<string, Set<string>>;
  saveError: SaveErrorFn;
  /** Site origin; when the sitemap yields no URLs the crawl is seeded from its homepage. */
  origin?: string | null;
  resultsDir: string;
}

interface PageDataForValidation {
  pages: Record<string, PageInfo>;
  incomingLinks?: Record<string, string[]>;
  segments?: unknown;
  segmentStats?: unknown;
  contentGaps?: unknown;
  contentCoverage?: unknown;
  contentGapStats?: unknown;
  linkingOpportunities?: unknown;
  linkingStats?: unknown;
  dnsData?: unknown;
  externalLinkVerification?: unknown;
  truncatedPaginationSeries?: Record<string, number>;
}

type SaveErrorFn = (
  generalError: string,
  detailedError: string | null | undefined,
  severity?: SeverityLevel | string,
) => void;

interface ValidationResult {
  issues?: Issue[];
  warnings?: Issue[];
  [key: string]: unknown;
}

const VALIDATOR_TIMEOUT_MS = CRAWL_SETTINGS.VALIDATOR_TIMEOUT_MS;

// Site-wide validators
import { DuplicateChecker } from '../analyzers/site-wide/duplicate-checker';
import { StructuredDataValidator } from '../analyzers/site-wide/structured-data-validator';
import { LinkStructureAnalyzer } from '../analyzers/site-wide/link-structure-analyzer';
import { SocialMediaValidator } from '../analyzers/site-wide/social-media-validator';
import { AnalyticsValidator } from '../analyzers/site-wide/analytics-validator';
import { IndexabilityValidator } from '../analyzers/site-wide/indexability-validator';
import { InternationalSEOValidator } from '../analyzers/site-wide/international-seo-validator';
import { LinkDepthAnalyzer } from '../analyzers/site-wide/link-depth-analyzer';
import { UrlArchitectureAnalyzer } from '../analyzers/seo/url-architecture-analyzer';
import { FreshnessAnalyzer } from '../analyzers/content/freshness-analyzer';
import { EEATAnalyzer } from '../analyzers/seo/eeat-analyzer';
import { TechnicalSEOAnalyzer } from '../analyzers/seo/technical-seo-analyzer';
import { ThinContentAnalyzer } from '../analyzers/content/thin-content-analyzer';
import { KeywordCannibalisationAnalyzer } from '../analyzers/site-wide/keyword-cannibalisation-analyzer';
import { Soft404Analyzer } from '../analyzers/seo/soft-404-analyzer';
import { ConsoleErrorAnalyzer } from '../analyzers/seo/console-error-analyzer';
import { PaginationAnalyzer } from '../analyzers/seo/pagination-analyzer';
import { BrokenPaginationAnalyzer } from '../analyzers/site-wide/broken-pagination-analyzer';
import { MediaSEOAnalyzer } from '../analyzers/seo/media-seo-analyzer';
import { WebComponentAnalyzer } from '../analyzers/seo/web-component-analyzer';
import { FontLoadingAnalyzer } from '../analyzers/performance/font-loading-analyzer';
import { ThirdPartyAnalyzer } from '../analyzers/performance/third-party-analyzer';
import { CriticalPathAnalyzer } from '../analyzers/performance/critical-path-analyzer';
import { ConnectionTimingAnalyzer } from '../analyzers/performance/connection-timing-analyzer';
import { FormAccessibilityAnalyzer } from '../analyzers/accessibility/form-accessibility-analyzer';
import { CookieConsentAnalyzer } from '../analyzers/security/cookie-consent-analyzer';

// New site-wide analyzers
import { RedirectChainAnalyzer } from '../analyzers/performance/redirect-chain-analyzer';
import { CompressionAnalyzer } from '../analyzers/performance/compression-analyzer';
import { ResourceHintsAnalyzer } from '../analyzers/performance/resource-hints-analyzer';
import { MixedContentAnalyzer } from '../analyzers/security/mixed-content-analyzer';
import { HTTPProtocolAnalyzer } from '../analyzers/performance/http-protocol-analyzer';
import { PWAAnalyzer } from '../analyzers/performance/pwa-analyzer';
import { AboveFoldAnalyzer } from '../analyzers/performance/above-fold-analyzer';
import { JavaScriptRenderingAnalyzer } from '../analyzers/seo/javascript-rendering-analyzer';
import { AnchorTextAnalyzer } from '../analyzers/seo/anchor-text-analyzer';
import { ExternalLinksAnalyzer } from '../analyzers/seo/external-links-analyzer';
import { CrawlBudgetAnalyzer } from '../analyzers/seo/crawl-budget-analyzer';
import { AEOAnalyzer } from '../analyzers/seo/aeo-analyzer';
import { llmsTxtFinding, type LlmsTxtInfo } from '../analyzers/agentic/agentic-checks';
import { ResponseHeaderAnalyzer } from '../analyzers/seo/response-header-analyzer';
import { CTADetectorAnalyzer } from '../analyzers/content/cta-detector-analyzer';
import { LanguageDetectionAnalyzer } from '../analyzers/content/language-detection-analyzer';
import { ContentSimilarityAnalyzer } from '../analyzers/site-wide/content-similarity-analyzer';
import { InternalPageRankAnalyzer } from '../analyzers/site-wide/internal-pagerank-analyzer';
import { CodeCoverageAnalyzer } from '../analyzers/performance/code-coverage-analyzer';
import { OutboundLinkChecker } from '../analyzers/content/outbound-link-checker';
import { PageSegmentAnalyzer } from '../analyzers/site-wide/page-segment-analyzer';
import { ContentGapAnalyzer } from '../analyzers/site-wide/content-gap-analyzer';
import { LinkingOpportunityAnalyzer } from '../analyzers/site-wide/linking-opportunity-analyzer';
import { DNSIPv6Analyzer } from '../analyzers/performance/dns-ipv6-analyzer';
import { normalizeUrlForComparison } from '../utils';

/**
 * Total pages this run actually attempted — success + error, across both the
 * sitemap crawl and the "missing from sitemap" second pass. Deliberately NOT
 * the sitemap frontier size: that undercounts once pages discovered outside
 * the sitemap get crawled too, especially with `--limit` capping the sitemap
 * side but not the discovered-URL side (cli-summary's success-rate percentage
 * must never exceed 100%, since it divides by exactly this value).
 */
export function computeTotalPagesProcessed(pageData: { totalWithoutError: number; totalWithError: number }): number {
  return pageData.totalWithoutError + pageData.totalWithError;
}

class AuditOrchestrator {
  /**
   * Analyze all pages - main crawling orchestration
   * @param {Object} context - Analysis context
   * @param {Object} context.results - Results object with sitemaps, pageData, isMultiLang
   * @param {Object} context.crawlerEngine - CrawlerEngine instance
   * @param {Map} context.incomingLinksTracking - Map for tracking incoming links
   * @param {Function} context.saveError - Callback to save errors
   * @param {string} context.resultsDir - Directory for results
   * @returns {Promise<void>}
   */
  static async analyzePages(context: AnalyzeContext) {
    const { results, crawlerEngine, incomingLinksTracking, saveError, resultsDir } = context;

    const uniquePages = new Set(Object.keys(results.sitemaps.urls));
    const collectedURLs = new Set<string>();

    // Build the crawl frontier from the sitemap, deduped on a canonical key
    // (hash + trailing-slash stripped) so trailing-slash variants of the same
    // page — and the bare origin vs its root-slash form — are crawled only
    // ONCE. Without this, a sitemap loc `https://site` and an in-page link to
    // `/` (normalised to `https://site/`) are treated as two pages, double-
    // counting every per-page finding and manufacturing a self-cannibalisation
    // finding for the homepage. The first-seen URL form is kept (so the report
    // shows whatever convention the sitemap/site actually uses). The shared
    // key set is threaded through both crawl passes; discovered links consult
    // it in collectLinks().
    const crawlFrontierKeys = new Set<string>();
    const pagesToCrawl: string[] = [];
    for (const url of uniquePages) {
      const key = normalizeUrlForComparison(url);
      if (crawlFrontierKeys.has(key)) continue;
      crawlFrontierKeys.add(key);
      pagesToCrawl.push(url);
    }

    // No sitemap URLs (missing/empty sitemap): seed from the homepage so link
    // discovery still finds the site, instead of auditing 0 pages. The seed is
    // NOT added to uniquePages, so it stays correctly "not in sitemap".
    const { origin } = context;
    if (pagesToCrawl.length === 0 && origin) {
      const home = `${origin.replace(/\/+$/, '')}/`;
      console.log(`Sitemap has no URLs; crawling from the homepage (${home}) instead.`);
      crawlFrontierKeys.add(normalizeUrlForComparison(home));
      pagesToCrawl.push(home);
    }

    // Detect multilanguage site
    let isMultiLang = AuditOrchestrator.#detectMultilanguage(results);

    console.log('Crawling pages from sitemap...');

    // First crawl: pages from sitemap
    const crawledData = await crawlerEngine.crawlPages({
      pagesToCrawl,
      collectedURLs,
      uniquePages,
      crawlFrontierKeys,
      results,
      incomingLinksTracking,
      sitemapUrls: results.sitemaps.urls,
    });

    let alternatesErrors = crawledData.alternatesErrors;
    isMultiLang = isMultiLang || crawledData.isMultiLang;
    let failedPages = crawledData.failedPages;

    // Second crawl: discovered URLs not in sitemap
    // "Not listed in sitemap" is reported after the crawl (runSiteWideValidation), once each
    // discovered URL's status is known: redirects, 404s and files are not missing pages.
    if (collectedURLs.size) {
      console.log('Crawling pages that are missing in sitemap...');

      const discoveredData = await crawlerEngine.crawlPages({
        pagesToCrawl: Array.from(collectedURLs),
        collectedURLs,
        uniquePages,
        crawlFrontierKeys,
        addMissing: true,
        results,
        incomingLinksTracking,
        sitemapUrls: results.sitemaps.urls,
      });

      alternatesErrors = [...alternatesErrors, ...discoveredData.alternatesErrors];
      isMultiLang = isMultiLang || discoveredData.isMultiLang;
      failedPages = [...discoveredData.failedPages, ...failedPages];
    }

    // Store multilanguage flag in results
    results.isMultiLang = isMultiLang;

    // Add isMultiLang flag to each page
    for (const url in results.pageData.pages) {
      results.pageData.pages[url].isMultiLang = isMultiLang;
    }

    // Finalise incoming links once, after all crawl passes have populated the
    // shared tracking Map. Doing this inside crawlPages would discard earlier
    // passes' data, because the discovered-URL pass would reset the result. The
    // persisted incomingLinks map is the authoritative source the report reads.
    crawlerEngine.finalizeIncomingLinks(results, incomingLinksTracking);

    // Orphaned-page detection and sitemap/crawl-status reconciliation both moved
    // to runSiteWideValidation() — they read results.pageData.pages, and at this
    // point in the crawl some already-processed pages may still be evicted from
    // memory (progress-manager evicts to avoid OOM); the caller only reloads them
    // right before runSiteWideValidation runs, so checking here produced false
    // "not crawled" / silently-skipped-orphan results for pages that were in fact
    // crawled fine. See #reportOrphanedPages / #reconcileSitemapStatusCodes.

    // Per-URL PSI lab data for representative pages (A4). No-op when --perf is
    // off, evidence capture is disabled, or no pages were sampled.
    if (crawlerEngine.capturePSIForSampled) {
      try {
        await crawlerEngine.capturePSIForSampled();
      } catch (error: unknown) {
        console.warn(`⚠️  PSI lab capture failed: ${(error as Error).message}`);
      }
    }

    // Write failed pages file asynchronously to avoid blocking event loop
    if (failedPages.length) {
      fsPromises
        .writeFile(path.join(resultsDir, 'failedPages.json'), JSON.stringify(failedPages))
        .catch((err) => console.warn(`⚠️  Could not write failedPages.json: ${err.message}`));
    }

    // Report alternates errors
    if (isMultiLang && alternatesErrors.length) {
      for (const alternatesError of alternatesErrors) {
        saveError(`Alternates are not set for some pages`, alternatesError, SEVERITY.MEDIUM);
      }
    }

    // NOT uniquePages.size: that's just the sitemap frontier, and with
    // --limit it's capped well below the pages actually crawled once the
    // "missing from sitemap" second pass (collectedURLs, uncapped) runs —
    // e.g. --limit=5 with 33 discovered-but-unlisted pages reports
    // "5 crawled, 38 successful (760%)" in the CLI summary. total must count
    // every page this run actually attempted, matching the same counters
    // totalWithoutError/totalWithError already use as the success-rate numerator.
    results.pageData.total = computeTotalPagesProcessed(results.pageData);
    results.pageData.isMultiLang = isMultiLang;
  }

  /**
   * Detect if site is multilanguage from sitemap, existing pages, or URL patterns
   * @private
   */
  static #detectMultilanguage(results: AnalyzeContext['results']): boolean {
    if (results.isMultiLang) return true;

    // Check sitemap for alternates (xhtml:link rel="alternate")
    for (const url in results.sitemaps.urls) {
      const sitemapEntry = results.sitemaps.urls[url];
      if (sitemapEntry.alternates && Object.keys(sitemapEntry.alternates).length > 0) {
        const hasValidAlternate = Object.values(sitemapEntry.alternates).some(
          (alt: AlternateLink) => alt.hreflang && alt.hreflang !== 'x-default',
        );
        if (hasValidAlternate) {
          console.log(`Detected multilanguage site from sitemap entry: ${url}`);
          return true;
        }
      }
    }

    // Check existing pages for alternates
    for (const url in results.pageData.pages) {
      const page = results.pageData.pages[url];
      if (page.alternates && page.alternates.length > 0) {
        const hasValidAlternate = page.alternates.some(
          (alt: AlternateLink) => alt.hreflang && alt.hreflang !== 'x-default',
        );
        if (hasValidAlternate) {
          console.log(`Detected multilanguage site from previously crawled page: ${url}`);
          return true;
        }
      }
    }

    // Check URL patterns for language indicators (/en/, /de/, /fr/, /en-us/, etc.)
    const langPatterns = detectLanguagePatternsInUrls(results.sitemaps.urls);
    if (langPatterns.isMultiLang) {
      console.log(`Detected multilanguage site from URL patterns: ${langPatterns.languages.join(', ')}`);
      return true;
    }

    return false;
  }

  /**
   * Reconcile sitemap URLs against crawl status codes.
   * Emits one aggregated finding per outcome bucket (4xx, 5xx, 3xx, not-crawled).
   *
   * Must run against the FULLY reloaded page set (post-`reloadEvictedPages`) —
   * called from runSiteWideValidation, never from the crawl-time analyzePages
   * path, where already-crawled pages can still be evicted from memory and
   * would falsely land in the notCrawled bucket.
   * @private
   */
  static #reconcileSitemapStatusCodes(
    pages: Record<string, PageInfo>,
    sitemapUrlsRecord: Record<string, unknown>,
    saveError: SaveErrorFn,
  ) {
    const sitemapUrls = Object.keys(sitemapUrlsRecord);
    if (sitemapUrls.length === 0) return;

    const buckets = {
      redirect: [] as string[], // 3xx
      notFound: [] as string[], // 4xx
      serverError: [] as string[], // 5xx
      notCrawled: [] as string[], // never made it into pageData.pages or no status
    };

    for (const url of sitemapUrls) {
      const page = pages[url];
      const status = page?.statusCode ?? page?.status;
      if (!status || typeof status !== 'number') {
        buckets.notCrawled.push(url);
        continue;
      }
      if (status >= 200 && status < 300) continue;
      if (status >= 300 && status < 400) buckets.redirect.push(url);
      else if (status >= 400 && status < 500) buckets.notFound.push(url);
      else if (status >= 500) buckets.serverError.push(url);
    }

    const formatExamples = (urls: string[], limit = 5) => {
      const list = urls.slice(0, limit).map((u) => `<li><a href="${escapeHtml(u)}">${escapeHtml(u)}</a></li>`).join('');
      const more = urls.length > limit ? ` (showing ${limit} of ${urls.length})` : '';
      return { list, more };
    };

    if (buckets.notFound.length > 0) {
      const { list, more } = formatExamples(buckets.notFound);
      saveError(
        `Sitemap contains URLs that return 4xx`,
        `${buckets.notFound.length} URL(s) in the sitemap return a 4xx status${more}. The sitemap should not include broken pages — it wastes crawl budget and signals low quality:<ul>${list}</ul>`,
        SEVERITY.HIGH,
      );
    }

    if (buckets.serverError.length > 0) {
      const { list, more } = formatExamples(buckets.serverError);
      saveError(
        `Sitemap contains URLs that return 5xx`,
        `${buckets.serverError.length} URL(s) in the sitemap return a 5xx status${more}. Fix the underlying server errors or remove these URLs from the sitemap:<ul>${list}</ul>`,
        SEVERITY.HIGH,
      );
    }

    if (buckets.redirect.length > 0) {
      const { list, more } = formatExamples(buckets.redirect);
      saveError(
        `Sitemap contains URLs that redirect`,
        `${buckets.redirect.length} URL(s) in the sitemap return a 3xx redirect${more}. Sitemap entries should be the final canonical URLs:<ul>${list}</ul>`,
        SEVERITY.MEDIUM,
      );
    }

    if (buckets.notCrawled.length > 0) {
      const { list, more } = formatExamples(buckets.notCrawled);
      saveError(
        `Sitemap URLs were not successfully crawled`,
        `${buckets.notCrawled.length} URL(s) from the sitemap were not crawled (network error, timeout, or skipped)${more}. These may need a re-run or investigation:<ul>${list}</ul>`,
        SEVERITY.LOW,
      );
    }

    const ok =
      sitemapUrls.length -
      buckets.notFound.length -
      buckets.serverError.length -
      buckets.redirect.length -
      buckets.notCrawled.length;
    console.log(
      `Sitemap reconciliation: ${ok}/${sitemapUrls.length} OK, ${buckets.notFound.length} 4xx, ${buckets.serverError.length} 5xx, ${buckets.redirect.length} 3xx, ${buckets.notCrawled.length} not-crawled`,
    );
  }

  /**
   * Report orphaned pages (pages without incoming links).
   *
   * Same reload-ordering requirement as #reconcileSitemapStatusCodes — must
   * run against the fully-reloaded page set, not mid-crawl, or an evicted
   * (temporarily absent) page is silently skipped instead of checked.
   * @private
   */
  static #reportPagesMissingFromSitemap(
    pages: Record<string, PageInfo>,
    sitemapUrls: Record<string, unknown>,
    saveError: SaveErrorFn,
  ) {
    if (Object.keys(sitemapUrls).length === 0) return; // no sitemap: nothing can be "missing" from it
    const inSitemap = new Set(Object.keys(sitemapUrls).map((u) => normalizeUrlForComparison(u)));
    for (const [url, page] of Object.entries(pages)) {
      if (page.foundIn !== 'discovered' || page.status !== 200 || page.redirectOnly || page.nonHtml || page.noindex) continue;
      if (inSitemap.has(normalizeUrlForComparison(url))) continue;
      const escapedUrl = escapeHtml(url);
      saveError(
        `Some URLs are not listed in sitemap`,
        `<a href="${escapedUrl}">${escapedUrl}</a> was found on the site but is not listed in sitemap`,
        SEVERITY.MEDIUM,
      );
    }
  }

  static #reportOrphanedPages(pages: Record<string, PageInfo>, saveError: SaveErrorFn) {
    let orphanedPagesCount = 0;

    for (const url in pages) {
      const page = pages[url];
      // Page is orphaned if it has no incoming links and is in the sitemap
      if (!page.hasIncomingLinks && page.foundIn === 'sitemap') {
        orphanedPagesCount++;
        const escapedUrl = escapeHtml(url);
        saveError(
          `Some pages have no incoming links from other pages`,
          `The page <a href="${escapedUrl}">${escapedUrl}</a> is only accessible through the sitemap (no internal links point to it)`,
          SEVERITY.MEDIUM,
        );
      }
    }

    if (orphanedPagesCount > 0) {
      console.log(`Found ${orphanedPagesCount} orphaned pages (only in sitemap, no incoming links)`);
    }
  }
  /** Emits the single site-level llms.txt finding (agentic family), if any. */
  static reportLlmsTxtFinding(info: LlmsTxtInfo | undefined, origin: string, saveError: SaveErrorFn) {
    const finding = llmsTxtFinding(info, origin);
    if (finding) saveError(finding.message ?? '', finding.detail, finding.severity);
  }

  /**
   * Run all site-wide validations
   * @param {Object} pageData - Page data object with pages
   * @param {string} origin - Site origin URL
   * @param {boolean} isMultiLang - Whether site has multiple languages
   * @param {Function} saveError - Callback to save errors
   */
  static async runSiteWideValidation(
    pageData: PageDataForValidation,
    origin: string,
    isMultiLang: boolean,
    saveError: SaveErrorFn,
    sitemapUrls: Record<string, unknown> = {},
    siteTextFiles?: SiteTextFilesData,
  ) {
    // Load analysis config for analyzers that support configurable thresholds
    const config = loadConfig();
    const analysisConfig = config.analysis ?? {};
    // Captured from the broken-pagination validator below; combined with
    // soft-404 pages into the defective-page set the caller suppresses from
    // every other finding's affected list.
    let brokenPaginationUrls: string[] = [];
    // Content checks run on real HTML pages only: not 4xx/5xx responses, redirect-source entries
    // (their target is crawled as its own page) or non-HTML files (an image linked from a post).
    const contentPages = Object.fromEntries(
      Object.entries(pageData.pages).filter(([, p]) => p.status === 200 && !p.redirectOnly && !p.nonHtml),
    );
    const validators = [
      {
        name: 'Duplicate Content',
        run: () => DuplicateChecker.checkDuplicates(contentPages),
      },
      {
        name: 'International SEO Consistency',
        run: () => InternationalSEOValidator.validateInternationalSEOConsistency(pageData.pages, isMultiLang),
      },
      {
        name: 'Hreflang Consistency',
        run: () => InternationalSEOValidator.validateHreflangConsistency(pageData.pages, isMultiLang),
      },
      {
        name: 'Structured Data Consistency',
        run: () => StructuredDataValidator.validateStructuredDataConsistency(contentPages),
      },
      {
        name: 'Indexability & Crawlability',
        run: () => IndexabilityValidator.validateIndexabilityCrawlability(pageData.pages, sitemapUrls),
      },
      {
        name: 'Link Structure',
        run: () => LinkStructureAnalyzer.analyzeLinkStructure(pageData.pages, pageData.incomingLinks ?? {}),
      },
      {
        name: 'Social Media Implementation',
        run: () => SocialMediaValidator.validateSocialMediaImplementation(contentPages),
      },
      {
        name: 'Analytics Implementation',
        run: () => AnalyticsValidator.validateAnalyticsImplementation(contentPages),
      },
      {
        name: 'Link Depth & Architecture',
        run: () => LinkDepthAnalyzer.analyze(pageData.pages, pageData.incomingLinks ?? {}, origin),
      },
      {
        name: 'URL Architecture (Site-Wide)',
        run: () => UrlArchitectureAnalyzer.analyzeSiteWide(contentPages, origin),
      },
      {
        name: 'Content Freshness (Site-Wide)',
        run: () => FreshnessAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'E-E-A-T Signals (Site-Wide)',
        run: () => EEATAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Technical SEO (Site-Wide)',
        run: () => TechnicalSEOAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Thin Content Detection',
        run: () => ThinContentAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Keyword Cannibalisation',
        run: () => KeywordCannibalisationAnalyzer.analyze(contentPages),
      },
      {
        name: 'Soft 404 Detection (Site-Wide)',
        run: () => Soft404Analyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Console Errors (Site-Wide)',
        run: () => ConsoleErrorAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Pagination SEO (Site-Wide)',
        run: () => PaginationAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Broken Pagination (Site-Wide)',
        run: () => {
          const result = BrokenPaginationAnalyzer.analyzeSiteWide(pageData.pages, {
            truncatedSeries: pageData.truncatedPaginationSeries,
          });
          brokenPaginationUrls = result.brokenUrls;
          return result;
        },
      },
      {
        name: 'Media SEO (Site-Wide)',
        run: () => MediaSEOAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Web Components (Site-Wide)',
        run: () => WebComponentAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Font Loading (Site-Wide)',
        run: () => FontLoadingAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Third-Party Scripts (Site-Wide)',
        run: () => ThirdPartyAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Critical Rendering Path (Site-Wide)',
        run: () => CriticalPathAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Connection Timing (Site-Wide)',
        run: () => ConnectionTimingAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Form Accessibility (Site-Wide)',
        run: () => FormAccessibilityAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Cookie Consent (Site-Wide)',
        run: () => CookieConsentAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Redirect Chains (Site-Wide)',
        run: () => RedirectChainAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Compression (Site-Wide)',
        run: () => CompressionAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Resource Hints (Site-Wide)',
        run: () => ResourceHintsAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Mixed Content (Site-Wide)',
        run: () => MixedContentAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'HTTP Protocol (Site-Wide)',
        run: () => HTTPProtocolAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'PWA Features (Site-Wide)',
        run: () => PWAAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Above-the-Fold (Site-Wide)',
        run: () => AboveFoldAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'JavaScript Rendering (Site-Wide)',
        run: () => JavaScriptRenderingAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Anchor Text (Site-Wide)',
        run: () => AnchorTextAnalyzer.analyzeSiteWide(contentPages, origin),
      },
      {
        name: 'External Links (Site-Wide)',
        run: () => ExternalLinksAnalyzer.analyzeSiteWide(contentPages, origin),
      },
      {
        name: 'Crawl Budget (Site-Wide)',
        run: () => CrawlBudgetAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'AI Search Readiness (Site-Wide)',
        run: () => AEOAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Response Headers (Site-Wide)',
        run: () => ResponseHeaderAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'CTA Detection (Site-Wide)',
        run: () => CTADetectorAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Language Detection (Site-Wide)',
        run: () => LanguageDetectionAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Content Similarity',
        run: () => ContentSimilarityAnalyzer.analyze(contentPages, analysisConfig),
      },
      {
        name: 'Internal PageRank',
        run: () => InternalPageRankAnalyzer.analyze(pageData.pages, pageData.incomingLinks ?? {}, origin),
      },
      {
        name: 'Code Coverage (Site-Wide)',
        run: () => CodeCoverageAnalyzer.analyzeSiteWide(contentPages),
      },
      {
        name: 'Outbound Link Health (Site-Wide)',
        run: () => OutboundLinkChecker.analyzeSiteWide(pageData.pages),
      },
    ];

    for (const validator of validators) {
      try {
        const result = AuditOrchestrator.#runWithTimeout(validator.run, validator.name, VALIDATOR_TIMEOUT_MS);
        AuditOrchestrator.#processValidationResult(result, saveError);
      } catch (error: unknown) {
        console.error(`Error running ${validator.name} validator:`, (error as Error).message);
      }
    }

    // Recompute incoming-link counts against the fully-reloaded page set before
    // orphan detection reads them — pages evicted mid-crawl had their
    // hasIncomingLinks baked in from an incomplete incoming-links map (see
    // populateIncomingLinksCount's doc comment), so re-run it here against the
    // now-complete data, same as the HTML report path already does.
    // config.queryParams comes back loosely typed from loadConfig's raw JSON
    // shape; config-loader's validateConfig already constrains `mode` to the
    // real union at load time, so this narrowing cast is safe.
    populateIncomingLinksCount(pageData.pages, pageData.incomingLinks, config.queryParams as QueryParamConfig);

    // Identify orphaned pages, and reconcile sitemap URLs against crawl status
    // codes (A1.4) — both moved here (from the crawl-time analyzePages path) so
    // they read the fully-reloaded page set, not a partially-evicted one.
    AuditOrchestrator.#reportOrphanedPages(pageData.pages, saveError);
    AuditOrchestrator.#reportPagesMissingFromSitemap(pageData.pages, sitemapUrls, saveError);
    AuditOrchestrator.#reconcileSitemapStatusCodes(pageData.pages, sitemapUrls, saveError);

    await AuditOrchestrator.checkAdsTxtGate(pageData.pages, origin, saveError, siteTextFiles);

    // Run async/data-storing validators that need special result handling
    await AuditOrchestrator.#runDataStoringValidators(pageData, origin, saveError);

    // Defective/non-real pages whose fix is to remove or repair the page, not to
    // address per-page findings on it: broken-pagination tails + soft 404s (HTTP
    // 200 serving error content — these DO get fully analyzed, so they pollute
    // every finding). Hard 4xx/5xx pages are excluded on purpose: the crawler
    // never analyzes non-200 responses, so they produce no on-page findings.
    const soft404Urls = Object.entries(pageData.pages)
      .filter(([, p]) => p.soft404?.isSoft404)
      .map(([url]) => url);
    const defectivePageUrls = [...new Set([...brokenPaginationUrls, ...soft404Urls])];

    return { defectivePageUrls };
  }

  /**
   * Flags a missing ads.txt only when a crawled page shows a known ad network.
   * `totalAds` alone is ignored: its generic selectors match ad-free markup.
   * Without stored info (resume from an older checkpoint) ads.txt is fetched here.
   */
  static async checkAdsTxtGate(
    pages: Record<string, PageInfo>,
    origin: string,
    saveError: SaveErrorFn,
    siteTextFiles?: SiteTextFilesData,
  ): Promise<void> {
    const adPage = Object.entries(pages).find(([, p]) => (p.adDensityData?.adNetworks?.length ?? 0) > 0);
    if (!adPage) return;
    let found = siteTextFiles?.adsTxt?.found;
    if (!siteTextFiles) {
      try {
        found = (await SiteTextFilesAnalyzer.analyzeAdsTxt(origin)).info.adsTxt.found;
      } catch {
        found = undefined;
      }
    }
    if (found !== false) return;
    const [url, page] = adPage;
    saveError(
      'ads.txt missing on a site that shows ads',
      `No /ads.txt found, but ad networks (${page.adDensityData!.adNetworks.join(', ')}) were detected on ${url}. Publish ads.txt to declare authorized sellers.`,
      SEVERITY.MEDIUM,
    );
  }

  /**
   * Run validators that store extra data on pageData (async or with side effects)
   * @private
   */
  static async #runDataStoringValidators(pageData: PageDataForValidation, origin: string, saveError: SaveErrorFn) {
    // Each entry: { name, run (async fn returning result), apply (stores data on pageData) }
    const dataValidators: Array<{
      name: string;
      run: () => Promise<ValidationResult & Record<string, unknown>>;
      apply: (result: ValidationResult & Record<string, unknown>) => void;
    }> = [
      {
        name: 'DNS & IPv6',
        run: () => DNSIPv6Analyzer.analyze(origin),
        apply: (result) => {
          pageData.dnsData = result.info;
        },
      },
      {
        name: 'Page Segments',
        run: async () => {
          const segmentResult = PageSegmentAnalyzer.analyzeSegments(pageData.pages);
          pageData.segments = segmentResult.segments;
          pageData.segmentStats = segmentResult.stats;
          for (const url in segmentResult.urlSegmentMap) {
            if (pageData.pages[url]) {
              pageData.pages[url].segment = segmentResult.urlSegmentMap[url];
            }
          }
          return { issues: segmentResult.issues as Issue[] };
        },
        apply: () => {},
      },
      {
        name: 'Content Gap',
        run: async () => ContentGapAnalyzer.analyze(pageData.pages),
        apply: (result) => {
          pageData.contentGaps = result.gaps;
          pageData.contentCoverage = result.coverage;
          pageData.contentGapStats = result.stats;
        },
      },
      {
        name: 'Linking Opportunities',
        run: async () => LinkingOpportunityAnalyzer.analyze(pageData.pages, origin),
        apply: (result) => {
          pageData.linkingOpportunities = result.opportunities;
          pageData.linkingStats = result.stats;
        },
      },
      {
        name: 'External Link Verification',
        run: async () => {
          console.log('\nVerifying external links...');
          return ExternalLinksAnalyzer.verifyExternalLinks(pageData.pages, origin, {
            concurrency: CRAWL_SETTINGS.EXTERNAL_LINK_VERIFY_CONCURRENCY,
            timeout: CRAWL_SETTINGS.EXTERNAL_LINK_VERIFY_TIMEOUT,
            maxUrls: CRAWL_SETTINGS.EXTERNAL_LINK_VERIFY_MAX_URLS,
          });
        },
        apply: (result) => {
          pageData.externalLinkVerification = result.stats;
        },
      },
      {
        name: 'Favicon & Web Manifest (Site-Wide)',
        run: () => checkFaviconAndManifest(pageData.pages, origin),
        apply: () => {},
      },
    ];

    for (const validator of dataValidators) {
      try {
        const result = await validator.run();
        validator.apply(result);
        AuditOrchestrator.#processValidationResult(result, saveError);
      } catch (error: unknown) {
        console.error(`Error running ${validator.name} analyzer:`, (error as Error).message);
      }
    }
  }

  /**
   * Run a function with timeout protection
   * @param {Function} fn - Function to run
   * @param {string} name - Name for logging
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {*} Function result or empty result on timeout
   * @private
   */
  static #runWithTimeout(fn: () => Record<string, unknown>, name: string, timeoutMs: number): ValidationResult {
    const startTime = Date.now();

    // For synchronous validators, we can't truly timeout, but we can track duration
    // and warn if it takes too long
    try {
      const result = fn();
      const duration = Date.now() - startTime;

      if (duration > timeoutMs) {
        console.warn(
          `⚠️  ${name} validator took ${(duration / 1000).toFixed(1)}s (exceeded ${timeoutMs / 1000}s threshold)`,
        );
      } else if (duration > timeoutMs / 2) {
        console.log(`  ⏱️  ${name}: ${(duration / 1000).toFixed(1)}s`);
      }

      return result;
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      if (duration > timeoutMs * 0.9) {
        // Likely timed out or hit resource limits
        console.error(
          `❌ ${name} validator failed after ${(duration / 1000).toFixed(1)}s: ${(error as Error).message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Process validation result and save issues/warnings
   * @param {Object} result - Validation result with issues and warnings arrays
   * @param {Function} saveError - Callback to save errors
   * @private
   */
  static #processValidationResult(result: ValidationResult, saveError: SaveErrorFn) {
    for (const issue of result.issues ?? []) {
      saveError(issue.message ?? '', issue.detail, issue.severity);
    }

    // Process warnings
    for (const warning of result.warnings ?? []) {
      saveError(warning.message ?? '', warning.detail, warning.severity);
    }
  }

  /**
   * Get list of all validator names for inspection/testing
   * @returns {Array} List of validator names
   */
  static getValidatorNames() {
    return [
      'DuplicateChecker',
      'InternationalSEOValidator (Consistency)',
      'InternationalSEOValidator (Hreflang)',
      'StructuredDataValidator',
      'IndexabilityValidator',
      'LinkStructureAnalyzer',
      'SocialMediaValidator',
      'AnalyticsValidator',
      'LinkDepthAnalyzer',
      'UrlArchitectureAnalyzer',
      'FreshnessAnalyzer',
      'EEATAnalyzer',
      'TechnicalSEOAnalyzer',
      'ThinContentAnalyzer',
      'KeywordCannibalisationAnalyzer',
      'Soft404Analyzer',
      'ConsoleErrorAnalyzer',
      'PaginationAnalyzer',
      'MediaSEOAnalyzer',
      'WebComponentAnalyzer',
      'FontLoadingAnalyzer',
      'ThirdPartyAnalyzer',
      'CriticalPathAnalyzer',
      'ConnectionTimingAnalyzer',
      'FormAccessibilityAnalyzer',
      'CookieConsentAnalyzer',
      'RedirectChainAnalyzer',
      'CompressionAnalyzer',
      'ResourceHintsAnalyzer',
      'MixedContentAnalyzer',
      'HTTPProtocolAnalyzer',
      'PWAAnalyzer',
      'Favicon & Web Manifest (Site-Wide)',
      'AboveFoldAnalyzer',
      'JavaScriptRenderingAnalyzer',
      'AnchorTextAnalyzer',
      'ExternalLinksAnalyzer',
      'CrawlBudgetAnalyzer',
      'AEOAnalyzer',
      'ResponseHeaderAnalyzer',
      'CTADetectorAnalyzer',
      'LanguageDetectionAnalyzer',
      'ContentSimilarityAnalyzer',
      'InternalPageRankAnalyzer',
      'CodeCoverageAnalyzer',
      'OutboundLinkChecker',
      'DNSIPv6Analyzer',
      'PageSegmentAnalyzer',
      'ContentGapAnalyzer',
      'LinkingOpportunityAnalyzer',
    ];
  }
}

export { AuditOrchestrator };
