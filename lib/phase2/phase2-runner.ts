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

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SCORING } from '../constants';
import { renderMarkdownToPdf } from '../reports/pdf-renderer';
import { ScoreCalculator } from '../scoring/score-calculator';
import { classifyIssue, isCataloguedErrorTier } from '../scoring/seo-catalog';
import { nextjsOverrideFor, isNextjsAudit } from '../scoring/nextjs-recommendations';
import type { FixRecommendation } from '../types';
import { normalizeMessage as _normalizeMessage, normalizeMessageForLookup } from '../utils/finding-id';
import { categorize, type Section } from './categorize';
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

/** Cap for the compact "Minor & informational" list at the end of a section. */
const MINOR_FINDING_LIMIT = 10;

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
  return impactScore(b[0], b[1]) - impactScore(a[0], a[1]);
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
  return (b.impactScore ?? 0) - (a.impactScore ?? 0);
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

/** Prepared details with verification suppression already applied. */
function preparedDetails(artifacts: AuditArtifacts, suppressed: ReadonlySet<string>): Record<string, IssueDetail> {
  return applySuppression(prepareDetails(artifacts), suppressed);
}

/** Drop HTML tags from analyzer details so the markdown stays clean. */
function stripHtml(s: string): string {
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
  return s
    // Unwrap anchors to their inner text (usually the URL itself).
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    // Surviving tag-like mentions are content, not markup — render literally.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, (m) => `\`${m}\``)
    .replace(/\s+/g, ' ')
    .trim();
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
 * Fold LLM-discovered anomalies into the section buckets as synthetic
 * findings, tagged `aiDiscovered` so the report can label them and so they're
 * never confused with deterministic results. Re-sorts the touched sections by
 * impact. No-op when `anomalies` is empty.
 */
function mergeAnomalies(buckets: Record<Section, Array<[string, IssueDetail]>>, anomalies: Anomaly[]): void {
  const touched = new Set<Section>();
  for (const a of anomalies) {
    const detail: IssueDetail = {
      severity: a.severity,
      count: 1,
      // Self-describing example: the evidence the model cited + the page it saw.
      examples: [`${a.evidence} — ${a.url}`],
      aiDiscovered: true,
      recommendation: a.recommendation,
    };
    buckets[a.section].push([a.title, detail]);
    touched.add(a.section);
  }
  for (const sec of touched) buckets[sec].sort(byImportance);
}

// ─── Section builders ───────────────────────────────────────────────────────

function buildCover(artifacts: AuditArtifacts): string {
  const { manifest, metadata } = artifacts;
  const date = new Date(manifest.created).toISOString().slice(0, 10);
  const sitemapCount = metadata.sitemaps?.total;
  const ok = manifest.progress.totalWithoutError;
  const err = manifest.progress.totalWithError;
  const lines: string[] = [];
  lines.push(`# Website Technical Audit`);
  lines.push('');
  lines.push(`## ${manifest.domain}`);
  lines.push('');
  lines.push(`**Generated:** ${date}  `);
  // Avoid the confusing "354 of 314" framing — crawled count includes pages
  // discovered outside the sitemap. Report each number plainly.
  const crawledLine = err > 0 ? `${ok} crawled, ${err} errored` : `${ok} crawled`;
  const sitemapLine = sitemapCount ? ` (sitemap listed ${sitemapCount})` : '';
  lines.push(`**Pages:** ${crawledLine}${sitemapLine}  `);
  if (metadata.isMultiLang) lines.push(`**Multilingual:** yes  `);
  lines.push('');
  return lines.join('\n');
}

function buildPurpose(artifacts: AuditArtifacts): string {
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
    'Each category section header shows the current 0–100 score and, where there is room to improve, the score we would expect once that category’s issues are addressed across the site (`current → ~projected`). Because a category’s findings can appear in more than one section, the projection is shown once — on the section that owns the score — while individual findings everywhere carry the rough number of points fixing them recovers in their category (`+~N pts`). These projections are estimates — the `~` is deliberate: SEO and Technical scores are direct functions of the findings, while Performance, Accessibility and Security derive from measured per-page signals (Core Web Vitals, axe-core, security headers), so a per-finding figure approximates resolving the class of problem it represents.',
    '',
  ];

  // Run-specific characteristics — gives the reader an at-a-glance picture
  // of what was actually measured for this particular audit.
  const evidence = artifacts.manifest.evidence;
  const sampledCount = evidence ? Object.keys(evidence).length : 0;
  const psiCaptured = evidence
    ? Object.values(evidence).filter((e) => e.files.some((f) => f.startsWith('psi.'))).length
    : 0;
  const axeCaptured = evidence
    ? Object.values(evidence).filter((e) => e.files.includes('axe.json')).length
    : 0;

  const stats: string[] = [];
  stats.push(`- **Pages crawled:** ${artifacts.manifest.progress.totalWithoutError}`);
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
      `*Representative-page evidence means we captured detailed diagnostics — a full network request log, an accessibility scan, and (where available) lab performance scores — for a small, structurally representative sample of pages (the homepage and a spread of section and detail pages), rather than for every page on the site. These samples ground the findings below in concrete, reproducible measurements.*`
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
function resolveQuickWin(
  q: QuickWin,
  isNextjs: boolean,
): { fix: string; example: string | undefined; lang: string } {
  const override = isNextjs ? nextjsOverrideFor(q.issue) : undefined;
  if (override) {
    return { fix: override.fix ?? q.fix, example: override.example ?? q.example, lang: 'tsx' };
  }
  return { fix: q.fix, example: q.example, lang: 'html' };
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
        `${i + 1}. ${sevSpan(d.severity)} — ${stripHtml(message)} *(${d.count} occurrence${d.count === 1 ? '' : 's'})*`,
      );
    });
    lines.push('');
  }

  // Quick wins — short effort, ordered by effortMinutes asc. Falls back to
  // deriving from `details` when scoring's quickWins list is sparse. Filter
  // before slicing so dropping an already-listed finding doesn't shrink the list.
  const richQuickwins = (summary.quickWins ?? [])
    .filter((q) => (q.effortMinutes ?? 999) <= 30 && !seen.has(summaryIdentity(q.issue)))
    .sort((a, b) => (a.effortMinutes ?? 999) - (b.effortMinutes ?? 999))
    .slice(0, 5);

  if (richQuickwins.length >= 1) {
    lines.push('### Quick Wins');
    lines.push('');
    richQuickwins.forEach((q) => {
      seen.add(summaryIdentity(q.issue));
      const rw = resolveQuickWin(q, isNextjs);
      lines.push(`- **${sanitizeProse(q.issue)}** — ${sanitizeProse(rw.fix.split('.').slice(0, 1).join('.'))}. *(effort: ${effortLevel(q.effort, q.effortMinutes)})*`);
      if (rw.example && rw.example.trim()) {
        lines.push('');
        lines.push(`  \`\`\`${rw.lang}`);
        for (const line of rw.example.trim().split('\n')) {
          lines.push(`  ${line}`);
        }
        lines.push('  ```');
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
        lines.push(`- ${sevSpan(d.severity)} **${stripHtml(message)}** *(${d.count} occurrence${d.count === 1 ? '' : 's'} — contained)*`);
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
      lines.push(`- ${sanitizeProse(q.issue)} — ${sanitizeProse(rw.fix.split('.').slice(0, 2).join('.'))}. *(effort: ${effortLevel(q.effort, q.effortMinutes)})*`);
      if (rw.example && rw.example.trim()) {
        lines.push('');
        lines.push(`  \`\`\`${rw.lang}`);
        for (const line of rw.example.trim().split('\n')) {
          lines.push(`  ${line}`);
        }
        lines.push('  ```');
      }
    });
    lines.push('');
  } else {
    // Fallback: high-severity findings with broad occurrence (systemic → real
    // engineering work). The `count > 20` gate marks them systemic, but order
    // by `byImportance` (category → severity → impact), not raw count, so an
    // SEO/performance item leads over a high-count accessibility one.
    const fallback = Object.entries(details ?? {})
      .filter(([message, d]) => {
        const sev = d.severity?.toLowerCase();
        return (sev === 'critical' || sev === 'high') && (d.count ?? 0) > 20 && !seen.has(summaryIdentity(message));
      })
      .sort(byImportance)
      .slice(0, 5);
    if (fallback.length > 0) {
      lines.push('### Long-term Recommendations');
      lines.push('');
      fallback.forEach(([message, d]) => {
        seen.add(summaryIdentity(message));
        lines.push(`- ${sevSpan(d.severity)} **${stripHtml(message)}** *(${d.count} occurrences — systemic)*`);
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
function buildFindingBlock(
  message: string,
  detail: IssueDetail,
  isNextjs = false,
  sourceMapping?: Record<string, SourceLocation[]> | null,
  impact?: ScoreImpact,
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
    const shown = examples.slice(0, EXAMPLES_PER_FINDING);
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
        lines.push(`- ${label || 'Shared value'}`);
        for (const u of urls.slice(0, PAGES_PER_CLUSTER)) lines.push(`    - ${u}`);
        if (urls.length > PAGES_PER_CLUSTER) {
          lines.push(`    - *…and ${urls.length - PAGES_PER_CLUSTER} more page${urls.length - PAGES_PER_CLUSTER === 1 ? '' : 's'}*`);
        }
      } else {
        // Single-page example. When the analyzer attached a measured value
        // ("… has 8 render-blocking resources", "… 73% of CSS is unused"), keep
        // that lead clause so the reader sees the actual number — not just the
        // URL. Fall back to the bare URL when there's nothing else.
        const summary = exampleSummary(ex);
        const beyondUrl = summary.replace(/https?:\/\/[^\s)]+/g, '').replace(/[\s:.,;–—-]+/g, '');
        lines.push(`- ${beyondUrl.length > 0 ? summary : (urls[0] ?? summary)}`);
      }
    }
    const remaining = Math.max(0, (detail.count ?? examples.length) - shown.length);
    if (remaining > 0) {
      lines.push(`- *…and ${remaining} more affected page${remaining === 1 ? '' : 's'}*`);
    }
    lines.push('');
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
    lines.push(
      `Review the affected pages listed above and apply the standard best practice for this issue. Prioritise the pages with the highest traffic or business value first.`,
    );
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
      lines.push(`- *…and ${locations.length - WHERE_LIMIT} more file${locations.length - WHERE_LIMIT === 1 ? '' : 's'}*`);
    }
    lines.push('');
  }

  if (recommendation?.example && recommendation.example.trim()) {
    // Next.js overrides supply JSX/TSX examples; tag the fence accordingly.
    const exampleLang = isNextjs && nextjsOverrideFor(message)?.example ? 'tsx' : 'html';
    lines.push('**Example**');
    lines.push('');
    lines.push(`\`\`\`${exampleLang}`);
    for (const line of recommendation.example.trim().split('\n')) {
      lines.push(line);
    }
    lines.push('```');
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
  const lead = `The most impactful is *${stripHtml(topMsg)}*${breadth}.`;
  const others = primary
    .slice(1, 3)
    .map(([m]) => `*${stripHtml(m)}*`)
    .join(', ');
  const also = others ? ` Also notable: ${others}.` : '';
  const minorNote = minorCount > 0 ? ` ${minorCount} minor/informational note${minorCount === 1 ? '' : 's'} follow.` : '';
  return `${primary.length} notable finding${primary.length === 1 ? '' : 's'} (${severityTally(primary)}). ${lead}${also}${minorNote}`;
}

function buildSection(
  section: Section,
  items: Array<[string, IssueDetail]>,
  narrative?: string | null,
  isNextjs = false,
  sourceMapping?: Record<string, SourceLocation[]> | null,
  impact?: ScoreImpact,
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
    lines.push(buildFindingBlock(message, detail, isNextjs, sourceMapping, impact));
  }

  if (hidden.length > 0) {
    lines.push(`> *…and ${hidden.length} more lower-priority finding${hidden.length === 1 ? '' : 's'} in this section (${severityTally(hidden)}).*`);
    lines.push('');
  }

  // Minor & informational — compact one-liners, never full finding blocks.
  if (minor.length > 0) {
    const shownMinor = minor.slice(0, MINOR_FINDING_LIMIT);
    lines.push('**Minor & informational**');
    lines.push('');
    for (const [message, detail] of shownMinor) {
      const c = detail.count ?? 0;
      lines.push(`- ${stripHtml(message)}${c > 1 ? ` *(${c} pages)*` : ''}`);
    }
    if (minor.length > shownMinor.length) {
      lines.push(`- *…and ${minor.length - shownMinor.length} more*`);
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
): string {
  const isNextjs = detectNextjs(artifacts);
  const sourceMapping = artifacts.repoAnalysis?.sourceMapping ?? null;
  // One details map drives both the summary and the sections so suppression and
  // ranking stay identical across them.
  const details = preparedDetails(artifacts, suppressed);
  const buckets = bucketDetails(details);
  mergeAnomalies(buckets, anomalies);
  // Score-impact model: ties every category section and finding to the score it
  // moves. Built from the same prepared details the sections render, so the
  // annotations and the findings can never disagree.
  const impact = buildScoreImpact(artifacts.analysis.summary?.categoryScores, details);
  const parts: string[] = [];
  parts.push(buildCover(artifacts));
  parts.push(buildPurpose(artifacts));
  parts.push(buildSummary(artifacts, details, suppressed, isNextjs));
  for (const sec of SECTION_ORDER) {
    parts.push(buildSection(sec, buckets[sec], narratives[sec], isNextjs, sourceMapping, impact));
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
  if (!process.env.ANTHROPIC_API_KEY) {
    if (options.verbose) {
      console.warn('--llm-narrative requested but ANTHROPIC_API_KEY is not set; falling back to templated prose.');
    }
    return {};
  }

  // Generate prose over the same suppressed set the report will render, so the
  // narrative never references a finding that was dropped.
  const buckets = bucketDetails(preparedDetails(artifacts, suppressed));
  const cacheDir = path.join(artifacts.runDir, 'cache', 'llm-narrative');

  const out: Partial<Record<Section, string | null>> = {};
  const calls = SECTION_ORDER.map(async (section) => {
    const items = buckets[section];
    if (items.length === 0) return;
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
  });
  await Promise.all(calls);
  return out;
}

/** Pull the first http(s):// URL out of a raw example string. */
function extractFirstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : undefined;
}

/**
 * All distinct http(s) URLs in an example string, in order. Anchors render the
 * URL twice (`<a href="u">u</a>`), so de-dupe to avoid double-listing.
 */
function extractAllUrls(s: string): string[] {
  return [...new Set(s.match(/https?:\/\/[^\s<>"']+/g) ?? [])];
}

/**
 * The lead clause of a single-page example, as plain text. Analyzers often
 * append rich HTML after the measured value — a `<br>` then a `<ul>` of
 * offending files plus an inline "Recommendation:" (the report already has a
 * Fix section). We keep only the part before that markup so the bullet shows
 * the URL + the number ("… 94% of CSS is unused (946.8 KB of 1011.2 KB)")
 * without the HTML blob or a duplicated recommendation.
 */
function exampleSummary(ex: string): string {
  const lead = ex.split(/<br\s*\/?>|<ul\b|<ol\b|<\/p>|\n/i)[0];
  return stripHtml(lead);
}

/**
 * For a clustered example like `The title "X" is used on N pages: <links…>`,
 * return the descriptive label (the part before the first URL/anchor), with
 * HTML and a trailing colon stripped.
 */
function clusterLabel(s: string): string {
  const idx = s.search(/<a\b|https?:\/\//i);
  return stripHtml(idx >= 0 ? s.slice(0, idx) : s)
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
  if (!process.env.ANTHROPIC_API_KEY) {
    if (options.verbose) {
      console.warn('--llm-verify requested but ANTHROPIC_API_KEY is not set; keeping all findings.');
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
 * Generate a curated markdown + PDF report inside the run directory.
 * Writes `audit-report.md` and `audit-report.pdf` next to the existing
 * Phase 1 outputs. Returns the PDF path.
 */
export async function runPhase2(runDir: string, options: Phase2Options = {}): Promise<string> {
  const artifacts = loadArtifacts(runDir);
  // Verification first — it decides which findings survive, so the narrative
  // and the rendered report both work from the suppressed set.
  const suppressed = await prepareSuppression(artifacts, options);
  // Optional LLM anomaly pass — returns [] when disabled, no API key, or no
  // evidence. Never blocks report generation. Runs in parallel with narratives.
  const [narratives, anomalies] = await Promise.all([
    prepareNarratives(artifacts, options, suppressed),
    options.llmFindings
      ? detectAnomalies(artifacts, {
          cacheDir: path.join(runDir, 'cache', 'llm-anomaly'),
          verbose: options.verbose,
        })
      : Promise.resolve([] as Anomaly[]),
  ]);
  const markdown = buildReportMarkdown(artifacts, narratives, anomalies, suppressed);

  const mdPath = path.join(runDir, 'audit-report.md');
  fs.writeFileSync(mdPath, markdown);

  const pdfPath = path.join(runDir, 'audit-report.pdf');
  await renderMarkdownToPdf(markdown, pdfPath, {
    title: `${artifacts.manifest.domain} — audit report`,
    imageBaseDir: path.join(runDir, 'evidence'),
  });
  return pdfPath;
}
