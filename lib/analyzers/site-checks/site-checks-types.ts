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
}

export interface SiteProbeResult {
  issues: Issue[];
  checks: SiteCheckResult[];
}

/** Every finding the site-level probes can emit (message prefixes, matched without HTML). */
export const SITE_CHECK_FINDING_PATTERN =
  /^(?:SPF |No SPF record|Multiple SPF records|DMARC |No DMARC record|Multiple DMARC records|No DKIM key|MTA-STS |No MTA-STS|No TLS-RPT|No CAA record|Git repository exposed|Subversion metadata exposed|\.env file exposed|\.DS_Store file exposed|\.htpasswd file exposed|Backup or database dump publicly downloadable|phpinfo\(\) page exposed|Directory listing enabled|Missing pages return HTTP|Missing pages redirect|Dangling CNAME)/i;

/** Per-page findings added together with the site-level probes. */
export const PAGE_CHECK_FINDING_PATTERN =
  /^(?:Invalid element in HTML head|Page not eligible for back\/forward cache|unload event handler blocks back\/forward cache|Outdated JavaScript library with known vulnerabilities|Google tags run without Consent Mode|Google Consent Mode v2 signals missing)/i;

/** Strips HTML, markdown backticks/emphasis and leading punctuation before matching. */
const plain = (m: string) =>
  m
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_]/g, '')
    .replace(/^[^A-Za-z0-9.]+/, '')
    .trim();

export function isSiteCheckFinding(message: string): boolean {
  return SITE_CHECK_FINDING_PATTERN.test(plain(message));
}

export function isPageCheckFinding(message: string): boolean {
  return PAGE_CHECK_FINDING_PATTERN.test(plain(message));
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
