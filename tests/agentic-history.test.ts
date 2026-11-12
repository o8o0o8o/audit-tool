import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryManager } from '../historyManager';
import { buildComparisonHtml } from '../generateComparison';
import type { AuditSnapshot } from '../lib/types';

function snapshot(categoryScores: Record<string, number>): AuditSnapshot {
  return {
    timestamp: '2026-11-01T00:00:00.000Z',
    date: '2026-11-01',
    runTimestamp: null,
    summary: {
      overallScore: 70,
      totalIssues: 10,
      criticalCount: 1,
      highCount: 2,
      mediumCount: 3,
      lowCount: 4,
      passRate: 50,
      categoryScores,
      totalPages: 5,
      pagesWithErrors: 0,
      sitemapUrls: 5,
    },
    issues: {},
    performance: null,
    technologies: [],
    insights: null,
    quickWins: [],
  };
}

const base = { seo: 80, performance: 60, accessibility: 70, security: 90, technical: 75 };
const oldAudit = snapshot(base);
const newAudit = snapshot({ ...base, seo: 85, agentic: 64 });

void test('old snapshot without agentic yields no agentic delta', () => {
  const cmp = new HistoryManager('example.com').compareAudits(oldAudit, newAudit);
  assert.ok(cmp.categoryDeltas);
  assert.equal('agentic' in cmp.categoryDeltas, false);
  assert.equal(cmp.categoryDeltas.seo, 5);
  assert.equal(cmp.categoryDeltas.performance, 0);
  for (const v of Object.values(cmp.categoryDeltas)) assert.ok(Number.isFinite(v));
});

void test('comparison card renders n/a for the missing side, no NaN', () => {
  const hm = new HistoryManager('example.com');
  const html = buildComparisonHtml('example.com', oldAudit, newAudit, hm.compareAudits(oldAudit, newAudit));
  const card = html.split('<div class="category-name">agentic</div>')[1]?.split('category-card')[0];
  assert.ok(card, 'agentic card rendered');
  assert.match(card, /<span class="old-value">n\/a<\/span>/);
  assert.match(card, /<span class="new-value">64<\/span>/);
  assert.match(card, /n\/a\s*<\/div>/);
  assert.doesNotMatch(html, /NaN/);
});

void test('category dropped in the new snapshot is skipped too', () => {
  const cmp = new HistoryManager('example.com').compareAudits(newAudit, oldAudit);
  assert.equal('agentic' in (cmp.categoryDeltas ?? {}), false);
});
