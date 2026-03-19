/**
 * Issues Detail Section
 * Flat, scannable table of all issues sorted by severity and impact.
 * Expandable rows show fix suggestions and affected pages.
 */

import { escapeHtml } from '../html-utils';
import { ScoreCalculator } from '../../scoring/score-calculator';
import { shortDomain } from '../comparison-helpers';
import type { ReportSectionData, AnalysisDetail, FixRecommendation, ComparisonData } from '../../types';

// ── Crawler error filtering ──────────────────────────────────────────────────

const CRAWLER_ERROR_PATTERNS = [
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
];

function isCrawlerError(issue: string) {
  return CRAWLER_ERROR_PATTERNS.some((p) => issue.includes(p));
}

// ── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SEVERITY_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  critical: { bg: '#fef2f2', text: '#991b1b', dot: '#ef4444' },
  high: { bg: '#fff7ed', text: '#9a3412', dot: '#f97316' },
  medium: { bg: '#fffbeb', text: '#92400e', dot: '#f59e0b' },
  low: { bg: '#f0fdf4', text: '#166534', dot: '#22c55e' },
};

// ── Types ────────────────────────────────────────────────────────────────────

interface IssueEntry {
  key: string;
  detail: AnalysisDetail;
  fix: FixRecommendation | null;
  impactScore: number;
  isQuickWin: boolean;
}

// ── Main export ──────────────────────────────────────────────────────────────

function getIssuesDetail(data: ReportSectionData) {
  if (data.comparison) {
    return getComparisonIssuesDetail(data.jsonData, data.comparison);
  }

  const { jsonData } = data;
  const analysisObj = (jsonData.analysis ?? {}) as Record<string, unknown>;
  const details = (analysisObj.details ?? {}) as Record<string, AnalysisDetail>;
  const fixes = ScoreCalculator.getFixRecommendations();

  // Build issue list
  const issues: IssueEntry[] = [];
  for (const [key, detail] of Object.entries(details)) {
    if (isCrawlerError(key)) continue;
    const count = detail.count ?? detail.examples?.length ?? 0;
    if (count === 0) continue;

    const fix = fixes[key] ?? null;
    const impactScore = ScoreCalculator.calculateImpactScore(detail.severity, count);
    const effortMinutes = fix?.effort ? ScoreCalculator.parseEffort(fix.effort) : 999;

    issues.push({
      key,
      detail,
      fix,
      impactScore,
      isQuickWin: impactScore >= 40 && effortMinutes <= 30,
    });
  }

  if (issues.length === 0) return '';

  // Sort: severity first, then impact score descending
  issues.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.detail.severity] ?? 3) - (SEVERITY_ORDER[b.detail.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.impactScore - a.impactScore;
  });

  // Count by severity
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    const sev = issue.detail.severity as keyof typeof counts;
    if (sev in counts) counts[sev]++;
  }

  return `
    <div class="issues-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <h2 style="margin:0;font-size:20px;color:#1f2937;">Issues (${issues.length})</h2>
        <div class="severity-filter-bar">
          ${renderFilterPill('all', 'All', issues.length, true)}
          ${counts.critical > 0 ? renderFilterPill('critical', 'Critical', counts.critical) : ''}
          ${counts.high > 0 ? renderFilterPill('high', 'High', counts.high) : ''}
          ${counts.medium > 0 ? renderFilterPill('medium', 'Medium', counts.medium) : ''}
          ${counts.low > 0 ? renderFilterPill('low', 'Low', counts.low) : ''}
        </div>
      </div>

      ${counts.critical > 0 ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#991b1b;"><strong>${counts.critical} critical issue${counts.critical > 1 ? 's' : ''}</strong> require immediate attention.</div>` : ''}

      <table class="issues-table" style="table-layout:fixed;width:100%;">
        <colgroup>
          <col style="width:32px;">
          <col style="width:80px;">
          <col>
          <col style="width:70px;">
          <col style="width:90px;">
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>Severity</th>
            <th>Issue</th>
            <th style="text-align:right;">Count</th>
            <th style="text-align:right;">Effort</th>
          </tr>
        </thead>
        <tbody>
          ${issues.map((issue, i) => renderIssueRow(issue, i)).join('')}
        </tbody>
      </table>
    </div>

    <script>
    function filterIssueSev(sev, btn) {
      document.querySelectorAll('.sev-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.issues-table-row').forEach(function(r) {
        var show = sev === 'all' || r.dataset.severity === sev;
        r.style.display = show ? '' : 'none';
        var detail = r.nextElementSibling;
        if (detail && detail.classList.contains('issue-detail-row')) {
          detail.style.display = 'none';
          r.querySelector('.row-chevron').textContent = '▸';
        }
      });
    }
    function toggleIssueDetail(idx) {
      var row = document.getElementById('issue-detail-' + idx);
      var chevron = document.getElementById('issue-chevron-' + idx);
      if (!row) return;
      var showing = row.style.display !== 'none';
      row.style.display = showing ? 'none' : 'table-row';
      if (chevron) chevron.textContent = showing ? '▸' : '▾';
    }
    </script>
  `;
}

function renderFilterPill(value: string, label: string, count: number, active = false) {
  const sev = SEVERITY_STYLES[value];
  const activeStyle = active ? 'background:#1f2937;color:white;border-color:#1f2937;' : '';
  const dotHtml = sev
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sev.dot};margin-right:4px;"></span>`
    : '';
  return `<button class="sev-pill${active ? ' active' : ''}" onclick="filterIssueSev('${value}',this)" style="${activeStyle}">${dotHtml}${label} <span style="opacity:0.7;">${count}</span></button>`;
}

// ── Table row ────────────────────────────────────────────────────────────────

function renderIssueRow(issue: IssueEntry, idx: number) {
  const { key, detail, fix, isQuickWin } = issue;
  const sev = detail.severity;
  const styles = SEVERITY_STYLES[sev] ?? SEVERITY_STYLES.medium;
  const count = detail.count ?? detail.examples?.length ?? 0;
  const examples = detail.examples ?? [];

  return `
    <tr class="issues-table-row" data-severity="${sev}" onclick="toggleIssueDetail(${idx})" style="cursor:pointer;">
      <td style="text-align:center;color:#9ca3af;font-size:12px;"><span class="row-chevron" id="issue-chevron-${idx}">▸</span></td>
      <td><span class="issue-sev-pill" style="background:${styles.bg};color:${styles.text};">${sev}</span></td>
      <td style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(key)}">${escapeHtml(key)}${isQuickWin ? ' <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;vertical-align:middle;">QUICK WIN</span>' : ''}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${count}</td>
      <td style="text-align:right;font-size:12px;color:#6b7280;">${fix?.effort ? escapeHtml(fix.effort) : '—'}</td>
    </tr>
    <tr class="issue-detail-row" id="issue-detail-${idx}" style="display:none;">
      <td colspan="5" style="padding:0;">
        ${renderIssueDetail(key, detail, fix, examples, count, idx)}
      </td>
    </tr>
  `;
}

// ── Expanded detail ──────────────────────────────────────────────────────────

function renderIssueDetail(
  key: string,
  detail: AnalysisDetail,
  fix: FixRecommendation | null,
  examples: string[],
  count: number,
  idx: number,
) {
  const VISIBLE = 5;

  const fixHtml = fix
    ? `
    <div style="margin-bottom:12px;">
      <div style="font-size:12px;font-weight:600;color:#059669;margin-bottom:4px;">How to fix</div>
      <div style="font-size:13px;color:#374151;line-height:1.5;">${escapeHtml(fix.fix)}</div>
      ${fix.example ? `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;color:#3b82f6;font-weight:500;">Code example</summary><pre style="margin-top:4px;padding:8px;background:#1f2937;color:#e5e7eb;border-radius:4px;font-size:12px;overflow-x:auto;white-space:pre-wrap;">${escapeHtml(fix.example)}</pre></details>` : ''}
    </div>
  `
    : '';

  const pagesHtml =
    examples.length > 0
      ? `
    <div>
      <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px;">Affected pages (${count})</div>
      <div style="display:flex;flex-direction:column;gap:2px;">
        ${examples
          .slice(0, VISIBLE)
          .map(
            (ex) =>
              `<div style="font-size:12px;color:#374151;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ex}</div>`,
          )
          .join('')}
        ${
          examples.length > VISIBLE
            ? `
          <div id="issue-more-${idx}" style="display:none;">
            ${examples
              .slice(VISIBLE)
              .map(
                (ex) =>
                  `<div style="font-size:12px;color:#374151;padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ex}</div>`,
              )
              .join('')}
          </div>
          <button onclick="event.stopPropagation();var el=document.getElementById('issue-more-${idx}');var s=el.style.display!=='none';el.style.display=s?'none':'block';this.textContent=s?'Show all ${examples.length}...':'Show less';" style="background:none;border:none;color:#3b82f6;cursor:pointer;font-size:12px;padding:2px 0;text-align:left;">Show all ${examples.length}...</button>
        `
            : ''
        }
        ${count > examples.length ? `<div style="font-size:11px;color:#9ca3af;">${count} total, ${examples.length} shown</div>` : ''}
      </div>
    </div>
  `
      : '';

  return `
    <div style="padding:12px 12px 12px 44px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
      ${fixHtml}
      ${pagesHtml}
    </div>
  `;
}

// ── Comparison issues detail ────────────────────────────────────────────────

interface ComparisonIssueEntry extends IssueEntry {
  compareCount: number;
  status: 'fixed' | 'new' | 'both';
}

function getComparisonIssuesDetail(jsonData: Record<string, unknown>, comparison: ComparisonData) {
  const originAnalysis = (jsonData.analysis ?? {}) as Record<string, unknown>;
  const originDetails = (originAnalysis.details ?? {}) as Record<string, AnalysisDetail>;

  const compareAnalysis = (comparison.compareJsonData.analysis ?? {}) as Record<string, unknown>;
  const compareDetails = (compareAnalysis.details ?? {}) as Record<string, AnalysisDetail>;

  const fixes = ScoreCalculator.getFixRecommendations();

  // Merge issues from both origins
  const allKeys = new Set([...Object.keys(originDetails), ...Object.keys(compareDetails)]);
  const issues: ComparisonIssueEntry[] = [];

  for (const key of allKeys) {
    if (isCrawlerError(key)) continue;

    const originDetail = originDetails[key];
    const compareDetail = compareDetails[key];

    const originCount = originDetail ? (originDetail.count ?? originDetail.examples?.length ?? 0) : 0;
    const compareCount = compareDetail ? (compareDetail.count ?? compareDetail.examples?.length ?? 0) : 0;

    if (originCount === 0 && compareCount === 0) continue;

    const detail = originDetail ?? compareDetail;
    const fix = fixes[key] ?? null;
    const impactScore = ScoreCalculator.calculateImpactScore(detail.severity, Math.max(originCount, compareCount));
    const effortMinutes = fix?.effort ? ScoreCalculator.parseEffort(fix.effort) : 999;

    let status: 'fixed' | 'new' | 'both';
    if (originCount > 0 && compareCount === 0) status = 'fixed';
    else if (originCount === 0 && compareCount > 0) status = 'new';
    else status = 'both';

    issues.push({
      key,
      detail,
      fix,
      impactScore,
      isQuickWin: impactScore >= 40 && effortMinutes <= 30,
      compareCount,
      status,
    });
  }

  if (issues.length === 0) return '';

  // Sort: severity first, then impact score descending
  issues.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.detail.severity] ?? 3) - (SEVERITY_ORDER[b.detail.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.impactScore - a.impactScore;
  });

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    const sev = issue.detail.severity as keyof typeof counts;
    if (sev in counts) counts[sev]++;
  }

  const fixedCount = issues.filter(i => i.status === 'fixed').length;
  const newCount = issues.filter(i => i.status === 'new').length;
  const originLabel = shortDomain(comparison.originDomainName);
  const compareLabel = shortDomain(comparison.compareDomainName);

  return `
    <div class="issues-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <h2 style="margin:0;font-size:20px;color:#1f2937;">Issues Comparison (${issues.length})</h2>
        <div class="severity-filter-bar">
          ${renderFilterPill('all', 'All', issues.length, true)}
          ${counts.critical > 0 ? renderFilterPill('critical', 'Critical', counts.critical) : ''}
          ${counts.high > 0 ? renderFilterPill('high', 'High', counts.high) : ''}
          ${counts.medium > 0 ? renderFilterPill('medium', 'Medium', counts.medium) : ''}
          ${counts.low > 0 ? renderFilterPill('low', 'Low', counts.low) : ''}
        </div>
      </div>

      ${fixedCount > 0 || newCount > 0 ? `
      <div style="display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        ${fixedCount > 0 ? `<div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #166534;"><strong>${fixedCount} issue${fixedCount > 1 ? 's' : ''}</strong> fixed in ${escapeHtml(compareLabel)}</div>` : ''}
        ${newCount > 0 ? `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #991b1b;"><strong>${newCount} new issue${newCount > 1 ? 's' : ''}</strong> in ${escapeHtml(compareLabel)}</div>` : ''}
      </div>
      ` : ''}

      <table class="issues-table" style="table-layout:fixed;width:100%;">
        <colgroup>
          <col style="width:32px;">
          <col style="width:80px;">
          <col>
          <col style="width:80px;">
          <col style="width:80px;">
          <col style="width:70px;">
          <col style="width:90px;">
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>Severity</th>
            <th>Issue</th>
            <th style="text-align:right;">${escapeHtml(originLabel)}</th>
            <th style="text-align:right;">${escapeHtml(compareLabel)}</th>
            <th style="text-align:center;">Status</th>
            <th style="text-align:right;">Effort</th>
          </tr>
        </thead>
        <tbody>
          ${issues.map((issue, i) => renderComparisonIssueRow(issue, i)).join('')}
        </tbody>
      </table>
    </div>

    <script>
    function filterIssueSev(sev, btn) {
      document.querySelectorAll('.sev-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.issues-table-row').forEach(function(r) {
        var show = sev === 'all' || r.dataset.severity === sev;
        r.style.display = show ? '' : 'none';
        var detail = r.nextElementSibling;
        if (detail && detail.classList.contains('issue-detail-row')) {
          detail.style.display = 'none';
          r.querySelector('.row-chevron').textContent = '▸';
        }
      });
    }
    function toggleIssueDetail(idx) {
      var row = document.getElementById('issue-detail-' + idx);
      var chevron = document.getElementById('issue-chevron-' + idx);
      if (!row) return;
      var showing = row.style.display !== 'none';
      row.style.display = showing ? 'none' : 'table-row';
      if (chevron) chevron.textContent = showing ? '▸' : '▾';
    }
    </script>
  `;
}

function renderComparisonIssueRow(issue: ComparisonIssueEntry, idx: number) {
  const { key, detail, fix, isQuickWin, compareCount, status } = issue;
  const sev = detail.severity;
  const styles = SEVERITY_STYLES[sev] ?? SEVERITY_STYLES.medium;
  const originCount = detail.count ?? detail.examples?.length ?? 0;
  const examples = detail.examples ?? [];

  const statusBadge = status === 'fixed'
    ? '<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">FIXED</span>'
    : status === 'new'
    ? '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">NEW</span>'
    : (() => {
        const delta = compareCount - originCount;
        if (delta === 0) return '<span style="color:#6b7280;font-size:11px;">same</span>';
        const color = delta < 0 ? '#059669' : '#dc2626';
        return `<span style="color:${color};font-size:11px;font-weight:600;">${delta > 0 ? '+' : ''}${delta}</span>`;
      })();

  return `
    <tr class="issues-table-row" data-severity="${sev}" onclick="toggleIssueDetail(${idx})" style="cursor:pointer;">
      <td style="text-align:center;color:#9ca3af;font-size:12px;"><span class="row-chevron" id="issue-chevron-${idx}">▸</span></td>
      <td><span class="issue-sev-pill" style="background:${styles.bg};color:${styles.text};">${sev}</span></td>
      <td style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(key)}">${escapeHtml(key)}${isQuickWin ? ' <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;vertical-align:middle;">QUICK WIN</span>' : ''}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${status === 'new' ? 'color:#9ca3af;' : ''}">${status === 'new' ? '—' : originCount}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${status === 'fixed' ? 'color:#9ca3af;' : ''}">${status === 'fixed' ? '—' : compareCount}</td>
      <td style="text-align:center;">${statusBadge}</td>
      <td style="text-align:right;font-size:12px;color:#6b7280;">${fix?.effort ? escapeHtml(fix.effort) : '—'}</td>
    </tr>
    <tr class="issue-detail-row" id="issue-detail-${idx}" style="display:none;">
      <td colspan="7" style="padding:0;">
        ${renderIssueDetail(key, detail, fix, examples, originCount, idx)}
      </td>
    </tr>
  `;
}

export { getIssuesDetail };
