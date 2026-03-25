/**
 * Quick Wins Section
 * Displays high-impact, low-effort fixes
 */

import { escapeHtml } from '../html-utils';
import type { ReportSectionData, QuickWinFull } from '../../types';

/**
 * Generate the quick wins section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the quick wins section
 */
function getQuickWins(data: ReportSectionData) {
  const { jsonData } = data;
  const analysisObj = (jsonData.analysis ?? {}) as Record<string, unknown>;
  const summaryObj = (analysisObj.summary ?? {}) as Record<string, unknown>;
  const quickWins = (summaryObj.quickWins ?? []) as QuickWinFull[];

  if (quickWins.length === 0) return '';

  return `
    <div class="quick-wins-section">
      <div class="wins-issues-title">
        <span>🎯</span>
        <span>Quick Wins</span>
        <span class="text-base opacity-90">(${quickWins.length} opportunities)</span>
      </div>

      <p class="text-center mb-7 text-base" style="opacity: 0.95;">
        High-impact fixes that take less than 30 minutes each
      </p>

      ${quickWins.map((win: QuickWinFull, index: number) => getQuickWinCard(win, index)).join('')}
    </div>
  `;
}

/**
 * Generate a single quick win card
 * @param {Object} win - Quick win data
 * @param {number} index - Card index
 * @returns {string} HTML string for the quick win card
 */
function getQuickWinCard(win: QuickWinFull, index: number) {
  const exampleHtml = win.example
    ? `
    <details class="code-example-wrapper">
      <summary class="cursor-pointer text-xs font-semibold mb-1" style="color: var(--color-info);">Show code example</summary>
      <div class="code-example">${escapeHtml(win.example)}</div>
    </details>
  `
    : '';

  const affectedPagesHtml =
    win.examples && win.examples.length > 0
      ? `
    <div class="affected-pages">
      <strong>Affected pages:</strong>
      <div class="mt-2">
        ${win.examples
          .slice(0, 3)
          .map((ex: string) => `<div class="opacity-85" style="margin: 2px 0;">${escapeHtml(ex)}</div>`)
          .join('')}
        ${win.affectedPages > 3 ? `<div class="opacity-70">... and ${win.affectedPages - 3} more</div>` : ''}
      </div>
    </div>
  `
      : '';

  const resourcesHtml =
    win.resources && win.resources.length > 0
      ? `
    <div class="resource-links">
      ${win.resources
        .map(
          (res: { text: string; url: string }) =>
            `<a href="${res.url}" target="_blank" rel="noopener noreferrer" class="resource-link">${escapeHtml(res.text)}</a>`,
        )
        .join('')}
    </div>
  `
      : '';

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
        <strong class="block mb-3">✅ How to Fix:</strong>
        ${escapeHtml(win.fix)}
      </div>

      ${exampleHtml}
      ${affectedPagesHtml}
      ${resourcesHtml}
    </div>
  `;
}

export { getQuickWins };
