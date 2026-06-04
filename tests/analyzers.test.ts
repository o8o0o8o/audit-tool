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
import { PaginationAnalyzer } from '../lib/analyzers/seo/pagination-analyzer';
import { ScoreCalculator } from '../lib/scoring/score-calculator';
import { scoredCategoryOf, buildScoreImpact, sectionScoreSuffix } from '../lib/phase2/score-impact';
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
  const build = (pageUrls: string[], incomingLinks: Record<string, string[]>) =>
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

  void it('routes content-quality / E-E-A-T / crawl-budget findings to seo, not the technical catch-all', () => {
    assert.strictEqual(categorize('Page has very thin content'), 'seo');
    assert.strictEqual(categorize('37.5% of pages have very thin content'), 'seo');
    assert.strictEqual(categorize('13 YMYL pages without author attribution'), 'seo');
    assert.strictEqual(categorize('No author information found'), 'seo');
    assert.strictEqual(categorize('Low E-E-A-T signals across site'), 'seo');
    assert.strictEqual(categorize('Significant crawl budget waste detected'), 'seo');
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

  void it('folds the site-wide infinite-scroll restatement into the per-page finding', () => {
    const out = consolidateFindings({
      'Infinite scroll without pagination fallback': det({ severity: 'high', count: 6 }),
      '6 pages use infinite scroll without pagination fallback': det({ severity: 'high', count: 1 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.includes('Infinite scroll without pagination fallback'));
    assert.ok(!keys.some((k) => /pages use infinite scroll/.test(k)), 'aggregate restatement should fold away');
  });

  void it('folds the site-wide missing-labels restatement into the per-page finding', () => {
    const out = consolidateFindings({
      'Form inputs missing labels': det({ severity: 'high', count: 52 }),
      '52 form inputs across site missing labels': det({ severity: 'high', count: 1 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.includes('Form inputs missing labels'));
    assert.ok(!keys.some((k) => /across site missing labels/.test(k)), 'aggregate restatement should fold away');
  });

  void it('folds the site-wide thin-content restatement into the per-page finding', () => {
    const out = consolidateFindings({
      'Page has very thin content': det({ severity: 'high', count: 6 }),
      '37.5% of pages have very thin content': det({ severity: 'medium', count: 1 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.includes('Page has very thin content'));
    assert.ok(!keys.some((k) => /% of pages have very thin content/.test(k)), 'aggregate restatement should fold away');
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
// Determinism — same audit data must produce the same report for
// everyone, regardless of the concurrent crawl-completion order that
// `analysis.details` keys and `examples` arrays were collected in.
// ============================================================
import { buildReportMarkdown } from '../lib/phase2/phase2-runner';
import type { AuditArtifacts, IssueDetail as P2IssueDetail } from '../lib/phase2/types';
import { ErrorAggregator } from '../lib/utils/error-aggregator';
import { exampleMetric, compareExamplesWorstFirst } from '../lib/utils';

function mkArtifacts(detailKeys: string[], examples: Record<string, string[]> = {}): AuditArtifacts {
  const details: Record<string, P2IssueDetail> = {};
  for (const k of detailKeys) {
    details[k] = { severity: 'high', count: 5, examples: [...(examples[k] ?? [])] };
  }
  return {
    runDir: '/tmp/determinism-test',
    manifest: {
      version: 1,
      format: 'multi',
      domain: 'example.com',
      created: '2026-01-01T00:00:00.000Z',
      progress: { processedPages: [], totalWithoutError: 0, totalWithError: 0, byError: {}, attempts: {} },
      files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
      evidence: null,
    },
    analysis: {
      overall: detailKeys,
      details,
      bySeverity: {},
      summary: {
        totalIssues: detailKeys.length,
        criticalCount: 0,
        highCount: detailKeys.length,
        mediumCount: 0,
        lowCount: 0,
        categoryScores: { seo: 50, performance: 50, accessibility: 50, security: 50 },
        overallScore: 50,
        passRate: 0,
        quickWins: [],
      },
    },
    metadata: {},
    repoAnalysis: null,
  };
}

void describe('buildReportMarkdown determinism', () => {
  void it('produces identical output regardless of details key-insertion order', () => {
    // Three findings that tie on category/severity/impact — only the stable
    // message tiebreaker can order them. If insertion order leaked through,
    // forward vs reversed would differ.
    const keys = ['Alpha unknown finding', 'Bravo unknown finding', 'Charlie unknown finding'];
    const fwd = buildReportMarkdown(mkArtifacts(keys));
    const rev = buildReportMarkdown(mkArtifacts([...keys].reverse()));
    assert.strictEqual(fwd, rev);
  });

  void it('omits templated pagination series keys ({N}) from affected pages', () => {
    // The broken-pagination finding embeds its series key as a URL-shaped
    // template (e.g. https://e.com/insights/page/{N}) alongside the real
    // affected pages. The {N} template is not a crawled page and must not lead
    // the "Affected pages" list.
    const example =
      'The <code>https://e.com/insights/page/{N}</code> pagination series advances into empty pages. ' +
      'Affected: https://e.com/insights/page/6, https://e.com/insights/page/7';
    const md = buildReportMarkdown(
      mkArtifacts(['Broken pagination wastes crawl budget — https://e.com/insights/page/{N}'], {
        'Broken pagination wastes crawl budget — https://e.com/insights/page/{N}': [example],
      }),
    );
    // The template may still appear in the finding header (it identifies the
    // series), but never as a clickable affected-page link.
    assert.ok(!md.includes('(https://e.com/insights/page/{N})'), 'templated {N} URL must not be linked as an affected page');
    assert.ok(md.includes('insights/page/6'), 'real affected pages must still be listed');
  });

  void it('--no-score strips score projections, point chips, and the scoring legend', () => {
    const keys = ['Missing meta description', 'Duplicate page titles found'];
    const examples = {
      'Missing meta description': ['https://e.com/a'],
      'Duplicate page titles found': ['https://e.com/b'],
    };

    // Default report carries the scoring legend and at least one score token
    // (either a `→` projection arrow or a `pts` chip).
    const scored = buildReportMarkdown(mkArtifacts(keys, examples));
    assert.ok(scored.includes('score we would expect'), 'default report should include the scoring legend');
    assert.ok(/→|pts/.test(scored), 'default report should include score projections or point chips');

    // --no-score (7th positional arg) must remove all three.
    const noScore = buildReportMarkdown(mkArtifacts(keys, examples), {}, [], new Set(), undefined, undefined, true);
    assert.ok(!noScore.includes('score we would expect'), 'no-score report must drop the scoring legend');
    assert.ok(!noScore.includes('→'), 'no-score report must not contain score projections');
    assert.ok(!/\+~\d+\s*pts/.test(noScore), 'no-score report must not contain per-finding point chips');
    // Findings themselves are untouched.
    assert.ok(noScore.includes('Missing meta description'), 'findings must still be present without scores');
  });

  void it('produces identical affected-pages samples regardless of example order', () => {
    const fwd = buildReportMarkdown(
      mkArtifacts(['Alpha unknown finding'], {
        'Alpha unknown finding': ['https://e.com/z', 'https://e.com/a', 'https://e.com/m'],
      }),
    );
    const rev = buildReportMarkdown(
      mkArtifacts(['Alpha unknown finding'], {
        'Alpha unknown finding': ['https://e.com/a', 'https://e.com/m', 'https://e.com/z'],
      }),
    );
    assert.strictEqual(fwd, rev);
  });
});

void describe('ErrorAggregator example retention determinism', () => {
  void it('retains the same (smallest) examples regardless of arrival order', () => {
    const urls = Array.from({ length: 150 }, (_, i) => `https://e.com/page-${String(i).padStart(3, '0')}`);
    const forward = new ErrorAggregator();
    for (const u of urls) forward.addError('Some issue', u, 'high');
    const reversed = new ErrorAggregator();
    for (const u of [...urls].reverse()) reversed.addError('Some issue', u, 'high');

    const ex = (agg: ErrorAggregator) => [...agg.getData().details['Some issue'].examples].sort();
    const a = ex(forward);
    const b = ex(reversed);
    assert.deepStrictEqual(a, b, 'retained example set must not depend on arrival order');
    // Total count is tracked accurately even though examples are capped.
    assert.strictEqual(forward.getData().details['Some issue'].count, 150);
  });

  void it('retains the worst examples (highest metric) when over the cap', () => {
    // 150 pages with an embedded request count from 1..150. Only 100 are kept;
    // the worst-first retention policy must keep the highest counts (51..150),
    // not an alphabetical slice — regardless of arrival order.
    const mk = (n: number) => `This page has ${n} requests https://e.com/page-${String(n).padStart(3, '0')}`;
    const ns = Array.from({ length: 150 }, (_, i) => i + 1);
    const agg = new ErrorAggregator();
    for (const n of [...ns].reverse()) agg.addError('Too many requests', mk(n), 'medium');
    const kept = agg.getData().details['Too many requests'].examples;
    const counts = kept.map((e) => parseInt(e.match(/has (\d+) requests/)![1], 10)).sort((x, y) => x - y);
    assert.strictEqual(counts.length, 100);
    assert.strictEqual(counts[0], 51, 'lowest retained count should be 51 (worst 100 kept)');
    assert.strictEqual(counts[99], 150, 'worst page (150 requests) must be retained');
  });
});

void describe('worst-first example ordering', () => {
  void it('exampleMetric reads the embedded value and normalises byte units', () => {
    assert.strictEqual(exampleMetric('This page has 48 requests https://e.com/x'), 48);
    assert.strictEqual(exampleMetric('https://e.com/x has Total Blocking Time 3273ms (threshold: 200ms)'), 3273);
    assert.strictEqual(exampleMetric('https://e.com/x: 96% of CSS is unused (5.5 MB of 5.7 MB)'), 96);
    // Byte units normalise so MB outranks KB even though 1.7 < 512 numerically.
    assert.ok(exampleMetric('https://e.com/x: 1.7 MB of unused code') > exampleMetric('https://e.com/y: 512 KB of unused code'));
    // Digits inside the URL path must not be mistaken for the metric.
    assert.strictEqual(exampleMetric('https://e.com/5-year-anniversary/'), -Infinity);
  });

  void it('orders worst-first with a deterministic lexicographic tiebreak', () => {
    const examples = [
      'This page has 43 requests https://e.com/a',
      'This page has 48 requests https://e.com/d',
      'This page has 47 requests https://e.com/b',
      'This page has 48 requests https://e.com/c',
    ];
    const sorted = [...examples].sort(compareExamplesWorstFirst);
    assert.deepStrictEqual(
      sorted.map((e) => parseInt(e.match(/has (\d+)/)![1], 10)),
      [48, 48, 47, 43],
    );
    // The two 48s tie on metric, so order is lexicographic (…/c before …/d).
    assert.ok(sorted[0].endsWith('/c'));
    assert.ok(sorted[1].endsWith('/d'));
    // Reversed input yields the identical order — determinism preserved.
    assert.deepStrictEqual([...examples].reverse().sort(compareExamplesWorstFirst), sorted);
  });

  void it('renders the affected-pages sample worst-first in the report', () => {
    const md = buildReportMarkdown(
      mkArtifacts(['Some pages have too many requests'], {
        'Some pages have too many requests': [
          'This page has 43 requests https://e.com/a',
          'This page has 90 requests https://e.com/z',
          'This page has 47 requests https://e.com/m',
        ],
      }),
    );
    const i90 = md.indexOf('90 requests');
    const i47 = md.indexOf('47 requests');
    const i43 = md.indexOf('43 requests');
    assert.ok(i90 >= 0 && i47 >= 0 && i43 >= 0, 'all examples should render');
    assert.ok(i90 < i47 && i47 < i43, 'worst (90 requests) must appear first');
  });
});

// ============================================================
// Phase 2 benchmarks (threshold + why for comparative findings)
// ============================================================
import { benchmarkFor } from '../lib/phase2/benchmarks';

// ============================================================
// URL architecture — long-URL finding names the offending URLs
// ============================================================
import { UrlArchitectureAnalyzer } from '../lib/analyzers/seo/url-architecture-analyzer';

void describe('UrlArchitectureAnalyzer long URLs', () => {
  void it('lists the actual long URLs in the finding detail, not just a count', () => {
    const longUrl = 'https://ex.com/' + 'segment-'.repeat(15) + 'end'; // >100 chars
    assert.ok(longUrl.length > 100);
    const pages = {
      'https://ex.com/': {} as PageInfo,
      'https://ex.com/about': {} as PageInfo,
      [longUrl]: {} as PageInfo,
    };
    const { warnings } = UrlArchitectureAnalyzer.analyzeSiteWide(pages, 'https://ex.com');
    const finding = warnings.find((w) => w.message === 'Some URLs are too long');
    assert.ok(finding, 'expected a long-URL finding');
    assert.ok(finding!.detail?.includes(longUrl), 'detail should name the offending URL');
    assert.ok(/1 URLs/.test(finding!.detail ?? ''), 'detail should still report the count');
  });

  void it('does not flag when all URLs are within length', () => {
    const pages = { 'https://ex.com/': {} as PageInfo, 'https://ex.com/about': {} as PageInfo };
    const { warnings } = UrlArchitectureAnalyzer.analyzeSiteWide(pages, 'https://ex.com');
    assert.ok(!warnings.some((w) => w.message === 'Some URLs are too long'));
  });
});

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
import { normalizeMessage, mergeNumericVariants, sanitizeProse, inlineExample } from '../lib/phase2/phase2-runner';
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
    assert.strictEqual(
      sanitizeProse('Replace generic divs with semantic elements.'),
      'Replace generic divs with semantic elements.',
    );
  });
});

void describe('normalizeMessage', () => {
  void it('strips trailing (N elements) tokens', () => {
    assert.strictEqual(normalizeMessage('Color contrast fails WCAG AA (24 elements)'), 'Color contrast fails WCAG AA');
  });

  void it('strips trailing bare (N) tokens', () => {
    assert.strictEqual(normalizeMessage('Some pages have too many h2 tags (16)'), 'Some pages have too many h2 tags');
  });

  void it('strips trailing (N units) with hyphenated units', () => {
    assert.strictEqual(normalizeMessage('Excessive DOM size (1357 dom-nodes)'), 'Excessive DOM size');
  });

  void it('does not strip parenthesised numbers in the middle of the message', () => {
    assert.strictEqual(normalizeMessage('LCP (2.7s) on the homepage'), 'LCP (2.7s) on the homepage');
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
    assert.strictEqual(normalizeMessageForLookup('38% pages have very thin content'), 'pages have very thin content');
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

  void it('flags dynamic import with ssr: false even when callback has its own parens', () => {
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
    const root = fakeRepo('app/utils.ts', `import _ from 'lodash';\nexport const d = _.debounce(() => {}, 100);\n`);
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
    fs.writeFileSync(path.join(nm, 'leaked.ts'), `export const dynamic = 'force-dynamic';\n`);
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
    const out = parseAnomalies('[{"title":"X","severity":"catastrophic","section":"made-up","evidence":"e"}]', URL);
    assert.strictEqual(out[0].severity, 'medium');
    assert.strictEqual(out[0].section, 'technical');
  });

  void it('drops entries missing a title or evidence', () => {
    const out = parseAnomalies('[{"title":"","evidence":"e"},{"title":"T","evidence":""}]', URL);
    assert.strictEqual(out.length, 0);
  });

  void it('extracts the array even when wrapped in prose/fences', () => {
    const out = parseAnomalies(
      'Here you go:\n```json\n[{"title":"T","evidence":"e","severity":"low","section":"seo"}]\n```',
      URL,
    );
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
    const out = parseVerifyResult(
      '{"drop":[{"index":3,"kind":"duplicate"},{"index":3,"kind":"false-positive"}]}',
      VALID,
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].index, 3);
  });

  void it('extracts the object even when wrapped in prose/fences', () => {
    const out = parseVerifyResult(
      'Sure:\n```json\n{"drop":[{"index":0,"kind":"false-positive","reason":"r"}]}\n```',
      VALID,
    );
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
      'https://ex.com/blog/page/1': page({
        contentQuality: { wordCount: 900 } as PageInfo['contentQuality'],
        contentHash: 'a',
      }),
      'https://ex.com/blog/page/2': page({
        contentQuality: { wordCount: 850 } as PageInfo['contentQuality'],
        contentHash: 'b',
      }),
      // empty trailing pages: thin + near-identical to each other
      'https://ex.com/blog/page/3': page({
        contentQuality: { wordCount: 10 } as PageInfo['contentQuality'],
        contentHash: 'empty',
      }),
      'https://ex.com/blog/page/4': page({
        contentQuality: { wordCount: 10 } as PageInfo['contentQuality'],
        contentHash: 'empty',
      }),
      'https://ex.com/blog/page/5': page({
        contentQuality: { wordCount: 12 } as PageInfo['contentQuality'],
        contentHash: 'empty',
      }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.ok(result.issues.some((i) => /crawl budget/i.test(i.message ?? '')));
  });

  void it('flags a series with trailing soft 404s', () => {
    const pages = {
      'https://ex.com/n?page=1': page({
        contentQuality: { wordCount: 600 } as PageInfo['contentQuality'],
        contentHash: 'x',
      }),
      'https://ex.com/n?page=2': page({ soft404: { isSoft404: true } as PageInfo['soft404'], contentHash: 'y' }),
      'https://ex.com/n?page=3': page({ soft404: { isSoft404: true } as PageInfo['soft404'], contentHash: 'z' }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(result.issues.length >= 1, true);
  });

  void it('does NOT flag a healthy paginated series with real content', () => {
    const pages = {
      'https://ex.com/blog/page/1': page({
        contentQuality: { wordCount: 900 } as PageInfo['contentQuality'],
        contentHash: 'a',
      }),
      'https://ex.com/blog/page/2': page({
        contentQuality: { wordCount: 850 } as PageInfo['contentQuality'],
        contentHash: 'b',
      }),
      'https://ex.com/blog/page/3': page({
        contentQuality: { wordCount: 780 } as PageInfo['contentQuality'],
        contentHash: 'c',
      }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    assert.strictEqual(result.issues.length, 0);
  });

  void it('flags a truncated series whose single highest crawled page is empty', () => {
    // Realistic: page 19 has real content, page 20 (the cap) is empty. No dup
    // neighbour exists, so this relies on the truncated-series relaxation.
    const pages = {
      'https://ex.com/c/page/19': page({
        contentQuality: { wordCount: 700 } as PageInfo['contentQuality'],
        contentHash: 'p19',
      }),
      'https://ex.com/c/page/20': page({
        contentQuality: { wordCount: 8 } as PageInfo['contentQuality'],
        contentHash: 'p20',
      }),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>, {
      truncatedSeries: { 'https://ex.com/c/page/{N}': 20 },
    });
    assert.ok(result.issues.some((i) => /crawl budget/i.test(i.message ?? '')));
  });

  void it('does NOT flag a truncated series whose highest page still has real content', () => {
    // A genuinely large catalog: the cap fired but the last page is substantive.
    const pages = {
      'https://ex.com/shop/page/19': page({
        contentQuality: { wordCount: 700 } as PageInfo['contentQuality'],
        contentHash: 'p19',
      }),
      'https://ex.com/shop/page/20': page({
        contentQuality: { wordCount: 650 } as PageInfo['contentQuality'],
        contentHash: 'p20',
      }),
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

// ============================================================
// Pagination Analyzer — infinite-scroll discoverability
// ============================================================
void describe('PaginationAnalyzer.decideInfiniteScrollProblem', () => {
  const decide = (over: Partial<Parameters<typeof PaginationAnalyzer.decideInfiniteScrollProblem>[0]> = {}) =>
    PaginationAnalyzer.decideInfiniteScrollProblem({
      mechanismPresent: true,
      renderedItemCount: 20,
      servedItemCount: 0,
      hasPaginationLinks: false,
      hasRelPrevNext: false,
      ...over,
    });

  void it('does NOT flag a server-rendered list merely revealed on scroll (items present in served HTML)', () => {
    // The user's case: server returns all items in HTML, client just hides them.
    assert.strictEqual(decide({ renderedItemCount: 20, servedItemCount: 20 }), false);
  });

  void it('does NOT flag a decorative sentinel on a page with no real list', () => {
    // lunacy.audio regression: homepage / product pages — mechanism present, no list.
    assert.strictEqual(decide({ renderedItemCount: 0, servedItemCount: 0 }), false);
    assert.strictEqual(decide({ renderedItemCount: 3, servedItemCount: 0 }), false);
  });

  void it('does NOT flag JS-loaded content when a static fallback exists', () => {
    assert.strictEqual(decide({ servedItemCount: 0, hasPaginationLinks: true }), false);
    assert.strictEqual(decide({ servedItemCount: 0, hasRelPrevNext: true }), false);
  });

  void it('does NOT flag when there is no infinite-scroll mechanism', () => {
    assert.strictEqual(decide({ mechanismPresent: false, servedItemCount: 0 }), false);
  });

  void it('flags a real JS-injected list with no crawlable fallback', () => {
    assert.strictEqual(decide({ renderedItemCount: 20, servedItemCount: 0 }), true);
    // Partial server-rendering below the fraction threshold still counts as a problem.
    assert.strictEqual(decide({ renderedItemCount: 20, servedItemCount: 3 }), true);
  });
});

void describe('PaginationAnalyzer.analyzeSiteWide — infinite scroll', () => {
  const pageWith = (paginationData: Partial<NonNullable<PageInfo['paginationData']>>): PageInfo =>
    ({ paginationData: { hasPagination: true, ...paginationData } }) as unknown as PageInfo;

  void it('does not emit a finding when infinite-scroll content is crawlable', () => {
    const pages = {
      'https://ex.com/a': pageWith({ infiniteScrollDetected: true, infiniteScrollContentCrawlable: true }),
    };
    const result = PaginationAnalyzer.analyzeSiteWide(pages as Record<string, PageInfo>);
    assert.strictEqual(
      result.issues.some((i) => /infinite scroll without pagination fallback/i.test(i.message ?? '')),
      false,
    );
  });

  void it('emits a per-page finding only for pages where content is not crawlable', () => {
    const pages = {
      'https://ex.com/feed': pageWith({ infiniteScrollDetected: true, infiniteScrollContentCrawlable: false }),
      'https://ex.com/list': pageWith({ infiniteScrollDetected: true, infiniteScrollContentCrawlable: false }),
      // crawlable one should not be counted
      'https://ex.com/home': pageWith({ infiniteScrollDetected: true, infiniteScrollContentCrawlable: true }),
    };
    const result = PaginationAnalyzer.analyzeSiteWide(pages as Record<string, PageInfo>);
    // One issue per affected page (count-free, stable message), so the report's
    // occurrence count matches the affected-page list instead of contradicting it.
    const findings = result.issues.filter((i) =>
      /infinite scroll without pagination fallback/i.test(i.message ?? ''),
    );
    assert.strictEqual(findings.length, 2, 'expected one finding per non-crawlable page');
    // The crawlable page must not appear; both non-crawlable ones must.
    const details = findings.map((f) => f.detail ?? '').join('\n');
    assert.match(details, /\/feed/);
    assert.match(details, /\/list/);
    assert.doesNotMatch(details, /\/home/);
  });
});

void describe('score-impact', () => {
  void it('routes security headers and cookies to the Security score (not the legacy catalog category)', () => {
    assert.strictEqual(scoredCategoryOf('Missing Permissions-Policy header'), 'security');
    assert.strictEqual(scoredCategoryOf('Missing cross-origin isolation headers'), 'security');
    assert.strictEqual(scoredCategoryOf('External scripts missing Subresource Integrity (SRI)'), 'security');
    assert.strictEqual(scoredCategoryOf('Source maps exposed in production'), 'security');
    assert.strictEqual(scoredCategoryOf('Third-party cookies without consent'), 'security');
    assert.strictEqual(scoredCategoryOf('Multiple tracking cookies set before consent'), 'security');
  });

  void it('routes SEO, performance, accessibility and JS-error findings correctly', () => {
    assert.strictEqual(scoredCategoryOf('Canonicals are not set for some pages'), 'seo');
    assert.strictEqual(scoredCategoryOf('Duplicate page titles found'), 'seo');
    assert.strictEqual(scoredCategoryOf('Render-blocking third-party scripts'), 'performance');
    assert.strictEqual(scoredCategoryOf('Some pages have CLS more than 0.1'), 'performance');
    assert.strictEqual(scoredCategoryOf('Color contrast fails WCAG AA (5 elements)'), 'accessibility');
    assert.strictEqual(scoredCategoryOf('Form inputs missing labels'), 'accessibility');
    // JS errors must read as Technical, never Performance.
    assert.strictEqual(scoredCategoryOf('Critical JavaScript errors detected'), 'technical');
  });

  void it('projects a higher score and attributes per-finding points within the gap', () => {
    const impact = buildScoreImpact(
      { security: 50, seo: 80, performance: 100 },
      {
        'Missing Permissions-Policy header': { severity: 'high', count: 52 },
        'External scripts missing Subresource Integrity (SRI)': { severity: 'medium', count: 12 },
        'Duplicate page titles found': { severity: 'high', count: 5 },
      },
    );
    const sec = impact.categories.security;
    assert.ok(sec, 'security status present');
    assert.strictEqual(sec!.current, 50);
    // Projection improves but never reaches a perfect 100.
    assert.ok(sec!.projected > 50 && sec!.projected <= 99, `projected ${sec!.projected}`);
    assert.strictEqual(sec!.gain, sec!.projected - sec!.current);
    // The high-severity, broad header finding earns the larger share.
    const header = impact.findingLift.get('Missing Permissions-Policy header');
    const sri = impact.findingLift.get('External scripts missing Subresource Integrity (SRI)');
    assert.ok(header?.category === 'security' && header.points >= 1);
    assert.ok(sri && sri.points >= 1);
    assert.ok(header!.points >= sri!.points);
  });

  void it('emits no lift or projection for a category already at 100', () => {
    const impact = buildScoreImpact(
      { technical: 100 },
      { 'Element with too many children': { severity: 'medium', count: 3 } },
    );
    assert.strictEqual(impact.categories.technical?.gain, 0);
    assert.strictEqual(impact.findingLift.size, 0);
  });

  void it('builds a headroom-first section suffix and is empty when scores are unknown', () => {
    const impact = buildScoreImpact(
      { security: 44, technical: 100 },
      {
        'Missing Permissions-Policy header': { severity: 'high', count: 50 },
        'Element with too many children': { severity: 'medium', count: 3 },
      },
    );
    const suffix = sectionScoreSuffix(['technical', 'security'], impact);
    // Security (with headroom) must lead Technical (at ceiling).
    assert.ok(suffix.includes('Security 44/100 → ~'), suffix);
    assert.ok(suffix.indexOf('Security') < suffix.indexOf('Technical'), suffix);
    assert.strictEqual(sectionScoreSuffix(['seo'], buildScoreImpact(undefined, {})), '');
  });
});

import { stampPageUrl } from '../lib/crawler/analyzer-runner';

void describe('stampPageUrl', () => {
  const URL = 'https://example.com/pricing';

  void it('appends the page URL (as an anchor) to a URL-less analyzer detail', () => {
    const out = stampPageUrl('182.4 KB of inline CSS. Critical CSS should be ~14KB or less.', URL);
    assert.ok(out.includes(`<a href="${URL}">${URL}</a>`), out);
    // Original detail text is preserved ahead of the URL.
    assert.ok(out.startsWith('182.4 KB of inline CSS.'), out);
  });

  void it('makes two same-detail occurrences distinct by their page URL', () => {
    const detail = '182.4 KB of inline CSS. Critical CSS should be ~14KB or less.';
    const a = stampPageUrl(detail, 'https://example.com/a');
    const b = stampPageUrl(detail, 'https://example.com/b');
    assert.notStrictEqual(a, b);
  });

  void it('leaves a detail that already references this page untouched', () => {
    const detail = `Title is missing for this page <a href="${URL}">${URL}</a>`;
    assert.strictEqual(stampPageUrl(detail, URL), detail);
  });

  void it('uses the page URL as the example when the detail is empty', () => {
    assert.strictEqual(stampPageUrl('   ', URL), `<a href="${URL}">${URL}</a>`);
  });
});

void describe('inlineExample', () => {
  void it('preserves the analyzer anchor as a clickable markdown link', () => {
    // Thin-content style: full href, shortened relative label.
    const ex = '<a href="https://example.com/company/">/company/</a> has only 54 words (minimum: 100)';
    assert.strictEqual(inlineExample(ex), '[/company/](https://example.com/company/) has only 54 words (minimum: 100)');
  });

  void it('keeps only the lead clause, dropping trailing HTML the Fix section covers', () => {
    const ex =
      '<a href="https://example.com/x">https://example.com/x</a> has 8 render-blocking resources<br><ul><li>a.css</li></ul>Recommendation: defer';
    assert.strictEqual(
      inlineExample(ex),
      '[https://example.com/x](https://example.com/x) has 8 render-blocking resources',
    );
  });

  void it('angle-brackets a destination containing parentheses so markdown does not break', () => {
    const ex = '<a href="https://example.com/p?a=(1)">/p</a> flagged';
    assert.strictEqual(inlineExample(ex), '[/p](<https://example.com/p?a=(1)>) flagged');
  });

  void it('leaves a bare URL (no anchor) for marked to autolink', () => {
    assert.strictEqual(inlineExample('https://example.com/bare'), 'https://example.com/bare');
  });
});

// ============================================================
// Finding verifier (--verify) — re-checks a finding's first example
// ============================================================
import {
  PageIndex,
  verifyFinding,
  verifyDetails,
} from '../lib/phase3/finding-verifier';
import type { IssueDetail as VIssueDetail } from '../lib/phase2/types';

function idx(pages: Record<string, Partial<PageInfo>>): PageIndex {
  const index = new PageIndex();
  for (const [url, p] of Object.entries(pages)) index.add(url, { url, ...p } as PageInfo);
  return index;
}
const detail = (examples: string[], extra: Partial<VIssueDetail> = {}): VIssueDetail => ({
  severity: 'high',
  count: examples.length,
  examples,
  ...extra,
});

void describe('finding-verifier', () => {
  void it('confirms a true duplicate-title claim against captured titles', () => {
    const pages = idx({
      'https://e.com/a': { title: 'Shared Title' },
      'https://e.com/b': { title: 'Shared Title' },
    });
    const ex = 'The title "Shared Title" is used on 2 pages: <a href="https://e.com/a">a</a> <a href="https://e.com/b">b</a>';
    const r = verifyFinding('Some pages have duplicate title', detail([ex]), pages);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('refutes a duplicate-title claim when captured titles actually differ', () => {
    const pages = idx({
      'https://e.com/a': { title: 'Title One' },
      'https://e.com/b': { title: 'Title Two' },
    });
    const ex = 'The title "Title One" is used on 2 pages: <a href="https://e.com/a">a</a> <a href="https://e.com/b">b</a>';
    const r = verifyFinding('Duplicate page titles found', detail([ex]), pages);
    assert.strictEqual(r.status, 'refuted');
  });

  void it('confirms missing-canonical when the page has an empty canonical', () => {
    const pages = idx({ 'https://e.com/x': { canonical: '' } });
    const r = verifyFinding('Some pages missing canonical URL', detail(['https://e.com/x']), pages);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('leaves missing-canonical UNCHECKED when the canonical field was not captured', () => {
    // Absence of the field ≠ proof the page has no canonical — never drop on it.
    const pages = idx({ 'https://e.com/x': {} });
    const r = verifyFinding('Some pages missing canonical URL', detail(['https://e.com/x']), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  void it('refutes missing-canonical when the page has a canonical', () => {
    const pages = idx({ 'https://e.com/x': { canonical: 'https://e.com/x' } });
    const r = verifyFinding('Some pages missing canonical URL', detail(['https://e.com/x']), pages);
    assert.strictEqual(r.status, 'refuted');
  });

  void it('matches an example URL despite trailing-slash differences', () => {
    const pages = idx({ 'https://e.com/x/': { canonical: 'https://e.com/x/' } });
    const r = verifyFinding('Missing canonical URL', detail(['https://e.com/x']), pages);
    assert.strictEqual(r.status, 'refuted');
  });

  void it('reads H1 count from persisted heading data, not the stripped top-level h1', () => {
    // headings.h1Count is the field that actually survives storage.
    const many = idx({ 'https://e.com/x': { headings: { h1Count: 2 } as PageInfo['headings'] } });
    const one = idx({ 'https://e.com/x': { headings: { h1Count: 1 } as PageInfo['headings'] } });
    const none = idx({ 'https://e.com/x': {} }); // no heading data captured
    assert.strictEqual(verifyFinding('Multiple H1 tags', detail(['https://e.com/x']), many).status, 'confirmed');
    assert.strictEqual(verifyFinding('Multiple H1 tags', detail(['https://e.com/x']), one).status, 'refuted');
    assert.strictEqual(verifyFinding('Multiple H1 tags', detail(['https://e.com/x']), none).status, 'unchecked');
  });

  void it('does NOT treat "Videos without accessible title" as a page-title finding', () => {
    // Regression: a loose /title/+/without/ matcher refuted this real a11y
    // finding because the page had a (page-level) title. It must be unchecked.
    const pages = idx({ 'https://e.com/v': { title: 'A real page title' } });
    const r = verifyFinding('Videos without accessible title', detail(['https://e.com/v']), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  void it('does NOT treat "LCP more than 2500ms" as an HTTP 500 finding', () => {
    // Regression: the substring "500" inside "2500ms" matched an http-error
    // matcher and refuted a real performance finding. No verifier should match.
    const pages = idx({ 'https://e.com/slow': { status: 200 } });
    const r = verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/slow']), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  void it('does NOT refute a "wrong canonical" finding where a canonical is present', () => {
    // "Many pages canonicalized to other URLs" is about a WRONG canonical, not a
    // missing one — the page HAS a canonical, so missing-canonical must not fire.
    const pages = idx({ 'https://e.com/p': { canonical: 'https://e.com/other' } });
    const r = verifyFinding('Many pages canonicalized to other URLs', detail(['https://e.com/p']), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  void it('leaves a confirm-only kind (missing-alt) unchecked when the proxy is 0/absent', () => {
    const some = idx({ 'https://e.com/x': { imagesWithoutAltCount: 3 } });
    const zero = idx({ 'https://e.com/x': { imagesWithoutAltCount: 0 } });
    const absent = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Image links without alt text', detail(['https://e.com/x']), some).status, 'confirmed');
    // 0 / absent → unchecked, NEVER refuted (the count is a broader proxy).
    assert.strictEqual(verifyFinding('Image links without alt text', detail(['https://e.com/x']), zero).status, 'unchecked');
    assert.strictEqual(verifyFinding('Image links without alt text', detail(['https://e.com/x']), absent).status, 'unchecked');
  });

  void it('leaves AI-discovered findings unchecked', () => {
    const pages = idx({ 'https://e.com/x': {} });
    const r = verifyFinding('Dead CTA button', detail(['saw it — https://e.com/x'], { aiDiscovered: true }), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  void it('leaves findings with no matching verifier unchecked', () => {
    const pages = idx({ 'https://e.com/x': {} });
    const r = verifyFinding('Some unrelated finding', detail(['https://e.com/x']), pages);
    assert.strictEqual(r.status, 'unchecked');
  });

  // ── New confirm-only verifiers backed by rich analyzer sub-objects ────────
  void it('confirms empty-anchor from anchorTextData.emptyAnchors, never refutes', () => {
    const has = idx({ 'https://e.com/x': { anchorTextData: { emptyAnchors: ['/', '/'] } as PageInfo['anchorTextData'] } });
    const none = idx({ 'https://e.com/x': { anchorTextData: { emptyAnchors: [] } as PageInfo['anchorTextData'] } });
    const absent = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), has).status, 'confirmed');
    assert.strictEqual(verifyFinding('Links with empty anchor text', detail(['https://e.com/x']), has).status, 'confirmed');
    assert.strictEqual(verifyFinding('Some pages have links without any text', detail(['https://e.com/x']), has).status, 'confirmed');
    // confirm-only: 0 / absent → unchecked, NEVER refuted
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), none).status, 'unchecked');
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), absent).status, 'unchecked');
  });

  void it('does NOT treat "Multiple pages target the same keyword in their H1" as a multiple-h1 finding', () => {
    // Regression: keyword-cannibalisation is about distinct pages sharing a
    // keyword, not one page with several H1s. The single-page H1 count (0/1)
    // must not auto-drop it.
    const pages = idx({ 'https://e.com/x': { headings: { h1Count: 1 } as PageInfo['headings'] } });
    assert.strictEqual(verifyFinding('Multiple pages target the same keyword in their H1', detail(['https://e.com/x']), pages).status, 'unchecked');
  });

  void it('does NOT match other anchor findings as empty-anchor', () => {
    const pages = idx({ 'https://e.com/x': { anchorTextData: { emptyAnchors: [] } as PageInfo['anchorTextData'] } });
    assert.strictEqual(verifyFinding('Anchor text over-optimization detected', detail(['https://e.com/x']), pages).status, 'unchecked');
    assert.strictEqual(verifyFinding('Same anchor text links to different pages', detail(['https://e.com/x']), pages).status, 'unchecked');
  });

  void it('confirms oversized / legacy-format image findings from imageOptimization', () => {
    const over = idx({ 'https://e.com/x': { imageOptimization: { oversizedImages: [{}], legacyFormats: 0 } as PageInfo['imageOptimization'] } });
    const legacy = idx({ 'https://e.com/x': { imageOptimization: { oversizedImages: [], legacyFormats: 2 } as PageInfo['imageOptimization'] } });
    assert.strictEqual(verifyFinding('Some images are significantly larger than their display size', detail(['https://e.com/x']), over).status, 'confirmed');
    assert.strictEqual(verifyFinding('Pages serve images only as JPG/PNG instead of WebP/AVIF', detail(['https://e.com/x']), legacy).status, 'confirmed');
  });

  void it('confirms unused-code / unused-css against codeCoverage, leaves within-bounds unchecked', () => {
    const heavy = idx({ 'https://e.com/x': { codeCoverage: { js: { unused: 600_000 }, css: { unused: 50_000, ratio: 70 } } as PageInfo['codeCoverage'] } });
    const light = idx({ 'https://e.com/x': { codeCoverage: { js: { unused: 1_000 }, css: { unused: 1_000, ratio: 5 } } as PageInfo['codeCoverage'] } });
    assert.strictEqual(verifyFinding('Large amount of unused code', detail(['https://e.com/x']), heavy).status, 'confirmed');
    assert.strictEqual(verifyFinding('High percentage of unused CSS', detail(['https://e.com/x']), heavy).status, 'confirmed');
    // confirm-only → within bounds stays unchecked, not refuted
    assert.strictEqual(verifyFinding('Large amount of unused code', detail(['https://e.com/x']), light).status, 'unchecked');
    assert.strictEqual(verifyFinding('High percentage of unused CSS', detail(['https://e.com/x']), light).status, 'unchecked');
  });

  void it('confirms render-blocking / dom-children / third-party payload from persisted metrics', () => {
    const p = idx({
      'https://e.com/x': {
        resourceOptimization: { renderBlocking: { totalBlocking: 9 } } as PageInfo['resourceOptimization'],
        domComplexityData: { maxChildren: 90, totalNodes: 1200 } as PageInfo['domComplexityData'],
        thirdPartyData: { totalSize: 900_000 } as PageInfo['thirdPartyData'],
      },
    });
    assert.strictEqual(verifyFinding('Some pages have too many render-blocking resources', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Element with too many children', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Excessive DOM size', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Excessive third-party payload', detail(['https://e.com/x']), p).status, 'confirmed');
  });

  void it('does NOT match render-blocking THIRD-PARTY scripts as the generic render-blocking kind', () => {
    const p = idx({ 'https://e.com/x': { resourceOptimization: { renderBlocking: { totalBlocking: 0 } } as PageInfo['resourceOptimization'] } });
    // This finding is about third-party scripts specifically → left for the LLM/CLI pass.
    assert.strictEqual(verifyFinding('Render-blocking third-party scripts', detail(['https://e.com/x']), p).status, 'unchecked');
  });

  void it('confirms tracking-before-consent from consentData, never refutes', () => {
    const has = idx({ 'https://e.com/x': { consentData: { trackingBeforeConsent: ['googletagmanager.com'], cookiesBeforeConsent: [] } as unknown as PageInfo['consentData'] } });
    const none = idx({ 'https://e.com/x': { consentData: { trackingBeforeConsent: [], cookiesBeforeConsent: [] } as unknown as PageInfo['consentData'] } });
    assert.strictEqual(verifyFinding('Multiple tracking cookies set before consent', detail(['https://e.com/x']), has).status, 'confirmed');
    assert.strictEqual(verifyFinding('Multiple tracking cookies set before consent', detail(['https://e.com/x']), none).status, 'unchecked');
  });

  void it('confirms color-contrast AAA vs AA against colorContrastData without cross-matching', () => {
    const p = idx({ 'https://e.com/x': { colorContrastData: { aaFailures: 5, aaaFailures: 20 } as PageInfo['colorContrastData'] } });
    // "passes AA but fails AAA" → AAA reader (must NOT hit the AA matcher despite containing "AA")
    assert.strictEqual(verifyFinding('Color contrast passes AA but fails AAA (20 elements)', detail(['https://e.com/x']), p).status, 'confirmed');
    // "fails WCAG AA" → AA reader
    assert.strictEqual(verifyFinding('Color contrast fails WCAG AA (5 elements)', detail(['https://e.com/x']), p).status, 'confirmed');
    // 0 failures → confirm-only stays unchecked
    const none = idx({ 'https://e.com/x': { colorContrastData: { aaFailures: 0, aaaFailures: 0 } as PageInfo['colorContrastData'] } });
    assert.strictEqual(verifyFinding('Color contrast passes AA but fails AAA (3 elements)', detail(['https://e.com/x']), none).status, 'unchecked');
  });

  void it('confirms SRI / Permissions-Policy / cross-origin / reduced-motion / autocomplete from persisted signals', () => {
    const p = idx({
      'https://e.com/x': {
        sriData: { missingIntegrity: [{}, {}] } as unknown as PageInfo['sriData'],
        permissionsPolicyData: { hasPermissionsPolicy: false } as PageInfo['permissionsPolicyData'],
        crossOriginPolicyData: { isCrossOriginIsolated: false } as PageInfo['crossOriginPolicyData'],
        reducedMotionData: { hasReducedMotionQuery: false } as PageInfo['reducedMotionData'],
        formData: { inputsWithoutAutocomplete: 3 } as PageInfo['formData'],
      },
    });
    assert.strictEqual(verifyFinding('External scripts missing Subresource Integrity (SRI)', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Missing Permissions-Policy header', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Missing cross-origin isolation headers', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('No prefers-reduced-motion CSS support', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(verifyFinding('Form inputs missing autocomplete attribute', detail(['https://e.com/x']), p).status, 'confirmed');
  });

  void it('confirms a single-cited "identical title" finding by scanning the full index (exact + truncated)', () => {
    const pages = idx({
      'https://e.com/a': { title: 'Shared Webinar Title | Siro' },
      'https://e.com/b': { title: 'Shared Webinar Title | Siro' },
      'https://e.com/c': { title: 'Other' },
    });
    const ex = 'Title "Shared Webinar Title | Siro" is duplicated for this page <a href="https://e.com/a">a</a>';
    assert.strictEqual(verifyFinding('Some pages have identical titles', detail([ex]), pages).status, 'confirmed');
    // Truncated description quote ("…") matched by prefix across pages
    const dpages = idx({
      'https://e.com/a': { description: 'EasyCare and Siro show how EasyCoach uses AI to analyze calls and coach reps' },
      'https://e.com/b': { description: 'EasyCare and Siro show how EasyCoach uses AI to analyze calls and coach reps' },
    });
    const dex = 'Description "EasyCare and Siro show how EasyCoach uses AI to an..." is duplicated for this page <a href="https://e.com/a">a</a>';
    assert.strictEqual(verifyFinding('Some pages have identical descriptions', detail([dex]), dpages).status, 'confirmed');
  });

  void it('reads too-many-h2 from the persisted h2Count field (confirm-only)', () => {
    const over = idx({ 'https://e.com/x': { headings: { h2Count: 17 } as PageInfo['headings'] } });
    const under = idx({ 'https://e.com/x': { headings: { h2Count: 2 } as PageInfo['headings'] } });
    assert.strictEqual(verifyFinding('Some pages have more than 10 h2 tags', detail(['https://e.com/x']), over).status, 'confirmed');
    assert.strictEqual(verifyFinding('Some pages have more than 10 h2 tags', detail(['https://e.com/x']), under).status, 'unchecked');
  });

  void it('confirms link-graph findings (orphan / unreachable / click-depth / low-equity) from SiteData', () => {
    const pages = idx({
      'https://e.com/': {},
      'https://e.com/deep': {},
      'https://e.com/orphan': {},
      'https://e.com/low': {},
    });
    const site = {
      incoming: new Map<string, string[]>([
        ['https://e.com/deep', ['https://e.com/a']],
        ['https://e.com/low', ['https://e.com/a', 'https://e.com/b']],
        ['https://e.com/orphan', []],
      ]),
      depthFromHome: new Map<string, number>([['https://e.com', 0], ['https://e.com/deep', 22]]),
      robotsDisallow: ['/admin/*'],
      robotsUserAgents: ['*'],
      sitemapUrls: new Set<string>(),
    };
    assert.strictEqual(verifyFinding('Orphan page (no internal links point to it)', detail(['https://e.com/orphan']), pages, site).status, 'confirmed');
    assert.strictEqual(verifyFinding('Page unreachable from homepage via internal links', detail(['https://e.com/orphan']), pages, site).status, 'confirmed');
    assert.strictEqual(verifyFinding('Page is more than 4 clicks from homepage', detail(['https://e.com/deep']), pages, site).status, 'confirmed');
    assert.strictEqual(verifyFinding('Page has very low internal link equity', detail(['https://e.com/low']), pages, site).status, 'confirmed');
    // No SiteData → unchecked, never a false drop
    assert.strictEqual(verifyFinding('Orphan page (no internal links point to it)', detail(['https://e.com/orphan']), pages).status, 'unchecked');
  });

  void it('confirms robots.txt findings from SiteData', () => {
    const pages = idx({ 'https://e.com/': {} });
    const site = {
      incoming: new Map<string, string[]>(),
      depthFromHome: new Map<string, number>(),
      robotsDisallow: ['/admin/*'],
      robotsUserAgents: ['*'],
      sitemapUrls: new Set<string>(),
    };
    assert.strictEqual(verifyFinding('Sensitive paths exposed in robots.txt', detail(['/admin']), pages, site).status, 'confirmed');
    assert.strictEqual(verifyFinding('Pattern matching characters used in robots.txt', detail(['/admin/*']), pages, site).status, 'confirmed');
    assert.strictEqual(verifyFinding('No explicit AI crawler rules in robots.txt', detail(['x']), pages, site).status, 'confirmed');
    // When GPTBot IS named → the AI-rules finding is left unchecked (not confirmed)
    const withAi = { ...site, robotsUserAgents: ['*', 'gptbot'] };
    assert.strictEqual(verifyFinding('No explicit AI crawler rules in robots.txt', detail(['x']), pages, withAi).status, 'unchecked');
  });

  void it('confirms sitemap findings (uncrawled URLs + indexable-not-in-sitemap count)', () => {
    const pages = idx({
      'https://e.com/a': { indexability: { isIndexable: true } as PageInfo['indexability'] },
      'https://e.com/b': { indexability: { isIndexable: true } as PageInfo['indexability'] },
    });
    const site = {
      incoming: new Map<string, string[]>(),
      depthFromHome: new Map<string, number>(),
      robotsDisallow: [],
      robotsUserAgents: [],
      sitemapUrls: new Set<string>(['https://e.com/a']), // /b indexable but absent
    };
    // Example cites an uncrawled sitemap URL
    assert.strictEqual(verifyFinding('Sitemap URLs were not successfully crawled', detail(['https://e.com/ghost']), pages, site).status, 'confirmed');
    // Count-only finding (no URL) → site-level fallback counts /b
    assert.strictEqual(verifyFinding('Indexable pages missing from sitemap', detail(['45 indexable page(s) are not listed in the sitemap']), pages, site).status, 'confirmed');
  });

  void it('confirms too-many-fonts from fontData.totalFonts', () => {
    const many = idx({ 'https://e.com/x': { fontData: { totalFonts: 7 } as PageInfo['fontData'] } });
    const few = idx({ 'https://e.com/x': { fontData: { totalFonts: 2 } as PageInfo['fontData'] } });
    assert.strictEqual(verifyFinding('Too many font files loaded', detail(['https://e.com/x']), many).status, 'confirmed');
    assert.strictEqual(verifyFinding('Too many font files loaded', detail(['https://e.com/x']), few).status, 'unchecked');
  });

  void it('verifyDetails partitions findings into confirmed / refuted / unchecked', () => {
    const pages = idx({
      'https://e.com/a': { canonical: '' }, // genuinely missing → confirmed
      'https://e.com/b': { canonical: 'https://e.com/b' }, // present → refuted
      'https://e.com/c': {},
    });
    const details: Record<string, VIssueDetail> = {
      'Missing canonical URL on /a': detail(['https://e.com/a']),
      'Missing canonical URL on /b': detail(['https://e.com/b']),
      'Some unrelated finding': detail(['https://e.com/c']),
    };
    const summary = verifyDetails(details, pages);
    assert.strictEqual(summary.confirmedCount, 1);
    assert.strictEqual(summary.refutedCount, 1);
    assert.strictEqual(summary.uncheckedCount, 1);
    assert.ok(summary.confirmed.has('Missing canonical URL on /a'));
    assert.ok(summary.refuted.has('Missing canonical URL on /b'));
  });
});

void describe('verification labels in the report', () => {
  void it('labels every issue ✓ Verified / unverified ONLY when a verify view is passed', () => {
    const arts = mkArtifacts(['Alpha unknown finding']);
    // Verified report, finding confirmed → ✓ Verified, no "unverified".
    const confirmed = buildReportMarkdown(arts, {}, [], new Set(), { confirmed: new Set(['Alpha unknown finding']) });
    assert.ok(confirmed.includes('✓ Verified'), 'confirmed issue should be badged');
    assert.ok(!confirmed.includes('>unverified<'), 'confirmed issue must not be marked unverified');
    // Verified report, finding NOT confirmed → unverified label.
    const unchecked = buildReportMarkdown(arts, {}, [], new Set(), { confirmed: new Set() });
    assert.ok(unchecked.includes('unverified'), 'unchecked issue should be marked unverified');
    assert.ok(!unchecked.includes('✓ Verified'), 'unchecked issue must not be badged verified');
    // Normal report (no verify view) → no verification labels at all.
    const normal = buildReportMarkdown(arts);
    assert.ok(!normal.includes('✓ Verified') && !normal.includes('unverified'), 'normal report carries no labels');
  });
});

void describe('finding-verifier — persisted-field readers', () => {
  // canonical/description are only set when present; an absent field on an
  // ANALYZED page (has `indexability`) means the tag was genuinely missing.
  const analyzed = { indexability: { isIndexable: true } } as Partial<PageInfo>;

  void it('confirms missing-canonical on an analyzed page with no canonical field', () => {
    const pages = idx({ 'https://e.com/x': { ...analyzed } });
    assert.strictEqual(verifyFinding('Canonicals are not set for some pages', detail(['https://e.com/x']), pages).status, 'confirmed');
  });

  void it('still UNCHECKED when the page was not analyzed (no indexability)', () => {
    const pages = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Canonicals are not set for some pages', detail(['https://e.com/x']), pages).status, 'unchecked');
  });

  void it('confirms missing-description on an analyzed page with no description', () => {
    const pages = idx({ 'https://e.com/x': { ...analyzed } });
    assert.strictEqual(verifyFinding('Description meta tag is missing', detail(['https://e.com/x']), pages).status, 'confirmed');
  });

  void it('reads noindex from indexability.hasNoindexTag (confirm) and can refute', () => {
    const yes = idx({ 'https://e.com/x': { indexability: { hasNoindexTag: true } } as Partial<PageInfo> });
    const no = idx({ 'https://e.com/x': { indexability: { hasNoindexTag: false } } as Partial<PageInfo> });
    const unknown = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), yes).status, 'confirmed');
    assert.strictEqual(verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), no).status, 'refuted');
    assert.strictEqual(verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), unknown).status, 'unchecked');
  });

  void it('reads redirect from hasRedirects (confirm) and refutes when not redirecting', () => {
    const yes = idx({ 'https://e.com/x': { hasRedirects: true, redirectCount: 1 } });
    const no = idx({ 'https://e.com/x': { hasRedirects: false, redirectCount: 0 } });
    assert.strictEqual(verifyFinding('3xx redirects in sitemap', detail(['https://e.com/x']), yes).status, 'confirmed');
    assert.strictEqual(verifyFinding('3xx redirects in sitemap', detail(['https://e.com/x']), no).status, 'refuted');
  });

  void it('verifies soft-404 from the persisted soft404 block', () => {
    const yes = idx({ 'https://e.com/x': { soft404: { isSoft404: true, confidence: 80, signals: [] } } as Partial<PageInfo> });
    const no = idx({ 'https://e.com/x': { soft404: { isSoft404: false, confidence: 0, signals: [] } } as Partial<PageInfo> });
    assert.strictEqual(verifyFinding('Soft 404 page', detail(['https://e.com/x']), yes).status, 'confirmed');
    assert.strictEqual(verifyFinding('Soft 404 page', detail(['https://e.com/x']), no).status, 'refuted');
  });
});

void describe('finding-verifier — threshold & boolean verifiers', () => {
  void it('confirms a CWV finding when the stored metric breaches the threshold, refutes when not', () => {
    const bad = idx({ 'https://e.com/x': { LCP: 4000 } });
    const ok = idx({ 'https://e.com/x': { LCP: 1800 } });
    const none = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), bad).status, 'confirmed');
    assert.strictEqual(verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), ok).status, 'refuted');
    assert.strictEqual(verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), none).status, 'unchecked');
  });

  void it('does NOT match a non-threshold metric mention ("LCP image not preloaded")', () => {
    const pages = idx({ 'https://e.com/x': { LCP: 1000 } });
    assert.strictEqual(verifyFinding('LCP image not preloaded', detail(['https://e.com/x']), pages).status, 'unchecked');
  });

  void it('verifies title/description length against the same bar the analyzer used', () => {
    const longTitle = idx({ 'https://e.com/x': { titleLength: 72 } });
    const shortTitle = idx({ 'https://e.com/x': { titleLength: 20 } });
    assert.strictEqual(verifyFinding('Some pages have titles that are too long', detail(['https://e.com/x']), longTitle).status, 'confirmed');
    assert.strictEqual(verifyFinding('Some pages have titles that are too long', detail(['https://e.com/x']), shortTitle).status, 'refuted');
    // "too short" must not fire on a 0-length (that's "missing", a different finding).
    const zero = idx({ 'https://e.com/x': { titleLength: 0 } });
    assert.strictEqual(verifyFinding('Some pages have titles that are too short', detail(['https://e.com/x']), zero).status, 'refuted');
  });

  void it('thin content is confirm-only (never refutes — the analyzer bar varies)', () => {
    const thin = idx({ 'https://e.com/x': { contentQuality: { wordCount: 50 } as PageInfo['contentQuality'] } });
    const fat = idx({ 'https://e.com/x': { contentQuality: { wordCount: 1200 } as PageInfo['contentQuality'] } });
    assert.strictEqual(verifyFinding('Page has very thin content', detail(['https://e.com/x']), thin).status, 'confirmed');
    assert.strictEqual(verifyFinding('Page has very thin content', detail(['https://e.com/x']), fat).status, 'unchecked');
  });

  void it('verifies console errors and per-page broken outbound links', () => {
    const errs = idx({ 'https://e.com/x': { consoleAnalysis: { errorCount: 3, warningCount: 0 } as PageInfo['consoleAnalysis'] } });
    assert.strictEqual(verifyFinding('JavaScript console errors detected', detail(['https://e.com/x']), errs).status, 'confirmed');
    const broken = idx({ 'https://e.com/x': { outboundLinkHealth: { broken: [{ url: 'x' }] } as unknown as PageInfo['outboundLinkHealth'] } });
    assert.strictEqual(verifyFinding('Page has 2 broken outbound link(s)', detail(['https://e.com/x']), broken).status, 'confirmed');
  });
});

// ============================================================
// LLM finding-verify — pure parsing + signal collection
// ============================================================
import { parseLlmVerdicts, extractCliResult } from '../lib/phase3/llm-finding-verify';
import { buildPageSignals, collectUncheckedContexts } from '../lib/phase3/finding-verifier';

void describe('llm finding-verify parsing', () => {
  void it('keeps only known indices and normalizes unknown verdicts to unsure', () => {
    const raw = '```json\n{"verdicts":[{"index":0,"verdict":"confirmed","reason":"ok"},{"index":1,"verdict":"weird"},{"index":9,"verdict":"refuted"}]}\n```';
    const out = parseLlmVerdicts(raw, [0, 1]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].verdict, 'confirmed');
    assert.strictEqual(out[1].verdict, 'unsure'); // "weird" → unsure
    assert.ok(!out.find((v) => v.index === 9)); // out-of-range dropped
  });

  void it('returns [] on malformed output', () => {
    assert.deepStrictEqual(parseLlmVerdicts('no json here', [0]), []);
    assert.deepStrictEqual(parseLlmVerdicts('{"nope":1}', [0]), []);
  });

  void it('extractCliResult unwraps the --output-format json envelope and tolerates raw text', () => {
    // CLI JSON envelope: the assistant text lives in `.result`.
    const env = JSON.stringify({ type: 'result', result: '{"verdicts":[{"index":0,"verdict":"confirmed"}]}', is_error: false });
    assert.ok(extractCliResult(env).includes('"verdicts"'));
    // Verdicts parse straight out of the unwrapped result.
    assert.strictEqual(parseLlmVerdicts(extractCliResult(env), [0])[0].verdict, 'confirmed');
    // Bare text (no envelope) is returned as-is.
    assert.strictEqual(extractCliResult('{"verdicts":[]}'), '{"verdicts":[]}');
    // Empty / whitespace → ''.
    assert.strictEqual(extractCliResult('   '), '');
    assert.strictEqual(extractCliResult(''), '');
  });
});

void describe('llm finding-verify context collection', () => {
  void it('builds a compact, defined-only signal snapshot', () => {
    const sig = buildPageSignals({ url: 'https://e.com/x', status: 200, titleLength: 40, LCP: 3000 } as PageInfo);
    assert.strictEqual(sig.status, 200);
    assert.strictEqual(sig.LCP, 3000);
    assert.ok(!('CLS' in sig), 'undefined fields are pruned');
    assert.deepStrictEqual(buildPageSignals(undefined), {}); // off-page → empty
  });

  void it('collects only the deterministically-unchecked findings, with their page signals', () => {
    const idxObj = idx({ 'https://e.com/x': { status: 200, titleLength: 40 } });
    const details: Record<string, P2IssueDetail> = {
      'Content may lack topical focus': { severity: 'low', count: 1, examples: ['https://e.com/x'] }, // no verifier → unchecked
      'Duplicate page titles found': { severity: 'high', count: 2, examples: ['t "A" used on 2: https://e.com/x https://e.com/y'] },
    };
    const summary = verifyDetails(details, idxObj);
    const ctxs = collectUncheckedContexts(details, summary.results, idxObj);
    assert.ok(ctxs.some((c) => c.key === 'Content may lack topical focus'), 'unchecked finding is collected');
    assert.ok(ctxs.every((c) => c.message && c.example), 'each context has message + example');
  });
});

import { parseReportFindings } from '../lib/phase3/live-verifier';

void describe('live-verifier: parseReportFindings', () => {
  const md = [
    '## SEO Audit',
    '',
    '### Top Priority Issues',
    '',
    '1. <span class="sev-high">HIGH</span> — Something *(3 occurrences)*',
    '',
    '### Canonicals are not set for some pages',
    '',
    '<span class="sev-high">HIGH</span> · affects 44 occurrences · effort: low',
    '',
    '**Affected pages**',
    '',
    '- [/a](https://www.siro.ai/a) — missing canonical',
    '- [/b](https://www.siro.ai/b) — missing canonical',
    '',
    '### Broken pagination wastes crawl budget — https://www.siro.ai/insights/page/{N}',
    '',
    '<span class="sev-high">HIGH</span> · affects 1 occurrence · effort: medium',
    '',
    '**Affected pages**',
    '',
    '- [/insights/page/{N}](https://www.siro.ai/insights/page/{N}) — template',
    '',
    '### Minor cosmetic thing',
    '',
    '<span class="sev-low">LOW</span> · affects 2 occurrences · effort: low',
    '',
    '**Affected pages**',
    '',
    '- [/c](https://www.siro.ai/c) — low sev',
    '',
  ].join('\n');

  const findings = parseReportFindings(md);

  void it('skips summary headings without a severity line', () => {
    assert.ok(!findings.some((f) => f.title === 'Top Priority Issues'), 'summary heading excluded');
  });

  void it('keeps CRITICAL/HIGH/MEDIUM and drops LOW', () => {
    assert.ok(findings.some((f) => f.title === 'Canonicals are not set for some pages'));
    assert.ok(!findings.some((f) => f.title === 'Minor cosmetic thing'), 'LOW dropped');
  });

  void it('extracts the first real example URL', () => {
    const c = findings.find((f) => f.title === 'Canonicals are not set for some pages');
    assert.strictEqual(c?.exampleUrl, 'https://www.siro.ai/a');
    assert.strictEqual(c?.severity, 'HIGH');
  });

  void it('parses the occurrence count (used to guard plural refutes)', () => {
    const c = findings.find((f) => f.title === 'Canonicals are not set for some pages');
    assert.strictEqual(c?.count, 44);
  });

  void it('leaves exampleUrl undefined when only templated {N} URLs exist', () => {
    const p = findings.find((f) => f.title.startsWith('Broken pagination'));
    assert.ok(p, 'pagination finding parsed');
    assert.strictEqual(p?.exampleUrl, undefined, 'templated URL not used as example');
  });
});

void describe('live-verifier: parseReportFindings — scan bounds & exclusions', () => {
  void it('does NOT grab a URL from Fix/Resources when Affected pages has no link (F1)', () => {
    const md = [
      '## SEO Audit',
      '',
      '### Finding whose example is plain text',
      '',
      '<span class="sev-high">HIGH</span> · affects 3 occurrences · effort: low',
      '',
      '**Affected pages**',
      '',
      '- Bare contextual evidence with no markdown link',
      '',
      '**Fix**',
      '',
      'Apply the standard best practice.',
      '',
      '**Resources**',
      '',
      '- [web.dev guide](https://web.dev/some-guide)',
      '',
    ].join('\n');
    const f = parseReportFindings(md);
    const finding = f.find((x) => x.title.startsWith('Finding whose example'));
    assert.ok(finding, 'finding parsed');
    assert.strictEqual(finding?.exampleUrl, undefined, 'Resources URL not used as example');
  });

  void it('skips AI-discovered findings (F3)', () => {
    const md = [
      '## UX Audit',
      '',
      '### Dead button on hero',
      '',
      '<span class="sev-medium">MEDIUM</span> · affects 1 occurrence · 🔍 AI-discovered · effort: medium',
      '',
      '**Affected pages**',
      '',
      '- Button does nothing — [https://x.example/](https://x.example/)',
      '',
    ].join('\n');
    const f = parseReportFindings(md);
    assert.ok(!f.some((x) => x.title === 'Dead button on hero'), 'AI-discovered finding excluded');
  });

  void it('parses CRITICAL severity from the span text, not the class (F8)', () => {
    const md = [
      '## Security Audit',
      '',
      '### Critical security gap',
      '',
      '<span class="sev-high">CRITICAL</span> · affects 2 occurrences · effort: high',
      '',
      '**Affected pages**',
      '',
      '- [/x](https://x.example/x) — bad',
      '',
    ].join('\n');
    const f = parseReportFindings(md);
    const finding = f.find((x) => x.title === 'Critical security gap');
    assert.strictEqual(finding?.severity, 'CRITICAL');
  });
});

import { checkFindingSignals, brokenOutboundVerdict, titleDescriptionVerdict, sharedTitleKeyword, resolveSiteOrigin, cannibalisationElement, type LiveSignals } from '../lib/phase3/live-verifier';

void describe('live-verifier: checker refute contract', () => {
  // A clean baseline page (no defects present at load).
  const base: LiveSignals = {
    url: 'https://x.example/', finalUrl: 'https://x.example/', status: 200, ttfbMs: 100,
    htmlBytes: 1000, totalBytes: 1000, totalRequests: 1, title: 'T', description: 'd', canonical: 'https://x.example/',
    h1Count: 1, iframeCount: 0, wordCount: 800, semanticRatio: 0.5, emptyAnchorCount: 0, inputsWithoutAutocomplete: 0,
    scriptsNoSri: 0, maxChildren: 5, jpgPngImages: 0, modernImages: 2, renderBlockingTotal: 0, renderBlockingThirdParty: 0,
    thirdPartyOrigins: 0, thirdPartyRequests: 0, thirdPartyBytes: 0, adScriptBytes: 0, largestImageBytes: 0, oversizedImages: 0,
    clsValue: 0, tbtMs: 0, unusedCssRatio: -1, unusedJsRatio: -1, preConsentTrackingCookies: 0, contrastViolations: -1,
    mainCount: 1, resourceHintCount: 2, privacyLinkCount: 1, tlsMs: 50, eeatSignals: 2,
  };

  void it('autocomplete is confirm-only: 0 inputs at load → unverified, NOT refuted (forms can mount on interaction)', () => {
    const r = checkFindingSignals('Form inputs missing autocomplete attribute', base, 1);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('autocomplete confirms when inputs without autocomplete are present at load', () => {
    const r = checkFindingSignals('Form inputs missing autocomplete attribute', { ...base, inputsWithoutAutocomplete: 4 }, 1);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('plural guard: a stable-signal refute on a multi-occurrence finding is downgraded to unverified', () => {
    // canonical present → missing-canonical would refute, but count>1 must not drop.
    const r = checkFindingSignals('Canonicals are not set for some pages', base, 44);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('single-occurrence stable-signal refute still refutes (the sampled page IS the finding)', () => {
    const r = checkFindingSignals('Canonical URL is not set', base, 1);
    assert.strictEqual(r.status, 'refuted');
  });

  // ---- registry-gap closers: every category-A finding kind is now OWNED ----

  void it('title-length confirms a too-short title and refutes one within range', () => {
    assert.strictEqual(checkFindingSignals('Some pages have titles that are too short', { ...base, title: 'short' }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Some pages have titles that are too short', { ...base, title: 'A perfectly adequate descriptive page title' }, 1).status, 'refuted');
  });

  void it('description-length confirms a too-long description and refutes one within range', () => {
    assert.strictEqual(checkFindingSignals('Some pages have descriptions that are too long', { ...base, description: 'x'.repeat(365) }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Some pages have descriptions that are too long', { ...base, description: 'y'.repeat(140) }, 1).status, 'refuted');
  });

  void it('length checkers do NOT own other "too long" findings (URL/headline/manifest) — locks matcher scope vs future wording drift', () => {
    // These real corpus messages contain "too long" but neither "title" nor
    // "description", so they must fall through, never be refuted against the
    // page's title/description length.
    for (const t of ['Article headline too long for rich results', 'Some URLs are too long', 'Manifest name too long', 'URL is too long (120 chars, max recommended: 100)']) {
      const r = checkFindingSignals(t, { ...base, title: 'short', description: 'x'.repeat(400) }, 1);
      assert.notStrictEqual(r.status, 'refuted', `"${t}" must not be refuted by a length checker`);
      assert.match(r.reason, /no live checker/i, `"${t}" should not route to title/description-length`);
    }
  });

  void it('missing-main confirms when no <main> landmark and refutes when present', () => {
    assert.strictEqual(checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 0 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 1 }, 1).status, 'refuted');
  });

  void it('missing-main matches the <main> titles but NOT <nav>/<header> landmark titles (which it must not refute against mainCount)', () => {
    // Real report titles that SHOULD route to the <main> checker.
    assert.strictEqual(checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 0 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Many pages missing <main> landmark', { ...base, mainCount: 0 }, 1).status, 'confirmed');
    // A <nav>/<header> landmark finding, or one whose text merely contains "main"
    // as a substring (FAQPage missing mainEntity), must NOT be owned by
    // missing-main — a present <main> would otherwise falsely refute (drop) it.
    for (const t of ['Missing <nav> landmark', 'Missing <header> landmark', 'FAQPage missing mainEntity array']) {
      const r = checkFindingSignals(t, { ...base, mainCount: 1 }, 1);
      assert.notStrictEqual(r.status, 'refuted', `"${t}" must not be refuted by the <main> checker`);
      assert.match(r.reason, /no live checker/i, `"${t}" should not route to missing-main`);
    }
  });

  void it('privacy-link confirms when absent and refutes when present', () => {
    assert.strictEqual(checkFindingSignals('No privacy policy link found', { ...base, privacyLinkCount: 0 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('No privacy policy link found', { ...base, privacyLinkCount: 1 }, 1).status, 'refuted');
  });

  void it('a multi-occurrence missing-main refute is downgraded to unverified (only the first page was checked)', () => {
    assert.strictEqual(checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 1 }, 19).status, 'unverified');
  });

  void it('tls is confirm-only: slow handshake confirms, fast/reused stays unverified (never refutes)', () => {
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: 446 }, 2).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: 20 }, 2).status, 'unverified');
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: null }, 2).status, 'unverified');
  });

  void it('resource-hints (site-wide page) confirms when the homepage has none, stays unverified when present', () => {
    assert.strictEqual(checkFindingSignals('Most pages lack resource hints', { ...base, resourceHintCount: 0 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Most pages lack resource hints', { ...base, resourceHintCount: 3 }, 1).status, 'unverified');
  });

  void it('eeat (site-wide page) confirms when no signals on the homepage, stays unverified otherwise', () => {
    assert.strictEqual(checkFindingSignals('Low E-E-A-T signals across site', { ...base, eeatSignals: 0 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Low E-E-A-T signals across site', { ...base, eeatSignals: 3 }, 1).status, 'unverified');
  });

  void it('cross-page topic aggregates are OWNED (unverified with reason), not a "no live checker" gap', () => {
    const topics = checkFindingSignals('Many topics with thin coverage', base, 1);
    assert.strictEqual(topics.status, 'unverified');
    assert.match(topics.reason, /topic|coverage aggregate/i);
    assert.doesNotMatch(topics.reason, /no live checker/i);
    assert.strictEqual(checkFindingSignals('High-opportunity content gaps identified', base, 1).status, 'unverified');
  });

  void it('every category-A kind resolves to a real checker, never the "no live checker" fallback', () => {
    const titles = [
      'Some pages have descriptions that are too long',
      'Some pages have titles that are too short',
      'Multiple pages target the same keyword in their titles',
      'Low E-E-A-T signals across site',
      'Some URLs are not listed in sitemap',
      'Most pages lack resource hints',
      'Many topics with thin coverage',
      'No privacy policy link found',
      'Missing `<main>` element',
      'High-opportunity content gaps identified',
      'Slow TLS negotiation',
    ];
    for (const t of titles) {
      assert.doesNotMatch(checkFindingSignals(t, base, 1).reason, /no live checker for this finding kind/i, `"${t}" should be owned by a checker`);
    }
  });
});

void describe('live-verifier: registry-gap pure helpers', () => {
  void it('titleDescriptionVerdict handles both directions and a missing value', () => {
    assert.strictEqual(titleDescriptionVerdict('title', 'short', false, 30, 60).status, 'confirmed');
    assert.strictEqual(titleDescriptionVerdict('title', 'a'.repeat(45), false, 30, 60).status, 'refuted');
    assert.strictEqual(titleDescriptionVerdict('description', 'd'.repeat(200), true, 120, 160).status, 'confirmed');
    assert.strictEqual(titleDescriptionVerdict('description', 'd'.repeat(140), true, 120, 160).status, 'refuted');
    assert.strictEqual(titleDescriptionVerdict('description', null, true, 120, 160).status, 'unverified');
    assert.strictEqual(titleDescriptionVerdict('title', '   ', false, 30, 60).status, 'unverified');
  });

  void it('sharedTitleKeyword finds a non-trivial shared word and ignores stopwords/short tokens', () => {
    assert.strictEqual(sharedTitleKeyword('AgntCMS Docs — Core', 'AgntCMS Docs — Concepts'), 'agntcms');
    assert.strictEqual(sharedTitleKeyword('The Home Page', 'The Home Site'), null); // only stopwords shared
    assert.strictEqual(sharedTitleKeyword('Pricing', 'Contact'), null);
  });

  void it('cannibalisationElement routes the H1 finding variant to H1, the title variant to title', () => {
    // Guards the wrong-element bug: the "…in their H1" finding must be verified
    // against H1s, not titles (which would falsely confirm off title overlap).
    assert.strictEqual(cannibalisationElement('Multiple pages target the same keyword in their H1'), 'h1');
    assert.strictEqual(cannibalisationElement('Multiple pages target the same keyword in their titles'), 'title');
  });

  void it('resolveSiteOrigin picks the most-cited on-site origin, ignoring external links', () => {
    const f = (urls: string[]): ReportFinding => ({ title: 't', severity: 'HIGH', count: 1, exampleUrl: urls[0], exampleUrls: urls });
    const origin = resolveSiteOrigin([
      f(['https://site.com/a', 'https://site.com/b']),
      f(['https://site.com/c']),
      f(['https://external.cdn/x']),
    ]);
    assert.strictEqual(origin, 'https://site.com');
    assert.strictEqual(resolveSiteOrigin([f([])]), null);
  });
});

void describe('live-verifier: parser ↔ renderer round-trip', () => {
  // Guards the implicit coupling between buildReportMarkdown's finding emit and
  // parseReportFindings: render a real finding through the actual renderer, then
  // re-parse it. Catches a renderer format change that hand-written fixtures
  // (which could share the same wrong format) would miss.
  void it('a rendered finding re-parses with matching title/severity/count/url', () => {
    const message = 'Canonicals are not set for some pages';
    const url = 'https://example.com/page-a';
    const md = buildReportMarkdown(mkArtifacts([message], { [message]: [url] }));
    const parsed = parseReportFindings(md);
    const f = parsed.find((p) => p.title === sanitizeProse(message));
    assert.ok(f, 'finding survives the render → parse round-trip');
    assert.strictEqual(f?.severity, 'HIGH');
    assert.strictEqual(f?.count, 5);
    assert.strictEqual(f?.exampleUrl, url);
  });
});

void describe('buildReportMarkdown screenshot embedding', () => {
  // A two-page evidence index; only /about and / were "sampled".
  const evidence = {
    'https_example.com_about': {
      url: 'https://example.com/about',
      files: ['screenshot.mobile.png', 'screenshot.desktop.png', 'axe.json'],
    },
    'https_example.com_': {
      url: 'https://example.com/',
      files: ['screenshot.mobile.png', 'screenshot.desktop.png'],
    },
  };
  function withEvidence(arts: AuditArtifacts, ev: Record<string, { url: string; files: string[] }>): AuditArtifacts {
    arts.manifest.evidence = ev;
    return arts;
  }

  void it('embeds mobile + desktop shots for a finding whose example page was sampled', () => {
    const msg = 'Canonicals are not set for some pages';
    const arts = withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), evidence);
    const md = buildReportMarkdown(arts);
    assert.match(md, /\*\*Screenshot\*\*/);
    assert.match(md, /src="evidence\/https_example\.com_about\/screenshot\.mobile\.png"/);
    assert.match(md, /src="evidence\/https_example\.com_about\/screenshot\.desktop\.png"/);
  });

  void it('renders no screenshot block when the cited page was not sampled', () => {
    const msg = 'Canonicals are not set for some pages';
    const arts = withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/unsampled'] }), evidence);
    const md = buildReportMarkdown(arts);
    assert.doesNotMatch(md, /\*\*Screenshot\*\*/);
  });

  void it('matches a trailing-slash / fragment variant of the sampled URL', () => {
    const msg = 'Canonicals are not set for some pages';
    const arts = withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about/#section'] }), evidence);
    const md = buildReportMarkdown(arts);
    assert.match(md, /src="evidence\/https_example\.com_about\/screenshot\.mobile\.png"/);
  });

  void it('embeds each page once; later findings on the same page get a pointer', () => {
    const a = 'Canonicals are not set for some pages';
    const b = 'Pages have titles that are too long';
    const arts = withEvidence(
      mkArtifacts([a, b], { [a]: ['https://example.com/about'], [b]: ['https://example.com/about'] }),
      evidence,
    );
    const md = buildReportMarkdown(arts);
    const mobileEmbeds = (md.match(/src="evidence\/https_example\.com_about\/screenshot\.mobile\.png"/g) ?? []).length;
    assert.strictEqual(mobileEmbeds, 1, 'the page screenshot is embedded exactly once across the report');
    assert.match(md, /is shown above\./);
  });

  void it('a rendered screenshot block does not corrupt parseReportFindings example capture', () => {
    const msg = 'Canonicals are not set for some pages';
    const url = 'https://example.com/about';
    const arts = withEvidence(mkArtifacts([msg], { [msg]: [url] }), evidence);
    const parsed = parseReportFindings(buildReportMarkdown(arts));
    const f = parsed.find((p) => p.title === sanitizeProse(msg));
    assert.ok(f, 'finding still parses');
    assert.strictEqual(f?.exampleUrl, url, 'example URL is the affected page, not a screenshot path');
  });

  void it('output is identical regardless of evidence-key insertion order', () => {
    const msg = 'Canonicals are not set for some pages';
    const reversed = Object.fromEntries(Object.entries(evidence).reverse());
    const fwd = buildReportMarkdown(withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), evidence));
    const rev = buildReportMarkdown(withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), reversed));
    assert.strictEqual(fwd, rev);
  });

  void it('on a normalized-URL collision the pick is deterministic, not manifest-order dependent', () => {
    // Two sampled dirs whose URLs differ only by a trailing slash both normalize
    // to the same key (a real possibility — the tool flags trailing-slash pairs
    // elsewhere). The chosen screenshot must not depend on manifest/readdir order.
    const msg = 'Canonicals are not set for some pages';
    const collide = {
      aaa_dir: { url: 'https://example.com/about', files: ['screenshot.mobile.png', 'screenshot.desktop.png'] },
      zzz_dir: { url: 'https://example.com/about/', files: ['screenshot.mobile.png', 'screenshot.desktop.png'] },
    };
    const reversed = Object.fromEntries(Object.entries(collide).reverse());
    const fwd = buildReportMarkdown(withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), collide));
    const rev = buildReportMarkdown(withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), reversed));
    assert.strictEqual(fwd, rev, 'collision pick is insertion-order independent');
    // The lexicographically-first dir key wins, in either order.
    assert.match(fwd, /src="evidence\/aaa_dir\/screenshot\.mobile\.png"/);
    assert.doesNotMatch(fwd, /src="evidence\/zzz_dir\//);
  });
});

import { verifySitemapMembership, verifyReachability, type LiveSite, type ReportFinding } from '../lib/phase3/live-verifier';

void describe('live-verifier: site-level verifiers', () => {
  const f = (title: string, url: string): ReportFinding => ({ title, severity: 'HIGH', count: 1, exampleUrl: url, exampleUrls: [url] });
  const site: LiveSite = {
    sitemapUrls: new Set(['https://e.com/a']),
    sitemapCapped: false,
    reachable: new Set(['https://e.com/a']),
    reachabilityCapped: false,
  };

  void it('sitemap: cited page absent from sitemap → confirmed; present → refuted', () => {
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/orphan'), site).status, 'confirmed');
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/a'), site).status, 'refuted');
  });

  void it('reachability: unreachable → confirmed; reachable → refuted', () => {
    assert.strictEqual(verifyReachability(f('Orphan page', 'https://e.com/orphan'), site).status, 'confirmed');
    assert.strictEqual(verifyReachability(f('Orphan page', 'https://e.com/a'), site).status, 'refuted');
  });

  void it('reachability: when the BFS was capped, a missing page is unverified (never a false orphan)', () => {
    const capped: LiveSite = { ...site, reachabilityCapped: true };
    assert.strictEqual(verifyReachability(f('Orphan page', 'https://e.com/orphan'), capped).status, 'unverified');
  });

  void it('sitemap: no sitemap fetched → unverified', () => {
    const empty: LiveSite = { sitemapUrls: new Set(), sitemapCapped: false, reachable: new Set(), reachabilityCapped: false };
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/x'), empty).status, 'unverified');
  });
});

import { crawlProfileToThrottle, firstExampleUrl, writeRefutedReport, loadPhase2State } from '../lib/phase3/verify-runner';
import { NETWORK_CONDITIONS, CPU_CONDITIONS } from '../lib/constants';

void describe('phase3: phase2-state.json boundary', () => {
  void it('round-trips the Phase 2 render state (suppression, narratives, anomalies, noScore)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2state-'));
    const state = {
      version: 1,
      generatedAt: '2026-06-04T00:00:00.000Z',
      suppressed: ['Duplicate page titles found'],
      narratives: { seo: 'Anchored narrative.' },
      anomalies: [{ section: 'ux', title: 'Dead button', severity: 'high', url: 'https://e.com/', evidence: 'e', recommendation: 'r' }],
      noScore: true,
    };
    fs.writeFileSync(path.join(dir, 'phase2-state.json'), JSON.stringify(state));
    assert.deepStrictEqual(loadPhase2State(dir), state);
  });

  void it('returns null when the state file is absent, malformed, missing the suppression array, or future-versioned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2state-missing-'));
    assert.strictEqual(loadPhase2State(dir), null, 'absent file');
    fs.writeFileSync(path.join(dir, 'phase2-state.json'), 'not json');
    assert.strictEqual(loadPhase2State(dir), null, 'malformed JSON');
    fs.writeFileSync(path.join(dir, 'phase2-state.json'), JSON.stringify({ version: 1, narratives: {} }));
    assert.strictEqual(loadPhase2State(dir), null, 'suppressed must be an array');
    fs.writeFileSync(path.join(dir, 'phase2-state.json'), JSON.stringify({ version: 2, suppressed: [], narratives: {}, anomalies: [], noScore: false }));
    assert.strictEqual(loadPhase2State(dir), null, 'unknown version degrades to the absent-state fallback');
  });
});

void describe('phase3: refuted-findings report', () => {
  void it('firstExampleUrl extracts the first real URL and skips templated {N} series keys', () => {
    assert.strictEqual(firstExampleUrl(['The page <a href="https://e.com/x">x</a> has a short title']), 'https://e.com/x');
    assert.strictEqual(firstExampleUrl(['[https://e.com/insights/page/{N}](https://e.com/insights/page/{N})', 'https://e.com/real']), 'https://e.com/real');
    assert.strictEqual(firstExampleUrl(['no url here']), undefined);
    assert.strictEqual(firstExampleUrl(undefined), undefined);
    // Trailing sentence punctuation on a bare URL is trimmed.
    assert.strictEqual(firstExampleUrl(['available at https://e.com/x.']), 'https://e.com/x');
    assert.strictEqual(firstExampleUrl(['see https://e.com/a/b; next']), 'https://e.com/a/b');
  });

  void it('writeRefutedReport writes nothing (returns null) when no findings were refuted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refuted-empty-'));
    assert.strictEqual(writeRefutedReport(dir, 'e.com', 'live', []), null);
    assert.strictEqual(fs.existsSync(path.join(dir, 'audit-report.refuted.md')), false);
  });

  void it('writeRefutedReport writes a report listing each dropped finding with its reason', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refuted-'));
    const out = writeRefutedReport(dir, 'e.com', 'live', [
      { title: 'Some URLs are not listed in sitemap', severity: 'medium', kind: 'site-graph', exampleUrl: 'https://e.com/', reason: 'cited page IS present in the sitemap' },
    ]);
    assert.ok(out, 'returns the written path');
    const md = fs.readFileSync(out as string, 'utf8');
    assert.match(md, /refuted findings/i);
    assert.match(md, /1 finding\(s\) dropped/);
    assert.match(md, /Some URLs are not listed in sitemap/);
    assert.match(md, /site-graph/);
    assert.match(md, /cited page IS present in the sitemap/);
    assert.match(md, /\*\*Re-checked:\*\*/, 'live mode labels the URL "Re-checked"');
  });

  void it('the data (offline) pass labels the URL "Example", not the live-only "Re-checked"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refuted-data-'));
    const out = writeRefutedReport(dir, 'e.com', 'data', [
      { title: 'Duplicate page titles found', severity: 'medium', kind: 'duplicate-title', exampleUrl: 'https://e.com/a', reason: 'titles differ in the crawl data' },
    ]);
    const md = fs.readFileSync(out as string, 'utf8');
    assert.match(md, /\*\*Example:\*\*/);
    assert.doesNotMatch(md, /Re-checked/);
  });
});

void describe('live-verifier: crawl throttle round-trip', () => {
  void it('maps a --perf crawl profile (slow4g network, normal cpu) to a live Throttle', () => {
    // This is exactly what the crawler records (crawler-engine selects
    // networkConditions.slow4g + cpuConditions.normal).
    const t = crawlProfileToThrottle({ perf: true, network: NETWORK_CONDITIONS.slow4g, cpu: CPU_CONDITIONS.normal });
    assert.ok(t, 'a perf crawl yields a throttle (regression guard: the map-vs-condition shape bug returned undefined)');
    assert.strictEqual(t?.downloadBps, NETWORK_CONDITIONS.slow4g.download);
    assert.strictEqual(t?.latencyMs, NETWORK_CONDITIONS.slow4g.latency);
    assert.strictEqual(t?.cpuRate, undefined, 'normal cpu is noThrottle → no CPU rate');
  });

  void it('returns undefined for a non-perf (unthrottled) crawl', () => {
    assert.strictEqual(crawlProfileToThrottle({ perf: false, network: null, cpu: null }), undefined);
    assert.strictEqual(crawlProfileToThrottle(null), undefined);
  });

  void it('applies CPU throttle when the selected cpu condition has a rate', () => {
    const t = crawlProfileToThrottle({ perf: true, network: NETWORK_CONDITIONS.normal, cpu: CPU_CONDITIONS.slow });
    assert.strictEqual(t?.cpuRate, CPU_CONDITIONS.slow.rate);
  });
});

void describe('live-verifier: broken-outbound match split', () => {
  const sig = (status: number): LiveSignals => ({
    url: 'https://e.com/p', finalUrl: 'https://e.com/p', status, ttfbMs: 100, htmlBytes: 1000, totalBytes: 1000, totalRequests: 1,
    title: 'T', description: 'd', canonical: 'https://e.com/p', h1Count: 1, iframeCount: 0, wordCount: 800, semanticRatio: 0.5,
    emptyAnchorCount: 0, inputsWithoutAutocomplete: 0, scriptsNoSri: 0, maxChildren: 5, jpgPngImages: 0, modernImages: 2,
    renderBlockingTotal: 0, renderBlockingThirdParty: 0, thirdPartyOrigins: 0, thirdPartyRequests: 0, thirdPartyBytes: 0,
    adScriptBytes: 0, largestImageBytes: 0, oversizedImages: 0, clsValue: 0, tbtMs: 0, unusedCssRatio: -1, unusedJsRatio: -1,
    preConsentTrackingCookies: 0, contrastViolations: -1,
    mainCount: 1, resourceHintCount: 2, privacyLinkCount: 1, tlsMs: 50, eeatSignals: 2,
  });

  void it('per-page "Page has N broken outbound link(s)" does NOT refute on a 200 container page', () => {
    // The example is the on-site container (HTTP 200); refuting here would drop a real finding.
    const r = checkFindingSignals('Page has 3 broken outbound link(s)', sig(200), 1);
    assert.notStrictEqual(r.status, 'refuted');
  });

  void it('site-wide broken-outbound verdict is confirm-only: 4xx → confirmed, 200 → unverified (volatile, never dropped)', () => {
    assert.strictEqual(brokenOutboundVerdict(404).status, 'confirmed');
    assert.strictEqual(brokenOutboundVerdict(503).status, 'confirmed');
    // External-link liveness is volatile; a 200 now must NOT drop a real finding.
    assert.strictEqual(brokenOutboundVerdict(200).status, 'unverified');
  });
});

void describe('live-verifier: path-case is significant in site-graph drop decisions', () => {
  const f = (title: string, url: string): ReportFinding => ({ title, severity: 'HIGH', count: 1, exampleUrl: url, exampleUrls: [url] });

  void it('sitemap: /Foo cited but only /foo in sitemap → NOT refuted (distinct resources)', () => {
    const site: LiveSite = { sitemapUrls: new Set(['https://e.com/foo']), sitemapCapped: false, reachable: new Set(), reachabilityCapped: true };
    // /Foo is genuinely missing; case-insensitive matching would wrongly drop it.
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/Foo'), site).status, 'confirmed');
  });

  void it('sitemap: exact case match → refuted', () => {
    const site: LiveSite = { sitemapUrls: new Set(['https://e.com/Foo']), sitemapCapped: false, reachable: new Set(), reachabilityCapped: true };
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/Foo'), site).status, 'refuted');
  });

  void it('sitemap: truncated index + page absent → unverified, NOT a false confirm', () => {
    const site: LiveSite = { sitemapUrls: new Set(['https://e.com/foo']), sitemapCapped: true, reachable: new Set(), reachabilityCapped: true };
    // The page could live in an unread child sitemap → must not assert "absent".
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/other'), site).status, 'unverified');
    // A present page still refutes even when truncated (presence is authoritative).
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/foo'), site).status, 'refuted');
  });

  void it('host case is ignored (URL normalizes host), path case is preserved', () => {
    const site: LiveSite = { sitemapUrls: new Set(['https://e.com/foo']), sitemapCapped: false, reachable: new Set(), reachabilityCapped: true };
    assert.strictEqual(verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://E.com/foo'), site).status, 'refuted');
  });
});

import { duplicateVerdict } from '../lib/phase3/live-verifier';

void describe('live-verifier: duplicateVerdict count-coverage', () => {
  void it('matching values → confirmed regardless of count', () => {
    assert.strictEqual(duplicateVerdict('title', 'Same', 'Same', 2).status, 'confirmed');
    assert.strictEqual(duplicateVerdict('title', 'Same', 'Same', 9).status, 'confirmed');
  });

  void it('count==2: the 2 cited pages ARE the finding → a mismatch refutes (drops)', () => {
    assert.strictEqual(duplicateVerdict('title', 'A', 'B', 2).status, 'refuted');
  });

  void it('count>2: a mismatch is partial evidence → unverified, never dropped', () => {
    assert.strictEqual(duplicateVerdict('description', 'A', 'B', 5).status, 'unverified');
  });

  void it('a missing value → unverified', () => {
    assert.strictEqual(duplicateVerdict('title', null, 'B', 2).status, 'unverified');
  });
});

import { isSuspectedInfinitePagination } from '../lib/analyzers/seo/pagination-analyzer';

void describe('pagination probe: isSuspectedInfinitePagination', () => {
  const base = { clicks: 3, controlPersists: true, urlAdvanced: true, emptyAfterClick: false, contentChanged: true, duplicateStreak: 0 };

  void it('FALSE POSITIVE GUARD: in-page/hash "next" that never advances the URL is never flagged', () => {
    // agntcms /docs case: clicking "next" only changed the hash, content identical.
    assert.strictEqual(isSuspectedInfinitePagination({ ...base, urlAdvanced: false, contentChanged: false, duplicateStreak: 3 }), false);
  });

  void it('healthy pagination (URL advances, content changes) is not flagged', () => {
    assert.strictEqual(isSuspectedInfinitePagination(base), false);
  });

  void it('broken: URL advances but content empties → flagged', () => {
    assert.strictEqual(isSuspectedInfinitePagination({ ...base, emptyAfterClick: true }), true);
  });

  void it('broken: URL advances but content is duplicate (never changes) → flagged', () => {
    assert.strictEqual(isSuspectedInfinitePagination({ ...base, contentChanged: false, duplicateStreak: 3 }), true);
  });

  void it('no clicks or control gone → not flagged', () => {
    assert.strictEqual(isSuspectedInfinitePagination({ ...base, clicks: 0 }), false);
    assert.strictEqual(isSuspectedInfinitePagination({ ...base, controlPersists: false, emptyAfterClick: true }), false);
  });
});

// ============================================================
// Phase 2: issue-aware visual evidence (overlays / CLS pair / SERP)
// ============================================================
import { evidenceKindFor } from '../lib/phase2/phase2-runner';

void describe('phase2: issue-aware visual evidence', () => {
  const OVERLAYS = {
    url: 'https://example.com/about',
    capturedAt: '2026-01-01T00:00:00.000Z',
    viewport: { width: 414, height: 896 },
    document: { width: 414, height: 3000 },
    pageMeta: { title: 'A'.repeat(75), description: 'D'.repeat(140) },
    head: {
      canonical: null as string | null,
      metaRobots: null as string | null,
      htmlLang: 'en',
      charset: 'utf-8',
      hasDoctype: true,
      hreflangs: [] as Array<{ lang: string; href: string }>,
    },
    panels: {
      renderBlocking: [
        { url: 'https://example.com/styles.css', kind: 'style' },
        { url: 'https://cdn.example.net/lib.js', kind: 'script' },
      ],
      coverage: {
        js: {
          total: 890_000,
          unused: 612_000,
          files: [{ url: 'https://example.com/assets/app.js', total: 500_000, unused: 365_000, unusedPercent: 73 }],
        },
      },
    },
    kinds: {
      'missing-alt': [{ selector: 'img.hero', rect: { x: 10, y: 200, width: 300, height: 150 }, label: 'no alt text' }],
    },
    cls: {
      value: 0.34,
      shifts: [
        {
          node: 'DIV',
          selector: 'div.hero',
          previousRect: { x: 0, y: 100, width: 414, height: 200 },
          currentRect: { x: 0, y: 300, width: 414, height: 200 },
        },
      ],
    },
  };

  const REQUESTS = {
    url: 'https://example.com/about',
    requests: {
      'https://example.com/about': { resourceType: 'document', size: 90_000 },
      'https://example.com/app.js': { resourceType: 'script', size: 400_000 },
      'https://tracker.adtech.io/pixel.js': { resourceType: 'script', size: 120_000 },
    },
  };

  /** A real runDir on disk carrying overlays.json + requests.json for the sampled /about page. */
  function mkEvidence(overlayOverrides: Record<string, unknown> = {}): { dir: string; files: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlays-'));
    const pageDir = path.join(dir, 'evidence', 'https_example.com_about');
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'overlays.json'), JSON.stringify({ ...OVERLAYS, ...overlayOverrides }));
    fs.writeFileSync(path.join(pageDir, 'requests.json'), JSON.stringify(REQUESTS));
    return {
      dir,
      files: ['screenshot.mobile.png', 'screenshot.desktop.png', 'screenshot.firstload.png', 'overlays.json', 'requests.json'],
    };
  }

  function evidenceArts(msg: string, ev: { dir: string; files: string[] }): AuditArtifacts {
    const a = mkArtifacts([msg], { [msg]: ['https://example.com/about'] });
    a.runDir = ev.dir;
    a.manifest.evidence = { 'https_example.com_about': { url: 'https://example.com/about', files: ev.files } };
    return a;
  }

  void it('maps finding messages to their evidence kind', () => {
    assert.deepStrictEqual(evidenceKindFor('Some images are missing alt text'), { type: 'overlay', kind: 'missing-alt' });
    // "Image links without alt text" must hit missing-alt, NOT empty-anchor.
    assert.deepStrictEqual(evidenceKindFor('Image links without alt text'), { type: 'overlay', kind: 'missing-alt' });
    assert.deepStrictEqual(evidenceKindFor('Some pages have CLS more than 0.1'), { type: 'cls' });
    assert.deepStrictEqual(evidenceKindFor('Pages have titles that are too long'), { type: 'serp', field: 'title' });
    assert.deepStrictEqual(evidenceKindFor('Links with empty anchor text'), { type: 'overlay', kind: 'empty-anchor' });
    assert.deepStrictEqual(evidenceKindFor('Insufficient color contrast detected'), { type: 'overlay', kind: 'contrast' });
    assert.deepStrictEqual(evidenceKindFor('Canonicals are not set for some pages'), { type: 'head', aspect: 'canonical' });
    assert.deepStrictEqual(evidenceKindFor('Pages in sitemap are marked noindex'), { type: 'head', aspect: 'noindex' });
    // "Render-blocking third-party scripts" must hit the render-blocking panel, not net/origins.
    assert.deepStrictEqual(evidenceKindFor('Render-blocking third-party scripts present'), { type: 'render-blocking' });
    assert.deepStrictEqual(evidenceKindFor('High percentage of unused CSS'), { type: 'coverage', which: 'css' });
    assert.deepStrictEqual(evidenceKindFor('Unused code exceeds 500KB'), { type: 'coverage', which: 'js' });
    assert.deepStrictEqual(evidenceKindFor('Large third-party payload detected'), { type: 'net', mode: 'origins' });
    assert.deepStrictEqual(evidenceKindFor('Some pages have too many requests'), { type: 'net', mode: 'types' });
    assert.deepStrictEqual(evidenceKindFor('Orphan pages detected in the link graph'), { type: 'site-graph' });
    assert.strictEqual(evidenceKindFor('Deprecated HTML elements detected'), null);
  });

  void it('renders a head snippet card with a flagged missing-canonical line', () => {
    const md = buildReportMarkdown(evidenceArts('Canonicals are not set for some pages', mkEvidence()));
    assert.match(md, /code-card/);
    assert.match(md, /line-missing/, 'the absent canonical renders as a flagged missing-comment');
    assert.match(md, /rel="canonical"/);
  });

  void it('skips the head card when the sampled page contradicts a missing-claim (canonical present)', () => {
    const ev = mkEvidence({ head: { ...OVERLAYS.head, canonical: 'https://example.com/about' } });
    const md = buildReportMarkdown(evidenceArts('Canonicals are not set for some pages', ev));
    assert.doesNotMatch(md, /code-card/);
    assert.match(md, /evidence-shots/, 'falls back to the plain screenshot pair');
  });

  void it('renders the network origins panel with third-party rows flagged', () => {
    const md = buildReportMarkdown(evidenceArts('Large third-party payload detected', mkEvidence()));
    assert.match(md, /data-panel/);
    assert.match(md, /tracker\.adtech\.io \(3rd-party\)/);
    assert.match(md, /bar-flag/, 'third-party bars use the flagged color');
    assert.match(md, /third-party: 1 req/);
  });

  void it('renders the by-type network panel for request-count findings', () => {
    const md = buildReportMarkdown(evidenceArts('Some pages have too many requests', mkEvidence()));
    assert.match(md, /data-panel/);
    assert.match(md, /3 requests/);
    assert.match(md, /script/);
  });

  void it('renders coverage bars from the persisted CDP summary', () => {
    const md = buildReportMarkdown(evidenceArts('Unused code exceeds 500KB', mkEvidence()));
    assert.match(md, /Unused JS/);
    assert.match(md, /app\.js/);
    assert.match(md, /\(73%\)/);
  });

  void it('renders the render-blocking resource list with kind chips', () => {
    const md = buildReportMarkdown(evidenceArts('Render-blocking resources exceed the threshold', mkEvidence()));
    assert.match(md, /2 render-blocking resource/);
    assert.match(md, /rb-style/);
    assert.match(md, /rb-script/);
    assert.match(md, /cdn\.example\.net\/lib\.js/);
  });

  void it('renders an annotated screenshot (crop + highlight boxes) for an overlay kind', () => {
    const md = buildReportMarkdown(evidenceArts('Some images are missing alt text', mkEvidence()));
    assert.match(md, /evidence-annotated/);
    assert.match(md, /class="ev-box"/);
    assert.match(md, /no alt text/, 'the per-element label is rendered');
    assert.match(md, /Images without alt text — https:\/\/example\.com\/about/, 'kind caption + page URL');
    assert.match(md, /src="evidence\/https_example\.com_about\/screenshot\.mobile\.png"/);
    assert.doesNotMatch(md, /screenshot\.desktop\.png/, 'annotated view replaces the plain mobile+desktop pair');
  });

  void it('renders the CLS before/after pair with ghost (previous) and solid (current) rects', () => {
    const md = buildReportMarkdown(evidenceArts('Some pages have CLS more than 0.1', mkEvidence()));
    assert.match(md, /evidence-pair/);
    assert.match(md, /screenshot\.firstload\.png/, 'the first-load shot is the "before"');
    assert.match(md, /On load/);
    assert.match(md, /ev-box ev-ghost/, 'previous position rendered as dashed ghost');
    assert.match(md, /CLS 0\.34/);
  });

  void it('renders a SERP preview with the overflow struck out for a too-long title', () => {
    const md = buildReportMarkdown(evidenceArts('Pages have titles that are too long', mkEvidence()));
    assert.match(md, /serp-preview/);
    assert.match(md, /serp-overflow/, 'the part past the truncation limit is marked');
    assert.match(md, /75 characters/);
  });

  void it('skips the SERP card when the sampled value contradicts the claim (falls back to screenshots)', () => {
    // Finding says "too short" but the sampled description is 140 chars (fine) —
    // a misleading card must not render; the plain screenshot pair appears.
    const md = buildReportMarkdown(evidenceArts('Pages have descriptions that are too short', mkEvidence()));
    assert.doesNotMatch(md, /serp-preview/);
    assert.match(md, /evidence-shots/);
  });

  void it('falls back to the plain screenshot pair when overlays.json is absent (older audits)', () => {
    const ev = mkEvidence();
    // Same message, but the evidence dir predates overlays.json.
    const a = evidenceArts('Some images are missing alt text', ev);
    a.manifest.evidence = {
      'https_example.com_about': {
        url: 'https://example.com/about',
        files: ['screenshot.mobile.png', 'screenshot.desktop.png'],
      },
    };
    const md = buildReportMarkdown(a);
    assert.doesNotMatch(md, /evidence-annotated/);
    assert.match(md, /evidence-shots/);
    assert.match(md, /screenshot\.desktop\.png/);
  });

  void it('issue-aware rendering stays deterministic across runs', () => {
    const ev = mkEvidence();
    const one = buildReportMarkdown(evidenceArts('Some images are missing alt text', ev));
    const two = buildReportMarkdown(evidenceArts('Some images are missing alt text', ev));
    assert.strictEqual(one, two);
  });
});

// ============================================================
// Phase 2: slice-3 evidence (LCP, no-JS pair, probe sequence, landmarks,
// security headers, schema card, link-graph facts)
// ============================================================
void describe('phase2: slice-3 evidence', () => {
  const OVERLAYS3 = {
    url: 'https://example.com/about',
    capturedAt: '2026-01-01T00:00:00.000Z',
    viewport: { width: 414, height: 896 },
    document: { width: 414, height: 3000 },
    pageMeta: { title: 'About', description: 'About page' },
    kinds: {
      landmarks: [
        { selector: 'header', rect: { x: 0, y: 0, width: 414, height: 80 }, label: '<header>' },
        { selector: 'footer', rect: { x: 0, y: 2800, width: 414, height: 200 }, label: '<footer>' },
      ],
      'form-label': [{ selector: 'input#q', rect: { x: 20, y: 400, width: 200, height: 40 }, label: 'no label' }],
    },
    lcp: {
      selector: 'img.hero',
      rect: { x: 0, y: 120, width: 414, height: 300 },
      value: 4200,
      subParts: { ttfb: 600, resourceLoad: 1800, resourceDelay: 900, renderDelay: 900 },
    },
    schema: { types: ['Organization', 'WebSite'], snippet: '{"@type":"Organization"}' },
    panels: { securityHeaders: { missing: ['content-security-policy', 'strict-transport-security'] } },
  };

  function mkEvidence3(over: Record<string, unknown> = {}, extraDirs: Record<string, { url: string; files: string[] }> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlays3-'));
    const pageDir = path.join(dir, 'evidence', 'https_example.com_about');
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'overlays.json'), JSON.stringify({ ...OVERLAYS3, ...over }));
    const files = ['screenshot.mobile.png', 'screenshot.firstload.png', 'screenshot.nojs.png', 'overlays.json'];
    return { dir, evidence: { 'https_example.com_about': { url: 'https://example.com/about', files }, ...extraDirs } };
  }

  function arts3(msg: string, ev: { dir: string; evidence: Record<string, { url: string; files: string[] }> }): AuditArtifacts {
    const a = mkArtifacts([msg], { [msg]: ['https://example.com/about'] });
    a.runDir = ev.dir;
    a.manifest.evidence = ev.evidence;
    return a;
  }

  void it('maps slice-3 messages to their evidence kinds', () => {
    assert.deepStrictEqual(evidenceKindFor('Some pages have LCP more than 2500ms'), { type: 'lcp' });
    assert.deepStrictEqual(evidenceKindFor('Significant content rendered by JavaScript'), { type: 'nojs' });
    assert.deepStrictEqual(evidenceKindFor('Broken "next" pagination wastes crawl budget'), { type: 'pagination' });
    assert.deepStrictEqual(evidenceKindFor('Form inputs missing labels'), { type: 'overlay', kind: 'form-label' });
    assert.deepStrictEqual(evidenceKindFor('Form inputs missing autocomplete attribute'), { type: 'overlay', kind: 'autocomplete' });
    assert.deepStrictEqual(evidenceKindFor('Missing <main> element'), { type: 'landmarks' });
    // The mainEntity pitfall: a schema finding must NOT hit the landmarks arm.
    assert.deepStrictEqual(evidenceKindFor('FAQPage missing mainEntity array'), { type: 'schema' });
    assert.deepStrictEqual(evidenceKindFor('Missing security headers detected'), { type: 'sec-headers' });
    // Real analyzer wording is per-header — must hit the same card.
    assert.deepStrictEqual(evidenceKindFor('Missing Permissions-Policy header'), { type: 'sec-headers' });
    assert.deepStrictEqual(evidenceKindFor('Missing cross-origin isolation headers'), { type: 'sec-headers' });
    assert.deepStrictEqual(evidenceKindFor('Orphan page (no internal links point to it)'), { type: 'site-graph' });
    // noindex-in-sitemap must hit the head/noindex arm, not site-graph.
    assert.deepStrictEqual(evidenceKindFor('Pages in sitemap are marked noindex'), { type: 'head', aspect: 'noindex' });
  });

  void it('renders the LCP element highlight + sub-parts breakdown', () => {
    const md = buildReportMarkdown(arts3('Some pages have LCP more than 2500ms', mkEvidence3()));
    assert.match(md, /LCP evidence/);
    assert.match(md, /LCP element — 4\.20s/);
    assert.match(md, /where the time went/);
    assert.match(md, /Resource load/);
  });

  void it('renders the JS-off vs hydrated pair', () => {
    const md = buildReportMarkdown(arts3('Significant content rendered by JavaScript', mkEvidence3()));
    assert.match(md, /screenshot\.nojs\.png/);
    assert.match(md, /JavaScript disabled \(what most crawlers see\)/);
    assert.match(md, /JavaScript enabled/);
  });

  void it('renders the pagination probe sequence from a probe evidence dir (unsampled series page)', () => {
    const probeDir = {
      'https_example.com_blog--pagination-probe': {
        url: 'https://example.com/blog',
        files: ['_meta.json', 'step-0-initial.png', 'step-1-after-first-click.png', 'step-2-after-5-clicks.png'],
      },
    };
    const ev = mkEvidence3({}, probeDir);
    const msg = 'Broken "next" pagination wastes crawl budget';
    const a = mkArtifacts([msg], { [msg]: ['https://example.com/blog'] });
    a.runDir = ev.dir;
    a.manifest.evidence = ev.evidence;
    const md = buildReportMarkdown(a);
    assert.match(md, /pagination probe/);
    assert.match(md, /Page as loaded/);
    assert.match(md, /After clicking “next” once/);
    assert.match(md, /After 5 clicks — “next” still enabled/);
    assert.match(md, /step-2-after-5-clicks\.png/);
  });

  void it('renders the landmark overlay when <main> is absent, skips when present', () => {
    const md = buildReportMarkdown(arts3('Missing <main> element', mkEvidence3()));
    assert.match(md, /Landmarks present — no &lt;main&gt;/);
    const withMain = mkEvidence3({
      kinds: { landmarks: [{ selector: 'main', rect: { x: 0, y: 100, width: 414, height: 2000 }, label: '<main>' }] },
    });
    const md2 = buildReportMarkdown(arts3('Missing <main> element', withMain));
    assert.doesNotMatch(md2, /Landmarks present/);
  });

  void it('renders the security-headers card from the persisted missing list', () => {
    const md = buildReportMarkdown(arts3('Missing security headers detected', mkEvidence3()));
    assert.match(md, /2 security header\(s\) missing/);
    assert.match(md, /content-security-policy/);
    assert.match(md, /hdr-miss/);
  });

  void it('renders the schema card with type chips; skips a missing-claim when types exist', () => {
    const md = buildReportMarkdown(arts3('Product schema incomplete: missing offers', mkEvidence3()));
    assert.match(md, /Structured data/);
    assert.match(md, /Organization/);
    assert.match(md, /chip/);
    const md2 = buildReportMarkdown(arts3('Pages missing schema markup', mkEvidence3()));
    assert.doesNotMatch(md2, /Structured data\*\*/, 'missing-claim contradicted by present types — card skipped');
  });

  void it('renders link-graph facts for an orphan ABSENT from the incoming-links map (crawled, zero inbound)', () => {
    // incoming-links.json only contains pages that received links — a true
    // orphan is missing from it entirely. The crawled set (processedPages)
    // must resolve that absence to "0 inbound links", not skip the row.
    const ev = mkEvidence3();
    fs.writeFileSync(path.join(ev.dir, 'incoming-links.json'), JSON.stringify({ 'https://example.com/': ['https://example.com/blog'] }));
    fs.writeFileSync(path.join(ev.dir, 'metadata.json'), JSON.stringify({ sitemaps: { urls: { 'https://example.com/': {} } } }));
    const msg = 'Orphan page (no internal links point to it)';
    const a = mkArtifacts([msg], { [msg]: ['https://example.com/about'] });
    a.runDir = ev.dir;
    a.manifest.evidence = ev.evidence;
    a.manifest.progress.processedPages = ['https://example.com/', 'https://example.com/about'];
    const md = buildReportMarkdown(a);
    assert.match(md, /Link-graph facts/);
    assert.match(md, /0 inbound links/);
    assert.match(md, /not in sitemap ✗/);
  });

  void it('renders link-graph facts for orphan findings from incoming-links + sitemap artifacts', () => {
    const ev = mkEvidence3();
    fs.writeFileSync(path.join(ev.dir, 'incoming-links.json'), JSON.stringify({ 'https://example.com/about': [] }));
    fs.writeFileSync(path.join(ev.dir, 'metadata.json'), JSON.stringify({ sitemaps: { urls: { 'https://example.com/': {} } } }));
    const md = buildReportMarkdown(arts3('Orphan page (no internal links point to it)', ev));
    assert.match(md, /Link-graph facts/);
    assert.match(md, /0 inbound links/);
    assert.match(md, /not in sitemap ✗/);
  });
});
