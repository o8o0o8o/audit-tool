/**
 * Human-readable description of how the audit scores are computed, built from
 * the same constants score-calculator.ts uses so the text can't drift.
 */

import { SCORING } from '../constants';
import { GRADE_BANDS, FIX_RECOVERY_RATIO, escapeHtml } from '../utils';

const CATEGORY_LABELS: Record<string, string> = {
  seo: 'SEO',
  performance: 'Performance',
  technical: 'Technical',
  accessibility: 'Accessibility',
  security: 'Security',
};

const CATEGORY_METHODS: Record<string, string> = {
  seo: 'Share of crawled pages with no Error-tier SEO issue (URL-pass): (pages without errors ÷ pages crawled) × 100. Warnings and notices are reported but not scored.',
  technical:
    'Share of crawled pages with no Error-tier technical issue (URL-pass): (pages without errors ÷ pages crawled) × 100.',
  performance: '', // filled from PERFORMANCE_METRIC_WEIGHTS below
  accessibility:
    'Mean of the per-page accessibility scores (axe-style deductions per violation; 100 − 10 per violation when only a count is known).',
  security:
    'Mean of the per-page security scores (Mozilla Observatory-style deductions for missing headers, HTTPS, cookie flags).',
};

export interface ScoringRules {
  categories: Array<{ key: string; label: string; weightPct: number; method: string }>;
  meanWeightPct: number;
  worstWeightPct: number;
  overall: string;
  grades: Array<{ grade: string; range: string }>;
  passRate: string;
  estimate: string;
  perPageNote: string;
}

const pct = (n: number): number => Math.round(n * 100);

export function getScoringRules(): ScoringRules {
  const metricWeights = Object.entries(SCORING.PERFORMANCE_METRIC_WEIGHTS)
    .map(([m, w]) => `${m} ${w}%`)
    .join(', ');
  const perfMethod = `Per page, each Core Web Vital is scored 0–100 on a Lighthouse log-normal curve (top-decile value → 90, median → 50) and the metrics are blended by weight: ${metricWeights}. The category is the mean across pages; without performance metrics it falls back to URL-pass on performance issues.`;

  const categories = Object.entries(SCORING.CATEGORY_WEIGHTS).map(([key, w]) => ({
    key,
    label: CATEGORY_LABELS[key] ?? key,
    weightPct: pct(w),
    method: key === 'performance' ? perfMethod : (CATEGORY_METHODS[key] ?? ''),
  }));
  const meanWeightPct = pct(SCORING.OVERALL_MEAN_WEIGHT);
  const worstWeightPct = 100 - meanWeightPct;

  const grades = GRADE_BANDS.map((b, i) => ({
    grade: b.grade,
    range: i === 0 ? `${b.min}–100` : `${b.min}–${GRADE_BANDS[i - 1].min - 1}`,
  }));
  grades.push({ grade: 'F', range: `0–${GRADE_BANDS[GRADE_BANDS.length - 1].min - 1}` });

  return {
    categories,
    meanWeightPct,
    worstWeightPct,
    overall: `Overall = ${meanWeightPct}% × weighted category mean + ${worstWeightPct}% × worst category score, so one failing category can't be averaged away.`,
    grades,
    passRate: 'Pass rate = pages loaded without an error ÷ pages crawled.',
    estimate: `Estimated score after fixes = overall + Σ (category weight × ${pct(FIX_RECOVERY_RATIO)}% of that category's headroom to 100).`,
    perPageNote:
      "Per-page Security, Cache, A11y and Content columns are each analyzer's own 0–100 check score for that page; they are shown for diagnosis and are separate from the weighted category blend.",
  };
}

export function scoringRulesHtml(): string {
  const r = getScoringRules();
  const rows = r.categories
    .map(
      (c) =>
        `<tr><td><strong>${escapeHtml(c.label)}</strong></td><td>${c.weightPct}%</td><td>${escapeHtml(c.method)}</td></tr>`,
    )
    .join('');
  const grades = r.grades.map((g) => `${g.grade} ${g.range}`).join(' · ');
  return `
    <details class="score-rules" id="score-rules">
      <summary>How is this score calculated?</summary>
      <div class="score-rules-body">
        <p>${escapeHtml(r.overall)}</p>
        <table class="score-rules-table">
          <thead><tr><th>Category</th><th>Weight</th><th>How it is scored</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><strong>Grades:</strong> ${escapeHtml(grades)}</p>
        <p>${escapeHtml(r.passRate)}</p>
        <p>${escapeHtml(r.estimate)}</p>
        <p>${escapeHtml(r.perPageNote)}</p>
      </div>
    </details>`;
}

export function scoringRulesMarkdown(): string {
  const r = getScoringRules();
  const rows = r.categories.map((c) => `| ${c.label} | ${c.weightPct}% | ${c.method} |`).join('\n');
  return [
    '**How the scores are calculated.** ' + r.overall,
    '',
    '| Category | Weight | How it is scored |',
    '|---|---|---|',
    rows,
    '',
    `Grades: ${r.grades.map((g) => `${g.grade} ${g.range}`).join(' · ')}.`,
  ].join('\n');
}
