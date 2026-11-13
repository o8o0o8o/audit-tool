/**
 * Shared types and finding patterns for the site-level "Domain & Exposure" checks
 * (email/DNS, exposed files, missing-page status probe, subdomain takeover) and
 * the per-page checks that sit next to them in the report.
 */

import type { Issue } from '../../types';

export type SiteCheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface SiteCheckResult {
  id: string;
  label: string;
  status: SiteCheckStatus;
  /** Short plain-text note shown next to the status (record value, reason skipped…). */
  note?: string;
}

/** Persisted in `metadata.json.gz` as `siteChecks`; read by the HTML report section. */
export interface SiteChecksData {
  checkedAt: string;
  domain: string;
  checks: SiteCheckResult[];
  /** Set when the probes ran in passive mode (`--passive` / `--lead`). */
  passive?: boolean;
}

export interface SiteProbeResult {
  issues: Issue[];
  checks: SiteCheckResult[];
}

/** Every finding the site-level probes can emit (message prefixes, matched without HTML). */
export const SITE_CHECK_FINDING_PATTERN =
  /^(?:SPF |No SPF record|Multiple SPF records|DMARC |No DMARC record|Multiple DMARC records|No DKIM key|MTA-STS |No MTA-STS|No TLS-RPT|No CAA record|Git repository exposed|Subversion metadata exposed|\.env file exposed|\.DS_Store file exposed|\.htpasswd file exposed|Backup or database dump publicly downloadable|phpinfo\(\) page exposed|Directory listing enabled|Missing pages return HTTP|Missing pages redirect|Dangling CNAME|.+ leaked in public JavaScript|Google API key in public JavaScript|Firebase Realtime Database|Cloud storage bucket allows|CORS reflects|Script loaded from a domain that no longer resolves|WordPress plugin with known|Staging or development host|Googlebot is served different|Requests with a Googlebot user agent|AI crawlers blocked by firewall|Homepage redirects by browser language|Trackers still run after consent|Session replay runs on pages)/i;

/** Per-page findings added together with the site-level probes. */
export const PAGE_CHECK_FINDING_PATTERN =
  /^(?:Invalid element in HTML head|Page not eligible for back\/forward cache|unload event handler blocks back\/forward cache|Outdated JavaScript library with known vulnerabilities|Google tags run without Consent Mode|Google Consent Mode v2 signals missing)/i;

/** Post-crawl crawl-graph findings (canonical/hreflang targets, facets, calendars, lastmod, CTAs, schema phone). */
export const GRAPH_CHECK_FINDING_PATTERN =
  /^(?:Canonical loop between pages|Canonical chain \(|Canonical points to an? (?:redirecting URL|error page|noindex page)|Hreflang alternate points to|Faceted navigation creates|Calendar URL space|Large date-archive URL series|Sitemap lastmod|CTA link (?:points|redirects)|Structured data telephone not shown)/i;

/** Per-page render / delivery findings: routed normally, never refuted by Phase 3. */
export const RENDER_CHECK_FINDING_PATTERN =
  /^(?:Server and rendered HTML disagree|Most page text is hidden|Content loads only after scrolling|Low color contrast in dark mode|Form submits (?:over insecure HTTP|data to a third-party domain)|CAPTCHA failed to load|Product schema price not shown|Assets are served through redirects|Long-cached assets without cache-busting|Same JavaScript library loaded more than once|CDN does not cache HTML pages|Cookie banner causes layout shift)/i;

/** Analytics / tag findings, shown in the report's Analytics & Tags block. */
export const ANALYTICS_FINDING_PATTERN =
  /^(?:Google tag script failed to load|Server-side tagging endpoint returns errors|Google Analytics hits fail to send|Analytics installed but no GA4 hits sent|GA4 hits sent to a property not referenced|Page views sent to multiple GA4 properties|Duplicate GA4 page_view|GA4 debug mode enabled|Personal data sent to Google Analytics|Meta Pixel fires duplicate PageView|dataLayer is overwritten after GTM loads|Consent Mode default set after tags start|Internal links with UTM parameters|Product page sends no view_item event|Cross-domain links lack GA4 linker|Client-side navigation sends no page_view|GTM container|Many Custom HTML tags in GTM container|GTM tags without consent settings|Google tags run without Consent Mode|Google Consent Mode v2 signals missing|Trackers still run after consent is rejected|Session replay runs on pages)/i;

/** Check-row ids rendered in the Analytics & Tags table instead of Domain & Exposure. */
export const ANALYTICS_CHECK_IDS = new Set([
  'ga4-hits',
  'gtm-container',
  'ga4-linker',
  'spa-pageview',
  'consent-reject',
  'session-replay-sensitive',
]);

export function isAnalyticsFinding(message: string): boolean {
  return ANALYTICS_FINDING_PATTERN.test(plain(message));
}

/** Strips HTML, markdown backticks/emphasis and leading punctuation before matching. */
const plain = (m: string) =>
  m
    .replace(/<[^>]*>/g, '')
    .replace(/[`*]/g, '')
    .replace(/^[^A-Za-z0-9.]+/, '')
    .trim();

export function isSiteCheckFinding(message: string): boolean {
  return SITE_CHECK_FINDING_PATTERN.test(plain(message));
}

export function isPageCheckFinding(message: string): boolean {
  return PAGE_CHECK_FINDING_PATTERN.test(plain(message));
}

export function isGraphCheckFinding(message: string): boolean {
  return GRAPH_CHECK_FINDING_PATTERN.test(plain(message));
}

/** Findings from these checks come from probes, DNS or whole-crawl data; Phase 3 never refutes them. */
export function isNeverRefuteCheckFinding(message: string): boolean {
  return (
    isSiteCheckFinding(message) ||
    isPageCheckFinding(message) ||
    isGraphCheckFinding(message) ||
    isAnalyticsFinding(message) ||
    RENDER_CHECK_FINDING_PATTERN.test(plain(message))
  );
}

/** Hostname with one leading `www.` removed, lower-cased. */
export function siteDomain(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const SECOND_LEVEL_SUFFIXES = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|mil)$/;

/**
 * Best-effort registrable domain without a public-suffix list: last two labels,
 * or last three when the second-to-last is a common second-level suffix under a
 * two-letter ccTLD (example.co.uk, example.com.au).
 */
export function orgDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL_SUFFIXES.test(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}
