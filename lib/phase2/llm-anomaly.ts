/**
 * Optional LLM anomaly-detection pass for Phase 2.
 *
 * Rule-based analyzers can only find what they were coded to look for. This
 * pass gives Claude the captured evidence for each representative page — the
 * screenshot (vision) plus structured signals (buttons, links + HTTP statuses,
 * forms, pagination state, network requests) — and asks it to surface
 * UNEXPECTED functional/UX problems the deterministic checks miss: dead
 * buttons, CTAs to 404s, never-terminating pagination, forms posting nowhere,
 * visually broken layout, placeholder content, and so on.
 *
 * Design mirrors llm-narrative.ts:
 *   • No SDK dependency — Anthropic's API is a vanilla HTTPS POST.
 *   • Gated on `ANTHROPIC_API_KEY`. Returns [] when absent or on any failure.
 *   • Disk-cached by SHA of (model, system, page-signals, screenshot bytes) so
 *     re-runs are free.
 *   • Bounded cost: runs only over the small representative-page sample.
 *
 * Cost: vision + signals at Sonnet pricing is roughly $0.02–0.05 per page;
 * a default 10-page sample is ~$0.2–0.5 per audit.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { PageInfo } from '../types';
import type { Section } from './categorize';
import type { AuditArtifacts } from './types';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic rejects images over 5MB; skip vision (signals only) past this. */
const MAX_IMAGE_BYTES = 4_500_000;

const VALID_SECTIONS: Section[] = ['performance', 'seo', 'privacy', 'accessibility', 'ux', 'technical'];
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** One LLM-discovered problem, ready to merge into a report section. */
export interface Anomaly {
  section: Section;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  url: string;
  evidence: string;
  recommendation: string;
}

export interface AnomalyOptions {
  cacheDir?: string;
  model?: string;
  apiKey?: string;
  verbose?: boolean;
  /** Cap on representative pages analysed (cost guard). Default: all sampled. */
  maxPages?: number;
}

const SYSTEM_PROMPT = `You are a senior web QA engineer reviewing ONE page of a website during a technical audit. You receive a screenshot plus structured signals (buttons, links with their HTTP statuses, forms, pagination state, failed network requests).

Find UNEXPECTED, concrete problems that automated rule-based checks miss — especially broken or non-functional UI and logic:
- Buttons or links that go nowhere, to a 404/5xx, or to "#"
- Calls-to-action whose label doesn't match their destination
- Pagination that appears unbounded / never terminates, or "load more" that re-fetches identical content
- Forms with no action, posting to the wrong place, or missing critical fields
- Visually broken layout: overlapping or cut-off content, invisible text, missing images
- Placeholder or contradictory content (lorem ipsum, "TODO", test data)
- Anything a human would immediately call a bug

Rules:
- Report ONLY concrete problems you can point to in the supplied evidence. No speculation. No generic SEO/performance/accessibility advice — other checks cover those.
- If the page looks fine, return an empty array. That is the correct and common answer.
- Each finding must cite the specific evidence (button text, the URL, the status code, what is visible in the screenshot).
- severity by user impact: critical = broken core flow; high = broken important element; medium = degraded; low = minor.
- section = the single best of: performance | seo | privacy | accessibility | ux | technical. Functional/visual bugs are usually "ux" or "technical".

Output ONLY a JSON array (no prose, no markdown fences). Each item:
{"title": string (<=80 chars), "severity": "critical|high|medium|low", "section": "...", "evidence": string, "recommendation": string}
Return [] when nothing is wrong.`;

/** Compact, token-frugal view of a page's interactive signals. */
function buildSignals(page: PageInfo | undefined, requests: RequestsFile | null): Record<string, unknown> {
  const link = page?.linkAnalysis ?? {};
  const failedRequests: Array<{ url: string; status: number; type?: string }> = [];
  if (requests?.requests) {
    for (const [url, r] of Object.entries(requests.requests)) {
      if (typeof r.status === 'number' && r.status >= 400) {
        failedRequests.push({ url, status: r.status, type: r.resourceType });
      }
    }
  }
  const pg = page?.paginationData;
  return {
    title: page?.title,
    buttons: (page?.buttons ?? []).slice(0, 40).map((b) => ({ text: b.text, type: b.type })),
    forms: (page?.forms ?? []).slice(0, 10).map((f) => ({ action: f.action, method: f.method, inputs: Array.isArray(f.inputs) ? f.inputs.length : undefined })),
    brokenLinks: Array.isArray(link.brokenLinks) ? link.brokenLinks.slice(0, 20) : undefined,
    emptyAnchorLinks: link.emptyAnchorLinks?.slice(0, 15),
    genericAnchorLinks: link.genericAnchorLinks?.slice(0, 15),
    redirectLinks: link.redirectLinks?.slice(0, 15),
    pagination: pg
      ? {
          hasPagination: pg.hasPagination,
          type: pg.type,
          currentPage: pg.currentPage,
          totalPages: pg.totalPages,
          infiniteScrollDetected: pg.infiniteScrollDetected,
          loadMoreDetected: pg.loadMoreDetected,
          linkCount: pg.paginationLinks?.length,
        }
      : undefined,
    ctas: (page?.ctaData?.ctas ?? page?.ctas ?? []).slice(0, 20),
    failedRequests: failedRequests.slice(0, 25),
  };
}

interface RequestsFile {
  url?: string;
  requests?: Record<string, { status?: number; resourceType?: string }>;
}

/** Read + gunzip a JSON file (handles both .json and .json.gz). */
function readMaybeGz<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Build a url→PageInfo map for only the sampled URLs (reads page batches). */
function loadSampledPages(runDir: string, wanted: Set<string>): Record<string, PageInfo> {
  const out: Record<string, PageInfo> = {};
  const pagesDir = path.join(runDir, 'pages');
  if (!fs.existsSync(pagesDir)) return out;
  for (const file of fs.readdirSync(pagesDir)) {
    const batch = readMaybeGz<{ pages?: Record<string, PageInfo> }>(path.join(pagesDir, file));
    if (!batch?.pages) continue;
    for (const [url, page] of Object.entries(batch.pages)) {
      if (wanted.has(url)) out[url] = page;
    }
  }
  return out;
}

/** Pick the best on-disk screenshot for a page's evidence dir, or null. */
function pickScreenshot(evidenceDir: string, files: string[]): { data: string; mediaType: string } | null {
  const candidates = ['screenshot.desktop.png', 'screenshot.mobile.png'].filter((f) => files.includes(f));
  for (const name of candidates) {
    const file = path.join(evidenceDir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_IMAGE_BYTES) continue; // too big for the API
      return { data: fs.readFileSync(file).toString('base64'), mediaType: 'image/png' };
    } catch {
      // try next
    }
  }
  return null;
}

/** Defensively parse the model's JSON-array reply into validated anomalies.
 *  Exported for unit testing. */
export function parseAnomalies(text: string, url: string): Anomaly[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Anomaly[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
    if (!title || !evidence) continue;
    const severity = (VALID_SEVERITIES.includes(o.severity as string) ? o.severity : 'medium') as Anomaly['severity'];
    const section = (VALID_SECTIONS.includes(o.section as Section) ? o.section : 'technical') as Section;
    const recommendation = typeof o.recommendation === 'string' ? o.recommendation.trim() : '';
    out.push({ section, title: title.slice(0, 120), severity, url, evidence, recommendation });
  }
  return out;
}

/** Call Claude (vision + signals) for one page. Returns raw JSON-array text. */
async function callModel(
  userPrompt: string,
  screenshot: { data: string; mediaType: string } | null,
  apiKey: string,
  model: string,
  verbose: boolean,
): Promise<string | null> {
  const content: unknown[] = [];
  if (screenshot) {
    content.push({ type: 'image', source: { type: 'base64', media_type: screenshot.mediaType, data: screenshot.data } });
  }
  content.push({ type: 'text', text: userPrompt });

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
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      if (verbose) {
        const body = await res.text().catch(() => '');
        console.warn(`LLM anomaly HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === 'text')?.text?.trim() ?? null;
  } catch (error: unknown) {
    if (verbose) console.warn(`LLM anomaly failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Detect emergent functional/UX anomalies across the representative-page
 * sample. Returns [] when evidence or the API key is missing, or on failure.
 */
export async function detectAnomalies(artifacts: AuditArtifacts, options: AnomalyOptions = {}): Promise<Anomaly[]> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
  const evidence = artifacts.manifest.evidence;
  if (!apiKey || !evidence || Object.keys(evidence).length === 0) return [];

  const model = options.model ?? DEFAULT_MODEL;
  let entries = Object.entries(evidence).filter(([, info]) => info.url);
  if (typeof options.maxPages === 'number' && options.maxPages > 0) {
    entries = entries.slice(0, options.maxPages);
  }

  const wanted = new Set(entries.map(([, info]) => info.url as string));
  const pages = loadSampledPages(artifacts.runDir, wanted);

  if (options.cacheDir) {
    try {
      fs.mkdirSync(options.cacheDir, { recursive: true });
    } catch {
      // best effort — caching is optional
    }
  }

  const results = await Promise.all(
    entries.map(async ([safeName, info]) => {
      const url = info.url as string;
      const evidenceDir = path.join(artifacts.runDir, 'evidence', safeName);
      const requests = readMaybeGz<RequestsFile>(path.join(evidenceDir, 'requests.json'));
      const signals = buildSignals(pages[url], requests);
      const screenshot = pickScreenshot(evidenceDir, info.files);
      const userPrompt = `Page URL: ${url}\n\nStructured signals (JSON):\n${JSON.stringify(signals, null, 1)}\n\nReview the screenshot and signals. Return the JSON array of problems.`;

      // Cache by everything that affects the answer, incl. the image bytes.
      const key = crypto
        .createHash('sha256')
        .update(model)
        .update('\0')
        .update(SYSTEM_PROMPT)
        .update('\0')
        .update(userPrompt)
        .update('\0')
        .update(screenshot?.data ?? 'no-image')
        .digest('hex');
      const cacheFile = options.cacheDir ? path.join(options.cacheDir, `${key}.json`) : null;

      let text: string | null;
      if (cacheFile && fs.existsSync(cacheFile)) {
        text = fs.readFileSync(cacheFile, 'utf8');
      } else {
        text = await callModel(userPrompt, screenshot, apiKey, model, options.verbose ?? false);
        if (text && cacheFile) {
          try {
            fs.writeFileSync(cacheFile, text);
          } catch {
            // best effort
          }
        }
      }
      return text ? parseAnomalies(text, url) : [];
    }),
  );

  return results.flat();
}
