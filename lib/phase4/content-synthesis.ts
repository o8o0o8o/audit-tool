/**
 * Phase 4 — optional LLM content-plan synthesis.
 *
 * Upgrades the deterministic plan (titles, rationale, briefs) using the ranked
 * gap matrix as grounding. The model only RE-WRITES plan items for the gaps it
 * is given — it never invents topics. Returns null on any failure so the runner
 * keeps the templated plan. Honors the low-effort LLM policy via the shared
 * transport.
 */

import { callLlmText, extractJson } from './llm-client';
import { buildContentPlan, resolvePlanActions, type PlanAction } from './content-plan';
import { titleCase } from './topic-extract';
import type { CompetitiveGap, ContentPlanItem } from './types';

const SYSTEM_PROMPT = `You are an SEO content strategist. You turn a list of competitive content gaps into a prioritised content plan that helps a site win organic search traffic.

Return STRICT JSON only: {"plan": [{"priority": 1, "topic": "...", "title": "...", "targetKeywords": ["..."], "rationale": "...", "format": "...", "suggestedWordCount": 1500, "brief": "..."}]}.
Rules:
- One item per gap you are given, in the same priority order. Do not add topics that are not in the gaps.
- "topic": a clean 2–4 word topic label in Title Case, with NO brand/product names (e.g. "Documentation Reference", not "Documentation Payload"). This is the canonical name for the gap.
- "title": a compelling, specific article/page title a human would click.
- "brief": 1–2 sentences on angle and what to cover. Concrete, no fluff. When a gap is marked action=expand with a page URL, frame the brief as expanding THAT existing page (reference the URL); when action=create, frame it as a new page.
- "format": e.g. "Pillar guide", "How-to", "Comparison", "Listicle".
- Keep targetKeywords to the keywords provided for that gap.
- JSON only, no prose.`;

function buildUserPrompt(gaps: CompetitiveGap[], actions: PlanAction[]): string {
  const list = gaps
    .map((g, i) => {
      const vol = typeof g.searchVolume === 'number' ? `, ~${g.searchVolume} searches/mo` : '';
      const diff = typeof g.difficulty === 'number' ? `, difficulty ${g.difficulty}` : '';
      const a = actions[i];
      const act = a.action === 'expand' ? `, action=expand page=${a.targetPage}` : ', action=create';
      return `${i + 1}. topic="${g.topic}" type=${g.gapType} keywords=[${g.keywords.join(', ')}] ourPages=${g.ourPages} competitorPages=${g.competitorPages} competitorBestWords=${g.competitorBestWordCount}${vol}${diff}${act}`;
    })
    .join('\n');
  return `Competitive content gaps (already ranked):\n${list}\n\nWrite the content plan as JSON.`;
}

interface RawPlanItem {
  priority?: number;
  topic?: string;
  title?: string;
  targetKeywords?: unknown;
  rationale?: string;
  format?: string;
  suggestedWordCount?: number;
  brief?: string;
}

/**
 * Synthesize a content plan from the gaps. Returns null when no transport is
 * available or the reply is unusable; the runner then falls back to
 * {@link buildContentPlan}.
 */
export async function synthesizeContentPlan(
  gaps: CompetitiveGap[],
  opts: { cacheDir?: string; verbose?: boolean } = {},
): Promise<ContentPlanItem[] | null> {
  if (!gaps.length) return null;
  const actions = resolvePlanActions(gaps);
  const raw = await callLlmText({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(gaps, actions),
    cacheDir: opts.cacheDir,
    cacheTag: 'plan',
    maxTokens: 2500,
    verbose: opts.verbose,
  });
  const parsed = extractJson<{ plan?: RawPlanItem[] }>(raw);
  if (!parsed?.plan || !Array.isArray(parsed.plan) || !parsed.plan.length) return null;

  // Use the templated plan as a backstop for any missing fields, so a partial
  // LLM reply never produces a malformed item.
  const fallback = buildContentPlan(gaps);
  const items: ContentPlanItem[] = parsed.plan.slice(0, gaps.length).map((raw, i) => {
    const fb = fallback[i] ?? fallback[fallback.length - 1];
    const keywords = Array.isArray(raw.targetKeywords)
      ? raw.targetKeywords.filter((k): k is string => typeof k === 'string').slice(0, 5)
      : fb.targetKeywords;
    return {
      priority: i + 1,
      topic: typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim() : titleCase(gaps[i].topic),
      // action/targetPage are deterministic (de-duped across the plan) — never trust the LLM for them.
      action: actions[i].action,
      targetPage: actions[i].targetPage,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fb.title,
      targetKeywords: keywords.length ? keywords : fb.targetKeywords,
      rationale: typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : fb.rationale,
      format: typeof raw.format === 'string' && raw.format.trim() ? raw.format.trim() : fb.format,
      suggestedWordCount:
        typeof raw.suggestedWordCount === 'number' && raw.suggestedWordCount > 0
          ? Math.round(raw.suggestedWordCount)
          : fb.suggestedWordCount,
      brief: typeof raw.brief === 'string' && raw.brief.trim() ? raw.brief.trim() : fb.brief,
    };
  });
  if (opts.verbose) console.log(`   LLM synthesized ${items.length} content-plan item(s)`);
  return items;
}

/**
 * Relabel each gap's `topic` from the matching plan item's LLM-cleaned `topic`
 * (plan is 1:1 with gaps, same order). Used only on the LLM path, so the
 * gap-matrix labels read as cleanly as the plan ("Documentation Reference"
 * instead of the raw bigram "documentation payload"). Mutates gaps in place;
 * leaves a gap untouched when its plan item has no usable topic. Pure/exported
 * for tests.
 */
export function applyPlanTopics(gaps: CompetitiveGap[], plan: ContentPlanItem[]): void {
  for (let i = 0; i < gaps.length; i++) {
    const t = plan[i]?.topic;
    if (typeof t === 'string' && t.trim()) gaps[i].topic = t.trim();
  }
}
