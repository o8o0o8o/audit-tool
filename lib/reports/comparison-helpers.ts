/**
 * Comparison Helpers
 * Shared utilities for dual-origin report rendering
 */

import { calcPercent, stripWww } from '../utils';
import { getScoreClass } from './html-utils';

/**
 * Get color based on whether delta represents improvement or regression
 * @param delta - The numeric difference (positive = increase)
 * @param lowerIsBetter - If true, negative delta is good (e.g., load time, error count)
 */
function getDeltaColor(delta: number, lowerIsBetter = true): string {
  if (delta === 0) return '#6b7280'; // gray
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
  return isImprovement ? '#10b981' : '#ef4444'; // green or red
}

/**
 * Format a delta value as a small colored badge
 * @param delta - The numeric difference
 * @param unit - Unit string (ms, %, etc.)
 * @param lowerIsBetter - If true, negative delta is good
 */
function formatDeltaBadge(delta: number, unit = '', lowerIsBetter = true): string {
  if (delta === 0) return '<span class="delta-badge neutral">—</span>';
  const color = getDeltaColor(delta, lowerIsBetter);
  const arrow = delta > 0 ? '▲' : '▼';
  const sign = delta > 0 ? '+' : '';
  const displayValue = unit === '%' ? Math.abs(delta).toFixed(1) : Math.abs(delta).toFixed(0);
  return `<span class="delta-badge" style="color: ${color};">${arrow} ${sign}${delta > 0 ? '' : '-'}${displayValue}${unit}</span>`;
}

/**
 * Format a percentage delta badge
 * @param origin - Origin value
 * @param compare - Compare value
 * @param lowerIsBetter - If true, lower values are better
 */
function formatPercentDelta(origin: number, compare: number, lowerIsBetter = true): string {
  if (origin === 0 && compare === 0) return '';
  if (origin === 0) return '<span class="delta-badge" style="color: #6b7280;">new</span>';
  const pctChange = ((compare - origin) / origin) * 100;
  if (Math.abs(pctChange) < 0.5) return '<span class="delta-badge neutral">—</span>';
  const color = getDeltaColor(pctChange, lowerIsBetter);
  const arrow = pctChange > 0 ? '▲' : '▼';
  return `<span class="delta-badge" style="color: ${color};">${arrow} ${Math.abs(pctChange).toFixed(0)}%</span>`;
}

/**
 * Render two values side by side with labels and optional delta
 * @param originValue - Display string for origin
 * @param compareValue - Display string for compare
 * @param originLabel - Short label for origin (domain name)
 * @param compareLabel - Short label for compare (domain name)
 * @param delta - Optional delta badge HTML
 */
function formatDualValue(
  originValue: string,
  compareValue: string,
  originLabel: string,
  compareLabel: string,
  delta = '',
): string {
  return `<div class="dual-value">
  <div class="dual-value-item origin-value">
    <span class="dual-label origin-label">${originLabel}</span>
    <span class="dual-val">${originValue}</span>
  </div>
  <div class="dual-value-item compare-value">
    <span class="dual-label compare-label">${compareLabel}</span>
    <span class="dual-val">${compareValue}</span>
  </div>
  ${delta ? `<div class="dual-delta">${delta}</div>` : ''}
</div>`;
}

/**
 * Format two scores with a visual delta
 */
const SCORE_HEX_COLORS: Record<string, string> = { good: '#10b981', warning: '#f59e0b', bad: '#ef4444' };

function formatDualScore(origin: number, compare: number, originLabel: string, compareLabel: string): string {
  const delta = compare - origin;
  const deltaColor = getDeltaColor(-delta, true); // higher score = better, so lowerIsBetter=false inverted
  const scoreColor = (s: number) => SCORE_HEX_COLORS[getScoreClass(s)];
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '';
  const deltaText = delta !== 0 ? `${arrow} ${Math.abs(delta)}` : '—';

  return `<div class="dual-score">
  <div class="dual-score-item">
    <span class="dual-label origin-label">${originLabel}</span>
    <span class="dual-score-val" style="color: ${scoreColor(origin)};">${origin}</span>
  </div>
  <div class="dual-score-delta" style="color: ${deltaColor};">${deltaText}</div>
  <div class="dual-score-item">
    <span class="dual-label compare-label">${compareLabel}</span>
    <span class="dual-score-val" style="color: ${scoreColor(compare)};">${compare}</span>
  </div>
</div>`;
}

/**
 * Render a comparison header bar with origin vs compare domain names
 */
function getComparisonHeader(
  originDomain: string,
  compareDomain: string,
  matchStats: { matched: number; originOnly: number; compareOnly: number },
): string {
  const total = matchStats.matched + matchStats.originOnly + matchStats.compareOnly;
  const matchPct = calcPercent(matchStats.matched, matchStats.matched + matchStats.originOnly);

  return `<div class="comparison-header">
  <div class="comparison-header-sites">
    <span class="comparison-origin-badge">${originDomain}</span>
    <span class="comparison-vs">vs</span>
    <span class="comparison-compare-badge">${compareDomain}</span>
  </div>
  <div class="comparison-header-stats">
    <span>${matchStats.matched} matched pages (${matchPct}%)</span>
    ${matchStats.originOnly > 0 ? `<span class="comparison-stat-origin">${matchStats.originOnly} only in origin</span>` : ''}
    ${matchStats.compareOnly > 0 ? `<span class="comparison-stat-compare">${matchStats.compareOnly} only in compare</span>` : ''}
  </div>
</div>`;
}

/**
 * Short domain label (strip www. prefix)
 */
function shortDomain(domain: string): string {
  return stripWww(domain);
}

/**
 * Get CSS class name for a delta value (positive/negative/neutral)
 * @param value - Delta value (positive = increase)
 */
function deltaClass(value: number): 'positive' | 'negative' | 'neutral' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

/**
 * Get sign prefix for a delta value
 */
function deltaSymbol(value: number): string {
  return value > 0 ? '+' : '';
}

/**
 * Get CSS variable color for a delta (for use in report section templates)
 * @param delta - Numeric change
 * @param higherIsBetter - If true, positive delta is good (default true)
 */
function getDeltaCssColor(delta: number, higherIsBetter = true): string {
  if (delta === 0) return 'var(--color-text-muted)';
  const isGood = higherIsBetter ? delta > 0 : delta < 0;
  return isGood ? 'var(--color-success)' : 'var(--color-error)';
}

/**
 * Extract origin/compare labels from comparison data.
 * Avoids repeating shortDomain(comparison.originDomainName) across report sections.
 */
function extractComparisonLabels(comparison: { originDomainName: string; compareDomainName: string }) {
  return {
    originLabel: shortDomain(comparison.originDomainName),
    compareLabel: shortDomain(comparison.compareDomainName),
  };
}

/**
 * Format a metric delta with sign, class, and unit for comparison reports.
 * Computes the delta between two string/number values and returns the HTML span.
 * @param oldVal - Old metric value (string or number)
 * @param newVal - New metric value (string or number)
 * @param unit - Unit string (e.g., 'ms', '')
 * @param decimals - Number of decimal places (default: 0)
 */
function formatMetricDelta(oldVal: string | number, newVal: string | number, unit = 'ms', decimals = 0): string {
  const delta = parseFloat(String(newVal)) - parseFloat(String(oldVal));
  return formatDeltaSpan(delta, unit, decimals);
}

/**
 * Format a pre-computed delta value as a styled span with sign, CSS class, and unit.
 * @param delta - The numeric delta (positive = increase)
 * @param unit - Unit string (e.g., 'ms', '')
 * @param decimals - Number of decimal places (default: 0)
 * @param lowerIsBetter - If true (default), positive delta is bad (latency, errors)
 */
function formatDeltaSpan(delta: number, unit = 'ms', decimals = 0, lowerIsBetter = true): string {
  const cls = lowerIsBetter ? deltaClass(-delta) : deltaClass(delta);
  return `<span class="delta ${cls}">${deltaSymbol(delta)}${delta.toFixed(decimals)}${unit}</span>`;
}

export {
  getDeltaColor,
  getDeltaCssColor,
  formatDeltaBadge,
  formatPercentDelta,
  formatDualValue,
  formatDualScore,
  getComparisonHeader,
  shortDomain,
  extractComparisonLabels,
  deltaClass,
  deltaSymbol,
  formatMetricDelta,
  formatDeltaSpan,
};
