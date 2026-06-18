/**
 * Phase 4 — topic-term extraction.
 *
 * The crawl's per-page `topKeywords` were built for on-page keyword-density
 * metrics, not topic research: they include code identifiers, URL/GTM fragments
 * scraped from markup, and other noise. This module derives a cleaner topic
 * signal for the competitive-gap analysis from the fields that actually survive
 * storage AND describe topics — the page **title** and **h1** — plus the
 * `topKeywords` that pass a content-term filter. Title/h1 also contribute
 * adjacent **bigrams** so real phrases ("content modeling") surface, not just
 * single words.
 *
 * Symmetric by construction: our on-disk pages keep `title` + `headings.h1`
 * (h2–h6 are stripped to counts) and competitor pages carry the same fields, so
 * both sides are indexed from the same signal and the gap comparison is fair.
 */

import { STOP_WORDS } from '../constants';
import type { PageInfo } from '../types';

/**
 * Programming keywords / generic code nouns that frequently top the keyword
 * counts of code-heavy docs but are never real content topics. Deliberately
 * narrow — only unambiguous code tokens, NOT product words like "config",
 * "data", or "create" that can legitimately be topics.
 */
const CODE_TOKENS = new Set([
  'const', 'await', 'async', 'function', 'return', 'import', 'export', 'default',
  'null', 'undefined', 'true', 'false', 'void', 'typeof', 'instanceof',
  'props', 'params', 'param', 'args', 'argv', 'callback', 'promise',
  'string', 'boolean', 'number', 'object', 'array', 'enum', 'interface',
]);

/**
 * Is `raw` a plausible content term? Normalises to letters-only, then requires:
 * length 4–24, contains a vowel, no `http`/`www`/`gtm` fragment, not a stop word
 * or code token. Pure and exported for tests.
 */
export function isContentTerm(raw: string): boolean {
  const t = (raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t.length < 4 || t.length > 24) return false; // junk concatenations (srchttps…) are long
  if (!/[aeiouy]/.test(t)) return false; // consonant-only tokens are not words
  if (t.includes('http') || t.includes('www') || t.includes('gtm')) return false; // URL/GTM fragments
  if (STOP_WORDS.has(t) || CODE_TOKENS.has(t)) return false;
  return true;
}

/** Tokenise a phrase into lowercase word tokens (letters only). */
function tokenize(phrase: string): string[] {
  return (phrase || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Content unigrams + adjacent content bigrams from a phrase. A bigram is formed
 * only from two consecutive tokens that are BOTH content terms (no stop word
 * between), so phrases stay tight ("content modeling", not "content for model").
 */
function phraseTerms(phrase: string): string[] {
  const tokens = tokenize(phrase);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isContentTerm(tokens[i])) continue;
    out.push(tokens[i]);
    if (i + 1 < tokens.length && isContentTerm(tokens[i + 1])) {
      out.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  return out;
}

/**
 * The set of topic terms for a page: title + h1 phrases/bigrams, plus the
 * page's `topKeywords` that pass the content filter. De-duplicated per page.
 */
export function extractPageTerms(page: PageInfo): Set<string> {
  const terms = new Set<string>();
  if (page.title) for (const t of phraseTerms(page.title)) terms.add(t);
  for (const h of page.headings?.h1 ?? []) for (const t of phraseTerms(h)) terms.add(t);
  for (const kw of page.contentQuality?.topKeywords ?? []) {
    const w = (kw?.word ?? '').toLowerCase();
    if (isContentTerm(w)) terms.add(w);
  }
  return terms;
}

/** Title-case a term/phrase for display ("content modeling" → "Content Modeling"). */
export function titleCase(s: string): string {
  return (s || '')
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** One entry of the term index, structurally compatible with `ContentGapAnalyzer`. */
export interface TermIndexEntry {
  word: string;
  urls: Set<string>;
  totalDensity: number;
  avgDensity: number | string;
}

/**
 * Choose a human-readable topic label for a cluster. `ContentGapAnalyzer`
 * names a cluster after its single most-frequent term, which is almost always a
 * bare unigram ("documentation"). This prefers a representative multi-word
 * PHRASE from the cluster instead ("documentation reference"): among the
 * cluster's phrases, the one most-supported across pages, preferring phrases
 * that contain the cluster seed so the label stays on-topic. Falls back to the
 * seed word when the cluster has no phrase. Returns lowercase (callers
 * title-case for display); deterministic via a total-order tiebreak.
 */
export function bestTopicLabel(seed: string, keywords: string[], index: Map<string, TermIndexEntry>): string {
  const phrases = keywords.filter((k) => k.includes(' '));
  if (!phrases.length) return seed;
  const support = (p: string) => index.get(p)?.urls.size ?? 0;
  const onTopic = phrases.filter((p) => p.split(' ').includes(seed));
  const pool = onTopic.length ? onTopic : phrases;
  // Most cross-page support first; then shorter (more generic); then lexical.
  pool.sort((a, b) => support(b) - support(a) || a.length - b.length || a.localeCompare(b));
  return pool[0];
}

/**
 * Build a `term -> { urls }` index over pages, shaped to feed
 * `ContentGapAnalyzer.clusterKeywords`. Density is unused by Phase 4 scoring,
 * so it is left at 0.
 */
export function buildTermIndex(pages: Record<string, PageInfo>): Map<string, TermIndexEntry> {
  const index = new Map<string, TermIndexEntry>();
  for (const url in pages) {
    for (const term of extractPageTerms(pages[url])) {
      let entry = index.get(term);
      if (!entry) {
        entry = { word: term, urls: new Set<string>(), totalDensity: 0, avgDensity: 0 };
        index.set(term, entry);
      }
      entry.urls.add(url);
    }
  }
  return index;
}
