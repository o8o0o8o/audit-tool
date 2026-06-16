/**
 * LLM repo analysis — the optional reasoning layer ON TOP OF the deterministic
 * repo analyzers (it never replaces them). The deterministic core is the fast,
 * exact, reproducible substrate; this pass uses it as GROUNDING to meet the
 * three goals static analysis can't fully reach:
 *
 *   1. find MORE — issues no hardcoded rule enumerates (architecture/SEO smells)
 *   2. CONFIRM — does the source actually explain a crawl finding, and why?
 *   3. FIX — a concrete, code-aware suggestion against the real cited file
 *
 * Same contract as the other LLM passes (`--llm-findings` / `--verify`):
 *   • With `ANTHROPIC_API_KEY` it POSTs the API; otherwise, if the `claude` CLI
 *     is on PATH it spawns it headless (keyless) via the shared transport.
 *   • Disk-cached by SHA of (transport, model, system, prompt) so re-runs are free.
 *   • Degrades SILENTLY to [] on any failure / no transport / no source.
 *   • Low-effort per the project LLM policy (modest max_tokens, no extended thinking).
 *
 * Trust model mirrors `--verify`: the LLM only ADDS findings; it can never drop a
 * deterministic one. Findings citing a file NOT in the provided context are
 * dropped (anti-hallucination) — the model may only reason over what we showed it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { callClaudeCli, isClaudeCliAvailable } from '../../phase2/claude-cli';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const LLM_API_TIMEOUT_MS = 120_000;

/** Bounds — keep the prompt cheap and the run snappy. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 8_000;
const MAX_CRAWL_FINDINGS = 25;
const MAX_OUTPUT_TOKENS = 2_500;

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_KINDS = new Set(['novel', 'confirmation']);

export interface LlmRepoFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  detail: string;
  fix: string;
  kind: 'novel' | 'confirmation';
  file?: string;
}

export interface RepoContext {
  framework: string | null;
  version: string | null;
  router: string | null;
  configFile: string | null;
  /** Deterministic repo issues already found — so the LLM looks for OTHER things. */
  knownIssues: Array<{ message: string; severity: string }>;
  /** Crawl findings to corroborate against the source (goal 2). */
  crawlFindings: Array<{ message: string; severity: string; example?: string }>;
  /** Files the deterministic source-mapper tied to issues — confirm candidates. */
  sourceMapFiles: string[];
}

export interface LlmRepoOptions {
  apiKey?: string | null;
  model?: string;
  cacheDir?: string;
  maxFiles?: number;
  verbose?: boolean;
}

const SYSTEM_PROMPT = `You are a senior web/SEO engineer reviewing a website's SOURCE REPOSITORY.
You are given: the detected framework, the issues a deterministic analyzer ALREADY found, the issues a live CRAWL of the deployed site found, and the contents of selected source files.

Do three things:
1. FIND MORE: surface SEO / performance / correctness / accessibility problems in the source that are NOT already in the "known issues" list and that a regex-based analyzer would miss (architecture, data-fetching, rendering strategy, config, framework misuse).
2. CONFIRM: for each crawl finding, decide whether the provided source EXPLAINS it, and say how (cite the file/symbol).
3. FIX: give a concrete, code-aware fix for each problem.

Rules:
- Use ONLY the provided file contents. NEVER invent files, paths, or line numbers. If a file you'd need was not provided, omit the finding rather than guess.
- Be specific and actionable; no generic advice.
- Return ONLY a JSON array (no prose, no markdown fences). Each element:
  {"severity":"critical|high|medium|low","title":"short title","detail":"what & why","fix":"concrete code-level fix","kind":"novel|confirmation","file":"relative/path or omitted"}
- If you find nothing, return [].`;

/** Resolve a repo-relative candidate, refusing anything that escapes the repo root. */
function safeResolve(repoRoot: string, rel: string): string | null {
  const resolved = path.resolve(repoRoot, rel);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (resolved !== repoRoot && !resolved.startsWith(rootWithSep)) return null; // traversal guard
  return resolved;
}

/**
 * Gather a bounded, deduped set of high-signal source files: the framework
 * config, common entry files, and every file the deterministic source-mapper
 * flagged. Existing-only, capped in count and per-file size.
 */
export function gatherSourceFiles(
  repoPath: string,
  ctx: RepoContext,
  maxFiles: number = MAX_FILES,
): Array<{ path: string; content: string }> {
  const candidates: string[] = [];
  if (ctx.configFile) candidates.push(ctx.configFile);

  // Common framework entry points (existence-filtered below).
  candidates.push(
    'app/layout.tsx',
    'app/layout.jsx',
    'app/layout.ts',
    'app/layout.js',
    'src/app/layout.tsx',
    'src/app/layout.jsx',
    'app/page.tsx',
    'src/app/page.tsx',
    'pages/_app.tsx',
    'pages/_app.jsx',
    'pages/_document.tsx',
    'app/robots.ts',
    'app/sitemap.ts',
  );

  // Confirm candidates from the deterministic source-mapper.
  candidates.push(...ctx.sourceMapFiles);

  const seen = new Set<string>();
  const files: Array<{ path: string; content: string }> = [];
  for (const rel of candidates) {
    if (files.length >= maxFiles) break;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = safeResolve(repoPath, rel);
    if (!abs) continue;
    let content: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + '\n/* …truncated… */';
    }
    files.push({ path: rel, content });
  }
  return files;
}

function buildUserPrompt(ctx: RepoContext, files: Array<{ path: string; content: string }>): string {
  const known = ctx.knownIssues.slice(0, MAX_CRAWL_FINDINGS).map((i) => `- [${i.severity}] ${i.message}`);
  const crawl = ctx.crawlFindings
    .slice(0, MAX_CRAWL_FINDINGS)
    .map((i) => `- [${i.severity}] ${i.message}${i.example ? ` (e.g. ${i.example})` : ''}`);
  const fileBlocks = files.map((f) => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n');

  return [
    `Framework: ${ctx.framework ?? 'unknown'}${ctx.version ? ` ${ctx.version}` : ''}${ctx.router ? ` (${ctx.router} router)` : ''}`,
    ctx.configFile ? `Config file: ${ctx.configFile}` : '',
    '',
    `Known issues (deterministic analyzer — DO NOT repeat these):\n${known.length ? known.join('\n') : '(none)'}`,
    '',
    `Crawl findings to corroborate against the source:\n${crawl.length ? crawl.join('\n') : '(none)'}`,
    '',
    `Source files:\n${fileBlocks || '(none provided)'}`,
    '',
    'Return the JSON array now.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Parse the model's JSON-array reply into validated findings. Defensive and pure
 * (exported for tests): tolerates markdown fences / leading prose, validates the
 * enum fields, and DROPS any finding whose `file` is not in `allowedFiles`
 * (anti-hallucination — the model may only cite files we actually provided).
 */
export function parseLlmRepoFindings(text: string, allowedFiles: Set<string>): LlmRepoFinding[] {
  if (!text) return [];
  let raw = text.trim();
  // Strip ```json fences if present.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  // Isolate the first JSON array.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: LlmRepoFinding[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const severity = String(o.severity ?? '').toLowerCase();
    const kind = String(o.kind ?? 'novel').toLowerCase();
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const detail = typeof o.detail === 'string' ? o.detail.trim() : '';
    const fix = typeof o.fix === 'string' ? o.fix.trim() : '';
    const file = typeof o.file === 'string' && o.file.trim() ? o.file.trim() : undefined;

    if (!title || !VALID_SEVERITIES.has(severity) || !VALID_KINDS.has(kind)) continue;
    // Anti-hallucination: a cited file must be one we actually provided.
    if (file && !allowedFiles.has(file)) continue;

    out.push({
      severity: severity as LlmRepoFinding['severity'],
      message: title,
      detail,
      fix,
      kind: kind as LlmRepoFinding['kind'],
      file,
    });
  }
  return out;
}

/** Text-only API call (source review needs no vision). Resolves text or null. */
async function callModel(userPrompt: string, apiKey: string, model: string, verbose: boolean): Promise<string | null> {
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
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`LLM repo HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (verbose) console.warn(`LLM repo failed: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the LLM repo pass. Returns validated findings, or [] when no transport is
 * reachable, no source is gatherable, or anything fails. Never throws.
 */
export async function analyzeRepoWithLlm(
  repoPath: string,
  ctx: RepoContext,
  options: LlmRepoOptions = {},
): Promise<LlmRepoFinding[]> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  const useCli = !apiKey && isClaudeCliAvailable();
  if (!apiKey && !useCli) return [];

  const files = gatherSourceFiles(repoPath, ctx, options.maxFiles ?? MAX_FILES);
  if (files.length === 0) return [];

  const model = useCli ? options.model ?? 'cli-default' : options.model ?? DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(ctx, files);
  const allowed = new Set(files.map((f) => f.path));

  if (options.cacheDir) {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
    } catch {
      // best effort — caching is optional
    }
  }

  const key = crypto
    .createHash('sha256')
    .update(useCli ? 'cli' : 'api')
    .update('\0')
    .update(model)
    .update('\0')
    .update(SYSTEM_PROMPT)
    .update('\0')
    .update(userPrompt)
    .digest('hex');
  const cacheFile = options.cacheDir ? path.join(options.cacheDir, `${key}.json`) : null;

  let text: string | null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    text = fs.readFileSync(cacheFile, 'utf8');
  } else {
    text = useCli
      ? await callClaudeCli(`${SYSTEM_PROMPT}\n\n${userPrompt}`, options.model, options.verbose ?? false)
      : await callModel(userPrompt, apiKey as string, model, options.verbose ?? false);
    if (text && cacheFile) {
      try {
        fs.writeFileSync(cacheFile, text);
      } catch {
        // best effort
      }
    }
  }

  return text ? parseLlmRepoFindings(text, allowed) : [];
}
