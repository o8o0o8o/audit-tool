/**
 * Phase 4 LLM transport — a thin JSON-returning wrapper around the SAME
 * API-or-keyless-CLI selection the Phase 2/3 passes use.
 *
 * Contract mirrors `lib/phase2/llm-narrative.ts`:
 *   • With `ANTHROPIC_API_KEY` it POSTs to the Anthropic API; otherwise, if the
 *     `claude` CLI is on PATH it spawns it headless (keyless, user's login).
 *   • Low-effort policy: no extended thinking on the API; the CLI inherits the
 *     user's default model with no override.
 *   • Disk-cached by SHA of (model, system, user) under distinct API/CLI keys.
 *   • Returns null on any failure so callers fall back to deterministic output.
 *
 * Usage is recorded against the `content-research` LLM category for the summary.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { callClaudeCli, isClaudeCliAvailable } from '../phase2/claude-cli';
import { recordApiUsage, recordCacheHit, type ApiUsage } from '../utils/llm-usage-tracker';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const LLM_API_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

export function llmTransportAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || isClaudeCliAvailable();
}

export interface LlmJsonRequest {
  system: string;
  user: string;
  cacheDir?: string;
  /** Cache namespace so different call sites don't collide. */
  cacheTag: string;
  maxTokens?: number;
  verbose?: boolean;
}

function cacheKey(tag: string, model: string, system: string, user: string): string {
  return crypto
    .createHash('sha256')
    .update(tag)
    .update('\0')
    .update(model)
    .update('\0')
    .update(system)
    .update('\0')
    .update(user)
    .digest('hex');
}

async function callApi(req: LlmJsonRequest, apiKey: string, model: string): Promise<string | null> {
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
        max_tokens: req.maxTokens ?? 1500,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (req.verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`content-research LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: ApiUsage;
    };
    recordApiUsage('content-research', json.model ?? model, json.usage);
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (req.verbose) console.warn(`content-research LLM failed: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one LLM call and return its raw text reply, or null. Callers parse JSON
 * defensively via {@link extractJson}.
 */
export async function callLlmText(req: LlmJsonRequest): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const useCli = !apiKey && isClaudeCliAvailable();
  if (!apiKey && !useCli) return null;

  const model = useCli ? 'default' : DEFAULT_MODEL;
  const key = `${useCli ? 'cli-' : ''}${cacheKey(req.cacheTag, model, req.system, req.user)}`;

  let cacheFile: string | null = null;
  if (req.cacheDir) {
    try {
      fs.mkdirSync(req.cacheDir, { recursive: true });
      cacheFile = path.join(req.cacheDir, `${key}.txt`);
      if (fs.existsSync(cacheFile)) {
        recordCacheHit('content-research');
        return fs.readFileSync(cacheFile, 'utf8');
      }
    } catch {
      cacheFile = null;
    }
  }

  const text = useCli
    ? await callClaudeCli(`${req.system}\n\n${req.user}`, undefined, req.verbose ?? false, undefined, 'content-research')
    : await callApi(req, apiKey as string, DEFAULT_MODEL);
  if (!text) return null;

  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, text);
    } catch {
      // best effort
    }
  }
  return text;
}

/**
 * Pull the first JSON value (object or array) out of an LLM reply, tolerating
 * markdown fences and surrounding prose. Returns null on anything unparseable.
 */
export function extractJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  const stripped = raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates: string[] = [stripped];
  // A balanced object/array slice handles prose/trailing text around the JSON
  // (e.g. "Here you go: {...} done"). Whichever bracket appears first wins.
  const firstObj = stripped.indexOf('{');
  const firstArr = stripped.indexOf('[');
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    const slice = sliceBalanced(stripped, '{', '}');
    if (slice) candidates.push(slice);
  } else if (firstArr >= 0) {
    const slice = sliceBalanced(stripped, '[', ']');
    if (slice) candidates.push(slice);
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Extract the first balanced `open…close` span, respecting string literals. */
function sliceBalanced(s: string, open: string, close: string): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
