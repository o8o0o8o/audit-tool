/**
 * Internal type definitions for the Crawler Engine
 * Shared across crawler-engine.ts, resilience.ts, page-data-builder.ts, analyzer-runner.ts
 */

import type { PageInfo, ParsedPage, NetworkCondition, CpuCondition, CrawlProfile, SitemapUrl, Issue, ChromePage } from '../types';
import type { CrUXFieldData } from './crux-api';
import type { BrowserContext } from 'playwright';

// ─── Crawler Engine internal interfaces ─────────────────────────────────────

export interface CrawlerInternalOptions {
  concurrency: number;
  saveHtml: boolean;
  screenshots: boolean;
  analysis: Record<string, unknown>;
  perf: boolean;
  origin: string;
  networkConditions: Record<string, NetworkCondition>;
  cpuConditions: Record<string, CpuCondition>;
  verbose: boolean;
  userAgent: string | null;
  /** Extra HTTP request headers sent on every navigation (e.g. an auth token,
   *  or Vercel's `x-vercel-protection-bypass` for auditing your own protected
   *  site). From `crawl.headers` in the config. */
  headers?: Record<string, string> | null;
  queryParams: QueryParamConfig;
  cruxApiKey?: string | null;
  config?: Record<string, unknown>;
  /** Base directory where per-page evidence (screenshots, HAR) is written. */
  evidenceDir?: string;
  /** Max number of representative-page samples (default 10). */
  evidenceCap?: number;
  /** Lead scan (`--lead`). */
  lead?: boolean;
  /** Most page loads (navigations) across all crawl passes of the run. */
  maxPages?: number | null;
  /** Called with the URL of every request sent from the crawl's browser contexts. */
  requestObserver?: (url: string) => void;
}

export interface QueryParamConfig {
  mode?: 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist';
  whitelist?: string[];
  blacklist?: string[];
}

export interface FailureTracker {
  consecutiveFailures: number;
  lastFailureTime: number;
  circuitOpen: boolean;
  circuitOpenTime: number;
  /**
   * Consecutive not-found responses (HTTP 404 or soft 404) keyed by pagination
   * series key (`…/page/{N}`, `?page=N`). Broken pagination is a per-series
   * phenomenon — a single series whose "next" links advance into nonexistent
   * pages — so the streak is counted within each series, not globally. This
   * keeps the abort precise: dead one-off URLs (e.g. stale sitemap entries)
   * never participate, and several independently-paginated sections each ending
   * with a trailing 404 can't aggregate into a false abort.
   */
  paginationNotFoundStreak: Map<string, number>;
  /** Last not-found URL recorded for a pagination series, for reporting. */
  last404Url?: string;
}

export interface BackoffState {
  attempts: number;
  lastAttempt: number;
}

export interface RequestInfo {
  resourceType?: string;
  method?: string;
  startTime?: number;
  status?: number;
  endTime?: number;
  duration?: number;
  size?: number | null;
  /** Response headers (lower-cased names); dropped when pages are checkpointed. */
  headers?: Record<string, string>;
  /** Times this URL was requested on the page. */
  count?: number;
  /** Request failed at the network level (DNS, blocked, aborted). */
  failed?: boolean;
  /** POST body of analytics hits (GA4 /g/collect batches), capped; dropped at checkpoint. */
  postData?: string;
}

export interface RedirectEntry {
  url: string;
  status: number | string;
}

export interface BasicTestResult {
  TTFB?: number;
  FCP?: number;
  LCP?: number;
  CLS?: number;
  INP?: number;
  TBT?: number;
  TTI?: number;
  speedIndex?: number;
  lcpElement?: string | null;
  lcpUrl?: string | null;
  lcpSize?: { width: number; height: number } | null;
  lcpSelector?: string | null;
  lcpRect?: { x: number; y: number; width: number; height: number } | null;
  lcpSubParts?: { ttfb: number; resourceLoad: number; resourceDelay: number; renderDelay: number };
  clsEntries?: unknown[];
  clsLargestShift?: number | null;
  clsShiftCount?: number;
  inpEvent?: string | null;
  longTasks?: unknown[];
  domContentLoaded?: number;
  domComplete?: number;
  loadEvent?: number;
  status: number | undefined;
  requests: Record<string, RequestInfo>;
  totalResponseSize: number;
  metrics: PerformanceMetrics;
  redirectChain: RedirectEntry[];
  responseHeaders: Record<string, string | undefined>;
  consoleData: unknown;
  url?: string;
  blockers?: unknown;
  /** Served HTML (pre-JS response body), when capturable. */
  servedHtml?: string;
  /**
   * Viewport screenshot taken right after the load event, before vitals
   * settle / auto-scroll / lazy hydration. Captured only for pages the
   * representative sampler is expected to pick (evidence enabled); paired with
   * the settled evidence screenshot to visualise post-load layout shifts.
   */
  firstLoadShot?: Buffer;
}

export interface PerformanceMetrics {
  nav: PerformanceEntryList;
  resources: PerformanceEntryList;
  paint: PerformanceEntryList;
}

export type PerformanceEntryList = unknown[];

export interface CrawlPagesParams {
  pagesToCrawl: string[];
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  addMissing: boolean;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
  /**
   * Canonical-key dedup set (hash + trailing-slash stripped, via
   * normalizeUrlForComparison) shared across both crawl passes. Prevents the
   * same page being crawled twice when its sitemap loc and its discovered
   * in-page link differ only by a trailing slash (e.g. `/foo` vs `/foo/`, or
   * the bare origin `https://site` vs `https://site/`). Seeded from the sitemap
   * URLs by the orchestrator; grown as discovered URLs are added.
   */
  crawlFrontierKeys: Set<string>;
}

export interface CrawlResults {
  pageData: {
    pages: Record<string, PageInfo>;
    processedPages: Set<string>;
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, string[] | number>;
    attempts: Record<string, number>;
    incomingLinks?: Record<string, string[]>;
    crawlAborted?: {
      reason: string;
      threshold: number;
      lastUrl?: string;
      /** The pagination series key whose broken streak tripped the abort. */
      series?: string;
    };
    truncatedPaginationSeries?: Record<string, number>;
  };
  cruxData?: CrUXFieldData | null;
  /** Effective throttle profile applied during the crawl — recorded so the live
   *  `--verify` pass can re-fetch under the same network/CPU conditions. */
  crawlProfile?: CrawlProfile;
}

export interface CrawlSinglePageParams {
  url: string;
  context: BrowserContext;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  /** Normalized title/description → the FIRST page that carried it, so a later
   *  duplicate can name the page it collides with (not just "this page"). */
  uniqueTitles: Map<string, string>;
  uniqueDescriptions: Map<string, string>;
  paginationSeriesCounts: Map<string, number>;
  /** See CrawlPagesParams.crawlFrontierKeys. */
  crawlFrontierKeys: Set<string>;
}

export interface ProcessPageDataParams {
  page: BasicTestResult;
  chromePage: ChromePage;
  url: string;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  sitemapUrls: Record<string, SitemapUrl & { alternates?: Record<string, { hreflang: string }> }>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  uniqueTitles: Map<string, string>;
  uniqueDescriptions: Map<string, string>;
  paginationSeriesCounts: Map<string, number>;
  /** See CrawlPagesParams.crawlFrontierKeys. */
  crawlFrontierKeys: Set<string>;
}

export interface CollectLinksParams {
  parsedPage: ParsedPage;
  url: string;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  sitemapUrls: Record<string, SitemapUrl>;
  paginationSeriesCounts: Map<string, number>;
  /** See CrawlPagesParams.crawlFrontierKeys. */
  crawlFrontierKeys: Set<string>;
}

export interface LinkEntry {
  text: string | undefined;
  href: string;
  isInternal: boolean;
}

export interface MetaTag {
  name: string | null;
  content: string;
}

export interface LinkTag {
  rel: string;
  hrefLang: string;
  href: string;
}

export interface AlternateEntry {
  hreflang: string;
  href: string;
}

export interface AnalyzerResult {
  issues?: Issue[];
  warnings?: Issue[];
  [key: string]: unknown;
}

export interface CrawlPageResult {
  isMultiLang?: boolean;
  failed: boolean;
  errorType?: string;
}

export type ReportIssueFn = (message: string, detail: string, severity: string) => void;
