/**
 * Executive Summary Section
 * Displays overall score, issue counts, and category health
 * Supports dual-origin comparison mode
 */

import { CATEGORY_CONFIG } from '../metrics-metadata';
import { formatDeltaBadge, shortDomain } from '../comparison-helpers';
import type { PageInfo, ReportSectionData, CategoryScores, ComparisonData } from '../../types';

/** Helper to extract summary from jsonData */
function extractSummary(jsonData: Record<string, unknown>) {
  const analysisObj = (jsonData.analysis ?? {}) as Record<string, unknown>;
  return (analysisObj.summary ?? {}) as Record<string, unknown>;
}

function getScoreColor(score: number): string {
  return score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
}

function getLetterGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Generate the executive summary section
 */
function getExecutiveSummary(data: ReportSectionData) {
  const { jsonData, comparison } = data;

  if (comparison) {
    return getComparisonExecutiveSummary(jsonData, comparison);
  }

  return getSingleExecutiveSummary(data);
}

/** Single-origin executive summary (original behavior) */
function getSingleExecutiveSummary(data: ReportSectionData) {
  const { jsonData } = data;
  const summary = extractSummary(jsonData);
  const overallScore = (summary.overallScore ?? 0) as number;
  const categoryScores = (summary.categoryScores ?? {}) as Record<string, number>;

  let scoreClass = 'bad';
  if (overallScore >= 80) scoreClass = 'good';
  else if (overallScore >= 60) scoreClass = 'warning';

  const letterGrade = getLetterGrade(overallScore);

  const categoryHealthHtml =
    Object.keys(categoryScores).length > 0
      ? `
    <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.2);">
      <div style="text-align: center; margin-bottom: 16px; font-size: 14px; opacity: 0.9;">Category Health</div>
      ${getCategoryBars(categoryScores)}
    </div>
  `
      : '';

  return `
    <div class="executive-summary">
      <h2>📊 Executive Summary</h2>

      <div class="summary-score">
        <div class="score-circle" style="position: relative;">
          <div class="score-ring" style="--score: ${overallScore}; --color: ${getScoreColor(overallScore)};"></div>
          <div class="score-number ${scoreClass}">${overallScore}</div>
          <div class="score-label">Site Health (${letterGrade})</div>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-card-value">${summary.totalIssues ?? 0}</div>
          <div class="summary-card-label">Total Issues</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fca5a5;">${summary.criticalCount ?? 0}</div>
          <div class="summary-card-label">Critical</div>
          ${((summary.criticalCount as number) ?? 0) > 0 ? '<div class="summary-card-hint">Fix immediately</div>' : ''}
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fdba74;">${summary.highCount ?? 0}</div>
          <div class="summary-card-label">High</div>
          ${((summary.highCount as number) ?? 0) > 0 ? '<div class="summary-card-hint">Fix this week</div>' : ''}
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fde047;">${summary.mediumCount ?? 0}</div>
          <div class="summary-card-label">Medium</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #a5f3fc;">${summary.lowCount ?? 0}</div>
          <div class="summary-card-label">Low</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value">${summary.passRate ?? 0}%</div>
          <div class="summary-card-label">Pass Rate</div>
        </div>
      </div>

      ${getEstimatedScoreAfterFixes(summary, overallScore)}

      ${categoryHealthHtml}

      ${getInsightHighlights(jsonData)}
    </div>
  `;
}

/** Dual-origin comparison executive summary */
function getComparisonExecutiveSummary(jsonData: Record<string, unknown>, comparison: ComparisonData) {
  const originSummary = extractSummary(jsonData);
  const compareSummary = extractSummary(comparison.compareJsonData);

  const originScore = (originSummary.overallScore ?? 0) as number;
  const compareScore = (compareSummary.overallScore ?? 0) as number;
  const scoreDelta = compareScore - originScore;

  const originLabel = shortDomain(comparison.originDomainName);
  const compareLabel = shortDomain(comparison.compareDomainName);

  const originCategoryScores = (originSummary.categoryScores ?? {}) as Record<string, number>;
  const compareCategoryScores = (compareSummary.categoryScores ?? {}) as Record<string, number>;

  return `
    <div class="executive-summary">
      <h2>📊 Comparison Summary</h2>

      <!-- Dual score display -->
      <div style="display: flex; justify-content: center; align-items: center; gap: 40px; margin: 20px 0; flex-wrap: wrap;">
        <div style="text-align: center;">
          <div class="score-circle" style="position: relative;">
            <div class="score-ring" style="--score: ${originScore}; --color: ${getScoreColor(originScore)};"></div>
            <div class="score-number ${originScore >= 80 ? 'good' : originScore >= 60 ? 'warning' : 'bad'}">${originScore}</div>
            <div class="score-label">${originLabel} (${getLetterGrade(originScore)})</div>
          </div>
        </div>

        <div style="text-align: center;">
          <div style="font-size: 14px; color: rgba(255,255,255,0.7); margin-bottom: 8px;">Delta</div>
          <div style="font-size: 32px; font-weight: 800; color: ${scoreDelta > 0 ? '#10b981' : scoreDelta < 0 ? '#ef4444' : 'rgba(255,255,255,0.5)'};">
            ${scoreDelta > 0 ? '+' : ''}${scoreDelta}
          </div>
          <div style="font-size: 12px; color: rgba(255,255,255,0.6);">${scoreDelta > 0 ? 'Compare is better' : scoreDelta < 0 ? 'Origin is better' : 'Equal'}</div>
        </div>

        <div style="text-align: center;">
          <div class="score-circle" style="position: relative;">
            <div class="score-ring" style="--score: ${compareScore}; --color: ${getScoreColor(compareScore)};"></div>
            <div class="score-number ${compareScore >= 80 ? 'good' : compareScore >= 60 ? 'warning' : 'bad'}">${compareScore}</div>
            <div class="score-label">${compareLabel} (${getLetterGrade(compareScore)})</div>
          </div>
        </div>
      </div>

      <!-- Dual issue counts -->
      <div class="summary-grid">
        ${getDualSummaryCard('Total Issues', (originSummary.totalIssues as number) ?? 0, (compareSummary.totalIssues as number) ?? 0, originLabel, compareLabel, '', true)}
        ${getDualSummaryCard('Critical', (originSummary.criticalCount as number) ?? 0, (compareSummary.criticalCount as number) ?? 0, originLabel, compareLabel, '#fca5a5', true)}
        ${getDualSummaryCard('High', (originSummary.highCount as number) ?? 0, (compareSummary.highCount as number) ?? 0, originLabel, compareLabel, '#fdba74', true)}
        ${getDualSummaryCard('Medium', (originSummary.mediumCount as number) ?? 0, (compareSummary.mediumCount as number) ?? 0, originLabel, compareLabel, '#fde047', true)}
        ${getDualSummaryCard('Low', (originSummary.lowCount as number) ?? 0, (compareSummary.lowCount as number) ?? 0, originLabel, compareLabel, '#a5f3fc', true)}
        ${getDualSummaryCard('Pass Rate', (originSummary.passRate as number) || 0, (compareSummary.passRate as number) || 0, originLabel, compareLabel, '', false, '%')}
      </div>

      <!-- Dual category health -->
      ${
        Object.keys(originCategoryScores).length > 0 || Object.keys(compareCategoryScores).length > 0
          ? `
      <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.2);">
        <div style="text-align: center; margin-bottom: 16px; font-size: 14px; opacity: 0.9;">Category Health</div>
        ${getDualCategoryBars(originCategoryScores, compareCategoryScores, originLabel, compareLabel)}
      </div>
      `
          : ''
      }

      ${getInsightHighlights(jsonData)}
    </div>
  `;
}

/** Render a summary card with two values and a delta */
function getDualSummaryCard(
  label: string,
  originVal: number,
  compareVal: number,
  originLabel: string,
  compareLabel: string,
  color: string,
  lowerIsBetter: boolean,
  unit = '',
): string {
  const delta = compareVal - originVal;
  const deltaBadge = formatDeltaBadge(delta, unit, lowerIsBetter);

  return `
    <div class="summary-card">
      <div style="display: flex; justify-content: center; gap: 16px; align-items: baseline;">
        <div style="text-align: center;">
          <div style="font-size: 10px; font-weight: 600; color: #93c5fd; text-transform: uppercase;">${originLabel}</div>
          <div class="summary-card-value" ${color ? `style="color: ${color};"` : ''}>${originVal}${unit}</div>
        </div>
        <div style="font-size: 11px; padding-top: 14px;">${deltaBadge}</div>
        <div style="text-align: center;">
          <div style="font-size: 10px; font-weight: 600; color: #c4b5fd; text-transform: uppercase;">${compareLabel}</div>
          <div class="summary-card-value" ${color ? `style="color: ${color};"` : ''}>${compareVal}${unit}</div>
        </div>
      </div>
      <div class="summary-card-label">${label}</div>
    </div>
  `;
}

/** Estimated score after fixes section */
function getEstimatedScoreAfterFixes(summary: Record<string, unknown>, overallScore: number): string {
  if (((summary.criticalCount as number) ?? 0) + ((summary.highCount as number) ?? 0) === 0) return '';

  const cats = (summary.categoryScores ?? {}) as Record<string, number>;
  const weights: Record<string, number> = {
    seo: 0.3,
    performance: 0.25,
    technical: 0.2,
    accessibility: 0.15,
    security: 0.1,
  };
  let potentialGain = 0;
  for (const [cat, w] of Object.entries(weights)) {
    const headroom = 100 - (cats[cat] || 100);
    potentialGain += headroom * 0.6 * w;
  }
  const predicted = Math.min(100, Math.round(overallScore + potentialGain));
  if (predicted <= overallScore) return '';

  return `
    <div style="margin-top: 20px; padding: 12px 16px; background: rgba(255,255,255,0.15); border-radius: 8px; font-size: 13px; text-align: center;">
      <strong>Estimated Score After Fixes:</strong>
      Fix all critical + high issues to potentially reach
      <strong style="color: #10b981;">~${predicted}/100</strong>
    </div>`;
}

/**
 * Generate insight highlight badges for executive summary
 */
function getInsightHighlights(jsonData: Record<string, unknown>) {
  const pageData = jsonData.pageData as Record<string, unknown> | undefined;
  const pages = Object.values((pageData?.pages as Record<string, PageInfo>) || {});
  if (pages.length === 0) return '';

  const badges: string[] = [];

  const langMismatches = pages.filter((p: PageInfo) => p.languageDetection?.match === false).length;
  if (langMismatches > 0) {
    badges.push(
      `<span class="insight-badge warn">🌐 ${langMismatches} language mismatch${langMismatches > 1 ? 'es' : ''}</span>`,
    );
  }

  const brokenOutbound = pages.reduce((s: number, p: PageInfo) => s + (p.outboundLinkHealth?.broken?.length ?? 0), 0);
  if (brokenOutbound > 0) {
    badges.push(
      `<span class="insight-badge warn">🔗 ${brokenOutbound} broken outbound link${brokenOutbound > 1 ? 's' : ''}</span>`,
    );
  }

  const similarPages = pages.filter(
    (p: PageInfo) => ((p.contentSimilarity?.similarPages as unknown[] | undefined)?.length ?? 0) > 0,
  ).length;
  if (similarPages > 0) {
    badges.push(
      `<span class="insight-badge info">📄 ${similarPages} near-duplicate page${similarPages > 1 ? 's' : ''}</span>`,
    );
  }

  const coveragePages = pages.filter((p: PageInfo) => p.codeCoverage?.js?.ratio != null);
  if (coveragePages.length > 0) {
    const avgUnused =
      coveragePages.reduce((s: number, p: PageInfo) => s + (p.codeCoverage?.js?.ratio ?? 0), 0) / coveragePages.length;
    if (avgUnused > 50) {
      badges.push(`<span class="insight-badge warn">📦 ${avgUnused.toFixed(0)}% avg unused JS</span>`);
    }
  }

  const noCta = pages.filter((p: PageInfo) => p.ctaData?.summary?.total === 0).length;
  if (noCta > pages.length * 0.3) {
    badges.push(`<span class="insight-badge info">🎯 ${noCta} page${noCta > 1 ? 's' : ''} without CTAs</span>`);
  }

  if (badges.length === 0) return '';

  return `
    <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.2);">
      <div style="text-align: center; margin-bottom: 10px; font-size: 13px; opacity: 0.8;">Key Insights</div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;">
        ${badges.join('')}
      </div>
    </div>
  `;
}

/**
 * Category descriptions for tooltips
 */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  seo: 'On-page SEO: titles, descriptions, headings, canonical URLs, structured data, and indexability.',
  performance: 'Core Web Vitals and page speed: TTFB, FCP, LCP, CLS, page size, and request count.',
  accessibility: 'WCAG compliance: ARIA labels, form labels, color contrast, keyboard navigation, and landmarks.',
  security: 'Security posture: HTTPS, security headers, CSP, cookie flags, and XSS prevention.',
  technical: 'Technical implementation: redirects, URL structure, caching, CDN, and Service Worker.',
};

/**
 * Generate single-origin category progress bars
 */
function getCategoryBars(categoryScores: Partial<CategoryScores>) {
  const categories = [
    { key: 'seo', name: 'SEO', score: categoryScores.seo ?? 0 },
    { key: 'performance', name: 'Performance', score: categoryScores.performance ?? 0 },
    { key: 'accessibility', name: 'Accessibility', score: categoryScores.accessibility ?? 0 },
    { key: 'security', name: 'Security', score: categoryScores.security ?? 0 },
    { key: 'technical', name: 'Technical', score: categoryScores.technical ?? 0 },
  ];

  return categories
    .map((cat) => {
      let progressClass = 'progress-bad';
      if (cat.score >= 80) progressClass = 'progress-good';
      else if (cat.score >= 60) progressClass = 'progress-warning';

      const config = (CATEGORY_CONFIG as Record<string, { name: string; icon: string; color: string }>)[cat.key] || {};
      const icon = config.icon || '';
      const description = CATEGORY_DESCRIPTIONS[cat.key] || '';

      return `
      <div style="margin: 12px 0;" title="${description}">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 13px;">
          <span>${icon} ${cat.name}</span>
          <span style="font-weight: 700;">${cat.score}/100</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar ${progressClass}" style="width: ${cat.score}%;"></div>
        </div>
      </div>
    `;
    })
    .join('');
}

/**
 * Generate dual-origin category bars (two bars per category with delta)
 */
function getDualCategoryBars(
  originScores: Record<string, number>,
  compareScores: Record<string, number>,
  _originLabel: string,
  _compareLabel: string,
) {
  const categories = [
    { key: 'seo', name: 'SEO' },
    { key: 'performance', name: 'Performance' },
    { key: 'accessibility', name: 'Accessibility' },
    { key: 'security', name: 'Security' },
    { key: 'technical', name: 'Technical' },
  ];

  return categories
    .map((cat) => {
      const originScore = originScores[cat.key] || 0;
      const compareScore = compareScores[cat.key] || 0;
      const delta = compareScore - originScore;
      const config = (CATEGORY_CONFIG as Record<string, { name: string; icon: string; color: string }>)[cat.key] || {};
      const icon = config.icon || '';
      const description = CATEGORY_DESCRIPTIONS[cat.key] || '';

      const getBarClass = (s: number) => (s >= 80 ? 'progress-good' : s >= 60 ? 'progress-warning' : 'progress-bad');
      const deltaColor = delta > 0 ? '#10b981' : delta < 0 ? '#ef4444' : '#6b7280';
      const deltaText = delta !== 0 ? `${delta > 0 ? '+' : ''}${delta}` : '—';

      return `
      <div style="margin: 14px 0;" title="${description}">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
          <span>${icon} ${cat.name}</span>
          <span>
            <span style="color: #93c5fd; font-weight: 600; font-size: 12px;">${originScore}</span>
            <span style="color: ${deltaColor}; font-weight: 700; font-size: 11px; margin: 0 6px;">${deltaText}</span>
            <span style="color: #c4b5fd; font-weight: 600; font-size: 12px;">${compareScore}</span>
          </span>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <span style="font-size: 9px; color: #93c5fd; min-width: 14px; text-align: center;">O</span>
          <div class="progress-bar-container" style="flex: 1;">
            <div class="progress-bar ${getBarClass(originScore)}" style="width: ${originScore}%;"></div>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center; margin-top: 2px;">
          <span style="font-size: 9px; color: #c4b5fd; min-width: 14px; text-align: center;">C</span>
          <div class="progress-bar-container" style="flex: 1;">
            <div class="progress-bar ${getBarClass(compareScore)}" style="width: ${compareScore}%;"></div>
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}

export { getExecutiveSummary };
