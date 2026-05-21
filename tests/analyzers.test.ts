import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ResponseHeaderAnalyzer } from '../lib/analyzers/seo/response-header-analyzer';
import { LanguageDetectionAnalyzer } from '../lib/analyzers/content/language-detection-analyzer';
import { ContentSimilarityAnalyzer } from '../lib/analyzers/site-wide/content-similarity-analyzer';
import { InternalPageRankAnalyzer } from '../lib/analyzers/site-wide/internal-pagerank-analyzer';
import { CodeCoverageAnalyzer } from '../lib/analyzers/performance/code-coverage-analyzer';
import { CTADetectorAnalyzer } from '../lib/analyzers/content/cta-detector-analyzer';
import { OutboundLinkChecker } from '../lib/analyzers/content/outbound-link-checker';
import { ScoreCalculator } from '../lib/scoring/score-calculator';
import { DEFAULT_CONFIG } from '../lib/config-loader';
import { METRIC_INFO, SIGNAL_CATEGORIES } from '../lib/reports/metrics-metadata';
import { getJsonSummary } from '../lib/utils/cli-summary';
import { HistoryManager } from '../historyManager';
import { getContentInsights } from '../lib/reports/sections/content-insights';
import type { PageInfo } from '../lib/types';

// ============================================================
// Response Header Analyzer
// ============================================================
void describe('ResponseHeaderAnalyzer', () => {
  void it('detects X-Robots-Tag noindex in info', () => {
    const pageData = {
      responseHeaders: { 'x-robots-tag': 'noindex', 'content-type': 'text/html' },
    };
    const result = ResponseHeaderAnalyzer.analyze(pageData as unknown as PageInfo, 'https://example.com/');
    assert.ok(result.info);
    assert.strictEqual(result.info.noindexViaHeader, true);
    assert.strictEqual(result.info.xRobotsTag, 'noindex');
  });

  void it('site-wide detects X-Robots-Tag noindex pages', () => {
    const allPages = {
      'https://example.com/': {
        responseHeaderAnalysis: { noindexViaHeader: true },
      },
    };
    const result = ResponseHeaderAnalyzer.analyzeSiteWide(allPages as unknown as Record<string, PageInfo>);
    assert.ok(result.issues.some((i) => (i.message ?? '').toLowerCase().includes('x-robots-tag')));
  });

  void it('returns no issues for clean headers', () => {
    const pageData = {
      responseHeaders: { 'content-type': 'text/html' },
    };
    const result = ResponseHeaderAnalyzer.analyze(pageData as unknown as PageInfo, 'https://example.com/');
    assert.strictEqual(result.issues.length, 0);
  });
});

// ============================================================
// Language Detection Analyzer (public API only - needs browser for full test)
// ============================================================
void describe('LanguageDetectionAnalyzer', () => {
  void it('exports analyzeLanguage method', () => {
    assert.strictEqual(typeof LanguageDetectionAnalyzer.analyzeLanguage, 'function');
  });

  void it('exports analyzeSiteWide method', () => {
    assert.strictEqual(typeof LanguageDetectionAnalyzer.analyzeSiteWide, 'function');
  });

  void it('site-wide detects language mismatches', () => {
    const allPages = {
      'https://example.com/': {
        url: 'https://example.com/',
        languageDetection: {
          match: false,
          detectedLanguage: 'fr',
          declaredLanguage: 'en',
          detectedConfidence: 0.8,
          htmlLang: 'en',
          contentLanguageHeader: null,
          topCandidates: [],
        },
      },
      'https://example.com/about': {
        url: 'https://example.com/about',
        languageDetection: {
          match: true,
          detectedLanguage: 'en',
          declaredLanguage: 'en',
          detectedConfidence: 0.9,
          htmlLang: 'en',
          contentLanguageHeader: null,
          topCandidates: [],
        },
      },
    };
    const result = LanguageDetectionAnalyzer.analyzeSiteWide(allPages);
    assert.ok(result.issues.some((i) => (i.message ?? i.detail ?? '').toLowerCase().includes('language')));
  });
});

// ============================================================
// Content Similarity Analyzer
// ============================================================
void describe('ContentSimilarityAnalyzer', () => {
  void it('detects similar pages', () => {
    const allPages = {
      'https://example.com/a': {
        contentQuality: {
          wordCount: 500,
          topKeywords: [
            { word: 'seo', density: 3 },
            { word: 'audit', density: 2.5 },
            { word: 'tool', density: 2 },
            { word: 'website', density: 1.5 },
            { word: 'performance', density: 1 },
          ],
        },
      },
      'https://example.com/b': {
        contentQuality: {
          wordCount: 520,
          topKeywords: [
            { word: 'seo', density: 3.1 },
            { word: 'audit', density: 2.4 },
            { word: 'tool', density: 2.1 },
            { word: 'website', density: 1.4 },
            { word: 'performance', density: 1.1 },
          ],
        },
      },
      'https://example.com/c': {
        contentQuality: {
          wordCount: 800,
          topKeywords: [
            { word: 'recipe', density: 4 },
            { word: 'cooking', density: 3 },
            { word: 'food', density: 2 },
          ],
        },
      },
    };

    ContentSimilarityAnalyzer.analyze(allPages as unknown as Record<string, PageInfo>);
    // Pages A and B should be detected as similar
    const pageA = allPages['https://example.com/a'] as Record<string, unknown>;
    assert.ok(pageA.contentSimilarity);
    const simA = pageA.contentSimilarity as { similarPages: unknown[] };
    assert.ok(simA.similarPages.length > 0);
    // Page C should not be similar to A/B
    const pageC = allPages['https://example.com/c'] as Record<string, unknown>;
    const simC = pageC.contentSimilarity as { similarPages?: unknown[] } | undefined;
    assert.strictEqual(simC?.similarPages?.length ?? 0, 0);
  });

  void it('handles pages without keywords', () => {
    const allPages = {
      'https://example.com/a': { contentQuality: { wordCount: 10 } },
      'https://example.com/b': {},
    };
    const result = ContentSimilarityAnalyzer.analyze(allPages as unknown as Record<string, PageInfo>);
    assert.ok(result);
    assert.ok(Array.isArray(result.issues));
  });
});

// ============================================================
// Internal PageRank Analyzer
// ============================================================
void describe('InternalPageRankAnalyzer', () => {
  void it('exports analyze method', () => {
    assert.strictEqual(typeof InternalPageRankAnalyzer.analyze, 'function');
  });

  void it('returns result with issues array', () => {
    const allPages = {
      'https://example.com/': { internalLinks: [{ href: 'https://example.com/about' }] },
      'https://example.com/about': { internalLinks: [{ href: 'https://example.com/' }] },
    };
    const incomingLinks = {
      'https://example.com/': ['https://example.com/about'],
      'https://example.com/about': ['https://example.com/'],
    };
    const result = InternalPageRankAnalyzer.analyze(
      allPages as unknown as Record<string, PageInfo>,
      incomingLinks,
      'https://example.com',
    );
    assert.ok(result);
    assert.ok(Array.isArray(result.issues));
    // Both pages should have PageRank assigned
    assert.ok((allPages['https://example.com/'] as Record<string, unknown>).internalPageRank != null);
    assert.ok((allPages['https://example.com/about'] as Record<string, unknown>).internalPageRank != null);
  });
});

// ============================================================
// Code Coverage Analyzer
// ============================================================
void describe('CodeCoverageAnalyzer', () => {
  void it('exports startCoverage and analyze methods', () => {
    assert.strictEqual(typeof CodeCoverageAnalyzer.startCoverage, 'function');
    assert.strictEqual(typeof CodeCoverageAnalyzer.analyze, 'function');
  });
});

// ============================================================
// CTA Detector Analyzer
// ============================================================
void describe('CTADetectorAnalyzer', () => {
  void it('exports analyzeCTAs method', () => {
    assert.strictEqual(typeof CTADetectorAnalyzer.analyzeCTAs, 'function');
  });
});

// ============================================================
// Outbound Link Checker
// ============================================================
void describe('OutboundLinkChecker', () => {
  void it('exports analyze method', () => {
    assert.strictEqual(typeof OutboundLinkChecker.analyze, 'function');
  });
});

// ============================================================
// Score Calculator
// ============================================================
void describe('ScoreCalculator', () => {
  const dummyPages: Record<string, Record<string, unknown>> = { 'https://example.com/': {} };

  void it('Error-tier SEO issue reduces SEO score (Ahrefs URL-pass)', () => {
    const analysisData = {
      bySeverity: { critical: [], high: ['Hreflang conflicts'], medium: [], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(
      analysisData,
      dummyPages as unknown as Record<string, PageInfo>,
    );
    assert.ok(scores.seo < 100, `Expected seo < 100, got ${scores.seo}`);
  });

  void it('Warning-tier SEO issue does NOT reduce SEO score', () => {
    // Ahrefs methodology: only Errors move the score. Warnings are reported separately.
    const analysisData = {
      bySeverity: { critical: [], high: [], medium: ['Some pages have missing or empty meta description'], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(
      analysisData,
      dummyPages as unknown as Record<string, PageInfo>,
    );
    assert.strictEqual(scores.seo, 100, `Expected seo=100 (warnings don't count), got ${scores.seo}`);
  });

  void it('X-Robots-Tag block is classified as SEO error (catalog)', () => {
    const analysisData = {
      bySeverity: { critical: [], high: ['Pages blocked via X-Robots-Tag header'], medium: [], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(
      analysisData,
      dummyPages as unknown as Record<string, PageInfo>,
    );
    assert.ok(scores.seo < 100, `Expected seo < 100, got ${scores.seo}`);
  });

  void it('Performance issue without metrics uses URL-pass fallback', () => {
    const analysisData = {
      bySeverity: { critical: [], high: [], medium: ['High percentage of unused JavaScript'], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(
      analysisData,
      dummyPages as unknown as Record<string, PageInfo>,
    );
    assert.ok(scores.performance < 100, `Expected performance < 100, got ${scores.performance}`);
  });

  void it('Performance score uses log-normal CDF on per-page metrics', () => {
    // A page with LCP=1220 (p10) should score ~90 for LCP.
    const fastPages = { 'https://example.com/': { LCP: 1220, INP: 50, CLS: 0.025, FCP: 934, TTFB: 200 } };
    const slowPages = { 'https://example.com/': { LCP: 4000, INP: 500, CLS: 0.25, FCP: 3000, TTFB: 1800 } };
    const empty = { bySeverity: { critical: [], high: [], medium: [], low: [] }, details: {} };

    const fast = ScoreCalculator.calculateCategoryScores(empty, fastPages as unknown as Record<string, PageInfo>);
    const slow = ScoreCalculator.calculateCategoryScores(empty, slowPages as unknown as Record<string, PageInfo>);
    assert.ok(fast.performance > 80, `Expected fast performance > 80, got ${fast.performance}`);
    assert.ok(slow.performance < 30, `Expected slow performance < 30, got ${slow.performance}`);
  });

  void it('SEO score scales with breadth of affected pages', () => {
    const pages100: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 100; i++) pages100[`https://example.com/${i}`] = {};

    const fewAffected = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {
        'Some pages have missing or empty title': { severity: 'high' as const, count: 2, examples: ['a', 'b'] },
      },
    };
    const manyAffected = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {
        'Some pages have missing or empty title': { severity: 'high' as const, count: 80, examples: ['a', 'b', 'c'] },
      },
    };

    const scoresFew = ScoreCalculator.calculateCategoryScores(
      fewAffected,
      pages100 as unknown as Record<string, PageInfo>,
    );
    const scoresMany = ScoreCalculator.calculateCategoryScores(
      manyAffected,
      pages100 as unknown as Record<string, PageInfo>,
    );
    assert.ok(
      scoresMany.seo < scoresFew.seo,
      `Expected many-affected score (${scoresMany.seo}) < few-affected score (${scoresFew.seo})`,
    );
  });

  void it('security score is mean of per-page securityScore', () => {
    const pages = {
      'https://example.com/': { security: { securityScore: 60 } },
      'https://example.com/about': { security: { securityScore: 40 } },
    };
    const analysisData = { bySeverity: { critical: [], high: [], medium: [], low: [] }, details: {} };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(scores.security, 50);
  });

  void it('accessibility score uses a11yScore + formData when both present', () => {
    const pages = {
      'https://example.com/': {
        formData: { accessibilityScore: 80 },
        accessibility: { violationCount: 2 }, // 100 - 2*10 = 80
      },
    };
    const analysisData = { bySeverity: { critical: [], high: [], medium: [], low: [] }, details: {} };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(scores.accessibility, 80);
  });

  void it('identifies structural issues as quick wins', () => {
    const details = {
      'Some pages have redirect chains or loops': {
        severity: 'critical' as const,
        count: 10,
        examples: ['https://example.com/a', 'https://example.com/b'],
      },
      'Some pages have very thin content': {
        severity: 'high' as const,
        count: 20,
        examples: ['https://example.com/c'],
      },
    };
    const quickWins = ScoreCalculator.identifyQuickWins(details);
    const issues = quickWins.map((q) => q.issue);
    assert.ok(issues.includes('Some pages have redirect chains or loops'), 'Expected redirect chains in quick wins');
    assert.ok(issues.includes('Some pages have very thin content'), 'Expected thin content in quick wins');
  });
});

// ============================================================
// Config Loader - analysis section
// ============================================================
void describe('Config Loader - analysis section', () => {
  void it('has analysis defaults', () => {
    assert.ok(DEFAULT_CONFIG.analysis);
    assert.strictEqual(DEFAULT_CONFIG.analysis.similarityThreshold, 0.6);
    assert.strictEqual(DEFAULT_CONFIG.analysis.maxOutboundChecks, 20);
    assert.strictEqual(DEFAULT_CONFIG.analysis.jsUnusedThreshold, 50);
    assert.strictEqual(DEFAULT_CONFIG.analysis.cssUnusedThreshold, 60);
    assert.strictEqual(DEFAULT_CONFIG.analysis.outboundTimeout, 5000);
  });
});

// ============================================================
// Metrics Metadata - new entries
// ============================================================
void describe('Metrics Metadata - new entries', () => {
  void it('has all new metric entries', () => {
    const newKeys = [
      'internalPageRank',
      'languageDetected',
      'languageMatch',
      'ctaCount',
      'ctaAboveFold',
      'jsUnused',
      'cssUnused',
      'brokenOutboundLinks',
      'mainContentWords',
      'boilerplateRatio',
      'contentSimilarity',
      'responseHeaders',
    ];
    for (const key of newKeys) {
      assert.ok(METRIC_INFO[key], `Missing METRIC_INFO entry: ${key}`);
      assert.ok(METRIC_INFO[key].name, `Missing name for: ${key}`);
    }
  });

  void it('has new signal categories', () => {
    assert.ok(SIGNAL_CATEGORIES.contentInsights);
    assert.ok(SIGNAL_CATEGORIES.codeCoverage);
    assert.ok(SIGNAL_CATEGORIES.advancedLinkAnalysis);
  });
});

// ============================================================
// CLI Summary
// ============================================================
void describe('CLI Summary', () => {
  void it('getJsonSummary includes insights', () => {
    const results = {
      analysis: {
        summary: {
          overallScore: 75,
          totalIssues: 5,
          criticalCount: 0,
          highCount: 1,
          mediumCount: 2,
          lowCount: 2,
          categoryScores: {},
        },
      },
      pageData: {
        pages: {
          'https://example.com/': { languageDetection: { match: false } },
          'https://example.com/about': { outboundLinkHealth: { broken: [{ url: 'http://dead.link' }] } },
        },
        totalWithoutError: 2,
        totalWithError: 0,
      },
    };
    const json = getJsonSummary(
      results as unknown as Parameters<typeof getJsonSummary>[0],
      'example.com',
      '/tmp/report.html',
    );
    assert.ok(json.insights);
    assert.strictEqual(json.insights.languageMismatches, 1);
    assert.strictEqual(json.insights.brokenOutboundLinks, 1);
  });
});

// ============================================================
// History Manager - insights extraction
// ============================================================
void describe('HistoryManager - insights', () => {
  void it('extractInsightsSummary returns metrics', () => {
    const mgr = new HistoryManager('test-domain', '/tmp/audit-test-results');
    const auditData = {
      pageData: {
        pages: {
          'https://example.com/': {
            languageDetection: { match: false },
            outboundLinkHealth: { broken: [{ url: 'http://dead.link' }] },
            codeCoverage: { js: { ratio: 45 }, css: { ratio: 30 } },
            contentSimilarity: { similarPages: ['https://example.com/b'] },
            ctaData: { summary: { total: 0 } },
          },
          'https://example.com/b': {
            languageDetection: { match: true },
            ctaData: { summary: { total: 2 } },
          },
        },
      },
    };
    const insights = mgr.extractInsightsSummary(
      auditData as unknown as Parameters<typeof mgr.extractInsightsSummary>[0],
    );
    assert.ok(insights);
    assert.strictEqual(insights!.languageMismatches, 1);
    assert.strictEqual(insights!.brokenOutboundLinks, 1);
    assert.strictEqual(insights!.nearDuplicatePages, 1);
    assert.strictEqual(insights!.pagesWithoutCTAs, 1);
    assert.strictEqual(insights!.avgJsUnused, 45);
    assert.strictEqual(insights!.avgCssUnused, 30);
  });
});

// ============================================================
// Content Insights Report Section
// ============================================================
void describe('Content Insights Report', () => {
  void it('generates HTML string', () => {
    const html = getContentInsights({ jsonData: { pageData: { pages: {} }, analysis: {} } } as unknown as Parameters<
      typeof getContentInsights
    >[0]);
    assert.strictEqual(typeof html, 'string');
    assert.ok(html.includes('content-insights') || html.length === 0 || html.includes('section'));
  });
});
