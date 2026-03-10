/**
 * Input Validation and Sanitization Utilities
 * Provides secure validation for user inputs and URLs
 */

import type { ValidationResult } from './lib/types';

/**
 * Validates and sanitizes a URL
 */
export function validateURL(urlString: string): ValidationResult {
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
      return { valid: false, error: `Unsupported protocol: ${url.protocol}. Only http: and https: are allowed.\n  Hint: Use https://${url.hostname} instead.` };
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
      console.warn(`\u26A0\uFE0F  Warning: Auditing private/local address: ${url.hostname}`);
    }

    return { valid: true, url };
  } catch (error) {
    return { valid: false, error: `Invalid URL: ${(error as Error).message}` };
  }
}

/**
 * Sanitizes a filename to prevent path traversal
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed';

  const sanitized = filename
    .replace(/[\/\\]/g, '_')
    .replace(/\0/g, '')
    .replace(/%00/gi, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 255);

  return sanitized || 'unnamed';
}

/**
 * Validates command-line arguments
 */
export function validateArguments(args: {
  origin?: string;
  sitemap?: string;
  compareSitemap?: string;
  perf?: boolean | string;
  proceed?: boolean | string;
}): { valid: boolean; error?: string } {
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
 */
export function sanitizeDomainName(domain: string): string {
  if (!domain) return 'unknown';

  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .replace(/:\d+$/, '')
    .replace(/[^a-z0-9.-]/g, '_')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/_+/g, '_')
    .substring(0, 100);
}

/**
 * Checks if a string contains potential injection patterns
 */
export function containsSuspiciousPatterns(input: string): boolean {
  if (!input || typeof input !== 'string') return false;

  const suspiciousPatterns = [
    /[;&|`$(){}[\]]/,
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /\.\.\//,
    /\0/,
    /%00/i,
    /\beval\s*\(/i,
    /\bFunction\s*\(/i,
    /\$\{[^}]+\}/,
    /\bnew\s+Function\b/i,
    /\bsetTimeout\s*\([^,]*,/i,
    /\bsetInterval\s*\([^,]*,/i,
    /data:\s*text\/html/i,
    /vbscript:/i,
  ];

  return suspiciousPatterns.some(pattern => pattern.test(input));
}

/**
 * Rate limiting helper for preventing abuse
 */
export class RateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private requests: number[];

  constructor(maxRequests: number = 10, windowMs: number = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  isAllowed(): boolean {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      return false;
    }

    this.requests.push(now);
    return true;
  }

  getTimeUntilReset(): number {
    if (this.requests.length === 0) return 0;
    const oldestRequest = Math.min(...this.requests);
    const resetTime = oldestRequest + this.windowMs;
    return Math.max(0, resetTime - Date.now());
  }
}

/**
 * Validates a repository path for source code analysis
 */
export function validateRepoPath(repoPath: string): ValidationResult {
  if (!repoPath || typeof repoPath !== 'string') {
    return { valid: false, error: 'Repository path must be a non-empty string' };
  }

  const fs = require('fs');
  const path = require('path');

  const resolved: string = path.resolve(repoPath);

  if (repoPath.includes('\0')) {
    return { valid: false, error: 'Repository path contains invalid characters' };
  }

  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Not a directory: ${resolved}` };
    }
  } catch {
    return { valid: false, error: `Directory not found: ${resolved}` };
  }

  const packageJsonPath = path.join(resolved, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { valid: false, error: `No package.json found in: ${resolved}` };
  }

  return { valid: true, resolvedPath: resolved };
}

// Alias for naming consistency
export const validateUrl = validateURL;

// CommonJS compatibility
module.exports = {
  validateURL,
  validateUrl,
  sanitizeFilename,
  validateArguments,
  validateRepoPath,
  sanitizeDomainName,
  containsSuspiciousPatterns,
  RateLimiter,
};

// CLI testing
if (require.main === module) {
  console.log('Testing validators...\n');

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
    console.log(`  ${url}: ${result.valid ? '\u2705 Valid' : '\u274C ' + result.error}`);
  });

  console.log('\nFilename Sanitization Tests:');
  const testFilenames = [
    '../../../etc/passwd',
    'normal-file.txt',
    'file<with>bad:chars',
    'a'.repeat(300)
  ];

  testFilenames.forEach(filename => {
    console.log(`  "${filename}" \u2192 "${sanitizeFilename(filename)}"`);
  });

  console.log('\nDomain Sanitization Tests:');
  const testDomains = [
    'https://www.example.com/',
    'example.com:8080',
    'sub.domain.example.com'
  ];

  testDomains.forEach(domain => {
    console.log(`  "${domain}" \u2192 "${sanitizeDomainName(domain)}"`);
  });

  console.log('\nRate Limiter Test:');
  const limiter = new RateLimiter(3, 1000);
  for (let i = 0; i < 5; i++) {
    console.log(`  Request ${i + 1}: ${limiter.isAllowed() ? '\u2705 Allowed' : '\u274C Rate limited'}`);
  }
}
