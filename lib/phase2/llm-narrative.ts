/**
 * Optional LLM narrative pass for Phase 2.
 *
 * Replaces the templated `**Analysis.** N findings...` line in each section
 * with 2–3 sentences of richer prose anchored in the actual findings list.
 * Everything else (severity pills, counts, example bullets, screenshots)
 * stays untouched — the LLM's surface area is intentionally tiny.
 *
 * Design:
 *   • No SDK dependency. Anthropic's API is a vanilla HTTPS POST.
 *   • Two transports, auto-selected so a key is never required: with
 *     `ANTHROPIC_API_KEY` it POSTs to the API; otherwise, if the `claude` CLI is
 *     on PATH it spawns it headless (keyless, using the user's login). Returns
 *     null only when neither is available, or on any failure.
 *   • Disk-cached by SHA of (model, system, user, findings) so re-runs are free.
 *   • Returns null on any failure so the caller falls back to templated text.
 *
 * Cost: at Sonnet pricing (~$3/M input, $15/M output), each section call is
 * roughly $0.005 (200 input tokens, 100 output). A typical audit runs the
 * pass for 4–6 sections → ~$0.02–$0.03 per audit. Prompt caching is not
 * useful here since each section's findings are unique per audit.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { callClaudeCli, isClaudeCliAvailable } from './claude-cli';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

export interface NarrativeRequest {
  sectionTitle: string;
  /** Compact findings summary the LLM works from. */
  findings: Array<{
    message: string;
    severity: string;
    count: number;
    exampleUrl?: string;
  }>;
  /** Optional cache directory; if set, prompts and replies are persisted. */
  cacheDir?: string;
  /** Optional model override. */
  model?: string;
  /** Optional API key override; defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Optional verbose flag to log API errors. */
  verbose?: boolean;
}

const SYSTEM_PROMPT = `You write the short "Analysis" paragraph that opens each section of a web technical audit report.

Tone: terse, factual, professional. Match the voice of an experienced engineer briefing another engineer — no marketing words, no superlatives, no padding.

Length: 2–3 sentences, ~60 words max. Never longer.

Rules:
- Only use the findings you are given. Do not invent metrics, page counts, or fixes.
- Lead with the most important pattern you see in the list (e.g. "Most performance issues concentrate on case-study pages").
- The reader will see the per-finding list right after your paragraph — do not enumerate findings or repeat their titles.
- Do not start with "This section" or "In this audit". Open with substance.
- Plain prose. No bullets, no headings, no markdown emphasis.`;

function buildUserPrompt(req: NarrativeRequest): string {
  const sev = (s: string) => s.toUpperCase().padEnd(8);
  const list = req.findings
    .slice(0, 30)
    .map((f) => `${sev(f.severity)} ${f.count.toString().padStart(4)}× — ${f.message}${f.exampleUrl ? `  (e.g. ${f.exampleUrl})` : ''}`)
    .join('\n');
  return `Section: ${req.sectionTitle}\n\nFindings (severity, occurrence count, message):\n${list}\n\nWrite the Analysis paragraph.`;
}

function cacheKey(model: string, system: string, user: string): string {
  return crypto.createHash('sha256').update(model).update('\0').update(system).update('\0').update(user).digest('hex');
}

/** Call the Anthropic API for one section. Returns the paragraph text or null. */
async function callApi(userPrompt: string, apiKey: string, model: string, verbose: boolean): Promise<string | null> {
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
        max_tokens: 250,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      if (verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`LLM narrative HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (verbose) console.warn(`LLM narrative failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Generate a rich Analysis paragraph for one section, or null on failure.
 *
 * Transport priority: the Anthropic API when a key is present, otherwise the
 * keyless `claude` CLI when it is available (shared with the verify/anomaly
 * passes). Returns null when neither is reachable so the caller keeps templated
 * prose. API and CLI replies are cached under distinct keys.
 */
export async function generateSectionAnalysis(req: NarrativeRequest): Promise<string | null> {
  const apiKey = req.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  const useCli = !apiKey && isClaudeCliAvailable();
  if (!apiKey && !useCli) return null;

  // The CLI uses the user's default model (no override); the API uses ours.
  const model = useCli ? req.model : req.model ?? DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(req);
  const rawKey = cacheKey(model ?? 'default', SYSTEM_PROMPT, userPrompt);
  const key = useCli ? `cli-${rawKey}` : rawKey;

  // Disk cache lookup
  let cacheFile: string | null = null;
  if (req.cacheDir) {
    try {
      fs.mkdirSync(req.cacheDir, { recursive: true });
      cacheFile = path.join(req.cacheDir, `${key}.txt`);
      if (fs.existsSync(cacheFile)) {
        return fs.readFileSync(cacheFile, 'utf8');
      }
    } catch {
      cacheFile = null;
    }
  }

  const text = useCli
    ? extractParagraph(await callClaudeCli(`${SYSTEM_PROMPT}\n\n${userPrompt}`, model, req.verbose ?? false))
    : await callApi(userPrompt, apiKey as string, model as string, req.verbose ?? false);
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
 * Normalise a CLI reply into a clean paragraph: trim, drop any accidental
 * markdown fences the headless model might wrap prose in, collapse to null when
 * empty. The API path returns prose directly so it skips this.
 */
function extractParagraph(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return text || null;
}
