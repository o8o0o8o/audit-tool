/**
 * Issues Detail Section
 * Flat, scannable table of all issues sorted by severity and impact.
 * Expandable rows show fix suggestions and affected pages.
 */

import { isCrawlerError, SEVERITY_ORDER } from '../../constants';
import { escapeHtml, renderExpandableList } from '../html-utils';
import { extractDetails } from '../data-processor';
import { mergeNumericVariants } from '../../scoring/merge-variants';
import { nextjsOverrideFor, isNextjsAudit } from '../../scoring/nextjs-recommendations';
import { ScoreCalculator } from '../../scoring/score-calculator';
import { extractComparisonLabels } from '../comparison-helpers';
import type { ReportSectionData, AnalysisDetail, FixRecommendation, ComparisonData } from '../../types';

/** Shared inline script for issue table filtering/expanding (used in both main and comparison reports) */
function getIssueTableScript() {
  return `<style>
    @media print {
      .issues-table-row[data-overflow="1"] { display: table-row !important; }
      .issues-show-all { display: none !important; }
    }
    </style>
    <script>
    function applyIssueRows(section) {
      var sev = section.dataset.sev || 'all';
      var expanded = section.dataset.expanded === '1';
      section.querySelectorAll('.issues-table-row').forEach(function(r) {
        var show = sev === 'all' ? (expanded || r.dataset.overflow !== '1') : r.dataset.severity === sev;
        r.style.display = show ? '' : 'none';
        var detail = r.nextElementSibling;
        if (detail && detail.classList.contains('issue-detail-row')) {
          detail.style.display = 'none';
          r.querySelector('.row-chevron').textContent = '▸';
        }
      });
      var more = section.querySelector('.issues-show-all');
      if (more) {
        more.style.display = sev === 'all' ? '' : 'none';
        more.textContent = expanded ? 'Show less' : more.dataset.label;
      }
    }
    function filterIssueSev(sev, btn) {
      var section = btn.closest('.issues-section');
      section.querySelectorAll('.sev-pill').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      section.dataset.sev = sev;
      applyIssueRows(section);
    }
    function toggleIssuesShowAll(btn) {
      var section = btn.closest('.issues-section');
      section.dataset.expanded = section.dataset.expanded === '1' ? '0' : '1';
      applyIssueRows(section);
    }
    function toggleIssueDetail(idx) {
      var row = document.getElementById('issue-detail-' + idx);
      var chevron = document.getElementById('issue-chevron-' + idx);
      if (!row) return;
      var showing = row.style.display !== 'none';
      row.style.display = showing ? 'none' : 'table-row';
      if (chevron) chevron.textContent = showing ? '▸' : '▾';
    }
    </script>`;
}

/** Issues shown before the "Show all" toggle; the rest are the lowest-severity ones after the sort. */
const ISSUES_VISIBLE = 10;

function overflowAttrs(idx: number) {
  return idx >= ISSUES_VISIBLE ? ' data-overflow="1"' : '';
}

function renderShowAllButton(total: number) {
  if (total <= ISSUES_VISIBLE) return '';
  const label = `Show all (${total})`;
  return `<button type="button" class="issues-show-all sev-pill" data-label="${label}" onclick="toggleIssuesShowAll(this)" style="margin-top:12px;">${label}</button>`;
}

const SEVERITY_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  critical: {
    bg: 'var(--color-severity-critical-bg)',
    text: 'var(--color-severity-critical-text)',
    dot: 'var(--color-error)',
  },
  high: { bg: 'var(--color-severity-high-bg)', text: 'var(--color-severity-high-text)', dot: 'var(--orange-500)' },
  medium: {
    bg: 'var(--color-severity-medium-bg)',
    text: 'var(--color-severity-medium-text)',
    dot: 'var(--color-warning)',
  },
  low: { bg: 'var(--color-severity-low-bg)', text: 'var(--color-severity-low-text)', dot: 'var(--green-500)' },
};

/** Count issues by severity level. */
function countBySeverity(issues: { detail: { severity: string } }[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    const sev = issue.detail.severity as keyof typeof counts;
    if (sev in counts) counts[sev]++;
  }
  return counts;
}

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
  // Group numeric-variant findings (e.g. "Element with too many children (87)"
  // / "(65)") into one row with the summed count and merged examples, instead
  // of one row per variant.
  const details = mergeNumericVariants(extractDetails(jsonData));
  const fixes = ScoreCalculator.getFixRecommendations();
  const isNextjs = isNextjsAudit(
    (jsonData.repoAnalysis as { framework?: string } | undefined)?.framework,
    Object.values(details).flatMap((d) => d.examples ?? []),
  );

  // Build issue list
  const issues: IssueEntry[] = [];
  for (const [key, detail] of Object.entries(details)) {
    if (isCrawlerError(key)) continue;
    const count = detail.count ?? detail.examples?.length ?? 0;
    if (count === 0) continue;

    // When the site is Next.js, swap generic examples/advice for the idiomatic
    // Next.js equivalent (next/image, Metadata API, next.config redirects, …).
    const baseFix = fixes[key] ?? null;
    const override = isNextjs ? nextjsOverrideFor(key) : undefined;
    const fix = override ? ({ ...(baseFix ?? {}), ...override } as FixRecommendation) : baseFix;
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

  const counts = countBySeverity(issues);

  return `
    <div class="issues-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <h2 style="margin:0;font-size:var(--font-size-lg);color:var(--gray-800);">Issues (${issues.length})</h2>
        <div class="severity-filter-bar">
          ${renderFilterPill('all', 'All', issues.length, true)}
          ${counts.critical > 0 ? renderFilterPill('critical', 'Critical', counts.critical) : ''}
          ${counts.high > 0 ? renderFilterPill('high', 'High', counts.high) : ''}
          ${counts.medium > 0 ? renderFilterPill('medium', 'Medium', counts.medium) : ''}
          ${counts.low > 0 ? renderFilterPill('low', 'Low', counts.low) : ''}
        </div>
      </div>

      ${counts.critical > 0 ? `<div style="background:var(--color-error-bg);border:1px solid var(--color-error-border);border-radius:var(--radius-lg);padding:10px 14px;margin-bottom:16px;font-size:var(--font-size-sm);color:var(--color-error-text);"><strong>${counts.critical} critical issue${counts.critical > 1 ? 's' : ''}</strong> require immediate attention.</div>` : ''}

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
      ${renderShowAllButton(issues.length)}
    </div>

    ${getIssueTableScript()}
  `;
}

function renderFilterPill(value: string, label: string, count: number, active = false) {
  const sev = SEVERITY_STYLES[value];
  const activeStyle = active ? 'background:var(--color-accent);color:#000;border-color:var(--color-accent);' : '';
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
    <tr class="issues-table-row" data-severity="${sev}"${overflowAttrs(idx)} onclick="toggleIssueDetail(${idx})" style="cursor:pointer;${idx >= ISSUES_VISIBLE ? 'display:none;' : ''}">
      <td style="text-align:center;color:var(--color-text-disabled);font-size:var(--font-size-xs);"><span class="row-chevron" id="issue-chevron-${idx}">▸</span></td>
      <td><span class="issue-sev-pill" style="background:${styles.bg};color:${styles.text};">${sev}</span></td>
      <td style="font-weight:var(--font-weight-medium);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(key)}">${escapeHtml(key)}${isQuickWin ? ' <span style="background:var(--amber-100);color:var(--color-warning-text);padding:1px 6px;border-radius:var(--radius-sm);font-size:var(--font-size-2xs);font-weight:var(--font-weight-semibold);vertical-align:middle;">QUICK WIN</span>' : ''}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${count}</td>
      <td style="text-align:right;font-size:var(--font-size-xs);color:var(--color-text-muted);">${fix?.effort ? ScoreCalculator.effortLevel(fix.effort) : '—'}</td>
    </tr>
    <tr class="issue-detail-row" id="issue-detail-${idx}"${overflowAttrs(idx)} style="display:none;">
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
      <div style="font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);color:var(--green-emerald-600);margin-bottom:4px;">How to fix</div>
      <div style="font-size:var(--font-size-sm);color:var(--color-text-secondary);line-height:1.5;">${escapeHtml(fix.fix)}</div>
      ${fix.example ? `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:var(--font-size-xs);color:var(--color-info);font-weight:var(--font-weight-medium);">Code example</summary><pre style="margin-top:4px;padding:8px;background:var(--gray-800);color:var(--color-border-default);border-radius:var(--radius-sm);font-size:var(--font-size-xs);overflow-x:auto;white-space:pre-wrap;">${escapeHtml(fix.example)}</pre></details>` : ''}
    </div>
  `
    : '';

  const pagesHtml =
    examples.length > 0
      ? `
    <div>
      <div style="font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);color:var(--color-text-muted);margin-bottom:4px;">Affected pages (${count})</div>
      <div style="display:flex;flex-direction:column;gap:2px;">
        ${renderExpandableList(
          examples,
          // Escape at the sink: `examples` come from analyzer `detail` strings
          // that interpolate attacker-controlled page content (titles, anchor
          // text, hrefs). Rendering them raw is stored XSS in a report the
          // author opens locally (often file://). Matches top-issues/quick-wins.
          (ex) =>
            `<div style="font-size:var(--font-size-xs);color:var(--color-text-secondary);padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ex)}</div>`,
          `issue-detail-more-${idx}`,
          VISIBLE,
          count,
        )}
      </div>
    </div>
  `
      : '';

  return `
    <div style="padding:12px 12px 12px 44px;background:var(--color-bg-page);border-bottom:1px solid var(--color-border-default);">
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
  const originDetails = mergeNumericVariants(extractDetails(jsonData));
  const compareDetails = mergeNumericVariants(extractDetails(comparison.compareJsonData));

  const fixes = ScoreCalculator.getFixRecommendations();
  const isNextjs = isNextjsAudit(
    (jsonData.repoAnalysis as { framework?: string } | undefined)?.framework,
    Object.values(originDetails).flatMap((d) => d.examples ?? []),
  );

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
    const baseFix = fixes[key] ?? null;
    const override = isNextjs ? nextjsOverrideFor(key) : undefined;
    const fix = override ? ({ ...(baseFix ?? {}), ...override } as FixRecommendation) : baseFix;
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

  const counts = countBySeverity(issues);

  const fixedCount = issues.filter((i) => i.status === 'fixed').length;
  const newCount = issues.filter((i) => i.status === 'new').length;
  const { originLabel, compareLabel } = extractComparisonLabels(comparison);

  return `
    <div class="issues-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
        <h2 style="margin:0;font-size:var(--font-size-lg);color:var(--gray-800);">Issues Comparison (${issues.length})</h2>
        <div class="severity-filter-bar">
          ${renderFilterPill('all', 'All', issues.length, true)}
          ${counts.critical > 0 ? renderFilterPill('critical', 'Critical', counts.critical) : ''}
          ${counts.high > 0 ? renderFilterPill('high', 'High', counts.high) : ''}
          ${counts.medium > 0 ? renderFilterPill('medium', 'Medium', counts.medium) : ''}
          ${counts.low > 0 ? renderFilterPill('low', 'Low', counts.low) : ''}
        </div>
      </div>

      ${
        fixedCount > 0 || newCount > 0
          ? `
      <div style="display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        ${fixedCount > 0 ? `<div style="background: var(--color-success-bg); border: 1px solid var(--color-success-border); border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--color-success-text);"><strong>${fixedCount} issue${fixedCount > 1 ? 's' : ''}</strong> fixed in ${escapeHtml(compareLabel)}</div>` : ''}
        ${newCount > 0 ? `<div style="background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 8px; padding: 10px 14px; font-size: 13px; color: var(--color-error-text);"><strong>${newCount} new issue${newCount > 1 ? 's' : ''}</strong> in ${escapeHtml(compareLabel)}</div>` : ''}
      </div>
      `
          : ''
      }

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
      ${renderShowAllButton(issues.length)}
    </div>

    ${getIssueTableScript()}
  `;
}

function renderComparisonIssueRow(issue: ComparisonIssueEntry, idx: number) {
  const { key, detail, fix, isQuickWin, compareCount, status } = issue;
  const sev = detail.severity;
  const styles = SEVERITY_STYLES[sev] ?? SEVERITY_STYLES.medium;
  const originCount = detail.count ?? detail.examples?.length ?? 0;
  const examples = detail.examples ?? [];

  const statusBadge =
    status === 'fixed'
      ? '<span style="background:var(--color-success-bg);color:var(--color-success-text);padding:2px 8px;border-radius:var(--radius-sm);font-size:var(--font-size-2xs);font-weight:var(--font-weight-semibold);">FIXED</span>'
      : status === 'new'
        ? '<span style="background:var(--color-error-bg);color:var(--color-error-text);padding:2px 8px;border-radius:var(--radius-sm);font-size:var(--font-size-2xs);font-weight:var(--font-weight-semibold);">NEW</span>'
        : (() => {
            const delta = compareCount - originCount;
            if (delta === 0)
              return '<span style="color:var(--color-text-muted);font-size:var(--font-size-xs);">same</span>';
            const color = delta < 0 ? 'var(--color-success-alt)' : 'var(--color-error-alt)';
            return `<span style="color:${color};font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);">${delta > 0 ? '+' : ''}${delta}</span>`;
          })();

  return `
    <tr class="issues-table-row" data-severity="${sev}"${overflowAttrs(idx)} onclick="toggleIssueDetail(${idx})" style="cursor:pointer;${idx >= ISSUES_VISIBLE ? 'display:none;' : ''}">
      <td style="text-align:center;color:var(--color-text-disabled);font-size:var(--font-size-xs);"><span class="row-chevron" id="issue-chevron-${idx}">▸</span></td>
      <td><span class="issue-sev-pill" style="background:${styles.bg};color:${styles.text};">${sev}</span></td>
      <td style="font-weight:var(--font-weight-medium);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${escapeHtml(key)}">${escapeHtml(key)}${isQuickWin ? ' <span style="background:var(--amber-100);color:var(--color-warning-text);padding:1px 6px;border-radius:var(--radius-sm);font-size:var(--font-size-2xs);font-weight:var(--font-weight-semibold);vertical-align:middle;">QUICK WIN</span>' : ''}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${status === 'new' ? 'color:var(--color-text-disabled);' : ''}">${status === 'new' ? '—' : originCount}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${status === 'fixed' ? 'color:var(--color-text-disabled);' : ''}">${status === 'fixed' ? '—' : compareCount}</td>
      <td style="text-align:center;">${statusBadge}</td>
      <td style="text-align:right;font-size:var(--font-size-xs);color:var(--color-text-muted);">${fix?.effort ? ScoreCalculator.effortLevel(fix.effort) : '—'}</td>
    </tr>
    <tr class="issue-detail-row" id="issue-detail-${idx}"${overflowAttrs(idx)} style="display:none;">
      <td colspan="7" style="padding:0;">
        ${renderIssueDetail(key, detail, fix, examples, originCount, idx)}
      </td>
    </tr>
  `;
}

export { getIssuesDetail };
