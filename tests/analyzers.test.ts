import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ResponseHeaderAnalyzer } from '../lib/analyzers/seo/response-header-analyzer';
import { LanguageDetectionAnalyzer } from '../lib/analyzers/content/language-detection-analyzer';
import { ContentSimilarityAnalyzer } from '../lib/analyzers/site-wide/content-similarity-analyzer';
import { InternalPageRankAnalyzer } from '../lib/analyzers/site-wide/internal-pagerank-analyzer';
import { CodeCoverageAnalyzer } from '../lib/analyzers/performance/code-coverage-analyzer';
import { CTADetectorAnalyzer } from '../lib/analyzers/content/cta-detector-analyzer';
import { OutboundLinkChecker } from '../lib/analyzers/content/outbound-link-checker';
import { BrokenPaginationAnalyzer } from '../lib/analyzers/site-wide/broken-pagination-analyzer';
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

// ============================================================
// RepresentativeSampler — Phase 1 A2.1
// ============================================================
import { RepresentativeSampler } from '../lib/crawler/representative-sampler';

void describe('RepresentativeSampler', () => {
  void it('buckets URLs by template and dedupes within a bucket', () => {
    const s = new RepresentativeSampler(10);
    assert.strictEqual(s.shouldSample('https://example.com/'), true); // bucket "/"
    assert.strictEqual(s.shouldSample('https://example.com'), false); // same bucket
    assert.strictEqual(s.shouldSample('https://example.com/about'), true); // "/about"
    assert.strictEqual(s.shouldSample('https://example.com/blog'), true); // "/blog"
    assert.strictEqual(s.shouldSample('https://example.com/blog/x'), true); // "/blog/*"
    assert.strictEqual(s.shouldSample('https://example.com/blog/y'), false); // same bucket
  });

  void it('respects the cap', () => {
    const s = new RepresentativeSampler(3);
    s.shouldSample('https://x.com/');
    s.shouldSample('https://x.com/a');
    s.shouldSample('https://x.com/b');
    assert.strictEqual(s.shouldSample('https://x.com/c'), false);
    assert.strictEqual(s.getSampledUrls().length, 3);
  });

  void it('returns null bucket for unparseable URLs', () => {
    assert.strictEqual(RepresentativeSampler.bucketOf('not a url'), null);
  });
});

// ============================================================
// populateIncomingLinksCount — incoming-links key normalization
// ============================================================
import { populateIncomingLinksCount } from '../lib/crawler/page-data-builder';

void describe('populateIncomingLinksCount', () => {
  const build = (
    pageUrls: string[],
    incomingLinks: Record<string, string[]>,
  ) =>
    ({
      pageData: {
        pages: Object.fromEntries(pageUrls.map((u) => [u, { url: u } as PageInfo])),
        incomingLinks,
      },
    }) as unknown as Parameters<typeof populateIncomingLinksCount>[0];

  void it('counts incoming links when page URL matches the map key exactly', () => {
    const r = build(['https://x.com/docs/install'], {
      'https://x.com/docs/install': ['https://x.com/a', 'https://x.com/b'],
    });
    populateIncomingLinksCount(r);
    assert.strictEqual(r.pageData.pages['https://x.com/docs/install'].incomingLinksCount, 2);
    assert.strictEqual(r.pageData.pages['https://x.com/docs/install'].hasIncomingLinks, true);
  });

  void it('resolves the bare-origin page against the normalized (trailing-slash) map key', () => {
    // The map is keyed by normalizeUrl(href); a link to "/" becomes
    // "https://x.com/", but the page may be crawled as the bare origin.
    const r = build(['https://x.com'], {
      'https://x.com/': ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
    });
    populateIncomingLinksCount(r);
    assert.strictEqual(r.pageData.pages['https://x.com'].incomingLinksCount, 3);
    assert.strictEqual(r.pageData.pages['https://x.com'].hasIncomingLinks, true);
  });

  void it('marks pages with no incoming links as orphaned (count 0)', () => {
    const r = build(['https://x.com/orphan'], {
      'https://x.com/other': ['https://x.com/a'],
    });
    populateIncomingLinksCount(r);
    assert.strictEqual(r.pageData.pages['https://x.com/orphan'].incomingLinksCount, 0);
    assert.strictEqual(r.pageData.pages['https://x.com/orphan'].hasIncomingLinks, false);
  });
});

// ============================================================
// Phase 2 categorize — JS errors vs JS performance routing
// ============================================================
import { categorize } from '../lib/phase2/categorize';

void describe('categorize (Phase 2 routing)', () => {
  void it('routes JS errors to technical, not performance', () => {
    assert.strictEqual(categorize('Critical JavaScript errors detected'), 'technical');
    assert.strictEqual(categorize('JavaScript console errors'), 'technical');
    assert.strictEqual(categorize('Uncaught exception on checkout'), 'technical');
  });

  void it('routes JS performance to performance', () => {
    assert.strictEqual(categorize('High percentage of unused JavaScript'), 'performance');
    assert.strictEqual(categorize('JavaScript bundle is too large'), 'performance');
  });

  void it('routes 404s to seo', () => {
    assert.strictEqual(categorize('Broken pages (404 errors) are being crawled'), 'seo');
    assert.strictEqual(categorize('Sitemap contains URLs that return 4xx'), 'seo');
  });

  void it('routes hreflang to seo', () => {
    assert.strictEqual(categorize('Hreflang alternate URLs are not fully qualified'), 'seo');
  });

  void it('routes cookies/consent to privacy', () => {
    assert.strictEqual(categorize('Tracking cookies without consent banner'), 'privacy');
    assert.strictEqual(categorize('Cookies with excessive lifespan'), 'privacy');
  });

  void it('routes axe / WCAG to accessibility', () => {
    assert.strictEqual(categorize('Color contrast fails WCAG AA'), 'accessibility');
    assert.strictEqual(categorize('Form inputs missing labels'), 'accessibility');
  });

  void it('falls back to technical for unknown', () => {
    assert.strictEqual(categorize('Some completely unknown finding xyz'), 'technical');
  });
});

// ============================================================
// Phase 2 consolidation / de-duplication
// ============================================================
import { consolidateFindings, findingGroupKey } from '../lib/phase2/consolidate';
import type { IssueDetail } from '../lib/phase2/types';

const det = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  severity: 'medium',
  count: 1,
  examples: [],
  ...over,
});

void describe('consolidateFindings (Phase 2 de-dup)', () => {
  void it('folds the unreachable-pages finding into the orphan-pages finding', () => {
    const out = consolidateFindings({
      '8 orphan pages detected (no internal links pointing to them)': det({ severity: 'high', count: 8 }),
      '9 pages are unreachable from homepage via internal links': det({ severity: 'medium', count: 9 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.some((k) => /orphan pages detected/.test(k)));
    assert.ok(!keys.some((k) => /unreachable from homepage/.test(k)), 'unreachable should be folded away');
    // Kept entry escalates to the most-severe and broadest count.
    const orphan = out['8 orphan pages detected (no internal links pointing to them)'];
    assert.strictEqual(orphan.severity, 'high');
    assert.strictEqual(orphan.count, 9);
  });

  void it('folds "inconsistent cookie consent" into the tracking-cookies finding', () => {
    const out = consolidateFindings({
      'Multiple tracking cookies set before consent': det({ severity: 'medium', count: 3 }),
      'Inconsistent cookie consent implementation': det({ severity: 'high', count: 5 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.includes('Multiple tracking cookies set before consent'));
    assert.ok(!keys.includes('Inconsistent cookie consent implementation'));
    assert.strictEqual(out['Multiple tracking cookies set before consent'].severity, 'high');
  });
});

void describe('findingGroupKey (cross-list identity)', () => {
  void it('maps differently-worded duplicate-title findings to one identity', () => {
    assert.strictEqual(
      findingGroupKey('Duplicate page titles found'),
      findingGroupKey('Some pages have identical titles'),
    );
  });

  void it('maps orphan and unreachable findings to one identity', () => {
    assert.strictEqual(
      findingGroupKey('8 orphan pages detected (no internal links pointing to them)'),
      findingGroupKey('9 pages are unreachable from homepage via internal links'),
    );
  });

  void it('keeps unrelated findings distinct', () => {
    assert.notStrictEqual(
      findingGroupKey('Canonicals are not set for some pages'),
      findingGroupKey('Duplicate page titles found'),
    );
  });
});

// ============================================================
// Phase 2 benchmarks (threshold + why for comparative findings)
// ============================================================
import { benchmarkFor } from '../lib/phase2/benchmarks';

void describe('benchmarkFor', () => {
  void it('returns a benchmark anchored to the real threshold', () => {
    const b = benchmarkFor('Some pages have too many requests');
    assert.ok(b && /≤20 requests/.test(b), `expected request threshold, got: ${b}`);
  });

  void it('covers render-blocking, unused CSS/JS, and third-party payload', () => {
    assert.ok(/≤5 render-blocking/.test(benchmarkFor('Some pages have too many render-blocking resources') ?? ''));
    assert.ok(/80%/.test(benchmarkFor('High percentage of unused CSS') ?? ''));
    assert.ok(/70%/.test(benchmarkFor('High percentage of unused JavaScript') ?? ''));
    assert.ok(/third-party payload/i.test(benchmarkFor('Excessive third-party payload') ?? ''));
  });

  void it('every benchmark states both a target and a rationale', () => {
    const samples = [
      'Some pages have titles that are too long',
      'Some pages have descriptions that are too short',
      'Element with too many children',
      'Large HTML document',
    ];
    for (const s of samples) {
      const b = benchmarkFor(s);
      assert.ok(b && b.length > 20, `missing benchmark for: ${s}`);
    }
  });

  void it('returns undefined for non-comparative findings', () => {
    assert.strictEqual(benchmarkFor('Some pages are missing canonical URL'), undefined);
    assert.strictEqual(benchmarkFor('Invalid JSON-LD schema'), undefined);
  });
});

void describe('ScoreCalculator.effortLevel', () => {
  void it('maps minute estimates to low and hour estimates to medium/high', () => {
    assert.strictEqual(ScoreCalculator.effortLevel('5 minutes'), 'low');
    assert.strictEqual(ScoreCalculator.effortLevel('30 minutes'), 'low');
    assert.strictEqual(ScoreCalculator.effortLevel('1 hour'), 'medium');
    assert.strictEqual(ScoreCalculator.effortLevel('2 hours'), 'medium');
    assert.strictEqual(ScoreCalculator.effortLevel('4-8 hours'), 'high');
  });

  void it('prefers a pre-parsed effortMinutes when supplied', () => {
    assert.strictEqual(ScoreCalculator.effortLevel('ignored', 10), 'low');
    assert.strictEqual(ScoreCalculator.effortLevel('ignored', 200), 'high');
  });

  void it('defaults to medium when effort is unknown', () => {
    assert.strictEqual(ScoreCalculator.effortLevel(undefined), 'medium');
  });
});

// ============================================================
// PackageAnalyzer — Phase 1 (repo)
// ============================================================
import { PackageAnalyzer } from '../lib/analyzers/repo/package-analyzer';

void describe('PackageAnalyzer', () => {
  void it('flags wildcard ranges', () => {
    const r = PackageAnalyzer.analyze({ dependencies: { foo: '*', bar: 'latest', baz: '^1.0.0' } });
    assert.ok(r.warnings.some((w) => /wildcard/i.test(w.message ?? '')));
  });

  void it('flags Next/React major mismatch as HIGH', () => {
    const r = PackageAnalyzer.analyze({ dependencies: { next: '^13.4.0', react: '^17.0.2' } });
    const mismatch = r.issues.find((i) => /newer React/i.test(i.message ?? ''));
    assert.ok(mismatch, 'expected mismatch issue');
    assert.strictEqual(mismatch?.severity, 'high');
  });

  void it('does not fire mismatch when Next and React are compatible', () => {
    const r = PackageAnalyzer.analyze({ dependencies: { next: '^14.2.0', react: '^18.2.0' } });
    assert.ok(!r.issues.some((i) => /newer React/i.test(i.message ?? '')));
  });

  void it('flags multiple styling solutions only at >=3', () => {
    const two = PackageAnalyzer.analyze({
      dependencies: { 'styled-components': '^6', '@emotion/react': '^11' },
    });
    assert.ok(!two.warnings.some((w) => /Multiple styling/i.test(w.message ?? '')));

    const three = PackageAnalyzer.analyze({
      dependencies: { 'styled-components': '^6', '@emotion/react': '^11', tailwindcss: '^3' },
    });
    assert.ok(three.warnings.some((w) => /Multiple styling/i.test(w.message ?? '')));
  });
});

// ============================================================
// parseSrcset — Phase 1 A3.1
// ============================================================
import { parseSrcset } from '../lib/analyzers/performance/image-optimization-analyzer';

void describe('parseSrcset', () => {
  void it('parses w-descriptor multi-candidate', () => {
    const r = parseSrcset('a-400.jpg 400w, a-800.jpg 800w, a-1200.jpg 1200w');
    assert.strictEqual(r.length, 3);
    assert.deepStrictEqual(r[1], { url: 'a-800.jpg', value: 800, kind: 'w' });
  });

  void it('parses x-descriptor multi-candidate', () => {
    const r = parseSrcset('a.jpg 1x, a-2x.jpg 2x, a-3x.jpg 3x');
    assert.strictEqual(r.length, 3);
    assert.strictEqual(r[2].value, 3);
    assert.strictEqual(r[2].kind, 'x');
  });

  void it('treats descriptor-less URL as 1x', () => {
    const r = parseSrcset('a.jpg');
    assert.deepStrictEqual(r, [{ url: 'a.jpg', value: 1, kind: 'x' }]);
  });

  void it('returns [] for empty input', () => {
    assert.deepStrictEqual(parseSrcset(''), []);
  });

  void it('silently skips garbage descriptors', () => {
    // "garbage" isn't Nw or Nx → that candidate is dropped, others kept.
    const r = parseSrcset('a.jpg garbage, b.jpg 200w');
    assert.deepStrictEqual(r, [{ url: 'b.jpg', value: 200, kind: 'w' }]);
  });

  void it('handles fractional x descriptors', () => {
    const r = parseSrcset('a.jpg 1.5x');
    assert.deepStrictEqual(r, [{ url: 'a.jpg', value: 1.5, kind: 'x' }]);
  });
});

// ============================================================
// normalizeMessage / mergeNumericVariants — Phase 2 dedup
// ============================================================
import { normalizeMessage, mergeNumericVariants, sanitizeProse } from '../lib/phase2/phase2-runner';
import { normalizeMessageForLookup } from '../lib/utils/finding-id';

void describe('sanitizeProse', () => {
  void it('preserves element-name mentions as inline code so marked does not swallow them', () => {
    assert.strictEqual(
      sanitizeProse('Use semantic elements (<main>, <article>, <section>, <nav>) for AI.'),
      'Use semantic elements (`<main>`, `<article>`, `<section>`, `<nav>`) for AI.',
    );
  });

  void it('unwraps anchor markup to its inner text', () => {
    assert.strictEqual(
      sanitizeProse('<a href="https://x.com/p">https://x.com/p</a> has no <main> landmark.'),
      'https://x.com/p has no `<main>` landmark.',
    );
  });

  void it('leaves plain prose untouched', () => {
    assert.strictEqual(sanitizeProse('Replace generic divs with semantic elements.'), 'Replace generic divs with semantic elements.');
  });
});

void describe('normalizeMessage', () => {
  void it('strips trailing (N elements) tokens', () => {
    assert.strictEqual(
      normalizeMessage('Color contrast fails WCAG AA (24 elements)'),
      'Color contrast fails WCAG AA',
    );
  });

  void it('strips trailing bare (N) tokens', () => {
    assert.strictEqual(
      normalizeMessage('Some pages have too many h2 tags (16)'),
      'Some pages have too many h2 tags',
    );
  });

  void it('strips trailing (N units) with hyphenated units', () => {
    assert.strictEqual(normalizeMessage('Large DOM size (1357 dom-nodes)'), 'Large DOM size');
  });

  void it('does not strip parenthesised numbers in the middle of the message', () => {
    assert.strictEqual(
      normalizeMessage('LCP (2.7s) on the homepage'),
      'LCP (2.7s) on the homepage',
    );
  });

  void it('returns the input unchanged when there is no trailing token', () => {
    assert.strictEqual(normalizeMessage('Description meta tag is missing'), 'Description meta tag is missing');
  });

  void it('does not strip a leading count (that is normalizeMessageForLookup only)', () => {
    assert.strictEqual(
      normalizeMessage('5 pages have critical JavaScript errors'),
      '5 pages have critical JavaScript errors',
    );
  });
});

void describe('normalizeMessageForLookup', () => {
  void it('strips a leading count prefix', () => {
    assert.strictEqual(
      normalizeMessageForLookup('5 pages have critical JavaScript errors'),
      'pages have critical JavaScript errors',
    );
  });

  void it('strips a leading percentage prefix with optional "of"', () => {
    assert.strictEqual(
      normalizeMessageForLookup('12% of pages have near-duplicate content'),
      'pages have near-duplicate content',
    );
    assert.strictEqual(
      normalizeMessageForLookup('38% pages have very thin content'),
      'pages have very thin content',
    );
  });

  void it('still strips trailing (N units) tokens like normalizeMessage', () => {
    assert.strictEqual(
      normalizeMessageForLookup('Color contrast fails WCAG AA (24 elements)'),
      'Color contrast fails WCAG AA',
    );
  });
});

void describe('mergeNumericVariants', () => {
  void it('sums counts across variants', () => {
    const merged = mergeNumericVariants({
      'X fails (24 elements)': { severity: 'high', count: 5, examples: ['a'] },
      'X fails (25 elements)': { severity: 'high', count: 5, examples: ['b'] },
      'X fails (18 elements)': { severity: 'high', count: 5, examples: ['c'] },
    });
    const keys = Object.keys(merged);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(merged[keys[0]].count, 15);
    assert.deepStrictEqual(merged[keys[0]].examples, ['a', 'b', 'c']);
  });

  void it('keeps the highest severity when merging', () => {
    const merged = mergeNumericVariants({
      'X (1)': { severity: 'low', count: 1, examples: [] },
      'X (2)': { severity: 'high', count: 1, examples: [] },
      'X (3)': { severity: 'medium', count: 1, examples: [] },
    });
    const v = Object.values(merged)[0];
    assert.strictEqual(v.severity, 'high');
  });

  void it('dedupes identical example URLs across variants', () => {
    const merged = mergeNumericVariants({
      'X (1)': { severity: 'low', count: 1, examples: ['https://example.com/a'] },
      'X (2)': { severity: 'low', count: 1, examples: ['https://example.com/a'] },
    });
    const v = Object.values(merged)[0];
    assert.strictEqual(v.examples?.length, 1);
  });

  void it('leaves genuinely-distinct messages distinct', () => {
    const merged = mergeNumericVariants({
      'Missing alt text': { severity: 'medium', count: 3, examples: [] },
      'Missing meta description': { severity: 'critical', count: 2, examples: [] },
    });
    assert.strictEqual(Object.keys(merged).length, 2);
  });
});

// ============================================================
// SourcePatternAnalyzer — Phase 1 (repo, source-level)
// ============================================================
import { SourcePatternAnalyzer } from '../lib/analyzers/repo/source-pattern-analyzer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Build a tiny fake Next.js repo containing one source file; return root path. */
function fakeRepo(filename: string, contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-pat-'));
  const file = path.join(root, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return root;
}

/** Convenience for messages including given substring. */
function find<T extends { message?: string }>(arr: T[], fragment: string): T | undefined {
  return arr.find((i) => (i.message ?? '').toLowerCase().includes(fragment.toLowerCase()));
}

void describe('SourcePatternAnalyzer', () => {
  void it('returns nothing for non-Next.js frameworks', () => {
    const root = fakeRepo('app/page.tsx', `export default function P() { return null; }`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nuxt', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(r.issues.length, 0);
    assert.strictEqual(r.warnings.length, 0);
  });

  void it('flags cache: "no-store"', () => {
    const root = fakeRepo(
      'app/fetcher.ts',
      `export async function load() {\n  return fetch('/api/x', { cache: "no-store" });\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'disable the Next.js data cache'));
  });

  void it("flags dynamic import with ssr: false even when callback has its own parens", () => {
    const root = fakeRepo(
      'app/page.tsx',
      `import dynamic from 'next/dynamic';\nconst Heavy = dynamic(() => import('./Heavy'), { ssr: false });\nexport default function P() { return <Heavy />; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    const hit = find(r.issues, 'ssr: false break SEO');
    assert.ok(hit, `expected ssr:false finding, got ${JSON.stringify([...r.issues, ...r.warnings])}`);
    assert.strictEqual(hit?.severity, 'high');
  });

  void it('flags force-dynamic export', () => {
    const root = fakeRepo(
      'app/icon.tsx',
      `export const dynamic = 'force-dynamic';\nexport default function Icon() { return null; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'force-dynamic'));
  });

  void it('flags full-lib lodash imports', () => {
    const root = fakeRepo(
      'app/utils.ts',
      `import _ from 'lodash';\nexport const d = _.debounce(() => {}, 100);\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'lodash imported as a whole library'));
  });

  void it('does NOT flag method-specific lodash imports', () => {
    const root = fakeRepo(
      'app/utils.ts',
      `import debounce from 'lodash.debounce';\nimport throttle from 'lodash/throttle';\nexport { debounce, throttle };\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'lodash imported as a whole library'));
  });

  void it('flags CSS inlined in _app via dangerouslySetInnerHTML', () => {
    const root = fakeRepo(
      'pages/_app.tsx',
      `import fs from 'fs';\nexport default function App() {\n  return <style dangerouslySetInnerHTML={{ __html: fs.readFileSync('a.css','utf8') }} />;\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['pages'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'CSS inlined via dangerouslySetInnerHTML in _app'));
  });

  void it('does NOT flag CSS-inline pattern in non-_app files', () => {
    const root = fakeRepo(
      'pages/index.tsx',
      `import fs from 'fs';\nexport default function P() {\n  return <style dangerouslySetInnerHTML={{ __html: fs.readFileSync('a.css','utf8') }} />;\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['pages'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'CSS inlined'));
  });

  void it('skips node_modules and similar dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-pat-skip-'));
    const nm = path.join(root, 'app', 'node_modules', 'evil');
    fs.mkdirSync(nm, { recursive: true });
    // place a violating pattern inside node_modules
    fs.writeFileSync(
      path.join(nm, 'leaked.ts'),
      `export const dynamic = 'force-dynamic';\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'nextjs', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'force-dynamic'));
  });
});

// ============================================================
// Stable finding identity (slug + volatility)
// ============================================================
import { slugifyFinding, isVolatileFinding } from '../lib/utils/finding-id';

void describe('slugifyFinding', () => {
  void it('produces a stable kebab-case slug', () => {
    assert.strictEqual(slugifyFinding('Color contrast fails WCAG AA'), 'color-contrast-fails-wcag-aa');
  });

  void it('returns the same slug for numeric variants', () => {
    assert.strictEqual(
      slugifyFinding('Color contrast fails WCAG AA (24 elements)'),
      slugifyFinding('Color contrast fails WCAG AA (25 elements)'),
    );
  });

  void it('strips HTML wrappers before slugifying', () => {
    assert.strictEqual(
      slugifyFinding('<a href="x">Description meta tag is missing</a>'),
      slugifyFinding('Description meta tag is missing'),
    );
  });

  void it('caps slug length', () => {
    const long = 'a'.repeat(500);
    assert.ok(slugifyFinding(long).length <= 120);
  });
});

void describe('isVolatileFinding', () => {
  void it('flags timing-based findings as volatile', () => {
    assert.strictEqual(isVolatileFinding('Some pages have LCP more than 2500ms'), true);
    assert.strictEqual(isVolatileFinding('TTFB exceeds threshold'), true);
    assert.strictEqual(isVolatileFinding('Core Web Vitals fail on /products'), true);
    assert.strictEqual(isVolatileFinding('High percentage of unused JavaScript'), true);
    assert.strictEqual(isVolatileFinding('Excessive third-party payload'), true);
  });

  void it('does not flag structural findings', () => {
    assert.strictEqual(isVolatileFinding('Description meta tag is missing'), false);
    assert.strictEqual(isVolatileFinding('Hreflang alternates are not fully qualified'), false);
    assert.strictEqual(isVolatileFinding('Trailing slash inconsistencies in sitemap'), false);
    assert.strictEqual(isVolatileFinding('Cookies with excessive lifespan'), false);
  });
});

// ============================================================
// computeContentHash — normalises drift sources
// ============================================================
import { computeContentHash } from '../lib/utils/content-hash';

void describe('computeContentHash', () => {
  void it('returns the same hash for identical HTML', () => {
    const a = computeContentHash('<html><body><h1>Hi</h1></body></html>');
    const b = computeContentHash('<html><body><h1>Hi</h1></body></html>');
    assert.strictEqual(a, b);
  });

  void it('ignores whitespace differences', () => {
    const a = computeContentHash('<html><body><h1>Hi</h1></body></html>');
    const b = computeContentHash('<html>\n  <body>\n    <h1>Hi</h1>\n  </body>\n</html>');
    assert.strictEqual(a, b);
  });

  void it('ignores cache-busted Next.js chunk URLs', () => {
    const a = computeContentHash('<script src="/_next/static/chunks/abc123def456.js"></script>');
    const b = computeContentHash('<script src="/_next/static/chunks/zzz987qqq000.js"></script>');
    assert.strictEqual(a, b);
  });

  void it('ignores CSRF/nonce token values', () => {
    const a = computeContentHash('<input name="csrfmiddlewaretoken" value="aaaaaaa">');
    const b = computeContentHash('<input name="csrfmiddlewaretoken" value="zzzzzzz">');
    assert.strictEqual(a, b);
  });

  void it('ignores ISO timestamps', () => {
    const a = computeContentHash('<time datetime="2026-01-01T00:00:00Z">Old</time>');
    const b = computeContentHash('<time datetime="2026-05-26T12:34:56Z">Old</time>');
    assert.strictEqual(a, b);
  });

  void it('ignores HTML comments', () => {
    const a = computeContentHash('<body><!-- build 123 --><h1>X</h1></body>');
    const b = computeContentHash('<body><!-- build 999 --><h1>X</h1></body>');
    assert.strictEqual(a, b);
  });

  void it('reports a real change when meaningful content differs', () => {
    const a = computeContentHash('<body><h1>About</h1></body>');
    const b = computeContentHash('<body><h1>Contact</h1></body>');
    assert.notStrictEqual(a, b);
  });
});

// ============================================================
// HistoryManager.compareAudits — diff classifier
// ============================================================
void describe('compareAudits classifier', () => {
  type SS = Parameters<HistoryManager['compareAudits']>[0];
  const mkSnapshot = (
    overrides: Partial<SS> & {
      issues?: Record<string, { severity: string; count: number }>;
      pageHashes?: Record<string, string>;
    },
  ): SS =>
    ({
      timestamp: '2026-01-01T00:00:00Z',
      date: '2026-01-01',
      runTimestamp: null,
      summary: {
        overallScore: 80,
        totalIssues: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        passRate: 100,
        categoryScores: {},
        totalPages: 0,
        pagesWithErrors: 0,
        sitemapUrls: 0,
      },
      issues: overrides.issues ?? {},
      performance: null,
      technologies: [],
      insights: null,
      quickWins: [],
      pageHashes: overrides.pageHashes,
      ...overrides,
    }) as unknown as SS;

  void it('buckets a count-flip on a volatile finding into noise', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({ issues: { 'Some pages have LCP more than 2500ms': { severity: 'high', count: 7 } } }),
      mkSnapshot({ issues: { 'Some pages have LCP more than 2500ms': { severity: 'high', count: 8 } } }),
    );
    assert.strictEqual(cmp.classified?.noise.length, 1);
    assert.strictEqual(cmp.classified?.real.length, 0);
  });

  void it('buckets a structural count change into real', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({ issues: { 'Description meta tag is missing': { severity: 'critical', count: 3 } } }),
      mkSnapshot({ issues: { 'Description meta tag is missing': { severity: 'critical', count: 5 } } }),
    );
    assert.strictEqual(cmp.classified?.real.length, 1);
    assert.strictEqual(cmp.classified?.noise.length, 0);
    assert.strictEqual(cmp.classified?.real[0].kind, 'count');
  });

  void it('"new" appearance of a volatile finding still counts as real', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({ issues: {} }),
      mkSnapshot({ issues: { 'Slow page rendering (LCP)': { severity: 'high', count: 4 } } }),
    );
    assert.strictEqual(cmp.classified?.real.length, 1);
    assert.strictEqual(cmp.classified?.real[0].kind, 'new');
  });

  void it('merges numeric-variant messages into one slug-keyed entry', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({
        issues: {
          'Color contrast fails WCAG AA (24 elements)': { severity: 'high', count: 5 },
          'Color contrast fails WCAG AA (25 elements)': { severity: 'high', count: 5 },
        },
      }),
      mkSnapshot({
        issues: {
          'Color contrast fails WCAG AA (12 elements)': { severity: 'high', count: 8 },
        },
      }),
    );
    // Both sides collapse to the same slug → one diff entry, oldCount=10, newCount=8
    const entries = [...(cmp.classified?.real ?? []), ...(cmp.classified?.noise ?? [])];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].oldCount, 10);
    assert.strictEqual(entries[0].newCount, 8);
  });

  void it('detects how many pages changed via content hash', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({ pageHashes: { '/': 'aaa', '/about': 'bbb', '/blog': 'ccc' } }),
      mkSnapshot({ pageHashes: { '/': 'aaa', '/about': 'CHANGED', '/blog': 'ccc' } }),
    );
    assert.strictEqual(cmp.classified?.siteChanged.pagesCompared, 3);
    assert.strictEqual(cmp.classified?.siteChanged.pagesChanged, 1);
    assert.strictEqual(cmp.classified?.siteChanged.pagesUnchanged, 2);
  });

  void it('counts unique pages (present on only one side)', () => {
    const m = new HistoryManager('test');
    const cmp = m.compareAudits(
      mkSnapshot({ pageHashes: { '/': 'a', '/old': 'x' } }),
      mkSnapshot({ pageHashes: { '/': 'a', '/new': 'y' } }),
    );
    assert.strictEqual(cmp.classified?.siteChanged.pagesUnique, 2);
  });
});

// LLM anomaly pass — defensive JSON parsing
import { parseAnomalies } from '../lib/phase2/llm-anomaly';

void describe('parseAnomalies', () => {
  const URL = 'https://example.com/p';

  void it('parses a valid JSON array and stamps the url', () => {
    const out = parseAnomalies(
      '[{"title":"Dead CTA","severity":"high","section":"ux","evidence":"Button goes to #","recommendation":"Wire it up"}]',
      URL,
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, 'Dead CTA');
    assert.strictEqual(out[0].section, 'ux');
    assert.strictEqual(out[0].url, URL);
  });

  void it('normalizes unknown section/severity to technical/medium', () => {
    const out = parseAnomalies(
      '[{"title":"X","severity":"catastrophic","section":"made-up","evidence":"e"}]',
      URL,
    );
    assert.strictEqual(out[0].severity, 'medium');
    assert.strictEqual(out[0].section, 'technical');
  });

  void it('drops entries missing a title or evidence', () => {
    const out = parseAnomalies('[{"title":"","evidence":"e"},{"title":"T","evidence":""}]', URL);
    assert.strictEqual(out.length, 0);
  });

  void it('extracts the array even when wrapped in prose/fences', () => {
    const out = parseAnomalies('Here you go:\n```json\n[{"title":"T","evidence":"e","severity":"low","section":"seo"}]\n```', URL);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].section, 'seo');
  });

  void it('returns [] for an empty array, junk, or no array', () => {
    assert.strictEqual(parseAnomalies('[]', URL).length, 0);
    assert.strictEqual(parseAnomalies('not json at all', URL).length, 0);
    assert.strictEqual(parseAnomalies('[broken', URL).length, 0);
  });
});

// LLM verification pass — defensive JSON parsing
import { parseVerifyResult } from '../lib/phase2/llm-verify';

void describe('parseVerifyResult', () => {
  const VALID = [0, 1, 2, 3];

  void it('parses drop decisions and keeps only valid indices', () => {
    const out = parseVerifyResult(
      '{"drop":[{"index":1,"kind":"duplicate","reason":"same as #0"},{"index":9,"kind":"false-positive","reason":"oob"}]}',
      VALID,
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 1);
    assert.strictEqual(out[0].kind, 'duplicate');
  });

  void it('normalizes an unknown kind to duplicate and supplies a default reason', () => {
    const out = parseVerifyResult('{"drop":[{"index":2,"kind":"weird"}]}', VALID);
    assert.strictEqual(out[0].kind, 'duplicate');
    assert.ok(out[0].reason.length > 0);
  });

  void it('de-duplicates repeated indices', () => {
    const out = parseVerifyResult('{"drop":[{"index":3,"kind":"duplicate"},{"index":3,"kind":"false-positive"}]}', VALID);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 3);
  });

  void it('extracts the object even when wrapped in prose/fences', () => {
    const out = parseVerifyResult('Sure:\n```json\n{"drop":[{"index":0,"kind":"false-positive","reason":"r"}]}\n```', VALID);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 0);
  });

  void it('returns [] for an empty drop list, junk, or no object', () => {
    assert.strictEqual(parseVerifyResult('{"drop":[]}', VALID).length, 0);
    assert.strictEqual(parseVerifyResult('not json', VALID).length, 0);
    assert.strictEqual(parseVerifyResult('{broken', VALID).length, 0);
    assert.strictEqual(parseVerifyResult('', VALID).length, 0);
  });
});

// ============================================================
// Broken Pagination Analyzer
// ============================================================
void describe('BrokenPaginationAnalyzer', () => {
  const page = (over: Partial<PageInfo> = {}): PageInfo =>
    ({ status: 200, contentQuality: { wordCount: 800 }, ...over }) as unknown as PageInfo;

  void it('flags a series whose tail is empty + near-duplicate listings', () => {
    const pages = {
      'https://ex.com/blog/page/1': page({ contentQuality: { wordCount: 900 } as PageInfo['contentQuality'], contentHash: 'a' }),
      'https://ex.com/blog/page/2': page({ contentQuality: { wordCount: 850 } as PageInfo['contentQuality'], contentHash: 'b' }),
      // empty trailing pages: thin + near-identical to each other
      'https://ex.com/blog/page/3': page({ contentQuality: { wordCount: 10 } as PageInfo['contentQuality'], contentHash: 'empty' }),
      'https://ex.com/blog/page/4': page({ contentQuality: { wordCount: 10 } as PageInfo['contentQuality'], contentHash: 'empty' }),
      'https://ex.com/blog/page/5': page({ contentQuality: { wordCount: 12 } as PageInfo['contentQuality'], contentHash: 'empty' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.ok(result.issues.some((i) => /crawl budget/i.test(i.message ?? '')));
  });

  void it('flags a series with trailing soft 404s', () => {
    const pages = {
      'https://ex.com/n?page=1': page({ contentQuality: { wordCount: 600 } as PageInfo['contentQuality'], contentHash: 'x' }),
      'https://ex.com/n?page=2': page({ soft404: { isSoft404: true } as PageInfo['soft404'], contentHash: 'y' }),
      'https://ex.com/n?page=3': page({ soft404: { isSoft404: true } as PageInfo['soft404'], contentHash: 'z' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(result.issues.length >= 1, true);
  });

  void it('does NOT flag a healthy paginated series with real content', () => {
    const pages = {
      'https://ex.com/blog/page/1': page({ contentQuality: { wordCount: 900 } as PageInfo['contentQuality'], contentHash: 'a' }),
      'https://ex.com/blog/page/2': page({ contentQuality: { wordCount: 850 } as PageInfo['contentQuality'], contentHash: 'b' }),
      'https://ex.com/blog/page/3': page({ contentQuality: { wordCount: 780 } as PageInfo['contentQuality'], contentHash: 'c' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(result.issues.length, 0);
  });

  void it('flags a truncated series whose single highest crawled page is empty', () => {
    // Realistic: page 19 has real content, page 20 (the cap) is empty. No dup
    // neighbour exists, so this relies on the truncated-series relaxation.
    const pages = {
      'https://ex.com/c/page/19': page({ contentQuality: { wordCount: 700 } as PageInfo['contentQuality'], contentHash: 'p19' }),
      'https://ex.com/c/page/20': page({ contentQuality: { wordCount: 8 } as PageInfo['contentQuality'], contentHash: 'p20' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>, {
      truncatedSeries: { 'https://ex.com/c/page/{N}': 20 },
    });
    assert.ok(result.issues.some((i) => /crawl budget/i.test(i.message ?? '')));
  });

  void it('does NOT flag a truncated series whose highest page still has real content', () => {
    // A genuinely large catalog: the cap fired but the last page is substantive.
    const pages = {
      'https://ex.com/shop/page/19': page({ contentQuality: { wordCount: 700 } as PageInfo['contentQuality'], contentHash: 'p19' }),
      'https://ex.com/shop/page/20': page({ contentQuality: { wordCount: 650 } as PageInfo['contentQuality'], contentHash: 'p20' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>, {
      truncatedSeries: { 'https://ex.com/shop/page/{N}': 20 },
    });
    assert.strictEqual(result.issues.length, 0);
  });

  void it('ignores non-paginated pages entirely', () => {
    const pages = {
      'https://ex.com/about': page({ contentQuality: { wordCount: 5 } as PageInfo['contentQuality'] }),
      'https://ex.com/contact': page({ contentQuality: { wordCount: 5 } as PageInfo['contentQuality'] }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(result.issues.length, 0);
  });
});
