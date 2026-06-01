/**
 * Scoring methodologies.
 *
 * Each function maps measurements/issues to a 0-100 score using a documented
 * industry-standard approach. Centralised here so the score-calculator stays a
 * thin orchestrator.
 *
 * Sources:
 * - Lighthouse log-normal: https://github.com/GoogleChrome/lighthouse/blob/main/docs/scoring.md
 * - Cypress weighted ratio: https://docs.cypress.io/accessibility/core-concepts/accessibility-score
 * - Ahrefs URL-pass: https://help.ahrefs.com/en/articles/1424673
 * - Mozilla HTTP Observatory: https://github.com/mozilla/http-observatory/blob/main/httpobs/docs/scoring.md
 */

/**
 * Lighthouse-style log-normal CDF score.
 * `p10` is the value top-decile sites achieve (→ score 90); `median` is the
 * HTTPArchive median (→ score 50). Lower-is-better metrics only (latency,
 * shift, etc.).
 */
export function logNormalScore(value: number, p10: number, median: number): number {
  if (!Number.isFinite(value) || value <= 0) return 100;
  if (p10 <= 0 || median <= 0 || p10 >= median) return 50;

  // Both Math.log(p10/median) and erfcInv(1.8) are negative for lower-is-better
  // metrics; their signs cancel to give a positive shape. Don't wrap in abs() —
  // doing so breaks the cancellation and produces inverted scores.
  const shape = Math.log(p10 / median) / Math.SQRT2 / erfcInv(2 * 0.9);
  const location = Math.log(median);
  const cdf = 0.5 * erfc((Math.log(value) - location) / (shape * Math.SQRT2));
  return clamp01(cdf) * 100;
}

/**
 * Cypress-style weighted ratio. Used for accessibility per axe-core impact.
 * `passedWeight + failedWeight === 0` means "no applicable checks" → 100.
 */
export function weightedRatio(passedWeight: number, failedWeight: number): number {
  const total = passedWeight + failedWeight;
  if (total <= 0) return 100;
  return (passedWeight / total) * 100;
}

/**
 * Ahrefs-style URL-pass score.
 * `score = (URLs without any Error-tier issue ÷ total URLs) × 100`.
 * Only Error-tier counts; Warnings/Notices are reported separately.
 */
export function urlPassScore(urlsWithErrors: number, totalUrls: number): number {
  if (totalUrls <= 0) return 100;
  const clean = Math.max(0, totalUrls - Math.min(urlsWithErrors, totalUrls));
  return (clean / totalUrls) * 100;
}

/**
 * Mozilla Observatory-style deduction score.
 * Start at `baseline`, subtract `deductions`, add `bonuses`. Clamp to [0, 100].
 */
export function deductionScore(deductions: number, bonuses = 0, baseline = 100): number {
  return Math.max(0, Math.min(100, baseline - deductions + bonuses));
}

/** Mean of a numeric array. Returns null when empty. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Abramowitz & Stegun 7.1.26 — max error ~1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function erfc(x: number): number {
  return 1 - erf(x);
}

/** Inverse complementary error function via rational approximation. */
function erfcInv(x: number): number {
  if (x >= 2) return -Infinity;
  if (x <= 0) return Infinity;
  const v = 1 - x;
  const w = -Math.log((1 - v) * (1 + v));
  let p: number;
  if (w < 5) {
    const wm = w - 2.5;
    p = 2.81022636e-8;
    p = 3.43273939e-7 + p * wm;
    p = -3.5233877e-6 + p * wm;
    p = -4.39150654e-6 + p * wm;
    p = 0.00021858087 + p * wm;
    p = -0.00125372503 + p * wm;
    p = -0.00417768164 + p * wm;
    p = 0.246640727 + p * wm;
    p = 1.50140941 + p * wm;
  } else {
    const wm = Math.sqrt(w) - 3;
    p = -0.000200214257;
    p = 0.000100950558 + p * wm;
    p = 0.00134934322 + p * wm;
    p = -0.00367342844 + p * wm;
    p = 0.00573950773 + p * wm;
    p = -0.0076224613 + p * wm;
    p = 0.00943887047 + p * wm;
    p = 1.00167406 + p * wm;
    p = 2.83297682 + p * wm;
  }
  return p * v;
}
