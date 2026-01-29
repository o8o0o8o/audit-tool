/**
 * Utility Functions
 * Common helper functions used throughout the audit tool
 */

const crypto = require('crypto');
const { THRESHOLDS, SEVERITY } = require('./constants');

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
 * Validate URL
 * @param {string} urlString - URL to validate
 * @returns {string} Normalized URL
 * @throws {Error} If URL is invalid
 */
function validateUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required and must be a string');
  }

  try {
    const url = new URL(urlString);

    // Only allow http and https protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid protocol: ${url.protocol}. Only http and https are allowed`);
    }

    // Ensure hostname is present
    if (!url.hostname) {
      throw new Error('URL must have a valid hostname');
    }

    return url.href; // Return normalized URL
  } catch (error) {
    throw new Error(`Invalid URL: ${error.message}`);
  }
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
    const decodedPath = decodeURIComponent(url.pathname);
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

module.exports = {
  stripHashFragment,
  validateUrl,
  createSafeFilename,
  analyzeUrlStructure,
  formatElapsedTime,
};
