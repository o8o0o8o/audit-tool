/**
 * Version of the scoring rules, stored with every history snapshot. Scores from two different
 * versions are not comparable: a change between them may come from the rules, not from the site.
 * Raise it with every change that can move a score for an unchanged site (weights, reach, curves,
 * which findings count). A snapshot saved before this field existed counts as version 1.
 *
 * 2: graduated SEO/technical scores; no performance score without a measurement; a finding with a
 *    count is never site-wide.
 */
export const SCORING_VERSION = 2;

/** Version of a stored snapshot; snapshots without the field were scored by the first rules. */
export function scoringVersionOf(snapshot: object | null | undefined): number {
  const v = (snapshot as { scoringVersion?: unknown } | null | undefined)?.scoringVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

/** True when both snapshots were scored by the same rules, so their scores can be subtracted. */
export function scoresComparable(a: object | null | undefined, b: object | null | undefined): boolean {
  return scoringVersionOf(a) === scoringVersionOf(b);
}

export const SCORES_NOT_COMPARABLE_NOTE =
  'Scores are not comparable: the scoring rules changed between these two audits, so a difference in score does not show a change on the site.';
