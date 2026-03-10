const { describe, it } = require('node:test');
const assert = require('node:assert');

// ============================================================
// Response Header Analyzer
// ============================================================
describe('ResponseHeaderAnalyzer', () => {
  const { ResponseHeaderAnalyzer } = require('../lib/analyzers/seo/response-header-analyzer');

  it('detects X-Robots-Tag noindex in info', () => {
    const pageData = {
      responseHeaders: { 'x-robots-tag': 'noindex', 'content-type': 'text/html' },
    };
    const result = ResponseHeaderAnalyzer.analyze(pageData, 'https://example.com/');
    assert.ok(result.info);
    assert.strictEqual(result.info.noindexViaHeader, true);
    assert.strictEqual(result.info.xRobotsTag, 'noindex');
  });

  it('site-wide detects X-Robots-Tag noindex pages', () => {
    const allPages = {
      'https://example.com/': {
        responseHeaderAnalysis: { noindexViaHeader: true },
      },
    };
    const result = ResponseHeaderAnalyzer.analyzeSiteWide(allPages);
    assert.ok(result.issues.some(i => (i.title || '').toLowerCase().includes('x-robots-tag')));
  });

  it('returns no issues for clean headers', () => {
    const pageData = {
      responseHeaders: { 'content-type': 'text/html' },
    };
    const result = ResponseHeaderAnalyzer.analyze(pageData, 'https://example.com/');
    assert.strictEqual(result.issues.length, 0);
  });
});

// ============================================================
// Language Detection Analyzer (public API only - needs browser for full test)
// ============================================================
describe('LanguageDetectionAnalyzer', () => {
  const { LanguageDetectionAnalyzer } = require('../lib/analyzers/content/language-detection-analyzer');

  it('exports analyzeLanguage method', () => {
    assert.strictEqual(typeof LanguageDetectionAnalyzer.analyzeLanguage, 'function');
  });

  it('exports analyzeSiteWide method', () => {
    assert.strictEqual(typeof LanguageDetectionAnalyzer.analyzeSiteWide, 'function');
  });

  it('site-wide detects language mismatches', () => {
    const allPages = {
      'https://example.com/': {
        url: 'https://example.com/',
        languageDetection: { match: false, detectedLanguage: 'fr', declaredLanguage: 'en', detectedConfidence: 0.8, htmlLang: 'en' },
      },
      'https://example.com/about': {
        url: 'https://example.com/about',
        languageDetection: { match: true, detectedLanguage: 'en', declaredLanguage: 'en', detectedConfidence: 0.9, htmlLang: 'en' },
      },
    };
    const result = LanguageDetectionAnalyzer.analyzeSiteWide(allPages);
    assert.ok(result.issues.some(i => (i.title || i.description || '').toLowerCase().includes('language')));
  });
});

// ============================================================
// Content Similarity Analyzer
// ============================================================
describe('ContentSimilarityAnalyzer', () => {
  const { ContentSimilarityAnalyzer } = require('../lib/analyzers/site-wide/content-similarity-analyzer');

  it('detects similar pages', () => {
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

    const result = ContentSimilarityAnalyzer.analyze(allPages);
    // Pages A and B should be detected as similar
    const pageA = allPages['https://example.com/a'];
    assert.ok(pageA.contentSimilarity);
    assert.ok(pageA.contentSimilarity.similarPages.length > 0);
    // Page C should not be similar to A/B
    const pageC = allPages['https://example.com/c'];
    assert.strictEqual(pageC.contentSimilarity?.similarPages?.length || 0, 0);
  });

  it('handles pages without keywords', () => {
    const allPages = {
      'https://example.com/a': { contentQuality: { wordCount: 10 } },
      'https://example.com/b': {},
    };
    const result = ContentSimilarityAnalyzer.analyze(allPages);
    assert.ok(result);
    assert.ok(Array.isArray(result.issues));
  });
});

// ============================================================
// Internal PageRank Analyzer
// ============================================================
describe('InternalPageRankAnalyzer', () => {
  const { InternalPageRankAnalyzer } = require('../lib/analyzers/site-wide/internal-pagerank-analyzer');

  it('exports analyze method', () => {
    assert.strictEqual(typeof InternalPageRankAnalyzer.analyze, 'function');
  });

  it('returns result with issues array', () => {
    const allPages = {
      'https://example.com/': { internalLinks: [{ href: 'https://example.com/about' }] },
      'https://example.com/about': { internalLinks: [{ href: 'https://example.com/' }] },
    };
    const incomingLinks = {
      'https://example.com/': ['https://example.com/about'],
      'https://example.com/about': ['https://example.com/'],
    };
    const result = InternalPageRankAnalyzer.analyze(allPages, incomingLinks, 'https://example.com');
    assert.ok(result);
    assert.ok(Array.isArray(result.issues));
    // Both pages should have PageRank assigned
    assert.ok(allPages['https://example.com/'].internalPageRank != null);
    assert.ok(allPages['https://example.com/about'].internalPageRank != null);
  });
});

// ============================================================
// Code Coverage Analyzer
// ============================================================
describe('CodeCoverageAnalyzer', () => {
  const { CodeCoverageAnalyzer } = require('../lib/analyzers/performance/code-coverage-analyzer');

  it('exports startCoverage and analyze methods', () => {
    assert.strictEqual(typeof CodeCoverageAnalyzer.startCoverage, 'function');
    assert.strictEqual(typeof CodeCoverageAnalyzer.analyze, 'function');
  });
});

// ============================================================
// CTA Detector Analyzer
// ============================================================
describe('CTADetectorAnalyzer', () => {
  const { CTADetectorAnalyzer } = require('../lib/analyzers/content/cta-detector-analyzer');

  it('exports analyzeCTAs method', () => {
    assert.strictEqual(typeof CTADetectorAnalyzer.analyzeCTAs, 'function');
  });
});

// ============================================================
// Outbound Link Checker
// ============================================================
describe('OutboundLinkChecker', () => {
  const { OutboundLinkChecker } = require('../lib/analyzers/content/outbound-link-checker');

  it('exports analyze method', () => {
    assert.strictEqual(typeof OutboundLinkChecker.analyze, 'function');
  });
});

// ============================================================
// Score Calculator - new patterns
// ============================================================
describe('ScoreCalculator - new patterns', () => {
  const { ScoreCalculator } = require('../lib/scoring/score-calculator');

  // Need at least one page to avoid early return
  const dummyPages = { 'https://example.com/': {} };

  it('categorizes language-related issues to SEO', () => {
    const analysisData = {
      bySeverity: {
        critical: [],
        high: ['Detected content language does not match declared language'],
        medium: [],
        low: [],
      },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, dummyPages);
    assert.ok(scores.seo < 100, `Expected seo < 100, got ${scores.seo}`);
  });

  it('categorizes unused JavaScript to performance', () => {
    const analysisData = {
      bySeverity: {
        critical: [],
        high: [],
        medium: ['High percentage of unused JavaScript'],
        low: [],
      },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, dummyPages);
    assert.ok(scores.performance < 100, `Expected performance < 100, got ${scores.performance}`);
  });

  it('categorizes x-robots-tag to SEO (matches "robots" pattern)', () => {
    const analysisData = {
      bySeverity: {
        critical: [],
        high: ['Pages blocked via X-Robots-Tag header'],
        medium: [],
        low: [],
      },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, dummyPages);
    // "x-robots-tag" matches "robots" pattern → categorized as SEO
    assert.ok(scores.seo < 100, `Expected seo < 100, got ${scores.seo}`);
  });

  it('scales penalty by affected page count from details', () => {
    // 2% affected vs 80% affected on same total should differ
    const pages100 = {};
    for (let i = 0; i < 100; i++) pages100[`https://example.com/${i}`] = {};

    const fewAffected = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {
        'Some pages have missing or empty title': { severity: 'high', count: 2, examples: ['a', 'b'] },
      },
    };
    const manyAffected = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {
        'Some pages have missing or empty title': { severity: 'high', count: 80, examples: ['a', 'b', 'c'] },
      },
    };

    const scoresFew = ScoreCalculator.calculateCategoryScores(fewAffected, pages100);
    const scoresMany = ScoreCalculator.calculateCategoryScores(manyAffected, pages100);
    assert.ok(scoresMany.seo < scoresFew.seo, `Expected many-affected penalty (${scoresMany.seo}) < few-affected penalty (${scoresFew.seo})`);
  });

  it('reads security score from page.security.securityScore', () => {
    const pages = {
      'https://example.com/': { security: { securityScore: 60 } },
      'https://example.com/about': { security: { securityScore: 40 } },
    };
    const analysisData = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, pages);
    assert.strictEqual(scores.security, 50, `Expected security=50 (avg of 60,40), got ${scores.security}`);
  });

  it('reads accessibility from formData.accessibilityScore and violations', () => {
    const pages = {
      'https://example.com/': {
        formData: { accessibilityScore: 80 },
        accessibility: { violationCount: 2 }, // 100 - 2*10 = 80
      },
    };
    const analysisData = {
      bySeverity: { critical: [], high: [], medium: [], low: [] },
      details: {},
    };
    const scores = ScoreCalculator.calculateCategoryScores(analysisData, pages);
    // Average of 80 (formData) and 80 (violations) = 80
    assert.strictEqual(scores.accessibility, 80, `Expected accessibility=80, got ${scores.accessibility}`);
  });

  it('identifies structural issues as quick wins', () => {
    const details = {
      'Some pages have redirect chains or loops': {
        severity: 'critical',
        count: 10,
        examples: ['https://example.com/a', 'https://example.com/b'],
      },
      'Some pages have very thin content': {
        severity: 'high',
        count: 20,
        examples: ['https://example.com/c'],
      },
    };
    const quickWins = ScoreCalculator.identifyQuickWins(details);
    const issues = quickWins.map(q => q.issue);
    assert.ok(issues.includes('Some pages have redirect chains or loops'), 'Expected redirect chains in quick wins');
    assert.ok(issues.includes('Some pages have very thin content'), 'Expected thin content in quick wins');
  });
});

// ============================================================
// Config Loader - analysis section
// ============================================================
describe('Config Loader - analysis section', () => {
  const { DEFAULT_CONFIG } = require('../lib/config-loader');

  it('has analysis defaults', () => {
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
describe('Metrics Metadata - new entries', () => {
  const { METRIC_INFO, SIGNAL_CATEGORIES } = require('../lib/reports/metrics-metadata');

  it('has all new metric entries', () => {
    const newKeys = [
      'internalPageRank', 'languageDetected', 'languageMatch',
      'ctaCount', 'ctaAboveFold', 'jsUnused', 'cssUnused',
      'brokenOutboundLinks', 'mainContentWords', 'boilerplateRatio',
      'contentSimilarity', 'responseHeaders',
    ];
    for (const key of newKeys) {
      assert.ok(METRIC_INFO[key], `Missing METRIC_INFO entry: ${key}`);
      assert.ok(METRIC_INFO[key].name, `Missing name for: ${key}`);
    }
  });

  it('has new signal categories', () => {
    assert.ok(SIGNAL_CATEGORIES.contentInsights);
    assert.ok(SIGNAL_CATEGORIES.codeCoverage);
    assert.ok(SIGNAL_CATEGORIES.advancedLinkAnalysis);
  });
});

// ============================================================
// CLI Summary
// ============================================================
describe('CLI Summary', () => {
  const { getJsonSummary } = require('../lib/utils/cli-summary');

  it('getJsonSummary includes insights', () => {
    const results = {
      analysis: { summary: { overallScore: 75, totalIssues: 5, criticalCount: 0, highCount: 1, mediumCount: 2, lowCount: 2, categoryScores: {} } },
      pageData: {
        pages: {
          'https://example.com/': { languageDetection: { match: false } },
          'https://example.com/about': { outboundLinkHealth: { broken: [{ url: 'http://dead.link' }] } },
        },
        totalWithoutError: 2,
        totalWithError: 0,
      },
    };
    const json = getJsonSummary(results, 'example.com', '/tmp/report.html');
    assert.ok(json.insights);
    assert.strictEqual(json.insights.languageMismatches, 1);
    assert.strictEqual(json.insights.brokenOutboundLinks, 1);
  });
});

// ============================================================
// History Manager - insights extraction
// ============================================================
describe('HistoryManager - insights', () => {
  const { HistoryManager } = require('../historyManager');

  it('extractInsightsSummary returns metrics', () => {
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
    const insights = mgr.extractInsightsSummary(auditData);
    assert.strictEqual(insights.languageMismatches, 1);
    assert.strictEqual(insights.brokenOutboundLinks, 1);
    assert.strictEqual(insights.nearDuplicatePages, 1);
    assert.strictEqual(insights.pagesWithoutCTAs, 1);
    assert.strictEqual(insights.avgJsUnused, 45);
    assert.strictEqual(insights.avgCssUnused, 30);
  });
});

// ============================================================
// Content Insights Report Section
// ============================================================
describe('Content Insights Report', () => {
  const { getContentInsights } = require('../lib/reports/sections/content-insights');

  it('generates HTML string', () => {
    const html = getContentInsights({ jsonData: { pageData: { pages: {} }, analysis: {} } });
    assert.strictEqual(typeof html, 'string');
    assert.ok(html.includes('content-insights') || html.length === 0 || html.includes('section'));
  });
});
