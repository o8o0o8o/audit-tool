/**
 * Report-layer consolidation of analyzer findings.
 *
 * Different analyzers sometimes report the same underlying problem under
 * different wordings (e.g. three separate "privacy policy link missing"
 * findings). `mergeNumericVariants` only merges messages differing by a
 * trailing number, so these survive as duplicates and inflate the report.
 *
 * This pass runs after `mergeNumericVariants` and before section bucketing:
 *   1. Drops low-value findings that are confirmed false-positive-prone.
 *   2. Folds semantically-equivalent findings into a single canonical entry.
 *
 * It is deliberately conservative — only the explicitly-listed groups are
 * touched; everything else passes through unchanged.
 */

import { normalizeMessageForLookup } from '../utils/finding-id';
import type { IssueDetail } from './types';

/** Severity rank for escalation (lower = more severe). */
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function moreSevere(a: string, b: string): string {
  return (SEV_RANK[a?.toLowerCase()] ?? 9) <= (SEV_RANK[b?.toLowerCase()] ?? 9) ? a : b;
}

/**
 * Findings dropped entirely. The bare Shadow DOM diagnostics fire on any page
 * with a single shadow root regardless of whether real content sits inside —
 * the content-bearing variants ("…content in Shadow DOM") are kept and carry
 * the genuine SEO signal.
 */
const SUPPRESS: RegExp[] = [/^no declarative shadow dom fallback/i, /^heavy shadow dom usage/i];

interface DedupGroup {
  /** The kept ("primary") finding — its message + examples win. */
  primary: RegExp;
  /** Equivalent findings folded into the primary and then removed. */
  members: RegExp[];
  /** When the members flag DISTINCT page sets (not just the same finding
   *  worded differently), union the example URLs and count the union instead of
   *  taking Math.max — otherwise the folded total is under-reported. */
  distinctSets?: boolean;
}

/**
 * Groups of equivalent findings. Within a group the primary's message and
 * per-page examples are kept; members only escalate severity / contribute
 * examples when the primary has none.
 */
const DEDUP_GROUPS: DedupGroup[] = [
  // Three analyzers all report "no visible privacy policy link".
  {
    primary: /^no privacy policy link found/i,
    members: [/privacy policy link missing on many pages/i, /many pages lack privacy policy link/i],
  },
  // "Inconsistent consent" with 0% coverage is the same as "tracking without
  // a consent banner" — keep the per-page finding, escalate severity. The
  // primary matches the analyzer's actual wording ("Multiple tracking cookies
  // set before consent"); the without-consent variant is a member so whichever
  // is present becomes the kept entry.
  {
    primary: /tracking cookies set before consent/i,
    members: [/inconsistent cookie consent implementation/i, /^tracking cookies without consent/i],
  },
  // Orphan pages (no inbound internal links) and pages unreachable from the
  // homepage via internal links are the same internal-linking discoverability
  // problem reported by one analyzer two ways. Keep the orphan finding (the
  // more specific signal); fold the unreachable one in.
  {
    primary: /orphan pages detected/i,
    members: [/pages are unreachable from homepage via internal links/i],
    distinctSets: true,
  },
  // Missing <main>: an AEO/semantic finding and an a11y-landmark finding.
  {
    primary: /^missing <main> element/i,
    members: [/many pages missing <main> landmark/i],
  },
  // Duplicate titles — several analyzers report exact-duplicate titles under
  // different wordings. Keep the clustered "Duplicate page titles found" (it
  // lists which pages share each title); fold the rest in. "Near-duplicate" is
  // intentionally NOT merged — similar-but-not-identical is a distinct finding.
  {
    primary: /^duplicate page titles found/i,
    members: [/^some pages have identical titles/i, /^duplicate titles detected/i],
  },
  // Duplicate meta descriptions — same story.
  {
    primary: /^duplicate meta descriptions found/i,
    members: [/^some pages have identical descriptions/i, /^duplicate descriptions detected/i],
  },
  // Infinite scroll — the per-page analyzer finding and the site-wide validator
  // restatement ("N pages use infinite scroll without pagination fallback") are
  // the same crawl-budget issue. Keep the per-page finding; fold the aggregate.
  {
    primary: /^infinite scroll without pagination fallback/i,
    members: [/pages use infinite scroll without pagination fallback/i],
  },
  // Missing form labels — per-page finding vs site-wide aggregate ("N form
  // inputs across site missing labels").
  {
    primary: /^form inputs missing labels/i,
    members: [/form inputs across site missing labels/i],
  },
  // Thin content — per-page finding vs site-wide aggregate ("N% of pages have
  // very thin content").
  {
    primary: /^page has very thin content/i,
    members: [/% of pages have very thin content/i],
  },
];

/**
 * Group-aware de-dup identity for a finding message.
 *
 * `consolidateFindings` only folds equivalents inside the `details` map. But
 * the scoring layer's `quickWins` list is built independently and may name the
 * same problem differently (e.g. a quick win "Some pages have identical titles"
 * vs the details entry "Duplicate page titles found"). When de-duplicating the
 * summary's Top Priority / Quick Wins / Long-term lists against each other we
 * need those two to share an identity — otherwise the same issue is highlighted
 * twice. This returns a stable group tag when the message matches a DEDUP_GROUP
 * (primary OR member), and the normalized-for-lookup form otherwise.
 */
export function findingGroupKey(message: string): string {
  for (let i = 0; i < DEDUP_GROUPS.length; i++) {
    const g = DEDUP_GROUPS[i];
    if (g.primary.test(message) || g.members.some((m) => m.test(message))) {
      return `group:${i}`;
    }
  }
  return normalizeMessageForLookup(message).toLowerCase();
}

/**
 * Consolidate a details map: drop suppressed findings and collapse equivalent
 * groups into one canonical entry each. Pure — returns a new object.
 */
export function consolidateFindings(details: Record<string, IssueDetail>): Record<string, IssueDetail> {
  // 1. Drop suppressed findings.
  const out: Record<string, IssueDetail> = {};
  for (const [message, detail] of Object.entries(details)) {
    if (SUPPRESS.some((rx) => rx.test(message))) continue;
    out[message] = { ...detail, examples: [...(detail.examples ?? [])] };
  }

  // 2. Fold dedup groups.
  for (const group of DEDUP_GROUPS) {
    const keys = Object.keys(out);
    const matches = (rx: RegExp) => keys.find((k) => rx.test(k));

    // The kept entry: the explicit primary if present, else promote the first
    // matching member so we never lose the finding entirely.
    let primaryKey = matches(group.primary);
    const memberKeys = group.members.map(matches).filter((k): k is string => !!k && k !== primaryKey);
    if (!primaryKey) {
      if (memberKeys.length === 0) continue; // nothing in this group present
      primaryKey = memberKeys.shift()!; // promote first member
    }
    if (memberKeys.length === 0) continue;

    const primary = out[primaryKey];
    for (const mk of memberKeys) {
      const m = out[mk];
      primary.severity = moreSevere(primary.severity, m.severity);
      if (group.distinctSets) {
        // Members flag DISTINCT page sets — union the example URLs (dedup) and
        // keep count at least the size of that union, so Math.max of one set's
        // size doesn't under-report the combined total.
        const have = new Set(primary.examples ?? []);
        const merged = [...(primary.examples ?? [])];
        for (const ex of m.examples ?? []) {
          if (!have.has(ex)) {
            have.add(ex);
            merged.push(ex);
          }
        }
        primary.examples = merged;
        primary.count = Math.max(primary.count ?? 0, m.count ?? 0, merged.length);
      } else {
        primary.count = Math.max(primary.count ?? 0, m.count ?? 0);
        // Only borrow examples when the primary has none of its own (keeps the
        // primary's per-page URLs rather than appending summary prose).
        if ((primary.examples?.length ?? 0) === 0 && (m.examples?.length ?? 0) > 0) {
          primary.examples = [...m.examples];
        }
      }
      delete out[mk];
    }
  }

  return out;
}
