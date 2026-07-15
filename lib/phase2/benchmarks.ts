/**
 * Benchmarks for comparative findings.
 *
 * When a finding says "too many / too few / too long / too short / high
 * percentage of …" the reader needs three things to act: the value measured now
 * (carried per-page in each finding's examples), the value it SHOULD be, and
 * WHY that target matters. This module supplies the "should be + why" half — a
 * single sentence anchored in the same `THRESHOLDS` constants the analyzers use
 * to flag the issue, so the report and the detector never drift apart.
 *
 * The "how many now" half is recovered separately by the report renderer, which
 * keeps the analyzer's measured clause ("… has 8 render-blocking resources")
 * instead of collapsing each example to a bare URL.
 *
 * Keyed by a conservative regex on the finding title. Returns undefined for
 * findings that aren't threshold-comparative, so most findings are unaffected.
 */

import { THRESHOLDS } from '../constants';

const kb = (bytes: number) => `${Math.round(bytes / 1000)} KB`;
const mb = (bytes: number) => {
  const v = bytes / 1_000_000;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
};

interface BenchmarkRule {
  match: RegExp;
  text: string;
}

// Order matters: more specific patterns first (e.g. "exceeds 3MB" before the
// general "large HTML document"). First match wins.
const RULES: BenchmarkRule[] = [
  {
    match: /too many requests|too many http requests/i,
    text: `Recommended: ≤${THRESHOLDS.REQUEST_COUNT} requests per page. Each extra request adds connection setup and bandwidth contention that delays rendering.`,
  },
  {
    match: /render-?blocking (resources|third-party)/i,
    text: `Recommended: ≤${THRESHOLDS.RENDER_BLOCKING_MAX} render-blocking resources. Each one holds up first paint until it has downloaded and executed.`,
  },
  {
    match: /titles? (that are )?too long/i,
    text: `Recommended: title ≤${THRESHOLDS.TITLE_MAX} characters. Google truncates longer titles in search results.`,
  },
  {
    match: /titles? (that are )?too short/i,
    text: `Recommended: title ≥${THRESHOLDS.TITLE_MIN} characters so it describes the page and uses the available result width.`,
  },
  {
    match: /descriptions? (that are )?too long/i,
    text: `Recommended: meta description ≤${THRESHOLDS.DESCRIPTION_MAX} characters. Google truncates longer descriptions in the SERP.`,
  },
  {
    match: /descriptions? (that are )?too short/i,
    text: `Recommended: meta description ${THRESHOLDS.DESCRIPTION_MIN}–${THRESHOLDS.DESCRIPTION_MAX} characters; shorter ones waste result space and under-describe the page.`,
  },
  {
    match: /high percentage of unused javascript/i,
    text: `Flagged when over 70% of a page's JavaScript goes unused. Ship only what the page needs via code-splitting and tree-shaking.`,
  },
  {
    match: /high percentage of unused css/i,
    text: `Flagged when over 80% of a page's CSS goes unused. Extract critical CSS and drop rules the page never applies.`,
  },
  {
    match: /(large amount of )?unused code/i,
    text: `Flagged above ${kb(THRESHOLDS.UNUSED_CODE_BYTES_WARNING)} of unused code per page. Users download and parse bytes the page never executes.`,
  },
  {
    // Single canonical third-party-payload benchmark (tier-twin collapsed,
    // report-rules.md §5). Covers both the >warning and >critical bands.
    match: /large third-party payload/i,
    text: `Recommended: keep third-party payload under ${kb(THRESHOLDS.THIRD_PARTY_SIZE_WARNING)}; above ${mb(THRESHOLDS.THIRD_PARTY_SIZE_CRITICAL)} it dominates load time and main-thread work. Third-party code blocks the main thread and is outside your control.`,
  },
  {
    match: /(too many )?third-party origins/i,
    text: `Recommended: ≤30 distinct third-party origins. Each new origin costs a DNS lookup, TCP connection, and TLS handshake before its content can load.`,
  },
  {
    match: /element with too many children/i,
    text: `Recommended: ≤${THRESHOLDS.DOM_CHILDREN_WARNING} child elements per parent (Lighthouse). Large DOM branches slow style, layout, and rendering.`,
  },
  {
    // Single canonical HTML-size benchmark (tier-twin collapsed, report-rules.md §5).
    // Covers both the >1 MB and >3 MB bands.
    match: /large html document/i,
    text: `Flagged above 1 MB of HTML (severe above 3 MB). Very large HTML slows parsing, wastes crawl budget, and approaches Google's 15 MB rendering limit. Trim inline styles/scripts and server-rendered payload to speed up parsing.`,
  },
  {
    match: /page size is too big|page.*too big/i,
    text: `Recommended: total page weight ≤${mb(THRESHOLDS.PAGE_SIZE)}. Heavier pages cost mobile users time and data.`,
  },
  {
    match: /urls? (are )?too long/i,
    text: `Recommended: URL ≤${THRESHOLDS.URL_LENGTH_RECOMMENDED} characters (hard cap ${THRESHOLDS.URL_LENGTH_MAX}). Long URLs are harder to share, read, and keep stable.`,
  },
  {
    match: /too many (internal |outbound |external )?links|links per page/i,
    text: `Recommended: ≤${THRESHOLDS.LINKS_PER_PAGE_WARNING} links per page. Excessive links dilute link equity and overwhelm readers.`,
  },
  {
    match: /text-to-html ratio|low text-to-html/i,
    text: `Recommended: text-to-HTML ratio ≥${THRESHOLDS.TEXT_TO_HTML_RATIO_MIN}%. A low ratio signals thin content relative to markup.`,
  },
  {
    match: /thin content|insufficient content|content is too short|too few words|low word count/i,
    text: `Recommended: ≥${THRESHOLDS.CONTENT_MIN} words (≥${THRESHOLDS.CONTENT_RECOMMENDED} preferred). Thin pages struggle to rank and to satisfy search intent.`,
  },
  {
    match: /too many h2|excessive h2/i,
    text: `Recommended: ≤${THRESHOLDS.H2_COUNT} H2 headings. Too many top-level sections suggest the page should be split or restructured.`,
  },
];

/**
 * The "should be + why" sentence for a comparative finding, or undefined when
 * the finding isn't threshold-based. Matched against the (HTML-free) title.
 */
export function benchmarkFor(message: string): string | undefined {
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.text;
  }
  return undefined;
}
