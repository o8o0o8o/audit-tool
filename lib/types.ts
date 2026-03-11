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
  statusCode?: number;
  title?: string;
  description?: string;
  canonical?: string;
  redirectChain?: Array<{url: string; status: number | string; timing?: number}>;
  error?: string;
  issues?: Issue[];
  // Performance metrics
  ttfb?: number;
  lcp?: number;
  cls?: number;
  fcp?: number;
  inp?: number;
  tbt?: number;
  // Content
  wordCount?: number;
  h1?: string[];
  h2?: string[];
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
  saveData: () => void;
  checkAttempts: (url: string) => void;
  saveAttempt: (url: string) => void;
}
