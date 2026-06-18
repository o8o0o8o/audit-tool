/**
 * Phase 4 runner — Competitive Content Research.
 *
 * Runs AFTER the crawl (and Phase 2/3) and NEVER touches their outputs. Reads
 * the Phase 1 artifacts off disk, crawls a bounded sample of competitor content,
 * computes the competitive topic-coverage gap, and emits a SEPARATE
 * `content-research-report.{md,html,pdf}` plus a versioned
 * `content-research-state.json`.
 *
 * Standalone & re-runnable — everything it needs is on disk:
 *   npx tsx -e "import {runContentResearchPhase} from './lib/phase4/phase4-runner'; runContentResearchPhase('<runDir>',{verbose:true})"
 *
 * Graceful degradation throughout: no competitors + no LLM → self-gap report;
 * a competitor unreachable → noted and skipped; no LLM → templated content plan;
 * injection file absent → ranks on crawl-derived signal only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { renderMarkdownToPdf } from '../reports/pdf-renderer';
import { loadArtifacts } from '../phase2/phase2-runner';
import { loadAllPages } from '../phase3/finding-verifier';
import { buildTermIndex, titleCase } from './topic-extract';
import { CONTENT_RESEARCH } from '../constants';
import type { PageInfo } from '../types';
import { crawlCompetitor, normaliseOrigin } from './competitor-crawl';
import { computeCompetitiveGaps, computeSelfGaps } from './competitive-gap';
import { buildContentPlan } from './content-plan';
import { synthesizeContentPlan, applyPlanTopics } from './content-synthesis';
import { deriveTopicTaxonomy } from './topic-taxonomy';
import { discoverCompetitors, type ProductSummary } from './competitor-discovery';
import { llmTransportAvailable } from './llm-client';
import type {
  CompetitiveGap,
  CompetitorProfile,
  ContentPlanItem,
  ContentResearchOptions,
  ContentResearchState,
  KeywordInjection,
} from './types';

/** Build a url→PageInfo record from the on-disk page index. */
function pagesRecord(runDir: string): Record<string, PageInfo> {
  const index = loadAllPages(runDir);
  const out: Record<string, PageInfo> = {};
  for (const page of index.all()) {
    if (page?.url) out[page.url] = page;
  }
  return out;
}

/** Derive the audited site's origin from the crawled pages or the manifest. */
function deriveOrigin(ourPages: Record<string, PageInfo>, domain: string | undefined): string {
  for (const url of Object.keys(ourPages)) {
    try {
      return new URL(url).origin;
    } catch {
      /* keep looking */
    }
  }
  return domain ? `https://${domain}` : '';
}

/** Pick the homepage page (root path) or the shortest-path page as a proxy. */
function homepageOf(ourPages: Record<string, PageInfo>, origin: string): PageInfo | undefined {
  const exact = ourPages[origin] ?? ourPages[`${origin}/`];
  if (exact) return exact;
  let best: PageInfo | undefined;
  let bestLen = Infinity;
  for (const [url, page] of Object.entries(ourPages)) {
    try {
      const len = new URL(url).pathname.length;
      if (len < bestLen) {
        bestLen = len;
        best = page;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

function buildProductSummary(ourPages: Record<string, PageInfo>, origin: string): ProductSummary {
  const home = homepageOf(ourPages, origin);
  const index = buildTermIndex(ourPages);
  const topTopics = [...index.entries()]
    .sort((a, b) => b[1].urls.size - a[1].urls.size)
    .slice(0, 15)
    .map(([word]) => word);
  return {
    origin,
    title: home?.title,
    description: home?.description,
    headings: home?.headings?.h1 ?? [],
    topTopics,
  };
}

/** Read the optional keyword injection file. Returns null when absent/invalid. */
function loadInjection(runDir: string): KeywordInjection | null {
  const file = path.join(runDir, 'content-research-data.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KeywordInjection;
    if (!Array.isArray(parsed.keywords)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Resolve competitor URLs from a CSV string or a file path (one URL per line). */
export function parseCompetitorsArg(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let text = raw;
  try {
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) text = fs.readFileSync(raw, 'utf8');
  } catch {
    /* treat as inline list */
  }
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Markdown rendering ─────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const GAP_LABEL: Record<string, string> = {
  missing: 'Not covered',
  thin: 'Thin coverage',
  depth: 'Shallow vs competitor',
};

function buildReportMarkdown(args: {
  ourOrigin: string;
  competitors: CompetitorProfile[];
  gaps: CompetitiveGap[];
  plan: ContentPlanItem[];
  enriched: boolean;
  selfOnly: boolean;
  generatedAt: string;
}): string {
  const { ourOrigin, competitors, gaps, plan, enriched, selfOnly, generatedAt } = args;
  const lines: string[] = [];
  lines.push(`# Competitive Content Research`);
  lines.push('');
  lines.push(`**Site:** ${ourOrigin}  `);
  lines.push(`**Generated:** ${generatedAt} (point-in-time — competitor sites change)  `);
  if (enriched) lines.push(`**Keyword data:** enriched from \`content-research-data.json\`  `);
  lines.push('');

  // Competitors crawled
  lines.push('## Competitors analyzed');
  lines.push('');
  if (selfOnly) {
    lines.push(
      '> No competitors were supplied or discovered, so this report surfaces your **own thinnest topics** as content opportunities. Re-run with `--competitors=site-a.com,site-b.com` (or enable `--llm` for auto-discovery) for a full competitive comparison.',
    );
  } else {
    lines.push('| Competitor | Pages analyzed | Source |');
    lines.push('| --- | ---: | --- |');
    for (const c of competitors) {
      const src = c.error ? `⚠️ ${esc(c.error)}` : c.discovered ? 'LLM-discovered' : 'supplied';
      lines.push(`| ${esc(c.host)} | ${c.pagesCrawled} | ${src} |`);
    }
  }
  lines.push('');

  // Section A — topic coverage gaps
  lines.push(selfOnly ? '## Content opportunities (internal)' : '## Competitive topic-coverage gaps');
  lines.push('');
  if (!gaps.length) {
    lines.push('No significant content gaps were detected from the crawled sample.');
  } else {
    const head = selfOnly
      ? ['Topic', 'Keywords', 'Your pages', 'Status', 'Opportunity']
      : ['Topic', 'Keywords', 'Your pages', 'Competitor pages', 'Best competitor', 'Gap', 'Opportunity'];
    if (enriched) head.push('Volume');
    lines.push(`| ${head.join(' | ')} |`);
    lines.push(`| ${head.map(() => '---').join(' | ')} |`);
    for (const g of gaps) {
      const kw = esc(g.keywords.slice(0, 4).join(', '));
      const row = selfOnly
        ? [esc(titleCase(g.topic)), kw, String(g.ourPages), GAP_LABEL[g.gapType], String(g.opportunityScore)]
        : [
            esc(titleCase(g.topic)),
            kw,
            String(g.ourPages),
            String(g.competitorPages),
            esc(g.bestCompetitor ?? '—'),
            GAP_LABEL[g.gapType],
            String(g.opportunityScore),
          ];
      if (enriched) row.push(typeof g.searchVolume === 'number' ? g.searchVolume.toLocaleString('en-US') : '—');
      lines.push(`| ${row.join(' | ')} |`);
    }
  }
  lines.push('');

  // Section B — content plan
  lines.push('## Prioritized content plan');
  lines.push('');
  if (!plan.length) {
    lines.push('No content-plan items — no gaps to act on.');
  } else {
    for (const item of plan) {
      lines.push(`### ${item.priority}. ${item.title}`);
      lines.push('');
      const action =
        item.action === 'expand'
          ? `Expand existing${item.targetPage ? ` — ${item.targetPage}` : ''}`
          : item.action === 'create'
            ? 'Create new'
            : null;
      if (action) lines.push(`**Action:** ${esc(action)}  `);
      lines.push(`**Format:** ${esc(item.format)} · **Target length:** ~${item.suggestedWordCount} words  `);
      lines.push(`**Target keywords:** ${esc(item.targetKeywords.join(', ')) || '—'}  `);
      lines.push(`**Why:** ${esc(item.rationale)}  `);
      lines.push('');
      lines.push(item.brief);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Competitive content research phase. Returns the report PDF path, or null when
 * there are no crawled pages to research.
 */
export async function runContentResearchPhase(
  runDir: string,
  options: ContentResearchOptions = {},
): Promise<string | null> {
  console.log('\n🔬 Phase 4 — competitive content research…');
  const verbose = options.verbose === true;
  const artifacts = loadArtifacts(runDir);
  const ourPages = pagesRecord(runDir);
  if (!Object.keys(ourPages).length) {
    console.log('⚠️  No crawled pages found — skipping content research.');
    return null;
  }
  const ourOrigin = deriveOrigin(ourPages, artifacts.manifest?.domain);
  const cacheDir = path.join(runDir, 'cache', 'content-research');
  const useLlm = options.llm !== false && llmTransportAvailable();

  // 1. Resolve competitors: explicit list, else LLM discovery (when enabled).
  let competitorUrls = (options.competitors ?? [])
    .map((c) => normaliseOrigin(c))
    .filter((c): c is string => !!c)
    .slice(0, CONTENT_RESEARCH.MAX_COMPETITORS);
  let discovered = false;
  if (!competitorUrls.length && useLlm) {
    console.log('   No competitors supplied — asking the LLM to discover them…');
    competitorUrls = await discoverCompetitors(buildProductSummary(ourPages, ourOrigin), { cacheDir, verbose });
    discovered = competitorUrls.length > 0;
  }
  if (!competitorUrls.length) {
    console.log('   No competitors available — falling back to internal content-gap analysis.');
  }

  // 2. Crawl each competitor (bounded).
  const competitors: CompetitorProfile[] = [];
  for (const url of competitorUrls) {
    console.log(`   Crawling competitor: ${url}`);
    const profile = await crawlCompetitor(url, { verbose });
    profile.discovered = discovered;
    if (profile.error) console.log(`     ⚠️ ${profile.host}: ${profile.error}`);
    competitors.push(profile);
  }

  // 3. Compute gaps (competitive when we have competitor pages, else self-gaps).
  const injection = loadInjection(runDir);
  const haveCompetitorPages = competitors.some((c) => c.pagesCrawled > 0);
  const selfOnly = !haveCompetitorPages;
  let gaps: CompetitiveGap[];
  if (selfOnly) {
    gaps = computeSelfGaps(ourPages);
  } else {
    // On the LLM path, derive a clean top-down topic taxonomy; keyless falls
    // back to lexical clustering inside computeCompetitiveGaps.
    const topics = useLlm ? await deriveTopicTaxonomy(competitors, { cacheDir, verbose }) : null;
    gaps = computeCompetitiveGaps(ourPages, competitors, injection, topics ?? undefined);
  }

  // 4. Build the content plan (LLM-synthesized when available, else templated).
  let plan: ContentPlanItem[] | null = null;
  let llmPlan = false;
  if (useLlm && gaps.length) {
    plan = await synthesizeContentPlan(gaps, { cacheDir, verbose });
    llmPlan = plan !== null;
    // Surface the LLM's clean, de-branded topic labels in the gap matrix too
    // (keyless path keeps the deterministic bigram labels).
    if (plan) applyPlanTopics(gaps, plan);
  }
  if (!plan) plan = buildContentPlan(gaps);

  // 5. Render report + persist state.
  const generatedAt = new Date().toISOString();
  const markdown = buildReportMarkdown({
    ourOrigin,
    competitors,
    gaps,
    plan,
    enriched: injection !== null,
    selfOnly,
    generatedAt,
  });
  const mdPath = path.join(runDir, 'content-research-report.md');
  fs.writeFileSync(mdPath, markdown);

  const state: ContentResearchState = {
    version: 1,
    generatedAt,
    ourOrigin,
    competitors: competitors.map((c) => ({
      origin: c.origin,
      pagesCrawled: c.pagesCrawled,
      discovered: c.discovered,
      error: c.error,
    })),
    gaps,
    plan,
    enriched: injection !== null,
    llmPlan,
    selfOnly,
  };
  try {
    fs.writeFileSync(path.join(runDir, 'content-research-state.json'), JSON.stringify(state, null, 2));
  } catch (e: unknown) {
    console.warn('⚠️  Could not write content-research-state.json:', (e as Error).message);
  }

  const pdfPath = path.join(runDir, 'content-research-report.pdf');
  try {
    await renderMarkdownToPdf(markdown, pdfPath, {
      title: `${artifacts.manifest?.domain ?? ourOrigin} — content research`,
      imageBaseDir: runDir,
    });
  } catch (e: unknown) {
    console.warn('⚠️  Content-research PDF render failed (markdown still written):', (e as Error).message);
    return mdPath;
  }

  console.log(`📄 Content research report: ${pdfPath}`);
  return pdfPath;
}
