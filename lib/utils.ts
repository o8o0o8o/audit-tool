/**
 * Utility Functions
 * Common helper functions used throughout the audit tool
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { THRESHOLDS, SEVERITY } from './constants';
import type { UrlAnalysis } from './types';
// Import core URL validation from validators.js for consistency
import { validateURL as coreValidateURL } from '../validators';

// Tracking parameters to always strip (marketing, analytics, session)
const TRACKING_PARAMS = new Set([
  // Google Analytics / Ads
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  // Facebook
  'fbclid',
  'fb_action_ids',
  'fb_action_types',
  'fb_source',
  'fb_ref',
  // Microsoft/Bing
  'msclkid',
  // Other common tracking
  'mc_cid',
  'mc_eid',
  'oly_enc_id',
  'oly_anon_id',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'vero_id',
  'vero_conv',
  'nr_email_referer',
  'mkt_tok',
  'trk',
  'trkCampaign',
  'trkInfo',
  'si',
  'igshid',
  '__twitter_impression',
  's_kwcid',
  'ef_id',
  // Session/misc
  'ref',
  'referrer',
  'source',
  'sessionid',
  'sid',
  'phpsessid',
  'jsessionid',
  'aspsessionid',
  '_ga',
  '_gl',
  '_ke',
]);

interface NormalizeUrlOptions {
  mode?: 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist';
  whitelist?: string[];
  blacklist?: string[];
}

/**
 * Normalize URL by handling query parameters
 */
function normalizeUrl(urlString: string, options: NormalizeUrlOptions = {}): string {
  if (!urlString) return urlString;

  const { mode = 'strip_tracking', whitelist = [], blacklist = [] } = options;

  try {
    const url = new URL(urlString);
    url.hash = '';

    if (mode === 'keep_all') {
      return url.href;
    }

    if (mode === 'strip_all') {
      url.search = '';
      return url.href;
    }

    const paramsToRemove: string[] = [];
    const blacklistSet = new Set(blacklist.map((p) => p.toLowerCase()));
    const whitelistSet = mode === 'whitelist' ? new Set(whitelist.map((p) => p.toLowerCase())) : null;

    for (const [key] of url.searchParams) {
      const keyLower = key.toLowerCase();

      if (mode === 'whitelist') {
        if (!whitelistSet?.has(keyLower)) {
          paramsToRemove.push(key);
        }
      } else {
        if (TRACKING_PARAMS.has(keyLower) || blacklistSet.has(keyLower)) {
          paramsToRemove.push(key);
        }
      }
    }

    for (const key of paramsToRemove) {
      url.searchParams.delete(key);
    }

    url.searchParams.sort();
    return url.href;
  } catch {
    return urlString;
  }
}

/**
 * Strip hash fragment from URL
 */
function stripHashFragment(urlString: string): string {
  if (!urlString) return urlString;

  try {
    const url = new URL(urlString);
    url.hash = '';
    return url.href;
  } catch {
    const hashIndex = urlString.indexOf('#');
    if (hashIndex !== -1) {
      return urlString.substring(0, hashIndex);
    }
    return urlString;
  }
}

/**
 * Validate URL with comprehensive checks
 * Uses core validation from validators.js and adds additional security checks.
 *
 * Note: This function throws on error (for internal use).
 * For CLI validation with error objects, use validateURL from validators.js instead.
 */
function validateUrl(urlString: string): string {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required and must be a string');
  }

  const MAX_URL_LENGTH = 8192;
  if (urlString.length > MAX_URL_LENGTH) {
    throw new Error(`URL is too long (${urlString.length} chars, max ${MAX_URL_LENGTH})`);
  }

  const coreResult = coreValidateURL(urlString);
  if (!coreResult.valid) {
    throw new Error(coreResult.error);
  }

  const url: URL = coreResult.url as URL; // Guaranteed non-null after valid check above
  const hostname = url.hostname;

  if (hostname.length === 0 || hostname.length > 253) {
    throw new Error('Invalid hostname length');
  }

  if (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
    throw new Error('Invalid hostname format');
  }

  const labels = hostname.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new Error(`Invalid hostname label length: "${label}"`);
    }

    const isAscii = /^[a-zA-Z0-9-]+$/.test(label);
    const hasValidNonAscii = !isAscii && /^[\p{L}\p{N}-]+$/u.test(label);

    if (!isAscii && !hasValidNonAscii) {
      throw new Error(`Invalid characters in hostname label: "${label}"`);
    }

    if (label.startsWith('-') || label.endsWith('-')) {
      throw new Error(`Hostname label cannot start or end with hyphen: "${label}"`);
    }
  }

  const MAX_QUERY_PARAMS = 100;
  if (url.searchParams.size > MAX_QUERY_PARAMS) {
    throw new Error(`Too many query parameters (${url.searchParams.size}, max ${MAX_QUERY_PARAMS})`);
  }

  return url.href;
}

/**
 * Create safe filename from URL
 */
function createSafeFilename(url: string): string {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  const sanitized = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 50);
  return `${sanitized}_${hash}`;
}

/**
 * Analyze URL structure for SEO issues
 */
function analyzeUrlStructure(urlString: string, origin: string): UrlAnalysis {
  const analysis: UrlAnalysis = {
    length: 0,
    depth: 0,
    hasUppercase: false,
    hasUnderscores: false,
    hasSpaces: false,
    hasSpecialChars: false,
    hasQueryParams: false,
    queryParamCount: 0,
    isHttps: false,
    issues: [],
  };

  const MAX_ANALYSIS_URL_LENGTH = 2000;
  if (!urlString || urlString.length > MAX_ANALYSIS_URL_LENGTH) {
    analysis.issues.push({
      severity: SEVERITY.HIGH,
      message: urlString
        ? `URL too long for analysis (${urlString.length} chars, max ${MAX_ANALYSIS_URL_LENGTH})`
        : 'URL is empty or undefined',
    });
    return analysis;
  }

  try {
    const url = new URL(urlString);

    const pathAndQuery = url.pathname + url.search;
    analysis.length = pathAndQuery.length;
    analysis.isHttps = url.protocol === 'https:';

    const pathSegments = getPathSegments(url.pathname);
    analysis.depth = pathSegments.length;

    analysis.hasUppercase = /[A-Z]/.test(url.pathname);
    analysis.hasUnderscores = url.pathname.includes('_');
    analysis.hasSpaces = url.pathname.includes(' ') || url.pathname.includes('%20');

    const specialCharsPattern = /[^a-zA-Z0-9\-_\/\.]/;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      decodedPath = url.pathname;
    }
    analysis.hasSpecialChars = specialCharsPattern.test(decodedPath);

    analysis.hasQueryParams = url.search.length > 0;
    if (analysis.hasQueryParams) {
      analysis.queryParamCount = url.searchParams.size;
    }

    if (analysis.length > THRESHOLDS.URL_LENGTH_MAX) {
      analysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `URL is too long (${analysis.length} chars, max recommended: ${THRESHOLDS.URL_LENGTH_MAX})`,
      });
    } else if (analysis.length > THRESHOLDS.URL_LENGTH_RECOMMENDED) {
      analysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `URL is longer than recommended (${analysis.length} chars, recommended: ${THRESHOLDS.URL_LENGTH_RECOMMENDED})`,
      });
    }

    if (analysis.depth > THRESHOLDS.URL_DEPTH_MAX) {
      analysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `URL is too deep (${analysis.depth} levels, max recommended: ${THRESHOLDS.URL_DEPTH_MAX})`,
      });
    }

    if (analysis.hasUppercase) {
      analysis.issues.push({
        severity: SEVERITY.LOW,
        message: 'URL contains uppercase letters (lowercase is recommended)',
      });
    }

    if (analysis.hasUnderscores) {
      analysis.issues.push({
        severity: SEVERITY.LOW,
        message: 'URL contains underscores (hyphens are preferred for SEO)',
      });
    }

    if (analysis.hasSpaces) {
      analysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: 'URL contains spaces or %20 encoding',
      });
    }

    if (analysis.hasSpecialChars) {
      analysis.issues.push({
        severity: SEVERITY.LOW,
        message: 'URL contains special characters',
      });
    }

    if (!analysis.isHttps && origin.startsWith('https://')) {
      analysis.issues.push({
        severity: SEVERITY.HIGH,
        message: 'URL uses HTTP instead of HTTPS',
      });
    }
  } catch (error) {
    analysis.issues.push({
      severity: SEVERITY.HIGH,
      message: `Invalid URL format: ${(error as Error).message}`,
    });
  }

  return analysis;
}

/**
 * Format elapsed time in human-readable format
 */
function formatElapsedTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    const remainingSeconds = seconds % 60;
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Log levels with consistent prefixes
 */
const LOG_PREFIX: Record<string, string> = {
  ERROR: '\u274C',
  WARNING: '\u26A0\uFE0F',
  SUCCESS: '\u2713',
  INFO: '\uD83D\uDCCA',
  FILE: '\uD83D\uDCC1',
  SAVE: '\uD83D\uDCBE',
  LOAD: '\uD83D\uDCC4',
};

/**
 * Format a log message with consistent prefix
 */
function formatLogMessage(level: string, message: string): string {
  const prefix = LOG_PREFIX[level] || '';
  return prefix ? `${prefix} ${message}` : message;
}

/**
 * Format an error message consistently
 */
function formatErrorMessage(context: string, message: string): string {
  return `${LOG_PREFIX.ERROR} ${context}: ${message}`;
}

/**
 * Format a warning message consistently
 */
function formatWarningMessage(message: string): string {
  return `${LOG_PREFIX.WARNING} ${message}`;
}

/**
 * Generate timestamp string for folder names and IDs
 */
function generateTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Format bytes to human-readable size string
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Calculate difference in days between two dates
 */
function calculateDaysDiff(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Check if a link is internal (same origin)
 * Returns true for same-origin URLs, relative paths, and hash-only links.
 * Note: Returns true for empty/non-navigational hrefs (hash, javascript:, mailto:, tel:).
 */
function isInternalLink(href: string, origin: string): boolean {
  if (!href) return true;
  if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return true;
  }

  try {
    const linkOrigin = new URL(href, origin).origin;
    return linkOrigin === origin;
  } catch {
    return href.startsWith('/');
  }
}

/**
 * Strip "www." prefix from a hostname/domain.
 */
function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, '');
}

/**
 * Check if two URLs belong to the same domain (ignoring www prefix).
 */
function isSameDomain(url1: string, url2: string): boolean {
  const host1 = getHostname(url1);
  const host2 = getHostname(url2);
  if (!host1 || !host2) return false;
  return stripWww(host1) === stripWww(host2);
}

/**
 * Check if a request hostname is first-party relative to the origin hostname.
 * Returns true if the hosts are the same or one is a subdomain of the other.
 */
function isFirstPartyHost(reqHost: string, originHost: string): boolean {
  return reqHost === originHost || reqHost.endsWith('.' + originHost) || originHost.endsWith('.' + reqHost);
}

/**
 * Get origin from a URL string
 */
function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Safely extract hostname from a URL string.
 * Returns empty string on invalid URLs.
 */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Remove trailing slash from a path, preserving root '/'.
 */
function removeTrailingSlash(path: string): string {
  return path === '/' ? '/' : path.replace(/\/$/, '');
}

/**
 * Split a URL pathname into non-empty segments.
 * E.g. '/a/b/c/' -> ['a', 'b', 'c']
 */
function getPathSegments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Statistical helper: average of a numeric array
 */
function statAvg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/**
 * Statistical helper: percentile of a sorted numeric array
 * Assumes the array is already sorted ascending.
 */
function statPercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  return sortedArr[Math.floor(sortedArr.length * p)];
}

/**
 * Get letter grade from score (0-100)
 */
function getLetterGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Normalize URL for comparison purposes (strips hash fragment and trailing slash)
 */
function normalizeUrlForComparison(urlString: string): string {
  return urlString.split('#')[0].replace(/\/$/, '');
}

/**
 * Case-insensitive HTTP header lookup.
 * Playwright normalizes headers to lowercase, but external sources may not.
 */
function getHeader(headers: Record<string, string>, key: string): string | undefined {
  return headers[key.toLowerCase()] ?? headers[key] ?? undefined;
}

/**
 * Parse JSON-LD schemas from a parsed HTML page.
 * Returns an array of parsed schema objects. Invalid JSON-LD blocks are skipped.
 */
function parseJsonLdSchemas(parsedPage: { querySelectorAll(selector: string): { textContent: string }[] }): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];
  const scripts = parsedPage.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        schemas.push(item);
        // Also expand @graph items
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          for (const graphItem of item['@graph']) {
            schemas.push(graphItem);
          }
        }
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  }
  return schemas;
}

/**
 * Calculate predicted score after fixing all critical+high issues.
 * Returns null if no improvement is possible.
 */
function estimateScoreAfterFixes(
  overallScore: number,
  categoryScores: Record<string, number>,
  categoryWeights: Record<string, number>,
): number | null {
  let potentialGain = 0;
  for (const [cat, w] of Object.entries(categoryWeights)) {
    const headroom = 100 - (categoryScores[cat] || 100);
    potentialGain += headroom * 0.6 * w;
  }
  const predicted = Math.min(100, Math.round(overallScore + potentialGain));
  return predicted > overallScore ? predicted : null;
}

/**
 * Escape HTML to prevent XSS.
 * Handles null/undefined by returning empty string.
 */
function escapeHtml(unsafe: unknown): string {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format a list of URLs as HTML <li> elements with links.
 * Escapes HTML to prevent XSS. Optionally limits the number of items shown.
 */
function formatUrlList(urls: string[], maxItems?: number): string {
  const items = maxItems ? urls.slice(0, maxItems) : urls;
  return items
    .map((u) => {
      const escaped = escapeHtml(u);
      return `<li><a href="${escaped}">${escaped}</a></li>`;
    })
    .join('');
}

/**
 * Fetch a URL with an automatic timeout using AbortController.
 * Returns the fetch Response. Throws on timeout or network error.
 */
async function fetchWithTimeout(
  url: string,
  timeout: number,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a fetch Response body as text, aborting once `maxBytes` of DECOMPRESSED
 * data have been read. `fetch()` gunzips transparently, so a few-KB gzipped
 * response can expand to gigabytes — reading via the stream and cancelling past
 * the cap prevents an out-of-memory crash (zip-bomb / unbounded response DoS).
 */
async function readResponseTextCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    // No readable stream (e.g. a mocked Response) — bound the decoded length.
    const t = await response.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        total += value.length;
        if (total >= maxBytes) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8').slice(0, maxBytes);
}

/**
 * Calculate a percentage, returning 0 when total is 0.
 * Result is rounded to the nearest integer.
 */
function calcPercent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/**
 * Increment a counter in a Map. Equivalent to `map.set(key, (map.get(key) ?? 0) + amount)`.
 */
function incrementCounter<K>(map: Map<K, number>, key: K, amount: number = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/**
 * Get the top N entries from an iterable of [key, value] pairs, sorted by value descending.
 */
function getTopEntries<K>(entries: Iterable<[K, number]>, n: number): [K, number][] {
  return Array.from(entries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/**
 * Shorten a URL to its pathname for display, truncating if too long.
 */
function shortenUrl(url: string, maxLength = 50): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.length > maxLength) {
      return '...' + path.slice(-(maxLength - 3));
    }
    return path || '/';
  } catch {
    return url.slice(-maxLength);
  }
}

/**
 * Extract the filename from a URL path.
 * Returns the last path segment, or a truncated fallback on invalid URLs.
 */
function getFileNameFromUrl(url: string, maxLength = 50): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('/').pop() ?? pathname.substring(0, maxLength);
  } catch {
    return url?.substring(0, maxLength) ?? 'unknown';
  }
}

/**
 * Extract meta tag values from a parsed HTML page.
 * @param parsedPage - Parsed HTML page with querySelector
 * @param selectorAttr - The meta attribute to query by ('property' for OG, 'name' for Twitter)
 * @param tags - Object with tag names as keys, values will be populated
 * @returns The number of tags found
 */
function extractMetaTags(
  parsedPage: { querySelector(selector: string): { getAttribute(name: string): string | undefined | null } | null },
  selectorAttr: string,
  tags: Record<string, string | null>,
): number {
  let found = 0;
  for (const key in tags) {
    const tag = parsedPage.querySelector(`meta[${selectorAttr}="${key}"]`);
    if (tag) {
      tags[key] = tag.getAttribute('content') ?? null;
      found++;
    }
  }
  return found;
}

/**
 * Strip the severity suffix (e.g. " [critical]") from an issue string.
 */
function stripIssueSeverity(issue: string): string {
  return issue.replace(/\s*\[(critical|high|medium|low)\]\s*$/i, '');
}

/**
 * Clamp a score to the 0-100 range.
 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Truncate a string to maxLength, appending '...' if truncated.
 */
function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text ?? '';
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Check if a robots directive string contains a specific directive (case-insensitive).
 * Works for both meta robots content and X-Robots-Tag header values.
 */
function hasRobotsDirective(directiveString: string, directive: string): boolean {
  return directiveString.toLowerCase().includes(directive.toLowerCase());
}

/**
 * Count words in a text string.
 */
function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Check if a URL is a non-content page (cart, login, search, etc.).
 * These pages are excluded from content quality checks.
 */
function isNonContentPage(url: string): boolean {
  const nonContentPatterns = [
    /\/(cart|checkout|basket|login|register|account|search|404|error)/i,
    /\/(tag|category|archive|author)\/[^/]+\/?$/i,
    /\?(s|q|query|search)=/i,
    /\/page\/\d+\/?$/i,
    /\/(home|index)\/?$/i,
  ];

  if (nonContentPatterns.some((pattern) => pattern.test(url))) return true;

  // Exclude homepage
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    if (path === '') return true;
  } catch {
    /* ignore */
  }

  return false;
}

/**
 * Detect important page links (about, contact, privacy, terms, etc.)
 * from parsed HTML. Used by E-E-A-T, cookie consent, and analytics analyzers.
 */
function detectImportantPageLinks(parsedPage: { querySelectorAll(selector: string): { getAttribute(name: string): string | undefined | null; textContent: string }[]; text?: string }) {
  const links = parsedPage.querySelectorAll('a');
  const result = {
    hasAboutPage: false,
    hasContactInfo: false,
    hasPrivacyPolicy: false,
    hasTermsOfService: false,
    hasCookiePolicy: false,
    hasAccessibilityStatement: false,
    hasImpressum: false,
  };

  for (const link of links) {
    const href = (link.getAttribute('href') ?? '').toLowerCase();
    const text = (link.textContent || '').toLowerCase();

    if (/about|who.we.are|our.team|our.story/i.test(href) || /about|who we are/i.test(text)) {
      result.hasAboutPage = true;
    }
    if (/contact|get.in.touch/i.test(href) || /contact/i.test(text)) {
      result.hasContactInfo = true;
    }
    if (/privacy/i.test(href) || /privacy/i.test(text)) {
      result.hasPrivacyPolicy = true;
    }
    if (/terms|tos|conditions/i.test(href) || /terms/i.test(text)) {
      result.hasTermsOfService = true;
    }
    if (/cookie.policy|cookie-policy|cookies$/i.test(href) || /cookie policy/i.test(text)) {
      result.hasCookiePolicy = true;
    }
    if (/accessibility/i.test(href) || /accessibility statement|accessibility/i.test(text)) {
      result.hasAccessibilityStatement = true;
    }
    if (/impressum|imprint|legal.notice|legal-notice/i.test(href) || /impressum|imprint|legal notice/i.test(text)) {
      result.hasImpressum = true;
    }
  }

  // Also check for contact info in content
  const bodyText = parsedPage.text || '';
  if (/\b[\w.-]+@[\w.-]+\.\w{2,}\b/.test(bodyText)) {
    result.hasContactInfo = true;
  }
  if (/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(bodyText)) {
    result.hasContactInfo = true;
  }

  return result;
}

/**
 * Detect author information from a parsed HTML page.
 * Checks JSON-LD schemas, meta tags, and common CSS selectors.
 */
function detectAuthorInfo(parsedPage: { querySelector(selector: string): { getAttribute(name: string): string | undefined | null; textContent: string } | null; querySelectorAll(selector: string): { textContent: string }[]; text?: string }) {
  const result: { author: string | null; credentials: string[] } = { author: null, credentials: [] };

  // Check schema.org author
  const schemas = parseJsonLdSchemas(parsedPage);
  for (const schema of schemas) {
    if (schema.author) {
      const authorObj = schema.author as Record<string, unknown>;
      const author = typeof schema.author === 'string' ? schema.author : (authorObj.name as string);
      if (author) {
        result.author = author;
        if (authorObj.jobTitle) {
          result.credentials.push(authorObj.jobTitle as string);
        }
        if (authorObj.description) {
          result.credentials.push(authorObj.description as string);
        }
      }
    }
  }

  // Check meta author
  if (!result.author) {
    const metaAuthor = parsedPage.querySelector('meta[name="author"]');
    if (metaAuthor) {
      result.author = metaAuthor.getAttribute('content') ?? null;
    }
  }

  // Check common author patterns in HTML
  if (!result.author) {
    const authorSelectors = [
      '[rel="author"]',
      '.author-name',
      '.author',
      '.byline',
      '[itemprop="author"]',
      '.post-author',
      '.article-author',
      '.entry-author',
    ];

    for (const selector of authorSelectors) {
      const el = parsedPage.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        if (text && text.length < 100) {
          result.author = text.replace(/^by\s+/i, '');
          break;
        }
      }
    }
  }

  // Look for credentials near author
  if (result.author) {
    const credentialPatterns = [
      /\b(MD|PhD|Dr\.|M\.D\.|DO|JD|MBA|CPA|CFP|RN|LCSW)\b/gi,
      /\b(certified|licensed|registered|board-certified)\s+\w+/gi,
      /\b(\d+)\+?\s*years?\s*(of)?\s*experience/gi,
    ];

    const bodyText = parsedPage.text || '';
    for (const pattern of credentialPatterns) {
      const matches = bodyText.match(pattern);
      if (matches) {
        result.credentials.push(...matches.slice(0, 3));
      }
    }
  }

  return result;
}

/**
 * Calculate Jaccard similarity between two sets.
 * Returns a value between 0 (completely different) and 1 (identical).
 * Uses an optimized loop over the smaller set.
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detect lazy loading implementation from a parsed HTML page.
 * Returns info about native or library-based lazy loading, or null if none found.
 */
function detectLazyLoading(parsedPage: { querySelectorAll(selector: string): unknown[]; toString(): string }): { type: string; count?: number; pattern?: string } | null {
  // Check for native lazy loading
  const lazyImages = parsedPage.querySelectorAll('img[loading="lazy"]');
  if (lazyImages.length > 0) {
    return { type: 'native', count: lazyImages.length };
  }

  // Check for common lazy loading libraries
  const html = parsedPage.toString();
  if (html.includes('data-src') || html.includes('data-lazy')) {
    return { type: 'library', pattern: 'data-src' };
  }
  if (html.includes('lazyload') || html.includes('lazy-load')) {
    return { type: 'library', pattern: 'class-based' };
  }

  return null;
}

/**
 * Count lazy loading patterns in raw HTML string (for JS rendering comparison).
 */
function countLazyLoadingPatterns(html: string): string[] {
  const lazyPatterns = [/loading=["']lazy["']/gi, /data-src=/gi, /data-lazy/gi, /lazyload/gi, /lazy-load/gi];

  const matches: string[] = [];
  for (const pattern of lazyPatterns) {
    const found = html.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }

  return matches;
}

/**
 * Read a gzip-compressed JSON file and parse it.
 */
function readCompressedJson<T = unknown>(filePath: string): T {
  const compressed = fs.readFileSync(filePath);
  return JSON.parse(zlib.gunzipSync(compressed).toString('utf-8')) as T;
}

/**
 * Write data as gzip-compressed JSON.
 */
function writeCompressedJson(filePath: string, data: unknown): void {
  const jsonString = JSON.stringify(data);
  fs.writeFileSync(filePath, zlib.gzipSync(jsonString));
}

/**
 * Get the platform-specific command for opening a file/URL in the default browser.
 */
function getOpenCommand(): string {
  return process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
}

// JS framework and CMS detection functions have been consolidated into
// TechnologyDetector.quickDetectFramework() and TechnologyDetector.quickDetectCMS()
// in lib/analyzers/seo/technology-detector.ts

/**
 * Check for server-side rendering indicators in a parsed page.
 */
function hasSSRIndicators(parsedPage: { querySelector(selector: string): { textContent: string } | null; toString(): string }): boolean {
  const mainContent = parsedPage.querySelector('main, article, .content, #content');
  if (mainContent) {
    const text = mainContent.textContent.trim();
    if (text.length > 100) return true;
  }

  const html = parsedPage.toString();
  return html.includes('__NEXT_DATA__') || html.includes('__NUXT__');
}

/**
 * Get the number of incoming links for a URL from an incoming links record.
 * Handles both array and number formats.
 */
function getIncomingLinkCount(incomingLinks: Record<string, unknown>, url: string): number {
  const incoming = incomingLinks[url];
  if (Array.isArray(incoming)) return incoming.length;
  if (typeof incoming === 'number') return incoming;
  return 0;
}

/**
 * Convert a Map or plain object to an array of [key, value] entries.
 * Handles the Map/Object ambiguity that occurs after JSON serialization/restoration.
 */
function normalizeToEntries<V>(data: Map<string, V> | Record<string, V> | null | undefined): [string, V][] {
  if (data instanceof Map) return Array.from(data.entries());
  if (!data) return [];
  return Object.entries(data) as [string, V][];
}

/**
 * Format a sample list showing first N items with a "and X more" suffix.
 */
// Pagination URL patterns (captures the page-number portion as group 2 for replacement).
// Deliberately excludes bare /\d+/$ — too ambiguous with article/product IDs and dates.
const PAGINATION_SERIES_PATTERNS: ReadonlyArray<{ regex: RegExp; sub: string }> = [
  { regex: /([?&]page=)(\d+)/i, sub: '$1{N}' },
  { regex: /([?&]p=)(\d+)/i, sub: '$1{N}' },
  { regex: /([?&]paged=)(\d+)/i, sub: '$1{N}' },
  { regex: /([?&]offset=)(\d+)/i, sub: '$1{N}' },
  { regex: /(\/page\/)(\d+)/i, sub: '$1{N}' },
  { regex: /(\/p\/)(\d+)/i, sub: '$1{N}' },
  { regex: /(-page-)(\d+)/i, sub: '$1{N}' },
  { regex: /(_page_)(\d+)/i, sub: '$1{N}' },
];

/**
 * If `url` looks like a paginated URL, return a canonical "series key" with
 * the page number replaced by `{N}` (so all pages in the same series share a
 * key). Otherwise return null.
 *
 * Examples:
 *   /insights/page/100              → /insights/page/{N}
 *   /insights/page/100?postType=x   → /insights/page/{N}?postType=x
 *   /list?page=5&sort=asc           → /list?page={N}&sort=asc
 */
function getPaginationSeriesKey(url: string): string | null {
  for (const { regex, sub } of PAGINATION_SERIES_PATTERNS) {
    if (regex.test(url)) {
      return url.replace(regex, sub);
    }
  }
  return null;
}

/**
 * If `url` looks like a paginated URL, return its page number (the `{N}` part
 * captured by the series patterns). Otherwise return null. Used to order pages
 * within a single series when detecting a broken pagination tail.
 *
 * Examples:
 *   /insights/page/100   → 100
 *   /list?page=5&sort=a  → 5
 *   /products            → null
 */
function getPaginationPageNumber(url: string): number | null {
  for (const { regex } of PAGINATION_SERIES_PATTERNS) {
    const match = url.match(regex);
    if (match) {
      const n = parseInt(match[2], 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function formatSampleList(items: string[], limit = 5, separator = ', '): string {
  const shown = items.slice(0, limit).join(separator);
  const remaining = items.length - limit;
  return remaining > 0 ? `${shown}${separator}and ${remaining} more` : shown;
}

const BYTE_UNIT_SCALE: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/**
 * Extract the numeric severity metric an analyzer embedded in an example /
 * affected-page string, so lists can be ordered worst-first. Examples state the
 * measured value in prose — before the URL ("This page has 48 requests …") or
 * after it ("… loads 7.1 MB from third parties", "… 96% of CSS is unused",
 * "… Total Blocking Time 3273ms"). URLs and HTML are stripped first so digits
 * inside paths/hrefs (e.g. "/5-year-anniversary/") can't masquerade as the
 * metric; then the first number is read. A byte unit (B/KB/MB/GB/TB) is
 * normalised to bytes so "512 KB" sorts below "7.7 MB"; other units (ms, %,
 * counts) are unit-consistent within a single finding, so the raw number is
 * directly comparable. Returns -Infinity when no metric is present (bare-URL
 * examples), so they sort last.
 */
function exampleMetric(ex: string): number {
  const text = ex.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?/i);
  if (!match) return -Infinity;
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return -Infinity;
  const unit = match[2]?.toUpperCase();
  return unit && BYTE_UNIT_SCALE[unit] ? value * BYTE_UNIT_SCALE[unit] : value;
}

/**
 * Comparator that orders example strings worst-first: the higher embedded
 * metric leads, with a lexicographic tiebreak so equal-metric (and metric-less)
 * examples keep a stable order independent of the concurrent crawl-completion
 * order they were collected in. This keeps the report deterministic — same
 * crawl data → identical report — see docs/report-rules.md.
 */
function compareExamplesWorstFirst(a: string, b: string): number {
  const ma = exampleMetric(a);
  const mb = exampleMetric(b);
  if (ma !== mb) return mb > ma ? 1 : -1;
  return a.localeCompare(b);
}

export {
  normalizeUrl,
  stripHashFragment,
  validateUrl,
  createSafeFilename,
  analyzeUrlStructure,
  formatElapsedTime,
  formatLogMessage,
  formatErrorMessage,
  formatWarningMessage,
  generateTimestamp,
  formatBytes,
  calculateDaysDiff,
  isInternalLink,
  getOrigin,
  statAvg,
  statPercentile,
  getLetterGrade,
  normalizeUrlForComparison,
  getHeader,
  parseJsonLdSchemas,
  estimateScoreAfterFixes,
  formatUrlList,
  shortenUrl,
  escapeHtml,
  fetchWithTimeout,
  readResponseTextCapped,
  calcPercent,
  incrementCounter,
  getTopEntries,
  extractMetaTags,
  truncateText,
  hasRobotsDirective,
  getFileNameFromUrl,
  isSameDomain,
  isFirstPartyHost,
  getHostname,
  removeTrailingSlash,
  getPathSegments,
  clampScore,
  countWords,
  isNonContentPage,
  detectImportantPageLinks,
  detectAuthorInfo,
  detectLazyLoading,
  countLazyLoadingPatterns,
  hasSSRIndicators,
  getOpenCommand,
  jaccardSimilarity,
  readCompressedJson,
  stripIssueSeverity,
  stripWww,
  writeCompressedJson,
  getIncomingLinkCount,
  normalizeToEntries,
  formatSampleList,
  exampleMetric,
  compareExamplesWorstFirst,
  getPaginationSeriesKey,
  getPaginationPageNumber,
  LOG_PREFIX,
  TRACKING_PARAMS,
};
