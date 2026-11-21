import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoreCalculator, performanceSource } from '../lib/scoring/score-calculator';
import { SCORING_VERSION, scoresComparable, scoringVersionOf } from '../lib/scoring/scoring-version';
import { blendOverallScore, estimateScoreAfterFixes } from '../lib/utils';
import { SCORING } from '../lib/constants';
import { HistoryManager } from '../historyManager';
import { getJsonSummary, printAuditSummary, type AuditResultsExtended } from '../lib/utils/cli-summary';
import { publishRun } from '../lib/leads/publish';
import type { ApiProspectStore } from '../lib/leads/prospect-store';
import type { AnalysisDetail, AuditSnapshot, PageInfo } from '../lib/types';
import { writeFixtureRun } from './platform/helpers';

const pagesOf = (n: number): Record<string, PageInfo> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `https://example.com/p${i}`,
      { url: `https://example.com/p${i}` } as PageInfo,
    ]),
  );

function seoScore(details: Record<string, Partial<AnalysisDetail>>, bySeverity: Record<string, string[]> = {}) {
  return ScoreCalculator.calculateCategoryScores(
    { bySeverity, details: details as Record<string, AnalysisDetail> },
    pagesOf(500),
  ).seo;
}

void describe('reach of a finding (SEO / technical score)', () => {
  const TITLE = 'Missing canonical URL';

  void it('a one-off finding costs one page whatever its example looks like', () => {
    const fullUrl = seoScore({ [TITLE]: { severity: 'critical', count: 1, examples: ['https://example.com/foo'] } });
    const pathOnly = seoScore({ [TITLE]: { severity: 'critical', count: 1, examples: ['/foo'] } });
    const noExample = seoScore({ [TITLE]: { severity: 'critical', count: 1 } });
    assert.equal(fullUrl, 100);
    assert.equal(pathOnly, fullUrl);
    assert.equal(noExample, fullUrl);
  });

  void it('a small known count is never site-wide', () => {
    const three = seoScore({ [TITLE]: { severity: 'critical', count: 3, examples: ['/a', '/b', '/c'] } });
    assert.ok(three > 99);
    const examplesOnly = seoScore({ [TITLE]: { severity: 'critical', examples: ['/a'] } });
    assert.equal(examplesOnly, 100);
  });

  void it('only a finding with no pages and no count is site-wide', () => {
    assert.equal(seoScore({ [TITLE]: { severity: 'critical' } }), 50);
    assert.equal(seoScore({}, { critical: [TITLE], high: [], medium: [], low: [] }), 50);
    assert.equal(seoScore({ [TITLE]: { severity: 'critical', count: 500 } }), 50);
  });
});

void describe('no measurement is not a score of 0', () => {
  void it('blendOverallScore gives no score when nothing was measured', () => {
    assert.equal(blendOverallScore({}), null);
    assert.equal(blendOverallScore({ seo: undefined, performance: undefined }), null);
    assert.equal(blendOverallScore({ seo: 0 }), 0, 'a measured 0 stays 0');
    assert.equal(estimateScoreAfterFixes(50, {}, SCORING.CATEGORY_WEIGHTS), null);
  });

  void it('performanceSource has no value without lab or real-user data', () => {
    assert.equal(performanceSource([{ url: 'https://example.com/' } as PageInfo], null), undefined);
    assert.equal(performanceSource([{ url: 'https://example.com/', LCP: 900 } as PageInfo], null), 'lab');
    assert.equal(performanceSource([], { LCP: 1800 }), 'field');
  });

  void it('the CLI summary prints "not measured", not Performance 0/100', () => {
    const results = {
      analysis: {
        summary: {
          overallScore: 88,
          categoryScores: { seo: 90, accessibility: 80, security: 85, technical: 95 },
          totalIssues: 0,
        },
        details: {},
      },
      pageData: { pages: {}, byError: {} },
    } as unknown as AuditResultsExtended;
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      printAuditSummary(results, 'example.com', 'report.html');
      (results.analysis!.summary as { overallScore?: number }).overallScore = undefined;
      printAuditSummary(results, 'example.com', 'report.html');
    } finally {
      console.log = log;
    }
    const text = out.join('\n');
    assert.match(text, /Performance\s+.*not measured/);
    assert.doesNotMatch(text, /Performance[^\n]*\b0\/100/);
    assert.match(text, /Score:.*not available/);
    assert.equal(getJsonSummary(results, 'example.com', 'report.html').score, null);
  });
});

void describe('history: scores from different scoring rules', () => {
  const snapshot = (overallScore: number, seo: number, scoringVersion?: number): AuditSnapshot =>
    ({
      timestamp: '2026-11-01T00:00:00.000Z',
      date: '2026-11-01',
      runTimestamp: null,
      ...(scoringVersion === undefined ? {} : { scoringVersion }),
      summary: {
        overallScore,
        totalIssues: 10,
        criticalCount: 1,
        highCount: 2,
        mediumCount: 3,
        lowCount: 4,
        passRate: 50,
        categoryScores: { seo },
      },
      issues: {},
      performance: null,
      technologies: [],
      insights: null,
      quickWins: [],
    }) as unknown as AuditSnapshot;

  void it('a snapshot without the field counts as the first version', () => {
    assert.equal(scoringVersionOf(snapshot(1, 1)), 1);
    assert.ok(scoresComparable(snapshot(1, 1), snapshot(2, 2)));
    assert.ok(!scoresComparable(snapshot(1, 1), snapshot(2, 2, SCORING_VERSION)));
  });

  void it('gives no score delta across a scoring change and says why', () => {
    const cmp = new HistoryManager('example.com').compareAudits(snapshot(40, 0), snapshot(75, 50, SCORING_VERSION));
    assert.equal(cmp.scoresComparable, false);
    assert.match(cmp.scoresNote ?? '', /not comparable.*scoring rules changed/);
    assert.equal(cmp.scoreChange, 0);
    assert.deepEqual(cmp.categoryDeltas, {});
    assert.equal(cmp.deltaMetrics.totalIssues, 0, 'issue counts are still compared');
  });

  void it('compares scores of the same version as before', () => {
    const cmp = new HistoryManager('example.com').compareAudits(
      snapshot(40, 0, SCORING_VERSION),
      snapshot(75, 50, SCORING_VERSION),
    );
    assert.equal(cmp.scoresComparable, true);
    assert.equal(cmp.scoresNote, undefined);
    assert.equal(cmp.scoreChange, 35);
    assert.equal(cmp.categoryDeltas?.seo, 50);
  });

  void it('new snapshots record the current version', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'history-'));
    try {
      const manager = new HistoryManager('example.com', dir);
      manager.addAuditSnapshot({});
      assert.equal(scoringVersionOf(manager.getLatestAudit()), SCORING_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe('publishing a run', () => {
  const listing = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[path.relative(dir, p)] = readFileSync(p).toString('base64');
      }
    };
    walk(dir);
    return out;
  };

  void it('masks secrets in a temporary copy and leaves the run on disk as it was', async () => {
    const fixture = writeFixtureRun();
    const tmpBefore = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('publish-run-')));
    try {
      const secret = `AKIA${'ABCDEFGHIJKLMNOP'}`;
      mkdirSync(path.join(fixture.runDir, 'evidence', 'home'), { recursive: true });
      writeFileSync(path.join(fixture.runDir, 'evidence', 'home', 'requests.json'), JSON.stringify({ key: secret }));
      const before = listing(fixture.runDir);
      let seenRunCopy = '';
      const api = {
        call: async (_method: string, apiPath: string) => {
          if (apiPath !== '/api/v1/audits/import') throw new Error(`unexpected call ${apiPath}`);
          seenRunCopy = readdirSync(os.tmpdir()).find((n) => n.startsWith('publish-run-') && !tmpBefore.has(n)) ?? '';
          return { audit_id: 'a1', already_imported: true };
        },
      } as unknown as ApiProspectStore;
      const res = await publishRun(api, fixture.runDir);
      assert.equal(res.alreadyImported, true);
      assert.ok(seenRunCopy, 'the upload is prepared in a temporary folder');
      assert.deepEqual(listing(fixture.runDir), before, 'no file of the run was rewritten or added');
      assert.ok(!existsSync(path.join(fixture.runDir, 'platform', 'masked.json')));
      assert.ok(!existsSync(path.join(os.tmpdir(), seenRunCopy)), 'the copy is deleted afterwards');

      // Also deleted when publishing fails.
      const failing = {
        call: async () => {
          throw new Error('platform down');
        },
      } as unknown as ApiProspectStore;
      await assert.rejects(publishRun(failing, fixture.runDir), /platform down/);
      assert.deepEqual(listing(fixture.runDir), before);
      const left = readdirSync(os.tmpdir()).filter((n) => n.startsWith('publish-run-') && !tmpBefore.has(n));
      assert.deepEqual(left, []);
    } finally {
      fixture.cleanup();
    }
  });
});
