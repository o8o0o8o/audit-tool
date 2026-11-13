/**
 * Domain & Exposure section of the HTML report: a status table for the
 * site-level checks (email authentication, DNS, exposed files, missing-page
 * status, subdomain takeover), followed by every finding from those checks
 * and from the related per-page checks (head integrity, bfcache, vulnerable JS
 * libraries, Consent Mode v2). Rendered inside the Issues tab.
 */

import {
  ANALYTICS_CHECK_IDS,
  isAnalyticsFinding,
  isPageCheckFinding,
  isSiteCheckFinding,
  type SiteChecksData,
} from '../../analyzers/site-checks/site-checks-types';
import { escapeHtml } from '../html-utils';
import { findingChips, renderFindingList, renderSubpanel } from './report-panel';

export const DOMAIN_EXPOSURE_TITLE = 'Domain & Exposure';

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pass: { text: 'OK', color: 'var(--color-success)' },
  warn: { text: 'Warning', color: 'var(--color-score-warning)' },
  fail: { text: 'Issue', color: 'var(--color-error)' },
  skipped: { text: 'Not checked', color: 'var(--gray-600)' },
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

const strip = (m: string) => m.replace(/<[^>]*>/g, '');

interface BlockOptions {
  id: string;
  title: string;
  cleanText: string;
  includeFinding: (message: string) => boolean;
  includeCheck: (id: string) => boolean;
}

function renderChecksBlock(
  siteChecks: SiteChecksData | null | undefined,
  details: Record<string, { severity?: string; count?: number }>,
  opts: BlockOptions,
): string {
  const checks = (siteChecks?.checks ?? []).filter((c) => opts.includeCheck(c.id));
  const findings = Object.entries(details)
    .filter(([m]) => opts.includeFinding(m))
    .sort(
      ([, a], [, b]) =>
        SEVERITY_ORDER.indexOf(String(a.severity ?? 'low')) - SEVERITY_ORDER.indexOf(String(b.severity ?? 'low')),
    );
  if (!checks.length && findings.length === 0) return '';

  const rows = checks
    .map((c) => {
      const s = STATUS_LABEL[c.status] ?? STATUS_LABEL.skipped;
      return `<tr>
          <td>${escapeHtml(c.label)}</td>
          <td style="font-weight:600;color:${s.color};white-space:nowrap;">${s.text}</td>
          <td style="color:var(--color-text-muted);word-break:break-word;">${escapeHtml(c.note ?? '')}</td>
        </tr>`;
    })
    .join('');
  const table = rows
    ? `<table class="domain-exposure-checks">
        <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '';

  const stripped = findings.map(([m, d]) => [strip(m), d] as [string, { severity?: string; count?: number }]);
  const list = findings.length
    ? renderFindingList('domain-exposure-findings', stripped)
    : `<div class="domain-exposure-clean" style="border:1px solid var(--color-success);border-radius:var(--radius-lg);padding:10px 14px;font-size:var(--font-size-sm);"><strong>${escapeHtml(opts.cleanText)}</strong></div>`;

  const domain = siteChecks?.domain
    ? ` <span style="font-weight:400;color:var(--color-text-muted);font-size:var(--font-size-sm);">${escapeHtml(siteChecks.domain)}</span>`
    : '';
  return renderSubpanel({
    id: opts.id,
    className: 'domain-exposure-section',
    heading: `${escapeHtml(opts.title)}${domain}`,
    chips: findingChips(stripped),
    body: `${list}${table}
      <p class="subpanel-note">Full details and affected pages for each finding are in the issues list above.</p>`,
  });
}

export function getDomainExposureSection(
  siteChecks: SiteChecksData | null | undefined,
  details: Record<string, { severity?: string; count?: number }>,
): string {
  return renderChecksBlock(siteChecks, details, {
    id: 'domain-exposure',
    title: DOMAIN_EXPOSURE_TITLE,
    cleanText: 'No domain or exposure issues found.',
    includeFinding: (m) => (isSiteCheckFinding(m) || isPageCheckFinding(m)) && !isAnalyticsFinding(m),
    includeCheck: (id) => !ANALYTICS_CHECK_IDS.has(id),
  });
}

export const ANALYTICS_TAGS_TITLE = 'Analytics & Tags';

export function getAnalyticsTagsSection(
  siteChecks: SiteChecksData | null | undefined,
  details: Record<string, { severity?: string; count?: number }>,
): string {
  return renderChecksBlock(siteChecks, details, {
    id: 'analytics-tags',
    title: ANALYTICS_TAGS_TITLE,
    cleanText: 'No analytics or tag issues found.',
    includeFinding: isAnalyticsFinding,
    includeCheck: (id) => ANALYTICS_CHECK_IDS.has(id),
  });
}
