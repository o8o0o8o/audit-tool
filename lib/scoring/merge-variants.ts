/**
 * Merge analyzer findings whose messages differ only by an embedded numeric
 * value (e.g. "Element with too many children (87)" vs "(65)", or
 * "Color contrast fails WCAG AA (3 elements)"). Many analyzers bake a per-page
 * count into the message, which fragments one logical finding into dozens of
 * rows. Grouping here sums the counts, unions the examples, keeps the highest
 * severity, and re-keys by a clean human-readable display message.
 *
 * Standalone (no PDF/Playwright deps) so both the Phase 2 PDF runner and the
 * interactive HTML report can share one implementation.
 */

import { normalizeMessage } from '../utils/finding-id';

/** Minimal shape the merge needs; extra fields are preserved via spread. */
export interface VariantDetail {
  severity: string;
  count?: number;
  examples?: string[];
  truncated?: boolean;
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function maxSeverity(a: string, b: string): string {
  const ar = SEV_RANK[a?.toLowerCase()] ?? 9;
  const br = SEV_RANK[b?.toLowerCase()] ?? 9;
  return ar <= br ? a : b;
}

/** Strip HTML tags so example URLs dedupe on visible text, not markup. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trailing "(N units)" token — stripped from the display message only. */
const TRAILING_COUNT = /\s*\(\s*\d+(?:\s+[a-z][a-z-]{0,15})?\s*\)\s*$/i;

export function mergeNumericVariants<T extends VariantDetail>(details: Record<string, T>): Record<string, T> {
  // Group by the normalized form (HTML-stripped, trailing "(N units)" removed)
  // but keep a real, human-readable original message as the display key —
  // normalizeMessage destroys literal element mentions like `<main>`, which
  // would otherwise render as the useless "Missing  element".
  const merged: Record<string, { detail: T; display: string }> = {};
  for (const [message, detail] of Object.entries(details)) {
    const key = normalizeMessage(message);
    if (!merged[key]) {
      merged[key] = {
        detail: { ...detail, examples: [...(detail.examples ?? [])] },
        display: message,
      };
    } else {
      const m = merged[key].detail;
      m.severity = maxSeverity(m.severity, detail.severity);
      m.count = (m.count ?? 0) + (detail.count ?? 0);
      // Dedup examples by stripped text so we don't show the same URL twice.
      const seen = new Set((m.examples ?? []).map(stripHtml));
      for (const ex of detail.examples ?? []) {
        const norm = stripHtml(ex);
        if (!seen.has(norm)) {
          (m.examples ??= []).push(ex);
          seen.add(norm);
        }
      }
      m.truncated = m.truncated || detail.truncated;
      // Prefer the shortest original as the display message — typically the
      // cleanest variant without an embedded count.
      if (message.length < merged[key].display.length) merged[key].display = message;
    }
  }
  const out: Record<string, T> = {};
  for (const { detail, display } of Object.values(merged)) {
    out[display.replace(TRAILING_COUNT, '').trim()] = detail;
  }
  return out;
}
