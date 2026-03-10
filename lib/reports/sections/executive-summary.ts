/**
 * Executive Summary Section
 * Displays overall score, issue counts, and category health
 */

import { CATEGORY_CONFIG } from '../metrics-metadata';

/**
 * Generate the executive summary section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the executive summary section
 */
function getExecutiveSummary(data: any) {
  const { jsonData } = data;
  const summary = jsonData.analysis?.summary || {};
  const overallScore = summary.overallScore || 0;
  const categoryScores = summary.categoryScores || {};

  // Determine score color and letter grade
  let scoreClass = 'bad';
  if (overallScore >= 80) scoreClass = 'good';
  else if (overallScore >= 60) scoreClass = 'warning';

  const letterGrade = overallScore >= 95 ? 'A+' : overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' : overallScore >= 60 ? 'D' : 'F';

  const categoryHealthHtml = Object.keys(categoryScores).length > 0 ? `
    <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.2);">
      <div style="text-align: center; margin-bottom: 16px; font-size: 14px; opacity: 0.9;">Category Health</div>
      ${getCategoryBars(categoryScores)}
    </div>
  ` : '';

  return `
    <div class="executive-summary">
      <h2>📊 Executive Summary</h2>

      <div class="summary-score">
        <div class="score-circle" style="position: relative;">
          <div class="score-ring" style="--score: ${overallScore}; --color: ${overallScore >= 80 ? '#10b981' : overallScore >= 60 ? '#f59e0b' : '#ef4444'};"></div>
          <div class="score-number ${scoreClass}">${overallScore}</div>
          <div class="score-label">Site Health (${letterGrade})</div>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-card-value">${summary.totalIssues || 0}</div>
          <div class="summary-card-label">Total Issues</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fca5a5;">${summary.criticalCount || 0}</div>
          <div class="summary-card-label">Critical</div>
          ${(summary.criticalCount || 0) > 0 ? '<div class="summary-card-hint">Fix immediately</div>' : ''}
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fdba74;">${summary.highCount || 0}</div>
          <div class="summary-card-label">High</div>
          ${(summary.highCount || 0) > 0 ? '<div class="summary-card-hint">Fix this week</div>' : ''}
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fde047;">${summary.mediumCount || 0}</div>
          <div class="summary-card-label">Medium</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #a5f3fc;">${summary.lowCount || 0}</div>
          <div class="summary-card-label">Low</div>
        </div>
        <div class="summary-card">
          <div class="summary-card-value">${summary.passRate || 0}%</div>
          <div class="summary-card-label">Pass Rate</div>
        </div>
      </div>

      ${(summary.criticalCount || 0) + (summary.highCount || 0) > 0 ? (() => {
        // Estimate score gain based on category headroom (categories farthest from 100 gain most)
        const cats = summary.categoryScores || {};
        const weights = { seo: 0.30, performance: 0.25, technical: 0.20, accessibility: 0.15, security: 0.10 };
        let potentialGain = 0;
        for (const [cat, w] of Object.entries(weights)) {
          const headroom = 100 - (cats[cat] || 100);
          // Assume fixing critical+high recovers 50-70% of headroom
          potentialGain += headroom * 0.6 * w;
        }
        const predicted = Math.min(100, Math.round(overallScore + potentialGain));
        return predicted > overallScore ? `
      <div style="margin-top: 20px; padding: 12px 16px; background: rgba(255,255,255,0.15); border-radius: 8px; font-size: 13px; text-align: center;">
        <strong>Estimated Score After Fixes:</strong>
        Fix all critical + high issues to potentially reach
        <strong style="color: #10b981;">~${predicted}/100</strong>
      </div>` : '';
      })() : ''}

      ${categoryHealthHtml}

      ${getInsightHighlights(jsonData)}
    </div>
  `;
}

/**
 * Generate insight highlight badges for executive summary
 */
function getInsightHighlights(jsonData: any) {
  const pages = Object.values(jsonData.pageData?.pages || {}) as any[];
  if (pages.length === 0) return '';

  const badges: string[] = [];

  const langMismatches = pages.filter((p: any) => p.languageDetection?.match === false).length;
  if (langMismatches > 0) {
    badges.push(`<span class="insight-badge warn">🌐 ${langMismatches} language mismatch${langMismatches > 1 ? 'es' : ''}</span>`);
  }

  const brokenOutbound = pages.reduce((s: number, p: any) => s + (p.outboundLinkHealth?.broken?.length || 0), 0);
  if (brokenOutbound > 0) {
    badges.push(`<span class="insight-badge warn">🔗 ${brokenOutbound} broken outbound link${brokenOutbound > 1 ? 's' : ''}</span>`);
  }

  const similarPages = pages.filter((p: any) => p.contentSimilarity?.similarPages?.length > 0).length;
  if (similarPages > 0) {
    badges.push(`<span class="insight-badge info">📄 ${similarPages} near-duplicate page${similarPages > 1 ? 's' : ''}</span>`);
  }

  const coveragePages = pages.filter((p: any) => p.codeCoverage?.js?.ratio != null);
  if (coveragePages.length > 0) {
    const avgUnused = coveragePages.reduce((s: number, p: any) => s + p.codeCoverage.js.ratio, 0) / coveragePages.length;
    if (avgUnused > 50) {
      badges.push(`<span class="insight-badge warn">📦 ${avgUnused.toFixed(0)}% avg unused JS</span>`);
    }
  }

  const noCta = pages.filter((p: any) => p.ctaData?.summary?.total === 0).length;
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
const CATEGORY_DESCRIPTIONS = {
  seo: 'On-page SEO: titles, descriptions, headings, canonical URLs, structured data, and indexability.',
  performance: 'Core Web Vitals and page speed: TTFB, FCP, LCP, CLS, page size, and request count.',
  accessibility: 'WCAG compliance: ARIA labels, form labels, color contrast, keyboard navigation, and landmarks.',
  security: 'Security posture: HTTPS, security headers, CSP, cookie flags, and XSS prevention.',
  technical: 'Technical implementation: redirects, URL structure, caching, CDN, and Service Worker.'
};

/**
 * Generate category progress bars
 * @param {Object} categoryScores - Category scores object
 * @returns {string} HTML string for category bars
 */
function getCategoryBars(categoryScores: any) {
  const categories = [
    { key: 'seo', name: 'SEO', score: categoryScores.seo || 0 },
    { key: 'performance', name: 'Performance', score: categoryScores.performance || 0 },
    { key: 'accessibility', name: 'Accessibility', score: categoryScores.accessibility || 0 },
    { key: 'security', name: 'Security', score: categoryScores.security || 0 },
    { key: 'technical', name: 'Technical', score: categoryScores.technical || 0 }
  ];

  return categories.map((cat: any) => {
    let progressClass = 'progress-bad';
    if (cat.score >= 80) progressClass = 'progress-good';
    else if (cat.score >= 60) progressClass = 'progress-warning';

    const config = (CATEGORY_CONFIG as Record<string, any>)[cat.key] || {};
    const icon = config.icon || '';
    const description = (CATEGORY_DESCRIPTIONS as Record<string, string>)[cat.key] || '';

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
  }).join('');
}

export { getExecutiveSummary };