/**
 * Constants and Configuration
 * Centralized configuration for thresholds, severity levels, and error codes
 */

import type { SeverityLevel, NetworkCondition, CpuCondition } from './types';

// Known error messages to track
export const KNOWN_ERRORS: string[] = ['ERR_TOO_MANY_REDIRECTS'];

// Issue severity levels
export const SEVERITY = {
  CRITICAL: 'critical' as const,
  HIGH: 'high' as const,
  MEDIUM: 'medium' as const,
  LOW: 'low' as const,
} satisfies Record<string, SeverityLevel>;

// Crawl settings
export const CRAWL_SETTINGS = {
  DEFAULT_CONCURRENCY: 5,
  MAX_CONCURRENCY: 20,
  BATCH_SIZE: 100,
  MAX_EXAMPLES_PER_ISSUE: 100,
  MAX_TOTAL_ISSUE_COUNT: 1000000,
  MAX_DISCOVERED_URLS: 100000,
  MAX_INCOMING_LINKS: 100000,
  INCOMING_LINKS_PER_TARGET_MAX: 100,
  ANALYZER_TIMEOUT: 10000,
  BATCH_TIMEOUT: 300000,
  CHECKPOINT_SAVE_INTERVAL: 5,
  CIRCUIT_BREAKER_THRESHOLD: 10,
  CIRCUIT_BREAKER_COOLDOWN_MS: 60000,
  // Abort the entire crawl after this many consecutive 404 responses.
  // Why: catches broken pagination where a page links to /page/N for N beyond the real last page.
  CONSECUTIVE_404_THRESHOLD: 10,
  // Cap auto-discovered URLs from a single pagination series (e.g. /page/N).
  // Why: catches "empty pagination" cases where a site links to page/2..page/N
  // for absurd N, but every page beyond the real last renders an empty listing
  // (status 200, no "not found" text) — so neither hard nor soft 404 detection fires.
  MAX_PAGINATED_URLS_PER_SERIES: 20,
  // Broken-pagination (infinite "next") detection.
  // Why: a "next" link that keeps returning HTTP 200 empty/duplicate listings
  // past the real last page makes crawlers follow it indefinitely, wasting
  // crawl budget. We flag a series once its trailing pages look broken.
  // Minimum number of contiguous broken trailing pages before we flag a series.
  BROKEN_PAGINATION_MIN_TAIL: 2,
  // Word count at/below which a listing page counts as "empty/thin".
  BROKEN_PAGINATION_THIN_WORDS: 50,
  // Active JS-"next" probe: max clicks to follow, total time budget, and the
  // max number of distinct series probed per audit (keeps cost bounded).
  BROKEN_PAGINATION_MAX_PROBE_CLICKS: 3,
  BROKEN_PAGINATION_PROBE_TIMEOUT_MS: 6000,
  BROKEN_PAGINATION_MAX_PROBES: 5,
  // Infinite-scroll discoverability check.
  // Why: an infinite-scroll *mechanism* (sentinel/trigger) is only an SEO problem
  // when the list content it loads is NOT already in the served HTML (so a crawler
  // can't see it) AND there's no static fallback. These gate the finding so a
  // server-rendered list that's merely revealed on scroll is never flagged.
  // Minimum repeated list items (in the rendered DOM, near a sentinel) before a
  // page is considered to have a genuine scrolled content list.
  INFINITE_SCROLL_MIN_LIST_ITEMS: 5,
  // Fraction of the rendered item count that must also be present in the served
  // HTML for the content to count as crawlable (server-rendered). Below this, the
  // list is treated as JS-injected.
  INFINITE_SCROLL_SERVED_FRACTION: 0.5,
  BACKOFF_RESET_TIMEOUT_MS: 300000,
  BACKOFF_BASE_DELAY_MS: 1000,
  BACKOFF_MAX_DELAY_MS: 30000,
  RETRY_DELAY_BASE_MS: 2000,
  CRUX_BATCH_SIZE: 5,
  CRUX_BATCH_DELAY_MS: 200,
  PROGRESS_REPORT_INTERVAL_MS: 2000,
  MAX_TITLE_LENGTH: 500,
  MAX_DESCRIPTION_LENGTH: 1000,
  VALIDATOR_TIMEOUT_MS: 30000,
  EXTERNAL_LINK_VERIFY_CONCURRENCY: 5,
  EXTERNAL_LINK_VERIFY_TIMEOUT: 10000,
  EXTERNAL_LINK_VERIFY_MAX_URLS: 500,
} as const;

// Viewport settings (mobile-first)
export const VIEWPORT = {
  WIDTH: 414,
  HEIGHT: 896,
  DEVICE_SCALE_FACTOR: 1,
} as const;

/** Desktop viewport used for representative-page evidence captures. */
export const DESKTOP_VIEWPORT = {
  WIDTH: 1280,
  HEIGHT: 800,
} as const;

/**
 * Default User-Agent for crawling. Playwright's out-of-the-box UA contains
 * "HeadlessChrome", which many WAFs / bot-protection layers answer with 403 —
 * silently shrinking coverage (e.g. content articles returning 403). A real
 * mobile-Chrome UA matches the mobile viewport above and crawls like Google's
 * mobile-first bot. Override per-audit via `crawl.userAgent` in the config.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// Performance and SEO thresholds
export const THRESHOLDS = {
  // Core Web Vitals (Google's recommended thresholds)
  TTFB: 800,
  FCP: 1800,
  LCP: 2500,
  CLS: 0.1,
  INP: 200,

  // Connection timing (ms) — a TLS handshake above this is flagged "Slow TLS
  // negotiation". Shared by the producing analyzer and the live verifier.
  TLS_HANDSHAKE: 100,

  // Lab metrics (Lighthouse-style thresholds)
  TBT: 200,
  TTI: 3800,
  SPEED_INDEX: 3400,

  // Page metrics
  PAGE_SIZE: 6_000_000,
  REQUEST_COUNT: 20,

  // Content
  TITLE_MIN: 30,
  TITLE_MAX: 60,
  DESCRIPTION_MIN: 120,
  DESCRIPTION_MAX: 160,
  CONTENT_MIN: 300,
  CONTENT_RECOMMENDED: 600,
  H2_COUNT: 10,

  // Content Quality
  TEXT_TO_HTML_RATIO_MIN: 25,
  READABILITY_TARGET: 60,
  KEYWORD_DENSITY_MAX: 3,
  PARAGRAPH_MIN: 3,
  SENTENCE_AVG_WORDS: 20,

  // Technical SEO
  URL_LENGTH_RECOMMENDED: 75,
  URL_LENGTH_MAX: 100,
  URL_DEPTH_MAX: 3,

  // Performance Optimization
  IMAGE_SIZE_MAX: 200_000,
  IMAGE_SIZE_WARNING: 100_000,
  TOTAL_IMAGE_SIZE_MAX: 1_000_000,
  LAZY_LOAD_THRESHOLD: 3,
  RENDER_BLOCKING_MAX: 5,
  UNMINIFIED_SIZE_THRESHOLD: 10000,
  INLINE_CSS_SIZE_WARNING: 50_000,
  INLINE_JS_SIZE_WARNING: 50_000,
  CRITICAL_CSS_SIZE_WARNING: 100_000,
  DOCUMENT_SIZE_WARNING: 100_000,

  // Accessibility (WCAG 2.1 Level AA)
  COLOR_CONTRAST_MIN_NORMAL: 4.5,
  COLOR_CONTRAST_MIN_LARGE: 3,
  MAX_TABINDEX: 0,
  MIN_TOUCH_TARGET_SIZE: 44,

  // Freshness (days)
  FRESHNESS_EXCELLENT: 7,
  FRESHNESS_GOOD: 30,
  FRESHNESS_OK: 90,
  FRESHNESS_FAIR: 180,
  FRESHNESS_POOR: 365,
  FRESHNESS_VERY_POOR: 730,

  // DOM Complexity (Lighthouse thresholds)
  DOM_NODES_WARNING: 800,
  DOM_NODES_CRITICAL: 1400,
  DOM_DEPTH_WARNING: 32,
  DOM_CHILDREN_WARNING: 60,

  // Thin Content (word count)
  THIN_CONTENT_BARE_MIN: 100,
  THIN_CONTENT_LOW: 300,
  THIN_CONTENT_RECOMMENDED: 600,
  THIN_CONTENT_TEXT_RATIO_MIN: 10,

  // SSL Certificate (days before expiry)
  SSL_EXPIRY_WARNING: 30,
  SSL_EXPIRY_CRITICAL: 7,

  // Cookie lifespan (days). Regulators consider >13 months excessive for
  // analytics/marketing cookies; we use 365 as a round, defensible threshold.
  COOKIE_LIFESPAN_WARNING_DAYS: 365,

  // Above-Fold / Font / Third-Party (bytes)
  ABOVE_FOLD_IMAGE_SIZE: 500_000,
  ABOVE_FOLD_IMAGE_AVG: 300_000,
  FONT_SIZE_CRITICAL: 500_000,
  FONT_SIZE_WARNING: 250_000,
  THIRD_PARTY_SIZE_CRITICAL: 1_000_000,
  THIRD_PARTY_SIZE_WARNING: 500_000,

  // Code coverage
  UNUSED_CODE_BYTES_WARNING: 500_000,

  // Links
  LINKS_PER_PAGE_WARNING: 150,
  LINKS_PER_PAGE_MAX: 300,
  EXTERNAL_LINKS_PER_PAGE_MAX: 50,

  RETRY_ATTEMPTS: 3,
  PAGE_TIMEOUT: 30000,
  CLS_COLLECTION_TIME: 2000,
  FETCH_TIMEOUT: 10000,
  SITEMAP_LIMIT: 50000,
} as const;

/**
 * Scoring constants.
 *
 * Per-category methodology (see lib/scoring/methodologies.ts):
 *   • Performance   — Lighthouse log-normal CDF + weighted average of metrics
 *   • Accessibility — mean of per-page a11yScore (analyzer-computed)
 *   • Security      — mean of per-page securityScore (Observatory deductions)
 *   • SEO           — Ahrefs URL-pass on error-tier issues
 *   • Technical     — Ahrefs URL-pass on error-tier issues
 *   • Overall       — weighted average of category scores
 */
export const SCORING = {
  /** Overall = Σ CATEGORY_WEIGHTS[k] · categoryScores[k]. Sums to 1. */
  CATEGORY_WEIGHTS: {
    seo: 0.3,
    performance: 0.25,
    technical: 0.2,
    accessibility: 0.15,
    security: 0.1,
  } as Record<string, number>,

  /**
   * Overall blends the weighted mean with the WORST category score so a
   * failing category (e.g. SEO 30, Security 29) can't be masked by strong
   * ones: overall = mean·OVERALL_MEAN_WEIGHT + min·(1 − OVERALL_MEAN_WEIGHT).
   * A pure mean reported siro.ai (SEO 30 / Sec 29 / rest ~94) as a reassuring
   * 69; this blend pulls it down to ~51, which is honest for an audit.
   */
  OVERALL_MEAN_WEIGHT: 0.55,

  /**
   * Per-metric weights for the Performance composite (Core Web Vitals + lab).
   * Mirrors Lighthouse 10 weighting with TBT swapped for INP (per Web Vitals).
   * Sums to 100 so the result is a percentage.
   */
  PERFORMANCE_METRIC_WEIGHTS: {
    LCP: 25,
    INP: 30,
    CLS: 25,
    FCP: 10,
    TTFB: 10,
  } as Record<string, number>,

  /**
   * Log-normal CDF control points per metric.
   * `p10` (top-decile site value) → score 90; `median` → score 50.
   * Numbers from web.dev / HTTPArchive (the same source Lighthouse uses).
   * https://web.dev/articles/defining-core-web-vitals-thresholds
   */
  PERFORMANCE_CONTROL_POINTS: {
    LCP: { p10: 1220, median: 2500 },
    INP: { p10: 50, median: 200 },
    CLS: { p10: 0.025, median: 0.1 },
    FCP: { p10: 934, median: 1800 },
    TTFB: { p10: 200, median: 800 },
  } as Record<string, { p10: number; median: number }>,

  /**
   * Quick-win classification thresholds (impact score 0-100, effort in
   * minutes). Used only by identifyQuickWins(); not part of category scoring.
   */
  QUICK_WIN_MIN_IMPACT: 40,
  QUICK_WIN_MAX_EFFORT_MINUTES: 30,
  QUICK_WIN_MAX_RESULTS: 10,

  /** Tier→impact-score for quick-win sorting (Ahrefs only counts errors). */
  TIER_IMPACT_BASE: {
    error: 80,
    warning: 40,
    notice: 15,
  } as Record<string, number>,
} as const;

/**
 * Network throttling conditions for performance testing
 *
 * Chrome DevTools Protocol uses bytes/second for throughput.
 * Formula: (speed_in_kbps * 1000) / 8 = bytes/second
 *
 * Efficiency factors account for TCP overhead, packet loss, and real-world conditions:
 * - 0.8 = 80% efficiency (worst case, high latency networks)
 * - 0.9 = 90% efficiency (moderate networks)
 * - 1.5 = Burst capacity factor for low-latency networks
 *
 * Latency multipliers simulate real-world round-trip times:
 * - Base latency x 5 for slow 3G (high jitter, retransmissions)
 * - Base latency x 3.75 for fast 3G (moderate overhead)
 */
export const NETWORK_CONDITIONS: Record<string, NetworkCondition> = {
  slow3g: {
    download: ((500 * 1000) / 8) * 0.8,
    upload: ((500 * 1000) / 8) * 0.8,
    latency: 400 * 5,
    name: 'slow3g',
  },
  fast3g: {
    download: ((1.6 * 1000 * 1000) / 8) * 0.9,
    upload: ((750 * 1000) / 8) * 0.9,
    latency: 150 * 3.75,
    name: 'fast3g',
  },
  slow4g: {
    download: ((1.6 * 1000 * 1000) / 8) * 1.5,
    upload: ((750 * 1000) / 8) * 1.5,
    latency: 150,
    name: 'slow4g',
  },
  normal: {
    noThrottle: true,
    name: 'normal',
  },
};

// CPU throttling conditions
export const CPU_CONDITIONS: Record<string, CpuCondition> = {
  normal: {
    noThrottle: true,
    name: 'normal',
  },
  slow: {
    rate: 4,
    name: 'slow',
  },
};

// Meta tags configuration - categorized by importance for better error reporting
export const META_TAGS_CONFIG = {
  critical: ['description'] as const,
  social_required: ['og:title', 'og:description', 'og:image', 'twitter:card'] as const,
  recommended: [
    'viewport',
    'robots',
    'og:type',
    'og:url',
    'og:site_name',
    'twitter:title',
    'twitter:description',
    'twitter:image',
  ] as const,
  optional: ['twitter:site', 'twitter:creator', 'author', 'theme-color', 'og:locale', 'og:image:alt'] as const,
  deprecated: ['keywords'] as const,
};

// Flat list for backwards compatibility
export const META_TAGS: string[] = [
  ...META_TAGS_CONFIG.critical,
  ...META_TAGS_CONFIG.social_required,
  ...META_TAGS_CONFIG.recommended,
];

/**
 * Get severity for a missing meta tag
 */
export function getMetaTagSeverity(tagName: string): SeverityLevel | null {
  if ((META_TAGS_CONFIG.critical as readonly string[]).includes(tagName)) return SEVERITY.HIGH;
  if ((META_TAGS_CONFIG.social_required as readonly string[]).includes(tagName)) return SEVERITY.MEDIUM;
  if ((META_TAGS_CONFIG.recommended as readonly string[]).includes(tagName)) return SEVERITY.LOW;
  return null;
}

// Patterns that indicate crawler/infrastructure errors, not website issues
export const CRAWLER_ERROR_PATTERNS = [
  'TimeoutError',
  'Target page, context or browser has been closed',
  'page.goto:',
  'net::ERR_',
  'NS_ERROR_',
  'Navigation failed',
  'Protocol error',
  'Session closed',
  'Connection refused',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
] as const;

/**
 * Check if an issue is a crawler error (not a website issue)
 */
export function isCrawlerError(issue: string): boolean {
  return CRAWLER_ERROR_PATTERNS.some((pattern) => issue.includes(pattern));
}

// Severity sort order for issue prioritization
export const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Stop words for text analysis (keyword extraction, anchor text analysis)
// Core grammatical stop words plus common words that don't carry keyword value
export const STOP_WORDS = new Set([
  // Articles & determiners
  'a', 'an', 'the',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into', 'about', 'after', 'over',
  // Be verbs
  'is', 'was', 'are', 'were', 'been', 'be', 'am', 'being',
  // Have verbs
  'have', 'has', 'had', 'having',
  // Do verbs
  'do', 'does', 'did',
  // Modal verbs
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  // Pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose',
  // Adverbs & common words
  'where', 'when', 'why', 'how', 'not', 'no', 'only', 'very', 'just', 'also', 'now', 'here', 'there',
  'too', 'then', 'than', 'so', 'up', 'out', 'if',
  // Common function words
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'own', 'same', 'any',
  // Common verbs with little keyword value
  'said', 'say', 'get', 'go', 'make', 'know', 'take', 'see', 'come', 'think', 'look', 'want', 'give', 'use', 'used',
  // Common nouns/misc with little keyword value
  'people', 'time', 'year', 'day', 'way', 'one', 'two', 'good', 'new', 'first', 'well', 'even', 'back', 'work',
]) as ReadonlySet<string>;

// Generic anchor texts that provide no SEO value
export const GENERIC_ANCHORS = [
  'click here',
  'here',
  'read more',
  'more',
  'learn more',
  'continue',
  'continue reading',
  'link',
  'this link',
  'click',
  'go',
  'visit',
  'see more',
  'view more',
  'details',
  'more details',
  'more info',
  'more information',
  'info',
  'information',
  'website',
  'page',
  'this page',
  'this',
  'find out more',
  'download',
] as const;

/**
 * Normalize text for comparison (handles whitespace variations, HTML entities, Unicode)
 * Used for duplicate detection to reduce false positives
 */
export function normalizeTextForComparison(text: string): string {
  if (!text) return '';

  let normalized = text;

  // 1. Decode common HTML entities
  const htmlEntities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '-',
    '&mdash;': '-',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&hellip;': '...',
    '&copy;': '(c)',
    '&reg;': '(r)',
    '&trade;': '(tm)',
  };

  for (const [entity, char] of Object.entries(htmlEntities)) {
    normalized = normalized.split(entity).join(char);
  }

  // 2. Decode numeric HTML entities (&#123; or &#x7B;)
  normalized = normalized.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  normalized = normalized.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  // 3. Normalize Unicode variants (NFKC converts compatibility characters)
  try {
    normalized = normalized.normalize('NFKC');
  } catch {
    // Fallback if normalize() is not available
  }

  // 4. Replace common Unicode punctuation with ASCII equivalents
  const unicodePunctuation: Record<string, string> = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2026': '...',
    '\u00A0': ' ',
  };

  for (const [unicode, ascii] of Object.entries(unicodePunctuation)) {
    normalized = normalized.split(unicode).join(ascii);
  }

  // 5. Collapse whitespace and trim
  normalized = normalized.trim().replace(/\s+/g, ' ').toLowerCase();

  return normalized;
}
