import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTIC_FINDING_MESSAGES } from '../lib/constants';
import { categorize } from '../lib/phase2/categorize';
import { buildReportMarkdown } from '../lib/phase2/phase2-runner';
import type { AuditArtifacts } from '../lib/phase2/types';
import { loadPhase2State } from '../lib/phase3/verify-runner';
import { ScoreCalculator, scoreAgentic } from '../lib/scoring/score-calculator';
import { getScoringRules } from '../lib/scoring/scoring-rules';
import { NO_AGENTIC_ISSUES_TEXT, resolveAgenticState } from '../lib/reports/sections/agentic-browsing';
import { generateHTML } from '../generateHTML';
import type { PageInfo, PageData } from '../lib/types';

const ORIGIN = 'https://site.test';
const PAGE_A = `${ORIGIN}/a`;
const PAGE_B = `${ORIGIN}/b`;
const NAMES = AGENTIC_FINDING_MESSAGES.interactiveNames.message;
const LLMS = AGENTIC_FINDING_MESSAGES.llmsTxtMissing.message;

const pass = { passed: true, offenders: [] };
const fail = { passed: false, offenders: ['<a>'] };

function agenticPage(url: string, failNames = false, hintsUnavailable = false): PageInfo {
  return {
    url,
    status: 200,
    agentic: {
      checks: { interactiveNames: failNames ? fail : pass, interactiveRoles: pass, formLabels: pass, hoverOnly: pass },
      ...(hintsUnavailable && { computedHintsUnavailable: true }),
    },
  } as unknown as PageInfo;
}

const plainPage = (url: string) => ({ url, status: 200 }) as unknown as PageInfo;

const detail = (message: string, url = PAGE_A) => ({
  severity: 'high' as const,
  count: 1,
  examples: [`<a href="${url}">${url}</a> ${message.toLowerCase()}`],
});

function summaryFor(pages: Record<string, PageInfo>, details: Record<string, ReturnType<typeof detail>>) {
  const bySeverity = { critical: [], high: Object.keys(details), medium: [], low: [] };
  const pageData = { totalWithoutError: Object.keys(pages).length, totalWithError: 0 } as unknown as PageData;
  return ScoreCalculator.calculateSummary({ bySeverity, details }, pageData, pages);
}

function artifacts(
  pages: Record<string, PageInfo>,
  details: Record<string, ReturnType<typeof detail>>,
  agentic: boolean | undefined,
): AuditArtifacts {
  return {
    runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-p2-')),
    manifest: {
      version: 1,
      format: 'multi',
      domain: 'site.test',
      created: '2026-01-01T00:00:00.000Z',
      progress: { processedPages: Object.keys(pages), totalWithoutError: 1, totalWithError: 0, byError: {} },
      files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
      evidence: null,
    },
    analysis: { overall: Object.keys(details), details, bySeverity: {}, summary: summaryFor(pages, details) },
    metadata: { sitemaps: { total: 1 }, ...(agentic === undefined ? {} : { agentic }) },
    repoAnalysis: null,
  } as unknown as AuditArtifacts;
}

function renderHtml(
  pages: Record<string, PageInfo>,
  details: Record<string, ReturnType<typeof detail>>,
  agentic: boolean | undefined,
  noScore = false,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-html-'));
  const auditFile = path.join(dir, 'audit.json');
  fs.writeFileSync(
    auditFile,
    JSON.stringify({
      robots: { sitemaps: [], 'user-agent': {} },
      sitemaps: { urls: {}, total: 1 },
      isMultiLang: false,
      timing: {},
      pageData: {
        pages,
        processedPages: Object.keys(pages),
        totalWithoutError: Object.keys(pages).length,
        totalWithError: 0,
        byError: {},
      },
      analysis: { overall: Object.keys(details), details, bySeverity: {}, summary: summaryFor(pages, details) },
    }),
  );
  if (agentic !== undefined) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ agentic }));
  const out = path.join(dir, 'site.test.html');
  generateHTML(auditFile, 'site.test', out, undefined, { noScore });
  return fs.readFileSync(out, 'utf8');
}

const both = { [PAGE_A]: agenticPage(PAGE_A), [PAGE_B]: agenticPage(PAGE_B) };

void describe('agentic category score', () => {
  void it('scores 0.8 × per-page pass ratio + 0.2 × llms.txt', () => {
    assert.equal(scoreAgentic(both, {}), 100);
    assert.equal(scoreAgentic(both, { [LLMS]: detail(LLMS) }), 80);
    const halfFailing = { [PAGE_A]: agenticPage(PAGE_A, true), [PAGE_B]: agenticPage(PAGE_B) };
    assert.equal(scoreAgentic(halfFailing, {}), Math.round(0.8 * 87.5 + 20));
  });

  void it('is present beside the other categories and left out of the overall blend', () => {
    const withAgentic = summaryFor(both, { [LLMS]: detail(LLMS) });
    const without = summaryFor({ [PAGE_A]: plainPage(PAGE_A), [PAGE_B]: plainPage(PAGE_B) }, { [LLMS]: detail(LLMS) });
    assert.equal(withAgentic.categoryScores.agentic, 80);
    assert.equal(without.categoryScores.agentic, undefined);
    assert.equal(withAgentic.overallScore, without.overallScore);
  });

  void it('only counts pages that carry agentic data', () => {
    assert.equal(scoreAgentic({ [PAGE_A]: agenticPage(PAGE_A), [PAGE_B]: plainPage(PAGE_B) }, {}), 100);
  });

  void it('scoring rules describe the agentic category', () => {
    const rule = getScoringRules().categories.find((c) => c.key === 'agentic');
    assert.ok(rule && /llms\.txt/.test(rule.method) && rule.weightPct === 0);
  });

  void it('html: shows the score by default and hides it with noScore', () => {
    assert.match(renderHtml(both, {}, true), /Agentic Browsing <span class="agentic-score"[^>]*>100\/100/);
    const hidden = renderHtml(both, {}, true, true);
    assert.ok(hidden.includes('id="agentic-browsing"'));
    assert.ok(!hidden.includes('agentic-score'));
  });
});

void describe('Agentic Browsing section', () => {
  void it('categorize routes every agentic finding, llms.txt included, to agentic', () => {
    for (const { message } of Object.values(AGENTIC_FINDING_MESSAGES)) assert.equal(categorize(message), 'agentic');
  });

  void it('lists the findings in both reports, llms.txt once and not under SEO', () => {
    const details = { [NAMES]: detail(NAMES), [LLMS]: detail(LLMS, `${ORIGIN}/llms.txt`) };
    const html = renderHtml(both, details, true);
    const section = html.slice(html.indexOf('id="agentic-browsing"'));
    assert.ok(section.includes(NAMES) && section.includes(LLMS));
    assert.ok(!html.includes(NO_AGENTIC_ISSUES_TEXT));

    const md = buildReportMarkdown(artifacts(both, details, true));
    const agentic = md.slice(md.indexOf('## Agentic Browsing'));
    assert.ok(md.includes('## Agentic Browsing'));
    assert.ok(agentic.includes(NAMES) && agentic.includes(LLMS));
    const seoStart = md.indexOf('## SEO Audit');
    if (seoStart >= 0) {
      const seo = md.slice(seoStart, md.indexOf('\n## ', seoStart + 1));
      assert.ok(!seo.includes(LLMS));
    }
  });

  void it('shows the clean-state message when the checks ran on every page and found nothing', () => {
    assert.ok(renderHtml(both, {}, true).includes(NO_AGENTIC_ISSUES_TEXT));
    const md = buildReportMarkdown(artifacts(both, {}, true));
    assert.ok(md.includes('## Agentic Browsing') && md.includes(NO_AGENTIC_ISSUES_TEXT));
  });

  void it('notes partial coverage and inline-styles-only hover checks instead of a clean state', () => {
    const partial = { [PAGE_A]: agenticPage(PAGE_A, false, true), [PAGE_B]: plainPage(PAGE_B) };
    const html = renderHtml(partial, {}, true);
    assert.ok(html.includes('Agentic checks ran on 1 of 2 pages'));
    assert.ok(html.includes('Hover-only check limited to inline styles on 1 page'));
    assert.ok(!html.includes(NO_AGENTIC_ISSUES_TEXT));
    const md = buildReportMarkdown(artifacts(partial, {}, true));
    assert.ok(md.includes('Agentic checks ran on 1 of 2 pages') && !md.includes(NO_AGENTIC_ISSUES_TEXT));
  });

  void it('is absent when the checks were disabled or the run predates them', () => {
    const plain = { [PAGE_A]: plainPage(PAGE_A) };
    for (const flag of [false, undefined]) {
      assert.ok(!renderHtml(plain, {}, flag).includes('id="agentic-browsing"'));
      assert.ok(!buildReportMarkdown(artifacts(plain, {}, flag)).includes('## Agentic Browsing'));
    }
    assert.equal(resolveAgenticState(false, both), null);
  });

  void it('Phase 3 re-render keeps the section from phase2-state.json; an older state file drops it', () => {
    const run = artifacts(both, {}, true);
    const state = { enabled: true, coverage: { covered: 2, total: 2, hintsLimited: 0 } };
    const base = { version: 1, generatedAt: '', suppressed: [], narratives: {}, anomalies: [], noScore: false };
    fs.writeFileSync(path.join(run.runDir, 'phase2-state.json'), JSON.stringify({ ...base, agentic: state }));
    const persisted = loadPhase2State(run.runDir);
    assert.deepEqual(persisted?.agentic, state);
    const md = buildReportMarkdown(run, {}, [], new Set(), undefined, undefined, false, {
      agentic: persisted?.agentic ?? null,
    });
    assert.ok(md.includes(NO_AGENTIC_ISSUES_TEXT));

    fs.writeFileSync(path.join(run.runDir, 'phase2-state.json'), JSON.stringify(base));
    const old = loadPhase2State(run.runDir);
    const oldMd = buildReportMarkdown(run, {}, [], new Set(), undefined, undefined, false, {
      agentic: old?.agentic ?? null,
    });
    assert.ok(!oldMd.includes('## Agentic Browsing'));
  });
});
