/**
 * Utility Functions
 * Common helper functions used throughout the audit tool
 */

import crypto from 'crypto';
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

    const pathSegments = url.pathname.split('/').filter((segment) => segment.length > 0);
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
 * Format a list of URLs as HTML <li> elements with links.
 * Escapes HTML to prevent XSS. Optionally limits the number of items shown.
 */
function formatUrlList(urls: string[], maxItems?: number): string {
  const items = maxItems ? urls.slice(0, maxItems) : urls;
  return items
    .map((u) => {
      const escaped = u.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<li><a href="${escaped}">${escaped}</a></li>`;
    })
    .join('');
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
  LOG_PREFIX,
  TRACKING_PARAMS,
};
