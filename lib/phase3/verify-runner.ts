/**
 * Phase 3 runner — verification.
 *
 * Runs AFTER Phase 2 has written the curated report and NEVER touches it.
 * Re-checks each surviving finding (live re-fetch by default; deterministic
 * disk pass with SEO_AUDIT_VERIFY_OFFLINE=1) and emits a SEPARATE
 * `audit-report.verified.{md,pdf}` plus `audit-report.refuted.md` for the
 * findings it dropped.
 *
 * The phase boundary is explicit: Phase 2 persists `phase2-state.json`
 * (suppression set, LLM narratives, anomalies, noScore) next to the report, and
 * this runner re-renders the verified report from that state — so
 * `runVerifyPhase(runDir)` is standalone and re-runnable: re-verify an audit
 * against the live site at any later time without re-crawling or re-running
 * the LLM passes. When the state file is absent (audits that predate it), the
 * verdicts are unaffected; the verified report just renders with templated
 * prose, no anomaly findings, and no LLM suppression.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { CrawlProfile } from '../types';
import { renderMarkdownToPdf } from '../reports/pdf-renderer';
import {
  loadArtifacts,
  preparedDetails,
  buildReportMarkdown,
  sanitizeProse,
  stripHtml,
  type Phase2State,
} from '../phase2/phase2-runner';
import type { AuditArtifacts } from '../phase2/types';
import type { Section } from '../phase2/categorize';
import type { Anomaly } from '../phase2/llm-anomaly';
import {
  loadAllPages,
  loadSiteData,
  verifyDetails,
  collectUncheckedContexts,
  buildSiteAggregate,
  firstExample,
} from './finding-verifier';
import {
  llmVerifyFindings,
  claudeCliVerifyFindings,
  isClaudeCliAvailable,
  llmVerifyFindingsVision,
  type LlmVerifyItem,
  type VisionVerifyItem,
} from './llm-finding-verify';
import {
  verifyReportLive,
  liveSignalsSnapshot,
  captureAnomalyEvidence,
  type Throttle,
  type LiveVerdict,
  type VerdictReason,
  type LiveSignals,
} from './live-verifier';

export interface VerifyPhaseOptions {
  /** Surface API/cache errors and per-finding verdict logs. */
  verbose?: boolean;
  /** Override the persisted render setting (defaults to what Phase 2 used). */
  noScore?: boolean;
}

/**
 * The render inputs the verified report is built from — the persisted Phase 2
 * state resolved against the caller's options.
 */
interface ResolvedState {
  narratives: Partial<Record<Section, string | null>>;
  anomalies: Anomaly[];
  suppressed: ReadonlySet<string>;
  noScore: boolean;
  verbose: boolean;
}

/**
 * Read the Phase 2 → Phase 3 boundary artifact (`phase2-state.json`). Returns
 * null when absent (audits that predate it) or unreadable — the caller then
 * verifies over the unsuppressed finding set with templated prose.
 */
export function loadPhase2State(runDir: string): Phase2State | null {
  const file = path.join(runDir, 'phase2-state.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Phase2State;
    // A future-versioned (or shape-invalid) state file degrades to the same
    // documented fallback as an absent one, rather than misrendering.
    if (parsed.version !== 1 || !Array.isArray(parsed.suppressed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Verification phase (`--verify`). Standalone entry point: everything it needs
 * is on disk (Phase 1 artifacts + Phase 2 report + `phase2-state.json`), so it
 * can re-verify an existing audit at any time:
 *
 *   npx tsx -e "import {runVerifyPhase} from './lib/phase3/verify-runner'; runVerifyPhase('<runDir>',{verbose:true})"
 *
 * Two implementations, both feeding a SEPARATE `audit-report.verified.*`
 * (the Phase 2 originals are never touched):
 *   • Live re-fetch (default) — parses `audit-report.md`, re-fetches each
 *     CRITICAL/HIGH/MEDIUM finding's first example, re-asserts the claim
 *     against the current page.
 *   • Deterministic disk pass (SEO_AUDIT_VERIFY_OFFLINE=1) — re-checks each
 *     finding against the crawl data on disk; reproducible, no network.
 *
 * Confirmed findings are labelled (✓ Verified, or ✓ Verified (AI)); refuted
 * ones are dropped into `audit-report.refuted.md`; the rest stay *unverified*.
 *
 * Returns the verified PDF path, or null when there's nothing to verify.
 */
export async function runVerifyPhase(runDir: string, options: VerifyPhaseOptions = {}): Promise<string | null> {
  const artifacts = loadArtifacts(runDir);
  const persisted = loadPhase2State(runDir);
  if (!persisted) {
    console.log(
      '⚠️  phase2-state.json not found — verifying over the unsuppressed finding set (templated prose, no anomaly findings).',
    );
  }
  const state: ResolvedState = {
    narratives: (persisted?.narratives ?? {}) as Partial<Record<Section, string | null>>,
    anomalies: (persisted?.anomalies ?? []) as Anomaly[],
    suppressed: new Set(persisted?.suppressed ?? []),
    noScore: options.noScore ?? persisted?.noScore ?? false,
    verbose: options.verbose === true,
  };

  // Live re-fetch verification (default). Set SEO_AUDIT_VERIFY_OFFLINE=1 to use
  // the legacy deterministic disk pass (reproducible, no network) instead.
  if (process.env.SEO_AUDIT_VERIFY_OFFLINE !== '1') {
    return await runLiveVerification(artifacts, state);
  }
  return await runOfflineVerification(artifacts, state);
}

/**
 * Load externally-supplied verdicts for the verify phase, if present. Lets a
 * Claude session (Claude Code, a spawned subagent) verify the unchecked
 * findings and drop the answers in `<runDir>/verify-verdicts.json` — no API key.
 * Shape: `{ "findings": [ { "key": "<finding message>", "verdict":
 * "confirmed"|"refuted"|"unsure", "reason": "..." } ] }`. Returns null when
 * absent or malformed (the run then falls back to the API path / skips).
 */
function loadInjectedVerdicts(runDir: string): Map<string, { verdict: string; reason: string }> | null {
  const file = path.join(runDir, 'verify-verdicts.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      findings?: Array<{ key?: unknown; verdict?: unknown; reason?: unknown }>;
    };
    if (!Array.isArray(parsed.findings)) return null;
    const out = new Map<string, { verdict: string; reason: string }>();
    for (const f of parsed.findings) {
      if (typeof f.key !== 'string') continue;
      const verdict = f.verdict === 'confirmed' || f.verdict === 'refuted' ? f.verdict : 'unsure';
      out.set(f.key, { verdict, reason: typeof f.reason === 'string' ? f.reason : '' });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic disk-pass verification (SEO_AUDIT_VERIFY_OFFLINE=1). Two
 * stages, both feeding the SEPARATE `audit-report.verified.*`:
 *   1. Deterministic — re-checks each surviving finding's first example against
 *      the crawl data; drops the ones the data contradicts (logged).
 *   2. LLM fallback — reasons over the cited page's evidence for the findings
 *      the deterministic pass left `unchecked` (injected verdicts, the API, or
 *      the keyless `claude` CLI), returning confirmed / refuted / unsure.
 *
 * Returns the verified PDF path, or null when there's nothing to verify.
 */
async function runOfflineVerification(artifacts: AuditArtifacts, state: ResolvedState): Promise<string | null> {
  const pages = loadAllPages(artifacts.runDir);
  if (pages.size === 0) {
    console.log('⚠️  Verification skipped: no per-page data on disk to verify against.');
    return null;
  }

  // Stage 1 — deterministic. Verify over exactly the set the main report
  // rendered (post LLM-suppression). `loadSiteData` adds the link graph + robots
  // + sitemap (from incoming-links/metadata) so site-level findings are checkable.
  const baseDetails = preparedDetails(artifacts, state.suppressed);
  const site = loadSiteData(artifacts.runDir, pages) ?? undefined;
  const summary = verifyDetails(baseDetails, pages, site);
  for (const message of summary.refuted) {
    const result = summary.results.get(message);
    console.log(`  ✗ verify refuted: ${stripHtml(message)} — ${result?.reason ?? 'contradicted by crawl data'}`);
  }

  // Stage 2 — LLM fallback over the still-unchecked findings. Verdicts come from
  // EITHER an injected `verify-verdicts.json` (so a Claude session — Claude Code,
  // a subagent — can supply judgments with no API key) OR a live API call when
  // `ANTHROPIC_API_KEY` is set. Injection wins when present.
  const aiConfirmed = new Set<string>();
  const contexts = collectUncheckedContexts(baseDetails, summary.results, pages);
  const injected = loadInjectedVerdicts(artifacts.runDir);
  let verdictByKey = new Map<string, { verdict: string; reason: string }>();

  if (injected) {
    verdictByKey = injected;
    console.log(`  … applying ${injected.size} injected verdict(s) from verify-verdicts.json (no API key needed)`);
  } else if (contexts.length > 0 && (process.env.ANTHROPIC_API_KEY || isClaudeCliAvailable())) {
    // Prefer the API when a key is set (fastest, parallel); otherwise spawn the
    // Claude CLI so the LLM pass still runs with no key. Both share the same
    // payload, parsing, and verdict-merge below.
    const items = contexts.map((c, i) => ({
      index: i,
      message: c.message,
      example: c.example,
      pageUrl: c.pageUrl,
      signals: c.signals,
    }));
    const llmOpts = {
      cacheDir: path.join(artifacts.runDir, 'cache', 'llm-finding-verify'),
      verbose: state.verbose,
      siteContext: buildSiteAggregate(pages),
    };
    const useApi = !!process.env.ANTHROPIC_API_KEY;
    console.log(
      `  … ${useApi ? 'LLM-verifying' : 'verifying via Claude CLI (no API key)'} ${contexts.length} finding(s) the deterministic pass could not check`,
    );
    const verdicts = useApi ? await llmVerifyFindings(items, llmOpts) : await claudeCliVerifyFindings(items, llmOpts);
    for (const v of verdicts) {
      const ctx = contexts[v.index];
      if (ctx) verdictByKey.set(ctx.key, { verdict: v.verdict, reason: v.reason });
    }
  } else if (state.verbose) {
    console.warn('--verify: no verify-verdicts.json, no ANTHROPIC_API_KEY, and no Claude CLI; skipping LLM fallback.');
  }

  // The LLM may only UPGRADE a finding to confirmed — it never drops. LLM
  // judgment over partial evidence is too uncertain to silently remove a real
  // finding; only the deterministic pass (exact data) auto-drops. An LLM
  // "refuted" is surfaced as a disputed note, not a deletion.
  let aiDisputed = 0;
  for (const c of contexts) {
    const v = verdictByKey.get(c.key);
    if (!v) continue;
    if (v.verdict === 'confirmed') {
      aiConfirmed.add(c.key);
    } else if (v.verdict === 'refuted') {
      aiDisputed++;
      console.log(`  ⚠ AI disputes (kept, not dropped): ${c.message}${v.reason ? ` — ${v.reason}` : ''}`);
    }
  }

  const combinedSuppressed = new Set<string>([...state.suppressed, ...summary.refuted]);
  const dataConfirmed = summary.confirmedCount;
  const dropped = summary.refutedCount;
  const remainingUnverified = summary.uncheckedCount - aiConfirmed.size;
  const total = dataConfirmed + summary.refutedCount + summary.uncheckedCount;
  const aiNote = aiConfirmed.size > 0 ? ` + ${aiConfirmed.size} AI-confirmed` : '';
  const disputeNote = aiDisputed > 0 ? `, ${aiDisputed} AI-disputed (kept)` : '';
  console.log(
    `✓ Verification: ${dataConfirmed} confirmed (data)${aiNote}, ${dropped} auto-removed${disputeNote}, ${remainingUnverified} unverified (of ${total}).`,
  );

  const banner =
    `> **✓ Verification pass.** Each issue's first concrete example was re-checked — first against the crawl data, ` +
    `then (where that was inconclusive) by an LLM reviewing the page's evidence. ` +
    `**${dataConfirmed} confirmed from data**${aiConfirmed.size > 0 ? `, **${aiConfirmed.size} confirmed by AI review**` : ''}, ` +
    `**${dropped} auto-removed** as false positives, ${remainingUnverified} still *unverified* (insufficient evidence to decide — not a defect). ` +
    `The AI review only adds confirmations; it never drops a finding. Each issue below carries its status.\n`;

  const markdown = buildReportMarkdown(
    artifacts,
    state.narratives,
    state.anomalies,
    combinedSuppressed,
    { confirmed: summary.confirmed, aiConfirmed },
    banner,
    state.noScore,
  );

  const mdPath = path.join(artifacts.runDir, 'audit-report.verified.md');
  fs.writeFileSync(mdPath, markdown);

  const pdfPath = path.join(artifacts.runDir, 'audit-report.verified.pdf');
  await renderMarkdownToPdf(markdown, pdfPath, {
    title: `${artifacts.manifest.domain} — verified audit report`,
    imageBaseDir: artifacts.runDir,
  });
  console.log(`📄 Verified report: ${pdfPath}`);

  // Capture the deterministically-dropped findings in a separate report. Use the
  // verifier's own worst-first example selector so the URL shown is the one the
  // pass actually cross-checked.
  const refutedEntries: RefutedEntry[] = [...summary.refuted].map((m) => {
    const detail = baseDetails[m];
    const res = summary.results.get(m);
    const chosen = detail ? firstExample(detail) : undefined;
    return {
      title: m,
      severity: detail?.severity,
      kind: res?.kind,
      exampleUrl: firstExampleUrl(chosen ? [chosen] : undefined),
      reason: res?.reason ?? 'contradicted by crawl data',
    };
  });
  const refutedPath = writeRefutedReport(artifacts.runDir, artifacts.manifest.domain, 'data', refutedEntries);
  if (refutedPath) console.log(`📄 Refuted findings (dropped): ${refutedPath}`);

  return pdfPath;
}

/**
 * Convert a recorded {@link CrawlProfile} (single selected conditions) to a live
 * {@link Throttle}. Returns undefined for a no-perf or no-throttle crawl. Pure
 * (no IO) so the producer→consumer shape is unit-testable.
 */
export function crawlProfileToThrottle(p: CrawlProfile | null | undefined): Throttle | undefined {
  if (!p?.perf) return undefined;
  const t: Throttle = {};
  if (p.network && !p.network.noThrottle && (p.network.download ?? 0) > 0) {
    t.downloadBps = p.network.download;
    t.uploadBps = p.network.upload;
    t.latencyMs = p.network.latency;
  }
  if (p.cpu && !p.cpu.noThrottle && (p.cpu.rate ?? 1) > 1) t.cpuRate = p.cpu.rate;
  return t.downloadBps || t.cpuRate ? t : undefined;
}

/**
 * Read the crawl's throttle profile from `metadata.json.gz` (written when the
 * crawl ran with `--perf`) into a {@link Throttle} for the live pass, so perf
 * signals are measured under the same network/CPU conditions. Returns undefined
 * (unthrottled — matching a default crawl) when absent or unreadable.
 */
function loadCrawlThrottle(runDir: string): Throttle | undefined {
  try {
    const file = path.join(runDir, 'metadata.json.gz');
    if (!fs.existsSync(file)) return undefined;
    const meta = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as {
      crawlProfile?: CrawlProfile | null;
    };
    return crawlProfileToThrottle(meta.crawlProfile);
  } catch {
    return undefined;
  }
}

/** Human labels for the verdict reason codes, used in the verified report's
 *  "unverified breakdown" line so each category reads in plain language. */
const REASON_LABELS: Record<VerdictReason, string> = {
  confirmed: 'confirmed',
  refuted: 'refuted',
  'no-checker': 'no live checker for the kind',
  'no-example': 'no example URL cited',
  unreachable: 'page unreachable',
  'under-observable': 'under-observable at load',
  'load-dependent': 'load-dependent network aggregate',
  volatile: 'volatile signal',
  'site-level': 'site-level / cross-page',
  'plural-undersampled': 'plural finding undersampled',
  'llm-unsure': 'LLM could not decide',
  inconclusive: 'inconclusive',
};

/**
 * A blockquote line breaking the `unverified` C/H/M verdicts down by reason code,
 * most-common first — so the report distinguishes "we checked hard and can't
 * decide" from "we never tried." Returns '' when nothing was unverified.
 */
export function verdictBreakdownLine(verdicts: LiveVerdict[]): string {
  const byCode = new Map<VerdictReason, number>();
  for (const v of verdicts)
    if (v.status === 'unverified') byCode.set(v.reasonCode, (byCode.get(v.reasonCode) ?? 0) + 1);
  if (byCode.size === 0) return '';
  // State the unverified COUNT against the total explicitly ("15 of the 45").
  // Without it a reader saw only "of the 45 live-checked" followed by reasons
  // summing to 15 and read it as broken arithmetic — the missing 30 were the
  // confirmed/refuted findings, which by definition aren't part of an
  // "unverified" breakdown. (The main banner's much larger unverified count is a
  // different, full-finding-set basis, not this CRITICAL/HIGH/MEDIUM subset.)
  const unverifiedCount = [...byCode.values()].reduce((a, b) => a + b, 0);
  const parts = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c, n]) => `${n} ${REASON_LABELS[c] ?? c}`);
  return `> **Why findings are unverified** (${unverifiedCount} of the ${verdicts.length} live-checked CRITICAL/HIGH/MEDIUM findings remain unverified): ${parts.join(', ')}. None of these are defects — each is a deliberate non-decision.\n`;
}

/** First real http(s) URL across a finding's example strings (skips templated
 *  `{N}` series keys), or undefined. Examples may be markdown/HTML or bare URLs. */
export function firstExampleUrl(examples: string[] | undefined): string | undefined {
  for (const ex of examples ?? []) {
    for (const url of ex.match(/https?:\/\/[^\s)\]<>"']+/g) ?? []) {
      // Strip trailing sentence punctuation a bare URL in prose can pick up
      // ("…available at https://e.com/x." → drop the period).
      if (!/[{}]/.test(url)) return url.replace(/[.,;:]+$/, '');
    }
  }
  return undefined;
}

/** One dropped finding, for the refuted-findings report. */
export interface RefutedEntry {
  title: string;
  severity?: string;
  /** Live checker kind that drove the refute (live pass only). */
  kind?: string;
  /** The example URL / signal that was re-checked. */
  exampleUrl?: string;
  /** Why it was dropped (the verdict's reason). */
  reason: string;
}

/**
 * Write the findings the verification pass DROPPED to a separate
 * `audit-report.refuted.md`. These never appear in the verified report (they
 * were refuted — already-fixed or analyzer false positives), but they're worth
 * keeping: a recurring refute is a candidate analyzer bug. Returns the path, or
 * null when nothing was refuted (no empty file is written).
 */
export function writeRefutedReport(
  runDir: string,
  domain: string,
  mode: 'live' | 'data',
  entries: RefutedEntry[],
): string | null {
  if (entries.length === 0) return null;
  const stamp = `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const intro =
    mode === 'live'
      ? `> **Refuted by the live verification pass** (${stamp}). Each issue below was in the audit report, but a live re-fetch of its first example **contradicted the claim**, so it was DROPPED from \`audit-report.verified.md\`. These are likely already-fixed issues or analyzer false positives. The live site can change, so this reflects a point in time.`
      : `> **Refuted by the deterministic verification pass.** Each issue below was in the audit report, but the crawl data on disk **contradicted the claim**, so it was DROPPED from \`audit-report.verified.md\`. These are candidate analyzer false positives worth investigating.`;
  const lines: string[] = [
    `# ${domain} — refuted findings`,
    '',
    intro,
    '',
    `**${entries.length} finding(s) dropped.**`,
    '',
  ];
  for (const e of entries) {
    lines.push(`## ${stripHtml(e.title)}`, '');
    const meta = [e.severity ? e.severity.toUpperCase() : null, e.kind ? `kind: \`${e.kind}\`` : null]
      .filter(Boolean)
      .join(' · ');
    if (meta) lines.push(meta, '');
    // The live pass re-fetches a specific URL; the data pass cross-checks crawl
    // data on disk, so call the URL an "Example" there rather than "Re-checked".
    if (e.exampleUrl) lines.push(`- **${mode === 'live' ? 'Re-checked' : 'Example'}:** ${e.exampleUrl}`);
    lines.push(`- **Why dropped:** ${stripHtml(e.reason)}`, '');
  }
  const mdPath = path.join(runDir, 'audit-report.refuted.md');
  fs.writeFileSync(mdPath, lines.join('\n'));
  return mdPath;
}

/**
 * Live verification (default). Parses the report Phase 2 wrote
 * (`audit-report.md`), takes each CRITICAL/HIGH/MEDIUM finding's first
 * concrete example, RE-FETCHES that page live, and re-asserts the claim against
 * the current page. Confirmed → ✓ Verified; refuted → dropped (no longer true /
 * false positive); the rest stay *unverified* (site-level, cross-page, or
 * needing instrumentation a single light load can't provide).
 *
 * Non-deterministic by nature — the verified report reflects the live site at a
 * point in time, so the banner is timestamped. The legacy deterministic disk
 * pass is still available via SEO_AUDIT_VERIFY_OFFLINE=1.
 */
/**
 * Slice 3 — LLM stage for the LIVE pass. Over the findings the deterministic
 * live checkers left `unverified` (and which the live pass actually fetched a
 * page for), package each with the FRESH live signals and ask the LLM whether
 * the claim holds. Verdicts come from EITHER an injected `verify-verdicts.json`
 * (no key) OR the API (`ANTHROPIC_API_KEY`) OR the keyless `claude` CLI — same
 * priority as the offline pass.
 *
 * Caution preserved exactly as offline: the LLM may only UPGRADE a finding to
 * confirmed (rendered `✓ Verified (AI)`). An LLM "refuted" is surfaced as a
 * kept-but-flagged AI-dispute (logged), NEVER a drop — LLM judgment over partial
 * evidence is too uncertain to silently remove a finding.
 *
 * Returns the set of finding MESSAGES the LLM confirmed, plus the dispute count.
 */
async function runLiveLlmStage(
  verdicts: LiveVerdict[],
  signalsByUrl: Map<string, LiveSignals | null>,
  titleToMessage: Map<string, string>,
  decided: ReadonlySet<string>,
  runDir: string,
  verbose: boolean,
): Promise<{ aiConfirmed: Set<string>; aiDisputed: number }> {
  const aiConfirmed = new Set<string>();
  let aiDisputed = 0;

  // Build one LLM item per still-unverified finding that has a fetched page with
  // signals (no signals → nothing for the model to reason over → skip).
  const items: LlmVerifyItem[] = [];
  const keyByIndex: string[] = [];
  for (const v of verdicts) {
    if (v.status !== 'unverified' || !v.exampleUrl) continue;
    const message = titleToMessage.get(v.title) ?? titleToMessage.get(sanitizeProse(v.title));
    if (!message || decided.has(message)) continue;
    const signals = signalsByUrl.get(v.exampleUrl);
    if (!signals) continue; // page wasn't fetched / didn't load → no evidence to send
    if (keyByIndex.includes(message)) continue; // one item per message
    const index = items.length;
    items.push({ index, message, example: v.exampleUrl, pageUrl: v.exampleUrl, signals: liveSignalsSnapshot(signals) });
    keyByIndex.push(message);
  }

  const injected = loadInjectedVerdicts(runDir);
  const verdictByIndex = new Map<number, { verdict: string; reason: string }>();

  if (injected) {
    for (let i = 0; i < keyByIndex.length; i++) {
      const v = injected.get(keyByIndex[i]);
      if (v) verdictByIndex.set(i, v);
    }
    if (verdictByIndex.size > 0)
      console.log(
        `  … applying ${verdictByIndex.size} injected verdict(s) from verify-verdicts.json (no API key needed)`,
      );
  } else if (items.length > 0 && (process.env.ANTHROPIC_API_KEY || isClaudeCliAvailable())) {
    const llmOpts = { cacheDir: path.join(runDir, 'cache', 'llm-finding-verify-live'), verbose };
    const useApi = !!process.env.ANTHROPIC_API_KEY;
    console.log(
      `  … ${useApi ? 'LLM-verifying' : 'verifying via Claude CLI (no API key)'} ${items.length} unverified finding(s) against fresh live signals`,
    );
    const llmVerdicts = useApi
      ? await llmVerifyFindings(items, llmOpts)
      : await claudeCliVerifyFindings(items, llmOpts);
    for (const lv of llmVerdicts) verdictByIndex.set(lv.index, { verdict: lv.verdict, reason: lv.reason });
  } else if (verbose) {
    console.warn(
      '--verify (live): no verify-verdicts.json, no ANTHROPIC_API_KEY, and no Claude CLI; skipping the live LLM stage.',
    );
  }

  for (let i = 0; i < keyByIndex.length; i++) {
    const v = verdictByIndex.get(i);
    if (!v) continue;
    if (v.verdict === 'confirmed') aiConfirmed.add(keyByIndex[i]);
    else if (v.verdict === 'refuted') {
      aiDisputed++;
      console.log(
        `  ⚠ AI disputes (kept, not dropped): ${stripHtml(keyByIndex[i])}${v.reason ? ` — ${v.reason}` : ''}`,
      );
    }
  }

  return { aiConfirmed, aiDisputed };
}

/**
 * Slice 4 — vision verification of AI-discovered (anomaly) findings. Each
 * anomaly's cited page is re-fetched and screenshotted; the LLM is asked whether
 * the emergent UX/layout bug still manifests. Vision runs on the API transport;
 * the keyless CLI falls back to signals-only (text), and an injected
 * verify-verdicts.json (keyed by the anomaly title) wins over both — same
 * priority as every other LLM stage.
 *
 * Caution preserved: the LLM may only UPGRADE an anomaly to confirmed (rendered
 * `✓ Verified (AI)`); a refute is a kept-but-flagged dispute, NEVER a drop.
 * Returns the set of anomaly TITLES confirmed, plus the dispute count.
 */
async function verifyAnomaliesLive(
  anomalies: Anomaly[],
  throttle: Throttle | undefined,
  runDir: string,
  verbose: boolean,
): Promise<{ aiConfirmed: Set<string>; aiDisputed: number }> {
  const aiConfirmed = new Set<string>();
  let aiDisputed = 0;
  const withUrl = anomalies.filter((a) => /^https?:\/\//.test(a.url));
  if (withUrl.length === 0) return { aiConfirmed, aiDisputed };

  console.log(
    `🖼️  Live verification: re-checking ${withUrl.length} AI-discovered finding(s) against fresh screenshots…`,
  );
  const evidence = await captureAnomalyEvidence(
    withUrl.map((a) => a.url),
    { throttle, verbose },
  );

  // Signals each transport sees (the CLI path is text-only — no screenshot).
  const signalsFor = (a: Anomaly): Record<string, unknown> => {
    const e = evidence.get(a.url);
    return { status: e?.status ?? 0, finalUrl: e?.finalUrl ?? a.url, section: a.section, originalEvidence: a.evidence };
  };
  const titleByIndex = withUrl.map((a) => a.title);

  const injected = loadInjectedVerdicts(runDir);
  const verdictByIndex = new Map<number, { verdict: string; reason: string }>();

  if (injected) {
    for (let i = 0; i < withUrl.length; i++) {
      const v = injected.get(withUrl[i].title);
      if (v) verdictByIndex.set(i, v);
    }
    if (verdictByIndex.size > 0)
      console.log(`  … applying ${verdictByIndex.size} injected anomaly verdict(s) from verify-verdicts.json`);
  } else if (process.env.ANTHROPIC_API_KEY) {
    const items: VisionVerifyItem[] = withUrl.map((a, index) => {
      const shot = evidence.get(a.url)?.screenshot;
      return {
        index,
        message: a.title,
        example: `${a.evidence} — ${a.url}`,
        pageUrl: a.url,
        signals: signalsFor(a),
        image: shot ? { data: shot, mediaType: 'image/png' } : null,
      };
    });
    console.log(`  … vision-verifying ${items.length} AI-discovered finding(s) via the API`);
    for (const lv of await llmVerifyFindingsVision(items, {
      cacheDir: path.join(runDir, 'cache', 'llm-anomaly-verify'),
      verbose,
    }))
      verdictByIndex.set(lv.index, { verdict: lv.verdict, reason: lv.reason });
  } else if (isClaudeCliAvailable()) {
    // Keyless CLI: text-only (no screenshot), so it judges on signals + the
    // original evidence text. Reuses the standard batched verify transport.
    const items: LlmVerifyItem[] = withUrl.map((a, index) => ({
      index,
      message: a.title,
      example: `${a.evidence} — ${a.url}`,
      pageUrl: a.url,
      signals: signalsFor(a),
    }));
    console.log(`  … verifying ${items.length} AI-discovered finding(s) via Claude CLI (signals-only, no screenshot)`);
    for (const lv of await claudeCliVerifyFindings(items, {
      cacheDir: path.join(runDir, 'cache', 'llm-anomaly-verify'),
      verbose,
    }))
      verdictByIndex.set(lv.index, { verdict: lv.verdict, reason: lv.reason });
  } else if (verbose) {
    console.warn('--verify (live): no key and no Claude CLI; skipping AI-discovered finding verification.');
  }

  for (let i = 0; i < titleByIndex.length; i++) {
    const v = verdictByIndex.get(i);
    if (!v) continue;
    if (v.verdict === 'confirmed') aiConfirmed.add(titleByIndex[i]);
    else if (v.verdict === 'refuted') {
      aiDisputed++;
      console.log(
        `  ⚠ AI disputes its own earlier finding (kept, not dropped): ${stripHtml(titleByIndex[i])}${v.reason ? ` — ${v.reason}` : ''}`,
      );
    }
  }
  return { aiConfirmed, aiDisputed };
}

async function runLiveVerification(artifacts: AuditArtifacts, state: ResolvedState): Promise<string | null> {
  const reportPath = path.join(artifacts.runDir, 'audit-report.md');
  if (!fs.existsSync(reportPath)) {
    console.log('⚠️  Live verification skipped: audit-report.md not found.');
    return null;
  }
  const reportMd = fs.readFileSync(reportPath, 'utf8');

  // Match the crawl's network/CPU throttle (recorded in metadata when the crawl
  // ran with --perf) so live perf signals (TTFB/CLS/TBT) are comparable.
  const throttle = loadCrawlThrottle(artifacts.runDir);

  // Persisted full-crawl link/sitemap graph: lets the live pass adjudicate
  // orphan / unreachable / click-depth / low-link-equity / sitemap-membership
  // findings against the WHOLE crawl instead of a bounded 120-page live BFS
  // (which left them `unverified` on large sites). Undefined → live BFS fallback.
  const siteData = loadSiteData(artifacts.runDir, loadAllPages(artifacts.runDir)) ?? undefined;

  console.log("🔎 Live verification: re-fetching each finding's example(s) and re-asserting the claim…");
  const { verdicts, signalsByUrl } = await verifyReportLive(reportMd, { verbose: state.verbose, throttle, siteData });

  // Map parsed report titles → in-memory finding messages. The renderer emits
  // `### ${sanitizeProse(message)}`, so a parsed title equals
  // sanitizeProse(message); match on that to build the render's VerifyView.
  const baseDetails = preparedDetails(artifacts, state.suppressed);
  const titleToMessage = new Map<string, string>();
  for (const message of Object.keys(baseDetails)) {
    const key = sanitizeProse(message);
    if (!titleToMessage.has(key)) titleToMessage.set(key, message);
  }

  const confirmed = new Set<string>();
  const refutedMessages = new Set<string>();
  // Keep the refuting verdict per dropped message so the refuted report can show
  // its severity / kind / example / reason.
  const refutedByMessage = new Map<string, LiveVerdict>();
  for (const v of verdicts) {
    const message = titleToMessage.get(v.title) ?? titleToMessage.get(sanitizeProse(v.title));
    if (message) {
      if (v.status === 'confirmed') confirmed.add(message);
      else if (v.status === 'refuted') {
        refutedMessages.add(message);
        refutedByMessage.set(message, v);
      }
    }

    if (v.status === 'refuted' && message)
      console.log(`  ✗ live refuted (dropped): ${stripHtml(v.title)} — ${v.reason}`);
    else if (v.status === 'refuted')
      console.log(`  · live refuted but unmatched (kept): ${stripHtml(v.title)} — ${v.reason}`);
    else if (state.verbose)
      console.log(`  ${v.status === 'confirmed' ? '✓' : '·'} live ${v.status}: ${stripHtml(v.title)} — ${v.reason}`);
  }

  // Confirm wins over refute on a title collision: if two distinct findings
  // collapse to the same sanitizeProse key, never let a stray refute DROP a
  // message another verdict confirmed. Keeps the two sets disjoint so the
  // counts below can't double-count one message.
  for (const m of confirmed) refutedMessages.delete(m);

  // Slice 3 — LLM stage over the still-unverified findings, using the fresh live
  // signals captured above. Only upgrades to confirmed (✓ Verified (AI)); an LLM
  // refute is a kept-but-flagged dispute, never a drop. Findings the
  // deterministic pass already decided are excluded.
  const decided = new Set<string>([...confirmed, ...refutedMessages]);
  const llmStage = await runLiveLlmStage(
    verdicts,
    signalsByUrl,
    titleToMessage,
    decided,
    artifacts.runDir,
    state.verbose,
  );
  // aiConfirmed is the RENDERING set (badges); it grows to include anomaly titles.
  const aiConfirmed = new Set<string>(llmStage.aiConfirmed);
  let aiDisputed = llmStage.aiDisputed;
  // Only baseDetails-derived AI confirmations count toward the renderedTotal
  // identity below — anomaly findings render from state.anomalies and are NOT in
  // baseDetails, so subtracting them would corrupt the unverified tally.
  const findingAiConfirmedCount = llmStage.aiConfirmed.size;

  // Slice 4 — vision verification of AI-discovered (anomaly) findings.
  if (state.anomalies.length > 0) {
    const anomalyStage = await verifyAnomaliesLive(state.anomalies, throttle, artifacts.runDir, state.verbose);
    for (const title of anomalyStage.aiConfirmed) aiConfirmed.add(title);
    aiDisputed += anomalyStage.aiDisputed;
  }

  // Count over the FULL rendered set so the banner reconciles with the badges.
  // buildReportMarkdown labels every rendered finding (all severities — LOW and
  // unmatched included): confirmed → ✓ Verified, AI-confirmed → ✓ Verified (AI),
  // everything else → unverified, refuted → dropped. So total = all prepared
  // findings; unverified is the remainder after confirmed + ai-confirmed +
  // refuted. (Mirrors the disk pass, whose total is also over baseDetails.)
  const confirmedCount = confirmed.size;
  const refutedCount = refutedMessages.size;
  const renderedTotal = Object.keys(baseDetails).length;
  const unverifiedCount = Math.max(0, renderedTotal - confirmedCount - refutedCount - findingAiConfirmedCount);

  const aiNote = aiConfirmed.size > 0 ? ` + ${aiConfirmed.size} AI-confirmed` : '';
  const disputeNote = aiDisputed > 0 ? `, ${aiDisputed} AI-disputed (kept)` : '';
  console.log(
    `✓ Live verification: ${confirmedCount} confirmed${aiNote}, ${refutedCount} refuted (dropped)${disputeNote}, ${unverifiedCount} unverified (of ${renderedTotal}; ${verdicts.length} CRITICAL/HIGH/MEDIUM findings parsed).`,
  );

  const stamp = `${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const banner =
    `> **🔎 Live verification pass.** Each CRITICAL/HIGH/MEDIUM issue's example(s) were **re-fetched live** ` +
    `(${stamp}) and its claim re-checked against the current page — not the crawl-time snapshot. ` +
    `**${confirmedCount} confirmed**${aiConfirmed.size > 0 ? `, **${aiConfirmed.size} confirmed by AI review**` : ''}, **${refutedCount} refuted** (dropped as no-longer-true / false positive), ` +
    `${unverifiedCount} *unverified* — i.e. lower-severity findings (not live-checked), site-level / cross-page claims, multi-page findings whose other pages weren't sampled, or those needing instrumentation a single live load can't provide (not a defect). ` +
    `The AI review only adds confirmations; it never drops a finding. ` +
    `Because the live site can change, this report reflects a point in time. Each issue below carries its status.\n` +
    verdictBreakdownLine(verdicts);

  const combinedSuppressed = new Set<string>([...state.suppressed, ...refutedMessages]);
  const markdown = buildReportMarkdown(
    artifacts,
    state.narratives,
    state.anomalies,
    combinedSuppressed,
    { confirmed, aiConfirmed },
    banner,
    state.noScore,
  );

  const mdPath = path.join(artifacts.runDir, 'audit-report.verified.md');
  fs.writeFileSync(mdPath, markdown);

  const pdfPath = path.join(artifacts.runDir, 'audit-report.verified.pdf');
  await renderMarkdownToPdf(markdown, pdfPath, {
    title: `${artifacts.manifest.domain} — verified audit report (live)`,
    imageBaseDir: artifacts.runDir,
  });
  console.log(`📄 Verified report (live): ${pdfPath}`);

  // Capture the dropped findings in a separate report (candidate false positives).
  const refutedEntries: RefutedEntry[] = [...refutedMessages].map((m) => {
    const v = refutedByMessage.get(m);
    return {
      title: v?.title ?? m,
      severity: v?.severity,
      kind: v?.kind,
      exampleUrl: v?.exampleUrl,
      reason: v?.reason ?? 'contradicted by the live page',
    };
  });
  const refutedPath = writeRefutedReport(artifacts.runDir, artifacts.manifest.domain, 'live', refutedEntries);
  if (refutedPath) console.log(`📄 Refuted findings (dropped): ${refutedPath}`);

  return pdfPath;
}
