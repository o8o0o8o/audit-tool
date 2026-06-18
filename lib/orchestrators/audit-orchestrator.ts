/**
 * Audit Orchestrator
 * Handles site-wide validation and audit workflow coordination
 */

import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { SEVERITY, CRAWL_SETTINGS } from '../constants';
import { escapeHtml } from '../reports/html-utils';
import { loadConfig } from '../config-loader';
import type { PageInfo, SitemapUrl, AlternateLink, Issue, SeverityLevel } from '../types';

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
    if (collectedURLs.size) {
      for (const discoveredUrl of collectedURLs) {
        const escapedUrl = escapeHtml(discoveredUrl);
        saveError(
          `Some URLs are not listed in sitemap`,
          `<a href="${escapedUrl}">${escapedUrl}</a> was found on the site but is not listed in sitemap`,
          SEVERITY.MEDIUM,
        );
      }

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

    // Identify orphaned pages
    AuditOrchestrator.#reportOrphanedPages(results, saveError);

    // Reconcile sitemap URLs against crawl status codes (A1.4).
    AuditOrchestrator.#reconcileSitemapStatusCodes(results, saveError);

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

    results.pageData.total = uniquePages.size;
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
    const langPatterns = AuditOrchestrator.#detectLanguagePatternsInUrls(results.sitemaps.urls);
    if (langPatterns.isMultiLang) {
      console.log(`Detected multilanguage site from URL patterns: ${langPatterns.languages.join(', ')}`);
      return true;
    }

    return false;
  }

  /**
   * Detect language patterns in URLs (subdirectories like /en/, /de/, /fr/)
   * @private
   */
  static #detectLanguagePatternsInUrls(urls: Record<string, SitemapUrl>) {
    // Common language codes (ISO 639-1)
    const langCodes = new Set([
      'en',
      'de',
      'fr',
      'es',
      'it',
      'pt',
      'nl',
      'pl',
      'ru',
      'ja',
      'ko',
      'zh',
      'ar',
      'he',
      'hi',
      'th',
      'vi',
      'id',
      'ms',
      'tr',
      'sv',
      'da',
      'no',
      'fi',
      'cs',
      'hu',
      'ro',
      'bg',
      'uk',
      'el',
      'sk',
      'sl',
      'hr',
      'sr',
      'lt',
      'lv',
      'et',
      'ca',
      'eu',
      'gl',
      'cy',
      'ga',
      'mt',
      'is',
      'mk',
      'sq',
      'bs',
    ]);

    // Extended patterns: en-us, en-gb, de-de, etc.
    const langRegionPattern = /^\/([a-z]{2})(-[a-z]{2})?\//i;

    const detectedLanguages = new Set<string>();
    let urlsChecked = 0;
    const maxUrlsToCheck = 100; // Limit for performance

    for (const url in urls) {
      if (urlsChecked >= maxUrlsToCheck) break;
      urlsChecked++;

      try {
        const parsed = new URL(url);

        // Check for subdirectory pattern: /en/, /de/, /en-us/
        const pathMatch = parsed.pathname.match(langRegionPattern);
        if (pathMatch) {
          const langCode = pathMatch[1].toLowerCase();
          if (langCodes.has(langCode)) {
            detectedLanguages.add(langCode);
          }
        }

        // Check for subdomain pattern: en.example.com, de.example.com
        const hostParts = parsed.hostname.split('.');
        if (hostParts.length >= 2) {
          const subdomain = hostParts[0].toLowerCase();
          if (langCodes.has(subdomain) && subdomain !== 'www') {
            detectedLanguages.add(subdomain);
          }
        }
      } catch {
        // Invalid URL, skip
      }
    }

    return {
      isMultiLang: detectedLanguages.size >= 2, // Need at least 2 different languages
      languages: Array.from(detectedLanguages),
    };
  }

  /**
   * Reconcile sitemap URLs against crawl status codes.
   * Emits one aggregated finding per outcome bucket (4xx, 5xx, 3xx, not-crawled).
   * @private
   */
  static #reconcileSitemapStatusCodes(results: AnalyzeContext['results'], saveError: SaveErrorFn) {
    const sitemapUrls = Object.keys(results.sitemaps.urls);
    if (sitemapUrls.length === 0) return;

    const buckets = {
      redirect: [] as string[], // 3xx
      notFound: [] as string[], // 4xx
      serverError: [] as string[], // 5xx
      notCrawled: [] as string[], // never made it into pageData.pages or no status
    };

    for (const url of sitemapUrls) {
      const page = results.pageData.pages[url];
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
   * Report orphaned pages (pages without incoming links)
   * @private
   */
  static #reportOrphanedPages(results: AnalyzeContext['results'], saveError: SaveErrorFn) {
    let orphanedPagesCount = 0;

    for (const url in results.pageData.pages) {
      const page = results.pageData.pages[url];
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
  ) {
    // Load analysis config for analyzers that support configurable thresholds
    const config = loadConfig();
    const analysisConfig = config.analysis ?? {};
    // Captured from the broken-pagination validator below; combined with
    // soft-404 pages into the defective-page set the caller suppresses from
    // every other finding's affected list.
    let brokenPaginationUrls: string[] = [];
    const validators = [
      {
        name: 'Duplicate Content',
        run: () => DuplicateChecker.checkDuplicates(pageData.pages),
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
        run: () => StructuredDataValidator.validateStructuredDataConsistency(pageData.pages),
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
        run: () => SocialMediaValidator.validateSocialMediaImplementation(pageData.pages),
      },
      {
        name: 'Analytics Implementation',
        run: () => AnalyticsValidator.validateAnalyticsImplementation(pageData.pages),
      },
      {
        name: 'Link Depth & Architecture',
        run: () => LinkDepthAnalyzer.analyze(pageData.pages, pageData.incomingLinks ?? {}, origin),
      },
      {
        name: 'URL Architecture (Site-Wide)',
        run: () => UrlArchitectureAnalyzer.analyzeSiteWide(pageData.pages, origin),
      },
      {
        name: 'Content Freshness (Site-Wide)',
        run: () => FreshnessAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'E-E-A-T Signals (Site-Wide)',
        run: () => EEATAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Technical SEO (Site-Wide)',
        run: () => TechnicalSEOAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Thin Content Detection',
        run: () => ThinContentAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Keyword Cannibalisation',
        run: () => KeywordCannibalisationAnalyzer.analyze(pageData.pages),
      },
      {
        name: 'Soft 404 Detection (Site-Wide)',
        run: () => Soft404Analyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Console Errors (Site-Wide)',
        run: () => ConsoleErrorAnalyzer.analyzeSiteWide(pageData.pages),
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
        run: () => MediaSEOAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Web Components (Site-Wide)',
        run: () => WebComponentAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Font Loading (Site-Wide)',
        run: () => FontLoadingAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Third-Party Scripts (Site-Wide)',
        run: () => ThirdPartyAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Critical Rendering Path (Site-Wide)',
        run: () => CriticalPathAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Connection Timing (Site-Wide)',
        run: () => ConnectionTimingAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Form Accessibility (Site-Wide)',
        run: () => FormAccessibilityAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Cookie Consent (Site-Wide)',
        run: () => CookieConsentAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Redirect Chains (Site-Wide)',
        run: () => RedirectChainAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Compression (Site-Wide)',
        run: () => CompressionAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Resource Hints (Site-Wide)',
        run: () => ResourceHintsAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Mixed Content (Site-Wide)',
        run: () => MixedContentAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'HTTP Protocol (Site-Wide)',
        run: () => HTTPProtocolAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'PWA Features (Site-Wide)',
        run: () => PWAAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Above-the-Fold (Site-Wide)',
        run: () => AboveFoldAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'JavaScript Rendering (Site-Wide)',
        run: () => JavaScriptRenderingAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Anchor Text (Site-Wide)',
        run: () => AnchorTextAnalyzer.analyzeSiteWide(pageData.pages, origin),
      },
      {
        name: 'External Links (Site-Wide)',
        run: () => ExternalLinksAnalyzer.analyzeSiteWide(pageData.pages, origin),
      },
      {
        name: 'Crawl Budget (Site-Wide)',
        run: () => CrawlBudgetAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'AI Search Readiness (Site-Wide)',
        run: () => AEOAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Response Headers (Site-Wide)',
        run: () => ResponseHeaderAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'CTA Detection (Site-Wide)',
        run: () => CTADetectorAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Language Detection (Site-Wide)',
        run: () => LanguageDetectionAnalyzer.analyzeSiteWide(pageData.pages),
      },
      {
        name: 'Content Similarity',
        run: () => ContentSimilarityAnalyzer.analyze(pageData.pages, analysisConfig),
      },
      {
        name: 'Internal PageRank',
        run: () => InternalPageRankAnalyzer.analyze(pageData.pages, pageData.incomingLinks ?? {}, origin),
      },
      {
        name: 'Code Coverage (Site-Wide)',
        run: () => CodeCoverageAnalyzer.analyzeSiteWide(pageData.pages),
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
