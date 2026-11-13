/**
 * Historical Progress Section
 * Displays trend charts and progress metrics over time
 */

import { escapeHtml, getSeverityBadge } from '../html-utils';
import { truncateText } from '../../utils';
import { extractAnalysis, extractSummary } from '../data-processor';
import { getDeltaCssColor } from '../comparison-helpers';
import type { ReportSectionData, TrendDataCompat, AuditSnapshot, IssueTrend } from '../../types';

const SCORE_RULES_LINK = '<a href="#score-rules" class="score-rules-link" title="How is this score calculated?">ⓘ</a>';

type IssueTrendItem = IssueTrend & { issue: string; priorityScore: number };

/**
 * Generate the historical progress section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @param {Object} data.trendData - Historical trend data
 * @param {Object} data.previousAudit - Previous audit for comparison
 * @returns {string} HTML string for the historical progress section
 */
function getHistoricalProgress(data: ReportSectionData) {
  // In comparison mode, skip historical trends (not meaningful for cross-site comparison)
  if (data.comparison) return '';

  const { jsonData, trendData, previousAudit } = data;
  const noScore = data.noScore === true;

  const summaryObj = extractSummary(jsonData);
  const currentScore = (summaryObj.overallScore ?? 0) as number;
  const currentIssues = (summaryObj.totalIssues ?? 0) as number;
  const auditCount = trendData?.labels?.length ?? 1;

  // Show first audit message if no previous audit
  if (!previousAudit || !trendData || auditCount < 2) {
    return '<p class="history-note">Trends appear after your second audit.</p>';
  }

  const scoreDelta = currentScore - previousAudit.summary.overallScore;
  const issuesDelta = currentIssues - previousAudit.summary.totalIssues;

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: var(--gray-800); margin-bottom: 10px;">Historical Progress</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">Track your SEO improvements over ${auditCount} audit${auditCount > 1 ? 's' : ''}</p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${noScore ? '' : getDeltaCard(`Score Change ${SCORE_RULES_LINK}`, scoreDelta, scoreDelta >= 0, 'Since last audit')}
        ${getDeltaCard('Issues Change', issuesDelta, issuesDelta <= 0, 'Since last audit', true)}
        ${getInfoCard('Total Audits', auditCount, 'var(--color-info)', 'var(--color-link)', 'Tracked over time')}
        ${noScore ? '' : getInfoCard(`Current Score ${SCORE_RULES_LINK}`, currentScore, 'var(--purple-500)', 'var(--purple-600)', 'Out of 100')}
      </div>

      ${noScore ? '' : getCategoryDeltaCards(jsonData, previousAudit)}

      <div class="charts-grid">
        ${
          noScore
            ? ''
            : `<div class="chart-card">
          <div class="chart-title">Overall Score Trend ${SCORE_RULES_LINK}</div>
          <div class="chart-container">
            <canvas id="scoreTrendChart"></canvas>
          </div>
        </div>`
        }

        <div class="chart-card">
          <div class="chart-title">Total Issues Trend</div>
          <div class="chart-container">
            <canvas id="issuesTrendChart"></canvas>
          </div>
        </div>
      </div>

      ${getIssueTrendsSection(trendData)}

      ${getInsightTrends(trendData)}
    </div>
  `;
}

/**
 * Show trends for new insight metrics (language, coverage, outbound links)
 */
function getInsightTrends(trendData: TrendDataCompat | null) {
  if (!trendData?.insights) return '';

  const metrics = [
    { key: 'languageMismatches', label: 'Language Mismatches', icon: '🌐', inverse: true },
    { key: 'brokenOutboundLinks', label: 'Broken Outbound Links', icon: '🔗', inverse: true },
    { key: 'nearDuplicatePages', label: 'Near-Duplicate Pages', icon: '📄', inverse: true },
    { key: 'avgJsUnused', label: 'Avg Unused JS %', icon: '📦', inverse: true },
  ];

  const rows = [];
  for (const m of metrics) {
    const values = trendData.insights[m.key];
    if (!values || values.every((v: number | null) => v === null)) continue;

    const nonNull = values.filter((v: number | null) => v !== null);
    if (nonNull.length < 2) continue;

    const first = nonNull[0];
    const last = nonNull[nonNull.length - 1];
    const delta = last - first;
    const improved = m.inverse ? delta < 0 : delta > 0;
    const arrow = delta === 0 ? '→' : improved ? '↓' : '↑';
    const color = delta === 0 ? 'var(--color-text-muted)' : improved ? 'var(--color-success)' : 'var(--color-error)';

    rows.push(`
      <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--color-bg-page);border-radius:var(--radius-md);">
        <span style="font-size:var(--font-size-md);">${m.icon}</span>
        <span style="flex:1;font-size:var(--font-size-sm);color:var(--color-text-secondary);">${m.label}</span>
        <span style="font-size:var(--font-size-sm);color:var(--color-text-disabled);">${first}</span>
        <span style="color:${color};font-weight:600;">${arrow} ${last}</span>
        <span style="font-size:12px;color:${color};">(${delta > 0 ? '+' : ''}${typeof delta === 'number' && !Number.isInteger(delta) ? delta.toFixed(1) : delta})</span>
      </div>
    `);
  }

  if (rows.length === 0) return '';

  return `
    <div style="margin-top:24px;">
      <h3 style="font-size:var(--font-size-md);color:var(--gray-800);margin-bottom:12px;">Insight Trends</h3>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${rows.join('')}
      </div>
    </div>
  `;
}

/**
 * Generate the issue trends section with sparkline charts
 * @param {Object} trendData - Trend data including issueTrends
 * @returns {string} HTML string for the issue trends section
 */
function getIssueTrendsSection(trendData: TrendDataCompat) {
  if (!trendData.issueTrends || Object.keys(trendData.issueTrends).length === 0) {
    return '';
  }

  // Get top 10 most significant trending issues
  const sortedIssues = Object.entries(trendData.issueTrends)
    .map(([issue, data]: [string, IssueTrend]) => ({
      issue,
      ...data,
      // Priority score: critical/high severity + high count + significant change
      priorityScore: getSeverityWeight(data.severity) * data.latestCount * (1 + Math.abs(data.change) / 10),
    }))
    .filter((item: IssueTrendItem) => item.latestCount > 0 || item.trend === 'fixed') // Only show active or recently fixed
    .sort((a: IssueTrendItem, b: IssueTrendItem) => b.priorityScore - a.priorityScore)
    .slice(0, 10);

  if (sortedIssues.length === 0) {
    return '';
  }

  const issueRows = sortedIssues
    .map((item: IssueTrendItem, index: number) => {
      const trendIcon = getTrendIcon(item.trend);
      const changeText = getChangeText(item);
      const firstCount = item.counts[0] || 0;
      const latestCount = item.latestCount;

      return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid var(--color-border-default);">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--color-text-disabled); font-size: var(--font-size-xs);">${index + 1}.</span>
            <span style="font-size: var(--font-size-sm); color: var(--color-text-secondary);">${escapeHtml(truncateIssue(item.issue, 60))}</span>
          </div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid var(--color-border-default); text-align: center;">
          ${getSeverityBadge(item.severity.toUpperCase())}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid var(--color-border-default); text-align: center;">
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${firstCount} pages</div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid var(--color-border-default); text-align: center;">
          <div style="font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); color: var(--gray-800);">${latestCount} pages</div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid var(--color-border-default); text-align: center;">
          <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
            ${trendIcon}
            <span style="font-size: var(--font-size-xs); color: ${getTrendColor(item.trend)};">${changeText}</span>
          </div>
        </td>
      </tr>
    `;
    })
    .join('');

  return `
    <div style="margin-top: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 15px; display: flex; align-items: center; gap: 8px;">Issue Changes Between Audits
        <span style="font-size: var(--font-size-xs); font-weight: 400; color: var(--color-text-muted);">(Top 10 most impactful)</span>
      </h3>
      <p style="color: var(--color-text-muted); font-size: var(--font-size-sm); margin-bottom: 15px;">
        Comparing affected pages: first audit → current audit. ↓ = improving (fewer pages), ↑ = worsening (more pages)
      </p>
      <div style="background: var(--color-bg-surface); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm);">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--color-bg-page);">
              <th style="padding: 12px; text-align: left; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase;">Issue</th>
              <th style="padding: 12px; text-align: center; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase;">Severity</th>
              <th style="padding: 12px; text-align: center; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase;">First Audit</th>
              <th style="padding: 12px; text-align: center; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase;">Now</th>
              <th style="padding: 12px; text-align: center; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase;">Change</th>
            </tr>
          </thead>
          <tbody>
            ${issueRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Helper functions for issue trends
 */
function getSeverityWeight(severity: string) {
  const weights: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  return weights[severity?.toLowerCase()] ?? 1;
}

function getTrendIcon(trend: string) {
  const icons: Record<string, string> = {
    improving: '<span style="color: var(--color-success); font-size: var(--font-size-md);">↓</span>',
    worsening: '<span style="color: var(--color-error); font-size: var(--font-size-md);">↑</span>',
    stable: '<span style="color: var(--color-text-muted); font-size: var(--font-size-md);">→</span>',
    new: '<span style="color: var(--color-warning); font-size: var(--font-size-base);">🆕</span>',
    fixed: '<span style="color: var(--color-success); font-size: var(--font-size-base);">✓</span>',
  };
  return icons[trend] ?? icons.stable;
}

function getTrendColor(trend: string) {
  const colors: Record<string, string> = {
    improving: 'var(--color-success)',
    worsening: 'var(--color-error)',
    stable: 'var(--color-text-muted)',
    new: 'var(--color-warning)',
    fixed: 'var(--color-success)',
  };
  return colors[trend] ?? 'var(--color-text-muted)';
}

function getChangeText(item: IssueTrendItem) {
  if (item.trend === 'new') return 'New';
  if (item.trend === 'fixed') return 'Fixed';
  if (item.change === 0) return 'No change';
  const sign = item.change > 0 ? '+' : '';
  return `${sign}${item.change} (${sign}${item.changePercent}%)`;
}

const truncateIssue = truncateText;

// escapeHtml imported from ../html-utils

/**
 * Generate a delta card (shows change with color coding)
 */
function getDeltaCard(
  title: string,
  value: number,
  isPositive: boolean,
  subtitle: string,
  invertSign: boolean = false,
) {
  const displayValue = invertSign ? value : value;
  const gradient = isPositive ? 'var(--gradient-success)' : 'var(--gradient-danger)';

  return `
    <div style="background: ${gradient}; color: white; padding: 20px; border-radius: var(--radius-lg); text-align: center;">
      <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 10px;">${title}</div>
      <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${displayValue > 0 ? '+' : ''}${displayValue}</div>
      <div style="font-size: var(--font-size-xs); opacity: 0.9;">${subtitle}</div>
    </div>
  `;
}

/**
 * Generate an info card (static value)
 */
function getInfoCard(
  title: string,
  value: string | number,
  gradientStart: string,
  gradientEnd: string,
  subtitle: string,
) {
  return `
    <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid ${gradientStart}; color: var(--color-text-primary); padding: 20px; border-radius: var(--radius-lg); text-align: center;">
      <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 10px;">${title}</div>
      <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${value}</div>
      <div style="font-size: var(--font-size-xs); opacity: 0.9;">${subtitle}</div>
    </div>
  `;
}

/**
 * Generate category score deltas between current and previous audit
 */
function getCategoryDeltaCards(jsonData: Record<string, unknown>, previousAudit: AuditSnapshot | null) {
  const summaryObj = extractSummary(jsonData);
  const currentCats = (summaryObj.categoryScores ?? {}) as Record<string, number>;
  const prevCats = (previousAudit?.summary?.categoryScores ?? {}) as Record<string, number>;

  const categories = [
    { key: 'seo', name: 'SEO', icon: '🔍' },
    { key: 'performance', name: 'Performance', icon: '⚡' },
    { key: 'accessibility', name: 'Accessibility', icon: '♿' },
    { key: 'security', name: 'Security', icon: '🔒' },
    { key: 'technical', name: 'Technical', icon: '🔧' },
  ];

  const cards = categories
    .map((cat) => {
      const current = currentCats[cat.key] || 0;
      const prev = prevCats[cat.key];
      if (prev === undefined) return '';

      const delta = current - prev;
      const color = getDeltaCssColor(delta);
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      const sign = delta > 0 ? '+' : '';

      return `
      <div style="text-align: center; padding: 12px;">
        <div style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 4px;">${cat.icon} ${cat.name}</div>
        <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: var(--gray-800);">${current}</div>
        <div style="font-size: var(--font-size-sm); color: ${color}; font-weight: var(--font-weight-semibold);">${sign}${delta} ${arrow}</div>
      </div>
    `;
    })
    .filter(Boolean);

  if (cards.length === 0) return '';

  return `
    <div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; padding: 16px; background: var(--color-bg-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);">
      <div style="width: 100%; text-align: center; font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 8px; font-weight: var(--font-weight-semibold);">Category Changes vs Previous Audit ${SCORE_RULES_LINK}</div>
      ${cards.join('')}
    </div>
  `;
}

export { getHistoricalProgress };
