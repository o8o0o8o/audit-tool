/**
 * Stable per-page content hash.
 *
 * Used by the audit-comparison classifier to distinguish "the site actually
 * changed" from "the audit measured slightly differently this time". We hash
 * a normalised view of the HTML so the typical sources of run-to-run drift
 * (cache-busters, CSRF tokens, timestamps, build IDs in asset URLs, dynamic
 * comment markers) don't trigger spurious hash diffs.
 *
 * The normalisation is conservative: anything we can't confidently identify
 * as drift stays in the hash. The goal is "same site, same content → same
 * hash" with as few false negatives as practical.
 */

import { createHash } from 'crypto';

/**
 * Patterns that look like build IDs / cache-busters embedded in attribute
 * values. Replaced with a placeholder so the hash isn't sensitive to them.
 */
const DRIFT_PATTERNS: Array<[RegExp, string]> = [
  // <script src="/_next/static/chunks/abc123def456.js"> → /_next/static/chunks/HASH.js
  [/\/_next\/static\/[^"' ]+/g, '/_next/static/HASH'],
  // Long hex token URL segments (≥ 8 chars) — common for cache-busters
  [/\b[a-f0-9]{8,}\b/gi, 'HASH'],
  // csrfmiddlewaretoken, _csrf, xsrf, nonce style values
  [/(name=["'](?:csrf|xsrf|nonce|_token)[^"']*["']\s+value=)["'][^"']*["']/gi, '$1"NONCE"'],
  // <meta name="csrf-token" content="..."> and similar
  [/(meta[^>]*name=["'](?:csrf-token|xsrf-token|build-id|deploy-id)["'][^>]*content=)["'][^"']*["']/gi, '$1"NONCE"'],
  // ISO timestamps inside HTML — drop seconds-precision
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, 'TIMESTAMP'],
  // HTML comments — often contain build metadata
  [/<!--[\s\S]*?-->/g, ''],
];

/** Compute a normalised SHA256 of the HTML. Returns the hex digest. */
export function computeContentHash(html: string): string {
  let normalised = html;
  for (const [re, repl] of DRIFT_PATTERNS) {
    normalised = normalised.replace(re, repl);
  }
  // Collapse whitespace — formatting changes shouldn't ripple into the hash.
  // First strip whitespace BETWEEN adjacent tags (`> <` → `><`) so two
  // syntactically-identical documents with different pretty-printing hash the
  // same, then collapse internal runs.
  normalised = normalised
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised).digest('hex');
}
