/**
 * Agentic Browsing section: findings from the agentic check family (accessible
 * names, unlabeled click targets, form labels, hover-only content, llms.txt),
 * or a clean-state note, plus the page-coverage notes. Shared by the HTML
 * report and the Phase 2 markdown report.
 */

import { isAgenticFinding } from '../../analyzers/agentic/agentic-checks';
import { agenticCoverage } from '../../scoring/score-calculator';
import { escapeHtml } from '../html-utils';
import type { AgenticCoverage, PageInfo } from '../../types';

export const AGENTIC_SECTION_TITLE = 'Agentic Browsing';
export const NO_AGENTIC_ISSUES_TEXT = 'No agentic browsing issues found';

/** Whether the agentic checks ran, and on how many pages. Persisted in `phase2-state.json`. */
export interface AgenticReportState {
  enabled: boolean;
  coverage: AgenticCoverage;
}

/**
 * Resolve the section state from the run's `agentic` metadata flag and its pages.
 * `false` ⇒ disabled (null). Absent flag ⇒ enabled only if some page carries agentic data.
 */
export function resolveAgenticState(
  metadataFlag: unknown,
  pages: Record<string, PageInfo> | undefined,
): AgenticReportState | null {
  if (metadataFlag === false) return null;
  const coverage = agenticCoverage(pages);
  if (coverage) return { enabled: true, coverage };
  if (metadataFlag !== true) return null;
  return { enabled: true, coverage: { covered: 0, total: Object.keys(pages ?? {}).length, hintsLimited: 0 } };
}

/** Same as {@link resolveAgenticState} but from a saved summary's coverage (Phase 2 has no page data). */
export function agenticStateFromSummary(
  metadataFlag: unknown,
  coverage: AgenticCoverage | undefined,
  totalPages: number,
): AgenticReportState | null {
  if (metadataFlag === false) return null;
  if (coverage) return { enabled: true, coverage };
  if (metadataFlag !== true) return null;
  return { enabled: true, coverage: { covered: 0, total: totalPages, hintsLimited: 0 } };
}

/** Plain-text notes: partial coverage and inline-styles-only hover checks. */
export function agenticCoverageNotes(state: AgenticReportState): string[] {
  const { covered, total, hintsLimited } = state.coverage;
  const notes: string[] = [];
  if (covered < total) notes.push(`Agentic checks ran on ${covered} of ${total} pages.`);
  if (hintsLimited > 0)
    notes.push(`Hover-only check limited to inline styles on ${hintsLimited} page${hintsLimited === 1 ? '' : 's'}.`);
  return notes;
}

function isClean(state: AgenticReportState, findingCount: number): boolean {
  return findingCount === 0 && state.coverage.covered > 0 && state.coverage.covered >= state.coverage.total;
}

const CLEAN_DETAIL =
  'Every interactive element has an accessible name, form inputs have labels, there are no unlabeled click targets or hover-only content, and llms.txt is valid.';

/** Markdown clean-state / coverage lines for the Phase 2 section. `rendered` ⇒ the section heading is already out. */
export function agenticMarkdownNote(state: AgenticReportState | null, findingCount: number, rendered: boolean): string {
  if (!state?.enabled) return '';
  const lines = agenticCoverageNotes(state).map((n) => `*${n}*`);
  if (isClean(state, findingCount)) lines.unshift(`**${NO_AGENTIC_ISSUES_TEXT}.** ${CLEAN_DETAIL}`);
  if (lines.length === 0) return '';
  const body = lines.join('\n\n') + '\n';
  return rendered ? body : `## ${AGENTIC_SECTION_TITLE}\n\n${body}`;
}

/** HTML block for the report's Issues tab. Empty when the checks did not run. */
export function getAgenticBrowsingSection(
  state: AgenticReportState | null,
  details: Record<string, { severity?: string; count?: number }>,
  score?: number,
): string {
  if (!state?.enabled) return '';
  const findings = Object.entries(details).filter(([m]) => isAgenticFinding(m.replace(/<[^>]*>/g, '')));
  const notes = agenticCoverageNotes(state)
    .map((n) => `<p class="agentic-note" style="font-size:var(--font-size-sm);color:var(--gray-600);">${escapeHtml(n)}</p>`)
    .join('');
  const scoreHtml =
    score === undefined ? '' : ` <span class="agentic-score" style="font-weight:600;">${score}/100</span>`;
  const body = isClean(state, findings.length)
    ? `<div class="agentic-clean" style="border:1px solid var(--color-success);border-radius:var(--radius-lg);padding:10px 14px;margin-bottom:16px;font-size:var(--font-size-sm);"><strong>${NO_AGENTIC_ISSUES_TEXT}.</strong> ${escapeHtml(CLEAN_DETAIL)}</div>`
    : findings.length > 0
      ? `<ul class="agentic-findings">${findings
          .map(
            ([m, d]) =>
              `<li><strong>${escapeHtml(String(d.severity ?? '').toUpperCase())}</strong> ${escapeHtml(m.replace(/<[^>]*>/g, ''))}${d.count ? ` <span>(${d.count})</span>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  return `<div class="agentic-browsing-section" id="agentic-browsing" style="margin-top:24px;">
      <h2 style="margin:0 0 12px;font-size:var(--font-size-lg);color:var(--gray-800);">${AGENTIC_SECTION_TITLE}${scoreHtml}</h2>
      ${body}${notes}
    </div>`;
}
