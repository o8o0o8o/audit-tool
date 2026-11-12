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
          <td style="padding:6px 10px;">${escapeHtml(c.label)}</td>
          <td style="padding:6px 10px;font-weight:600;color:${s.color};">${s.text}</td>
          <td style="padding:6px 10px;color:var(--gray-600);font-size:var(--font-size-sm);word-break:break-word;">${escapeHtml(c.note ?? '')}</td>
        </tr>`;
    })
    .join('');
  const table = rows
    ? `<table class="domain-exposure-checks" style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 10px;">Check</th>
          <th style="text-align:left;padding:6px 10px;">Status</th>
          <th style="text-align:left;padding:6px 10px;">Details</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : '';

  const list = findings.length
    ? `<ul class="domain-exposure-findings">${findings
        .map(
          ([m, d]) =>
            `<li><strong>${escapeHtml(String(d.severity ?? '').toUpperCase())}</strong> ${escapeHtml(strip(m))}${d.count ? ` <span>(${d.count})</span>` : ''}</li>`,
        )
        .join('')}</ul>`
    : `<div class="domain-exposure-clean" style="border:1px solid var(--color-success);border-radius:var(--radius-lg);padding:10px 14px;font-size:var(--font-size-sm);"><strong>${escapeHtml(opts.cleanText)}</strong></div>`;

  const domain = siteChecks?.domain
    ? ` <span style="font-weight:400;color:var(--gray-600);font-size:var(--font-size-sm);">${escapeHtml(siteChecks.domain)}</span>`
    : '';
  return `<div class="domain-exposure-section" id="${opts.id}" style="margin-top:24px;">
      <h2 style="margin:0 0 12px;font-size:var(--font-size-lg);color:var(--gray-800);">${escapeHtml(opts.title)}${domain}</h2>
      ${table}${list}
      <p style="font-size:var(--font-size-sm);color:var(--gray-600);">Full details and affected pages for each finding are in the issues list above.</p>
    </div>`;
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
