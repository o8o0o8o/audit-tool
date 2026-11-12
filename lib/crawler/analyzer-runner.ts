/**
 * Analyzer Runner
 * Orchestrates all page-level analyzers with parallel execution and error isolation
 */

import type {
  ParsedPage,
  ChromePage,
  PageInfo,
  CodeCoverageData,
  OutboundLinkHealthData,
  NetworkRequest,
} from '../types';
import type { RequestInfo, AnalyzerResult, ReportIssueFn, CrawlerInternalOptions } from './crawler-types';
import { CRAWL_SETTINGS } from '../constants';
import { withTimeout } from './resilience';
import { escapeHtml } from '../reports/html-utils';

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
import { BrokenMediaAnalyzer } from '../analyzers/visual/broken-media-analyzer';
import { TextIntegrityAnalyzer } from '../analyzers/visual/text-integrity-analyzer';
import { AgenticBrowsingAnalyzer } from '../analyzers/agentic/agentic-browsing-analyzer';
import type { AgenticPageData } from '../analyzers/agentic/agentic-checks';
import { captureVisualShots } from './visual-shot-capture';
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
import { SRIAnalyzer } from '../analyzers/security/sri-analyzer';
import { PermissionsPolicyAnalyzer } from '../analyzers/security/permissions-policy-analyzer';
import { CrossOriginPolicyAnalyzer } from '../analyzers/security/cross-origin-policy-analyzer';
import { InformationDisclosureAnalyzer } from '../analyzers/security/information-disclosure-analyzer';
import { CSPQualityAnalyzer } from '../analyzers/security/csp-quality-analyzer';
import { OpenRedirectAnalyzer } from '../analyzers/security/open-redirect-analyzer';
import { ColorContrastAnalyzer } from '../analyzers/accessibility/color-contrast-analyzer';
import { ReducedMotionAnalyzer } from '../analyzers/accessibility/reduced-motion-analyzer';
import { AriaLiveAnalyzer } from '../analyzers/accessibility/aria-live-analyzer';
import { DOMComplexityAnalyzer } from '../analyzers/performance/dom-complexity-analyzer';
import { DeprecatedHTMLAnalyzer } from '../analyzers/seo/deprecated-html-analyzer';
import { InterstitialAnalyzer } from '../analyzers/seo/interstitial-analyzer';
import { AdDensityAnalyzer } from '../analyzers/seo/ad-density-analyzer';
import { SpellingGrammarAnalyzer } from '../analyzers/content/spelling-grammar-analyzer';
import { OutboundLinkChecker } from '../analyzers/content/outbound-link-checker';
import type { CLSEntry } from './vitals-collector';
import { HydrationMismatchAnalyzer } from '../analyzers/seo/hydration-mismatch-analyzer';
import { HiddenContentAnalyzer } from '../analyzers/seo/hidden-content-analyzer';
import { ScrollLoadedContentAnalyzer } from '../analyzers/seo/scroll-loaded-content-analyzer';
import { DarkModeContrastAnalyzer } from '../analyzers/accessibility/dark-mode-contrast-analyzer';
import { FormHealthAnalyzer } from '../analyzers/content/form-health-analyzer';
import { PriceConsistencyAnalyzer } from '../analyzers/seo/price-consistency-analyzer';
import { AssetDeliveryAnalyzer } from '../analyzers/performance/asset-delivery-analyzer';
import { ClsAttributionAnalyzer } from '../analyzers/performance/cls-attribution';
import { capturePageHints } from '../analyzers/site-checks/crawl-hints';
import { HeadIntegrityAnalyzer } from '../analyzers/seo/head-integrity-analyzer';
import { BfcacheAnalyzer } from '../analyzers/performance/bfcache-analyzer';
import { JsLibraryAnalyzer } from '../analyzers/security/js-library-analyzer';
import { ConsentModeAnalyzer } from '../analyzers/analytics/consent-mode-analyzer';

// Re-export ConsoleErrorAnalyzer for use by crawler-engine's #basicTest
export { ConsoleErrorAnalyzer };
// Re-export CodeCoverageAnalyzer for use by crawler-engine's #basicTest
export { CodeCoverageAnalyzer };

/**
 * Extract values from Promise.allSettled results with fallback for rejected promises
 */
function extractSettledResults(results: PromiseSettledResult<unknown>[], fallbacks: unknown[], url: string): unknown[] {
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Log the failure but continue with fallback
    console.log(`⚠️  Analyzer ${index} failed for ${url}: ${result.reason?.message ?? result.reason}`);
    return fallbacks[index];
  });
}

/**
 * Stamp the originating page URL onto a per-page analyzer detail so the
 * aggregated "Affected pages" list can map each occurrence back to its page.
 *
 * Page-level analyzers (unlike the page-data-builder checks) usually emit a
 * generic detail with no URL — e.g. "182.4 KB of inline CSS. Critical CSS
 * should be ~14KB…". Aggregated across the crawl these collapse into a column
 * of identical, unactionable bullets. Appending the page URL (as an anchor,
 * matching page-data-builder's style) makes every occurrence distinct and
 * navigable. Skipped when the detail already references this page's URL.
 */
export function stampPageUrl(detail: string, url: string): string {
  const escapedUrl = escapeHtml(url);
  const anchor = `<a href="${escapedUrl}">${escapedUrl}</a>`;
  // Detail with no body of its own — surface the page URL as the example.
  if (!detail.trim()) return anchor;
  // Already names this page (page-data-builder-style details, self-referential
  // analyzers) — leave it untouched.
  if (detail.includes(url) || detail.includes(escapedUrl)) return detail;
  return `${detail} — ${anchor}`;
}

/**
 * Report issues and warnings from analyzer result, stamping each with the
 * page URL so aggregated examples remain page-attributable.
 */
function reportIssues(result: AnalyzerResult, reportIssue: ReportIssueFn, url: string): void {
  for (const issue of result.issues ?? []) {
    reportIssue(issue.message ?? '', stampPageUrl(issue.detail ?? '', url), issue.severity);
  }
  for (const warning of result.warnings ?? []) {
    reportIssue(warning.message ?? '', stampPageUrl(warning.detail ?? '', url), warning.severity);
  }
}

/**
 * Run all analyzers on the page using parallel execution
 * Each analyzer group has a timeout to prevent hung analyzers from freezing the crawl
 */
export async function runAnalyzers(
  chromePage: ChromePage,
  parsedPage: ParsedPage,
  url: string,
  pageData: PageInfo,
  pageContent: string,
  requests: Record<string, RequestInfo>,
  consoleData: unknown,
  options: CrawlerInternalOptions,
  reportIssue: ReportIssueFn,
  servedHtml?: string,
  visual = false,
  agentic = true,
  clsEntries?: CLSEntry[],
): Promise<void> {
  const analyzerTimeout = CRAWL_SETTINGS.ANALYZER_TIMEOUT || 10000;
  // Cast requests for analyzer compatibility (analyzers use broader parameter types)
  const analyzerRequests = requests as unknown as NetworkRequest[];

  // ============================================================
  // GROUP 1: Browser-based analyzers (can run in parallel)
  // These read from the browser/parsed page independently
  // Using Promise.allSettled to prevent single analyzer failure from crashing the crawl
  // ============================================================

  // Default fallback values for failed analyzers
  const group1Fallbacks = [
    // Core SEO
    { issues: [], warnings: [] }, // headingResult
    [], // images
    { issues: [], warnings: [] }, // linkQualityResult
    { issues: [], warnings: [] }, // structuredDataResult
    { issues: [], warnings: [] }, // indexabilityResult
    { issues: [], warnings: [] }, // crawlabilityResult
    { issues: [], warnings: [] }, // internationalSEOResult
    // Content & UX
    { issues: [], warnings: [] }, // mobileFriendlyResult
    { issues: [], warnings: [] }, // accessibilityResult
    { issues: [], warnings: [] }, // contentQualityResult
    { formData: null, issues: [], warnings: [] }, // formResult
    // Social & Analytics
    { issues: [], warnings: [] }, // socialMediaResult
    { issues: [], warnings: [] }, // analyticsResult
    // Security
    { issues: [], warnings: [] }, // securityResult
    { consentData: null, issues: [], warnings: [] }, // consentResult
    // Performance
    { issues: [], warnings: [] }, // cachingResult
    { issues: [], warnings: [] }, // imageOptimizationResult
    { issues: [], warnings: [] }, // resourceOptimizationResult
    { fontData: null, issues: [], warnings: [] }, // fontResult
    { thirdPartyData: null, issues: [], warnings: [] }, // thirdPartyResult
    { criticalPathData: null, issues: [], warnings: [] }, // criticalPathResult
    { timingData: null, issues: [], warnings: [] }, // connectionResult
    // Advanced
    { paginationData: null, issues: [], warnings: [] }, // paginationResult
    { mediaData: null, issues: [], warnings: [] }, // mediaResult
    { webComponentData: null, issues: [], warnings: [] }, // webComponentResult
    // AEO / AI Search Readiness
    { issues: [], warnings: [], info: {} }, // aeoResult
    // Technology
    { technologies: [], frameworks: [], cms: null }, // technologies
    // CTA Detection
    { ctas: [], summary: {}, issues: [], warnings: [] }, // ctaResult
    // Language Detection
    { info: null, issues: [], warnings: [] }, // langDetectionResult
    // New analyzers (browser-based)
    { issues: [], warnings: [], info: {} }, // colorContrastResult
    { issues: [], warnings: [], info: {} }, // reducedMotionResult
    { issues: [], warnings: [], info: {} }, // ariaLiveResult
    { issues: [], warnings: [], info: {} }, // domComplexityResult
    { issues: [], warnings: [], info: {} }, // deprecatedHtmlResult
    { issues: [], warnings: [], info: {} }, // interstitialResult
    { issues: [], warnings: [], info: {} }, // adDensityResult
    { issues: [], warnings: [], info: {} }, // sriResult
    { issues: [], warnings: [], info: {} }, // infoDisclosureResult
    { issues: [], warnings: [], info: {} }, // openRedirectResult
    { issues: [], warnings: [], info: {} }, // spellingResult
    // Visual
    { issues: [] }, // brokenMediaResult
    { issues: [] }, // textIntegrityResult
    // Agentic browsing
    { checks: null, issues: [] }, // agenticResult
  ];

  const browserAnalyzersSettled = await withTimeout(
    Promise.allSettled([
      // Core SEO
      HeadingAnalyzer.analyzeHeadings(parsedPage, url),
      ImageAnalyzer.extractImageAlts(parsedPage),
      LinkQualityAnalyzer.analyzeLinkQuality(chromePage, parsedPage, url, options.origin, {}),
      StructuredDataAnalyzer.analyzeStructuredData(chromePage),
      IndexabilityAnalyzer.analyzeIndexability(
        chromePage,
        parsedPage,
        url,
        pageData.status ?? 0,
        pageData.responseHeaders ?? {},
      ),
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
      ImageOptimizationAnalyzer.analyzeImageOptimization(chromePage, requests, url),
      ResourceOptimizationAnalyzer.analyzeResourceOptimization(chromePage, analyzerRequests, url),
      FontLoadingAnalyzer.analyze(chromePage, parsedPage, analyzerRequests, url),
      ThirdPartyAnalyzer.analyze(chromePage, analyzerRequests, url, options.origin),
      CriticalPathAnalyzer.analyze(chromePage, parsedPage, analyzerRequests, pageData.metrics ?? {}, url),
      ConnectionTimingAnalyzer.analyze(chromePage, analyzerRequests, url),

      // Advanced
      PaginationAnalyzer.analyze(chromePage, parsedPage, url, servedHtml),
      MediaSEOAnalyzer.analyze(chromePage, parsedPage, pageData, url),
      WebComponentAnalyzer.analyze(chromePage, parsedPage, url),

      // AEO / AI Search Readiness
      AEOAnalyzer.analyze(chromePage, parsedPage, url),

      // Technology detection (with error handling)
      TechnologyDetector.detect(
        chromePage,
        parsedPage,
        pageContent,
        pageData.responseHeaders ?? {},
        analyzerRequests,
      ).catch((err) => {
        if (options.verbose)
          console.warn(
            `[tech-detect] CDP detection failed, falling back to HTML: ${err instanceof Error ? err.message : err}`,
          );
        const scriptSrcs = Object.keys(requests || {}).filter((u) => u.endsWith('.js'));
        return TechnologyDetector.detectFromHtml(pageContent, pageData.responseHeaders ?? {}, scriptSrcs);
      }),

      // CTA Detection
      CTADetectorAnalyzer.analyzeCTAs(chromePage, parsedPage, url),

      // Language Detection
      LanguageDetectionAnalyzer.analyzeLanguage(chromePage, parsedPage, url, pageData),

      // Security (browser-based)
      ColorContrastAnalyzer.analyze(chromePage, url),
      ReducedMotionAnalyzer.analyze(chromePage, parsedPage, url),
      AriaLiveAnalyzer.analyze(chromePage, url),
      DOMComplexityAnalyzer.analyze(chromePage, url),
      DeprecatedHTMLAnalyzer.analyze(chromePage, parsedPage, url),
      InterstitialAnalyzer.analyze(chromePage, url),
      AdDensityAnalyzer.analyze(chromePage, url),
      SRIAnalyzer.analyze(parsedPage, url),
      InformationDisclosureAnalyzer.analyze(pageData, parsedPage, url),
      OpenRedirectAnalyzer.analyze(pageData, parsedPage, url),
      SpellingGrammarAnalyzer.analyze(chromePage, url),

      // Visual — opt-in via --visual
      visual ? BrokenMediaAnalyzer.analyze(chromePage, url, requests) : Promise.resolve({ issues: [] }),
      visual ? TextIntegrityAnalyzer.analyze(chromePage, url) : Promise.resolve({ issues: [] }),

      // Agentic browsing — on by default, off with --no-agentic
      agentic ? AgenticBrowsingAnalyzer.analyze(chromePage, url, pageContent) : Promise.resolve({ issues: [] }),
    ]),
    analyzerTimeout,
    `Analyzer timeout for ${url}`,
  );

  // Extract results with fallbacks for failed analyzers
  const browserAnalyzers = extractSettledResults(browserAnalyzersSettled, group1Fallbacks, url);

  // Assign results from Group 1
  // Results come from Promise.allSettled extraction, cast to AnalyzerResult for typed access
  const [
    headingResult,
    images,
    linkQualityResult,
    structuredDataResult,
    indexabilityResult,
    crawlabilityResult,
    internationalSEOResult,
    mobileFriendlyResult,
    accessibilityResult,
    contentQualityResult,
    formResult,
    socialMediaResult,
    analyticsResult,
    securityResult,
    consentResult,
    cachingResult,
    imageOptimizationResult,
    resourceOptimizationResult,
    fontResult,
    thirdPartyResult,
    criticalPathResult,
    connectionResult,
    paginationResult,
    mediaResult,
    webComponentResult,
    aeoResult,
    technologies,
    ctaResult,
    langDetectionResult,
    colorContrastResult,
    reducedMotionResult,
    ariaLiveResult,
    domComplexityResult,
    deprecatedHtmlResult,
    interstitialResult,
    adDensityResult,
    sriResult,
    infoDisclosureResult,
    openRedirectResult,
    spellingResult,
    brokenMediaResult,
    textIntegrityResult,
    agenticResult,
  ] = browserAnalyzers as AnalyzerResult[];

  // Apply analyzer results to pageData with typed assignments
  // Results come from Promise.allSettled extraction (typed as AnalyzerResult), cast through unknown
  pageData.headings = headingResult as unknown as typeof pageData.headings;
  pageData.images = images as unknown as typeof pageData.images;
  pageData.linkAnalysis = linkQualityResult as unknown as typeof pageData.linkAnalysis;
  pageData.structuredData = structuredDataResult as unknown as typeof pageData.structuredData;
  pageData.indexability = indexabilityResult as unknown as typeof pageData.indexability;
  pageData.crawlability = crawlabilityResult as unknown as typeof pageData.crawlability;
  pageData.internationalSEO = internationalSEOResult as unknown as typeof pageData.internationalSEO;
  pageData.mobileFriendly = mobileFriendlyResult as unknown as typeof pageData.mobileFriendly;
  pageData.accessibility = accessibilityResult as unknown as typeof pageData.accessibility;
  pageData.contentQuality = contentQualityResult as unknown as typeof pageData.contentQuality;
  pageData.formData = (formResult as AnalyzerResult & { formData: typeof pageData.formData }).formData;
  pageData.socialMedia = socialMediaResult as unknown as typeof pageData.socialMedia;
  pageData.analytics = analyticsResult as unknown as typeof pageData.analytics;
  pageData.security = securityResult as unknown as typeof pageData.security;
  pageData.consentData = (consentResult as AnalyzerResult & { consentData: typeof pageData.consentData }).consentData;
  pageData.caching = cachingResult as unknown as typeof pageData.caching;
  pageData.imageOptimization = imageOptimizationResult as unknown as typeof pageData.imageOptimization;
  pageData.resourceOptimization = resourceOptimizationResult as unknown as typeof pageData.resourceOptimization;
  pageData.fontData = (fontResult as AnalyzerResult & { fontData: typeof pageData.fontData }).fontData;
  pageData.thirdPartyData = (
    thirdPartyResult as AnalyzerResult & { thirdPartyData: typeof pageData.thirdPartyData }
  ).thirdPartyData;
  pageData.criticalPathData = (
    criticalPathResult as AnalyzerResult & { criticalPathData: typeof pageData.criticalPathData }
  ).criticalPathData;
  pageData.timingData = (connectionResult as AnalyzerResult & { timingData: typeof pageData.timingData }).timingData;
  pageData.paginationData = (
    paginationResult as AnalyzerResult & { paginationData: typeof pageData.paginationData }
  ).paginationData;
  pageData.mediaData = (mediaResult as AnalyzerResult & { mediaData: typeof pageData.mediaData }).mediaData;
  pageData.webComponentData = (
    webComponentResult as AnalyzerResult & { webComponentData: typeof pageData.webComponentData }
  ).webComponentData;
  pageData.aeo = (aeoResult as AnalyzerResult & { info: typeof pageData.aeo }).info;
  pageData.technologies = technologies as unknown as typeof pageData.technologies;
  pageData.ctas = (ctaResult as AnalyzerResult & { ctas: typeof pageData.ctas }).ctas;
  pageData.ctaData = {
    ctas: (ctaResult as AnalyzerResult & { ctas: typeof pageData.ctas }).ctas,
    summary: (ctaResult as AnalyzerResult & { summary: unknown }).summary,
  } as typeof pageData.ctaData;
  pageData.languageDetection = (
    langDetectionResult as AnalyzerResult & { info: typeof pageData.languageDetection }
  ).info;
  pageData.colorContrastData = (
    colorContrastResult as AnalyzerResult & { info: typeof pageData.colorContrastData }
  ).info;
  pageData.reducedMotionData = (
    reducedMotionResult as AnalyzerResult & { info: typeof pageData.reducedMotionData }
  ).info;
  pageData.ariaLiveData = (ariaLiveResult as AnalyzerResult & { info: typeof pageData.ariaLiveData }).info;
  pageData.domComplexityData = (
    domComplexityResult as AnalyzerResult & { info: typeof pageData.domComplexityData }
  ).info;
  pageData.deprecatedHtmlData = (
    deprecatedHtmlResult as AnalyzerResult & { info: typeof pageData.deprecatedHtmlData }
  ).info;
  pageData.interstitialData = (interstitialResult as AnalyzerResult & { info: typeof pageData.interstitialData }).info;
  pageData.adDensityData = (adDensityResult as AnalyzerResult & { info: typeof pageData.adDensityData }).info;
  pageData.sriData = (sriResult as AnalyzerResult & { info: typeof pageData.sriData }).info;
  pageData.infoDisclosureData = (
    infoDisclosureResult as AnalyzerResult & { info: typeof pageData.infoDisclosureData }
  ).info;
  pageData.openRedirectData = (openRedirectResult as AnalyzerResult & { info: typeof pageData.openRedirectData }).info;
  pageData.spellingData = (spellingResult as AnalyzerResult & { info: typeof pageData.spellingData }).info;
  if (visual) {
    pageData.brokenMediaData = brokenMediaResult as unknown as typeof pageData.brokenMediaData;
    pageData.textIntegrityData = textIntegrityResult as unknown as typeof pageData.textIntegrityData;
    const highlights = [
      ...(pageData.brokenMediaData?.highlights ?? []),
      ...(pageData.textIntegrityData?.highlights ?? []),
    ];
    if (options.evidenceDir && highlights.length > 0) {
      const shots = await withTimeout(
        captureVisualShots(chromePage, url, options.evidenceDir, highlights),
        analyzerTimeout,
        `Visual screenshot timeout for ${url}`,
      ).catch((e) => {
        if (options.verbose) console.warn(`[visual] screenshots failed for ${url}: ${e instanceof Error ? e.message : e}`);
        return [];
      });
      if (shots.length > 0) pageData.visualShots = shots;
    }
  }
  if (agentic) {
    const { issues: _agenticIssues, ...agenticData } = agenticResult as unknown as AgenticPageData;
    (pageData as PageInfo & { agentic?: Omit<AgenticPageData, 'issues'> }).agentic = agenticData;
  }

  // Report issues from Group 1
  [
    headingResult,
    linkQualityResult,
    structuredDataResult,
    indexabilityResult,
    crawlabilityResult,
    internationalSEOResult,
    mobileFriendlyResult,
    accessibilityResult,
    contentQualityResult,
    formResult,
    socialMediaResult,
    analyticsResult,
    securityResult,
    consentResult,
    cachingResult,
    imageOptimizationResult,
    resourceOptimizationResult,
    fontResult,
    thirdPartyResult,
    criticalPathResult,
    connectionResult,
    paginationResult,
    mediaResult,
    webComponentResult,
    aeoResult,
    ctaResult,
    langDetectionResult,
    colorContrastResult,
    reducedMotionResult,
    ariaLiveResult,
    domComplexityResult,
    deprecatedHtmlResult,
    interstitialResult,
    adDensityResult,
    sriResult,
    infoDisclosureResult,
    openRedirectResult,
    spellingResult,
    brokenMediaResult,
    textIntegrityResult,
    agenticResult,
  ].forEach((result) => reportIssues(result as AnalyzerResult, reportIssue, url));

  // ============================================================
  // GROUP 2: Data-based analyzers (depend on Group 1 results)
  // These analyze pageData populated by Group 1
  // ============================================================

  // Soft 404 detection (needs contentQuality.wordCount from Group 1)
  const soft404Result = await withTimeout(
    Soft404Analyzer.analyze(chromePage, parsedPage, url, pageData),
    analyzerTimeout,
    `Soft404 analyzer timeout for ${url}`,
  ).catch((e) => {
    if (options.verbose) console.warn(`[soft404] Analyzer failed for ${url}: ${e instanceof Error ? e.message : e}`);
    return { soft404Data: null, issues: [], warnings: [] };
  });
  pageData.soft404 = soft404Result.soft404Data;
  reportIssues(soft404Result, reportIssue, url);

  // Active JS-"next" pagination probe. Decoupled from the Group-1 timeout so it
  // never eats that budget; uses its own isolated page. Bounded per-audit by
  // PaginationAnalyzer's probe budget. Only runs for JS-driven "next" controls
  // (static-href series are covered post-crawl by BrokenPaginationAnalyzer).
  if (pageData.paginationData?.nextIsJsControl && PaginationAnalyzer.shouldProbeNext(url)) {
    const probeResult = await withTimeout(
      PaginationAnalyzer.probeJsNext(chromePage, url, options.evidenceDir),
      CRAWL_SETTINGS.BROKEN_PAGINATION_PROBE_TIMEOUT_MS + 2000,
      `Pagination probe timeout for ${url}`,
    ).catch((e) => {
      if (options.verbose) console.warn(`[pagination-probe] failed for ${url}: ${e instanceof Error ? e.message : e}`);
      return { nextProbe: null, issues: [], warnings: [] };
    });
    pageData.paginationData.nextProbe = probeResult.nextProbe;
    reportIssues(probeResult, reportIssue, url);
  }

  // Synchronous analyzers - run in parallel since they only read pageData
  // Using Promise.allSettled to prevent single analyzer failure from crashing the crawl
  const group2Fallbacks = [
    { issues: [], warnings: [] }, // urlArchResult
    { freshnessData: null, issues: [], warnings: [] }, // freshnessResult
    { issues: [], warnings: [] }, // eeatResult
    { issues: [], warnings: [] }, // schemaResult
    { issues: [], warnings: [] }, // technicalResult
    { issues: [], warnings: [] }, // thinContentResult
    { info: null, issues: [], warnings: [] }, // redirectResult
    { info: null, issues: [], warnings: [] }, // compressionResult
    { info: null, issues: [], warnings: [] }, // hintsResult
    { info: null, issues: [], warnings: [] }, // mixedResult
    { info: null, issues: [], warnings: [] }, // protocolResult
    { info: null, issues: [], warnings: [] }, // pwaResult
    { info: null, issues: [], warnings: [] }, // aboveFoldResult
    { info: null, issues: [], warnings: [] }, // anchorResult
    { info: null, issues: [], warnings: [] }, // externalLinksResult
    { info: null, issues: [], warnings: [] }, // responseHeaderResult
    { info: null, issues: [], warnings: [] }, // cspQualityResult
    { info: null, issues: [], warnings: [] }, // permissionsPolicyResult
    { info: null, issues: [], warnings: [] }, // crossOriginResult
  ];

  const syncResultsSettled = await withTimeout(
    Promise.allSettled([
      UrlArchitectureAnalyzer.analyze(url, pageData, options.origin),
      FreshnessAnalyzer.analyze(pageData, pageData.response ?? {}, parsedPage),
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
      CSPQualityAnalyzer.analyze(pageData, url),
      PermissionsPolicyAnalyzer.analyze(pageData, url),
      CrossOriginPolicyAnalyzer.analyze(pageData, url),
    ]),
    analyzerTimeout,
    `Sync analyzers timeout for ${url}`,
  );

  // Extract results with fallbacks for failed analyzers
  const syncResults = extractSettledResults(syncResultsSettled, group2Fallbacks, url);

  const [
    _urlArchResult,
    freshnessResult,
    _eeatResult,
    _schemaResult,
    _technicalResult,
    _thinContentResult,
    redirectResult,
    compressionResult,
    hintsResult,
    mixedResult,
    protocolResult,
    pwaResult,
    aboveFoldResult,
    anchorResult,
    externalLinksResult,
    responseHeaderResult,
    cspQualityResult,
    permissionsPolicyResult,
    crossOriginResult,
  ] = syncResults as Array<AnalyzerResult & { freshnessData?: unknown; info?: unknown }>;

  // Apply data results
  pageData.freshnessData = freshnessResult.freshnessData as typeof pageData.freshnessData;
  pageData.redirectAnalysis = redirectResult.info as typeof pageData.redirectAnalysis;
  pageData.compressionData = compressionResult.info as typeof pageData.compressionData;
  pageData.resourceHintsData = hintsResult.info as typeof pageData.resourceHintsData;
  pageData.mixedContentData = mixedResult.info as typeof pageData.mixedContentData;
  pageData.protocolData = protocolResult.info as typeof pageData.protocolData;
  pageData.pwaData = pwaResult.info as typeof pageData.pwaData;
  pageData.aboveFoldData = aboveFoldResult.info as typeof pageData.aboveFoldData;
  pageData.anchorTextData = anchorResult.info as typeof pageData.anchorTextData;
  pageData.externalLinksData = externalLinksResult.info as typeof pageData.externalLinksData;
  pageData.responseHeaderAnalysis = responseHeaderResult.info as typeof pageData.responseHeaderAnalysis;
  pageData.cspQualityData = cspQualityResult.info as typeof pageData.cspQualityData;
  pageData.permissionsPolicyData = permissionsPolicyResult.info as typeof pageData.permissionsPolicyData;
  pageData.crossOriginPolicyData = crossOriginResult.info as typeof pageData.crossOriginPolicyData;

  // Report issues from Group 2
  syncResults.forEach((result) => reportIssues(result as AnalyzerResult, reportIssue, url));

  // Console error analysis (independent)
  if (consoleData) {
    const consoleResult = ConsoleErrorAnalyzer.analyze(consoleData, url);
    pageData.consoleAnalysis = consoleResult.consoleAnalysis;
    reportIssues(consoleResult, reportIssue, url);
  }

  // JavaScript rendering analysis (only if raw HTML available)
  // Raw = served (pre-JS) HTML, rendered = post-JS DOM. Passed on a copy so
  // neither large string is persisted on pageData / in checkpoints.
  if (servedHtml && pageContent) {
    const jsRenderResult = JavaScriptRenderingAnalyzer.analyze(
      { ...pageData, rawHtml: servedHtml, renderedHtml: pageContent },
      url,
    );
    pageData.jsRenderingData = jsRenderResult.info;
    reportIssues(jsRenderResult, reportIssue, url);
  }

  // Crawl-time hints for the post-crawl site checks (+ structured-data phone check)
  try {
    reportIssues(
      { issues: await capturePageHints(chromePage, parsedPage, url, pageData, requests) } as AnalyzerResult,
      reportIssue,
      url,
    );
  } catch {
    /* hints are best-effort */
  }

  // Head integrity (served HTML), bfcache, vulnerable JS libraries, Consent Mode v2
  reportIssues(HeadIntegrityAnalyzer.analyze(servedHtml), reportIssue, url);
  const scriptUrls = Object.entries(requests)
    .filter(([, r]) => r.resourceType === 'script')
    .map(([u]) => u);
  const pageChecks = await Promise.allSettled([
    withTimeout(BfcacheAnalyzer.analyze(chromePage, pageData.responseHeaders ?? {}), analyzerTimeout, `bfcache timeout for ${url}`),
    withTimeout(JsLibraryAnalyzer.analyze(chromePage, scriptUrls), analyzerTimeout, `JS library timeout for ${url}`),
    withTimeout(ConsentModeAnalyzer.analyze(chromePage, Object.keys(requests)), analyzerTimeout, `Consent Mode timeout for ${url}`),
  ]);
  for (const settled of pageChecks) {
    if (settled.status === 'fulfilled') reportIssues(settled.value as AnalyzerResult, reportIssue, url);
  }

  // Render / delivery checks. Order matters: the CLS attribution and price check
  // read the page as loaded; dark-mode contrast switches the color scheme and
  // scroll-loaded content scrolls the page, so those two run last, one at a time.
  reportIssues(HydrationMismatchAnalyzer.analyze(servedHtml, pageContent, url), reportIssue, url);
  reportIssues(FormHealthAnalyzer.analyze(pageContent, url, requests), reportIssue, url);
  const docHeaders = requests[pageData.finalUrl ?? url]?.headers ?? requests[url]?.headers;
  const assetResult = AssetDeliveryAnalyzer.analyze(requests, url, docHeaders);
  pageData.cdnCache = assetResult.info?.cdnCache;
  reportIssues(assetResult, reportIssue, url);
  // Code coverage analysis (requires perf flag, uses Coverage API started before navigation)
  if (options.perf) {
    try {
      const coverageResult = await withTimeout(
        CodeCoverageAnalyzer.analyze(chromePage, analyzerRequests, url),
        analyzerTimeout,
        `Coverage analyzer timeout for ${url}`,
      );
      pageData.codeCoverage = coverageResult.info as CodeCoverageData;
      reportIssues(coverageResult, reportIssue, url);
    } catch {
      pageData.codeCoverage = null;
    }
  }

  const runLast: Array<[string, () => Promise<AnalyzerResult>]> = [
    ['CLS attribution', () => ClsAttributionAnalyzer.analyze(chromePage, clsEntries) as Promise<AnalyzerResult>],
    [
      'price consistency',
      async () =>
        PriceConsistencyAnalyzer.analyze(
          pageContent,
          await chromePage.evaluate(() => document.body?.innerText ?? ''),
        ) as AnalyzerResult,
    ],
    ['hidden content', () => HiddenContentAnalyzer.analyze(chromePage) as Promise<AnalyzerResult>],
    ['dark-mode contrast', () => DarkModeContrastAnalyzer.analyze(chromePage) as Promise<AnalyzerResult>],
    ['scroll-loaded content', () => ScrollLoadedContentAnalyzer.analyze(chromePage) as Promise<AnalyzerResult>],
  ];
  for (const [name, run] of runLast) {
    try {
      reportIssues(await withTimeout(run(), analyzerTimeout, `${name} timeout for ${url}`), reportIssue, url);
    } catch {
      /* best-effort */
    }
  }

  // Outbound link health check (async, rate-limited)
  try {
    const outboundResult = await withTimeout(
      OutboundLinkChecker.analyze(pageData, url, options.origin, options.analysis),
      analyzerTimeout * 3, // Allow more time for external requests
      `Outbound link checker timeout for ${url}`,
    );
    pageData.outboundLinkHealth = outboundResult.info as OutboundLinkHealthData;
    reportIssues(outboundResult, reportIssue, url);
  } catch {
    pageData.outboundLinkHealth = null;
  }
}
