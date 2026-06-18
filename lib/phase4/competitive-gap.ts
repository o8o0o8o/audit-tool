/**
 * Phase 4 — deterministic competitive-gap computation.
 *
 * Pure functions over crawl data (no network, no LLM), so the gap matrix is
 * reproducible: same pages in → same ranked gaps out. Reuses the existing
 * `ContentGapAnalyzer` keyword index + clustering so competitor topics are
 * derived exactly like our own.
 */

import { ContentGapAnalyzer } from '../analyzers/site-wide/content-gap-analyzer';
import { clampScore } from '../utils';
import type { PageInfo } from '../types';
import { buildTermIndex, bestTopicLabel, type TermIndexEntry } from './topic-extract';
import type { CompetitiveGap, CompetitorProfile, CompetitorTopic, GapType, KeywordInjection } from './types';

/** A topic to evaluate: a label, its signal keywords, and the competitor pages covering it. */
interface ResolvedTopic {
  label: string;
  keywords: string[];
  pages: Set<string>;
}

/**
 * Pages in `index` that cover any of `keywords` — matched on the exact term and
 * on each keyword's unigram tokens (so an LLM phrase keyword like "content
 * modeling" still finds pages indexed under "content" or "modeling").
 */
function pagesForKeywords(keywords: string[], index: Map<string, TermIndexEntry>): Set<string> {
  const tokens = new Set<string>();
  for (const k of keywords) {
    const kl = k.toLowerCase();
    tokens.add(kl);
    for (const t of kl.split(' ')) if (t) tokens.add(t);
  }
  const urls = new Set<string>();
  for (const t of tokens) for (const u of index.get(t)?.urls ?? []) urls.add(u);
  return urls;
}

/** A competitor cluster must cover at least this many pages to count as a topic. */
const MIN_COMPETITOR_PAGES = 2;
/** We're "thin" if our coverage is below this fraction of the competitor's. */
const THIN_RATIO = 0.5;
/** We're shallow ("depth" gap) if our best page is below this fraction of theirs. */
const DEPTH_RATIO = 0.6;
const MAX_GAPS = 25;

function wordCountOf(page: PageInfo | undefined): number {
  return page?.contentQuality?.wordCount ?? 0;
}

/**
 * Max word count over a set of URLs. A plain `Math.max(0, ...arr.map())` would
 * spread the array into call arguments and throw `RangeError` once a cluster
 * touches ~100k+ pages on a very large crawl; this folds instead.
 */
function maxWordCount(urls: Iterable<string>, pages: Record<string, PageInfo>): number {
  let max = 0;
  for (const u of urls) {
    const wc = wordCountOf(pages[u]);
    if (wc > max) max = wc;
  }
  return max;
}

/**
 * The OUR page most relevant to a topic — the one matching the most distinct
 * topic-keyword tokens, tiebroken by word count then URL. This is the page to
 * expand: a long but generic page (e.g. a manifesto) shouldn't win every topic
 * just for being long. Returns undefined when no page covers the topic.
 */
function bestMatchingPage(
  keywords: string[],
  index: Map<string, TermIndexEntry>,
  pages: Record<string, PageInfo>,
): string | undefined {
  const tokens = new Set<string>();
  for (const k of keywords) {
    const kl = k.toLowerCase();
    tokens.add(kl);
    for (const t of kl.split(' ')) if (t) tokens.add(t);
  }
  const hits = new Map<string, number>(); // url -> distinct topic tokens matched
  for (const t of tokens) for (const u of index.get(t)?.urls ?? []) hits.set(u, (hits.get(u) ?? 0) + 1);

  let best: string | undefined;
  let bestHits = -1;
  let bestWc = -1;
  for (const [u, h] of hits) {
    const wc = wordCountOf(pages[u]);
    if (h > bestHits || (h === bestHits && wc > bestWc) || (h === bestHits && wc === bestWc && (best === undefined || u < best))) {
      best = u;
      bestHits = h;
      bestWc = wc;
    }
  }
  return best;
}

/**
 * Match injected keyword data to a topic's keyword set. Returns the best
 * (highest-volume) match's volume/difficulty, or undefined when none match.
 */
function matchInjection(
  keywords: string[],
  injection: KeywordInjection | null,
): { volume?: number; difficulty?: number } {
  if (!injection?.keywords?.length) return {};
  const kwLower = keywords.map((k) => k.toLowerCase());
  let best: { volume?: number; difficulty?: number } | null = null;
  for (const row of injection.keywords) {
    const term = (row.term || '').toLowerCase().trim();
    if (!term) continue;
    const hit = kwLower.some((k) => k === term || k.includes(term) || term.includes(k));
    if (!hit) continue;
    if (!best || (row.volume ?? 0) > (best.volume ?? 0)) best = { volume: row.volume, difficulty: row.difficulty };
  }
  return best ?? {};
}

/**
 * Opportunity score (0–100) for a competitive gap. Designed to SPREAD across a
 * wide range rather than peg every "missing" topic to a ceiling: competitor
 * breadth and search demand are continuous (log-scaled, generously capped), and
 * the categorical bonuses (deficit type, specificity) are kept small so they
 * tune the ranking instead of dominating it. Exported for tests.
 *
 * Component ceilings — breadth 38, consensus 20, deficit 18, depth 12,
 * specificity 6 (max 94 without search data); injected volume adds up to 28 and
 * difficulty subtracts up to 12, so real demand dominates when present.
 */
export function scoreGap(g: {
  gapType: GapType;
  competitorPages: number;
  coveringCompetitors: number;
  competitorBestWordCount?: number;
  keywords: string[];
  searchVolume?: number;
  difficulty?: number;
}): number {
  // Competitor coverage breadth — log-scaled so 50 pages clearly outranks 4,
  // with no early flat cap (log10(51)≈1.71 → ~38; log10(5)≈0.70 → ~15).
  let score = Math.min(Math.log10(g.competitorPages + 1) * 22, 38);
  // Multi-competitor consensus — each independent competitor adds signal.
  score += Math.min(g.coveringCompetitors * 5, 20); // 1→5, 2→10, 3→15, 4+→20
  // Our deficit — kept modest so it tunes rather than saturates the ranking.
  score += g.gapType === 'missing' ? 18 : g.gapType === 'thin' ? 12 : 6;
  // Competitor depth — a long best page signals a substantial topic (3600w→12).
  score += Math.min((g.competitorBestWordCount ?? 0) / 300, 12);
  // Keyword specificity — longer phrases tend to be higher-intent (small nudge).
  const avgLen = g.keywords.length ? g.keywords.reduce((s, k) => s + k.length, 0) / g.keywords.length : 0;
  score += avgLen >= 10 ? 6 : avgLen >= 6 ? 3 : 0;
  // Real search data (injection) dominates when present: demand up, difficulty down.
  if (typeof g.searchVolume === 'number') score += Math.min(Math.log10(Math.max(g.searchVolume, 1)) * 8, 28);
  if (typeof g.difficulty === 'number') score -= Math.min(g.difficulty / 8, 12);
  return clampScore(score);
}

/**
 * Compute competitive content gaps: topics competitors cover that we cover
 * weakly or not at all. Returns up to {@link MAX_GAPS}, ranked by opportunity.
 */
export function computeCompetitiveGaps(
  ourPages: Record<string, PageInfo>,
  competitors: CompetitorProfile[],
  injection: KeywordInjection | null = null,
  llmTopics?: CompetitorTopic[],
): CompetitiveGap[] {
  const withPages = competitors.filter((c) => c.pagesCrawled > 0);
  if (!withPages.length) return [];

  const allCompPages: Record<string, PageInfo> = {};
  for (const c of withPages) Object.assign(allCompPages, c.pages);
  const compIndex = buildTermIndex(allCompPages);
  const ourIndex = buildTermIndex(ourPages);
  // Per-competitor term index, to count how many competitors cover a topic.
  const perComp = withPages.map((c) => ({ profile: c, kw: buildTermIndex(c.pages) }));

  // Topics come from the LLM taxonomy (--llm: clean, de-branded, top-down) when
  // supplied, else from lexical clustering of the cleaned term index (keyless,
  // deterministic). Both reduce to {label, keywords, pages}; pages for LLM
  // topics are resolved deterministically from the term index.
  let topics: ResolvedTopic[];
  if (llmTopics && llmTopics.length) {
    topics = llmTopics.map((t) => ({
      label: t.label,
      keywords: t.keywords,
      pages: pagesForKeywords(t.keywords, compIndex),
    }));
  } else {
    topics = [...ContentGapAnalyzer.clusterKeywords(compIndex).values()].map((c) => ({
      label: bestTopicLabel(c.topic, c.keywords, compIndex),
      keywords: c.keywords,
      pages: c.pages,
    }));
  }

  const gaps: CompetitiveGap[] = [];
  for (const topic of topics) {
    const competitorPages = topic.pages.size;
    if (competitorPages < MIN_COMPETITOR_PAGES) continue;

    // Our coverage = distinct OUR pages touching the topic's keywords.
    const ourPagesSet = pagesForKeywords(topic.keywords, ourIndex);
    const ourCount = ourPagesSet.size;
    const ourBestWordCount = maxWordCount(ourPagesSet, ourPages);

    // Competitor depth + breadth.
    const competitorBestWordCount = maxWordCount(topic.pages, allCompPages);
    let coveringCompetitors = 0;
    let bestCompetitor: string | null = null;
    let bestCompetitorPages = 0;
    for (const { profile, kw } of perComp) {
      const covers = pagesForKeywords(topic.keywords, kw).size;
      if (covers > 0) {
        coveringCompetitors++;
        if (covers > bestCompetitorPages) {
          bestCompetitorPages = covers;
          bestCompetitor = profile.host;
        }
      }
    }

    // Classify the gap; skip topics we already cover adequately.
    let gapType: GapType | null = null;
    if (ourCount === 0) gapType = 'missing';
    else if (ourCount < competitorPages * THIN_RATIO) gapType = 'thin';
    else if (competitorBestWordCount > 0 && ourBestWordCount < competitorBestWordCount * DEPTH_RATIO) gapType = 'depth';
    if (!gapType) continue;

    const keywords = topic.keywords.slice(0, 6);
    const { volume, difficulty } = matchInjection(keywords, injection);

    // Examples: our pages first, then a competitor example for the topic.
    const ourExamples = [...ourPagesSet].slice(0, 3);
    const examples = ourExamples.slice(0, 2);
    const compExample = [...topic.pages][0];
    if (compExample) examples.push(compExample);

    gaps.push({
      topic: topic.label,
      keywords,
      ourPages: ourCount,
      ourBestWordCount,
      ourExamples,
      ourBestExample: bestMatchingPage(topic.keywords, ourIndex, ourPages),
      competitorPages,
      coveringCompetitors,
      competitorBestWordCount,
      bestCompetitor,
      gapType,
      opportunityScore: scoreGap({
        gapType,
        competitorPages,
        coveringCompetitors,
        competitorBestWordCount,
        keywords,
        searchVolume: volume,
        difficulty,
      }),
      searchVolume: volume,
      difficulty,
      examples,
    });
  }

  gaps.sort((a, b) => b.opportunityScore - a.opportunityScore || a.topic.localeCompare(b.topic));
  return gaps.slice(0, MAX_GAPS);
}

/** Opportunity score for an internal thin-coverage topic (no competitor data). */
function selfScore(keywords: string[], pageCount: number): number {
  let score = 30;
  score += Math.min(keywords.length * 6, 30); // topic breadth
  score += pageCount === 1 ? 25 : 10; // single page = bigger opportunity than two
  const avgLen = keywords.length ? keywords.reduce((s, k) => s + k.length, 0) / keywords.length : 0;
  score += avgLen >= 8 ? 10 : avgLen >= 5 ? 5 : 0; // specificity
  return clampScore(score);
}

/**
 * Fallback when there are no competitors: surface OUR thinnest topics as gaps,
 * over the SAME cleaned term index used for the competitive path (so the
 * fallback is consistent and equally noise-filtered). Topics we cover on only
 * 1–2 pages are the internal content opportunities.
 */
export function computeSelfGaps(ourPages: Record<string, PageInfo>): CompetitiveGap[] {
  const index = buildTermIndex(ourPages);
  const clusters = ContentGapAnalyzer.clusterKeywords(index);
  const gaps: CompetitiveGap[] = [];
  clusters.forEach((cluster) => {
    if (cluster.pageCount < 1 || cluster.pageCount > 2) return; // thin topics only
    const keywords = cluster.keywords.slice(0, 6);
    gaps.push({
      topic: bestTopicLabel(cluster.topic, cluster.keywords, index),
      keywords,
      ourPages: cluster.pageCount,
      ourBestWordCount: maxWordCount(cluster.pages, ourPages),
      ourExamples: [...cluster.pages].slice(0, 3),
      ourBestExample: bestMatchingPage(cluster.keywords, index, ourPages),
      competitorPages: 0,
      coveringCompetitors: 0,
      competitorBestWordCount: 0,
      bestCompetitor: null,
      gapType: 'thin', // self-gaps are our own under-covered terms, never "missing"
      opportunityScore: selfScore(keywords, cluster.pageCount),
      examples: [...cluster.pages].slice(0, 3),
    });
  });
  gaps.sort((a, b) => b.opportunityScore - a.opportunityScore || a.topic.localeCompare(b.topic));
  return gaps.slice(0, MAX_GAPS);
}
