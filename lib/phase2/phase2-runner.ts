/**
 * Phase 2 runner — turns a Phase 1 artifact directory into a curated
 * markdown report and a final PDF.
 *
 * No LLM. The synthesis is template-driven, anchored in the data the Phase 1
 * crawl already collected (analysis.json.gz, manifest.json.gz, metadata).
 * The report structure mirrors the human-PDF examples (Purpose / Summary /
 * Performance / SEO / Privacy / Accessibility / UX / Technical).
 *
 * An optional LLM-narrative pass is a follow-up; the templated output is
 * intentionally honest and brief rather than chatty.
 */

import { scoringRulesMarkdown } from '../scoring/scoring-rules';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SCORING, THRESHOLDS } from '../constants';
import type { VisualOverlays, OverlayItem, OverlayRect } from '../crawler/visual-overlay-collector';
import { compareExamplesWorstFirst, formatBytes } from '../utils';
import { renderMarkdownToPdf } from '../reports/pdf-renderer';
import { ScoreCalculator } from '../scoring/score-calculator';
import { classifyIssue, isCataloguedErrorTier } from '../scoring/seo-catalog';
import { nextjsOverrideFor, isNextjsAudit } from '../scoring/nextjs-recommendations';
import type { FixRecommendation } from '../types';
import { normalizeMessage as _normalizeMessage, normalizeMessageForLookup } from '../utils/finding-id';
import { categorize, type Section } from './categorize';
import { auditTypeLabel, matchesChecks, type CheckName } from '../presets';
import { benchmarkFor } from './benchmarks';
import { mergeNumericVariants } from '../scoring/merge-variants';
import { consolidateFindings, findingGroupKey } from './consolidate';
import {
  buildScoreImpact,
  sectionScoreSuffix,
  findingLiftChip,
  type ScoreImpact,
  type ScoredCategory,
} from './score-impact';
import { detectAnomalies, type Anomaly } from './llm-anomaly';
import { generateSectionAnalysis } from './llm-narrative';
import { verifyFindings } from './llm-verify';
import { isClaudeCliAvailable } from './claude-cli';
import { PhaseProgress, timedStep } from '../utils/phase-progress';
import { computePageCounts, type PageCounts } from '../utils/page-counts';
import { loadAllPages } from '../phase3/finding-verifier';
import type {
  AnalysisData,
  AuditArtifacts,
  IssueDetail,
  ManifestData,
  MetadataData,
  QuickWin,
  RepoAnalysisData,
  SourceLocation,
} from './types';

export interface Phase2Options {
  /** When true, ask Claude to rewrite each section's Analysis paragraph. */
  llmNarrative?: boolean;
  /** When true, run the LLM anomaly pass (vision + signals) over the
   *  representative-page sample and merge findings into the report. */
  llmFindings?: boolean;
  /** When true, run the LLM verification pass — revalidate findings and drop
   *  confirmed duplicates / false positives before the final report. */
  llmVerify?: boolean;
  /** When true, strip every score from the report — the per-category header
   *  projections (`current → ~projected`), the per-finding point chips
   *  (`+~N pts`), and the methodology paragraph that explains them. Findings,
   *  severities, counts and fixes are all unaffected. */
  noScore?: boolean;
  /** Report sections to render, in this order; `undefined` ⇒ every section in default order. */
  sections?: Section[];
  /** Check groups whose findings are kept; `undefined` ⇒ no finding filter. */
  checks?: CheckName[];
  /** Preset the audit ran with; shown as the audit type. */
  preset?: string;
  /** Surface API/cache errors. */
  verbose?: boolean;
}

const SECTION_TITLES: Record<Section, string> = {
  performance: 'Performance Audit',
  seo: 'SEO Audit',
  privacy: 'GDPR & Privacy Audit',
  accessibility: 'Accessibility Audit',
  ux: 'UX / UI Audit',
  technical: 'Common Problems',
};

// Section order reflects the audit's stated priorities: SEO, Performance and
// UX first, then the supporting categories.
const SECTION_ORDER: Section[] = ['seo', 'performance', 'ux', 'privacy', 'accessibility', 'technical'];

// The scored category each report section represents, for the header
// `current → projected` annotation. `privacy` maps to Security (GDPR/cookie
// gaps are what the Observatory-style security score penalises). `ux` and
// `technical` are catch-alls with no single owning score — their findings get
// per-item score chips instead, so the header carries no projection.
const SECTION_HOME_CATEGORY: Partial<Record<Section, ScoredCategory>> = {
  seo: 'seo',
  performance: 'performance',
  accessibility: 'accessibility',
  privacy: 'security',
};

/**
 * Category priority rank, derived from `SECTION_ORDER` (0 = highest). This is
 * the PRIMARY ranking key everywhere findings are ordered: a category that
 * matters more for this audit (SEO > Performance > UX > Privacy > Accessibility
 * > Technical) always sorts ahead of a lower one, and severity decides the
 * order *within* a category. So the headline lists read the same way the
 * document does — all SEO first, then Performance, and so on — rather than
 * interleaving categories by raw severity. Within a single section every
 * finding shares the same rank, so it leaves intra-section ordering untouched.
 */
const SECTION_RANK: Record<Section, number> = SECTION_ORDER.reduce(
  (acc, sec, i) => {
    acc[sec] = i;
    return acc;
  },
  {} as Record<Section, number>,
);

/** Per-section cap so a noisy analyzer doesn't produce a 30-page section. */
const SECTION_FINDING_LIMIT = 12;

/** Number of example URLs shown per finding in the report body. */
const EXAMPLES_PER_FINDING = 10;

/**
 * Two indexes of FIX_RECOMMENDATIONS, built once. The lookup tries them in
 * order so we tolerate analyzer wording differences:
 *
 *   1. `normalizeMessage`           — strips trailing `(N units)` only.
 *   2. `normalizeMessageForLookup`  — also strips leading `<count> ` and
 *                                     `<pct>% of ` prefixes that analyzer
 *                                     template strings inject.
 *
 * The aggressive lookup form is reserved for FIX_RECOMMENDATIONS matching so
 * it doesn't change finding identity used elsewhere (diff, merging).
 */
function buildIndex<T>(src: Record<string, T>, normalize: (s: string) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(src)) {
    out[normalize(k)] = v;
  }
  return out;
}
const FIX_BY_NORMAL = buildIndex(ScoreCalculator.getFixRecommendations(), _normalizeMessage);
const FIX_BY_LOOKUP = buildIndex(ScoreCalculator.getFixRecommendations(), normalizeMessageForLookup);
// Keys sorted longest-first; used by the prefix-fallback so the most
// specific entry wins (`"Active mixed content across site"` matches before
// the more general `"Active mixed content"`).
const FIX_LOOKUP_KEYS_BY_LENGTH = Object.keys(FIX_BY_LOOKUP).sort((a, b) => b.length - a.length);

/** Generic exact→normalized→longest-prefix matcher shared by both catalogs. */
function matchByMessage<T>(
  message: string,
  byNormal: Record<string, T>,
  byLookup: Record<string, T>,
  keysByLength: string[],
): T | undefined {
  const exact = byNormal[_normalizeMessage(message)] ?? byLookup[normalizeMessageForLookup(message)];
  if (exact) return exact;
  const lookupForm = normalizeMessageForLookup(message);
  for (const key of keysByLength) {
    if (key.length < 15) break;
    if (lookupForm === key || lookupForm.startsWith(key + ' ') || lookupForm.startsWith(key + ':')) {
      return byLookup[key];
    }
  }
  return undefined;
}

/**
 * Source-file locations the `--repo` pass mapped to a finding (matched exactly
 * or after trailing-count normalization). Empty when no repo mapping exists.
 */
function sourceLocationsFor(
  message: string,
  sourceMapping: Record<string, SourceLocation[]> | null | undefined,
): SourceLocation[] {
  if (!sourceMapping) return [];
  if (sourceMapping[message]) return sourceMapping[message];
  const norm = _normalizeMessage(message);
  for (const [key, locs] of Object.entries(sourceMapping)) {
    if (_normalizeMessage(key) === norm) return locs ?? [];
  }
  return [];
}

/**
 * Resolve the recommendation for a finding. When `isNextjs` is set and a
 * Next.js override exists, its fields (fix/example/resources) win over the
 * generic catalogue entry; everything else falls back to the generic entry.
 */
function lookupRecommendation(message: string, isNextjs = false): FixRecommendation | undefined {
  const base = matchByMessage(message, FIX_BY_NORMAL, FIX_BY_LOOKUP, FIX_LOOKUP_KEYS_BY_LENGTH);
  if (!isNextjs) return base;
  const override = nextjsOverrideFor(message);
  if (!override) return base;
  return { ...(base ?? {}), ...override } as FixRecommendation;
}

/**
 * Category-level default fix, used only when no catalogued recommendation owns
 * the finding. Replaces the old one-size-fits-all "apply the standard best
 * practice" sentence: every category resolves to actionable guidance, and on a
 * Next.js audit that guidance names the idiomatic Next.js mechanism (Metadata
 * API, next/image, next/dynamic, next/script, …) so fixes read framework-aware
 * even for kinds that lack a per-message override. This is the floor — explicit
 * catalog + Next.js overrides still take precedence in `resolveFix`.
 */
const DEFAULT_FIX_GENERIC: Record<string, string> = {
  seo: "Review the affected pages and set the relevant on-page SEO element (title, description, canonical, heading, or structured data) correctly and uniquely per page. Prioritise the highest-traffic or highest-value pages first.",
  performance: 'Audit the affected pages and trim the offending resources: defer or remove non-critical scripts, optimise and correctly size images, and eliminate render-blocking assets. Prioritise the highest-traffic pages.',
  accessibility: 'Fix the flagged elements to meet WCAG — add the missing label, alt text, accessible name, or sufficient colour contrast so assistive technology can interpret them.',
  security: 'Set the missing security header or transport setting at the server / edge so every response is covered, then re-test.',
  technical: 'Resolve the flagged technical issue (redirects, markup, or build configuration) at its source so the fix applies across the whole site.',
};

const DEFAULT_FIX_NEXTJS: Record<string, string> = {
  seo: 'Set this per route with the Next.js Metadata API (`export const metadata` or `generateMetadata` for dynamic routes) so each page declares a unique, correct value; configure `metadataBase` once in the root layout.',
  performance: 'Address this in the App Router: keep non-interactive UI as Server Components, lazy-load heavy client components with next/dynamic, serve images via next/image, and load third-party tags through next/script with strategy="lazyOnload".',
  accessibility: 'Fix the flagged elements in their React component so the change applies everywhere the component renders (add the label / alt / aria attribute, or correct the contrast token).',
  security: 'Set the missing header in next.config.js `headers()` (or middleware) so every route is covered, then re-test.',
  technical: "Resolve this in the Next.js config or route source (redirects(), route-segment config, or the component) so the fix applies across the build.",
};

function defaultFix(message: string, isNextjs: boolean): string {
  const { category } = classifyIssue(stripHtml(message));
  const table = isNextjs ? DEFAULT_FIX_NEXTJS : DEFAULT_FIX_GENERIC;
  return table[category] ?? DEFAULT_FIX_GENERIC.seo;
}

/**
 * Resolve the Fix text + example for a finding. Returns the catalogued
 * recommendation when one matches (with Next.js overrides merged in), otherwise
 * a category-level default — never an empty or one-size-fits-all string.
 * `fromCatalog` is false when the default kicked in, so callers (and tests) can
 * tell the difference. Does NOT cover AI-discovered findings, which carry their
 * own remediation in `detail.recommendation`.
 */
export function resolveFix(
  message: string,
  isNextjs = false,
): { fix: string; example?: string; fromCatalog: boolean } {
  const rec = lookupRecommendation(message, isNextjs);
  if (rec?.fix) return { fix: rec.fix, example: rec.example, fromCatalog: true };
  return { fix: defaultFix(message, isNextjs), example: rec?.example, fromCatalog: false };
}

/** Severity → base impact weight. */
const SEV_WEIGHT: Record<string, number> = { critical: 100, high: 70, medium: 35, low: 12 };
/** Catalog tier → multiplier. Notice-tier diagnostics are demoted so a
 *  low-value "best practice" check can't outrank a real warning. */
const TIER_MULT: Record<string, number> = { error: 1, warning: 0.85, notice: 0.4 };

/**
 * Rank a finding by real-world impact: severity × catalog-tier × category
 * value × breadth (how many pages it affects, with diminishing returns).
 * HIGHER = more important. Used only as the final tie-breaker once category
 * rank and severity band are equal — so a systemic finding outranks a contained
 * one of the same severity, and notice-tier boilerplate sinks below genuine
 * warnings. Cross-category priority is handled by `SECTION_RANK` in
 * `byImportance`, not here.
 */
function impactScore(message: string, detail: IssueDetail): number {
  const { tier, category } = classifyIssue(message, detail.severity);
  const sev = SEV_WEIGHT[(detail.severity ?? 'medium').toLowerCase()] ?? 25;
  const catValue = SCORING.CATEGORY_WEIGHTS[category] ?? 0.15; // 0.10–0.30
  // 1 page → ~1.3, 12 → ~2.1, 120 → ~3.1. Breadth matters but saturates.
  const breadth = 1 + Math.log10(1 + (detail.count ?? 1));
  return sev * (TIER_MULT[tier] ?? 0.6) * (0.7 + catValue) * breadth;
}

/** Severity band for ordering (lower = more important). */
const SEV_BAND: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Compare helper: most important first. Ordering keys, in order:
 *   1. Category priority (`SECTION_RANK`) — SEO > Performance > UX > Privacy >
 *      Accessibility > Technical. This leads so the headline lists group by
 *      category exactly like the document does, instead of interleaving
 *      categories by raw severity.
 *   2. Severity band — within a category, every critical/high precedes any
 *      medium/low.
 *   3. Real-world impact (breadth × tier × category value) breaks remaining ties.
 *
 * Within a single section the category key is constant, so intra-section
 * ordering is still severity-then-impact — unchanged. The category key only
 * reshapes the cross-section lists (Top Priority Issues, fallbacks).
 */
function byImportance(a: [string, IssueDetail], b: [string, IssueDetail]): number {
  const ca = SECTION_RANK[categorize(a[0])] ?? 99;
  const cb = SECTION_RANK[categorize(b[0])] ?? 99;
  if (ca !== cb) return ca - cb;
  const sa = SEV_BAND[(a[1].severity ?? 'medium').toLowerCase()] ?? 2;
  const sb = SEV_BAND[(b[1].severity ?? 'medium').toLowerCase()] ?? 2;
  if (sa !== sb) return sa - sb;
  const ia = impactScore(a[0], a[1]);
  const ib = impactScore(b[0], b[1]);
  if (ia !== ib) return ib - ia;
  // Final tiebreaker: the message key is unique and stable, so tied findings
  // order identically across runs regardless of concurrent crawl-completion
  // order (the order `analysis.details` keys were inserted). Without it, JS's
  // stable sort would leak that non-deterministic insertion order into the
  // report — different machines/runs could rank tied findings differently.
  return a[0].localeCompare(b[0]);
}

/**
 * `byImportance` for the scoring layer's `QuickWin` items, which carry their own
 * `impactScore` rather than an `IssueDetail`. Same intent: category priority
 * (`SECTION_RANK`: SEO > Performance > UX > Privacy/Security > Accessibility >
 * Technical) leads, then the precomputed impact score breaks ties. Keeps the
 * Long-term list grouped by category like the rest of the report instead of
 * letting a high-count accessibility item outrank an SEO/performance one.
 */
function byQuickWinImportance(a: QuickWin, b: QuickWin): number {
  const ca = SECTION_RANK[categorize(a.issue)] ?? 99;
  const cb = SECTION_RANK[categorize(b.issue)] ?? 99;
  if (ca !== cb) return ca - cb;
  const ia = a.impactScore ?? 0;
  const ib = b.impactScore ?? 0;
  if (ia !== ib) return ib - ia;
  // Deterministic final tiebreaker (see byImportance) — order by the stable
  // issue text so tied quick wins never depend on crawl-completion order.
  return a.issue.localeCompare(b.issue);
}

/** Severity ordering, weakest → strongest, for capping. */
const SEV_ASC = ['low', 'medium', 'high', 'critical'];
function capSeverity(sev: string, target: 'medium' | 'high'): string {
  const i = SEV_ASC.indexOf((sev ?? '').toLowerCase());
  const ti = SEV_ASC.indexOf(target);
  return i > ti ? target : sev;
}

/**
 * Temper heuristic severity with the *measured* category outcome.
 *
 * A single analyzer signal shouldn't read as high/critical when its category
 * objectively scores well — e.g. "too many render-blocking resources" tagged
 * HIGH on a site whose Performance score is 99. We cap (never raise):
 *
 *   category score ≥ 90 → at most MEDIUM
 *   category score ≥ 75 → at most HIGH (no critical)
 *
 * Findings the catalog vets as error-tier (mixed content, noindex-in-sitemap,
 * …) are exempt — those are known-serious regardless of the category average.
 * LLM-discovered anomalies keep their own severity (handled separately).
 */
function moderateSeverities(
  details: Record<string, IssueDetail>,
  categoryScores: Record<string, number> | undefined,
): Record<string, IssueDetail> {
  if (!categoryScores) return details;
  const out: Record<string, IssueDetail> = {};
  for (const [message, detail] of Object.entries(details)) {
    const { category } = classifyIssue(message, detail.severity);
    const score = categoryScores[category];
    let sev = detail.severity;
    if (typeof score === 'number' && !isCataloguedErrorTier(message)) {
      if (score >= 90) sev = capSeverity(sev, 'medium');
      else if (score >= 75) sev = capSeverity(sev, 'high');
    }
    out[message] = sev === detail.severity ? detail : { ...detail, severity: sev };
  }
  return out;
}

/**
 * Single pipeline for turning raw analyzer details into the report's working
 * set: merge numeric variants → consolidate equivalents/suppress noise →
 * moderate severity against measured category scores. Used everywhere details
 * are consumed so ranking stays consistent across sections and the summary.
 */
function prepareDetails(artifacts: AuditArtifacts): Record<string, IssueDetail> {
  return moderateSeverities(
    consolidateFindings(mergeNumericVariants(artifacts.analysis.details)),
    artifacts.analysis.summary?.categoryScores,
  );
}

/**
 * Remove findings the LLM verification pass flagged as duplicates / false
 * positives. `suppressed` holds the original message keys. Pure — returns a new
 * object; a no-op (and the same reference) when nothing is suppressed.
 */
function applySuppression(
  details: Record<string, IssueDetail>,
  suppressed: ReadonlySet<string>,
): Record<string, IssueDetail> {
  if (suppressed.size === 0) return details;
  const out: Record<string, IssueDetail> = {};
  for (const [message, detail] of Object.entries(details)) {
    if (!suppressed.has(message)) out[message] = detail;
  }
  return out;
}

/** Prepared details with verification suppression already applied. Exported
 *  for the Phase 3 verify runner, which must verify and re-render over exactly
 *  the set the main report rendered. */
export function preparedDetails(
  artifacts: AuditArtifacts,
  suppressed: ReadonlySet<string>,
  checks?: readonly CheckName[],
): Record<string, IssueDetail> {
  const details = applySuppression(prepareDetails(artifacts), suppressed);
  if (!checks) return details;
  return Object.fromEntries(
    Object.entries(details).filter(([message]) => matchesChecks(message, categorize(message), checks)),
  );
}

/** Sections and finding groups a report renders; empty ⇒ the full report. */
export interface ReportSelection {
  sections?: Section[];
  checks?: CheckName[];
  /** Preset the audit ran with; `undefined` ⇒ "Full audit". */
  preset?: string;
}

/** Drop HTML tags from analyzer details so the markdown stays clean. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize reader-facing prose for markdown output.
 *
 * Analyzer detail strings and fix recommendations mix two kinds of angle-bracket
 * content: real markup the analyzer emitted (e.g. `<a href="url">url</a>`) and
 * literal element mentions that are *content* (e.g. "use `<main>`, `<article>`").
 * Feeding either straight into `marked` is wrong — anchors render as live links
 * and bare element mentions get swallowed as empty HTML elements (so
 * "Use semantic elements (<main>, <article>)" rendered as "(, )"). Here we
 * unwrap anchors to their visible text and wrap any surviving tag mention in
 * backticks so it renders as literal inline code.
 */
export function sanitizeProse(s: string): string {
  return (
    s
      // Unwrap anchors to their inner text (usually the URL itself).
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
      // Surviving tag-like mentions are content, not markup — render literally.
      .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, (m) => `\`${m}\``)
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// Re-export the shared utility so existing imports keep working.
export const normalizeMessage = _normalizeMessage;

// Re-exported so existing imports (and tests) that pull mergeNumericVariants
// from this module keep working. The implementation lives in the shared
// scoring module and is used by both the PDF runner and the HTML report.
export { mergeNumericVariants };

/** Read and gunzip a JSON file. */
function readJsonGz<T>(file: string): T {
  const raw = fs.readFileSync(file);
  const text = zlib.gunzipSync(raw).toString('utf8');
  return JSON.parse(text) as T;
}

/** Load all artifacts the runner needs. Throws if the run directory is incomplete. */
export function loadArtifacts(runDir: string): AuditArtifacts {
  const manifest = readJsonGz<ManifestData>(path.join(runDir, 'manifest.json.gz'));
  const analysis = readJsonGz<AnalysisData>(path.join(runDir, 'analysis.json.gz'));
  const metadata = readJsonGz<MetadataData>(path.join(runDir, 'metadata.json.gz'));

  // Repo analysis is optional — present only when --repo was passed.
  let repoAnalysis: RepoAnalysisData | null = null;
  const repoPath = path.join(runDir, 'repo-analysis.json.gz');
  if (fs.existsSync(repoPath)) {
    try {
      repoAnalysis = readJsonGz<RepoAnalysisData>(repoPath);
    } catch {
      repoAnalysis = null;
    }
  }

  return { runDir, manifest, analysis, metadata, repoAnalysis };
}

/**
 * Detect whether the audited site is Next.js so the report can use Next.js-
 * specific recommendations. Prefers the repo-analysis framework (when `--repo`
 * was used); otherwise falls back to the `/_next/` build-output fingerprint
 * that appears in analyzer example URLs (script paths, etc.).
 */
function detectNextjs(artifacts: AuditArtifacts): boolean {
  const examples = Object.values(artifacts.analysis.details ?? {}).flatMap((d) => d.examples ?? []);
  return isNextjsAudit(artifacts.repoAnalysis?.framework, examples);
}

/** Render a severity as an inline span the PDF renderer can colour. */
function sevSpan(sev: string): string {
  const s = sev.toLowerCase();
  if (s === 'critical' || s === 'high') return `<span class="sev-high">${s.toUpperCase()}</span>`;
  if (s === 'medium') return `<span class="sev-medium">MEDIUM</span>`;
  if (s === 'low') return `<span class="sev-low">LOW</span>`;
  return s;
}

/** Group analyzer details into sections via the keyword categorizer. */
function bucketDetails(details: Record<string, IssueDetail>): Record<Section, Array<[string, IssueDetail]>> {
  const out: Record<Section, Array<[string, IssueDetail]>> = {
    performance: [],
    seo: [],
    privacy: [],
    accessibility: [],
    ux: [],
    technical: [],
  };
  for (const [message, detail] of Object.entries(details)) {
    out[categorize(message)].push([message, detail]);
  }
  // Sort each bucket by real-world impact (severity × tier × category × breadth).
  for (const sec of Object.keys(out) as Section[]) {
    out[sec].sort(byImportance);
  }
  return out;
}

/**
 * Consolidate per-page LLM anomalies into one finding per defect CLASS.
 *
 * The anomaly pass runs once per representative page, so a template-level bug
 * (e.g. a Clutch badge 403, a GET contact form) surfaces as N near-identical
 * anomalies — one per page, each "affects 1 occurrence". This collapses them
 * into a single anomaly carrying every page as an `occurrences[]` entry, so the
 * report shows one finding with N occurrences instead of N near-duplicates.
 *
 * Grouping key:
 *   - the model-supplied stable `kind` slug when present — grouped ACROSS
 *     sections, since the same defect is sometimes filed under `ux` on one page
 *     and `technical` on another (which previously split it into two findings
 *     with different severities); else
 *   - the normalized title, kept section-scoped (conservative — generic prose
 *     can mean different things in different sections) for older caches that
 *     predate the `kind` field.
 * Within one run every anomaly shares the same prompt, so `kind` is present for
 * all or none — the two strategies never mix mid-run.
 *
 * The representative keeps the worst severity in the group and the first item's
 * title/recommendation; the group lands in its dominant (most-frequent) section;
 * occurrences are de-duplicated by URL. Order is stable (first-seen) so the same
 * crawl yields the same report.
 */
export function consolidateAnomalies(anomalies: Anomaly[]): Anomaly[] {
  const SEV_RANK: Record<Anomaly['severity'], number> = { critical: 3, high: 2, medium: 1, low: 0 };
  // Union-find over multiple label kinds: a defect merges when ANY label
  // matches another's. A single key (kind XOR title) missed two real splits:
  //   • the LLM gives the SAME defect different `kind` slugs across pages
  //     ("contact-form-get-action" vs "contact-form-empty-action") — identical
  //     titles then split into separate findings with different severities;
  //   • the LLM keeps one `kind` but varies the wording slightly.
  // So when `kind` is present we add BOTH a kind label and a section-agnostic
  // title label (the same defect is sometimes filed under `ux` here, `technical`
  // there). When `kind` is absent (caches predating the field) we keep the
  // conservative section-scoped title key only — no cross-section merging.
  const parent = anomalies.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    // Keep the lower (first-seen) index as the root so group order is stable.
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const labelToFirst = new Map<string, number>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  anomalies.forEach((a, i) => {
    const labels: string[] = [];
    if (a.kind) {
      labels.push(`kind:${slug(a.kind)}`);
      labels.push(`title:${_normalizeMessage(a.title).toLowerCase()}`);
    } else {
      labels.push(`${a.section}::title:${_normalizeMessage(a.title).toLowerCase()}`);
    }
    for (const label of labels) {
      const first = labelToFirst.get(label);
      if (first === undefined) labelToFirst.set(label, i);
      else union(first, i);
    }
  });
  // Fuzzy bridge over `kind` slugs: the LLM sometimes emits DIFFERENT slugs for
  // ONE defect across pages ("form-empty-action", "form-empty-action-get",
  // "contact-form-get-action" — all the same empty-action GET form). Exact-label
  // union-find above leaves these as separate findings. Union any two
  // kind-bearing anomalies whose kind-token sets overlap strongly (Jaccard ≥
  // 0.6) so the variants collapse. 0.6 catches those genuine variants while
  // staying ABOVE the ~0.5 overlap of distinct-but-related classes (e.g.
  // "link-broken-outbound" vs "link-broken-internal"), so it never over-merges.
  const kindTokens = anomalies.map((a) =>
    a.kind ? new Set(slug(a.kind).split('-').filter(Boolean)) : null,
  );
  for (let i = 0; i < anomalies.length; i++) {
    const ti = kindTokens[i];
    if (!ti || ti.size === 0) continue;
    for (let j = i + 1; j < anomalies.length; j++) {
      const tj = kindTokens[j];
      if (!tj || tj.size === 0) continue;
      let inter = 0;
      for (const t of ti) if (tj.has(t)) inter++;
      const union2 = ti.size + tj.size - inter;
      if (union2 > 0 && inter / union2 >= 0.6) union(i, j);
    }
  }
  const groups = new Map<number, Anomaly[]>();
  const order: number[] = [];
  anomalies.forEach((a, i) => {
    const root = find(i);
    let grp = groups.get(root);
    if (!grp) {
      grp = [];
      groups.set(root, grp);
      order.push(root);
    }
    grp.push(a);
  });
  const out: Anomaly[] = [];
  for (const root of order) {
    const grp = groups.get(root)!;
    // Representative: worst severity, ties broken by first-seen order.
    let rep = grp[0];
    for (const a of grp) if (SEV_RANK[a.severity] > SEV_RANK[rep.severity]) rep = a;
    // Dominant section: most occurrences, ties broken by first-seen.
    const sectionCounts = new Map<Section, number>();
    for (const a of grp) sectionCounts.set(a.section, (sectionCounts.get(a.section) ?? 0) + 1);
    let section = rep.section;
    let bestCount = -1;
    for (const a of grp) {
      const n = sectionCounts.get(a.section)!;
      if (n > bestCount) {
        bestCount = n;
        section = a.section;
      }
    }
    const seen = new Set<string>();
    const occurrences: Array<{ url: string; evidence: string }> = [];
    for (const a of grp) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      occurrences.push({ url: a.url, evidence: a.evidence });
    }
    out.push({ ...rep, section, occurrences });
  }
  return out;
}

/**
 * Fold LLM-discovered anomalies into the section buckets as synthetic
 * findings, tagged `aiDiscovered` so the report can label them and so they're
 * never confused with deterministic results. Re-sorts the touched sections by
 * impact. No-op when `anomalies` is empty. Expects the consolidated list
 * (see `consolidateAnomalies`): one anomaly per defect, carrying `occurrences`.
 */
function mergeAnomalies(buckets: Record<Section, Array<[string, IssueDetail]>>, anomalies: Anomaly[]): void {
  const touched = new Set<Section>();
  for (const a of anomalies) {
    // Self-describing examples: each cited page's evidence + the page it saw.
    // Falls back to the single url/evidence for an un-consolidated anomaly.
    const occ = a.occurrences && a.occurrences.length > 0 ? a.occurrences : [{ url: a.url, evidence: a.evidence }];
    const detail: IssueDetail = {
      severity: a.severity,
      count: occ.length,
      examples: occ.map((o) => `${o.evidence} — ${o.url}`),
      aiDiscovered: true,
      recommendation: a.recommendation,
    };
    buckets[a.section].push([a.title, detail]);
    touched.add(a.section);
  }
  for (const sec of touched) buckets[sec].sort(byImportance);
}

// ─── Section builders ───────────────────────────────────────────────────────

const pageCountsCache = new WeakMap<AuditArtifacts, PageCounts>();

/**
 * Page counts from the stored page records. Fixtures/runs with no `pages/`
 * on disk fall back to the manifest counters.
 */
function crawlCounts(artifacts: AuditArtifacts): PageCounts {
  const cached = pageCountsCache.get(artifacts);
  if (cached) return cached;
  const progress = artifacts.manifest.progress;
  const index = loadAllPages(artifacts.runDir);
  const pages = Object.fromEntries(index.all().map((p, i) => [p.url ?? `#${i}`, p]));
  let counts = computePageCounts(pages, progress.byError ?? {});
  if (index.size === 0) {
    const ok = progress.totalWithoutError ?? 0;
    const err = progress.totalWithError ?? 0;
    counts = { crawled: ok + err, successful: ok, withErrors: err, failedToLoad: 0 };
  }
  pageCountsCache.set(artifacts, counts);
  return counts;
}

function buildCover(artifacts: AuditArtifacts, preset?: string): string {
  const { manifest, metadata } = artifacts;
  const date = new Date(manifest.created).toISOString().slice(0, 10);
  const sitemapCount = metadata.sitemaps?.total;
  const counts = crawlCounts(artifacts);
  const lines: string[] = [];
  lines.push(`# Website Technical Audit`);
  lines.push('');
  lines.push(`**Audit type:** ${auditTypeLabel(preset)}`);
  lines.push('');
  lines.push(`## ${manifest.domain}`);
  lines.push('');
  lines.push(`**Generated:** ${date}  `);
  // Avoid the confusing "354 of 314" framing — crawled count includes pages
  // discovered outside the sitemap. Report each number plainly.
  const ok = counts.successful;
  const err = counts.withErrors + counts.failedToLoad;
  const crawledLine = err > 0 ? `${ok} crawled, ${err} errored` : `${ok} crawled`;
  const sitemapLine = sitemapCount ? ` (sitemap listed ${sitemapCount})` : '';
  lines.push(`**Pages:** ${crawledLine}${sitemapLine}  `);
  if (metadata.isMultiLang) lines.push(`**Multilingual:** yes  `);
  lines.push('');
  return lines.join('\n');
}

/**
 * When the crawl produced no analyzable pages (every fetch errored or failed to
 * load), the per-page and site-wide findings below are artifacts of the error
 * responses — a "0 words / thin content" finding on a 404 is an artifact of the
 * error, not a content problem — and categories with no measured signal default
 * to a perfect score. Surface a prominent banner so a degenerate run is never
 * mistaken for a valid audit. Returns '' for a healthy crawl (>0 analyzed).
 */
function buildDegenerateCrawlBanner(artifacts: AuditArtifacts): string {
  const counts = crawlCounts(artifacts);
  if (counts.successful > 0) return '';
  const err = counts.withErrors + counts.failedToLoad;
  const errLine = err > 0 ? ` All ${err} attempted page(s) returned errors (e.g. 4xx/5xx) or failed to load.` : '';
  return [
    `> **⚠️ Crawl produced no analyzable pages.**${errLine} The findings and category scores below are derived from an empty / error-only dataset and are **not a reliable audit**: per-page findings (e.g. "thin content", "missing canonical") are artifacts of the error responses, and categories with no measured signal default to a perfect score. Investigate what makes these URLs unreachable — a sitemap pointing at dead URLs, an auth/geo wall, or bot blocking — and re-run.`,
    '',
  ].join('\n');
}

function buildPurpose(artifacts: AuditArtifacts, noScore = false): string {
  const lines: string[] = [
    '## Purpose of the Audit',
    '',
    "The primary purpose of this audit is to identify areas for improvement in the technical, SEO, performance, accessibility, and UX aspects of the website. It examines elements that impact user experience and search engine rankings, and proposes actionable recommendations to enhance the site's efficiency, compliance, and overall effectiveness.",
    '',
    '## Scope of the Audit',
    '',
    'To evaluate effectiveness from the perspective of both users and search engines, this audit covers:',
    '',
    '- Performance (Core Web Vitals, asset optimization, caching, fonts, render-blocking resources)',
    '- SEO (metadata, headings, structured data, sitemap, hreflang, internal links, status codes)',
    '- GDPR & Privacy (consent banner, third-party trackers, cookie lifespan)',
    '- Accessibility (axe-core findings + semantic heuristics)',
    '- UX / UI (responsive layout, forms, navigation)',
    '- Common technical issues (security headers, console errors, broken links)',
    '',
    '## Methodology',
    '',
    'The audit combines a deterministic crawl (Playwright on Chromium) with on-page analyzers and external signals (CrUX / PageSpeed Insights). All findings cited below are anchored in the crawl artifacts collected for this run.',
    '',
  ];

  // The scoring legend is only meaningful when the report actually carries
  // scores. Under --no-score the section projections and per-finding chips are
  // gone, so the paragraph explaining them would dangle — drop it.
  if (!noScore) {
    lines.push(
      'Each category section header shows the current 0–100 score and, where there is room to improve, the score we would expect once that category’s issues are addressed across the site (`current → ~projected`). Because a category’s findings can appear in more than one section, the projection is shown once — on the section that owns the score — while individual findings everywhere carry the rough number of points fixing them recovers in their category (`+~N pts`). These projections are estimates — the `~` is deliberate: SEO and Technical scores are direct functions of the findings, while Performance, Accessibility and Security derive from measured per-page signals (Core Web Vitals, axe-core, security headers), so a per-finding figure approximates resolving the class of problem it represents.',
      '',
      scoringRulesMarkdown(),
      '',
    );
  }

  // Run-specific characteristics — gives the reader an at-a-glance picture
  // of what was actually measured for this particular audit.
  const evidence = artifacts.manifest.evidence;
  const sampledCount = evidence ? Object.keys(evidence).length : 0;
  const psiCaptured = evidence
    ? Object.values(evidence).filter((e) => e.files.some((f) => f.startsWith('psi.'))).length
    : 0;
  const axeCaptured = evidence ? Object.values(evidence).filter((e) => e.files.includes('axe.json')).length : 0;

  const stats: string[] = [];
  stats.push(`- **Pages crawled:** ${crawlCounts(artifacts).successful}`);
  if (artifacts.metadata.sitemaps?.total) {
    stats.push(`- **Sitemap entries:** ${artifacts.metadata.sitemaps.total}`);
  }
  if (sampledCount > 0) {
    const evidenceParts: string[] = ['network log'];
    if (axeCaptured > 0) evidenceParts.push(`axe-core scan (${axeCaptured})`);
    if (psiCaptured > 0) evidenceParts.push(`PSI lab scores (${psiCaptured})`);
    stats.push(`- **Representative-page evidence:** ${sampledCount} page(s) — ${evidenceParts.join(', ')}`);
  } else {
    stats.push(`- **Representative-page evidence:** not captured (\`--no-evidence\` or no sampled pages)`);
  }
  if (artifacts.metadata.isMultiLang) {
    stats.push('- **Multilingual:** detected (hreflang reciprocity checks applied)');
  }
  if (artifacts.repoAnalysis?.framework) {
    const fw = artifacts.repoAnalysis.framework;
    const ver = artifacts.repoAnalysis.version ?? '';
    const router = artifacts.repoAnalysis.router ? ` · ${artifacts.repoAnalysis.router}` : '';
    stats.push(`- **Source code analysis:** ${fw}${ver ? ' ' + ver : ''}${router}`);
  }

  lines.push('**This run:**');
  lines.push('');
  lines.push(...stats);
  lines.push('');

  if (sampledCount > 0) {
    lines.push(
      `*Representative-page evidence means we captured detailed diagnostics — a full network request log, an accessibility scan, and (where available) lab performance scores — for a small, structurally representative sample of pages (the homepage and a spread of section and detail pages), rather than for every page on the site. These samples ground the findings below in concrete, reproducible measurements.*`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Resolve a quick-win's fix/example for the summary, applying the Next.js
 * override when detected. Returns the fence language (`tsx` for Next.js code,
 * `html` otherwise) so the example renders correctly.
 */
function resolveQuickWin(q: QuickWin, isNextjs: boolean): { fix: string; example: string | undefined; lang: string } {
  const override = isNextjs ? nextjsOverrideFor(q.issue) : undefined;
  if (override) {
    return { fix: override.fix ?? q.fix, example: override.example ?? q.example, lang: 'tsx' };
  }
  return { fix: q.fix, example: q.example, lang: 'html' };
}

/**
 * Render a quick-win / long-term example as indented summary lines: a prose
 * guidance sentence as an indented paragraph, real code in a fenced block.
 * Mirrors the per-finding Example rendering so prose ("Replace dead links with
 * archived versions…") never lands in a ```html fence.
 */
function renderIndentedExample(example: string, lang: string): string[] {
  const ex = example.trim();
  if (looksLikeProseExample(ex)) return ['', `  ${ex}`];
  const out = ['', `  \`\`\`${lang}`];
  for (const line of ex.split('\n')) out.push(`  ${line}`);
  out.push('  ```');
  return out;
}

/** Effort level for the report — delegates to the shared scoring helper so the
 *  low/medium/high thresholds stay in one place. */
const effortLevel = (effort: string | undefined, effortMinutes?: number) =>
  ScoreCalculator.effortLevel(effort, effortMinutes);

/**
 * Canonical identity for cross-list de-duplication within the summary. Uses the
 * group-aware key so equivalents named differently across the details map and
 * the scoring `quickWins` list (e.g. "identical titles" ≡ "Duplicate page
 * titles found") collapse to one identity.
 */
function summaryIdentity(message: string): string {
  return findingGroupKey(message);
}

function buildSummary(
  artifacts: AuditArtifacts,
  details: Record<string, IssueDetail>,
  suppressed: ReadonlySet<string>,
  isNextjs = false,
): string {
  const { summary } = artifacts.analysis;
  const lines: string[] = ['## Summary and Recommendations', ''];

  // Track what has already been listed so a finding never appears in more than
  // one of Top Priority / Quick Wins / Long-term. Precedence is list order:
  // Top Priority claims first, then Quick Wins, then Long-term.
  //
  // Seed with the verification-suppressed findings' identities: the Quick Wins /
  // Long-term lists are built from the scoring layer's `quickWins` (a separate
  // source from `details`), so without this seed a finding dropped by the
  // verification pass could still resurface there.
  const seen = new Set<string>();
  for (const message of suppressed) seen.add(summaryIdentity(message));

  // Top priority issues — rank from the full `details` map by category then
  // severity (not only `quickWins`, which is often a tiny subset on big audits).
  const ranked = Object.entries(details ?? {})
    .sort(byImportance)
    .slice(0, 3);
  if (ranked.length > 0) {
    lines.push('### Top Priority Issues');
    lines.push('');
    ranked.forEach(([message, d], i) => {
      seen.add(summaryIdentity(message));
      lines.push(
        `${i + 1}. ${sevSpan(d.severity)} — ${sanitizeProse(message)} *(${d.count} occurrence${d.count === 1 ? '' : 's'})*`,
      );
    });
    lines.push('');
  }

  // Quick wins — short effort, ordered by effortMinutes asc. Falls back to
  // deriving from `details` when scoring's quickWins list is sparse. Filter
  // before slicing so dropping an already-listed finding doesn't shrink the list.
  const richQuickwins = (summary.quickWins ?? [])
    .filter((q) => (q.effortMinutes ?? 999) <= 30 && !seen.has(summaryIdentity(q.issue)))
    .sort((a, b) => (a.effortMinutes ?? 999) - (b.effortMinutes ?? 999) || a.issue.localeCompare(b.issue))
    .slice(0, 5);

  if (richQuickwins.length >= 1) {
    lines.push('### Quick Wins');
    lines.push('');
    richQuickwins.forEach((q) => {
      seen.add(summaryIdentity(q.issue));
      const rw = resolveQuickWin(q, isNextjs);
      lines.push(
        `- **${sanitizeProse(q.issue)}** — ${sanitizeProse(rw.fix.split('.').slice(0, 1).join('.'))}. *(effort: ${effortLevel(q.effort, q.effortMinutes)})*`,
      );
      if (rw.example && rw.example.trim()) {
        lines.push(...renderIndentedExample(rw.example, rw.lang));
      }
    });
    lines.push('');
  } else {
    // Fallback: high/critical severity, low occurrence count (contained → easy fix).
    const fallback = Object.entries(details ?? {})
      .filter(([message, d]) => {
        const sev = d.severity?.toLowerCase();
        return (sev === 'critical' || sev === 'high') && (d.count ?? 0) <= 5 && !seen.has(summaryIdentity(message));
      })
      .sort(byImportance)
      .slice(0, 5);
    if (fallback.length > 0) {
      lines.push('### Quick Wins');
      lines.push('');
      fallback.forEach(([message, d]) => {
        seen.add(summaryIdentity(message));
        lines.push(
          `- ${sevSpan(d.severity)} **${sanitizeProse(message)}** *(${d.count} occurrence${d.count === 1 ? '' : 's'} — contained)*`,
        );
      });
      lines.push('');
    }
  }

  // Long-term recommendations — higher-effort or systemic items.
  const richLongterm = (summary.quickWins ?? [])
    .filter((q) => (q.effortMinutes ?? 0) > 30 && !seen.has(summaryIdentity(q.issue)))
    .sort(byQuickWinImportance)
    .slice(0, 5);

  if (richLongterm.length >= 1) {
    lines.push('### Long-term Recommendations');
    lines.push('');
    richLongterm.forEach((q) => {
      seen.add(summaryIdentity(q.issue));
      const rw = resolveQuickWin(q, isNextjs);
      lines.push(
        `- ${sanitizeProse(q.issue)} — ${sanitizeProse(rw.fix.split('.').slice(0, 2).join('.'))}. *(effort: ${effortLevel(q.effort, q.effortMinutes)})*`,
      );
      if (rw.example && rw.example.trim()) {
        lines.push(...renderIndentedExample(rw.example, rw.lang));
      }
    });
    lines.push('');
  } else {
    // Fallback: the next tier of unshown high/critical findings (Top Priority
    // already claimed the top few). Order by `byImportance` — category first
    // (SEO > Performance > UX > Privacy/Security > Accessibility > Technical),
    // then severity, then impact — so a weak-category SEO/security item leads
    // over a high-count accessibility one. No occurrence-count gate: site-wide
    // findings (crawl-budget waste, orphan pages, missing security headers) are
    // reported once yet are exactly the long-term engineering work this section
    // should surface. `count > 20` only decides the "systemic" label below.
    const fallback = Object.entries(details ?? {})
      .filter(([message, d]) => {
        const sev = d.severity?.toLowerCase();
        return (sev === 'critical' || sev === 'high') && !seen.has(summaryIdentity(message));
      })
      .sort(byImportance)
      .slice(0, 5);
    if (fallback.length > 0) {
      lines.push('### Long-term Recommendations');
      lines.push('');
      fallback.forEach(([message, d]) => {
        seen.add(summaryIdentity(message));
        const count = d.count ?? 0;
        const scope = count > 20 ? `${count} occurrences — systemic` : `${count} occurrence${count === 1 ? '' : 's'}`;
        lines.push(`- ${sevSpan(d.severity)} **${sanitizeProse(message)}** *(${scope})*`);
      });
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * Render one finding using the same template every time so the report reads
 * as a consistent draft of action items. Order:
 *   ### Title
 *   <sev> · affects N occurrence(s) · effort: …
 *   **Affected pages** — bullets (up to EXAMPLES_PER_FINDING, with +N more)
 *   **Fix** — from FIX_RECOMMENDATIONS when matched; uniform fallback otherwise
 *   **Example** — fenced code block (only when a recommendation supplied one)
 *   **Resources** — bullets (only when a recommendation supplied them)
 */
/**
 * Verification view passed only when rendering the `--verify` report. Its mere
 * presence switches on the per-finding verification label; `confirmed` holds
 * the messages that re-checked out. Absent for the normal report (no labels).
 */
interface VerifyView {
  /** Confirmed by the deterministic pass (re-checked against crawl data). */
  confirmed: ReadonlySet<string>;
  /** Confirmed by the LLM fallback (judgment over evidence). */
  aiConfirmed?: ReadonlySet<string>;
}

function buildFindingBlock(
  message: string,
  detail: IssueDetail,
  isNextjs = false,
  sourceMapping?: Record<string, SourceLocation[]> | null,
  impact?: ScoreImpact,
  verifyView?: VerifyView,
  screenshots?: ScreenshotIndex,
  embedded?: Set<string>,
  probes?: ProbeIndex,
  siteFacts?: SiteFacts | null,
): string {
  const lines: string[] = [];
  // sanitizeProse (not stripHtml) for the title: stripHtml deletes element
  // mentions like `<main>`, turning "Missing <main> element" into the useless
  // "Missing  element". sanitizeProse keeps them as literal inline code.
  const cleanTitle = sanitizeProse(message);
  const recommendation = lookupRecommendation(message, isNextjs);

  lines.push(`### ${cleanTitle}`);
  lines.push('');

  const headerParts: string[] = [
    sevSpan(detail.severity),
    `affects ${detail.count} occurrence${detail.count === 1 ? '' : 's'}${detail.truncated ? ' (truncated)' : ''}`,
  ];
  // Label LLM-discovered findings so they're auditable and clearly distinct
  // from deterministic analyzer output.
  if (detail.aiDiscovered) headerParts.push('🔍 AI-discovered');
  // Verification label — only in the `--verify` report. Every surviving issue
  // is tagged: ✓ Verified when its first example re-checked out against the
  // crawl data, "unverified" when no deterministic check could corroborate it
  // (refuted issues were dropped before rendering, so they never reach here).
  if (verifyView) {
    if (verifyView.confirmed.has(message)) {
      headerParts.push('<span class="verified">✓ Verified</span>');
    } else if (verifyView.aiConfirmed?.has(message)) {
      headerParts.push('<span class="verified">✓ Verified (AI)</span>');
    } else {
      headerParts.push('<span class="unverified">unverified</span>');
    }
  }
  if (recommendation?.effort) headerParts.push(`effort: ${effortLevel(recommendation.effort)}`);
  // Score lever — roughly how many points fixing this recovers, and in which
  // category. Omitted for AI-discovered findings (no deterministic score model)
  // and for findings worth < 1 point.
  const liftChip = !detail.aiDiscovered && impact ? findingLiftChip(message, impact) : null;
  if (liftChip) headerParts.push(liftChip);
  lines.push(headerParts.join(' · '));
  lines.push('');

  // Benchmark — for threshold-comparative findings ("too many / too long / high
  // percentage of …"), state what the value SHOULD be and WHY. The value it IS
  // now is carried per-page in the examples below. Skipped for AI findings,
  // which supply their own evidence + recommendation.
  if (!detail.aiDiscovered) {
    const benchmark = benchmarkFor(stripHtml(message));
    if (benchmark) {
      lines.push('**Benchmark**');
      lines.push('');
      lines.push(benchmark);
      lines.push('');
    }
  }

  // Affected pages — always present so structure is uniform, even when the
  // analyzer only produced a single contextual example string.
  const examples = detail.examples ?? [];
  if (examples.length > 0) {
    lines.push(detail.aiDiscovered ? '**Evidence**' : '**Affected pages**');
    lines.push('');
    // Sort worst-first before slicing so the shown sample leads with the most
    // severe pages (highest request count, largest unused-code size, worst TBT,
    // …) rather than alphabetically by URL. The lexicographic tiebreak inside
    // the comparator keeps the sample identical every run — `examples` are
    // appended in concurrent crawl-completion order, which is not deterministic
    // on its own.
    const shown = [...examples].sort(compareExamplesWorstFirst).slice(0, EXAMPLES_PER_FINDING);
    const PAGES_PER_CLUSTER = 12;
    for (const ex of shown) {
      // AI findings carry cited evidence ("<what was seen> — <url>"); keep it
      // whole.
      if (detail.aiDiscovered) {
        lines.push(`- ${sanitizeProse(ex)}`);
        continue;
      }
      // Clustered examples (duplicate titles/descriptions: a shared value used
      // on several pages) carry multiple URLs. Render the shared value as the
      // bullet and nest the related pages under it, so it's clear which pages
      // are grouped together — instead of collapsing to the first URL.
      const urls = extractAllUrls(ex);
      if (urls.length > 1) {
        const label = clusterLabel(ex);
        lines.push(`- ${label || 'Pages sharing this value'}`);
        for (const u of urls.slice(0, PAGES_PER_CLUSTER)) lines.push(`    - ${mdLink(u, u)}`);
        if (urls.length > PAGES_PER_CLUSTER) {
          lines.push(
            `    - *…and ${urls.length - PAGES_PER_CLUSTER} more page${urls.length - PAGES_PER_CLUSTER === 1 ? '' : 's'}*`,
          );
        }
      } else {
        // Single-page example. When the analyzer attached a measured value
        // ("… has 8 render-blocking resources", "… 73% of CSS is unused"), the
        // lead clause keeps the actual number; inlineExample preserves the page
        // anchor as a clickable markdown link. When the example is nothing but a
        // URL it yields a bare link too.
        lines.push(`- ${inlineExample(ex)}`);
      }
    }
    const remaining = Math.max(0, (detail.count ?? examples.length) - shown.length);
    if (remaining > 0) {
      lines.push(`- *…and ${remaining} more affected page${remaining === 1 ? '' : 's'}*`);
    }
    lines.push('');

    // Visual evidence — issue-aware when the sampled page carries overlay data
    // for this finding kind (annotated highlight boxes, CLS before/after pair,
    // SERP preview), otherwise the plain mobile + desktop pair. Only the ~10
    // representative pages carry evidence, so most findings render none.
    // AI-discovered findings supply their own evidence block, so skip them here.
    if (screenshots && embedded && !detail.aiDiscovered) {
      const block = buildEvidenceBlock(message, shown, screenshots, embedded, probes, siteFacts);
      if (block) {
        lines.push(block);
        lines.push('');
      }
    }
  }

  // Fix — anomaly-supplied remediation, else catalogued recommendation, else
  // a uniform client-facing hint.
  lines.push('**Fix**');
  lines.push('');
  if (detail.aiDiscovered && detail.recommendation) {
    lines.push(sanitizeProse(detail.recommendation));
  } else if (recommendation?.fix) {
    lines.push(sanitizeProse(recommendation.fix));
  } else {
    // No catalogued recommendation — fall back to a category-level default
    // (framework-aware on Next.js audits) rather than a generic boilerplate line.
    lines.push(sanitizeProse(defaultFix(message, isNextjs)));
  }
  lines.push('');

  // Where in the code — source files the --repo pass mapped to this finding,
  // so the reader can jump straight to the file to fix instead of guessing.
  const locations = sourceLocationsFor(message, sourceMapping);
  if (locations.length > 0) {
    lines.push('**Where in the code**');
    lines.push('');
    const WHERE_LIMIT = 10;
    for (const loc of locations.slice(0, WHERE_LIMIT)) {
      const where = loc.line && loc.line > 1 ? `${loc.file}:${loc.line}` : loc.file;
      const hint = loc.suggestion ? ` — ${sanitizeProse(loc.suggestion)}` : '';
      lines.push(`- \`${where}\`${hint}`);
    }
    if (locations.length > WHERE_LIMIT) {
      lines.push(
        `- *…and ${locations.length - WHERE_LIMIT} more file${locations.length - WHERE_LIMIT === 1 ? '' : 's'}*`,
      );
    }
    lines.push('');
  }

  if (recommendation?.example && recommendation.example.trim()) {
    const example = recommendation.example.trim();
    lines.push('**Example**');
    lines.push('');
    if (looksLikeProseExample(example)) {
      // A natural-language guidance sentence, not a code sample — render as
      // text. Fencing it as ```html produced absurd "code" blocks like "Replace
      // dead links with archived versions or remove them entirely."
      lines.push(example);
    } else {
      // Next.js overrides supply JSX/TSX examples; tag the fence accordingly.
      const exampleLang = isNextjs && nextjsOverrideFor(message)?.example ? 'tsx' : 'html';
      lines.push(`\`\`\`${exampleLang}`);
      for (const line of example.split('\n')) {
        lines.push(line);
      }
      lines.push('```');
    }
    lines.push('');
  }

  if (recommendation?.resources && recommendation.resources.length > 0) {
    lines.push('**Resources**');
    lines.push('');
    for (const r of recommendation.resources) {
      lines.push(`- [${r.text}](${r.url})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Severity tally string like "1 critical, 3 high" for a set of findings. */
function severityTally(items: Array<[string, IssueDetail]>): string {
  const tally: Record<string, number> = {};
  for (const [, d] of items) {
    const s = (d.severity ?? 'medium').toLowerCase();
    tally[s] = (tally[s] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    if (tally[sev]) parts.push(`${tally[sev]} ${sev}`);
  }
  return parts.join(', ');
}

/**
 * Deterministic Analysis paragraph. Leads with the single highest-impact
 * finding and how many pages it touches, then names the next couple — far
 * more useful than "N distinct findings". `primary` is pre-sorted by impact.
 */
function buildAnalysisProse(primary: Array<[string, IssueDetail]>, minorCount: number): string {
  if (primary.length === 0) {
    return minorCount > 0
      ? `No significant issues in this section — only ${minorCount} minor or informational note${minorCount === 1 ? '' : 's'}, listed below.`
      : 'No issues found in this section.';
  }
  const [topMsg, topDetail] = primary[0];
  const topPages = topDetail.count ?? 0;
  const breadth = topPages > 1 ? `, affecting ${topPages} pages` : '';
  const lead = `The most impactful is *${sanitizeProse(topMsg)}*${breadth}.`;
  const others = primary
    .slice(1, 3)
    .map(([m]) => `*${sanitizeProse(m)}*`)
    .join(', ');
  const also = others ? ` Also notable: ${others}.` : '';
  const minorNote =
    minorCount > 0 ? ` ${minorCount} minor/informational note${minorCount === 1 ? '' : 's'} follow.` : '';
  return `${primary.length} notable finding${primary.length === 1 ? '' : 's'} (${severityTally(primary)}). ${lead}${also}${minorNote}`;
}

function buildSection(
  section: Section,
  items: Array<[string, IssueDetail]>,
  narrative?: string | null,
  isNextjs = false,
  sourceMapping?: Record<string, SourceLocation[]> | null,
  impact?: ScoreImpact,
  verifyView?: VerifyView,
  screenshots?: ScreenshotIndex,
  embedded?: Set<string>,
  probes?: ProbeIndex,
  siteFacts?: SiteFacts | null,
): string {
  if (items.length === 0) return '';

  // Split genuine issues from notice-tier boilerplate so low-value "best
  // practice" checks (no web app manifest, no service worker, theme-color…)
  // don't bury the real findings. Both lists are already impact-sorted.
  const primary = items.filter(([m, d]) => classifyIssue(m, d.severity).tier !== 'notice');
  const minor = items.filter(([m, d]) => classifyIssue(m, d.severity).tier === 'notice');

  // Header score suffix — the category this section represents, with
  // `current → projected`. A category's projection is an audit-wide fact (its
  // findings scatter across sections), so we surface it once, on the section
  // that owns it, rather than repeating it on every section that contains a
  // stray finding of that category. The UX and Common-Problems sections are
  // catch-alls with no single home score; their findings still carry per-item
  // chips, but the header stays clean.
  const home = SECTION_HOME_CATEGORY[section];
  const scoreSuffix = impact && home ? sectionScoreSuffix([home], impact) : '';

  const lines: string[] = [];
  lines.push(`## ${SECTION_TITLES[section]}${scoreSuffix}`);
  lines.push('');

  // Analysis paragraph: LLM-enhanced prose when available, else the
  // deterministic top-finding-led fallback.
  if (narrative && narrative.trim()) {
    lines.push(`**Analysis.** ${narrative.trim()}`);
  } else {
    lines.push(`**Analysis.** ${buildAnalysisProse(primary, minor.length)}`);
  }
  lines.push('');

  // Cap noisy sections — show the top N primary findings, summarise the rest.
  // Findings that the --repo pass mapped to specific source files are the most
  // actionable (the reader knows exactly where to fix them), so surface them
  // even when they fall past the cap rather than hiding them.
  const shown = primary.slice(0, SECTION_FINDING_LIMIT);
  const overflow = primary.slice(SECTION_FINDING_LIMIT);
  const extraMapped = overflow.filter(([m]) => sourceLocationsFor(m, sourceMapping).length > 0);
  const hidden = overflow.filter(([m]) => sourceLocationsFor(m, sourceMapping).length === 0);

  for (const [message, detail] of [...shown, ...extraMapped]) {
    lines.push(buildFindingBlock(message, detail, isNextjs, sourceMapping, impact, verifyView, screenshots, embedded, probes, siteFacts));
  }

  if (hidden.length > 0) {
    lines.push(
      `> *…and ${hidden.length} more lower-priority finding${hidden.length === 1 ? '' : 's'} in this section (${severityTally(hidden)}).*`,
    );
    lines.push('');
  }

  // Minor & informational — compact one-liners, never full finding blocks.
  // The full list is shown (each is a single line, not an expensive finding
  // block), so the reader gets a complete inventory of lower-impact issues
  // rather than a truncated "…and N more".
  if (minor.length > 0) {
    lines.push('**Minor & informational**');
    lines.push('');
    for (const [message, detail] of minor) {
      const c = detail.count ?? 0;
      lines.push(`- ${sanitizeProse(message)}${c > 1 ? ` *(${c} pages)*` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Top-level builder ──────────────────────────────────────────────────────

export function buildReportMarkdown(
  artifacts: AuditArtifacts,
  narratives: Partial<Record<Section, string | null>> = {},
  anomalies: Anomaly[] = [],
  suppressed: ReadonlySet<string> = new Set(),
  verifyView?: VerifyView,
  verifyBanner?: string,
  noScore = false,
  selection: ReportSelection = {},
): string {
  const isNextjs = detectNextjs(artifacts);
  const sourceMapping = artifacts.repoAnalysis?.sourceMapping ?? null;
  // One details map drives both the summary and the sections so suppression and
  // ranking stay identical across them.
  const details = preparedDetails(artifacts, suppressed, selection.checks);
  const buckets = bucketDetails(details);
  mergeAnomalies(
    buckets,
    anomalies.filter((a) => matchesChecks(a.title, a.section, selection.checks)),
  );
  // Score-impact model: ties every category section and finding to the score it
  // moves. Built from the same prepared details the sections render, so the
  // annotations and the findings can never disagree. With --no-score we leave it
  // undefined, which suppresses both the section header projections and the
  // per-finding point chips downstream.
  const impact = noScore ? undefined : buildScoreImpact(artifacts.analysis.summary?.categoryScores, details);
  // Screenshot evidence — index the sampled-page captures so findings can embed
  // them. `embedded` is mutated as sections render (deterministic traversal) so
  // each unique page's screenshots appear once across the whole report.
  const screenshots = buildScreenshotIndex(artifacts.manifest, artifacts.runDir);
  const embedded = new Set<string>();
  // Probe-step shots (broken-pagination sequences) and site link-graph facts —
  // both best-effort; absent artifacts simply mean no such evidence renders.
  const probes = buildProbeIndex(artifacts.manifest);
  let siteFacts: SiteFacts | null;
  try {
    siteFacts = loadSiteFacts(artifacts.runDir, artifacts.manifest.progress?.processedPages ?? []);
  } catch {
    siteFacts = null;
  }
  const parts: string[] = [];
  parts.push(buildCover(artifacts, selection.preset));
  // Degenerate-crawl guard: when nothing was successfully analyzed, the findings
  // and scores below are artifacts. Warn before anything else so the report is
  // never mistaken for a valid audit (empty string for a healthy crawl).
  parts.push(buildDegenerateCrawlBanner(artifacts));
  // Verification banner (only on the `--verify` report) sits right under the
  // cover so the reader knows these findings were re-checked.
  if (verifyBanner) parts.push(verifyBanner);
  parts.push(buildPurpose(artifacts, noScore));
  parts.push(buildSummary(artifacts, details, suppressed, isNextjs));
  for (const sec of selection.sections ?? SECTION_ORDER) {
    parts.push(buildSection(sec, buckets[sec], narratives[sec], isNextjs, sourceMapping, impact, verifyView, screenshots, embedded, probes, siteFacts));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Pre-compute LLM-generated Analysis paragraphs for each non-empty section.
 * Returns an empty map (template fallback) when the API key is absent or
 * llmNarrative is disabled. Failures degrade silently — never blocks the run.
 */
async function prepareNarratives(
  artifacts: AuditArtifacts,
  options: Phase2Options,
  suppressed: ReadonlySet<string>,
): Promise<Partial<Record<Section, string | null>>> {
  if (!options.llmNarrative) return {};
  // No key → the narrative pass falls back to the keyless `claude` CLI. Only bail
  // to templated prose when neither transport is reachable.
  if (!process.env.ANTHROPIC_API_KEY && !isClaudeCliAvailable()) {
    if (options.verbose) {
      console.warn('--llm requested but no ANTHROPIC_API_KEY and no claude CLI found; falling back to templated prose.');
    }
    return {};
  }

  // Generate prose over the same suppressed set the report will render, so the
  // narrative never references a finding that was dropped.
  const buckets = bucketDetails(preparedDetails(artifacts, suppressed, options.checks));
  const cacheDir = path.join(artifacts.runDir, 'cache', 'llm-narrative');

  const out: Partial<Record<Section, string | null>> = {};
  const sectionsWithItems = (options.sections ?? SECTION_ORDER).filter((section) => buckets[section].length > 0);
  const progress = new PhaseProgress('Section narratives (LLM)', sectionsWithItems.length);
  const calls = sectionsWithItems.map(async (section) => {
    const items = buckets[section];
    const findings = items.slice(0, 30).map(([message, detail]) => ({
      message: stripHtml(message),
      severity: detail.severity ?? 'medium',
      count: detail.count ?? 0,
      exampleUrl: detail.examples?.[0] ? extractFirstUrl(detail.examples[0]) : undefined,
    }));
    out[section] = await generateSectionAnalysis({
      sectionTitle: SECTION_TITLES[section],
      findings,
      cacheDir,
      verbose: options.verbose,
    });
    progress.tick();
  });
  await Promise.all(calls);
  progress.done(`Section narratives: ${sectionsWithItems.length}`);
  return out;
}

// A templated URL pattern carries a `{N}`-style placeholder (e.g. a pagination
// series key `https://e.com/page/{N}`). These identify a series, not a real
// crawled page, so they must never be surfaced as an "affected page".
const isTemplateUrl = (u: string): boolean => /[{}]/.test(u);

/** Pull the first real (non-templated) http(s):// URL out of a raw example string. */
function extractFirstUrl(s: string): string | undefined {
  return (s.match(/https?:\/\/[^\s<>"']+/g) ?? []).find((u) => !isTemplateUrl(u));
}

/**
 * Normalize a URL for matching a finding's example against the captured-evidence
 * index: drop the fragment and any trailing slash so `https://e.com/about/` and
 * `https://e.com/about#x` both resolve to the same evidence entry. Both sides of
 * the comparison come from the same crawl, so case is left untouched.
 */
function normalizeUrlForEvidence(u: string): string {
  return u.replace(/#.*$/, '').replace(/\/+$/, '');
}

/** A captured page's screenshots, as paths relative to the evidence dir. */
interface ScreenshotRef {
  url: string;
  mobile?: string;
  desktop?: string;
  /** Viewport shot taken right after the load event (pre-settle). */
  firstload?: string;
  /** Viewport shot rendered with JavaScript disabled (what non-JS crawlers see). */
  nojs?: string;
  /** Parsed overlays.json — issue-element rects, page meta, CLS shifts. */
  overlays?: VisualOverlays;
  /** Aggregated requests.json — feeds the network data panels. */
  netSummary?: NetSummary;
}
type ScreenshotIndex = Map<string, ScreenshotRef>;

interface NetSummary {
  totalRequests: number;
  totalBytes: number;
  byType: Array<{ type: string; count: number; bytes: number }>;
  byHost: Array<{ host: string; count: number; bytes: number; thirdParty: boolean }>;
  thirdPartyCount: number;
  thirdPartyBytes: number;
}

/**
 * Aggregate a sampled page's request log into the compact summary the network
 * panels render. Deterministic: byte-desc with name tiebreakers. First-party =
 * same host as the page or a sub/super-domain of it (www. stripped).
 */
function summarizeRequests(pageUrl: string, requests: Record<string, { resourceType?: string; size?: number | null }>): NetSummary {
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    // unparseable page URL — everything counts as first-party
  }
  const byType = new Map<string, { count: number; bytes: number }>();
  const byHost = new Map<string, { count: number; bytes: number; thirdParty: boolean }>();
  let totalBytes = 0;
  let totalRequests = 0;
  let thirdPartyCount = 0;
  let thirdPartyBytes = 0;
  for (const [reqUrl, info] of Object.entries(requests)) {
    let host: string;
    try {
      host = new URL(reqUrl).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const bytes = typeof info.size === 'number' ? info.size : 0;
    const type = info.resourceType ?? 'other';
    const thirdParty = pageHost !== '' && host !== pageHost && !host.endsWith(`.${pageHost}`) && !pageHost.endsWith(`.${host}`);
    totalRequests += 1;
    totalBytes += bytes;
    if (thirdParty) {
      thirdPartyCount += 1;
      thirdPartyBytes += bytes;
    }
    const t = byType.get(type) ?? { count: 0, bytes: 0 };
    t.count += 1;
    t.bytes += bytes;
    byType.set(type, t);
    const h = byHost.get(host) ?? { count: 0, bytes: 0, thirdParty };
    h.count += 1;
    h.bytes += bytes;
    byHost.set(host, h);
  }
  const sortDesc = <T extends { bytes: number; count: number }>(entries: Array<[string, T]>) =>
    entries.sort(([an, a], [bn, b]) => b.bytes - a.bytes || b.count - a.count || (an < bn ? -1 : 1));
  return {
    totalRequests,
    totalBytes,
    byType: sortDesc([...byType.entries()]).map(([type, v]) => ({ type, ...v })),
    byHost: sortDesc([...byHost.entries()])
      .slice(0, 8)
      .map(([host, v]) => ({ host, ...v })),
    thirdPartyCount,
    thirdPartyBytes,
  };
}

/**
 * Build a normalized-URL → screenshot-paths index from the manifest's evidence
 * section. Paths are relative to `<runDir>` (the report's own directory and the
 * `imageBaseDir` the PDF renderer resolves to `file://`), so the same `evidence/
 * <dir>/…` src resolves both in the rendered PDF and when `audit-report.md` /
 * `.html` is opened directly. Deterministic: see the key-sorted iteration below.
 */
function buildScreenshotIndex(manifest: ManifestData, runDir?: string): ScreenshotIndex {
  const idx: ScreenshotIndex = new Map();
  const evidence = manifest.evidence;
  if (!evidence) return idx;
  // Iterate entries in evidence-dir-key order, not manifest order. The manifest's
  // evidence map is built by walking the evidence directory (readdir-derived,
  // machine-dependent), so its insertion order is NOT guaranteed. On a normalized
  // -URL collision (e.g. both `/about` and `/about/` were sampled — trailing-slash
  // pairs do occur), first-wins over the key-sorted entries deterministically
  // picks the lexicographically-first dir, preserving the byte-identical-report
  // guarantee (docs/report-rules.md) regardless of manifest order.
  const entries = Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, entry] of entries) {
    if (!entry?.url) continue;
    const ref: ScreenshotRef = { url: entry.url };
    if (entry.files.includes('screenshot.mobile.png')) ref.mobile = `evidence/${key}/screenshot.mobile.png`;
    if (entry.files.includes('screenshot.desktop.png')) ref.desktop = `evidence/${key}/screenshot.desktop.png`;
    if (entry.files.includes('screenshot.firstload.png')) ref.firstload = `evidence/${key}/screenshot.firstload.png`;
    if (entry.files.includes('screenshot.nojs.png')) ref.nojs = `evidence/${key}/screenshot.nojs.png`;
    if (!ref.mobile && !ref.desktop) continue;
    // Issue-element rects measured at capture time. Best effort — an absent or
    // unreadable overlays.json (older audits, synthetic test artifacts) just
    // means findings fall back to the plain screenshot block.
    if (runDir && entry.files.includes('overlays.json')) {
      try {
        ref.overlays = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', key, 'overlays.json'), 'utf8')) as VisualOverlays;
      } catch {
        // fall back to plain screenshots
      }
    }
    // Aggregate the request log into the compact summary the network panels
    // render; raw entries are discarded. Best effort like overlays.
    if (runDir && entry.files.includes('requests.json')) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', key, 'requests.json'), 'utf8')) as {
          requests?: Record<string, { resourceType?: string; size?: number | null }>;
        };
        if (raw.requests && Object.keys(raw.requests).length > 0) {
          ref.netSummary = summarizeRequests(entry.url, raw.requests);
        }
      } catch {
        // no network panel for this page
      }
    }
    const k = normalizeUrlForEvidence(entry.url);
    if (!idx.has(k)) idx.set(k, ref);
  }
  return idx;
}

/** Pagination-probe step shots, keyed by normalized probed URL. */
interface ProbeShots {
  url: string;
  clicks?: number;
  steps: Array<{ name: string; src: string }>;
}
type ProbeIndex = Map<string, ProbeShots>;

/**
 * Index pagination-probe evidence dirs (written by PaginationAnalyzer when a
 * probe flags a series). They carry step-*.png files and no screenshot.mobile,
 * so the regular screenshot index skips them; this picks them up instead.
 */
function buildProbeIndex(manifest: ManifestData): ProbeIndex {
  const idx: ProbeIndex = new Map();
  const evidence = manifest.evidence;
  if (!evidence) return idx;
  const entries = Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, entry] of entries) {
    if (!entry?.url) continue;
    const steps = entry.files
      .filter((f) => /^step-.*\.png$/.test(f))
      .sort()
      .map((f) => ({ name: f.replace(/\.png$/, ''), src: `evidence/${key}/${f}` }));
    if (steps.length === 0) continue;
    const k = normalizeUrlForEvidence(entry.url);
    if (!idx.has(k)) idx.set(k, { url: entry.url, steps });
  }
  return idx;
}

/** Site link-graph facts for the per-URL evidence table on site-wide findings. */
interface SiteFacts {
  /** normalized URL → inbound internal-link count */
  inbound: Map<string, number>;
  /** normalized sitemap URL set (null when no sitemap was recorded) */
  sitemap: Set<string> | null;
  /**
   * Normalized crawled-page set. incoming-links.json only contains pages that
   * RECEIVED links, so a true orphan is absent from the map — this set
   * disambiguates "crawled with zero inbound links" (a hard fact worth a row)
   * from "URL the crawl never saw" (no row — proves nothing).
   */
  crawled: Set<string>;
}

/**
 * Load the inbound-link graph + sitemap URL set for the link-graph facts
 * panel. Sync and best-effort: returns null when the artifacts are absent
 * (synthetic test runs, partial audits) — findings then render no panel.
 */
function loadSiteFacts(runDir: string, processedPages: string[] = []): SiteFacts | null {
  const readGzOrPlain = <T>(base: string): T | null => {
    for (const file of [`${base}.gz`, base]) {
      try {
        const raw = fs.readFileSync(path.join(runDir, file));
        return JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8')) as T;
      } catch {
        // try next variant
      }
    }
    return null;
  };
  const incoming = readGzOrPlain<Record<string, string[]>>('incoming-links.json');
  const metadata = readGzOrPlain<{ sitemaps?: { urls?: Record<string, unknown> } }>('metadata.json');
  if (!incoming && !metadata) return null;
  const inbound = new Map<string, number>();
  for (const [dst, srcs] of Object.entries(incoming ?? {})) {
    inbound.set(normalizeUrlForEvidence(dst), Array.isArray(srcs) ? srcs.length : 0);
  }
  const sitemapUrls = metadata?.sitemaps?.urls ? Object.keys(metadata.sitemaps.urls) : null;
  const sitemap = sitemapUrls && sitemapUrls.length > 0 ? new Set(sitemapUrls.map(normalizeUrlForEvidence)) : null;
  const crawled = new Set(processedPages.map(normalizeUrlForEvidence));
  return { inbound, sitemap, crawled };
}

/** Minimal escaping for a value placed inside a double-quoted HTML attribute. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Render a `**Screenshot**` block for the first sampled example among `shown`
 * (already worst-first sorted, so the pick is deterministic). Each unique
 * evidence page is embedded ONCE per report — `embedded` tracks pages already
 * shown, and later findings on the same page get a lightweight pointer instead
 * of repeating the (potentially large) full-page images. Returns null when no
 * shown example was sampled.
 */
function buildScreenshotBlock(
  shown: string[],
  screenshots: ScreenshotIndex,
  embedded: Set<string>,
): string | null {
  let ref: ScreenshotRef | undefined;
  for (const ex of shown) {
    const url = extractFirstUrl(ex);
    if (!url) continue;
    const found = screenshots.get(normalizeUrlForEvidence(url));
    if (found) {
      ref = found;
      break;
    }
  }
  if (!ref) return null;

  const lines: string[] = ['**Screenshot**', ''];
  const key = normalizeUrlForEvidence(ref.url);
  if (embedded.has(key)) {
    lines.push(`Screenshot of ${mdLink(ref.url, ref.url)} is shown above.`);
    return lines.join('\n');
  }
  embedded.add(key);

  const alt = escapeHtmlAttr(ref.url);
  lines.push('<div class="evidence-shots">');
  if (ref.mobile) {
    lines.push(`<figure><img src="${ref.mobile}" alt="Mobile screenshot of ${alt}" /><figcaption>Mobile</figcaption></figure>`);
  }
  if (ref.desktop) {
    lines.push(`<figure><img src="${ref.desktop}" alt="Desktop screenshot of ${alt}" /><figcaption>Desktop</figcaption></figure>`);
  }
  lines.push('</div>');
  return lines.join('\n');
}

// ─── Issue-aware visual evidence ─────────────────────────────────────────────
//
// When the sampled page carries overlays.json (rects of the offending elements
// measured at capture time, CLS shift attribution, page meta), findings render
// evidence that SHOWS the issue instead of a context-free full-page shot:
//   • overlay kinds  → the mobile screenshot CSS-cropped to the issue region,
//                      with highlight boxes + labels drawn over it
//   • CLS            → first-load shot vs settled shot, shifted elements boxed
//                      (ghost = position before the shift)
//   • title/description findings → a SERP-style preview card with the
//                      truncation/absence visualised
// A matched kind whose rich data is absent (older audits, unsampled pages,
// --no-evidence) degrades to the plain screenshot pair — the cited page is at
// least topically relevant. A finding that matches NO kind (cross-page /
// network / header / structural claims like keyword cannibalisation, TBT, SRI,
// broken outbound links) renders NO evidence block rather than a context-free
// screenshot that illustrates nothing about it.

type HeadAspect = 'canonical' | 'noindex' | 'hreflang' | 'lang' | 'charset' | 'doctype';
type EvidenceKind =
  | { type: 'overlay'; kind: string }
  | { type: 'cls' }
  | { type: 'lcp' }
  | { type: 'nojs' }
  | { type: 'pagination' }
  | { type: 'landmarks' }
  | { type: 'serp'; field: 'title' | 'description' }
  | { type: 'head'; aspect: HeadAspect }
  | { type: 'net'; mode: 'types' | 'origins' }
  | { type: 'coverage'; which: 'js' | 'css' }
  | { type: 'render-blocking' }
  | { type: 'sec-headers' }
  | { type: 'schema' }
  | { type: 'site-graph' };

/**
 * Map a finding message to the visual evidence it can carry. Regexes mirror
 * the wording matched by the verifier checkers (live-verifier / finding-
 * verifier) for the same kinds. Order matters: "Image links without alt text"
 * must resolve to missing-alt, not empty-anchor.
 */
/**
 * True when a fix-recommendation `example` is a natural-language guidance
 * sentence rather than a code sample, so the report renders it as text instead
 * of a misleading ```html fence. Conservative — anything with markup or code
 * structure (`<tags>`, braces, semicolons, assignments, newlines) is treated as
 * code. Validated against the full fix catalog: flags exactly the prose entries
 * and no real code example.
 */
export function looksLikeProseExample(example: string): boolean {
  const t = example.trim();
  return /^[A-Z].*\.$/.test(t) && !/[<\n{};=]/.test(t) && t.split(/\s+/).length >= 4;
}

export function evidenceKindFor(message: string): EvidenceKind | null {
  const t = message.toLowerCase();
  if (/\balt (text|attribute)\b/.test(t) && /(without|missing|no\b|empty)/.test(t)) return { type: 'overlay', kind: 'missing-alt' };
  if (/\bcls\b|layout shift/.test(t)) return { type: 'cls' };
  if (/\btitles?\b/.test(t) && /(too long|too short|missing|empty|duplicat)/.test(t)) return { type: 'serp', field: 'title' };
  if (/\bdescriptions?\b/.test(t) && /(too long|too short|missing|empty|duplicat)/.test(t)) return { type: 'serp', field: 'description' };
  if (/image/.test(t) && /(larger than (their|the).*display|significantly larger)/.test(t)) return { type: 'overlay', kind: 'oversized-image' };
  if (/(jpg|png).*(webp|avif)|webp\/avif|images only as/.test(t)) return { type: 'overlay', kind: 'legacy-image-format' };
  if (/empty anchor|links? with empty|links? without (any )?text/.test(t)) return { type: 'overlay', kind: 'empty-anchor' };
  if (/more than one h1|multiple h1/.test(t)) return { type: 'overlay', kind: 'multiple-h1' };
  if (/touch targets?/.test(t)) return { type: 'overlay', kind: 'small-touch-target' };
  if (/interstitial|popup/.test(t)) return { type: 'overlay', kind: 'interstitial' };
  if (/conversion elements/.test(t)) return { type: 'overlay', kind: 'cta-fold' };
  if (/contrast/.test(t)) return { type: 'overlay', kind: 'contrast' };
  // Data panels — must run before the head-snippet arms ("render-blocking
  // third-party scripts" should hit the render-blocking panel, not net).
  if (/render.?blocking/.test(t)) return { type: 'render-blocking' };
  if (/unused css/.test(t)) return { type: 'coverage', which: 'css' };
  if (/unused (code|javascript|js)/.test(t)) return { type: 'coverage', which: 'js' };
  if (/third.?party|advertis|heavy ads|ad scripts?/.test(t)) return { type: 'net', mode: 'origins' };
  if (/too many requests|size is too big|page.*too (big|large)|total transfer/.test(t)) return { type: 'net', mode: 'types' };
  // Head snippet cards
  if (/canonical/.test(t)) return { type: 'head', aspect: 'canonical' };
  if (/noindex/.test(t)) return { type: 'head', aspect: 'noindex' };
  if (/hreflang|alternate link/.test(t)) return { type: 'head', aspect: 'hreflang' };
  if (/\blang attribute\b|\bhtml lang\b|language mismatch/.test(t)) return { type: 'head', aspect: 'lang' };
  if (/charset|character encoding/.test(t)) return { type: 'head', aspect: 'charset' };
  if (/doctype/.test(t)) return { type: 'head', aspect: 'doctype' };
  // Slice 3 — LCP highlight, JS-off pair, probe sequence, landmark overlay,
  // security-header card, schema card, link-graph facts.
  if (/\blcp\b|largest contentful/.test(t)) return { type: 'lcp' };
  if (/rendered by javascript|relies on javascript|without ssr\b/.test(t)) return { type: 'nojs' };
  if (/pagination/.test(t)) return { type: 'pagination' };
  if (/form inputs? .*missing labels?|inputs?.*missing labels|placeholder used instead of label/.test(t))
    return { type: 'overlay', kind: 'form-label' };
  if (/autocomplete/.test(t)) return { type: 'overlay', kind: 'autocomplete' };
  // \bmain\b deliberately — must not catch "mainEntity" (FAQPage schema finding).
  if (/missing.*\bmain\b|<main>|role="main"|\bmain\b.*landmark/.test(t)) return { type: 'landmarks' };
  // No aggregate "security headers" finding exists — analyzers emit per-header
  // messages ("Missing Permissions-Policy header", …). The card lists ALL
  // headers missing on the sampled page, which evidences any of them.
  if (
    /security headers?|missing.*(permissions-policy|x-frame-options|content-security-policy|strict-transport-security|x-content-type-options|referrer-policy)|cross-origin isolation/.test(
      t,
    )
  )
    return { type: 'sec-headers' };
  if (/schema|structured data|json-?ld|faqpage|mainentity|videoobject|breadcrumb|howto\b/.test(t)) return { type: 'schema' };
  if (/orphan|link equity|unreachable|click depth|sitemap/.test(t)) return { type: 'site-graph' };
  return null;
}

const KIND_CAPTIONS: Record<string, string> = {
  'missing-alt': 'Images without alt text',
  'oversized-image': 'Images much larger than their display size',
  'legacy-image-format': 'JPG/PNG images without a WebP/AVIF variant',
  'empty-anchor': 'Links without anchor text',
  'multiple-h1': 'Multiple H1 headings',
  'small-touch-target': 'Touch targets below 48×48px',
  interstitial: 'Intrusive overlay',
  'cta-fold': 'First call-to-action relative to the fold',
  contrast: 'Color-contrast failures (axe-core)',
};

/** First example among `shown` whose page was sampled for evidence. */
function firstSampledRef(shown: string[], screenshots: ScreenshotIndex): ScreenshotRef | undefined {
  for (const ex of shown) {
    const url = extractFirstUrl(ex);
    if (!url) continue;
    const found = screenshots.get(normalizeUrlForEvidence(url));
    if (found) return found;
  }
  return undefined;
}

interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EvidenceBox {
  rect: OverlayRect;
  label?: string;
  /** Render as a dashed "previous position" outline (CLS before-rect). */
  ghost?: boolean;
}

/**
 * Pick the crop window for a set of highlight rects: full document width (the
 * mobile doc is viewport-wide anyway), vertically spanning as many rects as fit
 * in ~1.5 viewport heights starting from the topmost one. Keeps the annotated
 * view readable instead of squeezing a 20 000px page into 360px.
 */
function cropWindowFor(
  items: OverlayItem[],
  doc: { width: number; height: number },
  viewport: { width: number; height: number },
): { window: CropWindow; visible: OverlayItem[]; hiddenCount: number } {
  const sorted = [...items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const maxH = Math.max(viewport.height * 1.5, 600);
  const startY = sorted[0].rect.y;
  let visible = sorted.filter((i) => i.rect.y + i.rect.height <= startY + maxH);
  if (visible.length === 0) visible = [sorted[0]];
  const pad = 24;
  const minY = Math.max(0, Math.min(...visible.map((i) => i.rect.y)) - pad);
  const maxY = Math.min(doc.height, Math.max(...visible.map((i) => i.rect.y + i.rect.height)) + pad);
  return {
    window: { x: 0, y: minY, width: doc.width, height: Math.max(1, maxY - minY) },
    visible,
    hiddenCount: items.length - visible.length,
  };
}

const pctOf = (n: number, base: number): string => ((n / base) * 100).toFixed(3);

/**
 * An annotated figure: the full-page screenshot CSS-cropped to `win` (pure
 * CSS — an aspect-ratio wrapper with the img absolutely positioned at negative
 * offsets, no image processing), with highlight boxes %-positioned within the
 * window.
 *
 * Geometry invariants (all in DOCUMENT CSS px, the space the rects were
 * measured in):
 *   • Every vertical percentage (img top/height, box top/height) resolves
 *     against the wrapper height; every horizontal one against the wrapper
 *     width — one shared base per axis, so borders/box-sizing cancel out.
 *   • The img gets EXPLICIT width AND height, never `height:auto`: a full-page
 *     capture can be wider than document.scrollWidth (scrollbar gutter — hence
 *     `shot.width`), and deriving height from the bitmap aspect would skew
 *     every vertical position by that difference. Height is doc-based: the
 *     bitmap's rows span the document regardless of its pixel count.
 */
function annotatedFigureHtml(
  src: string,
  url: string,
  win: CropWindow,
  doc: { width: number; height: number },
  boxes: EvidenceBox[],
  caption: string,
  foldY?: number,
  shot?: { width: number },
): string {
  const sw = shot?.width ?? doc.width;
  const lines: string[] = ['<figure class="evidence-annotated">'];
  // Cap the rendered height (~640px) so a tall crop window never exceeds a PDF
  // page; width follows from the window's aspect ratio, capped near 1:1 CSS px.
  const renderW = Math.min(420, Math.round((640 * win.width) / win.height));
  lines.push(`<div class="ev-crop" style="aspect-ratio: ${win.width} / ${win.height}; width:${renderW}px;">`);
  lines.push(
    `<img src="${src}" alt="Annotated screenshot of ${escapeHtmlAttr(url)}" ` +
      `style="position:absolute;left:-${pctOf(win.x, win.width)}%;top:-${pctOf(win.y, win.height)}%;` +
      `width:${pctOf(sw, win.width)}%;height:${pctOf(doc.height, win.height)}%;max-width:none;max-height:none;margin:0;" />`,
  );
  for (const box of boxes) {
    const left = ((box.rect.x - win.x) / win.width) * 100;
    const top = ((box.rect.y - win.y) / win.height) * 100;
    const w = (box.rect.width / win.width) * 100;
    const h = (box.rect.height / win.height) * 100;
    if (left > 100 || top > 100 || left + w < 0 || top + h < 0) continue; // outside the window
    const cls = box.ghost ? 'ev-box ev-ghost' : 'ev-box';
    const label = box.label && !box.ghost ? `<span class="ev-label">${escapeHtmlAttr(box.label)}</span>` : '';
    lines.push(
      `<span class="${cls}" style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${w.toFixed(3)}%;height:${h.toFixed(3)}%;">${label}</span>`,
    );
  }
  if (foldY !== undefined && foldY > win.y && foldY < win.y + win.height) {
    lines.push(
      `<span class="ev-fold" style="top:${pctOf(foldY - win.y, win.height)}%;"><span class="ev-fold-label">fold</span></span>`,
    );
  }
  lines.push('</div>');
  lines.push(`<figcaption>${escapeHtmlAttr(caption)}</figcaption>`);
  lines.push('</figure>');
  return lines.join('\n');
}

/** Annotated screenshot for an overlay kind. Null when the data is absent. */
function buildAnnotatedBlock(ref: ScreenshotRef, kind: string): string | null {
  const ov = ref.overlays;
  if (!ov || !ref.mobile) return null;
  const items = ov.kinds?.[kind];
  if (!items || items.length === 0) return null;
  const { window: win, visible, hiddenCount } = cropWindowFor(items, ov.document, ov.viewport);
  const boxes: EvidenceBox[] = visible.map((i) => ({ rect: i.rect, label: i.label }));
  const suffix = hiddenCount > 0 ? ` (+${hiddenCount} more outside this view)` : '';
  const caption = `${KIND_CAPTIONS[kind] ?? 'Issue locations'} — ${ref.url}${suffix}`;
  const foldY = kind === 'cta-fold' ? ov.viewport.height : undefined;
  return ['**Screenshot**', '', annotatedFigureHtml(ref.mobile, ref.url, win, ov.document, boxes, caption, foldY, ov.shot)].join('\n');
}

/**
 * CLS before/after pair: the first-load viewport shot next to the settled
 * shot cropped to the same viewport window, with each shifted element's
 * previous position (dashed ghost) and final position (solid box) drawn on.
 * Shift rects are viewport coordinates at shift time; shifts happen at scroll
 * 0, where they coincide with document coordinates on the full-page shot.
 */
function buildClsPairBlock(ref: ScreenshotRef): string | null {
  const ov = ref.overlays;
  const cls = ov?.cls;
  if (!ov || !cls || cls.shifts.length === 0 || !ref.mobile) return null;
  const win: CropWindow = { x: 0, y: 0, width: ov.viewport.width, height: ov.viewport.height };
  const boxes: EvidenceBox[] = [];
  for (const s of cls.shifts) {
    const label = (s.selector ?? s.node ?? undefined)?.slice(0, 40);
    if (s.previousRect) boxes.push({ rect: s.previousRect, ghost: true });
    if (s.currentRect) boxes.push({ rect: s.currentRect, label });
  }
  const lines: string[] = ['**Screenshot — layout shift**', '', '<div class="evidence-pair">'];
  if (ref.firstload) {
    lines.push(
      `<figure><img src="${ref.firstload}" alt="First load of ${escapeHtmlAttr(ref.url)}" /><figcaption>On load</figcaption></figure>`,
    );
  }
  lines.push(
    annotatedFigureHtml(
      ref.mobile,
      ref.url,
      win,
      ov.document,
      boxes,
      `After layout shifts — CLS ${cls.value} (dashed = position before the shift)`,
      undefined,
      ov.shot,
    ),
  );
  lines.push('</div>');
  return lines.join('\n');
}

/**
 * SERP-style preview for title/description findings on a sampled page: the
 * snippet as a search engine would render it, with the overflow past the
 * truncation point struck out and a one-line note quantifying the problem.
 */
function buildSerpCard(ref: ScreenshotRef, field: 'title' | 'description', message: string): string | null {
  const meta = ref.overlays?.pageMeta;
  if (!meta) return null;
  const t = message.toLowerCase();
  const value = field === 'title' ? meta.title : meta.description;
  const max = field === 'title' ? THRESHOLDS.TITLE_MAX : THRESHOLDS.DESCRIPTION_MAX;
  const min = field === 'title' ? THRESHOLDS.TITLE_MIN : THRESHOLDS.DESCRIPTION_MIN;

  // The note must match the claim — a "too long" finding with a short sampled
  // value means the sampled page isn't representative; skip rather than confuse.
  let note: string;
  if (/too long/.test(t)) {
    if (value.length <= max) return null;
    note = `This ${field} is ${value.length} characters — search engines truncate at ~${max}.`;
  } else if (/too short/.test(t)) {
    if (value.length === 0 || value.length >= min) return null;
    note = `This ${field} is ${value.length} characters — below the recommended minimum of ${min}.`;
  } else if (/duplicat/.test(t)) {
    if (value.length === 0) return null;
    note = `This exact ${field} appears on multiple pages — each page competes for the same snippet.`;
  } else {
    // missing/empty
    if (value.length > 0) return null;
    note = `No ${field === 'title' ? 'title' : 'meta description'} — search engines will generate their own snippet.`;
  }

  let host: string;
  let crumbs = '';
  try {
    const u = new URL(ref.url);
    host = u.hostname;
    crumbs = u.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => ` › ${s}`)
      .join('');
  } catch {
    host = ref.url;
  }

  const esc = escapeHtmlAttr;
  const titleHtml =
    meta.title.length === 0
      ? `<span class="serp-missing">(no title — URL shown instead)</span>`
      : field === 'title' && meta.title.length > max
        ? `${esc(meta.title.slice(0, max))}<span class="serp-overflow">${esc(meta.title.slice(max))}</span>`
        : esc(meta.title);
  const descHtml =
    meta.description.length === 0
      ? `<span class="serp-missing">(no meta description — snippet auto-generated from page text)</span>`
      : field === 'description' && meta.description.length > max
        ? `${esc(meta.description.slice(0, max))}<span class="serp-overflow">${esc(meta.description.slice(max))}</span>`
        : esc(meta.description);

  return [
    '**Search preview**',
    '',
    '<div class="serp-preview">',
    `<div class="serp-url">${esc(host)}${esc(crumbs)}</div>`,
    `<div class="serp-title">${titleHtml}</div>`,
    `<div class="serp-desc">${descHtml}</div>`,
    `<div class="serp-note">${esc(note)}</div>`,
    '</div>',
  ].join('\n');
}

/**
 * Head snippet card: a reconstructed `<head>` excerpt for the sampled page
 * with the offending line flagged — or, when the element is missing, a
 * flagged "missing:" comment where it should be. Honesty guard: a finding
 * claiming X is missing renders nothing when the sampled page HAS X (the
 * sampled page isn't representative of that finding).
 */
function buildHeadSnippetCard(ref: ScreenshotRef, aspect: HeadAspect, message: string): string | null {
  const head = ref.overlays?.head;
  const meta = ref.overlays?.pageMeta;
  if (!head) return null;
  const t = message.toLowerCase();
  const esc = escapeHtmlAttr;
  const missingClaim = /not set|missing|no\b|lacks|don'?t have|without/.test(t);

  interface HeadLine {
    html: string;
    state?: 'flag' | 'missing';
  }
  const trunc = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines: HeadLine[] = [];
  const langAttr = head.htmlLang ? ` lang="${esc(head.htmlLang)}"` : '';
  lines.push({ html: `&lt;html${langAttr}&gt;`, state: aspect === 'lang' ? (head.htmlLang ? 'flag' : undefined) : undefined });
  if (aspect === 'lang' && !head.htmlLang) lines.push({ html: `&lt;!-- missing: lang attribute on &lt;html&gt; --&gt;`, state: 'missing' });
  lines.push({ html: `&nbsp;&nbsp;&lt;head&gt;` });
  const push = (html: string, state?: 'flag' | 'missing') => lines.push({ html: `&nbsp;&nbsp;&nbsp;&nbsp;${html}`, state });

  if (head.charset) push(`&lt;meta charset="${esc(head.charset)}"&gt;`, aspect === 'charset' ? 'flag' : undefined);
  else if (aspect === 'charset') push(`&lt;!-- missing: &lt;meta charset="utf-8"&gt; --&gt;`, 'missing');

  if (meta?.title) push(`&lt;title&gt;${esc(trunc(meta.title, 60))}&lt;/title&gt;`);

  if (head.canonical) push(`&lt;link rel="canonical" href="${esc(trunc(head.canonical))}"&gt;`, aspect === 'canonical' ? 'flag' : undefined);
  else if (aspect === 'canonical') push(`&lt;!-- missing: &lt;link rel="canonical" href="…"&gt; --&gt;`, 'missing');

  if (head.metaRobots) push(`&lt;meta name="robots" content="${esc(trunc(head.metaRobots, 60))}"&gt;`, aspect === 'noindex' ? 'flag' : undefined);

  if (aspect === 'hreflang') {
    for (const h of head.hreflangs.slice(0, 6)) {
      push(`&lt;link rel="alternate" hreflang="${esc(h.lang)}" href="${esc(trunc(h.href, 70))}"&gt;`, 'flag');
    }
    if (head.hreflangs.length === 0) push(`&lt;!-- missing: &lt;link rel="alternate" hreflang="…"&gt; --&gt;`, 'missing');
  }
  if (aspect === 'doctype' && !head.hasDoctype) {
    lines.unshift({ html: `&lt;!-- missing: &lt;!DOCTYPE html&gt; --&gt;`, state: 'missing' });
  }
  lines.push({ html: `&nbsp;&nbsp;&lt;/head&gt;` });

  // Honesty guards per aspect — skip the card when the sampled page
  // contradicts the claim; the generic screenshot fallback applies instead.
  switch (aspect) {
    case 'canonical':
      if (missingClaim && head.canonical) return null;
      break;
    case 'noindex':
      if (!head.metaRobots || !/noindex/i.test(head.metaRobots)) return null; // header-based noindex isn't visible here
      break;
    case 'hreflang':
      if (missingClaim && head.hreflangs.length > 0) return null;
      break;
    case 'lang':
      if (missingClaim && head.htmlLang) return null;
      break;
    case 'charset':
      if (missingClaim && head.charset) return null;
      break;
    case 'doctype':
      if (head.hasDoctype) return null;
      break;
  }

  const body = lines
    .map((l) => {
      const cls = l.state === 'flag' ? ' class="line-flag"' : l.state === 'missing' ? ' class="line-missing"' : '';
      return `<span${cls}>${l.html}</span>`;
    })
    .join('\n');
  return [
    '**Page head**',
    '',
    '<div class="code-card">',
    `<div class="code-card-title">&lt;head&gt; of ${esc(ref.url)}</div>`,
    `<pre class="code-card-pre">${body}</pre>`,
    '</div>',
  ].join('\n');
}

/** A labelled horizontal bar row for the data panels (pure CSS, PDF-safe). */
function barRow(name: string, bytes: number, maxBytes: number, sub: string, flagged = false): string {
  const pct = maxBytes > 0 ? Math.max(1, Math.round((bytes / maxBytes) * 100)) : 1;
  const cls = flagged ? 'bar-fill bar-flag' : 'bar-fill';
  return (
    `<div class="bar-row"><span class="bar-name">${escapeHtmlAttr(name)}</span>` +
    `<span class="bar-track"><span class="${cls}" style="width:${pct}%"></span></span>` +
    `<span class="bar-sub">${escapeHtmlAttr(sub)}</span></div>`
  );
}

/**
 * Network panel from the sampled page's request log: transfer broken down by
 * resource type ('types') or by origin with third-party flagged ('origins').
 */
function buildNetPanel(ref: ScreenshotRef, mode: 'types' | 'origins'): string | null {
  const net = ref.netSummary;
  if (!net || net.totalRequests === 0) return null;
  const rows: string[] = [];
  if (mode === 'types') {
    const max = net.byType[0]?.bytes ?? 0;
    for (const t of net.byType.slice(0, 8)) {
      rows.push(barRow(t.type, t.bytes, max, `${formatBytes(t.bytes)} · ${t.count} req`));
    }
  } else {
    const max = net.byHost[0]?.bytes ?? 0;
    for (const h of net.byHost) {
      rows.push(barRow(h.thirdParty ? `${h.host} (3rd-party)` : h.host, h.bytes, max, `${formatBytes(h.bytes)} · ${h.count} req`, h.thirdParty));
    }
  }
  const headline =
    mode === 'origins'
      ? `${net.totalRequests} requests · ${formatBytes(net.totalBytes)} — third-party: ${net.thirdPartyCount} req / ${formatBytes(net.thirdPartyBytes)}`
      : `${net.totalRequests} requests · ${formatBytes(net.totalBytes)} transferred`;
  return [
    '**Network breakdown**',
    '',
    '<div class="data-panel">',
    `<div class="data-panel-title">${escapeHtmlAttr(`${headline} — ${ref.url}`)}</div>`,
    ...rows,
    '</div>',
  ].join('\n');
}

/** Per-file unused-bytes bars from the persisted CDP coverage summary. */
function buildCoveragePanel(ref: ScreenshotRef, which: 'js' | 'css'): string | null {
  const cov = ref.overlays?.panels?.coverage?.[which];
  if (!cov || cov.total === 0) return null;
  const pct = Math.round((cov.unused / cov.total) * 100);
  const rows = cov.files.map((f) => {
    let name = f.url;
    try {
      const u = new URL(f.url);
      name = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
    } catch {
      // keep raw
    }
    return barRow(name, f.unused, cov.total, `${formatBytes(f.unused)} unused (${f.unusedPercent}%)`, f.unusedPercent > 50);
  });
  return [
    '**Unused code**',
    '',
    '<div class="data-panel">',
    `<div class="data-panel-title">${escapeHtmlAttr(
      `Unused ${which.toUpperCase()}: ${formatBytes(cov.unused)} of ${formatBytes(cov.total)} (${pct}%) — ${ref.url}`,
    )}</div>`,
    ...rows,
    '</div>',
  ].join('\n');
}

/** Render-blocking head resources measured at capture time. */
function buildRenderBlockingPanel(ref: ScreenshotRef): string | null {
  const list = ref.overlays?.panels?.renderBlocking;
  if (!list || list.length === 0) return null;
  const rows = list.map((r) => {
    let name = r.url;
    try {
      const u = new URL(r.url, ref.url);
      name = `${u.hostname}${u.pathname}`;
    } catch {
      // keep raw
    }
    return `<div class="bar-row"><span class="rb-chip rb-${r.kind}">${r.kind}</span><span class="bar-name bar-name-wide">${escapeHtmlAttr(name.length > 90 ? `${name.slice(0, 90)}…` : name)}</span></div>`;
  });
  return [
    '**Render-blocking resources**',
    '',
    '<div class="data-panel">',
    `<div class="data-panel-title">${escapeHtmlAttr(`${list.length} render-blocking resource(s) in <head> — ${ref.url}`)}</div>`,
    ...rows,
    '</div>',
  ].join('\n');
}

/**
 * LCP evidence: the LCP element highlighted on the settled shot plus a
 * sub-parts breakdown (TTFB / resource delay / resource load / render delay).
 */
function buildLcpBlock(ref: ScreenshotRef): string | null {
  const ov = ref.overlays;
  const lcp = ov?.lcp;
  if (!ov || !lcp) return null;
  const parts: string[] = [];
  if (lcp.rect && ref.mobile) {
    const win: CropWindow = { x: 0, y: 0, width: ov.viewport.width, height: ov.viewport.height };
    const label = `LCP element — ${(lcp.value / 1000).toFixed(2)}s${lcp.selector ? ` (${lcp.selector.slice(0, 40)})` : ''}`;
    parts.push(
      annotatedFigureHtml(
        ref.mobile,
        ref.url,
        win,
        ov.document,
        [{ rect: lcp.rect, label }],
        `Largest Contentful Paint element — ${ref.url}`,
        undefined,
        ov.shot,
      ),
    );
  }
  if (lcp.subParts) {
    const sp = lcp.subParts;
    const rows: Array<[string, number]> = [
      ['TTFB', sp.ttfb],
      ['Resource delay', sp.resourceDelay],
      ['Resource load', sp.resourceLoad],
      ['Render delay', sp.renderDelay],
    ];
    const max = Math.max(...rows.map(([, v]) => v), 1);
    parts.push(
      [
        '<div class="data-panel">',
        `<div class="data-panel-title">${escapeHtmlAttr(`LCP ${(lcp.value / 1000).toFixed(2)}s — where the time went`)}</div>`,
        ...rows.map(([name, v]) => barRow(name, v, max, `${Math.round(v)}ms`, v === max)),
        '</div>',
      ].join('\n'),
    );
  }
  if (parts.length === 0) return null;
  return ['**LCP evidence**', '', ...parts].join('\n');
}

/**
 * JS-off vs hydrated pair — what crawlers that don't execute JavaScript see
 * next to what users get. The starker the difference, the stronger the finding.
 */
function buildNojsPair(ref: ScreenshotRef): string | null {
  if (!ref.nojs) return null;
  const hydrated = ref.firstload ?? ref.mobile;
  if (!hydrated) return null;
  const esc = escapeHtmlAttr(ref.url);
  return [
    '**Screenshot — without JavaScript**',
    '',
    '<div class="evidence-pair">',
    `<figure><img src="${ref.nojs}" alt="JavaScript disabled — ${esc}" /><figcaption>JavaScript disabled (what most crawlers see)</figcaption></figure>`,
    `<figure><img src="${hydrated}" alt="Hydrated — ${esc}" /><figcaption>JavaScript enabled</figcaption></figure>`,
    '</div>',
  ].join('\n');
}

/**
 * Pagination-probe step sequence: the listing as loaded vs after clicking
 * "next" — content empties/duplicates while the control stays enabled.
 */
function buildPaginationSequence(shown: string[], probes: ProbeIndex): { block: string; probeUrl: string } | null {
  if (probes.size === 0) return null;
  let probe: ProbeShots | undefined;
  for (const ex of shown) {
    for (const url of extractAllUrls(ex)) {
      probe = probes.get(normalizeUrlForEvidence(url));
      if (probe) break;
    }
    if (probe) break;
  }
  // A report usually carries one probed series; if exactly one probe exists,
  // use it even when the finding's example cites a sibling page of the series.
  if (!probe && probes.size === 1) probe = [...probes.values()][0];
  if (!probe || probe.steps.length === 0) return null;
  const captions: Record<string, string> = {
    'step-0-initial': 'Page as loaded',
    'step-1-after-first-click': 'After clicking “next” once',
  };
  const figures = probe.steps.map((s) => {
    const caption = captions[s.name] ?? `After ${s.name.match(/\d+/g)?.pop() ?? 'more'} clicks — “next” still enabled`;
    return `<figure><img src="${s.src}" alt="${escapeHtmlAttr(`${caption} — ${probe!.url}`)}" /><figcaption>${escapeHtmlAttr(caption)}</figcaption></figure>`;
  });
  return {
    block: ['**Screenshot — pagination probe**', '', '<div class="evidence-pair">', ...figures, '</div>'].join('\n'),
    probeUrl: probe.url,
  };
}

/**
 * Landmark overlay for missing-<main> findings: tint the landmarks that ARE
 * present so the gap is visible. Honesty guard: skip when a <main> landmark
 * was found on the sampled page.
 */
function buildLandmarksBlock(ref: ScreenshotRef): string | null {
  const ov = ref.overlays;
  if (!ov || !ref.mobile) return null;
  const items = ov.kinds?.['landmarks'];
  if (!items || items.length === 0) return null;
  if (items.some((i) => i.label === '<main>')) return null; // claim contradicted
  const { window: win, visible, hiddenCount } = cropWindowFor(items, ov.document, ov.viewport);
  const boxes: EvidenceBox[] = visible.map((i) => ({ rect: i.rect, label: i.label }));
  const suffix = hiddenCount > 0 ? ` (+${hiddenCount} more outside this view)` : '';
  return [
    '**Screenshot**',
    '',
    annotatedFigureHtml(
      ref.mobile,
      ref.url,
      win,
      ov.document,
      boxes,
      `Landmarks present — no <main> among them — ${ref.url}${suffix}`,
      undefined,
      ov.shot,
    ),
  ].join('\n');
}

/** Security-headers card: the headers the analyzer found missing, listed ✗. */
function buildSecHeadersCard(ref: ScreenshotRef): string | null {
  const missing = ref.overlays?.panels?.securityHeaders?.missing;
  if (!missing || missing.length === 0) return null;
  const rows = missing.map(
    (h) => `<div class="bar-row"><span class="hdr-miss">✗</span><span class="bar-name bar-name-wide">${escapeHtmlAttr(h)}</span></div>`,
  );
  return [
    '**Response headers**',
    '',
    '<div class="data-panel">',
    `<div class="data-panel-title">${escapeHtmlAttr(`${missing.length} security header(s) missing on ${ref.url}`)}</div>`,
    ...rows,
    '</div>',
  ].join('\n');
}

/**
 * Schema card: JSON-LD types found on the sampled page (chips) + the first
 * block truncated. Honesty guard: a "missing schema" claim with types present
 * renders nothing.
 */
function buildSchemaCard(ref: ScreenshotRef, message: string): string | null {
  const schema = ref.overlays?.schema;
  const head = ref.overlays;
  if (!head) return null;
  const t = message.toLowerCase();
  const claimsMissing = /missing schema|no structured data|lacks structured data|no schema|without schema/.test(t);
  const types = schema?.types ?? [];
  if (claimsMissing && types.length > 0) return null;
  const lines: string[] = ['**Structured data**', '', '<div class="code-card">'];
  if (types.length === 0) {
    lines.push(`<div class="code-card-title">No JSON-LD structured data found on ${escapeHtmlAttr(ref.url)}</div>`);
  } else {
    lines.push(
      `<div class="code-card-title">JSON-LD on ${escapeHtmlAttr(ref.url)}: ${types.map((ty) => `<span class="chip">${escapeHtmlAttr(ty)}</span>`).join(' ')}</div>`,
    );
  }
  if (schema?.snippet) {
    lines.push(`<pre class="code-card-pre">${escapeHtmlAttr(schema.snippet)}${schema.snippet.length >= 600 ? '…' : ''}</pre>`);
  }
  lines.push('</div>');
  return lines.join('\n');
}

/**
 * Link-graph facts for site-wide findings (orphans, link equity, sitemap
 * membership): a small per-cited-URL table of inbound-link count and sitemap
 * presence, straight from the crawl's own graph artifacts.
 */
function buildSiteGraphPanel(shown: string[], siteFacts: SiteFacts | null | undefined): string | null {
  if (!siteFacts) return null;
  const urls: string[] = [];
  for (const ex of shown) {
    for (const u of extractAllUrls(ex)) {
      if (!urls.includes(u)) urls.push(u);
      if (urls.length >= 5) break;
    }
    if (urls.length >= 5) break;
  }
  if (urls.length === 0) return null;
  const rows: string[] = [];
  for (const u of urls) {
    const k = normalizeUrlForEvidence(u);
    // incoming-links.json omits pages with no inbound links — a crawled page
    // absent from the map genuinely has 0 (the orphan case this panel exists
    // for). For URLs the crawl never saw, absence proves nothing.
    const inbound = siteFacts.inbound.get(k) ?? (siteFacts.crawled.has(k) ? 0 : undefined);
    const inSitemap = siteFacts.sitemap ? siteFacts.sitemap.has(k) : null;
    if (inbound === undefined && inSitemap !== true) continue;
    const cells = [
      `<span class="bar-name bar-name-wide">${escapeHtmlAttr(u)}</span>`,
      `<span class="bar-sub">${inbound !== undefined ? `${inbound} inbound link${inbound === 1 ? '' : 's'}` : '—'}</span>`,
      siteFacts.sitemap ? `<span class="bar-sub">${inSitemap ? 'in sitemap ✓' : 'not in sitemap ✗'}</span>` : '',
    ];
    rows.push(`<div class="bar-row">${cells.join('')}</div>`);
  }
  if (rows.length === 0) return null;
  return [
    '**Link-graph facts**',
    '',
    '<div class="data-panel">',
    `<div class="data-panel-title">From the crawl's internal link graph${siteFacts.sitemap ? ' and sitemap' : ''}</div>`,
    ...rows,
    '</div>',
  ].join('\n');
}

/**
 * Issue-aware evidence dispatcher. Tries, in order: the kind-specific visual
 * (annotated overlay / CLS pair / SERP card) for the first sampled example,
 * then the plain screenshot pair. Annotated visuals are deduped per
 * (kind, page) via namespaced keys in the same `embedded` set the plain block
 * uses (plain keys are normalized URLs, so `kind:`-prefixed tags can't collide).
 */
function buildEvidenceBlock(
  message: string,
  shown: string[],
  screenshots: ScreenshotIndex,
  embedded: Set<string>,
  probes?: ProbeIndex,
  siteFacts?: SiteFacts | null,
): string | null {
  const kind = evidenceKindFor(message);

  // Kinds that don't require the cited page to be SAMPLED: probe sequences
  // belong to the series (probe shots are their own evidence dirs) and
  // link-graph facts come from site-level artifacts.
  if (kind?.type === 'pagination' && probes) {
    const seq = buildPaginationSequence(shown, probes);
    if (seq) {
      // Dedupe keyed to the probe actually rendered — two flagged series in
      // one report each show their own sequence exactly once.
      const tag = `pagination:${normalizeUrlForEvidence(seq.probeUrl)}`;
      if (embedded.has(tag)) return null; // this series' sequence already shown
      embedded.add(tag);
      return seq.block;
    }
  }
  if (kind?.type === 'site-graph') {
    const block = buildSiteGraphPanel(shown, siteFacts);
    if (block) return block;
  }

  const ref = firstSampledRef(shown, screenshots);
  if (!ref) return null;
  if (kind && (kind.type === 'cls' || kind.type === 'overlay' || kind.type === 'lcp' || kind.type === 'landmarks' || kind.type === 'nojs')) {
    const pageKey = normalizeUrlForEvidence(ref.url);
    const tag = `${kind.type === 'overlay' ? kind.kind : kind.type}:${pageKey}`;
    const block =
      kind.type === 'cls'
        ? buildClsPairBlock(ref)
        : kind.type === 'lcp'
          ? buildLcpBlock(ref)
          : kind.type === 'landmarks'
            ? buildLandmarksBlock(ref)
            : kind.type === 'nojs'
              ? buildNojsPair(ref)
              : buildAnnotatedBlock(ref, kind.kind);
    if (block) {
      if (embedded.has(tag)) {
        return `**Screenshot**\n\nAnnotated screenshot of ${mdLink(ref.url, ref.url)} is shown above.`;
      }
      embedded.add(tag);
      embedded.add(pageKey); // later plain blocks for this page point upward
      return block;
    }
  } else if (kind && kind.type !== 'pagination' && kind.type !== 'site-graph') {
    // Image-less cards/panels — plain-screenshot dedup unaffected.
    const block =
      kind.type === 'serp'
        ? buildSerpCard(ref, kind.field, message)
        : kind.type === 'head'
          ? buildHeadSnippetCard(ref, kind.aspect, message)
          : kind.type === 'net'
            ? buildNetPanel(ref, kind.mode)
            : kind.type === 'coverage'
              ? buildCoveragePanel(ref, kind.which)
              : kind.type === 'sec-headers'
                ? buildSecHeadersCard(ref)
                : kind.type === 'schema'
                  ? buildSchemaCard(ref, message)
                  : buildRenderBlockingPanel(ref);
    if (block) return block;
  }
  // No issue-specific evidence kind matched — keyword cannibalisation, TBT,
  // missing SRI, broken outbound links, iframe counts, redirect chains, etc.
  // These are cross-page / network / header / structural claims a context-free
  // full-page screenshot can't illustrate; attaching one reads as filler ("here
  // is a screenshot" that shows nothing about the finding). Render no evidence
  // block instead. A MATCHED kind whose rich render was unavailable (old audits
  // / unsampled / --no-evidence) still degrades to the page screenshot below —
  // there the shot is at least the page the issue is on.
  if (kind === null) return null;
  return buildScreenshotBlock(shown, screenshots, embedded);
}

/**
 * All distinct real http(s) URLs in an example string, in order. Anchors render
 * the URL twice (`<a href="u">u</a>`), so de-dupe to avoid double-listing.
 * Templated series keys (`…/page/{N}`) are dropped — they aren't real pages.
 */
function extractAllUrls(s: string): string[] {
  // Strip trailing sentence/list punctuation the greedy `[^\s<>"']+` class would
  // otherwise glue onto a URL — when URLs are joined into prose ("Affected: a, b, c")
  // every URL but the last keeps a trailing comma, producing a broken link.
  return [
    ...new Set(
      (s.match(/https?:\/\/[^\s<>"']+/g) ?? [])
        .map((u) => u.replace(/[.,;:!?]+$/, ''))
        .filter((u) => !isTemplateUrl(u)),
    ),
  ];
}

/**
 * A markdown link. The destination is angle-bracketed when it contains
 * characters that would otherwise break `[text](url)` parsing (spaces or
 * parentheses), which CommonMark/`marked` allow inside `<…>`.
 */
function mdLink(label: string, href: string): string {
  const dest = /[()\s]/.test(href) ? `<${href}>` : href;
  return `[${label}](${dest})`;
}

/**
 * Render a single-page example as inline markdown, preserving the analyzer's
 * anchor as a real markdown link so the affected page stays clickable in the
 * HTML/PDF report. A plain `stripHtml` would have flattened the anchor to its
 * visible text — and analyzers often use a shortened, relative label (e.g.
 * "/company/") that `marked` cannot autolink, so the page link was lost.
 * Keeps only the lead clause (analyzers append rich HTML after the measured
 * value — a `<br>`/`<ul>` of offending files plus an inline recommendation the
 * Fix section already covers) and drops any other surviving tags.
 */
export function inlineExample(ex: string): string {
  const lead = ex.split(/<br\s*\/?>|<ul\b|<ol\b|<\/p>|\n/i)[0];
  return (
    lead
      // Literal element MENTIONS that are content, not markup (e.g. "use
      // <main>, <article>") → inline code, so they survive rather than getting
      // silently deleted ("Use semantic elements (<main>, <article>)" → "(, )").
      // Done BEFORE anchor conversion so the `<https://…>` link destinations it
      // emits are never seen here. The strict tag shape and the `(?!a\b)`
      // guard skip real `<a>` markup and `://`-bearing URLs alike.
      .replace(/<\/?(?!a\b)[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, (m) => `\`${m}\``)
      // Anchor → markdown link.
      .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) =>
        mdLink(text.trim() || href, href),
      )
      // Drop any anchor tag the conversion didn't match (e.g. missing href).
      .replace(/<\/?a\b[^>]*>/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * For a clustered example like `The title "X" is used on N pages: <links…>`,
 * return the descriptive label (the part before the first URL/anchor), with
 * HTML and a trailing colon stripped.
 */
function clusterLabel(s: string): string {
  // Stop at the first link OR the first list/break markup. Duplicate-title and
  // duplicate-description details wrap their page list in `<ul><li>`; without
  // cutting there too, the stray `<ul>`/`<li>` tags fall inside the label and
  // sanitizeProse renders them as literal inline code (`\`<ul>\`\`<li>\``).
  // Mask `<code>…</code>` spans before locating the cut: a finding can MENTION a
  // URL inside code (the broken-pagination series key is itself a full URL,
  // `<code>https://site/page/{N}</code>`), and a bare `https?://` there would
  // otherwise be mistaken for the start of the page list — yielding the label
  // "The `<code>`". Masking preserves length so the slice index stays valid.
  const masked = s.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (m) => ' '.repeat(m.length));
  const idx = masked.search(/<a\b|<ul\b|<ol\b|<li\b|<br\s*\/?>|https?:\/\//i);
  // sanitizeProse (not stripHtml) so literal element mentions in the label
  // ("Pages missing <main>") render as inline code instead of vanishing.
  return sanitizeProse(idx >= 0 ? s.slice(0, idx) : s)
    .replace(/[:\s]+$/, '')
    .trim();
}

/**
 * LLM verification pass. Returns the set of (original) finding-message keys to
 * suppress — confirmed duplicates / false positives. Empty set when disabled,
 * no API key, or on any failure, so the full deterministic set is kept.
 *
 * Every drop is logged with its reason so the suppression is auditable.
 */
async function prepareSuppression(artifacts: AuditArtifacts, options: Phase2Options): Promise<Set<string>> {
  const empty = new Set<string>();
  if (!options.llmVerify) return empty;
  if (!process.env.ANTHROPIC_API_KEY && !isClaudeCliAvailable()) {
    if (options.verbose) {
      console.warn('--llm requested but no ANTHROPIC_API_KEY and no claude CLI found; keeping all findings.');
    }
    return empty;
  }

  // Verify over the same prepared (consolidated + ranked) set the report uses.
  const entries = Object.entries(prepareDetails(artifacts));
  const findings = entries.map(([message, detail], index) => ({
    index,
    section: categorize(message),
    severity: detail.severity ?? 'medium',
    count: detail.count ?? 0,
    message: stripHtml(message),
  }));

  const drops = await verifyFindings({
    findings,
    domain: artifacts.manifest.domain,
    cacheDir: path.join(artifacts.runDir, 'cache', 'llm-verify'),
    verbose: options.verbose,
  });

  const suppressed = new Set<string>();
  for (const drop of drops) {
    const entry = entries[drop.index];
    if (!entry) continue;
    suppressed.add(entry[0]);
    console.log(`  ⊘ verify dropped (${drop.kind}): ${stripHtml(entry[0])}${drop.reason ? ` — ${drop.reason}` : ''}`);
  }
  if (suppressed.size > 0) {
    console.log(`✓ Verification pass removed ${suppressed.size} finding(s) before the final report.`);
  }
  return suppressed;
}

/**
 * The Phase 2 → Phase 3 boundary artifact (`phase2-state.json`). Captures the
 * exact render inputs the main report used — the LLM-suppression set, the
 * narrative paragraphs, the anomaly findings, and the noScore setting — so the
 * Phase 3 verify runner can re-render the verified report identically, from
 * disk alone, at any later time (standalone re-verify) without re-running the
 * LLM passes. All fields are plain JSON.
 */
export interface Phase2State {
  version: 1;
  generatedAt: string;
  /** Findings the LLM suppression pass dropped (original message keys). */
  suppressed: string[];
  /** Per-section LLM narrative paragraphs (templated prose when absent). */
  narratives: Partial<Record<Section, string | null>>;
  /** LLM anomaly findings merged into the report. */
  anomalies: Anomaly[];
  /** Whether the main report was rendered without scores (--no-score). */
  noScore: boolean;
  /** Rendered sections in order; absent ⇒ every section in default order. */
  sections?: Section[];
  /** Check groups the findings were filtered to; absent ⇒ no filter. */
  checks?: CheckName[];
  /** Preset the audit ran with; absent ⇒ "Full audit". */
  preset?: string;
}

/** Persist the {@link Phase2State} boundary artifact next to the report. */
function writePhase2State(
  runDir: string,
  suppressed: ReadonlySet<string>,
  narratives: Partial<Record<Section, string | null>>,
  anomalies: Anomaly[],
  noScore: boolean,
  selection: ReportSelection,
): void {
  const state: Phase2State = {
    version: 1,
    generatedAt: new Date().toISOString(),
    suppressed: [...suppressed],
    narratives,
    anomalies,
    noScore,
    ...(selection.sections && { sections: selection.sections }),
    ...(selection.checks && { checks: selection.checks }),
    ...(selection.preset && { preset: selection.preset }),
  };
  fs.writeFileSync(path.join(runDir, 'phase2-state.json'), JSON.stringify(state, null, 2));
}

/**
 * Generate a curated markdown + PDF report inside the run directory.
 * Writes `audit-report.md` and `audit-report.pdf` next to the existing
 * Phase 1 outputs, plus `phase2-state.json` (the explicit boundary the
 * Phase 3 verify runner re-renders from). Returns the PDF path.
 */
export async function runPhase2(runDir: string, options: Phase2Options = {}): Promise<string> {
  console.log('\n📝 Phase 2 — building curated report…');
  const artifacts = loadArtifacts(runDir);
  // Verification first — it decides which findings survive, so the narrative
  // and the rendered report both work from the suppressed set. Only the LLM
  // path is slow enough to announce (the deterministic path is sub-second).
  const suppressed = options.llmVerify
    ? await timedStep('Verifying findings (LLM)', () => prepareSuppression(artifacts, options))
    : await prepareSuppression(artifacts, options);
  // Optional LLM anomaly pass — returns [] when disabled, no API key, or no
  // evidence. Never blocks report generation. Runs in parallel with narratives;
  // each emits its own per-item progress counter (prepareNarratives /
  // detectAnomalies).
  const [narratives, rawAnomalies] = await Promise.all([
    prepareNarratives(artifacts, options, suppressed),
    options.llmFindings
      ? detectAnomalies(artifacts, {
          cacheDir: path.join(runDir, 'cache', 'llm-anomaly'),
          verbose: options.verbose,
        })
      : Promise.resolve([] as Anomaly[]),
  ]);
  // Collapse per-page anomalies into one finding per defect class BEFORE both
  // the report and the persisted Phase 2→3 state, so the verified report and
  // the live verify pass operate on the same consolidated set.
  const anomalies = consolidateAnomalies(rawAnomalies);
  const selection: ReportSelection = { sections: options.sections, checks: options.checks, preset: options.preset };
  const markdown = buildReportMarkdown(
    artifacts,
    narratives,
    anomalies,
    suppressed,
    undefined,
    undefined,
    options.noScore === true,
    selection,
  );

  const mdPath = path.join(runDir, 'audit-report.md');
  fs.writeFileSync(mdPath, markdown);

  // Phase boundary — persist the render inputs so Phase 3 (`--verify`, or a
  // later standalone re-verify) re-renders the verified report identically.
  // Best-effort: a failed state write must not fail the report itself.
  try {
    writePhase2State(runDir, suppressed, narratives, anomalies, options.noScore === true, selection);
  } catch (e: unknown) {
    console.warn('⚠️  Could not write phase2-state.json:', (e as Error).message);
  }

  const pdfPath = path.join(runDir, 'audit-report.pdf');
  await timedStep('Rendering PDF', () =>
    renderMarkdownToPdf(markdown, pdfPath, {
      title: `${artifacts.manifest.domain} — audit report`,
      // Base at the run dir (where the .md/.html/.pdf live) so the `evidence/<dir>/…`
      // image paths resolve both in the rendered PDF and in the directly-opened report.
      imageBaseDir: runDir,
    }),
  );

  return pdfPath;
}
