/**
 * Top Issues Section
 * Displays top issues prioritized by severity
 */

const { escapeHtml } = require('../html-utils');

// Patterns that indicate crawler/infrastructure errors, not website issues
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

/**
 * Check if an issue is a crawler error (not a website issue)
 * @param {string} issue - Issue text
 * @returns {boolean}
 */
function isCrawlerError(issue) {
  return CRAWLER_ERROR_PATTERNS.some(pattern => issue.includes(pattern));
}

/**
 * Generate the top issues section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the top issues section
 */
function getTopIssues(data) {
  const { jsonData } = data;
  const bySeverity = jsonData.analysis?.bySeverity || {};

  const allIssues = [
    ...(bySeverity.critical || []).map(issue => ({ issue, severity: 'critical', severityLabel: 'Critical' })),
    ...(bySeverity.high || []).map(issue => ({ issue, severity: 'high', severityLabel: 'High' })),
    ...(bySeverity.medium || []).map(issue => ({ issue, severity: 'medium', severityLabel: 'Medium' })),
    ...(bySeverity.low || []).map(issue => ({ issue, severity: 'low', severityLabel: 'Low' }))
  ].filter(item => !isCrawlerError(item.issue)); // Filter out crawler errors

  const topIssues = allIssues.slice(0, 10);

  if (topIssues.length === 0) return '';

  return `
    <div class="top-issues-section">
      <div class="wins-issues-title">
        <span>⚠️</span>
        <span>Top ${topIssues.length} Issues to Address</span>
      </div>

      <p style="text-align: center; margin-bottom: 25px; font-size: 14px; opacity: 0.95;">
        Prioritized by severity - fix these first
      </p>

      ${topIssues.map((item, index) => getIssueCard(item, index, jsonData)).join('')}
    </div>
  `;
}

/**
 * Generate a single issue card
 * @param {Object} item - Issue item
 * @param {number} index - Card index
 * @param {Object} jsonData - Full JSON data for accessing details
 * @returns {string} HTML string for the issue card
 */
function getIssueCard(item, index, jsonData) {
  // Strip severity suffix from issue key (format: "Error message [severity]")
  const issueKey = item.issue.replace(/ \[(critical|high|medium|low)\]$/i, '');
  const details = jsonData.analysis?.details?.[issueKey] || {};
  const affectedCount = details.examples?.length || 0;

  const examplesHtml = details.examples && details.examples.length > 0 ? `
    <div class="affected-pages">
      <strong>Examples:</strong>
      <div style="margin-top: 5px;">
        ${details.examples.slice(0, 2).map(ex => `<div style="margin: 2px 0; opacity: 0.85;">${ex}</div>`).join('')}
        ${affectedCount > 2 ? `<div style="opacity: 0.7;">... and ${affectedCount - 2} more</div>` : ''}
      </div>
    </div>
  ` : '';

  return `
    <div class="issue-card">
      <div class="issue-header">
        <div class="issue-title">${index + 1}. ${escapeHtml(issueKey)}</div>
        <div class="issue-badges">
          <span class="issue-badge-item">${item.severityLabel}</span>
          ${affectedCount > 0 ? `<span class="issue-badge-item">${affectedCount} affected</span>` : ''}
        </div>
      </div>

      ${examplesHtml}
    </div>
  `;
}

module.exports = { getTopIssues };
