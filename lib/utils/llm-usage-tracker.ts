/**
 * Process-global LLM usage/cost accumulator.
 *
 * Every LLM call this tool makes (the `--llm` pass set and the `--verify` LLM
 * fallback, across both the Anthropic API and the keyless `claude` CLI
 * transports) reports its token usage here at the single point where it parses
 * the response. At the end of the audit `getLlmUsageSnapshot()` returns the
 * aggregate — total and per-category — for the CLI summary box and a persisted
 * `llm-usage.json`.
 *
 * Two cost paths:
 *   • CLI transport — the `claude -p --output-format json` envelope carries a
 *     REAL `total_cost_usd`, used verbatim (estimated=false).
 *   • API transport — the response carries only token counts, so cost is
 *     ESTIMATED from a per-model price table (estimated=true). The table can go
 *     stale; the summary marks estimated figures with a leading "~".
 *
 * Cache hits cost nothing and are counted separately (`cached`), so a re-run of
 * an already-cached audit reports `0` network calls and `$0.00`.
 *
 * One audit runs in one process (start.ts spawns a fresh process per audit), so
 * a module singleton is the right scope. `resetLlmUsage()` exists for tests.
 */

export type LlmCategory =
  | 'narrative'
  | 'anomaly'
  | 'verify'
  | 'finding-verify'
  | 'vision-verify'
  | 'repo'
  | 'content-research';
export type LlmTransport = 'api' | 'cli';

/** The Anthropic/CLI `usage` block shape (all fields optional/defensive). */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface CategoryUsage {
  calls: number; // billed network/CLI calls (excludes cache hits)
  cached: number; // cache hits (free)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number; // real (CLI) + estimated (API) summed
  estimated: boolean; // true if any portion was priced from the API table
  transports: LlmTransport[]; // distinct transports observed
}

export interface LlmUsageSnapshot {
  totalCalls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  estimated: boolean;
  byCategory: Record<string, CategoryUsage>;
}

/** Stable display/iteration order for categories in the summary. */
export const LLM_CATEGORY_ORDER: LlmCategory[] = [
  'narrative',
  'anomaly',
  'verify',
  'finding-verify',
  'vision-verify',
  'repo',
  'content-research',
];

/** USD per MILLION tokens, by model family. API-path estimates only. */
interface PriceRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const PRICING: Array<{ match: RegExp; rates: PriceRates }> = [
  { match: /opus/i, rates: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: /haiku/i, rates: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { match: /sonnet/i, rates: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
];
/** Sonnet-class default for unrecognised models (e.g. Fable, future ids). */
const DEFAULT_RATES: PriceRates = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

function ratesFor(model: string | undefined): PriceRates {
  if (model) {
    for (const { match, rates } of PRICING) if (match.test(model)) return rates;
  }
  return DEFAULT_RATES;
}

/** Estimate USD for an API call from token counts and the model's price table. */
export function estimateApiCostUsd(model: string | undefined, usage: ApiUsage | undefined): number {
  if (!usage) return 0;
  const r = ratesFor(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (input * r.input + output * r.output + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite) / 1_000_000;
}

const EMPTY = (): CategoryUsage => ({
  calls: 0,
  cached: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  costUsd: 0,
  estimated: false,
  transports: [],
});

const store = new Map<LlmCategory, CategoryUsage>();

function bucket(category: LlmCategory): CategoryUsage {
  let b = store.get(category);
  if (!b) {
    b = EMPTY();
    store.set(category, b);
  }
  return b;
}

function addTokens(b: CategoryUsage, usage: ApiUsage | undefined): void {
  if (!usage) return;
  b.inputTokens += usage.input_tokens ?? 0;
  b.outputTokens += usage.output_tokens ?? 0;
  b.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  b.cacheCreateTokens += usage.cache_creation_input_tokens ?? 0;
}

function noteTransport(b: CategoryUsage, t: LlmTransport): void {
  if (!b.transports.includes(t)) b.transports.push(t);
}

/** Record one billed API call: tokens + estimated cost from the price table. */
export function recordApiUsage(category: LlmCategory, model: string | undefined, usage: ApiUsage | undefined): void {
  const b = bucket(category);
  b.calls += 1;
  addTokens(b, usage);
  b.costUsd += estimateApiCostUsd(model, usage);
  b.estimated = true;
  noteTransport(b, 'api');
}

/** Record one billed CLI call: tokens + the envelope's REAL total_cost_usd. */
export function recordCliUsage(category: LlmCategory, usage: ApiUsage | undefined, costUsd: number | undefined): void {
  const b = bucket(category);
  b.calls += 1;
  addTokens(b, usage);
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) b.costUsd += costUsd;
  noteTransport(b, 'cli');
}

/** Record a disk-cache hit (no network/CLI call, no cost). */
export function recordCacheHit(category: LlmCategory): void {
  bucket(category).cached += 1;
}

/** Aggregate the accumulated usage into a flat, serialisable snapshot. */
export function getLlmUsageSnapshot(): LlmUsageSnapshot {
  const snap: LlmUsageSnapshot = {
    totalCalls: 0,
    cachedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    estimated: false,
    byCategory: {},
  };
  for (const category of LLM_CATEGORY_ORDER) {
    const b = store.get(category);
    if (!b || (b.calls === 0 && b.cached === 0)) continue;
    snap.totalCalls += b.calls;
    snap.cachedCalls += b.cached;
    snap.inputTokens += b.inputTokens;
    snap.outputTokens += b.outputTokens;
    snap.cacheReadTokens += b.cacheReadTokens;
    snap.cacheCreateTokens += b.cacheCreateTokens;
    snap.costUsd += b.costUsd;
    snap.estimated = snap.estimated || b.estimated;
    snap.byCategory[category] = { ...b, transports: [...b.transports] };
  }
  return snap;
}

/** Clear all accumulated usage. For tests and standalone re-runs. */
export function resetLlmUsage(): void {
  store.clear();
}
