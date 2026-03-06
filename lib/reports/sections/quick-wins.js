/**
 * Quick Wins Section
 * Displays high-impact, low-effort fixes
 */

const { escapeHtml } = require('../html-utils');

/**
 * Generate the quick wins section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the quick wins section
 */
function getQuickWins(data) {
  const { jsonData } = data;
  const quickWins = jsonData.analysis?.summary?.quickWins || [];

  if (quickWins.length === 0) return '';

  return `
    <div class="quick-wins-section">
      <div class="wins-issues-title">
        <span>🎯</span>
        <span>Quick Wins</span>
        <span style="font-size: 14px; opacity: 0.9;">(${quickWins.length} opportunities)</span>
      </div>

      <p style="text-align: center; margin-bottom: 25px; font-size: 14px; opacity: 0.95;">
        High-impact fixes that take less than 30 minutes each
      </p>

      ${quickWins.map((win, index) => getQuickWinCard(win, index)).join('')}
    </div>
  `;
}

/**
 * Generate a single quick win card
 * @param {Object} win - Quick win data
 * @param {number} index - Card index
 * @returns {string} HTML string for the quick win card
 */
function getQuickWinCard(win, index) {
  const exampleHtml = win.example ? `
    <details class="code-example-wrapper">
      <summary style="cursor: pointer; font-size: 12px; color: #3b82f6; font-weight: 600; margin-bottom: 4px;">Show code example</summary>
      <div class="code-example">${escapeHtml(win.example)}</div>
    </details>
  ` : '';

  const affectedPagesHtml = win.examples && win.examples.length > 0 ? `
    <div class="affected-pages">
      <strong>Affected pages:</strong>
      <div style="margin-top: 5px;">
        ${win.examples.slice(0, 3).map(ex => `<div style="margin: 2px 0; opacity: 0.85;">${ex}</div>`).join('')}
        ${win.affectedPages > 3 ? `<div style="opacity: 0.7;">... and ${win.affectedPages - 3} more</div>` : ''}
      </div>
    </div>
  ` : '';

  const resourcesHtml = win.resources && win.resources.length > 0 ? `
    <div class="resource-links">
      ${win.resources.map(res =>
        `<a href="${res.url}" target="_blank" rel="noopener noreferrer" class="resource-link">${escapeHtml(res.text)}</a>`
      ).join('')}
    </div>
  ` : '';

  return `
    <div class="win-card">
      <div class="win-header">
        <div class="win-title">${index + 1}. ${escapeHtml(win.issue)}</div>
        <div class="win-badges">
          <span class="win-badge">${win.impact} Impact</span>
          <span class="win-badge">⏱️ ${win.effort}</span>
          <span class="win-badge">${win.affectedPages} page${win.affectedPages > 1 ? 's' : ''}</span>
        </div>
      </div>

      <div class="fix-content">
        <strong style="display: block; margin-bottom: 8px;">✅ How to Fix:</strong>
        ${escapeHtml(win.fix)}
      </div>

      ${exampleHtml}
      ${affectedPagesHtml}
      ${resourcesHtml}
    </div>
  `;
}

module.exports = { getQuickWins };
