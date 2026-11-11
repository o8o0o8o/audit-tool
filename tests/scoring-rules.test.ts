import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCORING } from '../lib/constants';
import { getScoringRules, scoringRulesHtml, scoringRulesMarkdown } from '../lib/scoring/scoring-rules';
import { getExecutiveSummary } from '../lib/reports/sections/executive-summary';
import { getHistoricalProgress } from '../lib/reports/sections/historical-progress';
import { getPagesTable } from '../lib/reports/sections/pages-table';
import { buildReportMarkdown } from '../lib/phase2/phase2-runner';
import { buildComparisonHtml } from '../generateComparison';
import { HistoryManager } from '../historyManager';
import type { AuditArtifacts } from '../lib/phase2/types';
import type { AuditSnapshot, PageInfo, ReportSectionData } from '../lib/types';

const categoryScores = { seo: 61, performance: 72, technical: 80, accessibility: 90, security: 55 };

const summary = {
  totalIssues: 3,
  criticalCount: 1,
  highCount: 1,
  mediumCount: 1,
  lowCount: 0,
  categoryScores,
  overallScore: 64,
  passRate: 100,
  quickWins: [],
};

const page = {
  url: 'https://e.com/',
  security: { securityScore: 77 },
  caching: { cacheScore: 66 },
  accessibility: { a11yScore: 88 },
  contentQuality: { contentScore: 71 },
} as unknown as PageInfo;

function snapshot(overallScore: number): AuditSnapshot {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    date: '2026-01-01',
    runTimestamp: null,
    summary: { ...summary, overallScore },
    issues: {},
    performance: null,
    technologies: [],
    insights: null,
    quickWins: [],
  } as unknown as AuditSnapshot;
}

function sectionData(noScore: boolean): ReportSectionData {
  return {
    jsonData: { analysis: { summary }, pageData: { pages: { [page.url]: page } } },
    pages: [page],
    pageData: { pages: { [page.url]: page } } as unknown as ReportSectionData['pageData'],
    trendData: {
      labels: ['a', 'b'],
      scores: [50, 64],
      issues: [5, 3],
      critical: [1, 1],
    } as ReportSectionData['trendData'],
    previousAudit: snapshot(50),
    noScore,
  };
}

function artifacts(): AuditArtifacts {
  return {
    runDir: '/tmp/scoring-rules-test',
    manifest: {
      version: 1,
      format: 'multi',
      domain: 'e.com',
      created: '2026-01-01T00:00:00.000Z',
      progress: { processedPages: [], totalWithoutError: 5, totalWithError: 0, byError: {}, attempts: {} },
      files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
      evidence: null,
    },
    analysis: {
      overall: ['Missing meta description'],
      details: { 'Missing meta description': { severity: 'high', count: 2, examples: ['https://e.com/a'] } },
      bySeverity: {},
      summary,
    },
    metadata: {},
    repoAnalysis: null,
  } as unknown as AuditArtifacts;
}

const RULES_MARKER = 'How is this score calculated?';

void describe('scoring rules text', () => {
  void it('is built from SCORING constants', () => {
    const rules = getScoringRules();
    for (const [key, w] of Object.entries(SCORING.CATEGORY_WEIGHTS)) {
      const cat = rules.categories.find((c) => c.key === key);
      assert.ok(cat, `missing category ${key}`);
      assert.equal(cat.weightPct, Math.round(w * 100));
    }
    const html = scoringRulesHtml();
    for (const w of Object.values(SCORING.CATEGORY_WEIGHTS)) assert.ok(html.includes(`${Math.round(w * 100)}%`));
    for (const [m, w] of Object.entries(SCORING.PERFORMANCE_METRIC_WEIGHTS)) assert.ok(html.includes(`${m} ${w}%`));
    const meanPct = Math.round(SCORING.OVERALL_MEAN_WEIGHT * 100);
    assert.ok(html.includes(`${meanPct}% × weighted category mean + ${100 - meanPct}% × worst category`));
    assert.ok(html.includes('id="score-rules"'));
  });
});

void describe('HTML report score explanations', () => {
  void it('executive summary with a score carries the rules block', () => {
    const html = getExecutiveSummary(sectionData(false));
    assert.ok(html.includes('score-ring'));
    assert.ok(html.includes('id="score-rules"'));
    assert.ok(html.includes(RULES_MARKER));
  });

  void it('historical progress and pages table link score parts to the rules', () => {
    assert.ok(getHistoricalProgress(sectionData(false)).includes('href="#score-rules"'));
    assert.ok(getPagesTable(sectionData(false)).includes('href="#score-rules"'));
  });

  void it('--no-score removes scores and rules from the HTML sections', () => {
    const exec = getExecutiveSummary(sectionData(true));
    assert.ok(!exec.includes('score-ring'));
    assert.ok(!exec.includes('Category Health'));
    assert.ok(!exec.includes('Estimated Score After Fixes'));
    assert.ok(!exec.includes('score-rules'));
    assert.ok(exec.includes('Total Issues'));

    const hist = getHistoricalProgress(sectionData(true));
    for (const s of ['Current Score', 'Score Change', 'scoreTrendChart', 'Category Changes', 'score-rules']) {
      assert.ok(!hist.includes(s), `history must not contain ${s}`);
    }
    assert.ok(hist.includes('Issues Change'));

    const table = getPagesTable(sectionData(true));
    for (const s of ['Security Score', 'Cache Score', 'A11y Score', 'Content Score', 'score-rules']) {
      assert.ok(!table.includes(s), `pages table must not contain ${s}`);
    }
  });
});

void describe('Phase 2 report methodology', () => {
  void it('explains category weights and the overall blend when scores are shown', () => {
    const md = buildReportMarkdown(artifacts());
    assert.ok(md.includes(scoringRulesMarkdown()));
    for (const w of Object.values(SCORING.CATEGORY_WEIGHTS)) assert.ok(md.includes(`| ${Math.round(w * 100)}% |`));
  });

  void it('--no-score drops the rules text', () => {
    const md = buildReportMarkdown(artifacts(), {}, [], new Set(), undefined, undefined, true);
    assert.ok(!md.includes('How the scores are calculated'));
    assert.ok(!md.includes('weighted category mean'));
  });
});

void describe('audit comparison report', () => {
  void it('embeds the scoring rules and links score headings to them', () => {
    const oldA = snapshot(50);
    const newA = snapshot(64);
    const comparison = new HistoryManager('scoring-rules.test').compareAudits(oldA, newA);
    const html = buildComparisonHtml('e.com', oldA, newA, comparison);
    assert.ok(html.includes('id="score-rules"'));
    assert.ok((html.match(/href="#score-rules"/g) ?? []).length >= 2);
  });
});

void describe('--no-score client scripts', () => {
  void it('embeds no score values or score export lines', async () => {
    const { getScripts } = await import('../lib/reports/sections/scripts');
    const jsonData = {
      analysis: { summary: { overallScore: 87, categoryScores: { seo: 91 }, totalIssues: 3 }, details: {} },
      pageData: { pages: {} },
    };
    const base = {
      jsonData,
      pages: [],
      pageData: { pages: {} },
      domainName: 'example.com',
      trendData: { labels: ['a'], scores: [87], issues: [3], critical: [0] },
    } as unknown as ReportSectionData;
    const withScore = getScripts(base);
    assert.match(withScore, /"overallScore":87/);
    const out = getScripts({ ...base, noScore: true });
    assert.doesNotMatch(out, /overallScore"\s*:/);
    assert.doesNotMatch(out, /categoryScores"\s*:/);
    assert.doesNotMatch(out, /\b87\b/);
    assert.doesNotMatch(out, /Overall SEO Score/);
    assert.doesNotMatch(out, /'Security Score': \{/);
    assert.doesNotMatch(out, /## Score: /);
    assert.doesNotMatch(out, /'Score: ' \+ \(summary\.overallScore/);
  });
});
