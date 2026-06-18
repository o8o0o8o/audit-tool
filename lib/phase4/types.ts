/**
 * Phase 4 — Competitive Content Research types.
 *
 * Kept deliberately narrow: the phase reads the Phase 1 crawl off disk, crawls a
 * bounded sample of competitor content, and emits a standalone report + a
 * versioned state file (mirroring `phase2-state.json`).
 */

import type { PageInfo } from '../types';

export interface ContentResearchOptions {
  /** Surface fetch/LLM errors and per-step progress. */
  verbose?: boolean;
  /** Explicit competitor URLs (robots.ts resolves these from --competitors or config). */
  competitors?: string[];
  /**
   * Enable the optional LLM steps (competitor discovery when none are supplied,
   * and content-plan synthesis). When false/undefined the phase still runs fully
   * on its deterministic substrate. Defaults to "use LLM if a transport exists".
   */
  llm?: boolean;
}

/** A competitor's crawled content reduced to topic signal. */
export interface CompetitorProfile {
  /** Normalised origin, e.g. `https://example.com`. */
  origin: string;
  host: string;
  pagesCrawled: number;
  pagesAttempted: number;
  /** url -> minimal PageInfo carrying `contentQuality.topKeywords` + `wordCount`. */
  pages: Record<string, PageInfo>;
  /** True when this competitor was suggested by the LLM rather than supplied. */
  discovered: boolean;
  /** Set when the competitor could not be crawled at all. */
  error?: string;
}

export type GapType = 'missing' | 'thin' | 'depth';

export interface CompetitiveGap {
  /** Cluster topic label (the dominant keyword). */
  topic: string;
  /** Representative keywords for the topic. */
  keywords: string[];
  /** How many of OUR pages cover the topic. */
  ourPages: number;
  /** Largest word count among our pages on the topic (0 when none). */
  ourBestWordCount: number;
  /** How many competitor pages (across all competitors) cover the topic. */
  competitorPages: number;
  /** How many distinct competitors cover the topic. */
  coveringCompetitors: number;
  /** Largest competitor word count on the topic. */
  competitorBestWordCount: number;
  /** Host of the competitor with the deepest coverage, for the example link. */
  bestCompetitor: string | null;
  gapType: GapType;
  /** 0–100; higher = bigger opportunity. */
  opportunityScore: number;
  /** Monthly search volume, when supplied via the injection file. */
  searchVolume?: number;
  /** Keyword difficulty 0–100, when supplied via the injection file. */
  difficulty?: number;
  /** Example URLs — our pages first (if any), then a competitor example. */
  examples: string[];
  /** OUR pages that cover the topic (up to 3) — the pages to expand. Empty when missing. */
  ourExamples: string[];
  /** OUR deepest page on the topic (highest word count) — the primary expand target. */
  ourBestExample?: string;
}

export interface ContentPlanItem {
  priority: number;
  /** Suggested article/page title. */
  title: string;
  /** Short topic label (2–4 words, de-branded) — surfaced as the gap-matrix label on the LLM path. */
  topic?: string;
  /** Whether to create a new page or expand an existing one (derived from our coverage). */
  action?: 'create' | 'expand';
  /** The existing page URL to expand (when action === 'expand'). */
  targetPage?: string;
  targetKeywords: string[];
  /** Why this matters — the gap it closes. */
  rationale: string;
  /** e.g. "New pillar guide", "Topic-cluster expansion", "Depth upgrade". */
  format: string;
  suggestedWordCount: number;
  /** 1–3 sentence editorial brief. */
  brief: string;
}

/**
 * A competitor content topic: a clean label plus the keywords/terms that signal
 * it. Produced top-down by the LLM taxonomy pass (`topic-taxonomy.ts`) on the
 * `--llm` path; the keyless path derives the same shape from lexical clusters.
 */
export interface CompetitorTopic {
  label: string;
  keywords: string[];
}

/** Optional drop-in keyword data (`<runDir>/content-research-data.json`). */
export interface KeywordInjection {
  keywords: Array<{ term: string; volume?: number; difficulty?: number }>;
}

/** Versioned render inputs persisted for standalone re-runs. */
export interface ContentResearchState {
  version: 1;
  generatedAt: string;
  ourOrigin: string;
  competitors: Array<{ origin: string; pagesCrawled: number; discovered: boolean; error?: string }>;
  gaps: CompetitiveGap[];
  plan: ContentPlanItem[];
  /** True when the injection file enriched the gaps with real search data. */
  enriched: boolean;
  /** True when an LLM produced the content plan (vs the templated builder). */
  llmPlan: boolean;
  /** True when there were no competitors and the phase fell back to self-gaps. */
  selfOnly: boolean;
}
