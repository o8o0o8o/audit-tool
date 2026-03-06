/**
 * Input Validation and Sanitization Utilities
 * Provides secure validation for user inputs and URLs
 */

/**
 * Validates and sanitizes a URL
 * @param {string} urlString - URL to validate
 * @returns {{valid: boolean, url?: URL, error?: string}}
 */
function validateURL(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string' };
  }

  // Remove leading/trailing whitespace
  urlString = urlString.trim();

  // Check for obviously invalid characters
  if (urlString.includes(' ') || urlString.includes('\n') || urlString.includes('\t')) {
    return { valid: false, error: 'URL contains invalid whitespace characters' };
  }

  // Try to parse as URL
  try {
    const url = new URL(urlString);

    // Only allow HTTP/HTTPS protocols
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: `Unsupported protocol: ${url.protocol}. Only http: and https: are allowed` };
    }

    // Check for valid hostname
    if (!url.hostname || url.hostname.length === 0) {
      return { valid: false, error: 'URL must have a valid hostname' };
    }

    // Check for localhost/private IPs in production (optional security check)
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/
    ];

    const isPrivate = privatePatterns.some(pattern => pattern.test(url.hostname));
    if (isPrivate) {
      console.warn(`⚠️  Warning: Auditing private/local address: ${url.hostname}`);
    }

    return { valid: true, url };
  } catch (error) {
    return { valid: false, error: `Invalid URL: ${error.message}` };
  }
}

/**
 * Sanitizes a filename to prevent path traversal
 * @param {string} filename - Filename to sanitize
 * @returns {string} - Safe filename
 */
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed';

  return filename
    // Remove path separators
    .replace(/[\/\\]/g, '_')
    // Remove null bytes
    .replace(/\0/g, '')
    // Remove control characters
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Remove dangerous characters
    .replace(/[<>:"|?*]/g, '_')
    // Remove leading/trailing dots and spaces
    .replace(/^[\s.]+|[\s.]+$/g, '')
    // Limit length
    .substring(0, 255);
}

/**
 * Validates command-line arguments
 * @param {object} args - Parsed arguments object
 * @returns {{valid: boolean, error?: string}}
 */
function validateArguments(args) {
  // Allow --sitemap without --origin (origin is derived from sitemap URLs)
  if (!args.origin && !args.sitemap) {
    return { valid: false, error: 'Missing required argument: --origin (or --sitemap=<file>)' };
  }

  // Validate origin URL if provided
  if (args.origin) {
    const urlValidation = validateURL(args.origin);
    if (!urlValidation.valid) {
      return { valid: false, error: `Invalid origin URL: ${urlValidation.error}` };
    }
  }

  // Validate sitemap files exist
  if (args.sitemap) {
    const fs = require('fs');
    if (!fs.existsSync(args.sitemap)) {
      return { valid: false, error: `Sitemap file not found: ${args.sitemap}` };
    }
  }

  if (args.compareSitemap) {
    const fs = require('fs');
    if (!fs.existsSync(args.compareSitemap)) {
      return { valid: false, error: `Compare sitemap file not found: ${args.compareSitemap}` };
    }
    if (!args.sitemap) {
      return { valid: false, error: '--compare-sitemap requires --sitemap' };
    }
  }

  // Validate boolean flags
  if (args.perf !== undefined && typeof args.perf !== 'boolean' && args.perf !== '') {
    return { valid: false, error: '--perf must be a boolean flag (no value)' };
  }

  if (args.proceed !== undefined && typeof args.proceed !== 'boolean' && args.proceed !== '') {
    return { valid: false, error: '--proceed must be a boolean flag (no value)' };
  }

  return { valid: true };
}

/**
 * Sanitizes a domain name for use in filenames
 * @param {string} domain - Domain name
 * @returns {string} - Sanitized domain
 */
function sanitizeDomainName(domain) {
  if (!domain) return 'unknown';

  return domain
    .toLowerCase()
    // Remove protocol
    .replace(/^https?:\/\//, '')
    // Remove www.
    .replace(/^www\./, '')
    // Remove trailing slash
    .replace(/\/$/, '')
    // Remove port
    .replace(/:\d+$/, '')
    // Keep only alphanumeric, dots, and hyphens
    .replace(/[^a-z0-9.-]/g, '_')
    // Remove leading/trailing dots and hyphens
    .replace(/^[.-]+|[.-]+$/g, '')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Limit length
    .substring(0, 100);
}

/**
 * Checks if a string contains potential injection patterns
 * @param {string} input - Input to check
 * @returns {boolean} - True if suspicious patterns found
 */
function containsSuspiciousPatterns(input) {
  if (!input || typeof input !== 'string') return false;

  const suspiciousPatterns = [
    /[;&|`$(){}[\]]/,           // Shell metacharacters
    /<script/i,                  // XSS attempts
    /javascript:/i,              // JS protocol
    /on\w+\s*=/i,               // Event handlers (onclick=, onerror=, etc.)
    /\.\.\//,                    // Path traversal
    /\0/,                        // Null bytes
    /\beval\s*\(/i,             // eval() calls
    /\bFunction\s*\(/i,         // Function() constructor
    /\$\{[^}]+\}/,              // Template literal expressions ${...}
    /\bnew\s+Function\b/i,      // new Function()
    /\bsetTimeout\s*\([^,]*,/i, // setTimeout with string arg
    /\bsetInterval\s*\([^,]*,/i, // setInterval with string arg
    /data:\s*text\/html/i,      // Data URLs with HTML
    /vbscript:/i,               // VBScript protocol
  ];

  return suspiciousPatterns.some(pattern => pattern.test(input));
}

/**
 * Rate limiting helper for preventing abuse
 */
class RateLimiter {
  constructor(maxRequests = 10, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  /**
   * Checks if request is allowed
   * @returns {boolean}
   */
  isAllowed() {
    const now = Date.now();
    // Remove old requests outside the window
    this.requests = this.requests.filter(time => now - time < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      return false;
    }

    this.requests.push(now);
    return true;
  }

  /**
   * Gets time until next request is allowed (ms)
   * @returns {number}
   */
  getTimeUntilReset() {
    if (this.requests.length === 0) return 0;
    const oldestRequest = Math.min(...this.requests);
    const resetTime = oldestRequest + this.windowMs;
    return Math.max(0, resetTime - Date.now());
  }
}

/**
 * Validates a repository path for source code analysis
 * @param {string} repoPath - Path to the repository
 * @returns {{valid: boolean, error?: string}}
 */
function validateRepoPath(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    return { valid: false, error: 'Repository path must be a non-empty string' };
  }

  const fs = require('fs');
  const path = require('path');

  // Resolve to absolute path
  const resolved = path.resolve(repoPath);

  // Check for path traversal attempts
  if (repoPath.includes('\0')) {
    return { valid: false, error: 'Repository path contains invalid characters' };
  }

  // Check path exists and is a directory
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Not a directory: ${resolved}` };
    }
  } catch {
    return { valid: false, error: `Directory not found: ${resolved}` };
  }

  // Check for package.json
  const packageJsonPath = path.join(resolved, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { valid: false, error: `No package.json found in: ${resolved}` };
  }

  return { valid: true, resolvedPath: resolved };
}

// Alias for naming consistency (camelCase preferred in Node.js)
const validateUrl = validateURL;

module.exports = {
  validateURL,
  validateUrl,  // Alias for consistency with lib/utils.js naming convention
  sanitizeFilename,
  validateArguments,
  validateRepoPath,
  sanitizeDomainName,
  containsSuspiciousPatterns,
  RateLimiter
};

// CLI testing
if (require.main === module) {
  console.log('Testing validators...\n');

  // Test URL validation
  const testURLs = [
    'https://example.com',
    'http://localhost:3000',
    'invalid-url',
    'javascript:alert(1)',
    'https://192.168.1.1',
    'ftp://example.com'
  ];

  console.log('URL Validation Tests:');
  testURLs.forEach(url => {
    const result = validateURL(url);
    console.log(`  ${url}: ${result.valid ? '✅ Valid' : '❌ ' + result.error}`);
  });

  console.log('\nFilename Sanitization Tests:');
  const testFilenames = [
    '../../../etc/passwd',
    'normal-file.txt',
    'file<with>bad:chars',
    'a'.repeat(300)
  ];

  testFilenames.forEach(filename => {
    console.log(`  "${filename}" → "${sanitizeFilename(filename)}"`);
  });

  console.log('\nDomain Sanitization Tests:');
  const testDomains = [
    'https://www.example.com/',
    'example.com:8080',
    'sub.domain.example.com'
  ];

  testDomains.forEach(domain => {
    console.log(`  "${domain}" → "${sanitizeDomainName(domain)}"`);
  });

  console.log('\nRate Limiter Test:');
  const limiter = new RateLimiter(3, 1000);
  for (let i = 0; i < 5; i++) {
    console.log(`  Request ${i + 1}: ${limiter.isAllowed() ? '✅ Allowed' : '❌ Rate limited'}`);
  }
}
