/**
 * LLM fallback for the verification phase (`--verify` + `ANTHROPIC_API_KEY`).
 *
 * The deterministic verifier (finding-verifier.ts) can only check finding kinds
 * backed by an exact persisted signal. Everything else — judgment calls
 * ("content lacks topical focus", "over-optimized anchor text"), off-page
 * targets, or signals we don't store — is left `unchecked`. This pass hands
 * those leftover findings to Claude together with the cited page's structured
 * evidence and asks, per finding: is this TRUE for this page?
 *
 * Verdicts:
 *   • confirmed — the evidence supports the finding.
 *   • refuted   — the evidence contradicts it (a false positive).
 *   • unsure    — insufficient evidence to decide (the safe default).
 *
 * Design mirrors llm-anomaly.ts / llm-verify.ts:
 *   • No SDK dependency — vanilla HTTPS POST.
 *   • Gated on `ANTHROPIC_API_KEY`; returns [] when absent or on any failure.
 *   • Disk-cached by SHA of (model, system, batch payload) so re-runs are free.
 *   • Findings are sent in batches to bound the call count.
 *
 * Cost: structured-only (no images), batched ~10 findings/call → roughly
 * $0.01–0.03 per batch at Sonnet pricing; a typical audit is a few batches.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { callClaudeCli, isClaudeCliAvailable, extractCliResult } from '../phase2/claude-cli';
import { PhaseProgress } from '../utils/phase-progress';

// Re-export the shared CLI helpers so existing importers (phase2-runner, tests)
// keep working unchanged after the transport was hoisted to ./claude-cli.
export { isClaudeCliAvailable, extractCliResult };

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
/** Per-request timeout for the Anthropic API call (a stalled socket would
 *  otherwise hang the verify phase indefinitely). */
const LLM_API_TIMEOUT_MS = 120_000;
/** Findings per request — keeps payloads and parsing manageable. */
const BATCH_SIZE = 10;

export type LlmVerdictValue = 'confirmed' | 'refuted' | 'unsure';

/** One finding to verify, addressed by stable index within its batch. */
export interface LlmVerifyItem {
  index: number;
  message: string;
  /** The single example the report shows first (carries the cited URL/value). */
  example: string;
  /** The cited page's URL, if it is a crawled page. */
  pageUrl?: string;
  /** Compact structured evidence for the cited page (curated PageInfo slice). */
  signals: Record<string, unknown>;
}

export interface LlmVerdict {
  index: number;
  verdict: LlmVerdictValue;
  reason: string;
}

export interface LlmVerifyOptions {
  cacheDir?: string;
  model?: string;
  apiKey?: string;
  verbose?: boolean;
  /** Site-wide rollup (JSON), included once per batch so the model can verify
   *  "most/all pages lack X" and crawl-budget aggregates a single page can't. */
  siteContext?: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are a senior web-audit reviewer doing a fact-check pass. For EACH finding produced by an automated SEO/UX/accessibility analyzer, decide whether it is actually TRUE for the specific page cited, using ONLY the evidence provided (the finding text, its example, and a JSON snapshot of the page's measured signals).

Return one verdict per finding:
  • "confirmed" — the supplied evidence clearly supports the finding.
  • "refuted" — the supplied evidence clearly contradicts the finding (it is a false positive).
  • "unsure" — the evidence is insufficient to decide. This is the correct, expected answer whenever the snapshot doesn't contain what you'd need (e.g. off-page targets, subjective content-quality calls with no supporting signal). DO NOT guess.

Be strict and conservative: prefer "unsure" over a confident-but-unsupported verdict. Never confirm a finding the evidence doesn't actually show, and never refute one just because the snapshot lacks the signal.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"verdicts":[{"index":<number>,"verdict":"confirmed|refuted|unsure","reason":"<short, evidence-anchored>"}]}
Include exactly one entry per finding index you were given.`;

function buildUserPrompt(items: LlmVerifyItem[], siteContext?: Record<string, unknown>): string {
  const blocks = items.map((it) => {
    const sig = JSON.stringify(it.signals ?? {}, null, 0);
    return [
      `[${it.index}] FINDING: ${it.message}`,
      `    EXAMPLE: ${it.example}`,
      it.pageUrl ? `    PAGE: ${it.pageUrl}` : `    PAGE: (not a crawled page — likely off-site or site-level)`,
      `    SIGNALS: ${sig}`,
    ].join('\n');
  });
  const site =
    siteContext && Object.keys(siteContext).length > 0
      ? `SITE-WIDE ROLLUP (across all crawled pages — use this for "most/all pages lack X" and crawl-budget findings):\n${JSON.stringify(siteContext, null, 0)}\n\n`
      : '';
  return `${site}Verify each finding below. Return the JSON object with one verdict per index.\n\n${blocks.join('\n\n')}`;
}

function cacheKey(model: string, user: string): string {
  return crypto
    .createHash('sha256')
    .update(model)
    .update('\0')
    .update(SYSTEM_PROMPT)
    .update('\0')
    .update(user)
    .digest('hex');
}

/**
 * Parse the model's reply into validated verdicts. Pure and defensive:
 * tolerates prose/fences, keeps only known indices, normalizes unknown verdicts
 * to "unsure", de-dupes indices, returns [] on any structural problem.
 * Exported for unit testing.
 */
export function parseLlmVerdicts(raw: string, validIndices: number[]): LlmVerdict[] {
  if (!raw) return [];
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const list = (parsed as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return [];
  const valid = new Set(validIndices);
  const seen = new Set<number>();
  const out: LlmVerdict[] = [];
  for (const v of list) {
    const idx = (v as { index?: unknown })?.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || !valid.has(idx) || seen.has(idx)) continue;
    const rawVerdict = (v as { verdict?: unknown })?.verdict;
    const verdict: LlmVerdictValue =
      rawVerdict === 'confirmed' ? 'confirmed' : rawVerdict === 'refuted' ? 'refuted' : 'unsure';
    const reason =
      typeof (v as { reason?: unknown })?.reason === 'string' ? (v as { reason: string }).reason.trim() : '';
    seen.add(idx);
    out.push({ index: idx, verdict, reason: reason || verdict });
  }
  return out;
}

async function callModel(userPrompt: string, apiKey: string, model: string, verbose: boolean): Promise<string | null> {
  // Bound the request so a stalled connection can't hang the verify phase
  // forever (every other transport — CLI, CrUX — already has a timeout).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_API_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`LLM finding-verify HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (verbose) console.warn(`LLM finding-verify failed: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Verify one batch (≤BATCH_SIZE items); cached by payload hash. */
async function verifyBatch(items: LlmVerifyItem[], apiKey: string, options: LlmVerifyOptions): Promise<LlmVerdict[]> {
  const model = options.model ?? DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(items, options.siteContext);
  const validIndices = items.map((i) => i.index);
  const key = cacheKey(model, userPrompt);

  let cacheFile: string | null = null;
  if (options.cacheDir) {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      cacheFile = path.join(options.cacheDir, `${key}.json`);
      if (fs.existsSync(cacheFile)) return parseLlmVerdicts(fs.readFileSync(cacheFile, 'utf8'), validIndices);
    } catch {
      cacheFile = null;
    }
  }

  const text = await callModel(userPrompt, apiKey, model, options.verbose ?? false);
  if (!text) return [];
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, text);
    } catch {
      // best effort
    }
  }
  return parseLlmVerdicts(text, validIndices);
}

/**
 * Verify the given findings with the LLM. Returns [] on no key / no items / any
 * failure, so the caller keeps the deterministic result unchanged. Indices in
 * the returned verdicts are the same `index` values passed in.
 */
export async function llmVerifyFindings(items: LlmVerifyItem[], options: LlmVerifyOptions = {}): Promise<LlmVerdict[]> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey || items.length === 0) return [];

  const batches: LlmVerifyItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));

  const progress = new PhaseProgress('LLM verify batches', batches.length);
  const results = await Promise.all(
    batches.map((batch) =>
      verifyBatch(batch, apiKey, options).then((r) => {
        progress.tick();
        return r;
      }),
    ),
  );
  progress.done(`LLM verified ${items.length} finding(s) in ${batches.length} batch(es)`);
  return results.flat();
}

// ───────────────────────────────────────────────────────────────────────────
// Vision transport (Slice 4) — verify AI-discovered (anomaly) findings against a
// fresh screenshot of the cited page. API-only (the keyless CLI is text-only, so
// the live pass falls back to signals-only there, exactly like llm-anomaly).
// One call per item (each carries its own image), parallel + disk-cached.
// ───────────────────────────────────────────────────────────────────────────

/** A finding to verify WITH a screenshot of the cited page. */
export interface VisionVerifyItem extends LlmVerifyItem {
  image?: { data: string; mediaType: string } | null;
}

async function callModelVision(
  userPrompt: string,
  image: { data: string; mediaType: string } | null,
  apiKey: string,
  model: string,
  verbose: boolean,
): Promise<string | null> {
  const content: unknown[] = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  content.push({ type: 'text', text: userPrompt });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_API_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: 1500, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (verbose) console.warn(`LLM vision-verify HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (verbose) console.warn(`LLM vision-verify failed: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Verify one finding with its screenshot; cached by (model, prompt, image bytes). */
async function verifyOneVision(
  item: VisionVerifyItem,
  apiKey: string,
  options: LlmVerifyOptions,
): Promise<LlmVerdict | null> {
  const model = options.model ?? DEFAULT_MODEL;
  // Render the single item at index 0; remap the parsed verdict to its real index.
  const base = buildUserPrompt([{ ...item, index: 0 }], options.siteContext);
  const userPrompt =
    (item.image ? 'A screenshot of the cited page is attached — use it to judge visual/layout/UX claims. ' : '') + base;
  const key = `vision-${cacheKey(model, `${userPrompt}\0${item.image?.data ?? 'no-image'}`)}`;

  let cacheFile: string | null = null;
  if (options.cacheDir) {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      cacheFile = path.join(options.cacheDir, `${key}.json`);
      if (fs.existsSync(cacheFile)) {
        const v = parseLlmVerdicts(fs.readFileSync(cacheFile, 'utf8'), [0])[0];
        return v ? { index: item.index, verdict: v.verdict, reason: v.reason } : null;
      }
    } catch {
      cacheFile = null;
    }
  }

  const text = await callModelVision(userPrompt, item.image ?? null, apiKey, model, options.verbose ?? false);
  if (!text) return null;
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, text);
    } catch {
      // best effort
    }
  }
  const v = parseLlmVerdicts(text, [0])[0];
  return v ? { index: item.index, verdict: v.verdict, reason: v.reason } : null;
}

/**
 * Verify findings WITH screenshots (vision). Returns [] on no key / no items /
 * any failure, so the caller keeps the deterministic result unchanged. Returned
 * indices match the `index` values passed in.
 */
export async function llmVerifyFindingsVision(
  items: VisionVerifyItem[],
  options: LlmVerifyOptions = {},
): Promise<LlmVerdict[]> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey || items.length === 0) return [];
  const progress = new PhaseProgress('LLM vision checks', items.length);
  const results = await Promise.all(
    items.map((it) =>
      verifyOneVision(it, apiKey, options).then((r) => {
        progress.tick();
        return r;
      }),
    ),
  );
  progress.done(`Vision-checked ${items.length} finding(s)`);
  return results.filter((r): r is LlmVerdict => r !== null);
}

// ───────────────────────────────────────────────────────────────────────────
// Keyless transport — spawn the Claude Code CLI (`claude -p`) instead of the
// API. Same prompt, same parsing; the only difference is where the model runs.
// This lets `--verify` reason over the unchecked findings WITHOUT an
// `ANTHROPIC_API_KEY`, using the user's existing `claude` login. The transport
// itself lives in ./claude-cli (shared with the narrative/anomaly passes); it
// degrades silently: no binary / spawn failure / bad output → [], and the
// caller keeps the deterministic result unchanged.
// ───────────────────────────────────────────────────────────────────────────

/** Verify one batch via the CLI; cached by payload hash (distinct from API). */
async function cliVerifyBatch(items: LlmVerifyItem[], options: LlmVerifyOptions): Promise<LlmVerdict[]> {
  const model = options.model; // undefined → CLI uses the user's default model
  const userPrompt = buildUserPrompt(items, options.siteContext);
  const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;
  const validIndices = items.map((i) => i.index);
  const key = `cli-${cacheKey(model ?? 'default', userPrompt)}`;

  let cacheFile: string | null = null;
  if (options.cacheDir) {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      cacheFile = path.join(options.cacheDir, `${key}.json`);
      if (fs.existsSync(cacheFile)) return parseLlmVerdicts(fs.readFileSync(cacheFile, 'utf8'), validIndices);
    } catch {
      cacheFile = null;
    }
  }

  const text = await callClaudeCli(prompt, model, options.verbose ?? false);
  if (!text) return [];
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, text);
    } catch {
      // best effort
    }
  }
  return parseLlmVerdicts(text, validIndices);
}

/**
 * Verify the given findings by spawning the Claude CLI (no API key). Returns []
 * when the CLI isn't available / no items / any failure, so the caller keeps the
 * deterministic result unchanged. Batched like the API path. Returned indices
 * match the `index` values passed in.
 */
export async function claudeCliVerifyFindings(
  items: LlmVerifyItem[],
  options: LlmVerifyOptions = {},
): Promise<LlmVerdict[]> {
  if (items.length === 0 || !isClaudeCliAvailable()) return [];

  const batches: LlmVerifyItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));

  // Sequential: spawning many CLI processes at once is heavy and offers little
  // gain over the API path's parallelism. Batches are few in practice — but each
  // CLI spawn is slow (up to 180s), so show batch progress + ETA.
  const progress = new PhaseProgress('LLM verify batches (CLI)', batches.length);
  const out: LlmVerdict[] = [];
  for (const batch of batches) {
    out.push(...(await cliVerifyBatch(batch, options)));
    progress.tick();
  }
  progress.done(`LLM verified ${items.length} finding(s) in ${batches.length} batch(es)`);
  return out;
}
