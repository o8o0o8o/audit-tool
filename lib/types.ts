/**
 * Core type definitions for the SEO Audit Tool
 * Shared interfaces used across all modules
 */

import type { SiteHints } from './analyzers/site-checks/crawl-hints';
import type { TagRuntimeInfo } from './analyzers/analytics/tag-runtime-analyzer';

import type { PresetName } from './presets';
import type { BrokenMediaData } from './analyzers/visual/broken-media-analyzer';
import type { TextIntegrityData } from './analyzers/visual/text-integrity-analyzer';
import type { VisualShot } from './crawler/visual-shot-capture';

// ─── Severity & Issues ───────────────────────────────────────────────────────

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  message?: string;
  detail?: string;
  severity: SeverityLevel;
}

// ─── Analyzer Results ────────────────────────────────────────────────────────

export interface AnalyzerResult {
  issues: Issue[];
  warnings?: Issue[];
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SiteWideAnalyzerResult {
  issues: Issue[];
  warnings?: Issue[];
  [key: string]: unknown;
}

// ─── Page Data ───────────────────────────────────────────────────────────────

export interface PageInfo {
  url: string;
  status?: number;
  statusCode?: number;
  /** Stable SHA-256 of the normalised HTML; used by the audit-diff classifier. */
  contentHash?: string;
  title?: string;
  titleLength?: number;
  description?: string;
  descriptionLength?: number;
  canonical?: string;
  redirectChain?: Array<{ url: string; status: number | string; timing?: number }>;
  redirectCount?: number;
  hasRedirects?: boolean;
  error?: string;
  issues?: Issue[];

  // Page discovery
  foundIn?: 'sitemap' | 'discovered';
  discoveredOn?: string;
  isMultiLang?: boolean;

  // Performance metrics (lab) — uppercase variants set by crawler
  TTFB?: number;
  FCP?: number;
  LCP?: number;
  CLS?: number;
  INP?: number;
  TBT?: number;
  TTI?: number;
  speedIndex?: number;

  // Performance metrics (lowercase aliases used in reports)
  ttfb?: number;
  lcp?: number;
  cls?: number;
  fcp?: number;
  inp?: number;
  tbt?: number;

  // Navigation timing
  domContentLoaded?: number;
  domComplete?: number;
  loadEvent?: number;

  // Vitals attribution
  vitals?: Record<string, unknown>;

  // CrUX field data (per-URL, only in perf mode)
  cruxFieldData?: {
    metrics: Record<string, { p75: number; distribution?: { good: number; needsImprovement: number; poor: number } }>;
    targetType: string;
  } | null;

  // Content
  wordCount?: number;
  h1?: string[];
  h2?: string[];

  // Network / resource data
  requests?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  blockers?: Record<string, unknown>;
  totalResponseSize?: number;
  totalNumberOfRequests?: number;
  responseHeaders?: Record<string, string>;
  response?: { headers: Record<string, string> };
  resources?: CrawledResource[];
  headers?: Record<string, string>;
  contentEncoding?: string;
  htmlSize?: number;
  contentLength?: number;
  totalSize?: number;
  protocol?: string;
  httpVersion?: string | number;
  altSvc?: string;
  timing?: Record<string, unknown>;
  performanceEntry?: Record<string, unknown>;
  navigationTiming?: Record<string, unknown>;
  finalUrl?: string;
  loadTime?: number;
  renderingTime?: number;
  renderedHtml?: string;
  html?: string;
  pageSize?: number;
  requestCount?: number;
  performanceMetrics?: Record<string, unknown>;

  // Links
  links?: unknown;
  linksCount?: number;
  internalLinksCount?: number;
  externalLinksCount?: number;
  httpLinksCount?: number;
  incomingLinks?: unknown;
  incomingLinksCount?: number;
  hasIncomingLinks?: boolean;
  linkDepth?: number;

  // Images
  imagesCount?: number;
  imagesWithoutAltCount?: number;

  // Meta tags
  meta?: Record<string, unknown>[];
  metaMap?: Record<string, string>;
  metaTags?: Record<string, string>;
  missingMetaTags?: string[];
  hasKeywords?: boolean;
  hasViewport?: boolean;
  alternates?: AlternateLink[];
  lang?: string;

  // DOM-collected data
  viewport?: { width: number; height: number };
  lcpRect?: { top: number; bottom: number; left: number; right: number; width?: number; height?: number };
  lcpUrl?: string;
  buttons?: { text?: string; type?: string; rect?: Record<string, number> }[];
  forms?: { action?: string; method?: string; inputs?: unknown[] }[];
  iframes?: { src?: string; sandbox?: string }[];
  fonts?: { url?: string; family?: string; size?: number }[];
  icons?: { href?: string; sizes?: string; type?: string; rel?: string }[];
  manifest?: { url?: string; content?: Record<string, unknown> } | string;
  webManifest?: Record<string, unknown>;
  manifestContent?: Record<string, unknown>;
  serviceWorker?: boolean;
  serviceWorkerScope?: string;
  serviceWorkerFeatures?: Record<string, unknown>;
  themeColor?: string;
  appleTouchIcon?: string;
  resourceHints?: ResourceHintsCollected;
  unusedPreloads?: { url?: string; type?: string }[];
  noindex?: boolean;
  metaRobots?: string;
  blockedByRobots?: boolean;
  robotsBlocked?: boolean;

  // Analysis results from various analyzers
  headings?: HeadingAnalysis;
  images?: ImageAnalysis;
  accessibility?: AccessibilityAnalysis;
  security?: SecurityAnalysis;
  structuredData?: StructuredDataAnalysis;
  socialMedia?: SocialMediaAnalysis;
  performance?: PerformanceAnalysis;
  contentQuality?: ContentQualityAnalysis;
  indexability?: IndexabilityAnalysis;
  international?: InternationalAnalysis;
  urlAnalysis?: UrlAnalysis;
  linkAnalysis?: LinkAnalysisData;

  // Advanced analyzer results
  analyzerError?: { message: string; stack?: string };
  soft404?: Soft404Data | null;
  freshnessData?: FreshnessData | null;
  thirdPartyData?: ThirdPartyData;
  timingData?: TimingData;
  criticalPathData?: CriticalPathData;
  fontData?: Record<string, unknown>;
  compressionData?: CompressionData;
  imageOptimization?: ImageOptimizationData;
  brokenMediaData?: BrokenMediaData;
  textIntegrityData?: TextIntegrityData;
  /** `--visual`: screenshots of the page regions holding visual defects, with highlight boxes. */
  visualShots?: VisualShot[];
  consoleAnalysis?: ConsoleAnalysisData;
  formData?: FormAccessibilityData;
  resourceOptimization?: ResourceOptimizationData;
  caching?: CachingData;
  mediaData?: MediaData;
  webComponentData?: WebComponentData;
  aboveFoldData?: AboveFoldData;
  anchorTextData?: AnchorTextData;
  externalLinksData?: ExternalLinksData;
  redirectAnalysis?: RedirectAnalysisData;
  resourceHintsData?: ResourceHintsData;
  mixedContentData?: MixedContentData;
  protocolData?: ProtocolData;
  pwaData?: PwaData;
  responseHeaderAnalysis?: ResponseHeaderAnalysisData;
  jsRenderingData?: Record<string, unknown>;
  codeCoverage?: CodeCoverageData | null;
  outboundLinkHealth?: OutboundLinkHealthData | null;
  technical?: TechnicalData;
  eeat?: EeatData;
  segment?: string;

  // Analyzer results not previously typed
  crawlability?: CrawlabilityData;
  internationalSEO?: InternationalSEOData;
  mobileFriendly?: MobileFriendlyData;
  analytics?: AnalyticsTrackingData;
  consentData?: ConsentData;
  paginationData?: PaginationData;
  aeo?: AeoData;
  technologies?: TechnologyDetectionData;
  ctas?: CtaItem[];
  ctaData?: CtaData;
  languageDetection?: LanguageDetectionData;
  colorContrastData?: ColorContrastData;
  reducedMotionData?: ReducedMotionData;
  ariaLiveData?: AriaLiveData;
  domComplexityData?: DomComplexityData;
  deprecatedHtmlData?: DeprecatedHtmlData;
  interstitialData?: InterstitialData;
  adDensityData?: AdDensityData;
  sriData?: SriData;
  infoDisclosureData?: InfoDisclosureData;
  openRedirectData?: OpenRedirectData;
  spellingData?: SpellingData;

  // Security-related analyzer data
  cspQualityData?: Record<string, unknown>;
  permissionsPolicyData?: Record<string, unknown>;
  crossOriginPolicyData?: Record<string, unknown>;

  // Site-wide analysis results (set by validators after crawl)
  internalPageRank?: number;
  contentSimilarity?: Record<string, unknown>;
  score?: number;
  seo?: Record<string, unknown>;

  // Raw HTML content (temporary, stripped during optimization)
  rawHtml?: string;

  /** Capped crawl-time facts for the post-crawl site checks (see site-checks/crawl-hints.ts). */
  siteHints?: SiteHints;
  /** CDN cache state of the HTML document (asset-delivery-analyzer). */
  cdnCache?: 'hit' | 'miss' | 'none';
  /** What tags actually sent during load (tag-runtime-analyzer). */
  tagRuntime?: TagRuntimeInfo;
}

export interface PageData {
  pages: Record<string, PageInfo>;
  processedPages: string[];
  totalWithoutError: number;
  totalWithError: number;
  byError: Record<string, number>;
  attempts: Record<string, number>;
  total?: number;
  isMultiLang?: boolean;
  incomingLinks?: Record<string, string[]>;
  dnsData?: Record<string, unknown>;
  segments?: Record<string, unknown>;
  segmentStats?: Record<string, unknown>;
  contentGaps?: unknown[];
  contentCoverage?: Record<string, unknown[]>;
  contentGapStats?: Record<string, unknown>;
  linkingOpportunities?: unknown[];
  linkingStats?: Record<string, unknown>;
  externalLinkVerification?: Record<string, unknown>;
}

// ─── Audit Results ───────────────────────────────────────────────────────────

export interface AuditResults {
  robots: RobotsData;
  sitemaps: SitemapData;
  pageData: PageData;
  analysis: AnalysisData;
  metadata?: AuditMetadata;
}

export interface RobotsData {
  sitemaps: string[];
  'user-agent': Record<string, RobotsRules>;
}

export interface RobotsRules {
  allow?: string[];
  disallow?: string[];
  'crawl-delay'?: number;
}

export interface SitemapData {
  urls: Record<string, SitemapUrl>;
  total: number;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
  alternates?: AlternateLink[];
  imageCount?: number;
  videoCount?: number;
  hasNews?: boolean;
}

export interface SitemapImage {
  loc?: string;
}

export interface SitemapVideo {
  thumbnailLoc?: string;
  title?: string;
  description?: string;
  contentLoc?: string;
  playerLoc?: string;
  duration?: string;
}

export interface SitemapNews {
  name?: string;
  language?: string;
  publicationDate?: string;
  title?: string;
}

/** Absolute http(s) media URLs found in one sitemap entry — kept in memory only, never persisted. */
export interface SitemapMediaTargets {
  images: string[];
  videos: string[];
}

export interface AlternateLink {
  hreflang: string;
  href: string;
}

export interface AnalysisDetail {
  severity: SeverityLevel;
  count: number;
  examples: string[];
  truncated?: boolean;
  countTruncated?: boolean;
}

export interface AnalysisData {
  overall: Issue[] | Set<string>;
  details: Record<string, AnalysisDetail>;
  bySeverity?: Record<SeverityLevel, string[]>;
  summary?: AuditSummary;
}

export interface AuditMetadata {
  startTime: string;
  endTime?: string;
  duration?: number;
  origin: string;
  version?: string;
}

// ─── Analyzer-Specific Types ─────────────────────────────────────────────────

export interface HeadingAnalysis {
  h1: string[];
  h2?: string[];
  h3?: string[];
  h4?: string[];
  h5?: string[];
  h6?: string[];
  h1Count?: number;
  h2Count?: number;
  h3Count?: number;
  h4Count?: number;
  h5Count?: number;
  h6Count?: number;
  issues: Issue[];
  warnings?: Issue[];
}

export interface ImageAnalysis {
  totalImages: number;
  withoutAlt: number;
  withEmptyAlt: number;
  decorativeImages: number;
  issues: Issue[];
}

export interface AccessibilityAnalysis {
  issues: Issue[];
  warnings?: Issue[];
  ariaLandmarks?: string[];
  formLabels?: { labeled: number; unlabeled: number };
  violations?: unknown[];
  violationCount?: number;
  a11yScore?: number | null;
  aria?: { valid?: number; invalid?: number } | null;
  forms?: { inputsWithLabels?: number; inputsWithoutLabels?: number } | null;
  semantic?: { hasMain?: boolean; hasNav?: boolean; hasHeader?: boolean; hasFooter?: boolean } | null;
  keyboard?: { elementsWithoutFocus?: number; positiveTabindex?: number } | null;
}

export interface SecurityAnalysis {
  isHttps: boolean;
  headers: Record<string, string | undefined>;
  issues: Issue[];
  securityScore?: number;
  missingHeaders?: string[];
  mixedContent?: number;
  insecureCookies?: number;
  insecureCookieDetails?: { name: string; domain: string; issues: string[]; sameSite?: string }[];
  sameSiteIssues?: number;
  formsWithoutCSRF?: number;
  inlineScripts?: number;
}

export interface JsonLdSchema {
  type?: string;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StructuredDataAnalysis {
  schemas: SchemaItem[];
  issues: Issue[];
  jsonLdSchemas?: JsonLdSchema[];
  hasStructuredData?: boolean;
}

export interface SchemaItem {
  type: string;
  properties: Record<string, unknown>;
}

export interface SocialMediaAnalysis {
  og: Record<string, string>;
  twitter: Record<string, string>;
  openGraph?: Record<string, string>;
  issues: Issue[];
  warnings?: Issue[];
  hasOpenGraph?: boolean;
  hasTwitterCard?: boolean;
}

export interface PerformanceAnalysis {
  totalSize?: number;
  requestCount?: number;
  renderBlockingResources?: number;
  issues: Issue[];
}

export interface ContentQualityAnalysis {
  wordCount: number;
  readabilityScore?: number;
  textToHtmlRatio?: number;
  keywordDensity?: Record<string, number>;
  issues: Issue[];
  wordCountBySection?: Record<string, number> | { heading: string; wordCount: number }[];
  paragraphCount?: number;
  topKeywords?: { word: string; count: number; density: number }[];
  textLength?: number;
  contentScore?: number;
}

export interface IndexabilityAnalysis {
  isIndexable: boolean;
  blockingFactors: string[];
  warnings: string[];
  metaRobots: string | null;
  xRobotsTag: string | null;
  statusCode: number;
  canonicalPointsElsewhere: boolean;
  hasNoindexTag: boolean;
  hasNofollowTag: boolean;
  blockedByRobotsTxt: boolean;
  issues?: Issue[];
}

export interface InternationalAnalysis {
  hreflangTags: AlternateLink[];
  issues: Issue[];
}

export interface UrlAnalysis {
  length: number;
  depth: number;
  hasUppercase?: boolean;
  hasUnderscores?: boolean;
  hasSpaces?: boolean;
  hasSpecialChars?: boolean;
  hasQueryParams?: boolean;
  hasTrackingParams?: boolean;
  trackingParams?: string[];
  queryParamCount?: number;
  paramCount?: number;
  isHttps?: boolean;
  hasParameters?: boolean;
  components?: unknown;
  issues: Issue[];
}

// ─── Advanced Analyzer Data Types ───────────────────────────────────────────

export interface LinkAnalysisData {
  totalLinks?: number;
  internalLinks?: number;
  externalLinks?: number;
  nofollowLinks?: number;
  followLinks?: number;
  brokenLinks?: { href: string; statusCode: number; anchorText: string }[] | number;
  redirectLinks?: { href: string; redirectsTo: string }[];
  emptyAnchorLinks?: { href: string; rel: string }[];
  genericAnchorLinks?: { href: string; anchorText: string }[];
  anchorTextMap?: Record<string, number>;
  externalDomains?: Record<string, number>;
  linksToNonIndexable?: { href: string; reason: string }[];
  linkDepth?: number | null;
  issues?: Issue[];
  warnings?: Issue[];
  internalLinkRatio?: number;
  externalLinkRatio?: number;
  nofollowRatio?: number;
  internalNofollowLinks?: { href: string; anchorText: string }[];
  internalLinkUrls?: string[];
}

export interface Soft404Data {
  isSoft404: boolean;
  confidence: number;
  signals: string[];
}

export interface FreshnessData {
  lastModified: string | null;
  datePublished: string | null;
  dateModified: string | null;
  copyrightYear: number | null;
  lastUpdatedText: string | null;
  freshnessScore: number;
  ageInDays: number | null;
}

export interface ThirdPartyScript {
  url: string;
  host: string;
  category: string;
  size: number;
  duration: number;
  resourceType: string;
  status: number;
}

export interface ThirdPartyData {
  scripts?: ThirdPartyScript[];
  totalSize?: number;
  totalTime?: number;
  totalScripts?: number;
  byCategory?: Record<string, { count: number; size: number; time: number; hosts: string[] }>;
  blockingScripts?: { src: string; host: string }[];
  count?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface TimingPhaseData {
  total: number;
  slow: { url: string; origin: string; time: number }[];
}

export interface TimingData {
  document?: {
    dns: number;
    tcp: number;
    tls: number;
    ttfb: number;
    download: number;
    total: number;
    protocol: string;
  } | null;
  dns?: TimingPhaseData;
  tcp?: TimingPhaseData;
  tls?: TimingPhaseData;
  ttfb?: TimingPhaseData;
  uniqueOrigins?: string[];
  originTimings?: Record<
    string,
    {
      isFirstParty: boolean;
      requestCount: number;
      totalDns: number;
      totalTcp: number;
      totalTls: number;
      totalSize: number;
      protocol: string;
    }
  >;
  resourceTimings?: {
    url: string;
    origin: string;
    initiatorType: string;
    dns: number;
    tcp: number;
    tls: number;
    ttfb: number;
    download: number;
    total: number;
    size: number;
    protocol: string;
  }[];
  slowResources?: { url: string; origin: string; time: number }[];
  issues?: Issue[];
  warnings?: Issue[];
}

export interface CriticalPathData {
  blockingCSS?: { href: string; media: string; size: number; isBlocking: true }[];
  blockingJS?: { src: string; size: number; inHead: boolean; isBlocking: true; isInline: boolean }[];
  criticalCSSSize?: number;
  criticalJSSize?: number;
  totalBlockingTime?: number;
  documentSize?: number;
  htmlParseTime?: number;
  domContentLoaded?: number;
  firstPaint?: number;
  recommendations?: string[];
  inlineCSS?: { size: number }[];
  inlineJS?: { size: number }[];
  inlineCSSSize?: number;
  inlineJSSize?: number;
  hasCriticalCSS?: boolean;
  blockingCSSCount?: number;
  blockingJSCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface CompressionData {
  htmlCompression?: string | null;
  compressedResources?: number;
  uncompressedResources?: number;
  potentialSavings?: number;
  compressionTypes?: { gzip: number; br: number; deflate: number; none: number };
  resources?: {
    url: string;
    contentType: string;
    encoding: string;
    size: number;
    isCompressible: boolean;
    shouldCompress: boolean;
    isCompressed: boolean;
    potentialSavings: number;
  }[];
  issues?: Issue[];
  warnings?: Issue[];
}

export interface ImageOptimizationData {
  totalImages?: number;
  totalImageSize?: number;
  oversizedImages?: {
    src: string;
    size: number;
    naturalWidth: number;
    naturalHeight: number;
    displayWidth: number;
    displayHeight: number;
  }[];
  modernFormats?: number;
  legacyFormats?: number;
  withLazyLoading?: number;
  withoutLazyLoading?: number;
  withoutAlt?: number;
  images?: { src: string; size: number; format: string; width: number; height: number; loading: string }[];
  issues?: Issue[];
  warnings?: Issue[];
}

export interface ConsoleAnalysisData {
  errorCount?: number;
  criticalErrorCount?: number;
  warningCount?: number;
  errors?: { text: string; type: string; url: string; isCritical: boolean }[];
  warnings?: unknown[];
  hasErrors?: boolean;
  hasCriticalErrors?: boolean;
  issues?: Issue[];
}

export interface FormInput {
  type: string;
  id?: string;
  name?: string;
  hasLabel: boolean;
  hasExplicitLabel?: boolean;
  hasImplicitLabel?: boolean;
  hasAriaLabel?: boolean;
  shouldHaveAutocomplete: boolean;
  hasAutocomplete: boolean;
  autocompleteValue?: string;
  isRequired?: boolean;
  hasAriaRequired?: boolean;
  tabindex?: number;
  placeholderAsLabel?: boolean;
}

export interface FormAccessibilityData {
  forms?: {
    index: number;
    hasAction: boolean;
    method: string;
    hasSubmitButton: boolean;
    hasFieldset: boolean;
    hasRadioGroups: boolean;
    hasPositiveTabindex: boolean;
    inputs: FormInput[];
    inputsWithoutLabels: number;
    inputsWithoutAutocomplete: number;
    requiredWithoutAria: number;
    placeholderAsLabel: number;
  }[];
  totalForms?: number;
  totalInputs?: number;
  inputsWithoutLabels?: number;
  inputsWithoutAutocomplete?: number;
  formsWithoutAction?: number;
  accessibilityScore?: number;
  formCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface ResourceOptimizationData {
  compression?: {
    gzipCompressed?: number;
    brotliCompressed?: number;
    uncompressed?: number;
    totalSize?: number;
    compressedSize?: number;
    issues?: { severity: string; url: string; size: number }[];
  };
  minification?: {
    minifiedJS?: number;
    unminifiedJS?: number;
    minifiedCSS?: number;
    unminifiedCSS?: number;
    issues?: { severity: string; url: string; type: string; size: number }[];
  };
  renderBlocking?: {
    blockingScripts?: number;
    blockingStyles?: number;
    totalBlocking?: number;
    issues?: Issue[];
  };
  protocol?: { http1: number; http2: number; http3: number };
  renderBlockingResources?: unknown[];
  renderBlockingCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface CachingData {
  hasCDN?: boolean;
  cdnProvider?: string | null;
  htmlCacheable?: boolean;
  staticCached?: number;
  staticUncached?: number;
  hasServiceWorker?: boolean;
  cacheScore?: number | null;
  resources?: unknown[];
  cachedCount?: number;
  uncachedCount?: number;
  dynamicCached?: number;
  dynamicUncached?: number;
  issues?: string[];
  warnings?: string[];
}

export interface MediaData {
  videos?: Record<string, unknown>[];
  audios?: { src: string | null; hasTitle: boolean; hasTranscript: boolean }[];
  hasVideoSchema?: boolean;
  videoSchemaValid?: boolean;
  totalVideos?: number;
  totalAudios?: number;
  embeddedVideos?: {
    type: 'embedded';
    platform: string;
    src: string;
    hasTitle: boolean;
    title: string | null;
    hasCaption: boolean;
  }[];
  nativeVideos?: {
    type: 'native';
    src: string | null;
    sources: (string | null)[];
    hasPoster: boolean;
    poster: string | null;
    hasTitle: boolean;
    title: string | null;
    hasCaption: boolean;
    captionKind: string | null;
    autoplay: boolean;
    muted: boolean;
  }[];
  videosWithoutCaptions?: number;
  videosWithoutPoster?: number;
  videosWithoutTitle?: number;
  videoSchemaIssues?: string[];
  videoCount?: number;
  audioCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface WebComponentData {
  customElements?: { tagName: string; count: number; hasShadowRoot: boolean; isConnected: boolean }[];
  shadowRoots?: { hostTag: string; mode: string; childCount: number; textLength: number }[];
  totalCustomElements?: number;
  totalShadowRoots?: number;
  contentInShadowDom?: { text: boolean; links: boolean; headings: boolean; images: boolean };
  shadowDomTextLength?: number;
  lightDomTextLength?: number;
  framework?: string | null;
  hasDeclarativeShadowDom?: boolean;
  components?: unknown[];
  componentCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface AboveFoldData {
  viewport?: { width: number; height: number };
  hasContentAboveFold?: boolean;
  aboveFoldElements?: {
    headings: { tag: string; text: string }[];
    images: { src: string; size: number; loading: string; fetchPriority: string }[];
    text: Record<string, unknown>[];
    cta: { text: string; type: string }[];
  };
  criticalResources?: { url: string; type: string; size: number }[];
  lcpInViewport?: boolean;
  renderBlockingResources?: number;
  aboveFoldImageSize?: number;
  estimatedFoldPosition?: null;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface AnchorTextData {
  totalLinks?: number;
  internalLinks?: number;
  externalLinks?: number;
  genericAnchors?: { href: string; anchor: string }[];
  emptyAnchors?: string[];
  imageOnlyLinks?: { href: string; hasAlt: boolean }[];
  duplicateAnchors?: Record<string, string[]>;
  anchorDistribution?: Record<string, number>;
  avgAnchorLength?: number;
  anchors?: unknown[];
  anchorCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface ExternalLinksData {
  totalExternalLinks?: number;
  followedLinks?: number;
  nofollowLinks?: number;
  ugcLinks?: number;
  sponsoredLinks?: number;
  newTabLinks?: number;
  brokenLinks?: { href: string; status: number }[];
  suspiciousLinks?: { href: string; anchor: string }[];
  linksByDomain?: Record<string, { count: number; followed: number; nofollow: number }>;
  affiliateLinks?: { href: string; hasSponsored: boolean }[];
  socialLinks?: string[];
  links?: unknown[];
  externalLinkCount?: number;
  issues?: Issue[];
  warnings?: Issue[];
}

export interface RedirectAnalysisData {
  redirectCount: number;
  redirectChain: { url: string; status: number; timing?: number }[];
  finalUrl: string;
  hasHttpToHttps: boolean;
  hasWwwRedirect: boolean;
  totalRedirectTime: number;
}

export interface ResourceHintsData {
  preload: Record<string, unknown>[];
  prefetch: Record<string, unknown>[];
  preconnect: Record<string, unknown>[];
  dnsPrefetch: Record<string, unknown>[];
  modulePreload: Record<string, unknown>[];
  missingHints: { url: string; type: string; reason: string }[];
  unnecessaryHints: { url: string; type: string; reason: string }[];
}

export interface MixedContentData {
  isHttps: boolean;
  activeMixedContent: { url: string; type: string; blocked: boolean }[];
  passiveMixedContent: { url: string; type: string; blocked: boolean }[];
  totalMixedResources: number;
  blockedResources: number;
  htmlMixedContent?: { type: string; url: string }[];
}

export interface ProtocolData {
  protocol: string | null;
  protocolVersion: number | null;
  supportsHttp2: boolean;
  supportsHttp3: boolean;
  resourceProtocols: Record<string, number>;
  multiplexingBenefit: {
    resourceCount: number;
    http1EstimatedRounds: number;
    estimatedSavings: string;
  } | null;
  altSvc: string | null;
}

export interface PwaData {
  hasManifest: boolean;
  manifestUrl: string | null;
  manifestValid: boolean;
  manifestFields: Record<string, unknown> | string[];
  hasServiceWorker: boolean;
  serviceWorkerScope: string | null;
  isInstallable: boolean;
  installabilityIssues: string[];
  hasThemeColor: boolean;
  hasAppleTouchIcon: boolean;
  httpsRequired: boolean;
  offlineCapable: boolean;
}

export interface ResponseHeaderAnalysisData {
  vary: string | null;
  linkHeader: string | null;
  xRobotsTag: string | null;
  contentLanguage: string | null;
  parsedLinks: { url: string; rel?: string; hreflang?: string; as?: string; type?: string }[];
  varyDirectives: string[];
  dynamicServing?: boolean;
  preloadHints?: { url: string; as: string }[];
  httpCanonical?: string;
  httpAlternates?: { url: string; hreflang: string }[];
  noindexViaHeader?: boolean;
  nofollowViaHeader?: boolean;
  nosnippetViaHeader?: boolean;
  noarchiveViaHeader?: boolean;
  maxSnippet?: number;
  maxImagePreview?: string;
  missingXContentTypeOptions?: boolean;
}

export interface CodeCoverageFile {
  url: string;
  total: number;
  unused: number;
  unusedPercent: number;
}

export interface CodeCoverageData {
  js?: { total: number; used: number; unused: number; ratio: number; files: CodeCoverageFile[] };
  css?: { total: number; used: number; unused: number; ratio: number; files: CodeCoverageFile[] };
  totalUnusedBytes?: number;
  totalBytes?: number;
  unusedRatio?: number;
}

export interface OutboundLinkHealthData {
  totalChecked: number;
  broken: { url: string; status: number }[];
  redirected: { url: string; redirectTo: string; status: number }[];
  timeouts: string[];
  healthy: number;
}

export interface TechnicalData {
  metaRefresh: { delay: number; url: string | null } | null;
  jsFramework: string | null;
  cms: string | null;
  generator?: string | null;
  amp: boolean;
  pwa: boolean;
  lazyLoading: boolean | { type: string; count?: number; pattern?: string } | null;
  preload: { href: string; as: string | null }[];
  prefetch: string[];
  dns_prefetch: string[];
}

export interface EeatData {
  author: string | null;
  authorCredentials: string[];
  publishDate: string | null;
  updateDate: string | null;
  hasAboutPage: boolean;
  hasContactInfo: boolean;
  hasPrivacyPolicy: boolean;
  hasTermsOfService: boolean;
  trustSignals: string[];
  expertiseSignals: string[];
  score: number;
  isYMYL?: boolean;
  hasAuthor?: boolean;
  hasCitations?: boolean;
}

// ─── Additional Analyzer Data Types ──────────────────────────────────────────

export interface CrawlabilityData {
  isCrawlable: boolean;
  blockingFactors: string[];
  warnings: string[];
  hasRobotsTxtBlock: boolean;
  hasAuthRequired: boolean;
  redirectChain: string[];
  loadTime: number;
  resourcesBlocked: string[];
}

export interface InternationalSEOData {
  language: string | null;
  region: string | null;
  hasLangAttribute: boolean;
  langAttribute: string | null;
  htmlLang?: string | null;
  contentLanguageHeader: string | null;
  hasHreflang: boolean;
  hasXDefault: boolean;
  hasSelfReferential: boolean;
  urlStructure: string | null;
  charset: string | null;
  issues: string[];
  warnings: string[];
  currencyDetected?: string;
  hasDateFormat?: boolean;
  detectedScript?: string;
}

export interface MobileFriendlyData {
  isMobileFriendly: boolean;
  issues: string[];
  warnings: string[];
  issueCount: number;
  warningCount: number;
  metrics: Record<string, unknown>;
}

export interface AnalyticsTrackingData {
  hasGA4: boolean;
  hasUniversalAnalytics: boolean;
  hasGTM: boolean;
  hasFacebookPixel: boolean;
  hasLinkedInTag: boolean;
  hasTwitterPixel: boolean;
  hasTikTokPixel: boolean;
  hasPinterestTag: boolean;
  hasHotjar: boolean;
  hasMicrosoftClarity: boolean;
  trackingIds: Record<string, string[]>;
  hasCookieConsent: boolean;
  consentTool: string | null;
  hasPrivacyPolicy: boolean;
  issues: string[];
  warnings: string[];
}

export interface ConsentData {
  hasConsentBanner: boolean;
  consentPlatform: string | null;
  hasCookiePolicy: boolean;
  hasPrivacyPolicy: boolean;
  cookiesBeforeConsent: string[];
  trackingBeforeConsent: string[];
  totalCookies: number;
  thirdPartyCookies: number;
  bannerDetectionMethod: string | null;
  policyLinks?: { type: string; href: string }[];
  cookies?: {
    name: string;
    domain: string;
    isThirdParty: boolean;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
    expires: number;
  }[];
}

export interface PaginationData {
  hasPagination: boolean;
  type: string | null;
  hasRelPrevNext: boolean;
  relPrev: string | null;
  relNext: string | null;
  hasCanonical: boolean;
  canonicalPointsToSelf: boolean;
  paginationLinks: { page: number; href: string }[];
  currentPage: number | null;
  totalPages: number | null;
  /** True when an infinite-scroll *mechanism* (sentinel/trigger/container) is present. Descriptive only. */
  infiniteScrollDetected: boolean;
  /**
   * True when the page's list content is discoverable without client-side scroll —
   * i.e. there is no real scrolled list, or the list is already present in the
   * served HTML. When true, infinite scroll is NOT an SEO discoverability problem.
   */
  infiniteScrollContentCrawlable?: boolean;
  loadMoreDetected: boolean;
  issues: Issue[];
  /** Resolved href of the "next" control, if one was found. */
  nextUrl?: string | null;
  /** True when a "next" control exists but has no usable static href (JS-driven). */
  nextIsJsControl?: boolean;
  /** Result of the active JS-"next" probe (Part B). Null when not probed. */
  nextProbe?: PaginationProbeResult | null;
}

export interface PaginationProbeResult {
  /** Number of times "next" was successfully clicked. */
  clicks: number;
  /** Whether page content changed across the clicks. */
  contentChanged: boolean;
  /** Whether the "next" control was still present/enabled after the last click. */
  controlPersists: boolean;
  /** Whether the listing became empty after clicking. */
  emptyAfterClick: boolean;
  /** Whether clicking "next" ever advanced the URL path/query (ignoring the
   *  hash) — i.e. produced a new CRAWLABLE URL. False for in-page anchor /
   *  hash-only "next" links, which can't waste crawl budget. */
  urlAdvanced: boolean;
  /** Heuristic verdict: "next" advances into empty/duplicate content forever. */
  suspectedInfinite: boolean;
}

export interface AeoData {
  semanticHTMLRatio: number;
  semanticElements: Record<string, number>;
  genericElements: number;
  totalElements: number;
  hasFAQContent: boolean;
  hasDefinitionLists: boolean;
  hasStructuredQA: boolean;
  hasClearHeadingHierarchy: boolean;
  contentStructureScore: number;
  hasCitableContent: boolean;
  hasDatetimeMarkup: boolean;
  hasAuthorInfo: boolean;
  hasFAQSchema?: boolean;
  hasHowToSchema?: boolean;
  hasContentLists?: boolean;
  hasStructuredTables?: boolean;
  hasBlockquotes?: boolean;
}

export interface TechnologyDetectionData {
  technologies: {
    name: string;
    category: string;
    confidence: string;
    detectedBy: { type: string; pattern?: string; matched?: string; tag?: string; value?: string; header?: string }[];
  }[];
  byCategory: Record<string, string[]>;
  summary: {
    total: number;
    categories: { category: string; count: number; technologies: string[] }[];
  };
}

export interface CtaItem {
  type: string;
  text: string;
  href?: string | null;
  action?: string;
  method?: string;
  inputCount?: number;
  rect: { top: number; left: number; width: number; height: number };
  aboveFold: boolean;
}

export interface CtaData {
  ctas: CtaItem[];
  summary: {
    total: number;
    forms: number;
    ctaButtons: number;
    buttons: number;
    phoneLinks: number;
    emailLinks: number;
    aboveFoldCount: number;
  };
}

export interface LanguageDetectionData {
  detectedLanguage: string | null;
  detectedConfidence: number;
  declaredLanguage: string | null;
  htmlLang: string | null;
  contentLanguageHeader: string | null;
  match: boolean | null;
  topCandidates: { language: string; score: number; confidence: number }[];
}

export interface ColorContrastData {
  totalChecked: number;
  aaFailures: number;
  aaaFailures: number;
  worstContrast: {
    selector: string;
    text: string;
    foreground: string;
    background: string;
    ratio: number;
    fontSize: number;
    fontWeight: number;
    isLargeText: boolean;
    passesAA: boolean;
    passesAAA: boolean;
  } | null;
  failures: {
    selector: string;
    text: string;
    foreground: string;
    background: string;
    ratio: number;
    fontSize: number;
    fontWeight: number;
    isLargeText: boolean;
    passesAA: boolean;
    passesAAA: boolean;
  }[];
}

export interface ReducedMotionData {
  hasReducedMotionQuery: boolean;
  autoplayVideos: number;
  autoplayVideosWithoutPause: number;
  animatedElements: number;
  carousels: number;
  marqueeElements: number;
}

export interface AriaLiveData {
  totalLiveRegions: number;
  assertiveRegions: number;
  politeRegions: number;
  alertRoles: number;
  statusRoles: number;
  emptyLiveRegions: number;
  largeLiveRegions: number;
}

export interface DomComplexityData {
  totalNodes: number;
  maxDepth: number;
  maxChildren: number;
  deepestElement: string;
  widestElement: string;
  bodyChildren: number;
  elementCounts: Record<string, number>;
}

export interface DeprecatedHtmlData {
  deprecatedElements: { tag: string; count: number; replacement: string }[];
  deprecatedAPIs: string[];
  totalDeprecated: number;
}

export interface InterstitialData {
  detected: boolean;
  overlays: {
    selector: string;
    coveragePercent: number;
    zIndex: number;
    position: string;
  }[];
  cookieBanner: boolean;
  popupLibraries: string[];
}

export interface AdDensityData {
  totalAds: number;
  adAreaPercent: number;
  stickyAds: number;
  adNetworks: string[];
  adElements: { selector: string; width: number; height: number; isSticky: boolean }[];
}

export interface SriData {
  externalScripts: number;
  externalStyles: number;
  scriptsWithSRI: number;
  stylesWithSRI: number;
  missingIntegrity: { tag: string; src: string }[];
}

export interface InfoDisclosureData {
  serverHeader: string | null;
  poweredBy: string | null;
  disclosedHeaders: { name: string; value: string }[];
  sensitiveComments: number;
  hasSourceMaps: boolean;
  sourceMapUrls: string[];
}

export interface OpenRedirectData {
  suspiciousParams: { url: string; param: string; value: string }[];
  suspiciousLinks: { href: string; param: string }[];
}

export interface SpellingData {
  totalWords: number;
  misspellings: { word: string; correction: string; count: number }[];
  totalMisspellings: number;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface CategoryScores {
  seo: number;
  performance: number;
  accessibility: number;
  security: number;
  technical: number;
  /** Agentic Browsing; shown beside the others but kept out of the overall blend. Absent when no page ran the checks. */
  agentic?: number;
}

/** How many analyzed pages carry agentic-browsing data. */
export interface AgenticCoverage {
  covered: number;
  total: number;
  /** Pages whose computed-style hints were unavailable, so the hover-only check read inline styles only. */
  hintsLimited: number;
}

export interface QuickWin {
  issue: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  category: string;
  affectedPages: number;
  recommendation: string;
}

export interface AuditSummary {
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  categoryScores: CategoryScores;
  overallScore: number;
  passRate: number;
  quickWins: QuickWinFull[];
  /** Present when at least one page ran the agentic checks. */
  agenticCoverage?: AgenticCoverage;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NetworkCondition {
  download?: number;
  upload?: number;
  latency?: number;
  noThrottle?: boolean;
  name: string;
}

export interface CpuCondition {
  rate?: number;
  noThrottle?: boolean;
  name: string;
}

/**
 * The crawl's effective throttle profile, recorded into metadata so the live
 * `--verify` pass can re-fetch under the same conditions. `network`/`cpu` are
 * the SINGLE selected conditions actually applied (slow4g / normal), not the
 * full condition maps.
 */
export interface CrawlProfile {
  perf: boolean;
  network: NetworkCondition | null;
  cpu: CpuCondition | null;
}

export interface AuditConfig {
  origin?: string;
  sitemap?: string;
  compareSitemap?: string;
  proceed?: boolean;
  perf?: boolean;
  saveHtml?: boolean;
  screenshots?: boolean;
  concurrency?: number;
  preset?: PresetName;
  sections?: string[];
  checks?: string[];
  network?: string;
  cpu?: string;
  watch?: number;
  webhook?: string;
  slack?: string;
  config?: string;
  repoPath?: string;
  batchSize?: number;
  queryParamMode?: 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist';
  queryParamWhitelist?: string[];
  queryParamBlacklist?: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
  resolvedPath?: string;
}

// ─── Crawling ────────────────────────────────────────────────────────────────

export interface CrawlProgress {
  processedPages: string[];
  pages: Record<string, PageInfo>;
  totalWithoutError: number;
  totalWithError: number;
  byError: Record<string, number>;
  attempts: Record<string, number>;
}

export interface IncomingLinksMap extends Map<string, Set<string>> {}

// ─── Error Aggregation ───────────────────────────────────────────────────────

export interface AggregatedError {
  general: string;
  count: number;
  severity: SeverityLevel;
  examples: string[];
}

// ─── Common Analyzer Parameter Types ─────────────────────────────────────────

/** node-html-parser HTMLElement - used as parsedPage parameter */
export type { HTMLElement as ParsedPage } from 'node-html-parser';

/** Playwright Page - used as chromePage parameter */
export type { Page as ChromePage } from 'playwright';

/** Playwright Response - used as response parameter */
export type { Response as ChromeResponse } from 'playwright';

/** Resource collected during crawl (network request with extended metadata) */
export interface CrawledResource {
  url?: string;
  type?: string;
  resourceType?: string;
  status?: number;
  headers?: Record<string, string>;
  size?: number;
  transferSize?: number;
  contentType?: string;
  encoding?: string;
  isCompressible?: boolean;
  shouldCompress?: boolean;
  isCompressed?: boolean;
  potentialSavings?: number;
  protocol?: string;
  [key: string]: unknown;
}

/** Collected resource hints from DOM (preload, prefetch, etc.) */
export interface ResourceHintsCollected {
  preload?: { href?: string; as?: string; type?: string; crossorigin?: string }[];
  prefetch?: { href?: string; as?: string }[];
  preconnect?: { href?: string; crossorigin?: string }[];
  dnsPrefetch?: { href?: string }[];
  modulePreload?: { href?: string }[];
}

/** Network request info collected during crawl */
export interface NetworkRequest {
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  headers?: Record<string, string>;
  size?: number;
  transferSize?: number;
  mimeType?: string;
  timing?: Record<string, number>;
}

// ─── Metrics Metadata ────────────────────────────────────────────────────────

export interface MetricInfoEntry {
  name: string;
  fullName?: string;
  description: string;
  unit?: string;
  type?: string;
  threshold?: number;
  min?: number;
  max?: number;
  recommended?: number;
  isInverse?: boolean;
  goodLabel?: string;
  badLabel?: string;
  learnMore?: string;
  note?: string;
}

export interface SignalCategory {
  name: string;
  description: string;
  signals: string[];
}

export interface SeverityColorConfig {
  bg: string;
  text: string;
  border: string;
}

// ─── Report Section Data ────────────────────────────────────────────────────

export interface ComparisonData {
  compareJsonData: Record<string, unknown>;
  comparePages: PageInfo[];
  comparePageData: PageData & { incomingLinks?: Record<string, string[]> };
  compareDomainName: string;
  originDomainName: string;
  matchedPaths: Array<{ path: string; originUrl: string; compareUrl: string }>;
  originOnlyPaths: string[];
  compareOnlyPaths: string[];
}

export interface ReportSectionData {
  jsonData: Record<string, unknown>;
  pages: PageInfo[];
  pageData: PageData & { incomingLinks?: Record<string, string[]> };
  timing?: Record<string, unknown>;
  analysis?: AnalysisData;
  metrics?: Record<string, unknown>;
  pageCounts?: Record<string, number>;
  topIssues?: TopIssue[];
  trendData?: TrendDataCompat | null;
  previousAudit?: AuditSnapshot | null;
  sitemaps?: Record<string, unknown>;
  robots?: Record<string, unknown>;
  isMultiLang?: boolean;
  hasPerformanceMetrics?: boolean;
  domainName?: string;
  comparison?: ComparisonData;
  /** --no-score: omit every score and the scoring-rules block. */
  noScore?: boolean;
  /** Run directory, for reading evidence files (e.g. visual screenshots) into the report. */
  runDir?: string;
}

export interface TopIssue {
  issue: string;
  severity: string;
  count: number;
  examples: string[];
}

export interface TrendDataCompat {
  labels: string[];
  scores: number[];
  issues: number[];
  critical: number[];
  high: number[];
  categoryScores: Record<string, number[]>;
  performance: {
    ttfb: (string | null)[];
    lcp: (string | null)[];
    cls: (string | null)[];
  };
  issueTrends: Record<string, IssueTrend> | null;
  insights?: Record<string, (number | null)[]>;
}

export interface QuickWinFull {
  issue: string;
  severity: string;
  affectedPages: number;
  impact: string;
  effort: string;
  effortMinutes: number;
  fix: string;
  example?: string;
  resources: Array<{ text: string; url: string }>;
  impactScore: number;
  examples: string[];
}

export interface HeadingCount {
  tag: string;
  count: number;
}

export interface FailedBatch {
  file: string;
  error: string;
  expectedCount: number;
}

export interface ManifestData {
  files: {
    metadata: string;
    analysis: string;
    incomingLinks: string;
    pageBatches?: Array<{ file: string; count?: number }>;
  };
  progress: {
    processedPages: string[];
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, number>;
  };
}

export interface TimingPhase {
  name: string;
  duration: string;
  durationMs?: number;
}

export interface FixRecommendation {
  effort: string;
  fix: string;
  example?: string;
  resources?: Array<{ text: string; url: string }>;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ReportData {
  results: AuditResults;
  summary: AuditSummary;
  domain: string;
  timestamp: string;
  historyData?: HistoryEntry[];
}

export interface HistoryEntry {
  timestamp: string;
  overallScore: number;
  categoryScores: CategoryScores;
  totalPages: number;
  totalIssues: number;
}

// ─── CLI Arguments ──────────────────────────────────────────────────────────

export interface ParsedArgs {
  origin: string | null;
  compare: string | null;
  sitemap: string | null;
  compareSitemap: string | null;
  proceed: boolean;
  perf: boolean;
  saveHtml: boolean;
  screenshots: boolean;
  concurrency: number;
  concurrencyExplicit: boolean;
  heapSize: number | null;
  config: string | null;
  initConfig: boolean;
  repo: string | null;
  exclude: string[];
  limit: number | null;
  dryRun: boolean;
  generateCi: boolean;
  validateConfig: boolean;
  webhook: string | null;
  version: boolean;
  help: boolean;
  open: boolean;
  verbose: boolean;
  preset: PresetName | null;
  /** `--sections=<csv>` for `--preset=custom` (validated by `resolvePreset`). */
  sections: string[];
  /** `--checks=<csv>` for `--preset=custom` (validated by `resolvePreset`). */
  checks: string[];
  sites: string | null;
  slack: string | null;
  watch: number | null;
  brandLogo: string | null;
  brandName: string | null;
  ci: number | null;
  json: boolean;
  phase2: boolean;
  llmNarrative: boolean;
  llmFindings: boolean;
  llmRepo: boolean;
  llmVerify: boolean;
  verify: boolean;
  /** `--visual` / `--no-visual`; `null` ⇒ take `visual` from `.seoauditrc` (default off). */
  visual: boolean | null;
  noScore: boolean;
  evidence: boolean;
  evidenceCap: number;
  /** Phase 4 — opt-in competitive content research + content plan. */
  contentResearch: boolean;
  /** Comma-separated competitor URLs or a path to a file (one URL per line). Optional — LLM discovers when omitted. */
  competitors: string | null;
  warnings: string[];
  /** Fatal argument errors (e.g. unknown preset); the CLI exits non-zero when non-empty. */
  errors: string[];
}

// ─── SEOData Options ────────────────────────────────────────────────────────

export interface SEODataOptions {
  verbose?: boolean;
  open?: boolean;
  exclude?: string[];
  limit?: number | null;
  dryRun?: boolean;
  cruxApiKey?: string | null;
  screenshots?: boolean;
  /** When false, skip representative-page evidence capture (screenshots, axe, PSI). */
  evidence?: boolean;
  /** Cap on representative-page samples (default 10). */
  evidenceCap?: number;
  /** Run the visual (UI defect) analyzers. On `--proceed` the checkpoint's value wins. */
  visual?: boolean;
}

// ─── History Types ──────────────────────────────────────────────────────────

export interface AuditSnapshotSummary {
  overallScore: number;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  passRate: number;
  categoryScores: Partial<CategoryScores>;
  totalPages: number;
  pagesWithErrors: number;
  sitemapUrls: number;
}

export interface IssueSummary {
  severity: SeverityLevel;
  count: number;
}

export interface PerformanceSummary {
  avgTTFB: string;
  avgLCP: string;
  avgCLS: string;
  p75TTFB: string;
  p75LCP: string;
  p75CLS: string;
  pagesWithMetrics: number;
}

export interface InsightsSummary {
  languageMismatches: number;
  brokenOutboundLinks: number;
  nearDuplicatePages: number;
  pagesWithoutCTAs: number;
  avgJsUnused: number | null;
  avgCssUnused: number | null;
}

export interface AuditSnapshot {
  timestamp: string;
  date: string;
  runTimestamp: string | null;
  summary: AuditSnapshotSummary;
  issues: Record<string, IssueSummary>;
  performance: PerformanceSummary | null;
  technologies: string[];
  insights: InsightsSummary | null;
  quickWins: Array<{ issue: string; affectedPages: number; severity: SeverityLevel }>;
  /** url → contentHash, for the diff classifier's "site changed" signal. */
  pageHashes?: Record<string, string>;
}

export interface AuditHistory {
  domain: string;
  audits: AuditSnapshot[];
}

export interface AuditComparison {
  timestamp: string;
  oldDate: string;
  newDate: string;
  scoreChange: number;
  improvements: string[];
  regressions: string[];
  fixed: string[];
  newIssues: string[];
  deltaMetrics: {
    totalIssues: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    passRate: number;
  };
  categoryDeltas?: Record<string, number>;
  performanceDeltas?: {
    ttfb: number;
    lcp: number;
    cls: number;
  };
  insightDeltas?: Record<string, number>;
  /**
   * Classifier output: each finding change bucketed by trustworthiness.
   *   real         — structural change or volatile metric exceeded noise floor
   *   noise        — volatile-finding count moved within the noise floor
   *   siteChanged  — context, not a per-finding bucket: how many pages
   *                  actually changed content between runs
   */
  classified?: {
    real: AuditDiffEntry[];
    noise: AuditDiffEntry[];
    siteChanged: {
      pagesCompared: number;
      pagesChanged: number;
      pagesUnchanged: number;
      pagesUnique: number; // present only on one side
    };
  };
}

export interface AuditDiffEntry {
  slug: string;
  message: string;
  kind: 'new' | 'fixed' | 'count';
  oldCount: number;
  newCount: number;
  severity?: SeverityLevel | string;
  /** True when matched via a volatile-finding heuristic. */
  volatile: boolean;
}

export interface IssueTrend {
  labels: string[];
  counts: number[];
  severity: SeverityLevel;
  trend: 'stable' | 'new' | 'fixed' | 'improving' | 'worsening';
  latestCount: number;
  change: number;
  changePercent: number | string;
}

export interface TrendData {
  labels: string[];
  overallScores: number[];
  totalIssues: number[];
  criticalIssues: number[];
  highIssues: number[];
  categoryScores: Record<string, number[]>;
  performance: {
    ttfb: (string | null)[];
    lcp: (string | null)[];
    cls: (string | null)[];
  };
  issueTrends: Record<string, IssueTrend> | null;
  insights: Record<string, (number | null)[]>;
}

// ─── Sitemap Parser Result ──────────────────────────────────────────────────

export interface SitemapParseResult {
  sitemaps: Record<string, unknown>;
  urls: Record<string, SitemapUrl>;
  total: number;
  errors: Array<{ message: string; detail: string; severity: SeverityLevel }>;
}

// ─── Crawler Engine ─────────────────────────────────────────────────────────

export interface CrawlerEngineOptions {
  concurrency: number;
  saveHtml: boolean;
  screenshots: boolean;
  perf: boolean;
  origin: string | null;
  networkConditions: Record<string, NetworkCondition>;
  cpuConditions: Record<string, CpuCondition>;
  verbose: boolean;
  cruxApiKey: string | null;
  /** Base directory where per-page evidence (screenshots, HAR) is written. */
  evidenceDir?: string;
  /** Max number of representative-page samples (default 10). */
  evidenceCap?: number;
  /** Run the visual (UI defect) analyzers. */
  visual?: boolean;
}

export interface CrawlerCallbacks {
  saveError: (generalError: string, detailedError: string, severity?: string) => void;
  saveData: () => void | Promise<void>;
  checkAttempts: (url: string) => void;
  saveAttempt: (url: string) => void;
}

/** Fetch outcome for a site-level text file (security.txt, ads.txt, app-ads.txt). */
export interface SiteTextFileInfo {
  /** true = served, false = absent, undefined = network error (state unknown) */
  found: boolean | undefined;
  url?: string;
  invalidLines?: number;
}

export interface SiteTextFilesData {
  securityTxt?: SiteTextFileInfo;
  adsTxt?: SiteTextFileInfo;
  appAdsTxt?: SiteTextFileInfo;
}
