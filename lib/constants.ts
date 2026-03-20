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

// Performance and SEO thresholds
export const THRESHOLDS = {
  // Core Web Vitals (Google's recommended thresholds)
  TTFB: 800,
  FCP: 1800,
  LCP: 2500,
  CLS: 0.1,
  INP: 200,

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

  // Above-Fold / Font / Third-Party (bytes)
  ABOVE_FOLD_IMAGE_SIZE: 500_000,
  ABOVE_FOLD_IMAGE_AVG: 300_000,
  FONT_SIZE_CRITICAL: 500_000,
  FONT_SIZE_WARNING: 250_000,
  THIRD_PARTY_SIZE_CRITICAL: 1_000_000,
  THIRD_PARTY_SIZE_WARNING: 500_000,

  // Links
  LINKS_PER_PAGE_MAX: 300,
  EXTERNAL_LINKS_PER_PAGE_MAX: 50,

  RETRY_ATTEMPTS: 3,
  PAGE_TIMEOUT: 30000,
  CLS_COLLECTION_TIME: 2000,
  FETCH_TIMEOUT: 10000,
  SITEMAP_LIMIT: 50000,
} as const;

// Scoring weights and thresholds for ScoreCalculator
export const SCORING = {
  // Overall score: weighted average of category scores
  CATEGORY_WEIGHTS: {
    seo: 0.3,
    performance: 0.25,
    technical: 0.2,
    accessibility: 0.15,
    security: 0.1,
  } as Record<string, number>,

  // Penalty weight per issue severity
  SEVERITY_WEIGHTS: {
    critical: 5,
    high: 3,
    medium: 1,
    low: 0.3,
  } as Record<string, number>,

  // Impact score base values per severity (for quick wins)
  IMPACT_BASE_SCORES: {
    critical: 100,
    high: 70,
    medium: 40,
    low: 20,
  } as Record<string, number>,

  // Default scores for categories lacking page-level data
  DEFAULT_CATEGORY_SCORES: {
    accessibility: 70,
    security: 70,
  },

  // Log penalty scales per category (higher = steeper penalty curve)
  LOG_PENALTY_SCALE: {
    seo: 8,
    performance: 9,
    technical: 9,
  },

  // Breadth multiplier: scales penalty by proportion of affected pages
  BREADTH_MULTIPLIER_FACTOR: 4,
  BREADTH_MULTIPLIER_MAX: 5,

  // Page multiplier for impact score: max 3x based on affected count / 10
  IMPACT_PAGE_DIVISOR: 10,
  IMPACT_PAGE_MULTIPLIER_MAX: 3,
  IMPACT_PAGE_BOOST_FACTOR: 0.3,

  // Quick win thresholds
  QUICK_WIN_MIN_IMPACT: 40,
  QUICK_WIN_MAX_EFFORT_MINUTES: 30,
  QUICK_WIN_MAX_RESULTS: 10,
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
