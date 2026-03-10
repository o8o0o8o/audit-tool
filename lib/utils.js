/**
 * Utility Functions
 * Common helper functions used throughout the audit tool
 */

const crypto = require('crypto');
const { THRESHOLDS, SEVERITY } = require('./constants');
// Import core URL validation from validators.js for consistency
const { validateURL: coreValidateURL } = require('../validators');

// Tracking parameters to always strip (marketing, analytics, session)
const TRACKING_PARAMS = new Set([
  // Google Analytics / Ads
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
  // Facebook
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  // Microsoft/Bing
  'msclkid',
  // Other common tracking
  'mc_cid', 'mc_eid',  // Mailchimp
  'oly_enc_id', 'oly_anon_id',  // Omeda
  '_hsenc', '_hsmi', 'hsCtaTracking',  // HubSpot
  'vero_id', 'vero_conv',  // Vero
  'nr_email_referer',  // NewRelic
  'mkt_tok',  // Marketo
  'trk', 'trkCampaign', 'trkInfo',  // LinkedIn
  'si',  // Spotify
  'igshid',  // Instagram
  '__twitter_impression',  // Twitter
  's_kwcid',  // Adobe Analytics
  'ef_id',  // Adobe Experience Cloud
  // Session/misc
  'ref', 'referrer', 'source',
  'sessionid', 'sid', 'phpsessid', 'jsessionid', 'aspsessionid',
  '_ga', '_gl', '_ke',
]);

/**
 * Normalize URL by handling query parameters
 * @param {string} urlString - URL to normalize
 * @param {object} options - Normalization options
 * @param {string} options.mode - 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist'
 * @param {string[]} options.whitelist - Params to keep when mode is 'whitelist'
 * @param {string[]} options.blacklist - Additional params to strip
 * @returns {string} Normalized URL
 */
function normalizeUrl(urlString, options = {}) {
  if (!urlString) return urlString;

  const {
    mode = 'strip_tracking',
    whitelist = [],
    blacklist = [],
  } = options;

  try {
    const url = new URL(urlString);

    // Remove hash fragment
    url.hash = '';

    // Handle query params based on mode
    if (mode === 'keep_all') {
      // Keep all params, just remove hash
      return url.href;
    }

    if (mode === 'strip_all') {
      // Remove all query params
      url.search = '';
      return url.href;
    }

    // For 'strip_tracking' and 'whitelist' modes, process params
    const paramsToRemove = [];
    // Pre-compute Sets outside the loop to avoid O(n²) complexity
    const blacklistSet = new Set(blacklist.map(p => p.toLowerCase()));
    const whitelistSet = mode === 'whitelist'
      ? new Set(whitelist.map(p => p.toLowerCase()))
      : null;

    for (const [key] of url.searchParams) {
      const keyLower = key.toLowerCase();

      if (mode === 'whitelist') {
        // Only keep whitelisted params
        if (!whitelistSet.has(keyLower)) {
          paramsToRemove.push(key);
        }
      } else {
        // strip_tracking mode: remove tracking params and blacklisted
        if (TRACKING_PARAMS.has(keyLower) || blacklistSet.has(keyLower)) {
          paramsToRemove.push(key);
        }
      }
    }

    // Remove identified params
    for (const key of paramsToRemove) {
      url.searchParams.delete(key);
    }

    // Sort remaining params for consistent URLs
    url.searchParams.sort();

    return url.href;
  } catch (error) {
    // If URL parsing fails, return original
    return urlString;
  }
}

/**
 * Strip hash fragment from URL
 * @param {string} urlString - URL to process
 * @returns {string} URL without hash fragment
 */
function stripHashFragment(urlString) {
  if (!urlString) return urlString;

  try {
    const url = new URL(urlString);
    // Remove hash fragment
    url.hash = '';
    return url.href;
  } catch (error) {
    // If URL parsing fails, try simple string replacement
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
 *
 * @param {string} urlString - URL to validate
 * @returns {string} Normalized URL
 * @throws {Error} If URL is invalid
 */
function validateUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required and must be a string');
  }

  // Check URL length to prevent memory exhaustion
  const MAX_URL_LENGTH = 8192; // 8KB max (common browser limit)
  if (urlString.length > MAX_URL_LENGTH) {
    throw new Error(`URL is too long (${urlString.length} chars, max ${MAX_URL_LENGTH})`);
  }

  // Use core validation from validators.js for protocol/hostname checks
  const coreResult = coreValidateURL(urlString);
  if (!coreResult.valid) {
    throw new Error(coreResult.error);
  }

  const url = coreResult.url;

  // Additional security checks beyond core validation
  const hostname = url.hostname;

  // Check for obviously invalid hostnames
  if (hostname.length === 0 || hostname.length > 253) {
    throw new Error('Invalid hostname length');
  }

  // Check for consecutive dots or leading/trailing dots
  if (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
    throw new Error('Invalid hostname format');
  }

  // Validate each label in hostname
  const labels = hostname.split('.');
  for (const label of labels) {
    // Each label must be 1-63 chars
    if (label.length === 0 || label.length > 63) {
      throw new Error(`Invalid hostname label length: "${label}"`);
    }

    // Check for valid label characters (ASCII alphanumeric, hyphen, or IDN)
    // IDN labels start with 'xn--' after punycode encoding
    const isAscii = /^[a-zA-Z0-9-]+$/.test(label);
    const hasValidNonAscii = !isAscii && /^[\p{L}\p{N}-]+$/u.test(label);

    if (!isAscii && !hasValidNonAscii) {
      throw new Error(`Invalid characters in hostname label: "${label}"`);
    }

    // Label cannot start or end with hyphen
    if (label.startsWith('-') || label.endsWith('-')) {
      throw new Error(`Hostname label cannot start or end with hyphen: "${label}"`);
    }
  }

  // Check for query string with too many parameters (DoS prevention)
  const MAX_QUERY_PARAMS = 100;
  if (url.searchParams.size > MAX_QUERY_PARAMS) {
    throw new Error(`Too many query parameters (${url.searchParams.size}, max ${MAX_QUERY_PARAMS})`);
  }

  return url.href; // Return normalized URL
}

/**
 * Create safe filename from URL
 * @param {string} url - URL to convert to filename
 * @returns {string} Safe filename
 */
function createSafeFilename(url) {
  // Create a hash of the URL for the filename
  const hash = crypto.createHash('md5').update(url).digest('hex');
  // Also include a sanitized version for readability
  const sanitized = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 50); // Limit length
  return `${sanitized}_${hash}`;
}

/**
 * Analyze URL structure for SEO issues
 * @param {string} urlString - The URL to analyze
 * @param {string} origin - The site origin
 * @returns {object} Analysis results
 */
function analyzeUrlStructure(urlString, origin) {
  const analysis = {
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

  // Skip analysis for extremely long URLs to prevent ReDoS
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

    // URL length (excluding protocol and domain)
    const pathAndQuery = url.pathname + url.search;
    analysis.length = pathAndQuery.length;

    // Check if HTTPS
    analysis.isHttps = url.protocol === 'https:';

    // URL depth (number of path segments, excluding empty ones)
    const pathSegments = url.pathname.split('/').filter(segment => segment.length > 0);
    analysis.depth = pathSegments.length;

    // Check for uppercase letters in path
    analysis.hasUppercase = /[A-Z]/.test(url.pathname);

    // Check for underscores (hyphens are preferred)
    analysis.hasUnderscores = url.pathname.includes('_');

    // Check for spaces (should be encoded as %20)
    analysis.hasSpaces = url.pathname.includes(' ') || url.pathname.includes('%20');

    // Check for special characters (excluding hyphens and common separators)
    const specialCharsPattern = /[^a-zA-Z0-9\-_\/\.]/;
    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { decodedPath = url.pathname; }
    analysis.hasSpecialChars = specialCharsPattern.test(decodedPath);

    // Query parameters
    analysis.hasQueryParams = url.search.length > 0;
    if (analysis.hasQueryParams) {
      analysis.queryParamCount = url.searchParams.size;
    }

    // Generate issues
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
      message: `Invalid URL format: ${error.message}`,
    });
  }

  return analysis;
}

/**
 * Format elapsed time in human-readable format
 * @param {number} ms - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatElapsedTime(ms) {
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
const LOG_PREFIX = {
  ERROR: '❌',
  WARNING: '⚠️',
  SUCCESS: '✓',
  INFO: '📊',
  FILE: '📁',
  SAVE: '💾',
  LOAD: '📄',
};

/**
 * Format a log message with consistent prefix
 * @param {string} level - Log level (ERROR, WARNING, SUCCESS, INFO, FILE, SAVE, LOAD)
 * @param {string} message - Message to log
 * @returns {string} Formatted message
 */
function formatLogMessage(level, message) {
  const prefix = LOG_PREFIX[level] || '';
  return prefix ? `${prefix} ${message}` : message;
}

/**
 * Format an error message consistently
 * @param {string} context - Context/file where error occurred
 * @param {string} message - Error message
 * @returns {string} Formatted error message
 */
function formatErrorMessage(context, message) {
  return `${LOG_PREFIX.ERROR} ${context}: ${message}`;
}

/**
 * Format a warning message consistently
 * @param {string} message - Warning message
 * @returns {string} Formatted warning message
 */
function formatWarningMessage(message) {
  return `${LOG_PREFIX.WARNING} ${message}`;
}

/**
 * Generate timestamp string for folder names and IDs
 * Centralized to avoid duplicate implementations
 * @returns {string} Timestamp in format YYYY-MM-DD_HH-MM-SS
 */
function generateTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

module.exports = {
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
  LOG_PREFIX,
  TRACKING_PARAMS,
};
