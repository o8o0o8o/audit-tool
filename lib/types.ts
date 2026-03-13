/**
 * Core type definitions for the SEO Audit Tool
 * Shared interfaces used across all modules
 */

// ─── Severity & Issues ───────────────────────────────────────────────────────

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  message?: string;
  detail?: string;
  severity: SeverityLevel;
  title?: string;
  description?: string;
}

// ─── Analyzer Results ────────────────────────────────────────────────────────

export interface AnalyzerResult {
  issues: Issue[];
  [key: string]: any;
}

export interface SiteWideAnalyzerResult {
  issues: Issue[];
  [key: string]: any;
}

// ─── Page Data ───────────────────────────────────────────────────────────────

export interface PageInfo {
  url: string;
  status?: number;
  statusCode?: number;
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
  vitals?: Record<string, any>;

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
  metrics?: Record<string, any>;
  blockers?: Record<string, any>;
  totalResponseSize?: number;
  totalNumberOfRequests?: number;
  responseHeaders?: Record<string, string>;
  response?: { headers: Record<string, string> };

  // Links
  links?: unknown;
  linksCount?: number;
  internalLinksCount?: number;
  externalLinksCount?: number;
  httpLinksCount?: number;
  incomingLinks?: unknown;
  incomingLinksCount?: number;
  hasIncomingLinks?: boolean;

  // Images
  imagesCount?: number;
  imagesWithoutAltCount?: number;

  // Meta tags
  meta?: unknown[];
  metaMap?: Record<string, string>;
  hasKeywords?: boolean;
  hasViewport?: boolean;
  alternates?: AlternateLink[];

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
  fontData?: Record<string, any>;
  compressionData?: CompressionData;
  imageOptimization?: ImageOptimizationData;
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

  // TODO: Remove this index signature once all dynamic properties are typed above
  [key: string]: any;
}

export interface PageData {
  pages: Record<string, PageInfo>;
  processedPages: string[];
  totalWithoutError: number;
  totalWithError: number;
  byError: Record<string, number>;
  attempts: Record<string, number>;
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
  h2: string[];
  h3: string[];
  h4: string[];
  h5: string[];
  h6: string[];
  issues: Issue[];
  [key: string]: any;
}

export interface ImageAnalysis {
  totalImages: number;
  withoutAlt: number;
  withEmptyAlt: number;
  decorativeImages: number;
  issues: Issue[];
  [key: string]: any;
}

export interface AccessibilityAnalysis {
  issues: Issue[];
  ariaLandmarks?: string[];
  formLabels?: { labeled: number; unlabeled: number };
  [key: string]: any;
}

export interface SecurityAnalysis {
  isHttps: boolean;
  headers: Record<string, string | undefined>;
  issues: Issue[];
  [key: string]: any;
}

export interface StructuredDataAnalysis {
  schemas: SchemaItem[];
  issues: Issue[];
  [key: string]: any;
}

export interface SchemaItem {
  type: string;
  properties: Record<string, unknown>;
}

export interface SocialMediaAnalysis {
  og: Record<string, string>;
  twitter: Record<string, string>;
  issues: Issue[];
  [key: string]: any;
}

export interface PerformanceAnalysis {
  totalSize?: number;
  requestCount?: number;
  renderBlockingResources?: number;
  issues: Issue[];
  [key: string]: any;
}

export interface ContentQualityAnalysis {
  wordCount: number;
  readabilityScore?: number;
  textToHtmlRatio?: number;
  keywordDensity?: Record<string, number>;
  issues: Issue[];
  [key: string]: any;
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
  [key: string]: any;
}

export interface InternationalAnalysis {
  hreflangTags: AlternateLink[];
  issues: Issue[];
  [key: string]: any;
}

export interface UrlAnalysis {
  length: number;
  depth: number;
  hasUppercase: boolean;
  hasUnderscores: boolean;
  hasSpaces: boolean;
  hasSpecialChars: boolean;
  hasQueryParams: boolean;
  queryParamCount: number;
  isHttps: boolean;
  issues: Issue[];
  [key: string]: any;
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
  [key: string]: any;
}

export interface Soft404Data {
  isSoft404: boolean;
  confidence: number;
  signals: string[];
  [key: string]: any;
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
  byCategory?: Record<string, { count: number; size: number; time: number; hosts: string[] }>;
  blockingScripts?: { src: string; host: string }[];
  count?: number;
  [key: string]: any;
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
  [key: string]: any;
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
  [key: string]: any;
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
  [key: string]: any;
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
  issues?: Issue[];
  [key: string]: any;
}

export interface ConsoleAnalysisData {
  errorCount?: number;
  criticalErrorCount?: number;
  warningCount?: number;
  errors?: { text: string; type: string; url: string; isCritical: boolean }[];
  hasErrors?: boolean;
  hasCriticalErrors?: boolean;
  [key: string]: any;
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
  [key: string]: any;
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
  issues?: Issue[];
  [key: string]: any;
}

export interface CachingData {
  hasCDN?: boolean;
  cdnProvider?: string | null;
  htmlCacheable?: boolean;
  staticCached?: number;
  staticUncached?: number;
  hasServiceWorker?: boolean;
  cacheScore?: number | null;
  issues?: string[];
  [key: string]: any;
}

export interface MediaData {
  videos?: Record<string, any>[];
  audios?: { src: string | null; hasTitle: boolean; hasTranscript: boolean }[];
  hasVideoSchema?: boolean;
  videoSchemaValid?: boolean;
  totalVideos?: number;
  totalAudios?: number;
  embeddedVideos: {
    type: 'embedded';
    platform: string;
    src: string;
    hasTitle: boolean;
    title: string | null;
    hasCaption: boolean;
  }[];
  nativeVideos: {
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
  videosWithoutCaptions: number;
  videosWithoutPoster: number;
  videosWithoutTitle: number;
  videoSchemaIssues?: string[];
  [key: string]: any;
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
  [key: string]: any;
}

export interface AboveFoldData {
  viewport?: { width: number; height: number };
  hasContentAboveFold?: boolean;
  aboveFoldElements?: {
    headings: { tag: string; text: string }[];
    images: { src: string; size: number; loading: string; fetchPriority: string }[];
    text: Record<string, any>[];
    cta: { text: string; type: string }[];
  };
  criticalResources?: { url: string; type: string; size: number }[];
  lcpInViewport?: boolean;
  renderBlockingResources?: number;
  aboveFoldImageSize?: number;
  estimatedFoldPosition?: null;
  [key: string]: any;
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
  [key: string]: any;
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
  [key: string]: any;
}

export interface RedirectAnalysisData {
  redirectCount: number;
  redirectChain: { url: string; status: number; timing?: number }[];
  finalUrl: string;
  hasHttpToHttps: boolean;
  hasWwwRedirect: boolean;
  totalRedirectTime: number;
  [key: string]: any;
}

export interface ResourceHintsData {
  preload: Record<string, any>[];
  prefetch: Record<string, any>[];
  preconnect: Record<string, any>[];
  dnsPrefetch: Record<string, any>[];
  modulePreload: Record<string, any>[];
  missingHints: { url: string; type: string; reason: string }[];
  unnecessaryHints: { url: string; type: string; reason: string }[];
  [key: string]: any;
}

export interface MixedContentData {
  isHttps: boolean;
  activeMixedContent: { url: string; type: string; blocked: boolean }[];
  passiveMixedContent: { url: string; type: string; blocked: boolean }[];
  totalMixedResources: number;
  blockedResources: number;
  htmlMixedContent?: { type: string; url: string }[];
  [key: string]: any;
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
  [key: string]: any;
}

export interface PwaData {
  hasManifest: boolean;
  manifestUrl: string | null;
  manifestValid: boolean;
  manifestFields: Record<string, any> | string[];
  hasServiceWorker: boolean;
  serviceWorkerScope: string | null;
  isInstallable: boolean;
  installabilityIssues: string[];
  hasThemeColor: boolean;
  hasAppleTouchIcon: boolean;
  httpsRequired: boolean;
  offlineCapable: boolean;
  [key: string]: any;
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
  [key: string]: any;
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
  [key: string]: any;
}

export interface OutboundLinkHealthData {
  totalChecked: number;
  broken: { url: string; status: number }[];
  redirected: { url: string; redirectTo: string; status: number }[];
  timeouts: string[];
  healthy: number;
  [key: string]: any;
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
  [key: string]: any;
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
  [key: string]: any;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface CategoryScores {
  seo: number;
  performance: number;
  accessibility: number;
  security: number;
  technical: number;
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
  quickWins: QuickWin[];
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

export interface AuditConfig {
  origin?: string;
  sitemap?: string;
  compareSitemap?: string;
  proceed?: boolean;
  perf?: boolean;
  saveHtml?: boolean;
  screenshots?: boolean;
  concurrency?: number;
  preset?: 'quick' | 'standard' | 'deep';
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
export type ParsedPage = import('node-html-parser').HTMLElement;

/** Playwright Page - used as chromePage parameter */
export type ChromePage = import('playwright').Page;

/** Playwright Response - used as response parameter */
export type ChromeResponse = import('playwright').Response;

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
  [key: string]: any;
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

export interface QuickWinFull extends QuickWin {
  severity?: string;
  effortMinutes?: number;
  impactScore?: number;
  fix?: string;
  example?: string;
  examples?: string[];
  resources?: Array<{ text: string; url: string }>;
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
  onlyErrors: boolean;
  dryRun: boolean;
  generateCi: boolean;
  validateConfig: boolean;
  webhook: string | null;
  version: boolean;
  help: boolean;
  open: boolean;
  verbose: boolean;
  quiet: boolean;
  preset: 'quick' | 'standard' | 'deep' | null;
  sites: string | null;
  slack: string | null;
  watch: number | null;
  brandLogo: string | null;
  brandName: string | null;
  ci: number | null;
  json: boolean;
  warnings: string[];
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
}

export interface CrawlerCallbacks {
  saveError: (generalError: string, detailedError: string, severity?: string) => void;
  saveData: () => void | Promise<void>;
  checkAttempts: (url: string) => void;
  saveAttempt: (url: string) => void;
}
