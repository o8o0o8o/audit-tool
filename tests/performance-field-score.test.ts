import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScoreCalculator,
  fieldMetricsFromCrux,
  performanceSource,
  scoreFieldMetrics,
  withFieldPerformance,
} from '../lib/scoring/score-calculator';
import { fieldPerformanceMeta, withQuickScanLabel } from '../generateHTML';
import { blendOverallScore } from '../lib/utils';
import type { AnalysisDetail, PageData, PageInfo } from '../lib/types';

const crux = (p75: Record<string, number>) => ({
  metrics: Object.fromEntries(Object.entries(p75).map(([k, v]) => [k, { percentiles: { p75: v } }])),
});

// zoover.nl's real-user data from a lead scan: mostly good, INP needs improvement.
const ZOOVER = crux({ LCP: 1801, CLS: 0.03, INP: 284, FCP: 1499 });

// Enough performance findings that the old finding-count fallback scored 0.
const analysis = {
  bySeverity: { critical: [], high: ['Slow server response time (TTFB)'], medium: [], low: [] },
  details: {
    'Slow server response time (TTFB)': {
      severity: 'high',
      count: 25,
      examples: Array.from({ length: 25 }, (_, i) => `https://example.com/p${i}`),
    },
  } as Record<string, AnalysisDetail>,
};
const pagesNoLab: Record<string, PageInfo> = Object.fromEntries(
  Array.from({ length: 25 }, (_, i) => [`https://example.com/p${i}`, { url: `https://example.com/p${i}` } as PageInfo]),
);
const pageData = { totalWithoutError: 25, totalWithError: 0 } as PageData;

void describe('performance score without lab data', () => {
  void it('reads the p75 values from a CrUX response', () => {
    assert.deepEqual(fieldMetricsFromCrux(ZOOVER), { LCP: 1801, CLS: 0.03, INP: 284, FCP: 1499 });
    assert.equal(fieldMetricsFromCrux(null), null);
    assert.equal(fieldMetricsFromCrux({ metrics: {} }), null);
  });

  void it('scores real-user data instead of counting findings', () => {
    const withField = ScoreCalculator.calculateSummary(analysis, pageData, pagesNoLab, ZOOVER);
    assert.equal(withField.performanceSource, 'field');
    assert.equal(withField.categoryScores.performance, Math.round(scoreFieldMetrics(fieldMetricsFromCrux(ZOOVER)!)!));
    assert.ok(withField.categoryScores.performance > 40, 'mostly good vitals must not score near 0');

    const without = ScoreCalculator.calculateSummary(analysis, pageData, pagesNoLab);
    assert.equal(without.performanceSource, undefined, 'nothing measured: no source, like no score');
    assert.equal(without.categoryScores.performance, undefined);
  });

  void it('lab metrics still win over real-user data', () => {
    const pages = { 'https://example.com/': { url: 'https://example.com/', LCP: 900, CLS: 0 } as PageInfo };
    assert.equal(performanceSource(Object.values(pages), fieldMetricsFromCrux(ZOOVER)), 'lab');
    const summary = ScoreCalculator.calculateSummary(analysis, pageData, pages, crux({ LCP: 9000 }));
    assert.equal(summary.performanceSource, 'lab');
    assert.ok(summary.categoryScores.performance! > 90);
  });

  void it('rescores a summary saved before the source was recorded', () => {
    const old = ScoreCalculator.calculateSummary(analysis, pageData, pagesNoLab);
    delete old.performanceSource;
    assert.equal(old.categoryScores.performance, undefined, 'nothing measured: no score');
    const fixed = withFieldPerformance(old, pagesNoLab, ZOOVER);
    assert.equal(fixed.performanceSource, 'field');
    assert.ok(fixed.categoryScores!.performance! > 40);
    assert.equal(fixed.overallScore, blendOverallScore({ ...fixed.categoryScores! }), 'the overall now includes the real-user score');
    // A summary that already records its source is left alone.
    assert.equal(withFieldPerformance(fixed, pagesNoLab, crux({ LCP: 9000 })), fixed);
  });
});

void describe('quick scan report labels', () => {
  void it('the Performance header shows real-user vitals with their rating', () => {
    assert.equal(
      fieldPerformanceMeta(ZOOVER),
      'Real users: LCP 1.80 s good · INP 284 ms needs improvement · CLS 0.03 good',
    );
    assert.equal(fieldPerformanceMeta(null), '');
  });

  void it('the header names a quick scan', () => {
    const lead = { leadScan: { cap: 25 } };
    assert.equal(withQuickScanLabel('Full audit', lead), 'Quick scan (25 pages, passive)');
    assert.equal(withQuickScanLabel('Sales', lead), 'Sales · Quick scan (25 pages, passive)');
    assert.equal(withQuickScanLabel('Sales', {}), 'Sales');
  });
});
