/**
 * Optional LLM verification pass for Phase 2.
 *
 * Runs after the deterministic findings are consolidated, ranked and
 * severity-moderated, but BEFORE the final report is written. A senior-auditor
 * persona reviews the whole finding list and returns the subset that should be
 * removed because it is either:
 *   • a duplicate / near-duplicate of another finding already in the list, or
 *   • a likely false positive given the finding text.
 *
 * Dropping that noise is what makes the report "more concise and readable" —
 * the prose tightening is handled by the separate `--llm-narrative` pass, and
 * both are enabled together by the umbrella `--llm` flag.
 *
 * Design mirrors llm-narrative.ts / llm-anomaly.ts:
 *   • No SDK dependency. Anthropic's API is a vanilla HTTPS POST.
 *   • Gated on `ANTHROPIC_API_KEY`. Returns [] (no-op) when absent.
 *   • Disk-cached by SHA of (model, system, findings payload) so re-runs are free.
 *   • Returns [] on ANY failure so the caller falls back to the full finding set.
 *   • Conservative authority: only drops what the model explicitly flags, and
 *     every drop is logged with a reason so the suppression is auditable.
 *
 * Cost: one call per audit over ≤80 findings → ~$0.01–$0.03 at Sonnet pricing.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

/** A single finding handed to the verifier, addressed by stable index. */
export interface VerifyFinding {
  index: number;
  section: string;
  severity: string;
  count: number;
  message: string;
}

export type VerifyDropKind = 'duplicate' | 'false-positive';

/** A verifier decision to remove one finding. */
export interface VerifyDrop {
  index: number;
  kind: VerifyDropKind;
  reason: string;
}

export interface VerifyRequest {
  findings: VerifyFinding[];
  /** Audited domain — context for the reviewer. */
  domain?: string;
  /** Optional cache directory; if set, replies are persisted by payload hash. */
  cacheDir?: string;
  model?: string;
  apiKey?: string;
  verbose?: boolean;
}

const SYSTEM_PROMPT = `You are a senior web-audit reviewer doing a final quality pass on an automated audit before it is sent to a client.

You are given the full list of findings produced by deterministic analyzers, each with a stable index, its report section, severity, and how many pages it affects.

Your ONLY job is to identify findings that should be REMOVED from the report because they are:
  • "duplicate" — the same underlying problem as ANOTHER finding in the list (even if worded differently or split across sections). Keep the clearer/broader one, drop the redundant one.
  • "false-positive" — the finding text describes something that is almost certainly not a real problem, or is internally contradictory / nonsensical.

Be conservative. The deterministic analyzers are usually right. When in doubt, KEEP the finding. Do NOT drop a finding merely because it is low severity, niche, or you personally disagree with its importance — only drop genuine duplicates and genuine false positives.

Never drop BOTH members of a duplicate pair — keep exactly one.

Respond with ONLY a JSON object, no prose, in this exact shape:
{"drop":[{"index":<number>,"kind":"duplicate"|"false-positive","reason":"<short reason, name the finding it duplicates when kind=duplicate>"}]}
If nothing should be dropped, respond with {"drop":[]}.`;

function buildUserPrompt(req: VerifyRequest): string {
  const sev = (s: string) => (s ?? 'medium').toUpperCase().padEnd(8);
  const list = req.findings
    .map((f) => `[${f.index}] (${f.section}, ${sev(f.severity)}, ${f.count}×) ${f.message}`)
    .join('\n');
  const ctx = req.domain ? `Site: ${req.domain}\n\n` : '';
  return `${ctx}Findings:\n${list}\n\nReturn the JSON object listing only the findings to remove.`;
}

function cacheKey(model: string, system: string, user: string): string {
  return crypto.createHash('sha256').update(model).update('\0').update(system).update('\0').update(user).digest('hex');
}

/**
 * Parse the model's reply into validated drop decisions. Pure and defensive:
 *   • tolerates prose / code fences around the JSON object,
 *   • keeps only entries whose index is in `validIndices`,
 *   • normalizes an unknown `kind` to "duplicate",
 *   • de-duplicates repeated indices,
 *   • returns [] on any structural problem.
 * Exported for unit testing.
 */
export function parseVerifyResult(raw: string, validIndices: number[]): VerifyDrop[] {
  if (!raw) return [];
  // Pull the first {...} object out of the reply, ignoring fences/prose.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const drops = (parsed as { drop?: unknown })?.drop;
  if (!Array.isArray(drops)) return [];
  const valid = new Set(validIndices);
  const seen = new Set<number>();
  const out: VerifyDrop[] = [];
  for (const d of drops) {
    const idx = (d as { index?: unknown })?.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || !valid.has(idx) || seen.has(idx)) continue;
    const rawKind = (d as { kind?: unknown })?.kind;
    const kind: VerifyDropKind = rawKind === 'false-positive' ? 'false-positive' : 'duplicate';
    const reason = typeof (d as { reason?: unknown })?.reason === 'string' ? ((d as { reason: string }).reason).trim() : '';
    seen.add(idx);
    out.push({ index: idx, kind, reason: reason || (kind === 'duplicate' ? 'duplicate of another finding' : 'likely false positive') });
  }
  return out;
}

/**
 * Ask Claude which findings to drop. Returns [] on no key / no findings / any
 * failure, so the caller keeps the full deterministic set unchanged.
 */
export async function verifyFindings(req: VerifyRequest): Promise<VerifyDrop[]> {
  const apiKey = req.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) return [];
  if (!req.findings || req.findings.length === 0) return [];

  const model = req.model ?? DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(req);
  const validIndices = req.findings.map((f) => f.index);
  const key = cacheKey(model, SYSTEM_PROMPT, userPrompt);

  let cacheFile: string | null = null;
  if (req.cacheDir) {
    try {
      fs.mkdirSync(req.cacheDir, { recursive: true });
      cacheFile = path.join(req.cacheDir, `${key}.json`);
      if (fs.existsSync(cacheFile)) {
        return parseVerifyResult(fs.readFileSync(cacheFile, 'utf8'), validIndices);
      }
    } catch {
      cacheFile = null;
    }
  }

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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      if (req.verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`LLM verify HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return [];
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text) return [];

    if (cacheFile) {
      try {
        fs.writeFileSync(cacheFile, text);
      } catch {
        // best effort
      }
    }
    return parseVerifyResult(text, validIndices);
  } catch (error: unknown) {
    if (req.verbose) {
      console.warn(`LLM verify failed: ${(error as Error).message}`);
    }
    return [];
  }
}
