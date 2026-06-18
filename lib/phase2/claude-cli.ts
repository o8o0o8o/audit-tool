/**
 * Shared keyless transport — spawn the Claude Code CLI (`claude -p`) instead of
 * the Anthropic API. Lets the optional LLM passes (`--verify` and the `--llm`
 * pass set) reason WITHOUT an `ANTHROPIC_API_KEY`, using the user's
 * existing `claude` login.
 *
 * Same contract everywhere it is used: it degrades silently. No binary / spawn
 * failure / timeout / bad output → null, and the caller keeps its non-LLM result
 * unchanged. The CLI path is text-only (no vision) and inherits the user's
 * default model (no `--model` passed unless one is requested).
 *
 * Disabled entirely by `SEO_AUDIT_SKIP_CLAUDE_CLI=1`; binary overridable via
 * `SEO_AUDIT_CLAUDE_CLI_BIN`.
 */

import { spawn, spawnSync } from 'child_process';
import { recordCliUsage, type ApiUsage, type LlmCategory } from '../utils/llm-usage-tracker';

/** The CLI binary to spawn; overridable for tests / non-standard installs. */
const CLAUDE_CLI_BIN = process.env.SEO_AUDIT_CLAUDE_CLI_BIN || 'claude';
/** Default per-call wall-clock cap so a hung/interactive CLI can never stall the run. */
export const DEFAULT_CLI_TIMEOUT_MS = 180_000;

let claudeCliCached: boolean | null = null;

/**
 * Is the Claude CLI present and runnable? Probed once (via `--version`) and
 * memoised. Returns false on any error so detection itself never throws.
 */
export function isClaudeCliAvailable(): boolean {
  if (claudeCliCached !== null) return claudeCliCached;
  if (process.env.SEO_AUDIT_SKIP_CLAUDE_CLI) {
    claudeCliCached = false;
    return false;
  }
  try {
    const res = spawnSync(CLAUDE_CLI_BIN, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    claudeCliCached = res.status === 0;
  } catch {
    claudeCliCached = false;
  }
  return claudeCliCached;
}

/**
 * Pull the assistant text out of the CLI reply. `--output-format json` wraps it
 * in `{ "result": "<text>", ... }`; we also accept a raw text reply. Pure and
 * defensive (exported for unit testing) — returns '' on anything unparseable.
 */
export function extractCliResult(stdout: string): string {
  const s = (stdout ?? '').trim();
  if (!s) return '';
  // JSON envelope first (the `--output-format json` shape).
  const brace = s.indexOf('{');
  if (brace !== -1) {
    try {
      const env = JSON.parse(s.slice(brace)) as { result?: unknown };
      if (typeof env.result === 'string') return env.result.trim();
    } catch {
      // fall through — maybe the model emitted bare JSON as text
    }
  }
  return s;
}

/**
 * Pull token usage + the REAL dollar cost out of the `--output-format json`
 * envelope (`{ result, total_cost_usd, usage: {...} }`). Pure and defensive —
 * returns an empty object on anything unparseable, so usage accounting never
 * throws or blocks the call. Exported for unit testing.
 */
export function extractCliUsage(stdout: string): { usage?: ApiUsage; costUsd?: number } {
  const s = (stdout ?? '').trim();
  const brace = s.indexOf('{');
  if (brace === -1) return {};
  try {
    const env = JSON.parse(s.slice(brace)) as { total_cost_usd?: unknown; usage?: unknown };
    const out: { usage?: ApiUsage; costUsd?: number } = {};
    if (typeof env.total_cost_usd === 'number') out.costUsd = env.total_cost_usd;
    if (env.usage && typeof env.usage === 'object') out.usage = env.usage as ApiUsage;
    return out;
  } catch {
    return {};
  }
}

/**
 * Spawn one CLI call, feeding the prompt on stdin. Resolves the result text, or
 * null on spawn failure / non-zero exit / timeout. Never rejects.
 *
 * When `category` is supplied, the envelope's token usage + real `total_cost_usd`
 * are recorded against that category in the shared usage tracker on success.
 */
export function callClaudeCli(
  prompt: string,
  model: string | undefined,
  verbose: boolean,
  timeoutMs: number = DEFAULT_CLI_TIMEOUT_MS,
  category?: LlmCategory,
): Promise<string | null> {
  return new Promise((resolve) => {
    const argv = ['-p', '--output-format', 'json'];
    if (model) argv.push('--model', model);
    let child;
    try {
      child = spawn(CLAUDE_CLI_BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: unknown) {
      if (verbose) console.warn(`claude CLI spawn failed: ${(error as Error).message}`);
      return resolve(null);
    }
    let out = '';
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (verbose) console.warn('claude CLI timed out');
      done(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (verbose) console.warn(`claude CLI error: ${error.message}`);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (verbose) console.warn(`claude CLI exited ${code}`);
        return done(null);
      }
      if (category) {
        const { usage, costUsd } = extractCliUsage(out);
        recordCliUsage(category, usage, costUsd);
      }
      done(extractCliResult(out));
    });
    // The stdin stream emits its OWN async 'error' (e.g. EPIPE if the child
    // already exited) — a different emitter from child.on('error') above. Without
    // a listener that becomes an uncaught exception and crashes the audit, which
    // would defeat the silent-degradation contract.
    child.stdin.on('error', (error) => {
      clearTimeout(timer);
      if (verbose) console.warn(`claude CLI stdin error: ${error.message}`);
      done(null);
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}
