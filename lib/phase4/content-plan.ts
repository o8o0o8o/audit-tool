/**
 * Phase 4 — deterministic content-plan builder.
 *
 * Turns ranked competitive gaps into prioritised content-plan items. This is the
 * keyless fallback; when an LLM transport is available the runner upgrades these
 * with richer titles/briefs (see `content-synthesis.ts`), but the structure and
 * priorities come from here so the plan is always present and reproducible.
 */

import { titleCase } from './topic-extract';
import type { CompetitiveGap, ContentPlanItem } from './types';

const MAX_PLAN_ITEMS = 15;

/** Resolved action for one plan item. */
export interface PlanAction {
  action: 'create' | 'expand';
  targetPage?: string;
}

/**
 * Resolve create-vs-expand for each gap, de-duplicating expand targets across
 * the (opportunity-sorted) gap list: the highest-opportunity topic claims a
 * page; any later topic whose best page is already claimed becomes "create" —
 * the honest advice, since one broad page shouldn't be expanded into several
 * distinct pillars. Index-aligned with `gaps`. Exported so the templated and
 * LLM plan paths resolve actions identically.
 */
export function resolvePlanActions(gaps: CompetitiveGap[]): PlanAction[] {
  const claimed = new Set<string>();
  return gaps.map((g) => {
    const page = g.ourBestExample;
    if (g.ourPages === 0 || !page || claimed.has(page)) return { action: 'create' };
    claimed.add(page);
    return { action: 'expand', targetPage: page };
  });
}

function formatFor(action: PlanAction): string {
  return action.action === 'expand' ? 'Expand existing page' : 'New pillar guide';
}

function suggestedTitle(gap: CompetitiveGap, action: PlanAction): string {
  const topic = titleCase(gap.topic);
  return action.action === 'expand' ? `Expand your ${topic} coverage` : `${topic}: a complete guide`;
}

function rationaleFor(gap: CompetitiveGap): string {
  const parts: string[] = [];
  if (gap.gapType === 'missing') {
    parts.push(
      `Competitors publish ${gap.competitorPages} page(s) on this topic${gap.coveringCompetitors >= 2 ? ` (${gap.coveringCompetitors} of them)` : ''}; you have none.`,
    );
  } else if (gap.gapType === 'thin') {
    parts.push(`You cover this on ${gap.ourPages} page(s) vs ${gap.competitorPages} across competitors.`);
  } else {
    parts.push(
      `Your best page is ~${gap.ourBestWordCount} words vs ~${gap.competitorBestWordCount} for the leading competitor.`,
    );
  }
  if (typeof gap.searchVolume === 'number') {
    parts.push(`~${gap.searchVolume.toLocaleString('en-US')} monthly searches${typeof gap.difficulty === 'number' ? `, difficulty ${gap.difficulty}` : ''}.`);
  }
  return parts.join(' ');
}

function suggestedWordCount(gap: CompetitiveGap): number {
  const target = Math.max(gap.competitorBestWordCount, 1200);
  return Math.round(target / 100) * 100;
}

function briefFor(gap: CompetitiveGap, action: PlanAction): string {
  const adjacent = gap.keywords.slice(1, 4).join(', ') || gap.topic;
  const words = suggestedWordCount(gap);
  if (action.action === 'expand') {
    return `Expand your existing page ${action.targetPage} to cover ${gap.topic} in depth (${adjacent}) and bring it to roughly ${words} words.`;
  }
  return `Create a new page covering ${gap.topic} and adjacent terms (${adjacent}) in a single authoritative piece of roughly ${words} words.`;
}

export function buildContentPlan(gaps: CompetitiveGap[]): ContentPlanItem[] {
  const sliced = gaps.slice(0, MAX_PLAN_ITEMS);
  const actions = resolvePlanActions(sliced);
  return sliced.map((gap, i) => ({
    priority: i + 1,
    topic: titleCase(gap.topic),
    action: actions[i].action,
    targetPage: actions[i].targetPage,
    title: suggestedTitle(gap, actions[i]),
    targetKeywords: gap.keywords.slice(0, 5),
    rationale: rationaleFor(gap),
    format: formatFor(actions[i]),
    suggestedWordCount: suggestedWordCount(gap),
    brief: briefFor(gap, actions[i]),
  }));
}
