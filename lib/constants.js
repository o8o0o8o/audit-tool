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

// Network throttling conditions
const NETWORK_CONDITIONS = {
  slow3g: {
    download: ((500 * 1000) / 8) * 0.8,
    upload: ((500 * 1000) / 8) * 0.8,
    latency: 400 * 5,
    name: "slow3g",
  },
  fast3g: {
    download: ((1.6 * 1000 * 1000) / 8) * 0.9,
    upload: ((750 * 1000) / 8) * 0.9,
    latency: 150 * 3.75,
    name: "fast3g",
  },
  slow4g: {
    download: ((1.6 * 1000 * 1000) / 8) * 1.5,
    upload: ((750 * 1000) / 8) * 1.5,
    latency: 150,
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

module.exports = {
  KNOWN_ERRORS,
  SEVERITY,
  THRESHOLDS,
  NETWORK_CONDITIONS,
  CPU_CONDITIONS,
  META_TAGS,
  META_TAGS_CONFIG,
  getMetaTagSeverity,
};
