/**
 * Comparison Helpers
 * Shared utilities for dual-origin report rendering
 */

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
function formatDualScore(origin: number, compare: number, originLabel: string, compareLabel: string): string {
  const delta = compare - origin;
  const deltaColor = getDeltaColor(-delta, true); // higher score = better, so lowerIsBetter=false inverted
  const scoreColor = (s: number) => (s >= 80 ? '#10b981' : s >= 60 ? '#f59e0b' : '#ef4444');
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
  const matchPct =
    total > 0 ? Math.round((matchStats.matched / (matchStats.matched + matchStats.originOnly)) * 100) : 0;

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
  return domain.replace(/^www\./, '');
}

export {
  getDeltaColor,
  formatDeltaBadge,
  formatPercentDelta,
  formatDualValue,
  formatDualScore,
  getComparisonHeader,
  shortDomain,
};
