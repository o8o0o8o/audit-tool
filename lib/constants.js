/**
 * Constants and Configuration
 * Centralized configuration for thresholds, severity levels, and error codes
 */

// Known error messages to track
const KNOWN_ERRORS = ["ERR_TOO_MANY_REDIRECTS"];

// Issue severity levels
const SEVERITY = {
  CRITICAL: 'critical',  // Blocks indexing or causes major issues
  HIGH: 'high',          // Significant SEO impact
  MEDIUM: 'medium',      // Moderate impact, should fix
  LOW: 'low',            // Minor issues, nice to fix
};

// Crawl settings
const CRAWL_SETTINGS = {
  DEFAULT_CONCURRENCY: 5,
  MAX_CONCURRENCY: 20,
  BATCH_SIZE: 100, // Pages per batch file (configurable via config file)
  MAX_EXAMPLES_PER_ISSUE: 100, // Limit error examples to prevent memory issues
  MAX_TOTAL_ISSUE_COUNT: 1000000, // Safety limit for issue counts
  MAX_DISCOVERED_URLS: 100000, // Maximum URLs to discover via link crawling
  MAX_INCOMING_LINKS: 100000, // Maximum incoming link entries to prevent OOM on large sites
  ANALYZER_TIMEOUT: 10000, // milliseconds - timeout for individual analyzer groups
  BATCH_TIMEOUT: 300000, // milliseconds (5 minutes) - overall timeout for each batch to prevent indefinite hangs
  MAX_TITLE_LENGTH: 500, // Maximum title length to store (prevent memory issues)
  MAX_DESCRIPTION_LENGTH: 1000, // Maximum description length to store
};

// Viewport settings (mobile-first)
const VIEWPORT = {
  WIDTH: 414,
  HEIGHT: 896,
  DEVICE_SCALE_FACTOR: 1,
};

// Performance and SEO thresholds
const THRESHOLDS = {
  // Core Web Vitals (Google's recommended thresholds)
  TTFB: 800, // milliseconds
  FCP: 1800, // milliseconds - First Contentful Paint (good < 1.8s)
  LCP: 2500, // milliseconds - Largest Contentful Paint (good < 2.5s)
  CLS: 0.1, // Cumulative Layout Shift (good < 0.1)
  INP: 200, // milliseconds - Interaction to Next Paint (good < 200ms)

  // Lab metrics (Lighthouse-style thresholds)
  TBT: 200, // milliseconds - Total Blocking Time (good < 200ms)
  TTI: 3800, // milliseconds - Time to Interactive (good < 3.8s)
  SPEED_INDEX: 3400, // Speed Index (good < 3.4s)

  // Page metrics
  PAGE_SIZE: 6_000_000, // bytes
  REQUEST_COUNT: 20,

  // Content
  TITLE_MIN: 30, // characters
  TITLE_MAX: 60, // characters
  DESCRIPTION_MIN: 120, // characters
  DESCRIPTION_MAX: 160, // characters
  CONTENT_MIN: 300, // words minimum for quality content
  CONTENT_RECOMMENDED: 600, // words recommended for quality content
  H2_COUNT: 10,

  // Content Quality
  TEXT_TO_HTML_RATIO_MIN: 25, // percentage - minimum text content vs HTML code
  READABILITY_TARGET: 60, // Flesch Reading Ease target (60-70 = standard)
  KEYWORD_DENSITY_MAX: 3, // percentage - avoid keyword stuffing
  PARAGRAPH_MIN: 3, // minimum paragraphs for quality content
  SENTENCE_AVG_WORDS: 20, // average words per sentence (readability)

  // Technical SEO
  URL_LENGTH_RECOMMENDED: 75, // characters - recommended max
  URL_LENGTH_MAX: 100, // characters - absolute max
  URL_DEPTH_MAX: 3, // maximum depth from root (excluding domain)

  // Performance Optimization
  IMAGE_SIZE_MAX: 200_000, // bytes - 200KB max per image
  IMAGE_SIZE_WARNING: 100_000, // bytes - 100KB warning threshold
  TOTAL_IMAGE_SIZE_MAX: 1_000_000, // bytes - 1MB total images per page
  LAZY_LOAD_THRESHOLD: 3, // images - pages with 3+ images should use lazy loading
  RENDER_BLOCKING_MAX: 5, // maximum render-blocking resources
  UNMINIFIED_SIZE_THRESHOLD: 10000, // bytes - check minification for files > 10KB

  // Accessibility (WCAG 2.1 Level AA)
  COLOR_CONTRAST_MIN_NORMAL: 4.5, // minimum contrast ratio for normal text
  COLOR_CONTRAST_MIN_LARGE: 3, // minimum contrast ratio for large text (18pt+)
  MAX_TABINDEX: 0, // tabindex should be 0 or -1 (avoid positive values)
  MIN_TOUCH_TARGET_SIZE: 44, // pixels - minimum touch target size (WCAG 2.5.5)

  RETRY_ATTEMPTS: 3,
  PAGE_TIMEOUT: 30000, // milliseconds
  CLS_COLLECTION_TIME: 2000, // milliseconds - wait for CLS after LCP
  FETCH_TIMEOUT: 10000, // milliseconds
  SITEMAP_LIMIT: 50000,
};

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
 * - Base latency × 5 for slow 3G (high jitter, retransmissions)
 * - Base latency × 3.75 for fast 3G (moderate overhead)
 */
const NETWORK_CONDITIONS = {
  slow3g: {
    // 500 Kbps with 80% efficiency, ~2000ms RTT
    download: ((500 * 1000) / 8) * 0.8,   // ~50,000 bytes/sec
    upload: ((500 * 1000) / 8) * 0.8,     // ~50,000 bytes/sec
    latency: 400 * 5,                      // 2000ms (base 400ms × 5 for retransmissions)
    name: "slow3g",
  },
  fast3g: {
    // 1.6 Mbps with 90% efficiency, ~562ms RTT
    download: ((1.6 * 1000 * 1000) / 8) * 0.9,  // ~180,000 bytes/sec
    upload: ((750 * 1000) / 8) * 0.9,            // ~84,375 bytes/sec
    latency: 150 * 3.75,                          // 562ms (base 150ms × 3.75 for overhead)
    name: "fast3g",
  },
  slow4g: {
    // 1.6 Mbps with burst capacity, 150ms RTT (LTE edge conditions)
    download: ((1.6 * 1000 * 1000) / 8) * 1.5,  // ~300,000 bytes/sec
    upload: ((750 * 1000) / 8) * 1.5,            // ~140,625 bytes/sec
    latency: 150,                                 // 150ms base latency
    name: "slow4g",
  },
  normal: {
    noThrottle: true,
    name: "normal",
  },
};

// CPU throttling conditions
const CPU_CONDITIONS = {
  normal: {
    noThrottle: true,
    name: "normal",
  },
  slow: {
    rate: 4, // 4x slowdown
    name: "slow",
  },
};

// Meta tags configuration - categorized by importance for better error reporting
const META_TAGS_CONFIG = {
  // Critical - directly affects SERP appearance or indexing
  critical: [
    "description",      // Affects SERP snippet and CTR
  ],
  // Important for social sharing (report as warnings if missing)
  social_required: [
    "og:title",
    "og:description",
    "og:image",
    "twitter:card",
  ],
  // Recommended but not critical (report as low severity)
  recommended: [
    "viewport",         // Important for mobile UX, but checked in detail by MobileFriendlyAnalyzer
    "robots",           // Important but default behavior (index,follow) is fine
    "og:type",
    "og:url",
    "og:site_name",
    "twitter:title",
    "twitter:description",
    "twitter:image",
  ],
  // Optional - nice to have, don't report as errors
  optional: [
    "twitter:site",
    "twitter:creator",
    "author",
    "theme-color",
    "og:locale",
    "og:image:alt",
  ],
  // Deprecated - warn if present that they're not needed
  deprecated: [
    "keywords", // Google ignores this since 2009
  ],
};

// Flat list for backwards compatibility
const META_TAGS = [
  ...META_TAGS_CONFIG.critical,
  ...META_TAGS_CONFIG.social_required,
  ...META_TAGS_CONFIG.recommended,
];

// Get severity for a missing meta tag
function getMetaTagSeverity(tagName) {
  if (META_TAGS_CONFIG.critical.includes(tagName)) return SEVERITY.HIGH;
  if (META_TAGS_CONFIG.social_required.includes(tagName)) return SEVERITY.MEDIUM;
  if (META_TAGS_CONFIG.recommended.includes(tagName)) return SEVERITY.LOW;
  return null; // Don't report for optional/deprecated
}

/**
 * Normalize text for comparison (handles whitespace variations, HTML entities, Unicode)
 * Used for duplicate detection to reduce false positives
 * @param {string} text - Text to normalize
 * @returns {string} Normalized text
 */
function normalizeTextForComparison(text) {
  if (!text) return '';

  let normalized = text;

  // 1. Decode common HTML entities
  const htmlEntities = {
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

  // 3. Normalize Unicode variants
  // Use NFKC normalization to handle compatibility characters
  // This converts things like ﬁ → fi, ² → 2, etc.
  try {
    normalized = normalized.normalize('NFKC');
  } catch {
    // Fallback if normalize() is not available
  }

  // 4. Replace common Unicode punctuation with ASCII equivalents
  const unicodePunctuation = {
    '\u2018': "'",  // Left single quote
    '\u2019': "'",  // Right single quote
    '\u201C': '"',  // Left double quote
    '\u201D': '"',  // Right double quote
    '\u2013': '-',  // En dash
    '\u2014': '-',  // Em dash
    '\u2026': '...', // Ellipsis
    '\u00A0': ' ',  // Non-breaking space
  };

  for (const [unicode, ascii] of Object.entries(unicodePunctuation)) {
    normalized = normalized.split(unicode).join(ascii);
  }

  // 5. Collapse whitespace and trim
  normalized = normalized
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  return normalized;
}

module.exports = {
  KNOWN_ERRORS,
  SEVERITY,
  THRESHOLDS,
  CRAWL_SETTINGS,
  VIEWPORT,
  NETWORK_CONDITIONS,
  CPU_CONDITIONS,
  META_TAGS,
  META_TAGS_CONFIG,
  getMetaTagSeverity,
  normalizeTextForComparison,
};
