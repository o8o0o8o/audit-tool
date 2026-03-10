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
  redirectChain?: string[];
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

export interface AnalysisData {
  overall: Issue[];
  details: Record<string, any>;
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
  ariaLandmarks?: string[];
  formLabels?: { labeled: number; unlabeled: number };
  [key: string]: any;
}

export interface SecurityAnalysis {
  isHttps: boolean;
  headers: Record<string, string | undefined>;
  issues: Issue[];
}

export interface StructuredDataAnalysis {
  schemas: SchemaItem[];
  issues: Issue[];
}

export interface SchemaItem {
  type: string;
  properties: Record<string, unknown>;
}

export interface SocialMediaAnalysis {
  og: Record<string, string>;
  twitter: Record<string, string>;
  issues: Issue[];
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
}

export interface InternationalAnalysis {
  hreflangTags: AlternateLink[];
  issues: Issue[];
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
