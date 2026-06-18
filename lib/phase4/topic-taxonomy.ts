/**
 * Phase 4 — LLM topic taxonomy (top-down).
 *
 * Instead of growing topics bottom-up by lexical prefix/substring clustering
 * (which over-merges "brand"+"branch" and yields rough bigram labels), this asks
 * the model to read the competitor corpus (page titles + h1s) and name a clean
 * set of real CONTENT topics, each with the keywords/terms that signal it.
 * Deterministic code then maps pages to those topics via the term index, so only
 * the topic SET + labels come from the LLM — the page counts stay reproducible.
 *
 * Keyless fallback: returns null when no transport is available or the reply is
 * unusable, and `competitive-gap.ts` falls back to lexical clustering. Honors the
 * low-effort LLM policy via the shared transport.
 */

import { callLlmText, extractJson } from './llm-client';
import type { CompetitorProfile, CompetitorTopic } from './types';

/** Max topics to keep; max title/h1 lines fed to the model. */
const MAX_TOPICS = 20;
const MAX_CORPUS_LINES = 120;
const MAX_KEYWORDS_PER_TOPIC = 8;

const SYSTEM_PROMPT = `You are an SEO content strategist building a topic map of a market from competitor pages.

You are given page titles and headings from several competitor sites. Identify the distinct CONTENT TOPICS this market covers.

Return STRICT JSON only: {"topics": [{"label": "Content Modeling", "keywords": ["content modeling", "schema", "fields", "structured content"]}]}.
Rules:
- 10–15 distinct, non-overlapping topics covering the major themes.
- "label": a clean 2–4 word Title Case topic name with NO brand/product names (say "Headless CMS", not "Contentful").
- "keywords": 3–8 lowercase terms/phrases that signal the topic and would appear on a page about it. Use generic terms, not brand names.
- Topics must be real subject areas a content team would write about, not navigation labels ("pricing", "login") or single generic words.
- JSON only, no prose.`;

/** Build a compact, de-duplicated corpus of "title — h1" lines from competitors. */
function buildCorpus(competitors: CompetitorProfile[]): string {
  const lines = new Set<string>();
  for (const c of competitors) {
    for (const url in c.pages) {
      const p = c.pages[url];
      const title = (p.title ?? '').replace(/\s+/g, ' ').trim();
      const h1 = (p.headings?.h1?.[0] ?? '').replace(/\s+/g, ' ').trim();
      const line = [title, h1].filter(Boolean).join(' — ');
      if (line) lines.add(line);
      if (lines.size >= MAX_CORPUS_LINES) return [...lines].join('\n');
    }
  }
  return [...lines].join('\n');
}

/**
 * Parse + validate the taxonomy reply. Drops malformed entries; lowercases
 * keywords; caps counts. Returns null when nothing usable parses. Pure and
 * exported for tests.
 */
export function parseTaxonomy(raw: string | null): CompetitorTopic[] | null {
  const parsed = extractJson<{ topics?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.topics)) return null;
  const out: CompetitorTopic[] = [];
  const seen = new Set<string>();
  for (const t of parsed.topics) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as { label?: unknown; keywords?: unknown };
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!label || seen.has(label.toLowerCase())) continue;
    if (!Array.isArray(rec.keywords)) continue;
    const keywords = rec.keywords
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.toLowerCase().trim())
      .filter(Boolean)
      .slice(0, MAX_KEYWORDS_PER_TOPIC);
    if (!keywords.length) continue;
    seen.add(label.toLowerCase());
    out.push({ label, keywords });
    if (out.length >= MAX_TOPICS) break;
  }
  return out.length ? out : null;
}

/**
 * Derive a topic taxonomy from competitor pages via the LLM. Returns null when
 * no transport is reachable, the corpus is empty, or the reply is unusable — the
 * caller then falls back to lexical clustering.
 */
export async function deriveTopicTaxonomy(
  competitors: CompetitorProfile[],
  opts: { cacheDir?: string; verbose?: boolean } = {},
): Promise<CompetitorTopic[] | null> {
  const corpus = buildCorpus(competitors);
  if (!corpus) return null;
  const raw = await callLlmText({
    system: SYSTEM_PROMPT,
    user: `Competitor page titles and headings:\n${corpus}\n\nReturn the topic taxonomy as JSON.`,
    cacheDir: opts.cacheDir,
    cacheTag: 'taxonomy',
    maxTokens: 1800,
    verbose: opts.verbose,
  });
  const topics = parseTaxonomy(raw);
  if (opts.verbose) console.log(`   LLM topic taxonomy: ${topics?.length ?? 0} topic(s)`);
  return topics;
}
