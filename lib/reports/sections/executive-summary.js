/**
 * Executive Summary Section
 * Displays overall score, issue counts, and category health
 */

const { CATEGORY_CONFIG } = require('../metrics-metadata');

/**
 * Generate the executive summary section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the executive summary section
 */
function getExecutiveSummary(data) {
  const { jsonData } = data;
  const summary = jsonData.analysis?.summary || {};
  const overallScore = summary.overallScore || 0;
  const categoryScores = summary.categoryScores || {};

  // Determine score color
  let scoreClass = 'bad';
  if (overallScore >= 80) scoreClass = 'good';
  else if (overallScore >= 60) scoreClass = 'warning';

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
        <div class="score-circle">
          <div class="score-number ${scoreClass}">${overallScore}</div>
          <div class="score-label">Site Health</div>
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
        </div>
        <div class="summary-card">
          <div class="summary-card-value" style="color: #fdba74;">${summary.highCount || 0}</div>
          <div class="summary-card-label">High</div>
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

      ${categoryHealthHtml}
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
function getCategoryBars(categoryScores) {
  const categories = [
    { key: 'seo', name: 'SEO', score: categoryScores.seo || 0 },
    { key: 'performance', name: 'Performance', score: categoryScores.performance || 0 },
    { key: 'accessibility', name: 'Accessibility', score: categoryScores.accessibility || 0 },
    { key: 'security', name: 'Security', score: categoryScores.security || 0 },
    { key: 'technical', name: 'Technical', score: categoryScores.technical || 0 }
  ];

  return categories.map(cat => {
    let progressClass = 'progress-bad';
    if (cat.score >= 80) progressClass = 'progress-good';
    else if (cat.score >= 60) progressClass = 'progress-warning';

    const config = CATEGORY_CONFIG[cat.key] || {};
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
  }).join('');
}

module.exports = { getExecutiveSummary };
