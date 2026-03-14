/**
 * Internal type definitions for the Crawler Engine
 * Shared across crawler-engine.ts, resilience.ts, page-data-builder.ts, analyzer-runner.ts
 */

import type {
  PageInfo,
  NetworkCondition,
  CpuCondition,
  SitemapUrl,
  Issue,
  ChromePage,
} from '../types';
import type { CollectedVitals } from './vitals-collector';
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
  queryParams: QueryParamConfig;
  cruxApiKey?: string | null;
  config?: Record<string, unknown>;
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
  };
  cruxData?: CrUXFieldData | null;
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
  uniqueTitles: Set<string>;
  uniqueDescriptions: Set<string>;
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
  uniqueTitles: Set<string>;
  uniqueDescriptions: Set<string>;
}

export interface CollectLinksParams {
  parsedPage: import('../types').ParsedPage;
  url: string;
  results: CrawlResults;
  incomingLinksTracking: Map<string, Set<string>>;
  collectedURLs: Set<string>;
  uniquePages: Set<string>;
  pagesToCrawl: string[];
  addMissing: boolean;
  discoveredLinksSource: Map<string, string>;
  sitemapUrls: Record<string, SitemapUrl>;
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
