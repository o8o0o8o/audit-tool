/**
 * Issue catalog — maps known issue titles to {tier, category}.
 *
 * Tier follows the industry-standard 3-tier model (Ahrefs / Semrush / GSC /
 * Screaming Frog): Error / Warning / Notice. Only Error-tier issues move the
 * SEO and Best-Practices scores; Warnings + Notices are surfaced as
 * diagnostic information.
 *
 * Tier assignments reflect cross-tool consensus where it exists. For issues
 * not in the catalog, classifyIssue() falls back to the analyzer-reported
 * severity (critical/high → error, medium → warning, low → notice) and infers
 * category from keywords.
 */

import type { SeverityLevel } from '../types';

export type IssueTier = 'error' | 'warning' | 'notice';
export type IssueCategory = 'seo' | 'performance' | 'accessibility' | 'security' | 'technical';

export interface IssueDescriptor {
  tier: IssueTier;
  category: IssueCategory;
}

/** Severity → tier when the issue isn't in the catalog. */
export function severityToTier(severity: SeverityLevel | string | undefined): IssueTier {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'notice';
}

/**
 * Canonical catalog of issue titles → metadata. Add entries here when the
 * default severity-based classification is wrong for a given check.
 *
 * Title format mirrors what analyzers emit to `analysisData.details` (the
 * "general error" string passed to saveError()).
 */
export const ISSUE_CATALOG: Record<string, IssueDescriptor> = {
  // ─── SEO: On-page ─────────────────────────────────────────────────────────
  'Some pages have missing or empty title': { tier: 'error', category: 'seo' },
  'Some pages have missing or empty meta description': { tier: 'warning', category: 'seo' },
  'Some pages have duplicate title': { tier: 'error', category: 'seo' },
  'Some pages have duplicate description': { tier: 'warning', category: 'seo' },
  'Some pages have identical titles': { tier: 'error', category: 'seo' },
  'Some pages have identical descriptions': { tier: 'warning', category: 'seo' },
  'Duplicate page titles found': { tier: 'error', category: 'seo' },
  'Duplicate meta descriptions found': { tier: 'warning', category: 'seo' },
  'Some pages have more than one h1 tag': { tier: 'warning', category: 'seo' },
  'Some pages have skipped heading levels': { tier: 'notice', category: 'seo' },
  'Some pages are missing alt attribute on images': { tier: 'warning', category: 'seo' },

  // ─── SEO: Crawl & Indexability ────────────────────────────────────────────
  'Some pages are missing canonical URL': { tier: 'error', category: 'seo' },
  "Some loc and canonical don't match": { tier: 'error', category: 'seo' },
  'Some pages are not listed in sitemap': { tier: 'warning', category: 'seo' },
  'Incorrect origin in sitemap': { tier: 'error', category: 'seo' },
  'Some pages have redirect chains or loops': { tier: 'error', category: 'seo' },
  'Soft 404 detected': { tier: 'error', category: 'seo' },
  'Pages blocked via X-Robots-Tag header': { tier: 'error', category: 'seo' },
  'Alternates are not set for some pages': { tier: 'warning', category: 'seo' },

  // ─── SEO: Structured data ─────────────────────────────────────────────────
  'Invalid JSON-LD schema': { tier: 'error', category: 'seo' },
  'Missing structured data': { tier: 'notice', category: 'seo' },

  // ─── SEO: International ───────────────────────────────────────────────────
  'Hreflang conflicts': { tier: 'error', category: 'seo' },
  'Detected content language does not match declared language': { tier: 'warning', category: 'seo' },
  'Content-Language header mismatches html lang attribute': { tier: 'warning', category: 'seo' },

  // ─── SEO: Content ─────────────────────────────────────────────────────────
  'Some pages have very thin content': { tier: 'warning', category: 'seo' },

  // ─── Performance ──────────────────────────────────────────────────────────
  // (These reach the catalog only as a fallback signal; the perf score is
  //  computed from per-page metrics via log-normal CDF, not from issue counts.)
  'Some pages have TTFB more than 800ms': { tier: 'warning', category: 'performance' },
  'Some pages have LCP more than 2500ms': { tier: 'warning', category: 'performance' },
  'High percentage of unused JavaScript': { tier: 'warning', category: 'performance' },
  'High percentage of unused CSS': { tier: 'warning', category: 'performance' },
  'Large amount of unused code': { tier: 'warning', category: 'performance' },
  'Pages have image files larger than recommended': { tier: 'warning', category: 'performance' },
  'LCP image not preloaded': { tier: 'notice', category: 'performance' },
  'Excessive DOM size': { tier: 'warning', category: 'performance' },
  'Some pages have excessive third-party payload': { tier: 'warning', category: 'performance' },
  'Some pages have render-blocking third-party scripts': { tier: 'warning', category: 'performance' },
  'HTML document exceeds 3MB': { tier: 'warning', category: 'performance' },

  // ─── Security ─────────────────────────────────────────────────────────────
  'External scripts missing Subresource Integrity (SRI)': { tier: 'warning', category: 'security' },
  'Missing Permissions-Policy header': { tier: 'notice', category: 'security' },
  'Weak Content-Security-Policy directives': { tier: 'warning', category: 'security' },
  'Mixed content detected': { tier: 'error', category: 'security' },

  // ─── Accessibility ────────────────────────────────────────────────────────
  'Color contrast fails WCAG AA': { tier: 'warning', category: 'accessibility' },
  'Form inputs missing labels': { tier: 'warning', category: 'accessibility' },
  'No prefers-reduced-motion CSS support': { tier: 'notice', category: 'accessibility' },

  // ─── Best Practices (technical) ───────────────────────────────────────────
  'Critical JavaScript errors detected': { tier: 'error', category: 'technical' },
  'Intrusive interstitial/popup detected': { tier: 'warning', category: 'technical' },
  'Deprecated HTML elements found': { tier: 'notice', category: 'technical' },
  'Session ID detected in URL': { tier: 'warning', category: 'technical' },
  'Suspicious external link without nofollow': { tier: 'notice', category: 'technical' },
};

/**
 * Pattern-based overrides for findings whose titles are dynamic (embed a
 * keyword, count, or URL) and so can't be exact-matched in ISSUE_CATALOG.
 * Checked after the exact catalog, before the severity fallback. Without
 * these, a high-severity per-page variant inflates the Error tier and
 * collapses the category's URL-pass score for issues that are really
 * diagnostics (keyword overlap) or belong to another category (autoplay).
 */
const TITLE_PATTERN_OVERRIDES: Array<{ rx: RegExp; descriptor: IssueDescriptor }> = [
  // Keyword cannibalisation is a diagnostic, not a hard error (Ahrefs/Semrush
  // treat it as a warning). It also fragments into one finding per n-gram.
  { rx: /^multiple pages targeting keyword/i, descriptor: { tier: 'warning', category: 'seo' } },
  { rx: /multiple pages target the same keyword/i, descriptor: { tier: 'warning', category: 'seo' } },
  { rx: /multiple pages with similar h1 keyword/i, descriptor: { tier: 'warning', category: 'seo' } },
  { rx: /keyword cannibal/i, descriptor: { tier: 'warning', category: 'seo' } },
  // Thin content (per-page and percentage variants) — warning, mirroring the
  // catalogued "Some pages have very thin content".
  { rx: /\bvery thin content\b/i, descriptor: { tier: 'warning', category: 'seo' } },
  // Autoplay/missing media controls is an accessibility/UX concern, not an SEO error.
  { rx: /autoplay (video|media)|without pause controls/i, descriptor: { tier: 'notice', category: 'accessibility' } },
];

/**
 * Classify an issue. Falls back to severity-based tier + keyword-based
 * category when not catalogued.
 */
export function classifyIssue(title: string, severity?: SeverityLevel | string): IssueDescriptor {
  const exact = ISSUE_CATALOG[title];
  if (exact) return exact;
  for (const { rx, descriptor } of TITLE_PATTERN_OVERRIDES) {
    if (rx.test(title)) return descriptor;
  }
  return {
    tier: severityToTier(severity),
    category: inferCategory(title),
  };
}

/**
 * True only when a finding is *vetted* as error-tier by the catalog (an exact
 * entry or a pattern override) — i.e. a known-serious issue, not one that
 * merely inherited error-tier from a high/critical analyzer severity fallback.
 * Used by severity moderation to protect genuine errors from being demoted
 * when their category otherwise scores well.
 */
export function isCataloguedErrorTier(title: string): boolean {
  const exact = ISSUE_CATALOG[title];
  if (exact) return exact.tier === 'error';
  for (const { rx, descriptor } of TITLE_PATTERN_OVERRIDES) {
    if (rx.test(title)) return descriptor.tier === 'error';
  }
  return false;
}

const CATEGORY_PATTERNS: Array<{ category: IssueCategory; rx: RegExp }> = [
  {
    category: 'performance',
    rx: /\b(ttfb|lcp|cls|fcp|inp|tbt|cache|caching|cdn|render[- ]blocking|font|image|lazy|webp|avif|third[- ]?party|preload|prefetch|unused (javascript|css|code)|coverage|dom size|dom complexity|dom depth|dom children|page size|request count|compression|minif|critical path|service worker)\b/i,
  },
  {
    category: 'accessibility',
    rx: /\b(contrast|aria|focus indicator|keyboard|alt (text|attribute)|label|landmark|tabindex|wcag|a11y|accessibility|prefers-reduced-motion|touch target|skip link)\b/i,
  },
  {
    category: 'security',
    rx: /\b(csp|content[- ]security[- ]policy|hsts|strict-transport|https|tls|ssl|sri|subresource integrity|cookie|mixed content|x-frame|frame-ancestors|permissions[- ]policy|x-content-type|cors|xss|csrf|insecure|integrity)\b/i,
  },
  {
    category: 'technical',
    rx: /\b(redirect chain|redirect loop|http error|5\d{2}|dns|ipv6|aaaa|iframe|doctype|deprecated|cms|framework|popup|interstitial|overlay|ad density|document\.write|open redirect|nameserver|spelling|misspell)\b/i,
  },
];

function inferCategory(title: string): IssueCategory {
  for (const { category, rx } of CATEGORY_PATTERNS) {
    if (rx.test(title)) return category;
  }
  return 'seo';
}
