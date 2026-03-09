/**
 * Metrics Metadata for HTML Reports
 * Extends THRESHOLDS with display information and descriptions
 */

const { THRESHOLDS, SEVERITY } = require('../constants');

// Re-export THRESHOLDS for convenience
module.exports.THRESHOLDS = THRESHOLDS;
module.exports.SEVERITY = SEVERITY;

/**
 * Metric information for display in reports
 * Includes name, description, unit, and threshold info
 */
const METRIC_INFO = {
  ttfb: {
    name: 'TTFB',
    fullName: 'Time to First Byte',
    description: 'Time from request start until the first byte of the response is received',
    unit: 'ms',
    threshold: THRESHOLDS.TTFB,
    isInverse: true, // Lower is better
    goodLabel: `≤${THRESHOLDS.TTFB}ms`,
    badLabel: `>${THRESHOLDS.TTFB}ms`,
    learnMore: 'https://web.dev/ttfb/',
  },
  fcp: {
    name: 'FCP',
    fullName: 'First Contentful Paint',
    description: 'Time until the browser renders the first piece of content from the DOM',
    unit: 'ms',
    threshold: THRESHOLDS.FCP,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.FCP}ms`,
    badLabel: `>${THRESHOLDS.FCP}ms`,
    learnMore: 'https://web.dev/fcp/',
  },
  lcp: {
    name: 'LCP',
    fullName: 'Largest Contentful Paint',
    description: 'Time until the largest content element is rendered in the viewport',
    unit: 'ms',
    threshold: THRESHOLDS.LCP,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.LCP}ms`,
    badLabel: `>${THRESHOLDS.LCP}ms`,
    learnMore: 'https://web.dev/lcp/',
  },
  cls: {
    name: 'CLS',
    fullName: 'Cumulative Layout Shift',
    description: 'Measures visual stability by tracking unexpected layout shifts',
    unit: '',
    threshold: THRESHOLDS.CLS,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.CLS}`,
    badLabel: `>${THRESHOLDS.CLS}`,
    learnMore: 'https://web.dev/cls/',
  },
  inp: {
    name: 'INP',
    fullName: 'Interaction to Next Paint',
    description: 'Time from user interaction to visual update',
    unit: 'ms',
    threshold: THRESHOLDS.INP,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.INP}ms`,
    badLabel: `>${THRESHOLDS.INP}ms`,
    learnMore: 'https://web.dev/inp/',
  },
  pageSize: {
    name: 'Page Size',
    fullName: 'Total Page Size',
    description: 'Total size of all resources loaded by the page',
    unit: 'bytes',
    threshold: THRESHOLDS.PAGE_SIZE,
    isInverse: true,
    goodLabel: `≤${(THRESHOLDS.PAGE_SIZE / 1_000_000).toFixed(1)}MB`,
    badLabel: `>${(THRESHOLDS.PAGE_SIZE / 1_000_000).toFixed(1)}MB`,
  },
  requestCount: {
    name: 'Requests',
    fullName: 'Total Requests',
    description: 'Number of HTTP requests made by the page',
    unit: '',
    threshold: THRESHOLDS.REQUEST_COUNT,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.REQUEST_COUNT}`,
    badLabel: `>${THRESHOLDS.REQUEST_COUNT}`,
  },
  titleLength: {
    name: 'Title Length',
    fullName: 'Title Tag Length',
    description: 'Number of characters in the page title',
    unit: 'chars',
    min: THRESHOLDS.TITLE_MIN,
    max: THRESHOLDS.TITLE_MAX,
    goodLabel: `${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX} chars`,
  },
  descriptionLength: {
    name: 'Description Length',
    fullName: 'Meta Description Length',
    description: 'Number of characters in the meta description',
    unit: 'chars',
    min: THRESHOLDS.DESCRIPTION_MIN,
    max: THRESHOLDS.DESCRIPTION_MAX,
    goodLabel: `${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX} chars`,
  },
  urlLength: {
    name: 'URL Length',
    fullName: 'URL Length',
    description: 'Number of characters in the URL path',
    unit: 'chars',
    recommended: THRESHOLDS.URL_LENGTH_RECOMMENDED,
    max: THRESHOLDS.URL_LENGTH_MAX,
    goodLabel: `≤${THRESHOLDS.URL_LENGTH_RECOMMENDED} chars`,
  },
  urlDepth: {
    name: 'URL Depth',
    fullName: 'URL Directory Depth',
    description: 'Number of directory levels in the URL path',
    unit: 'levels',
    threshold: THRESHOLDS.URL_DEPTH_MAX,
    isInverse: true,
    goodLabel: `≤${THRESHOLDS.URL_DEPTH_MAX} levels`,
  },

  // ===== E-E-A-T SIGNALS =====
  eeatScore: {
    name: 'E-E-A-T Score',
    fullName: 'Experience, Expertise, Authoritativeness, Trustworthiness',
    description: 'Google evaluates E-E-A-T to assess content quality. Higher scores indicate better author attribution, trust signals, and expertise indicators.',
    unit: '',
    threshold: 50,
    goodLabel: '≥50',
    badLabel: '<50',
    learnMore: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
  },
  authorPresent: {
    name: 'Author Info',
    fullName: 'Author Attribution',
    description: 'Presence of author name, bio, or schema markup. Author attribution helps establish content credibility and expertise.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },
  authorCredentials: {
    name: 'Author Credentials',
    fullName: 'Author Credentials & Expertise',
    description: 'Author qualifications, certifications, or expertise indicators (e.g., "Dr.", "PhD", "certified").',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Not found',
  },
  trustSignals: {
    name: 'Trust Signals',
    fullName: 'Trust & Authority Signals',
    description: 'Indicators of trustworthiness: contact info, privacy policy, terms of service, about page, physical address.',
    type: 'count',
    goodLabel: '≥3 signals',
    badLabel: '<3 signals',
  },
  ymylPage: {
    name: 'YMYL',
    fullName: 'Your Money or Your Life',
    description: 'Page covers health, finance, legal, or safety topics requiring higher E-E-A-T standards.',
    type: 'boolean',
    note: 'YMYL pages need stronger E-E-A-T signals',
  },

  // ===== CONTENT QUALITY =====
  wordCount: {
    name: 'Word Count',
    fullName: 'Content Word Count',
    description: 'Total words in the main content. Thin content (<300 words) may not rank well. Aim for 600+ words for substantial topics.',
    unit: 'words',
    min: 100,
    recommended: 600,
    goodLabel: '≥600 words',
    badLabel: '<100 words',
  },
  textToHtmlRatio: {
    name: 'Text Ratio',
    fullName: 'Text to HTML Ratio',
    description: 'Percentage of visible text vs total HTML code. Low ratios (<10%) may indicate thin content or code bloat.',
    unit: '%',
    threshold: 10,
    recommended: 25,
    goodLabel: '≥25%',
    badLabel: '<10%',
  },
  readabilityScore: {
    name: 'Readability',
    fullName: 'Flesch Reading Ease',
    description: 'How easy the content is to read. 60-70 is ideal for most audiences. Higher = easier to read.',
    unit: '',
    threshold: 60,
    goodLabel: '60-70 (standard)',
    learnMore: 'https://en.wikipedia.org/wiki/Flesch%E2%80%93Kincaid_readability_tests',
  },
  paragraphCount: {
    name: 'Paragraphs',
    fullName: 'Paragraph Count',
    description: 'Number of content paragraphs. Well-structured content improves readability and user engagement.',
    unit: '',
    min: 2,
    goodLabel: '≥3 paragraphs',
  },
  contentScore: {
    name: 'Content Score',
    fullName: 'Overall Content Quality Score',
    description: 'Combined score based on word count, text ratio, structure, and readability. Higher is better (0-100).',
    unit: '',
    threshold: 50,
    goodLabel: '≥50',
    badLabel: '<50',
  },

  // ===== CONTENT FRESHNESS =====
  lastModified: {
    name: 'Last Modified',
    fullName: 'Last Modified Date',
    description: 'When the page was last updated (from HTTP headers or schema). Fresh content may rank better for time-sensitive queries.',
    type: 'date',
    note: 'Important for news, articles, and time-sensitive content',
  },
  datePublished: {
    name: 'Published',
    fullName: 'Publication Date',
    description: 'Original publication date from schema.org markup. Helps search engines understand content timeline.',
    type: 'date',
  },
  freshnessScore: {
    name: 'Freshness',
    fullName: 'Content Freshness Score',
    description: 'How recently content was updated. Critical for news/blogs. Score decreases as content ages.',
    unit: '',
    threshold: 50,
    goodLabel: 'Recent update',
    badLabel: 'Stale content',
  },
  contentAge: {
    name: 'Content Age',
    fullName: 'Days Since Last Update',
    description: 'Number of days since last modification. Older content may need refreshing for competitive topics.',
    unit: 'days',
    note: 'Consider updating content older than 1 year',
  },

  // ===== STRUCTURED DATA =====
  hasStructuredData: {
    name: 'Schema',
    fullName: 'Structured Data (Schema.org)',
    description: 'JSON-LD or microdata markup that helps search engines understand page content and enables rich results.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
    learnMore: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
  },
  schemaTypes: {
    name: 'Schema Types',
    fullName: 'Structured Data Types',
    description: 'Types of schema markup found (Article, Product, FAQPage, etc.). Different types enable different rich results.',
    type: 'list',
  },
  schemaErrors: {
    name: 'Schema Errors',
    fullName: 'Structured Data Validation Errors',
    description: 'Missing required fields or invalid values in schema markup. Errors prevent rich results from appearing.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 errors',
    badLabel: 'Has errors',
  },
  schemaWarnings: {
    name: 'Schema Warnings',
    fullName: 'Structured Data Recommendations',
    description: 'Optional but recommended fields missing from schema. Adding these may improve rich result appearance.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 warnings',
  },

  // ===== TECHNICAL SEO =====
  metaRefresh: {
    name: 'Meta Refresh',
    fullName: 'Meta Refresh Redirect',
    description: 'Client-side redirect using meta refresh tag. Search engines prefer 301/302 server redirects.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'Not used',
    badLabel: 'Using meta refresh',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects',
  },
  jsFramework: {
    name: 'JS Framework',
    fullName: 'JavaScript Framework',
    description: 'Detected framework (React, Vue, Angular, etc.). Client-side rendering may have indexing issues without SSR.',
    type: 'string',
    note: 'Ensure SSR/prerendering for JS frameworks',
  },
  hasSSR: {
    name: 'SSR',
    fullName: 'Server-Side Rendering',
    description: 'Content is rendered server-side. Important for SEO when using JavaScript frameworks.',
    type: 'boolean',
    goodLabel: 'Detected',
    note: 'Critical for JS framework sites',
  },
  cms: {
    name: 'CMS',
    fullName: 'Content Management System',
    description: 'Detected CMS platform (WordPress, Shopify, etc.). Helps identify common optimization patterns.',
    type: 'string',
  },
  amp: {
    name: 'AMP',
    fullName: 'Accelerated Mobile Pages',
    description: 'Page uses AMP framework for fast mobile loading. May appear in special Google mobile search results.',
    type: 'boolean',
    learnMore: 'https://amp.dev/',
  },
  pwa: {
    name: 'PWA',
    fullName: 'Progressive Web App',
    description: 'Site has PWA capabilities (manifest, service worker). Enables app-like experience and offline access.',
    type: 'boolean',
  },
  hasLazyLoading: {
    name: 'Lazy Loading',
    fullName: 'Image Lazy Loading',
    description: 'Images load as user scrolls. Improves initial page load and Core Web Vitals.',
    type: 'boolean',
    goodLabel: 'Implemented',
  },
  preloadCount: {
    name: 'Preload',
    fullName: 'Resource Preload Hints',
    description: 'Number of resources preloaded for faster critical rendering. Important for LCP optimization.',
    type: 'count',
    note: 'Preload critical fonts, images, and scripts',
  },

  // ===== URL ARCHITECTURE =====
  hasTrackingParams: {
    name: 'Tracking Params',
    fullName: 'URL Tracking Parameters',
    description: 'URL contains tracking parameters (utm_, fbclid, etc.). Should be handled with canonical tags to avoid duplicate content.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'Clean URL',
    badLabel: 'Has tracking params',
  },
  hasSessionId: {
    name: 'Session ID',
    fullName: 'Session ID in URL',
    description: 'URL contains session identifiers. Causes duplicate content issues and crawl waste.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'No session ID',
    badLabel: 'Session ID detected',
  },
  urlConsistency: {
    name: 'URL Consistency',
    fullName: 'Trailing Slash Consistency',
    description: 'URLs should consistently use or not use trailing slashes. Inconsistency causes duplicate content.',
    type: 'boolean',
    goodLabel: 'Consistent',
    badLabel: 'Inconsistent',
  },

  // ===== LINK STRUCTURE =====
  internalLinks: {
    name: 'Internal Links',
    fullName: 'Internal Link Count',
    description: 'Number of links to other pages on the same site. Internal linking distributes PageRank and helps crawling.',
    type: 'count',
    note: 'Aim for natural internal linking',
  },
  externalLinks: {
    name: 'External Links',
    fullName: 'External Link Count',
    description: 'Number of links to other websites. Quality external links can improve topical authority.',
    type: 'count',
  },
  hasIncomingLinks: {
    name: 'Incoming Links',
    fullName: 'Has Incoming Internal Links',
    description: 'Whether other pages link to this page. Orphan pages (no incoming links) may not be discovered by crawlers.',
    type: 'boolean',
    goodLabel: 'Has links',
    badLabel: 'Orphan page',
  },
  linkDepth: {
    name: 'Link Depth',
    fullName: 'Click Depth from Homepage',
    description: 'Minimum clicks needed to reach page from homepage. Important pages should be ≤3 clicks away.',
    unit: 'clicks',
    threshold: 3,
    isInverse: true,
    goodLabel: '≤3 clicks',
    badLabel: '>3 clicks',
  },
  isDeadEnd: {
    name: 'Dead End',
    fullName: 'Dead End Page',
    description: 'Page has no outgoing internal links. Dead ends trap users and prevent link equity flow.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'Has outgoing links',
    badLabel: 'Dead end',
  },

  // ===== INDEXABILITY =====
  isIndexable: {
    name: 'Indexable',
    fullName: 'Page Indexability',
    description: 'Whether search engines can index this page. Blocked by noindex, robots.txt, or canonical to another URL.',
    type: 'boolean',
    goodLabel: 'Indexable',
    badLabel: 'Not indexable',
  },
  hasCanonical: {
    name: 'Canonical',
    fullName: 'Canonical URL',
    description: 'Self-referencing or cross-domain canonical tag. Prevents duplicate content issues.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },
  canonicalMatch: {
    name: 'Canonical Match',
    fullName: 'Canonical URL Matches Page URL',
    description: 'Canonical URL should match the page URL (or intentionally point elsewhere). Mismatches cause indexing issues.',
    type: 'boolean',
    goodLabel: 'Match',
    badLabel: 'Mismatch',
  },
  robotsDirective: {
    name: 'Robots',
    fullName: 'Robots Meta Directive',
    description: 'Meta robots tag value (index/noindex, follow/nofollow). Controls how search engines handle the page.',
    type: 'string',
    note: 'Default is "index, follow"',
  },

  // ===== INTERNATIONAL SEO =====
  hasHreflang: {
    name: 'Hreflang',
    fullName: 'Hreflang Tags',
    description: 'Language/region targeting tags for international sites. Helps serve correct language version in search results.',
    type: 'boolean',
    goodLabel: 'Present',
    note: 'Required for multi-language sites',
    learnMore: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  },
  hreflangCount: {
    name: 'Languages',
    fullName: 'Language Versions',
    description: 'Number of language/region versions linked via hreflang. Should include x-default for fallback.',
    type: 'count',
  },
  hreflangReciprocal: {
    name: 'Hreflang Reciprocal',
    fullName: 'Hreflang Return Links',
    description: 'All hreflang pages must link back to each other. Missing return links break hreflang implementation.',
    type: 'boolean',
    goodLabel: 'Valid',
    badLabel: 'Missing return links',
  },

  // ===== HEADINGS =====
  h1Count: {
    name: 'H1 Count',
    fullName: 'H1 Heading Count',
    description: 'Number of H1 tags. Each page should have exactly one H1 describing the main topic.',
    unit: '',
    threshold: 1,
    goodLabel: '1 H1',
    badLabel: '0 or >1 H1',
  },
  h1Text: {
    name: 'H1 Text',
    fullName: 'H1 Heading Content',
    description: 'The main H1 heading text. Should be unique, descriptive, and include target keywords.',
    type: 'string',
  },
  headingStructure: {
    name: 'Heading Structure',
    fullName: 'Heading Hierarchy',
    description: 'Proper nesting of H1-H6 tags without skipping levels. Good structure helps accessibility and SEO.',
    type: 'boolean',
    goodLabel: 'Valid hierarchy',
    badLabel: 'Skipped levels',
  },

  // ===== IMAGES =====
  imagesTotal: {
    name: 'Images',
    fullName: 'Total Images',
    description: 'Number of images on the page. Images enhance content but need optimization.',
    type: 'count',
  },
  imagesMissingAlt: {
    name: 'Missing Alt',
    fullName: 'Images Missing Alt Text',
    description: 'Images without alt attributes. Alt text is required for accessibility and image SEO.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 missing',
    badLabel: 'Has missing alt',
  },
  imagesOptimized: {
    name: 'Optimized Images',
    fullName: 'Image Optimization Status',
    description: 'Images using modern formats (WebP, AVIF) and appropriate sizing. Reduces page weight.',
    type: 'percentage',
    goodLabel: '≥80%',
  },

  // ===== SOCIAL MEDIA =====
  hasOpenGraph: {
    name: 'Open Graph',
    fullName: 'Open Graph Tags',
    description: 'Facebook/social sharing meta tags (og:title, og:image, etc.). Controls how content appears when shared.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
    learnMore: 'https://ogp.me/',
  },
  hasTwitterCards: {
    name: 'Twitter Cards',
    fullName: 'Twitter Card Tags',
    description: 'Twitter-specific sharing tags (twitter:card, twitter:image). Enhances Twitter/X sharing appearance.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
    learnMore: 'https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/abouts-cards',
  },
  ogImage: {
    name: 'OG Image',
    fullName: 'Open Graph Image',
    description: 'Social sharing image. Recommended size: 1200x630px. Pages with images get more engagement.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },

  // ===== SECURITY =====
  isHttps: {
    name: 'HTTPS',
    fullName: 'Secure Connection',
    description: 'Page uses HTTPS encryption. Required for rankings and user trust. HTTP pages show security warnings.',
    type: 'boolean',
    goodLabel: 'Secure',
    badLabel: 'Not secure',
  },
  hasMixedContent: {
    name: 'Mixed Content',
    fullName: 'Mixed Content Issues',
    description: 'HTTPS page loading HTTP resources. Causes security warnings and may block resources.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'No issues',
    badLabel: 'Has mixed content',
  },
  hasSecurityHeaders: {
    name: 'Security Headers',
    fullName: 'HTTP Security Headers',
    description: 'Presence of security headers (CSP, X-Frame-Options, HSTS). Protects against common attacks.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },

  // ===== ACCESSIBILITY =====
  accessibilityScore: {
    name: 'A11y Score',
    fullName: 'Accessibility Score',
    description: 'Overall accessibility compliance score. Based on WCAG 2.1 guidelines. Higher is better (0-100).',
    unit: '',
    threshold: 70,
    goodLabel: '≥70',
    badLabel: '<70',
  },
  hasLangAttribute: {
    name: 'Lang Attribute',
    fullName: 'HTML Language Attribute',
    description: 'HTML lang attribute for screen readers and translation. Required for accessibility.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },
  hasSkipLink: {
    name: 'Skip Link',
    fullName: 'Skip Navigation Link',
    description: 'Link to skip to main content. Helps keyboard users navigate quickly.',
    type: 'boolean',
    goodLabel: 'Present',
  },
  colorContrast: {
    name: 'Color Contrast',
    fullName: 'Text Color Contrast',
    description: 'Text meets WCAG contrast requirements (4.5:1 for normal text, 3:1 for large text).',
    type: 'boolean',
    goodLabel: 'Sufficient',
    badLabel: 'Insufficient',
  },

  // ===== KEYWORD CANNIBALISATION =====
  keywordConflicts: {
    name: 'Keyword Conflicts',
    fullName: 'Keyword Cannibalisation Issues',
    description: 'Multiple pages targeting the same keywords compete against each other in search results.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 conflicts',
    badLabel: 'Has conflicts',
  },
  nearDuplicateTitle: {
    name: 'Duplicate Title',
    fullName: 'Near-Duplicate Title',
    description: 'Page title is very similar to another page. Unique titles help differentiate pages in search.',
    type: 'boolean',
    isInverse: true,
    goodLabel: 'Unique',
    badLabel: 'Near-duplicate',
  },

  // ===== ANALYTICS =====
  hasAnalytics: {
    name: 'Analytics',
    fullName: 'Analytics Tracking',
    description: 'Google Analytics, GTM, or other tracking detected. Essential for measuring SEO performance.',
    type: 'boolean',
    goodLabel: 'Present',
    badLabel: 'Missing',
  },
  analyticsType: {
    name: 'Analytics Type',
    fullName: 'Analytics Platform',
    description: 'Type of analytics (GA4, GTM, Adobe, etc.). GA4 is recommended for SEO tracking.',
    type: 'string',
  },

  // ===== NEW INSIGHTS =====
  internalPageRank: {
    name: 'PageRank',
    fullName: 'Internal PageRank',
    description: 'Relative importance of the page based on internal link structure. Higher values indicate pages that receive more link equity.',
    unit: '',
    note: 'Calculated using iterative PageRank algorithm on internal links',
  },
  languageDetected: {
    name: 'Detected Language',
    fullName: 'Content Language Detection',
    description: 'Language detected from page content using trigram analysis. Should match the html lang attribute.',
    type: 'string',
  },
  languageMatch: {
    name: 'Language Match',
    fullName: 'Language Declaration Match',
    description: 'Whether detected content language matches the declared html lang attribute. Mismatches confuse search engines.',
    type: 'boolean',
    goodLabel: 'Match',
    badLabel: 'Mismatch',
  },
  ctaCount: {
    name: 'CTAs',
    fullName: 'Call-to-Action Count',
    description: 'Number of CTAs (buttons, forms, phone/email links) found on the page. Important for conversion optimization.',
    type: 'count',
    note: 'Includes buttons, forms, tel: and mailto: links',
  },
  ctaAboveFold: {
    name: 'CTAs Above Fold',
    fullName: 'Above-Fold Call-to-Actions',
    description: 'CTAs visible without scrolling. At least one above-fold CTA improves conversion rates.',
    type: 'count',
    goodLabel: '≥1',
    badLabel: '0',
  },
  jsUnused: {
    name: 'Unused JS',
    fullName: 'Unused JavaScript Percentage',
    description: 'Percentage of loaded JavaScript that is not executed. High unused JS wastes bandwidth and slows page load.',
    unit: '%',
    threshold: 50,
    isInverse: true,
    goodLabel: '<50%',
    badLabel: '≥50%',
    learnMore: 'https://web.dev/articles/remove-unused-code',
  },
  cssUnused: {
    name: 'Unused CSS',
    fullName: 'Unused CSS Percentage',
    description: 'Percentage of loaded CSS rules that are not used. Unused CSS increases page weight and render time.',
    unit: '%',
    threshold: 60,
    isInverse: true,
    goodLabel: '<60%',
    badLabel: '≥60%',
    learnMore: 'https://web.dev/articles/unused-css-rules',
  },
  brokenOutboundLinks: {
    name: 'Broken Outbound',
    fullName: 'Broken Outbound Links',
    description: 'External links that return error status codes (4xx, 5xx). Broken outbound links hurt user trust and may affect SEO.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 broken',
    badLabel: 'Has broken links',
  },
  mainContentWords: {
    name: 'Main Words',
    fullName: 'Main Content Word Count',
    description: 'Words in the main content area (excluding nav, header, footer, sidebar). Better reflects actual content depth.',
    unit: 'words',
    min: 200,
    goodLabel: '≥200 words',
    badLabel: '<200 words',
  },
  boilerplateRatio: {
    name: 'Boilerplate %',
    fullName: 'Boilerplate Content Ratio',
    description: 'Percentage of page content in navigation, header, footer, and sidebar vs main content. High ratios indicate thin unique content.',
    unit: '%',
    threshold: 60,
    isInverse: true,
    goodLabel: '<60%',
    badLabel: '≥60%',
  },
  contentSimilarity: {
    name: 'Similar Content',
    fullName: 'Near-Duplicate Content',
    description: 'Pages with highly similar content based on keyword fingerprint analysis. May cause keyword cannibalization.',
    type: 'count',
    isInverse: true,
    goodLabel: '0 similar',
    badLabel: 'Has similar pages',
  },
  responseHeaders: {
    name: 'Response Headers',
    fullName: 'SEO Response Headers',
    description: 'Analysis of HTTP response headers relevant to SEO: Vary, Link, X-Robots-Tag, Content-Language.',
    type: 'object',
  },
};

/**
 * Severity display configuration
 */
const SEVERITY_CONFIG = {
  [SEVERITY.CRITICAL]: {
    label: 'Critical',
    color: '#991b1b',
    bgColor: '#fef2f2',
    borderColor: '#fecaca',
    icon: '🚨',
    priority: 0,
  },
  [SEVERITY.HIGH]: {
    label: 'High',
    color: '#c2410c',
    bgColor: '#fff7ed',
    borderColor: '#fed7aa',
    icon: '⚠️',
    priority: 1,
  },
  [SEVERITY.MEDIUM]: {
    label: 'Medium',
    color: '#b45309',
    bgColor: '#fffbeb',
    borderColor: '#fde68a',
    icon: '📝',
    priority: 2,
  },
  [SEVERITY.LOW]: {
    label: 'Low',
    color: '#166534',
    bgColor: '#f0fdf4',
    borderColor: '#bbf7d0',
    icon: 'ℹ️',
    priority: 3,
  },
};

/**
 * Score thresholds for display
 */
const SCORE_THRESHOLDS = {
  excellent: { min: 90, color: '#10b981', label: 'Excellent' },
  good: { min: 70, color: '#22c55e', label: 'Good' },
  needsWork: { min: 50, color: '#f59e0b', label: 'Needs Work' },
  poor: { min: 0, color: '#ef4444', label: 'Poor' },
};

/**
 * Get score category based on value
 * @param {number} score - Score value (0-100)
 * @returns {Object} Score category with color and label
 */
function getScoreCategory(score) {
  if (score >= SCORE_THRESHOLDS.excellent.min) return SCORE_THRESHOLDS.excellent;
  if (score >= SCORE_THRESHOLDS.good.min) return SCORE_THRESHOLDS.good;
  if (score >= SCORE_THRESHOLDS.needsWork.min) return SCORE_THRESHOLDS.needsWork;
  return SCORE_THRESHOLDS.poor;
}

/**
 * Category display configuration
 */
const CATEGORY_CONFIG = {
  seo: { name: 'SEO', icon: '🔍', color: '#3b82f6' },
  performance: { name: 'Performance', icon: '⚡', color: '#10b981' },
  accessibility: { name: 'Accessibility', icon: '♿', color: '#8b5cf6' },
  security: { name: 'Security', icon: '🔒', color: '#ef4444' },
  technical: { name: 'Technical', icon: '⚙️', color: '#6b7280' },
};

/**
 * Signal categories for grouping in reports
 */
const SIGNAL_CATEGORIES = {
  coreWebVitals: {
    name: 'Core Web Vitals',
    description: 'Google\'s metrics for user experience',
    signals: ['ttfb', 'fcp', 'lcp', 'cls', 'inp'],
  },
  pageSizeAndRequests: {
    name: 'Page Weight',
    description: 'Resource loading metrics',
    signals: ['pageSize', 'requestCount', 'preloadCount'],
  },
  onPageSEO: {
    name: 'On-Page SEO',
    description: 'Title, description, and heading optimization',
    signals: ['titleLength', 'descriptionLength', 'h1Count', 'h1Text', 'headingStructure'],
  },
  contentQuality: {
    name: 'Content Quality',
    description: 'Content depth and readability',
    signals: ['wordCount', 'textToHtmlRatio', 'readabilityScore', 'paragraphCount', 'contentScore'],
  },
  eeat: {
    name: 'E-E-A-T',
    description: 'Experience, Expertise, Authority, Trust signals',
    signals: ['eeatScore', 'authorPresent', 'authorCredentials', 'trustSignals', 'ymylPage'],
  },
  freshness: {
    name: 'Content Freshness',
    description: 'How recently content was updated',
    signals: ['lastModified', 'datePublished', 'freshnessScore', 'contentAge'],
  },
  structuredData: {
    name: 'Structured Data',
    description: 'Schema.org markup for rich results',
    signals: ['hasStructuredData', 'schemaTypes', 'schemaErrors', 'schemaWarnings'],
  },
  technicalSEO: {
    name: 'Technical SEO',
    description: 'Technical implementation details',
    signals: ['metaRefresh', 'jsFramework', 'hasSSR', 'cms', 'amp', 'pwa', 'hasLazyLoading'],
  },
  urlArchitecture: {
    name: 'URL Architecture',
    description: 'URL structure and cleanliness',
    signals: ['urlLength', 'urlDepth', 'hasTrackingParams', 'hasSessionId', 'urlConsistency'],
  },
  linkStructure: {
    name: 'Link Structure',
    description: 'Internal linking and navigation',
    signals: ['internalLinks', 'externalLinks', 'hasIncomingLinks', 'linkDepth', 'isDeadEnd'],
  },
  indexability: {
    name: 'Indexability',
    description: 'Search engine crawling and indexing',
    signals: ['isIndexable', 'hasCanonical', 'canonicalMatch', 'robotsDirective'],
  },
  international: {
    name: 'International SEO',
    description: 'Multi-language and regional targeting',
    signals: ['hasHreflang', 'hreflangCount', 'hreflangReciprocal'],
  },
  images: {
    name: 'Image Optimization',
    description: 'Image SEO and performance',
    signals: ['imagesTotal', 'imagesMissingAlt', 'imagesOptimized'],
  },
  social: {
    name: 'Social Media',
    description: 'Social sharing optimization',
    signals: ['hasOpenGraph', 'hasTwitterCards', 'ogImage'],
  },
  security: {
    name: 'Security',
    description: 'HTTPS and security headers',
    signals: ['isHttps', 'hasMixedContent', 'hasSecurityHeaders'],
  },
  accessibility: {
    name: 'Accessibility',
    description: 'WCAG compliance and usability',
    signals: ['accessibilityScore', 'hasLangAttribute', 'hasSkipLink', 'colorContrast'],
  },
  keywordStrategy: {
    name: 'Keyword Strategy',
    description: 'Keyword targeting and conflicts',
    signals: ['keywordConflicts', 'nearDuplicateTitle'],
  },
  analytics: {
    name: 'Analytics',
    description: 'Tracking implementation',
    signals: ['hasAnalytics', 'analyticsType'],
  },
  contentInsights: {
    name: 'Content Insights',
    description: 'Advanced content analysis including language, similarity, and CTAs',
    signals: ['languageDetected', 'languageMatch', 'ctaCount', 'ctaAboveFold', 'contentSimilarity', 'mainContentWords', 'boilerplateRatio'],
  },
  codeCoverage: {
    name: 'Code Coverage',
    description: 'JavaScript and CSS usage analysis',
    signals: ['jsUnused', 'cssUnused'],
  },
  advancedLinkAnalysis: {
    name: 'Advanced Links',
    description: 'PageRank, outbound health, and response headers',
    signals: ['internalPageRank', 'brokenOutboundLinks', 'responseHeaders'],
  },
};

/**
 * Get metric/signal info by key
 * @param {string} key - Signal key (e.g., 'eeatScore', 'wordCount')
 * @returns {Object|null} Signal metadata or null if not found
 */
function getSignalInfo(key) {
  return METRIC_INFO[key] || null;
}

/**
 * Get all signals in a category
 * @param {string} categoryKey - Category key (e.g., 'eeat', 'contentQuality')
 * @returns {Array} Array of signal info objects with their keys
 */
function getSignalsByCategory(categoryKey) {
  const category = SIGNAL_CATEGORIES[categoryKey];
  if (!category) return [];

  return category.signals.map(signalKey => ({
    key: signalKey,
    ...METRIC_INFO[signalKey],
  })).filter(s => s.name); // Filter out any missing signals
}

/**
 * Get tooltip text for a metric/signal
 * @param {string} key - Signal key
 * @returns {string} Tooltip text (description + learn more link if available)
 */
function getSignalTooltip(key) {
  const info = METRIC_INFO[key];
  if (!info) return '';

  let tooltip = info.description || '';
  if (info.note) {
    tooltip += ` (${info.note})`;
  }
  return tooltip;
}

/**
 * Format signal value for display
 * @param {string} key - Signal key
 * @param {any} value - Signal value
 * @returns {string} Formatted value
 */
function formatSignalValue(key, value) {
  const info = METRIC_INFO[key];
  if (!info) return String(value);

  if (info.type === 'boolean') {
    return value ? (info.goodLabel || 'Yes') : (info.badLabel || 'No');
  }

  if (info.unit === 'ms') {
    return `${Math.round(value)}ms`;
  }

  if (info.unit === 'bytes') {
    if (value > 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}MB`;
    }
    if (value > 1_000) {
      return `${(value / 1_000).toFixed(1)}KB`;
    }
    return `${value}B`;
  }

  if (info.unit === '%') {
    return `${typeof value === 'number' ? value.toFixed(1) : value}%`;
  }

  if (info.unit === 'chars' || info.unit === 'words' || info.unit === 'days') {
    return `${value} ${info.unit}`;
  }

  return String(value);
}

/**
 * Check if signal value is good/acceptable
 * @param {string} key - Signal key
 * @param {any} value - Signal value
 * @returns {boolean|null} true=good, false=bad, null=neutral
 */
function isSignalGood(key, value) {
  const info = METRIC_INFO[key];
  if (!info) return null;

  // Boolean signals
  if (info.type === 'boolean') {
    return info.isInverse ? !value : value;
  }

  // Threshold-based signals (lower is better when isInverse)
  if (info.threshold !== undefined) {
    if (info.isInverse) {
      return value <= info.threshold;
    }
    return value >= info.threshold;
  }

  // Range-based signals (min/max)
  if (info.min !== undefined && info.max !== undefined) {
    return value >= info.min && value <= info.max;
  }

  if (info.min !== undefined) {
    return value >= info.min;
  }

  if (info.max !== undefined) {
    return value <= info.max;
  }

  return null;
}

module.exports.METRIC_INFO = METRIC_INFO;
module.exports.SEVERITY_CONFIG = SEVERITY_CONFIG;
module.exports.SCORE_THRESHOLDS = SCORE_THRESHOLDS;
module.exports.CATEGORY_CONFIG = CATEGORY_CONFIG;
module.exports.SIGNAL_CATEGORIES = SIGNAL_CATEGORIES;
module.exports.getScoreCategory = getScoreCategory;
module.exports.getSignalInfo = getSignalInfo;
module.exports.getSignalsByCategory = getSignalsByCategory;
module.exports.getSignalTooltip = getSignalTooltip;
module.exports.formatSignalValue = formatSignalValue;
module.exports.isSignalGood = isSignalGood;
