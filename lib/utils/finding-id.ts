/**
 * Stable finding identity utilities.
 *
 * Across analyzer messages, runs, and report-rendering passes, we want a
 * single canonical identity for "the same kind of finding". Today this is
 * implicit (the message string itself), which breaks the moment an analyzer's
 * wording drifts. This module gives us three operations:
 *
 *   normalizeMessage  — strip HTML tags and trailing "(N units)" tokens, so
 *                       "Color contrast fails WCAG AA (24 elements)" and
 *                       "Color contrast fails WCAG AA (25 elements)" collapse
 *                       to the same message.
 *
 *   slugifyFinding    — normalize + lowercase + kebab-case. Used as the
 *                       canonical ID for diffing and de-duplication.
 *
 *   isVolatileFinding — heuristic flag for findings whose count fluctuates
 *                       from run to run because they depend on a timing
 *                       measurement (LCP, TTFB, …). The diff classifier uses
 *                       this to separate noise flips from real regressions.
 *
 * Pure functions. No I/O. Safe to import from anywhere.
 */

/** Strip trailing `(N units)` tokens — same regex used by Phase 2 dedup. */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*\d+(?:\s+[a-z][a-z-]{0,15})?\s*\)\s*$/i, '')
    .trim();
}

/**
 * Aggressive form of `normalizeMessage` used only by the FIX_RECOMMENDATIONS
 * lookup. In addition to `normalizeMessage` it:
 *
 *   1. Strips leading `<count> ` and `<pct>% of ` prefixes that analyzer
 *      template strings inject (e.g. `"5 pages have critical JavaScript errors"`).
 *   2. Collapses any other embedded numbers / percentages — so
 *      `"FAQ Question 3 missing acceptedAnswer"` and
 *      `"FAQ Question 12 missing acceptedAnswer"` reduce to the same key.
 *   3. Cleans up empty parentheses left behind by step 2.
 *
 * Kept out of `normalizeMessage` itself so finding identity / diff
 * comparisons are not affected by this aggressive collapse.
 */
export function normalizeMessageForLookup(msg: string): string {
  return normalizeMessage(msg)
    .replace(/^\s*\d+(?:[.,]\d+)?%?\s+(?:of\s+)?(?=[A-Za-z])/i, '')
    .replace(/\b\d+(?:[.,]\d+)?%?/g, '')
    .replace(/%/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\(\s*[A-Z][A-Z0-9_-]*\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable kebab-case slug for the finding.
 * Inputs that normalize to the same canonical form produce identical slugs,
 * regardless of HTML wrapping or trailing numeric variants.
 */
export function slugifyFinding(msg: string): string {
  return normalizeMessage(msg)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Patterns that indicate the finding's count moves with timing measurements
 * rather than structural state. A 7→8 flip on these is almost always noise.
 *
 * Conservative on purpose — we'd rather classify something as "real" and let
 * the reader verify than silently downgrade a genuine regression.
 */
const VOLATILE_PATTERNS = [
  /\b(LCP|FCP|TTFB|CLS|INP|TBT|TTI|speed\s*index)\b/i,
  /\bcore web vitals?\b/i,
  /slow.*(loading|rendering|response)/i,
  /\b(broken|outbound)\s+link/i, // transient network errors
  /unused\s+(javascript|js|css)/i, // coverage varies with page state
  /\brender.?blocking\b/i, // race-condition-sensitive
  /\bthird.?party\s+(payload|scripts?)\b/i, // depends on ad/analytics load
  /\b(image|font)\s+payload\b/i, // varies with caching
];

export function isVolatileFinding(message: string): boolean {
  const n = normalizeMessage(message);
  return VOLATILE_PATTERNS.some((re) => re.test(n));
}
