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
      return {
        valid: false,
        error: `Unsupported protocol: ${url.protocol}. Only http: and https: are allowed.\n  Hint: Use https://${url.hostname} instead.`,
      };
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
      /^fe80:/,
    ];

    const isPrivate = privatePatterns.some((pattern) => pattern.test(url.hostname));
    if (isPrivate) {
      console.warn(`\u26A0\uFE0F  Warning: Auditing private/local address: ${url.hostname}`);
    }

    return { valid: true, url };
  } catch (error) {
    return { valid: false, error: `Invalid URL: ${(error as Error).message}` };
  }
}

/**
 * Parse a hostname that may be an IPv4 address written in dotted, decimal,
 * octal, or hex form (e.g. `2130706433`, `0x7f000001`, `0177.0.0.1`) into its
 * 32-bit integer value. Returns null when the host is not an IPv4 literal.
 * SSRF guards that only string-match `127.` miss these equivalent encodings.
 */
function parseIPv4ToInt(host: string): number | null {
  const h = host.trim();
  // Single decimal/octal/hex integer form: http://2130706433/
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)$/i.test(h)) {
    const n =
      h.startsWith('0x') || h.startsWith('0X')
        ? parseInt(h, 16)
        : h.startsWith('0') && h.length > 1
          ? parseInt(h, 8)
          : parseInt(h, 10);
    return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n >>> 0 : null;
  }
  // Dotted form, each octet decimal/octal/hex: 0177.0.0.1, 0x7f.0.0.1
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*|0)$/i.test(part)) return null;
    const octet =
      part.startsWith('0x') || part.startsWith('0X')
        ? parseInt(part, 16)
        : part.startsWith('0') && part.length > 1
          ? parseInt(part, 8)
          : parseInt(part, 10);
    if (!Number.isFinite(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** True when a 32-bit IPv4 int falls in a private/loopback/link-local/CGNAT/
 *  reserved range that must never be fetched cross-origin (SSRF). */
function isPrivateIPv4Int(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  return (
    a === 0 || // 0.0.0.0/8 ("this network")
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // private 10/8
    (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
    (a === 192 && b === 168) || // private 192.168/16
    (a === 169 && b === 254) || // link-local 169.254/16 (incl. cloud metadata)
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a === 255 // broadcast
  );
}

/**
 * Classifies a hostname as private/internal/loopback — the set of hosts a
 * crawler must not be tricked into fetching when they appear in a remote site's
 * sitemap/robots/links (SSRF). Covers IPv4 (all numeric encodings), IPv6
 * loopback/ULA/link-local/unspecified/IPv4-mapped, and local hostnames.
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  if (!hostname) return true; // treat unparseable as unsafe
  let host = hostname.trim().toLowerCase();
  // Strip IPv6 brackets.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Local hostnames / mDNS.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }

  // IPv4 in any encoding.
  const v4 = parseIPv4ToInt(host);
  if (v4 !== null) return isPrivateIPv4Int(v4);

  // IPv6.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (host.startsWith('fe80:') || host.startsWith('fe80::')) return true; // link-local
    // Unique-local fc00::/7 → first byte fc or fd.
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
    // IPv4-mapped/compat ::ffff:127.0.0.1 etc.
    const mapped = host.match(/(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) {
      const inner = parseIPv4ToInt(mapped[1]);
      if (inner !== null && isPrivateIPv4Int(inner)) return true;
    }
    return false;
  }

  return false;
}

/**
 * SSRF gate for every URL the tool fetches/navigates that originates from a
 * remote site (sitemap `<loc>`, robots `Sitemap:`, discovered links, the
 * `--verify` re-fetch). Rejects non-http(s) protocols and private/internal
 * hosts. Auditing your OWN private/local site is allowed: pass `originHost` and
 * a same-host target passes, or set `SEO_AUDIT_ALLOW_PRIVATE=1` to disable the
 * private-range block entirely.
 */
export function isFetchAllowed(
  urlString: string,
  opts: { originHost?: string } = {},
): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { allowed: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (!url.hostname) return { allowed: false, reason: 'missing hostname' };

  if (isPrivateOrInternalHost(url.hostname)) {
    if (process.env.SEO_AUDIT_ALLOW_PRIVATE === '1') return { allowed: true };
    const originHost = opts.originHost?.toLowerCase().replace(/^\[|\]$/g, '');
    if (originHost && url.hostname.toLowerCase().replace(/^\[|\]$/g, '') === originHost) {
      return { allowed: true }; // same private host as the audit origin — intended
    }
    return { allowed: false, reason: `private/internal host ${url.hostname} (set SEO_AUDIT_ALLOW_PRIVATE=1 to allow)` };
  }
  return { allowed: true };
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
  origin?: string | null;
  sitemap?: string | null;
  compareSitemap?: string | null;
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

  return suspiciousPatterns.some((pattern) => pattern.test(input));
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
    this.requests = this.requests.filter((time) => now - time < this.windowMs);

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

// CLI testing
if (require.main === module) {
  console.log('Testing validators...\n');

  const testURLs = [
    'https://example.com',
    'http://localhost:3000',
    'invalid-url',
    'javascript:alert(1)',
    'https://192.168.1.1',
    'ftp://example.com',
  ];

  console.log('URL Validation Tests:');
  testURLs.forEach((url) => {
    const result = validateURL(url);
    console.log(`  ${url}: ${result.valid ? '\u2705 Valid' : '\u274C ' + result.error}`);
  });

  console.log('\nFilename Sanitization Tests:');
  const testFilenames = ['../../../etc/passwd', 'normal-file.txt', 'file<with>bad:chars', 'a'.repeat(300)];

  testFilenames.forEach((filename) => {
    console.log(`  "${filename}" \u2192 "${sanitizeFilename(filename)}"`);
  });

  console.log('\nDomain Sanitization Tests:');
  const testDomains = ['https://www.example.com/', 'example.com:8080', 'sub.domain.example.com'];

  testDomains.forEach((domain) => {
    console.log(`  "${domain}" \u2192 "${sanitizeDomainName(domain)}"`);
  });

  console.log('\nRate Limiter Test:');
  const limiter = new RateLimiter(3, 1000);
  for (let i = 0; i < 5; i++) {
    console.log(`  Request ${i + 1}: ${limiter.isAllowed() ? '\u2705 Allowed' : '\u274C Rate limited'}`);
  }
}
