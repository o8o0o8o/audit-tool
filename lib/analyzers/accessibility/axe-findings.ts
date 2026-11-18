/**
 * axe-core rule violations as audit findings. The crawl already runs axe on every evidence-sampled
 * page; this turns each violated rule into a finding that names the WCAG success criterion, the
 * number of elements and one of them. Colour contrast is left to the audit's own contrast finding,
 * which reports the same elements with their ratios.
 */

import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';

export interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  /** WCAG success criteria, e.g. `4.1.2`, read from the rule's tags. */
  wcag: string[];
  nodes: number;
  /** Markup of the first failing element, shortened. */
  sample: string;
}

interface RawViolation {
  id: string;
  impact?: string | null;
  help: string;
  tags?: string[];
  nodes: Array<{ html?: string }>;
}

/** `wcag412` → `4.1.2`; level and version tags (`wcag2a`, `wcag21aa`) are not criteria. */
export function wcagCriteria(tags: string[] = []): string[] {
  return tags
    .map((t) => /^wcag(\d)(\d)(\d{1,2})$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`);
}

export function summariseAxeViolations(violations: RawViolation[]): AxeViolationSummary[] {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    // Rule titles name elements as `<html>`; the angle brackets would be read as markup in a report.
    help: v.help.replace(/[<>]/g, ''),
    wcag: wcagCriteria(v.tags),
    nodes: v.nodes.length,
    sample: (v.nodes[0]?.html ?? '').replace(/\s+/g, ' ').slice(0, 160),
  }));
}

const SKIPPED = new Set(['color-contrast', 'color-contrast-enhanced']);
const IMPACT: Record<string, SeverityLevel | undefined> = {
  critical: SEVERITY.HIGH,
  serious: SEVERITY.MEDIUM,
  moderate: SEVERITY.LOW,
};

/** The finding message for a rule: stable per rule, so pages aggregate under it. */
export const axeMessage = (help: string) => `Accessibility (axe): ${help}`;

export const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One finding per violated rule of critical, serious or moderate impact. */
export function axeIssues(violations: AxeViolationSummary[], url: string): Issue[] {
  const out: Issue[] = [];
  for (const v of violations) {
    const severity = IMPACT[v.impact ?? ''];
    if (!severity || SKIPPED.has(v.id) || v.nodes === 0) continue;
    const criteria = v.wcag.length ? `WCAG ${v.wcag.join(', ')}` : 'an axe best-practice rule';
    out.push({
      severity,
      message: axeMessage(v.help),
      detail: `<a href="${url}">${url}</a>: ${v.nodes} element(s) fail axe rule <code>${v.id}</code> (${criteria}, impact ${v.impact}). For example: <code>${escapeText(v.sample)}</code>`,
    });
  }
  return out;
}
