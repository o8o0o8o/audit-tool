import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { SCORING } from '../lib/constants';
import { FIX_RECOVERY_RATIO, blendOverallScore, estimateScoreAfterFixes } from '../lib/utils';
import { ScoreCalculator } from '../lib/scoring/score-calculator';
import { getScoringRules } from '../lib/scoring/scoring-rules';
import { categorize } from '../lib/phase2/categorize';
import { matchesChecks, type CheckName } from '../lib/presets';
import { getExecutiveSummary } from '../lib/reports/sections/executive-summary';
import { renderNoPresetHtml } from './fixtures/report-fixture/make-golden';
import type { AnalysisDetail, PageData, PageInfo, ReportSectionData } from '../lib/types';

const auditFile = path.join(__dirname, 'fixtures/report-fixture/audit.json');

function cardValue(html: string, label: string): string | undefined {
  const re = new RegExp(`summary-card-value"[^>]*>([^<]*)</div>\\s*<div class="summary-card-label">${label}</div>`);
  return re.exec(html)?.[1];
}

void describe('executive summary numbers', () => {
  void it('summary recalculated after checks filter', () => {
    const checks: CheckName[] = ['seo'];
    const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8')) as {
      analysis: { details: Record<string, AnalysisDetail> };
      pageData: PageData & { pages: Record<string, PageInfo> };
    };
    const details = Object.fromEntries(
      Object.entries(audit.analysis.details).filter(([m]) => matchesChecks(m, categorize(m), checks)),
    );
    assert.ok(Object.keys(details).length < Object.keys(audit.analysis.details).length, 'filter must drop something');
    const bySeverity: Record<string, string[]> = {};
    for (const s of ['critical', 'high', 'medium', 'low']) {
      bySeverity[s] = Object.entries(details)
        .filter(([, d]) => String(d.severity).toLowerCase() === s)
        .map(([m]) => m);
    }
    const expected = ScoreCalculator.calculateSummary({ bySeverity, details }, audit.pageData, audit.pageData.pages);

    const html = renderNoPresetHtml({ checks });
    assert.equal(cardValue(html, 'Total Issues'), String(expected.totalIssues));
    assert.equal(cardValue(html, 'Critical'), String(expected.criticalCount));
    assert.equal(cardValue(html, 'High'), String(expected.highCount));
    assert.equal(cardValue(html, 'Medium'), String(expected.mediumCount));
    assert.equal(cardValue(html, 'Low'), String(expected.lowCount));
    assert.match(html, new RegExp(`score-number [^"]*">${expected.overallScore}</div>`));
  });

  void it('labels', () => {
    const summary = { totalIssues: 2, criticalCount: 1, highCount: 1, mediumCount: 0, lowCount: 0, passRate: 90, overallScore: 70, categoryScores: {} };
    const html = getExecutiveSummary({
      jsonData: { analysis: { summary } },
      pages: [],
      pageData: { pages: {} },
    } as unknown as ReportSectionData);
    assert.ok(html.includes('Pass Rate'));
    assert.ok(html.includes('share of crawled pages that loaded without errors'));
    assert.ok(html.includes('Total Issues'));
    assert.ok(html.includes('distinct kinds of issue, not pages'));

    const cmp = getExecutiveSummary({
      jsonData: { analysis: { summary } },
      pages: [],
      pageData: { pages: {} },
      comparison: { compareJsonData: { analysis: { summary } }, originDomainName: 'a.com', compareDomainName: 'b.com' },
    } as unknown as ReportSectionData);
    assert.ok(cmp.includes('Pass Rate'));
    assert.ok(cmp.includes('Total Issues'));
    assert.ok(cmp.includes('kinds of issue'));
    assert.ok(cmp.includes('share of crawled pages that loaded without errors'));
  });

  void it('rules text', () => {
    const r = getScoringRules();
    assert.match(r.passRate, /Pass Rate/);
    assert.match(r.passRate, /kinds of issue/);
    assert.match(r.estimate, new RegExp(`${Math.round(FIX_RECOVERY_RATIO * 100)}% of its headroom`));
    assert.match(r.estimate, /unmeasured categories get no credit/);
  });

  void it('estimate uses blended formula', () => {
    const scores = { seo: 30, performance: 80, technical: 70, accessibility: 90, security: 50 };
    const overall = ScoreCalculator.calculateOverallScore({ bySeverity: {}, details: {} }, {}, scores);
    assert.equal(overall, blendOverallScore(scores));
    const fixed = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v + (100 - v) * FIX_RECOVERY_RATIO]));
    assert.equal(estimateScoreAfterFixes(overall, scores, SCORING.CATEGORY_WEIGHTS), blendOverallScore(fixed));
    const perfect = { seo: 100, performance: 100, technical: 100, accessibility: 100, security: 100 };
    assert.equal(estimateScoreAfterFixes(100, perfect, SCORING.CATEGORY_WEIGHTS), null);
  });

  void it('estimate skips unmeasured categories', () => {
    const scores = { seo: 80, performance: 80, technical: 80, accessibility: 80 };
    const overall = blendOverallScore(scores);
    // security is absent: it stays 0, so the worst-category term stays 0 and the estimate is small.
    const fixed = { seo: 92, performance: 92, technical: 92, accessibility: 92 };
    assert.equal(estimateScoreAfterFixes(overall, scores, SCORING.CATEGORY_WEIGHTS), blendOverallScore(fixed));
    assert.ok(blendOverallScore(fixed) < blendOverallScore({ ...fixed, security: 60 }));
  });
});
