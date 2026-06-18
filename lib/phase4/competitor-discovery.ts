/**
 * Phase 4 — optional LLM competitor discovery.
 *
 * Used ONLY when no competitors were supplied. Builds a compact product summary
 * from our crawled homepage/top topics and asks the model for likely content
 * competitors. Every returned URL is validated (parseable, public host) before
 * it is crawled — an anti-hallucination guard mirroring `parseLlmRepoFindings`.
 */

import { CONTENT_RESEARCH } from '../constants';
import { validateURL, isFetchAllowed } from '../../validators';
import { callLlmText, extractJson } from './llm-client';
import { normaliseOrigin } from './competitor-crawl';

export interface ProductSummary {
  origin: string;
  title?: string;
  description?: string;
  headings: string[];
  topTopics: string[];
}

const SYSTEM_PROMPT = `You identify a website's main CONTENT competitors — sites competing for the same organic search audience and topics, not just direct product rivals.

Return STRICT JSON only: {"competitors": ["https://example.com", ...]}.
Rules:
- 3 to 5 competitors, most relevant first.
- Full https:// origins (scheme + host), no paths.
- Real, well-known sites in the same space. Do not invent domains.
- No explanation, no prose, JSON only.`;

function buildUserPrompt(s: ProductSummary): string {
  const lines = [
    `Our site: ${s.origin}`,
    s.title ? `Title: ${s.title}` : '',
    s.description ? `Description: ${s.description}` : '',
    s.headings.length ? `Headings: ${s.headings.slice(0, 8).join(' | ')}` : '',
    s.topTopics.length ? `Top topics/keywords: ${s.topTopics.slice(0, 15).join(', ')}` : '',
    '',
    'List this site\'s main content competitors as JSON.',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Validate and de-duplicate an LLM-supplied competitor list. Anti-hallucination
 * guard: each item must be a parseable, public-host URL; our own host and
 * duplicates are dropped; capped at MAX_COMPETITORS. Pure and exported for
 * tests. Non-string / unparseable / private items are silently dropped.
 */
export function filterValidCompetitors(items: unknown[], ourHost: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const origin = normaliseOrigin(item);
    if (!origin) continue;
    if (!validateURL(origin).valid) continue;
    if (!isFetchAllowed(origin).allowed) continue;
    const host = new URL(origin).host;
    if (host === ourHost) continue; // never "compete" against ourselves
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(origin);
    if (out.length >= CONTENT_RESEARCH.MAX_COMPETITORS) break;
  }
  return out;
}

/**
 * Ask the LLM for competitor origins. Returns a validated, de-duplicated list
 * (≤ MAX_COMPETITORS), excluding our own host. Returns [] on any failure or
 * when no transport is available.
 */
export async function discoverCompetitors(
  summary: ProductSummary,
  opts: { cacheDir?: string; verbose?: boolean } = {},
): Promise<string[]> {
  const raw = await callLlmText({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(summary),
    cacheDir: opts.cacheDir,
    cacheTag: 'discover',
    maxTokens: 400,
    verbose: opts.verbose,
  });
  const parsed = extractJson<{ competitors?: unknown }>(raw);
  const list = Array.isArray(parsed?.competitors) ? parsed!.competitors : [];

  let ourHost = '';
  try {
    ourHost = new URL(summary.origin).host;
  } catch {
    /* ignore */
  }

  const out = filterValidCompetitors(list, ourHost);
  if (opts.verbose) console.log(`   LLM suggested ${out.length} competitor(s): ${out.join(', ') || '(none)'}`);
  return out;
}
