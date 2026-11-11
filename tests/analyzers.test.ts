import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computePageCounts } from '../lib/utils/page-counts';
import { handlePageError, reconcileRetrySuccess } from '../lib/crawler/resilience';
import type { CrawlResults } from '../lib/crawler/crawler-types';
import { renderPageCountStats } from '../generateHTML';

import { ResponseHeaderAnalyzer } from '../lib/analyzers/seo/response-header-analyzer';
import {
  LanguageDetectionAnalyzer,
  LANGUAGE_PROFILES,
  LANGUAGE_DETECTION_MIN_TEXT_LENGTH,
  scoreProfile,
} from '../lib/analyzers/content/language-detection-analyzer';
import { parse } from 'node-html-parser';
import { calculateChartData } from '../lib/reports/sections/scripts';
import { getNewInsightCells } from '../lib/reports/sections/pages-table';
import { extractPageInsights } from '../lib/reports/data-processor';
import { generatePagesCSV } from '../generateCSV';
import { ContentSimilarityAnalyzer } from '../lib/analyzers/site-wide/content-similarity-analyzer';
import { KeywordCannibalisationAnalyzer } from '../lib/analyzers/site-wide/keyword-cannibalisation-analyzer';
import { InternalPageRankAnalyzer } from '../lib/analyzers/site-wide/internal-pagerank-analyzer';
import { CodeCoverageAnalyzer } from '../lib/analyzers/performance/code-coverage-analyzer';
import { FontLoadingAnalyzer } from '../lib/analyzers/performance/font-loading-analyzer';
import { CTADetectorAnalyzer } from '../lib/analyzers/content/cta-detector-analyzer';
import { OutboundLinkChecker } from '../lib/analyzers/content/outbound-link-checker';
import { BrokenPaginationAnalyzer } from '../lib/analyzers/site-wide/broken-pagination-analyzer';
import { Soft404Analyzer } from '../lib/analyzers/seo/soft-404-analyzer';
import { PaginationAnalyzer } from '../lib/analyzers/seo/pagination-analyzer';
import { ScoreCalculator } from '../lib/scoring/score-calculator';
import { scoredCategoryOf, buildScoreImpact, sectionScoreSuffix } from '../lib/phase2/score-impact';
import { DEFAULT_CONFIG } from '../lib/config-loader';
import { METRIC_INFO, SIGNAL_CATEGORIES } from '../lib/reports/metrics-metadata';
import { getJsonSummary } from '../lib/utils/cli-summary';
import { HistoryManager } from '../historyManager';
import { getContentInsights } from '../lib/reports/sections/content-insights';
import type { PageInfo } from '../lib/types';
import { isFetchAllowed, isPrivateOrInternalHost } from '../validators';
import { getPaginationSeriesKey, normalizeUrlForComparison } from '../lib/utils';
import { computeTotalPagesProcessed } from '../lib/orchestrators/audit-orchestrator';
import { previousScoreFrom } from '../robots';
import { collectLinks } from '../lib/crawler/page-data-builder';
import { parse as parseHtml } from 'node-html-parser';
import { recordPaginationNotFound, worstPaginationStreak } from '../lib/crawler/resilience';
import type { FailureTracker } from '../lib/crawler/crawler-types';
import { SitemapParser } from '../lib/parsers/sitemap-parser';

// ============================================================
// Broken-pagination abort scoping (crawler-engine consecutive-404 streak)
// ============================================================
// The crawler aborts on N consecutive not-found responses as a broken-pagination
// fast-fail. That streak is scoped to pagination-series URLs only: a run of dead
// one-off URLs (e.g. stale sitemap entries) is a finite, known set that must be
// crawled and reported, never used to abort. getPaginationSeriesKey is the exact
// classifier the abort uses, so guarding it guards the regression.
const THRESHOLD = 10; // CRAWL_SETTINGS.CONSECUTIVE_404_THRESHOLD

function mkTracker(): FailureTracker {
  return {
    consecutiveFailures: 0,
    lastFailureTime: 0,
    circuitOpen: false,
    circuitOpenTime: 0,
    paginationNotFoundStreak: new Map<string, number>(),
  };
}

void describe('broken-pagination abort scoping', () => {
  void it('does NOT classify one-off content URLs as a pagination series', () => {
    // The plentific regression: 10 dead /resource-center/blog/* sitemap URLs in
    // a row tripped the abort and stopped the crawl after 10 of 551 URLs.
    const oneOffUrls = [
      'https://www.plentific.com/resource-center/blog/plentific-welcomes-kaifu-nordland/',
      'https://www.plentific.com/resource-center/blog/vnw-managementforum-2025/',
      'https://example.com/about',
      'https://example.com/products/widget-3000',
      'https://example.com/2024/05/some-post',
    ];
    for (const url of oneOffUrls) {
      assert.strictEqual(
        getPaginationSeriesKey(url),
        null,
        `${url} must not count toward the broken-pagination streak`,
      );
    }
  });

  void it('DOES classify genuine pagination URLs as a series', () => {
    assert.strictEqual(getPaginationSeriesKey('https://e.com/insights/page/7'), 'https://e.com/insights/page/{N}');
    assert.strictEqual(
      getPaginationSeriesKey('https://e.com/list?page=5&sort=asc'),
      'https://e.com/list?page={N}&sort=asc',
    );
    // Pages in the same series share a key so the streak accumulates across them.
    assert.strictEqual(
      getPaginationSeriesKey('https://e.com/blog/page/9998'),
      getPaginationSeriesKey('https://e.com/blog/page/9999'),
    );
  });

  void it('never accumulates a streak for dead one-off URLs (the plentific regression)', () => {
    const t = mkTracker();
    // 50 dead one-off blog URLs in a row — far past the threshold.
    for (let i = 0; i < 50; i++) {
      recordPaginationNotFound(t, `https://www.plentific.com/resource-center/blog/post-${i}/`, true);
    }
    assert.strictEqual(worstPaginationStreak(t).count, 0, 'one-off dead URLs must never trip the abort');
  });

  void it('accumulates within a single broken series and trips the threshold', () => {
    const t = mkTracker();
    for (let n = 1; n <= THRESHOLD; n++) {
      recordPaginationNotFound(t, `https://e.com/blog/page/${n}`, true);
    }
    const worst = worstPaginationStreak(t);
    assert.strictEqual(worst.count, THRESHOLD);
    assert.strictEqual(worst.series, 'https://e.com/blog/page/{N}');
    assert.ok(worst.count >= THRESHOLD, 'a genuinely runaway series must still abort');
  });

  void it('does NOT aggregate trailing 404s across independent series', () => {
    // Many independently-paginated sections, each ending with ONE trailing 404
    // (the natural one-past-the-end). The old global counter would sum these to
    // THRESHOLD and false-abort; per-series tracking keeps each at 1.
    const t = mkTracker();
    for (let s = 0; s < THRESHOLD + 5; s++) {
      recordPaginationNotFound(t, `https://e.com/section-${s}/page/2`, false); // a real page
      recordPaginationNotFound(t, `https://e.com/section-${s}/page/3`, true); // one trailing 404
    }
    assert.strictEqual(worstPaginationStreak(t).count, 1, 'one trailing 404 per series must never aggregate');
  });

  void it('a real (non-404) page resets its own series streak', () => {
    const t = mkTracker();
    for (let n = 1; n <= 5; n++) recordPaginationNotFound(t, `https://e.com/blog/page/${n}`, true);
    assert.strictEqual(worstPaginationStreak(t).count, 5);
    recordPaginationNotFound(t, 'https://e.com/blog/page/6', false); // a real page mid-series
    assert.strictEqual(worstPaginationStreak(t).count, 0, 'a live page ends the broken-pagination streak');
  });
});

// ============================================================
// SSRF guard (validators.isFetchAllowed / isPrivateOrInternalHost)
// ============================================================
void describe('SSRF guard', () => {
  void it('flags private/internal/loopback hosts in every IPv4 encoding', () => {
    const privateHosts = [
      'localhost',
      'foo.localhost',
      'router.local',
      'svc.internal',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '2130706433', // decimal 127.0.0.1
      '0x7f000001', // hex 127.0.0.1
      '0177.0.0.1', // octal-first-octet 127.0.0.1
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
    ];
    for (const h of privateHosts) {
      assert.strictEqual(isPrivateOrInternalHost(h), true, `${h} should be private`);
    }
  });

  void it('allows ordinary public hosts', () => {
    for (const h of ['example.com', 'sub.example.co.uk', '8.8.8.8', '93.184.216.34']) {
      assert.strictEqual(isPrivateOrInternalHost(h), false, `${h} should be public`);
    }
  });

  void it('blocks private/non-http URLs but allows public http(s)', () => {
    assert.strictEqual(isFetchAllowed('https://example.com/sitemap.xml').allowed, true);
    assert.strictEqual(isFetchAllowed('http://169.254.169.254/latest/meta-data/').allowed, false);
    assert.strictEqual(isFetchAllowed('file:///etc/passwd').allowed, false);
    assert.strictEqual(isFetchAllowed('ftp://example.com/x').allowed, false);
    assert.strictEqual(isFetchAllowed('not a url').allowed, false);
  });

  void it('allows a private target only when it matches the audit origin host', () => {
    assert.strictEqual(isFetchAllowed('http://localhost:3000/page', { originHost: 'localhost' }).allowed, true);
    assert.strictEqual(isFetchAllowed('http://127.0.0.1/page', { originHost: 'localhost' }).allowed, false);
  });

  void it('honours SEO_AUDIT_ALLOW_PRIVATE=1 escape hatch', () => {
    const prev = process.env.SEO_AUDIT_ALLOW_PRIVATE;
    process.env.SEO_AUDIT_ALLOW_PRIVATE = '1';
    try {
      assert.strictEqual(isFetchAllowed('http://10.0.0.1/x').allowed, true);
    } finally {
      if (prev === undefined) delete process.env.SEO_AUDIT_ALLOW_PRIVATE;
      else process.env.SEO_AUDIT_ALLOW_PRIVATE = prev;
    }
  });
});

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

  const runLang = (text: string) =>
    LanguageDetectionAnalyzer.analyzeLanguage(
      { evaluate: async () => text } as unknown as Parameters<typeof LanguageDetectionAnalyzer.analyzeLanguage>[0],
      parse('<html lang="en"><body></body></html>') as unknown as Parameters<
        typeof LanguageDetectionAnalyzer.analyzeLanguage
      >[1],
      'https://example.com/',
      {} as PageInfo,
    );
  const ENGLISH =
    'The company has been working with the team on the development of the new product for the market. ' +
    'It is important that the information and the documentation are there for the customers, and that the ' +
    'support of the platform is with them throughout the process of integration and the operation of the service.';
  const FRENCH =
    'Les entreprises de la région sont les premières à proposer des solutions pour les clients et pour le ' +
    'développement de la communauté. Nous avons une équipe qui travaille dans le respect des valeurs de la ' +
    'société et des partenaires, avec une attention particulière pour la qualité des services et des produits.';

  void it('analyzeLanguage: profiles have only 3-char trigrams', () => {
    for (const [lang, profile] of Object.entries(LANGUAGE_PROFILES)) {
      assert.ok(profile.length >= 10, `${lang} has only ${profile.length} trigrams`);
      for (const tri of profile) assert.strictEqual([...tri].length, 3, `${lang}: ${tri}`);
      assert.strictEqual(new Set(profile).size, profile.length, `${lang} has duplicates`);
    }
  });

  void it('analyzeLanguage: Japanese text with kanji is detected as ja, not zh', async () => {
    const JAPANESE =
      '私たちの会社では、新しい製品の開発について説明しています。このサービスは日本の企業のために作られたもので、' +
      'お客様が安心して利用できるようにしています。詳しい情報については、こちらのページをご覧ください。' +
      '私たちは品質を大切にしており、すべての製品は厳しい検査を受けています。ご質問がありましたら、お気軽にお問い合わせください。' +
      'また、今後もより良いサービスを提供するために努力してまいります。どうぞよろしくお願いいたします。' +
      '当社の製品は多くの国で使われており、世界中のお客様から高い評価をいただいています。これからも新しい技術を取り入れながら、' +
      'より便利なサービスを作っていきたいと考えています。ご意見やご要望がございましたら、ぜひお聞かせください。';
    const res = await runLang(JAPANESE);
    assert.strictEqual(res.info.detectedLanguage, 'ja');
  });

  void it('analyzeLanguage: score normalised by profile size', () => {
    const textProfile = LANGUAGE_PROFILES.en;
    for (const profile of Object.values(LANGUAGE_PROFILES)) {
      const score = scoreProfile(textProfile, profile);
      assert.ok(score >= 0 && score <= 1, `score ${score}`);
    }
    assert.strictEqual(scoreProfile(textProfile, LANGUAGE_PROFILES.en), 0);
  });

  void it('analyzeLanguage: min text length', async () => {
    const short = await runLang(ENGLISH.padEnd(LANGUAGE_DETECTION_MIN_TEXT_LENGTH, ' x').slice(0, LANGUAGE_DETECTION_MIN_TEXT_LENGTH - 1));
    assert.strictEqual(short.info.detectedLanguage, null);
    const long = await runLang(ENGLISH);
    assert.strictEqual(long.info.detectedLanguage, 'en');
    assert.strictEqual(long.info.match, true);
  });

  void it('analyzeLanguage: null on low confidence', async () => {
    const mixed = 'xq zv kw '.repeat(30);
    const result = await runLang(mixed);
    assert.strictEqual(result.info.detectedLanguage, null);
    assert.strictEqual(result.info.match, null);
    assert.ok(result.info.detectedConfidence <= 0.5);
    assert.strictEqual(result.issues.length, 0);
  });

  void it('analyzeLanguage: confident French', async () => {
    const result = await runLang(FRENCH);
    assert.strictEqual(result.info.detectedLanguage, 'fr');
    assert.strictEqual(result.info.match, false);
    assert.strictEqual(result.issues.length, 1);
  });

  void it('analyzeLanguage: site-wide excludes undetermined pages', () => {
    const ld = (detectedLanguage: string | null, detectedConfidence: number, match: boolean | null) => ({
      languageDetection: { detectedLanguage, detectedConfidence, match, htmlLang: 'en' },
    });
    const pages = {
      a: { url: 'a', ...ld('en', 0.9, true) },
      b: { url: 'b', ...ld('it', 0.3, false) },
      c: { url: 'c', ...ld(null, 0.2, null) },
      d: { url: 'd', ...ld('fr', 0.8, false) },
    } as unknown as Record<string, PageInfo>;
    const result = LanguageDetectionAnalyzer.analyzeSiteWide(pages);
    assert.deepStrictEqual(result.detectedLanguages, { en: 1, fr: 1 });
    assert.strictEqual(result.undetermined, 2);
    assert.strictEqual(result.issues.length, 1);
  });

  void it('analyzeLanguage: focusreactive single-language en', async () => {
    const FOCUSREACTIVE =
      'We help companies build fast websites with headless CMS and modern frameworks. Our team works with ' +
      'the leading platforms and delivers projects that improve performance, search visibility and the ' +
      'experience of the people who use them. Talk to our experts about your next project and the results it can bring.';
    const analyze = (html: string, headers: Record<string, string>) =>
      LanguageDetectionAnalyzer.analyzeLanguage(
        { evaluate: async () => FOCUSREACTIVE } as unknown as Parameters<typeof LanguageDetectionAnalyzer.analyzeLanguage>[0],
        parse(html) as unknown as Parameters<typeof LanguageDetectionAnalyzer.analyzeLanguage>[1],
        'https://focusreactive.com/',
        { responseHeaders: headers } as unknown as PageInfo,
      );

    for (const result of [
      await analyze('<html lang="en"><body></body></html>', {}),
      await analyze('<html><body></body></html>', { 'content-language': 'en' }),
    ]) {
      assert.strictEqual(result.info.detectedLanguage, 'en');
      assert.strictEqual(result.info.declaredLanguage, 'en');
      assert.strictEqual(result.info.match, true);
      assert.ok(!result.issues.some((i) => /does not match/.test(i.message ?? '')));
    }

    const site = LanguageDetectionAnalyzer.analyzeSiteWide({
      'https://focusreactive.com/': {
        url: 'https://focusreactive.com/',
        languageDetection: (await analyze('<html lang="en"><body></body></html>', {})).info,
      },
    } as unknown as Record<string, PageInfo>);
    assert.deepStrictEqual(site.detectedLanguages, { en: 1 });
    assert.strictEqual(site.issues.length, 0);
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

  void it('extractKeywords rejects boundary-stopword and brand-trailing phrases', () => {
    // Regression: 3-word phrases were emitted with no stopword check ("visual
    // editing and"), and the "… | Brand" title suffix spawned brand-trailing
    // phrases ("case study focusreactive"). Both are junk n-grams, not keywords.
    const brand = new Set(['focusreactive']);
    const kws = KeywordCannibalisationAnalyzer.extractKeywords(
      'Arrive case study | FocusReactive visual editing and more',
      brand,
    );
    for (const k of kws) {
      const words = k.split(' ');
      assert.ok(!KeywordCannibalisationAnalyzer.isStopword(words[0]), `phrase starts with stopword: "${k}"`);
      assert.ok(
        !KeywordCannibalisationAnalyzer.isStopword(words[words.length - 1]),
        `phrase ends with stopword: "${k}"`,
      );
      assert.ok(!k.includes('focusreactive'), `brand token leaked into keyword: "${k}"`);
    }
    // Sanity: a legitimate phrase still survives.
    assert.ok(kws.includes('case study'), `expected "case study" in ${JSON.stringify(kws)}`);
  });

  void it('excludes redirect sources (trailing-slash twins) from near-duplicate detection', () => {
    const kw = [
      { word: 'seo', density: 3 },
      { word: 'audit', density: 2.5 },
      { word: 'tool', density: 2 },
      { word: 'website', density: 1.5 },
      { word: 'performance', density: 1 },
    ];
    const allPages = {
      'https://example.com/x/': { contentQuality: { wordCount: 500, topKeywords: kw } },
      // The no-slash twin redirected to /x/ and carries the same content — must
      // not register as a 100%-identical near-duplicate of /x/.
      'https://example.com/x': { hasRedirects: true, contentQuality: { wordCount: 500, topKeywords: kw } },
    };
    ContentSimilarityAnalyzer.analyze(allPages as unknown as Record<string, PageInfo>);
    const slash = allPages['https://example.com/x/'] as Record<string, unknown>;
    const sim = slash.contentSimilarity as { similarPages?: unknown[] } | undefined;
    assert.strictEqual(sim?.similarPages?.length ?? 0, 0);
  });
});

// ============================================================
// Redirect-source exclusion across site-wide validators (trailing-slash twins)
// ============================================================
import { DuplicateChecker } from '../lib/analyzers/site-wide/duplicate-checker';
import { IndexabilityValidator } from '../lib/analyzers/site-wide/indexability-validator';

void describe('redirect-source exclusion (trailing-slash twin inflation)', () => {
  void it('DuplicateChecker ignores a redirect source sharing the destination title', () => {
    const out = DuplicateChecker.checkDuplicates({
      'https://e.com/x/': { title: 'Shared Title', description: 'Shared description text' },
      // /x → /x/ redirect: holds the destination's title, must not count as a duplicate.
      'https://e.com/x': { title: 'Shared Title', description: 'Shared description text', hasRedirects: true },
    } as unknown as Record<string, PageInfo>);
    assert.strictEqual(out.duplicateTitles.size, 0, 'twin must not register a duplicate title');
    assert.strictEqual(out.duplicateDescriptions.size, 0, 'twin must not register a duplicate description');
  });

  void it('DuplicateChecker reframes same-page parameterized variants (faceted nav), not "duplicate titles"', () => {
    // /insights/page/2 and /insights/page/2?postType=case-study are ONE page
    // viewed through a query-string filter — they share a title by design. The
    // remedy is canonicalize/noindex, not a unique title, so the finding must be
    // the parameterized variant, NOT the cross-page "Duplicate page titles found".
    const out = DuplicateChecker.checkDuplicates({
      'https://e.com/insights/page/2': { title: 'Insights | Page 2', description: 'Insights page 2 description here' },
      'https://e.com/insights/page/2?postType=case-study': {
        title: 'Insights | Page 2',
        description: 'Insights page 2 description here',
      },
    } as unknown as Record<string, PageInfo>);
    const msgs = out.issues.map((i) => i.message);
    assert.ok(msgs.includes('Parameterized URLs share a title'), 'should emit the parameterized-title finding');
    assert.ok(
      msgs.includes('Parameterized URLs share a description'),
      'should emit the parameterized-description finding',
    );
    assert.ok(
      !msgs.includes('Duplicate page titles found'),
      'must NOT emit the cross-page duplicate-title finding for same-path variants',
    );
    assert.ok(
      !msgs.includes('Duplicate meta descriptions found'),
      'must NOT emit the cross-page duplicate-description finding for same-path variants',
    );
  });

  void it('DuplicateChecker still flags genuine cross-page duplicate titles (distinct paths)', () => {
    const out = DuplicateChecker.checkDuplicates({
      'https://e.com/a': { title: 'Shared Title' },
      'https://e.com/b': { title: 'Shared Title' },
    } as unknown as Record<string, PageInfo>);
    const msgs = out.issues.map((i) => i.message);
    assert.ok(msgs.includes('Duplicate page titles found'), 'distinct paths sharing a title remain a cross-page dup');
    assert.ok(!msgs.includes('Parameterized URLs share a title'), 'distinct paths are not parameterized variants');
  });

  void it('DuplicateChecker emits BOTH findings for a mixed group (distinct paths + param variants)', () => {
    const out = DuplicateChecker.checkDuplicates({
      'https://e.com/a': { title: 'Shared Title' },
      'https://e.com/a?sort=asc': { title: 'Shared Title' },
      'https://e.com/b': { title: 'Shared Title' },
    } as unknown as Record<string, PageInfo>);
    const msgs = out.issues.map((i) => i.message);
    assert.ok(msgs.includes('Duplicate page titles found'), '/a vs /b is a genuine cross-page duplicate');
    assert.ok(msgs.includes('Parameterized URLs share a title'), '/a vs /a?sort=asc is a parameterized variant');
  });

  void it('IndexabilityValidator does not flag a redirect source as missing from sitemap', () => {
    const out = IndexabilityValidator.validateIndexabilityCrawlability(
      {
        'https://e.com/new/': { indexability: { isIndexable: true } },
        // /old redirects to /new/ (in sitemap) but /old itself is not — without the
        // skip it would be counted as an indexable page missing from the sitemap.
        'https://e.com/old': { indexability: { isIndexable: true }, hasRedirects: true },
      } as unknown as Record<string, PageInfo>,
      { 'https://e.com/new/': true },
    );
    assert.ok(
      !out.issues.some((i) => /missing from sitemap/i.test(i.message ?? '')),
      'redirect source must not inflate the missing-from-sitemap count',
    );
  });
});

// ============================================================
// Crawl-frontier trailing-slash dedup (collectLinks)
// ============================================================
// A page whose sitemap loc is `https://site` (slash-less) and whose in-page
// link is `/` (normalised to `https://site/`) — or `/foo` vs `/foo/` — is ONE
// resource. The crawl frontier must dedup on the canonical key
// (normalizeUrlForComparison) so the page is crawled once; otherwise every
// per-page finding double-counts and the homepage is reported as cannibalising
// itself. We exercise collectLinks directly with addMissing=false (pass 1,
// where discovered-not-in-sitemap URLs are collected for the second pass).
void describe('crawl-frontier trailing-slash dedup (collectLinks)', () => {
  function runCollect(linkHrefs: string[], seedFrontierKeys: string[]) {
    const html = `<html><body>${linkHrefs.map((h) => `<a href="${h}">link</a>`).join('')}</body></html>`;
    const collectedURLs = new Set<string>();
    const uniquePages = new Set<string>();
    const crawlFrontierKeys = new Set<string>(seedFrontierKeys);
    collectLinks(
      {
        parsedPage: parseHtml(html) as never,
        url: 'https://site.com/some-page',
        results: { pageData: {} } as never,
        incomingLinksTracking: new Map(),
        collectedURLs,
        uniquePages,
        crawlFrontierKeys,
        pagesToCrawl: [],
        addMissing: false,
        discoveredLinksSource: new Map(),
        sitemapUrls: {},
        paginationSeriesCounts: new Map(),
      },
      'https://site.com',
      {},
      () => {},
    );
    return collectedURLs;
  }

  void it('does not collect the root link `/` when the bare origin is already in the frontier', () => {
    // Sitemap listed `https://site.com` (slash-less). Seed its canonical key.
    const collected = runCollect(['/'], [normalizeUrlForComparison('https://site.com')]);
    assert.strictEqual(collected.size, 0, 'root-slash twin of the bare origin must not be crawled again');
  });

  void it('does not collect `/foo` when `/foo/` is already in the frontier (and vice-versa)', () => {
    const a = runCollect(['/foo'], [normalizeUrlForComparison('https://site.com/foo/')]);
    assert.strictEqual(a.size, 0, '/foo must dedup against an already-known /foo/');
    const b = runCollect(['/foo/'], [normalizeUrlForComparison('https://site.com/foo')]);
    assert.strictEqual(b.size, 0, '/foo/ must dedup against an already-known /foo');
  });

  void it('still collects a genuinely new page absent from the frontier', () => {
    const collected = runCollect(['/brand-new'], [normalizeUrlForComparison('https://site.com')]);
    assert.deepStrictEqual([...collected], ['https://site.com/brand-new'], 'new pages are still discovered');
  });

  void it('collects two distinct trailing-slash variants only once between them', () => {
    // Both `/dup` and `/dup/` appear on the page, neither pre-seeded. The first
    // wins; the second collapses onto its canonical key.
    const collected = runCollect(['/dup', '/dup/'], []);
    assert.strictEqual(collected.size, 1, 'the two trailing-slash variants collapse to a single crawl');
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
    // A page at each metric's p10 should score ~90. The composite scores TBT
    // (lab-measurable), not INP — a non-interacting crawler records INP as 0ms,
    // which would otherwise score as perfect and inflate the result.
    const fastPages = { 'https://example.com/': { LCP: 1220, TBT: 150, CLS: 0.025, FCP: 934, TTFB: 200 } };
    const slowPages = { 'https://example.com/': { LCP: 4000, TBT: 800, CLS: 0.25, FCP: 3000, TTFB: 1800 } };
    const empty = { bySeverity: { critical: [], high: [], medium: [], low: [] }, details: {} };

    const fast = ScoreCalculator.calculateCategoryScores(empty, fastPages as unknown as Record<string, PageInfo>);
    const slow = ScoreCalculator.calculateCategoryScores(empty, slowPages as unknown as Record<string, PageInfo>);
    assert.ok(fast.performance > 80, `Expected fast performance > 80, got ${fast.performance}`);
    assert.ok(slow.performance < 30, `Expected slow performance < 30, got ${slow.performance}`);
  });

  void it('Performance score is not inflated by crawler INP=0; heavy TBT pulls it down', () => {
    // Regression: the composite weighted INP at 30%, but a non-interacting
    // crawler records INP=0ms (a perfect log-normal score), so a page with fast
    // paint scored ~100 even with severe main-thread blocking. The composite now
    // scores TBT instead. A page with great LCP/CLS/FCP/TTFB but a 1200ms TBT
    // must reflect that blocking, not ignore it.
    const heavyTbt = {
      'https://example.com/': { LCP: 500, INP: 0, CLS: 0.01, FCP: 500, TTFB: 60, TBT: 1200 },
    };
    const scores = ScoreCalculator.calculateCategoryScores(
      { bySeverity: { critical: [], high: [], medium: [], low: [] }, details: {} },
      heavyTbt as unknown as Record<string, PageInfo>,
    );
    assert.ok(
      scores.performance < 80,
      `Expected heavy-TBT performance < 80 (was ~100 with the INP=0 bug), got ${scores.performance}`,
    );
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
          'https://example.com/': { languageDetection: { match: false, detectedConfidence: 0.8 } },
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
            languageDetection: { match: false, detectedConfidence: 0.8 },
            outboundLinkHealth: { broken: [{ url: 'http://dead.link' }] },
            codeCoverage: { js: { ratio: 45 }, css: { ratio: 30 } },
            contentSimilarity: { similarPages: ['https://example.com/b'] },
            ctaData: { summary: { total: 0 } },
          },
          'https://example.com/b': {
            languageDetection: { match: true, detectedConfidence: 0.8 },
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
import { populateIncomingLinksCount, checkAlternateDuplicates } from '../lib/crawler/page-data-builder';

void describe('FontLoadingAnalyzer.analyzeFontRequests', () => {
  void it('excludes failed (4xx/5xx) font requests from payload, count, and formats', () => {
    // Regression: a 404 @font-face used to count toward the font payload, so a
    // page with broken fonts got both a "fonts return 404" finding and a "large
    // web font payload" finding counting those same missing files.
    const requests = {
      'https://e.com/Inter-Regular.woff2': { resourceType: 'font', status: 200, size: 120_000 },
      'https://e.com/InterDisplay-Bold.woff2': { resourceType: 'font', status: 404, size: 600 },
      'https://e.com/Legacy.woff': { resourceType: 'font', status: 500, size: 90_000 },
    };
    const { fonts, totalSize } = FontLoadingAnalyzer.analyzeFontRequests(
      requests as unknown as Parameters<typeof FontLoadingAnalyzer.analyzeFontRequests>[0],
    );
    assert.strictEqual(fonts.length, 1, 'only the 200 font counts');
    assert.strictEqual(totalSize, 120_000, 'payload excludes the 404/500 fonts');
    assert.strictEqual(fonts[0].format, 'woff2');
  });

  void it('counts fonts with no status (cached / not recorded) as loaded', () => {
    const requests = { 'https://e.com/a.woff2': { resourceType: 'font', size: 50_000 } };
    const { fonts, totalSize } = FontLoadingAnalyzer.analyzeFontRequests(
      requests as unknown as Parameters<typeof FontLoadingAnalyzer.analyzeFontRequests>[0],
    );
    assert.strictEqual(fonts.length, 1);
    assert.strictEqual(totalSize, 50_000);
  });
});

void describe('checkAlternateDuplicates', () => {
  const collect = (alternates: { href: string }[]) => {
    const issues: { message: string; detail: string }[] = [];
    checkAlternateDuplicates(
      alternates as Parameters<typeof checkAlternateDuplicates>[0],
      'https://example.com/page',
      (message, detail) => issues.push({ message, detail }),
    );
    return issues;
  };

  void it('reports a duplicated alternate ONCE, not once per occurrence', () => {
    // Regression: the old loop emitted on every occurrence, so [A, A] reported
    // the same page twice identically in the report.
    const issues = collect([{ href: 'https://example.com/page' }, { href: 'https://example.com/page' }]);
    assert.strictEqual(issues.length, 1, `expected one finding, got ${issues.length}`);
    assert.match(issues[0].detail, /https:\/\/example\.com\/page is duplicated/);
  });

  void it('reports each distinct duplicated href once; ignores non-duplicates', () => {
    const issues = collect([
      { href: 'https://example.com/a' },
      { href: 'https://example.com/a' },
      { href: 'https://example.com/b' }, // unique → not flagged
      { href: 'https://example.com/c' },
      { href: 'https://example.com/c' },
    ]);
    assert.strictEqual(issues.length, 2);
  });

  void it('reports nothing when all alternates are unique', () => {
    assert.strictEqual(collect([{ href: 'https://example.com/a' }, { href: 'https://example.com/b' }]).length, 0);
  });
});

void describe('populateIncomingLinksCount', () => {
  const build = (pageUrls: string[]) => Object.fromEntries(pageUrls.map((u) => [u, { url: u } as PageInfo]));

  void it('counts incoming links when page URL matches the map key exactly', () => {
    const pages = build(['https://x.com/docs/install']);
    populateIncomingLinksCount(pages, {
      'https://x.com/docs/install': ['https://x.com/a', 'https://x.com/b'],
    });
    assert.strictEqual(pages['https://x.com/docs/install'].incomingLinksCount, 2);
    assert.strictEqual(pages['https://x.com/docs/install'].hasIncomingLinks, true);
  });

  void it('resolves the bare-origin page against the normalized (trailing-slash) map key', () => {
    // The map is keyed by normalizeUrl(href); a link to "/" becomes
    // "https://x.com/", but the page may be crawled as the bare origin.
    const pages = build(['https://x.com']);
    populateIncomingLinksCount(pages, {
      'https://x.com/': ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
    });
    assert.strictEqual(pages['https://x.com'].incomingLinksCount, 3);
    assert.strictEqual(pages['https://x.com'].hasIncomingLinks, true);
  });

  void it('marks pages with no incoming links as orphaned (count 0)', () => {
    const pages = build(['https://x.com/orphan']);
    populateIncomingLinksCount(pages, {
      'https://x.com/other': ['https://x.com/a'],
    });
    assert.strictEqual(pages['https://x.com/orphan'].incomingLinksCount, 0);
    assert.strictEqual(pages['https://x.com/orphan'].hasIncomingLinks, false);
  });

  void it('resolves a page URL against a map key that only differs by a trailing slash (PR #6-style review)', () => {
    // Real-world case: a site's <a href> points to "/en/about" (no trailing
    // slash) while the crawled/canonical page URL is "/en/about/" (with one)
    // — normalizeUrl's WHATWG URL.href normalisation adds a trailing slash to
    // a bare origin but does not add or strip one on a non-empty path, so
    // neither the raw nor the normalised lookup would find this without the
    // extra slash-toggled fallback.
    const pages = build(['https://x.com/en/about/']);
    populateIncomingLinksCount(pages, {
      'https://x.com/en/about': ['https://x.com/en/'],
    });
    assert.strictEqual(pages['https://x.com/en/about/'].incomingLinksCount, 1);
    assert.strictEqual(pages['https://x.com/en/about/'].hasIncomingLinks, true);
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

  void it('ignores an embedded example URL when routing a section', () => {
    // The `https://` of a cited URL must not pull a finding into the technical
    // section via `/HTTPS|TLS|SSL/`.
    assert.strictEqual(
      categorize('Broken pagination wastes crawl budget — https://www.siro.ai/insights/page/{N}'),
      'seo',
    );
    assert.strictEqual(categorize('Duplicate page titles found — https://example.com/a'), 'seo');
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

  void it('keeps "Third-party cookies without consent" DISTINCT from "…set before consent" (report doc #2)', () => {
    const out = consolidateFindings({
      'Multiple tracking cookies set before consent': det({ severity: 'medium', count: 3 }),
      'Third-party cookies without consent': det({ severity: 'medium', count: 4 }),
    });
    const keys = Object.keys(out);
    // Two genuinely different privacy findings: a banner exists but cookies fire
    // early (before consent) vs no banner at all for third-party cookies. The
    // "…before consent" dedup group must NOT swallow the third-party one.
    assert.ok(keys.includes('Multiple tracking cookies set before consent'));
    assert.ok(keys.includes('Third-party cookies without consent'), 'third-party-without-consent must stay distinct');
    assert.strictEqual(keys.length, 2);
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

  void it('folds the per-link "links without any text" enumeration into "Empty anchor text"', () => {
    const out = consolidateFindings({
      'Empty anchor text': det({ severity: 'medium', count: 369 }),
      'Some pages have links without any text': det({ severity: 'medium', count: 1568 }),
    });
    const keys = Object.keys(out);
    assert.ok(keys.includes('Empty anchor text'));
    assert.ok(!keys.some((k) => /links without any text/.test(k)), 'per-link enumeration should fold away');
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
import { ErrorAggregator, isDefectivePageOwnerFinding } from '../lib/utils/error-aggregator';
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
      progress: { processedPages: [], totalWithoutError: 5, totalWithError: 0, byError: {}, attempts: {} },
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
    assert.ok(
      !md.includes('(https://e.com/insights/page/{N})'),
      'templated {N} URL must not be linked as an affected page',
    );
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

  void it('warns when the crawl produced no analyzable pages (degenerate-crawl guard)', () => {
    // The plentific GIGO case: 0 pages analyzed, all attempts errored. Every
    // per-page finding below is an artifact, so the report must say so loudly.
    const healthy = buildReportMarkdown(
      mkArtifacts(['Missing meta description'], { 'Missing meta description': ['https://e.com/a'] }),
    );
    assert.ok(
      !healthy.includes('no analyzable pages'),
      'a healthy crawl (>0 analyzed) must NOT carry the degenerate-crawl banner',
    );

    const degenerate = mkArtifacts(['Page has very thin content'], {
      'Page has very thin content': ['https://e.com/dead'],
    });
    degenerate.manifest.progress.totalWithoutError = 0;
    degenerate.manifest.progress.totalWithError = 10;
    const md = buildReportMarkdown(degenerate);
    assert.ok(md.includes('no analyzable pages'), 'degenerate crawl must carry the warning banner');
    assert.ok(md.includes('All 10 attempted page(s)'), 'banner should state how many pages errored');
    assert.ok(md.includes('not a reliable audit'), 'banner must flag the findings/scores as unreliable');
    // The banner sits above the findings so it is seen first.
    assert.ok(
      md.indexOf('no analyzable pages') < md.indexOf('Page has very thin content'),
      'banner must precede findings',
    );
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

void describe('ErrorAggregator.suppressExamplesByUrl', () => {
  void it('drops examples citing a suppressed URL and adjusts count, keeping the excepted finding', () => {
    const agg = new ErrorAggregator();
    // A normal finding citing a mix of real + broken-pagination pages.
    agg.addError('Canonicals are not set', 'missing on https://e.com/real', 'high');
    agg.addError('Canonicals are not set', 'missing on https://e.com/insights/page/7', 'high');
    agg.addError('Canonicals are not set', 'missing on https://e.com/insights/page/8', 'high');
    // The broken-pagination finding itself cites those same pages — must be kept.
    agg.addError('Broken pagination wastes crawl budget — x', 'tail https://e.com/insights/page/7', 'high');

    const removed = agg.suppressExamplesByUrl(
      new Set(['https://e.com/insights/page/7', 'https://e.com/insights/page/8']),
      (key) => key.startsWith('Broken pagination'),
    );

    assert.strictEqual(removed, 2, 'two phantom-page examples removed');
    const data = agg.getData();
    const canon = data.details['Canonicals are not set'];
    assert.strictEqual(canon.count, 1, 'count corrected to the surviving (non-truncated) example');
    assert.deepStrictEqual(canon.examples, ['missing on https://e.com/real']);
    // Excepted finding untouched.
    assert.ok(data.details['Broken pagination wastes crawl budget — x']);
  });

  void it('does NOT match a prefix URL (/page/7 must not catch /page/70)', () => {
    const agg = new ErrorAggregator();
    agg.addError('Some issue', 'x https://e.com/insights/page/70', 'medium');
    const removed = agg.suppressExamplesByUrl(new Set(['https://e.com/insights/page/7']));
    assert.strictEqual(removed, 0, '/page/7 is not a substring match for /page/70');
    assert.strictEqual(agg.getData().details['Some issue'].count, 1);
  });

  void it('drops a finding entirely when only suppressed pages remain', () => {
    const agg = new ErrorAggregator();
    agg.addError('Large HTML document', 'big https://e.com/insights/page/9', 'low');
    agg.suppressExamplesByUrl(new Set(['https://e.com/insights/page/9']));
    const data = agg.getData();
    assert.strictEqual(data.details['Large HTML document'], undefined, 'fully-phantom finding removed');
    assert.ok(!data.bySeverity.low.some((k) => k.startsWith('Large HTML document')), 'severity tally cleaned up');
  });

  void it('matches URLs whose escaped (&amp;) query string appears in the example', () => {
    const agg = new ErrorAggregator();
    agg.addError('Some issue', 'x <a href="https://e.com/l?page={N}&amp;sort=asc">link</a>', 'medium');
    const removed = agg.suppressExamplesByUrl(new Set(['https://e.com/l?page={N}&sort=asc']));
    assert.strictEqual(removed, 1, 'escaped & in the example matches the decoded URL');
  });

  void it('keeps defective pages in their owning findings but strips them elsewhere (soft 404 + pagination)', () => {
    const agg = new ErrorAggregator();
    const soft = 'https://e.com/ghost';
    agg.addError('Soft 404 detected - page returns 200 but shows error content', `x ${soft}`, 'high');
    agg.addError('Broken pagination wastes crawl budget — x', `tail https://e.com/insights/page/9`, 'high');
    agg.addError('Canonicals are not set', `missing on ${soft}`, 'high');
    agg.addError('Canonicals are not set', `missing on https://e.com/insights/page/9`, 'high');
    agg.addError('Canonicals are not set', `missing on https://e.com/real`, 'high');

    agg.suppressExamplesByUrl(new Set([soft, 'https://e.com/insights/page/9']), isDefectivePageOwnerFinding);
    const d = agg.getData().details;
    assert.deepStrictEqual(d['Canonicals are not set'].examples, ['missing on https://e.com/real']);
    assert.ok(d['Soft 404 detected - page returns 200 but shows error content'], 'soft-404 finding keeps its page');
    assert.ok(d['Broken pagination wastes crawl budget — x'], 'pagination finding keeps its page');
  });
});

void describe('isDefectivePageOwnerFinding', () => {
  void it('recognises defect-owner findings and rejects on-page-quality ones', () => {
    for (const k of [
      'Broken pagination wastes crawl budget — https://e.com/p/{N}',
      'Additional pagination series show broken/infinite "next" links',
      'Soft 404 detected - page returns 200 but shows error content',
      'Potential soft 404 page needs review',
    ]) {
      assert.ok(isDefectivePageOwnerFinding(k), `${k} should be a defect owner`);
    }
    for (const k of ['Canonicals are not set', 'Some pages have too many requests', 'Empty anchor text']) {
      assert.ok(!isDefectivePageOwnerFinding(k), `${k} must NOT be a defect owner`);
    }
  });
});

void describe('worst-first example ordering', () => {
  void it('exampleMetric reads the embedded value and normalises byte units', () => {
    assert.strictEqual(exampleMetric('This page has 48 requests https://e.com/x'), 48);
    assert.strictEqual(exampleMetric('https://e.com/x has Total Blocking Time 3273ms (threshold: 200ms)'), 3273);
    assert.strictEqual(exampleMetric('https://e.com/x: 96% of CSS is unused (5.5 MB of 5.7 MB)'), 96);
    // Byte units normalise so MB outranks KB even though 1.7 < 512 numerically.
    assert.ok(
      exampleMetric('https://e.com/x: 1.7 MB of unused code') > exampleMetric('https://e.com/y: 512 KB of unused code'),
    );
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
import { ExternalLinksAnalyzer } from '../lib/analyzers/seo/external-links-analyzer';
import { ResourceHintsAnalyzer } from '../lib/analyzers/performance/resource-hints-analyzer';

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

void describe('ResourceHintsAnalyzer.isPreloaded', () => {
  void it('matches a preload by exact href and by query-string variant', () => {
    const preloads = [{ href: 'https://ex.com/hero.jpg' }];
    assert.ok(ResourceHintsAnalyzer.isPreloaded('https://ex.com/hero.jpg', preloads));
    assert.ok(ResourceHintsAnalyzer.isPreloaded('https://ex.com/hero.jpg?v=2', preloads));
  });

  void it('does not treat an empty/missing preload href as matching every resource', () => {
    assert.ok(!ResourceHintsAnalyzer.isPreloaded('https://ex.com/hero.jpg', [{ href: '' }]));
    assert.ok(!ResourceHintsAnalyzer.isPreloaded('https://ex.com/hero.jpg', [{}]));
  });
});

void describe('UrlArchitectureAnalyzer session-ID detection', () => {
  const origin = 'https://ex.com';
  const flagged = (url: string) =>
    UrlArchitectureAnalyzer.analyze(url, {} as PageInfo, origin).issues.some((i) => i.type === 'session_id_in_url');

  void it('flags a genuine session-id query parameter', () => {
    assert.ok(flagged('https://ex.com/cart?sid=ABC123'), 'sid= query param');
    assert.ok(flagged('https://ex.com/cart?PHPSESSID=deadbeef'), 'PHPSESSID query param');
  });

  void it('flags a path-embedded session token that assigns a value', () => {
    assert.ok(flagged('https://ex.com/page;jsessionid=ABC123'), 'matrix jsessionid');
  });

  void it('does not flag ordinary words containing "sid" (regression: "resident")', () => {
    assert.ok(!flagged('https://ex.com/resident-engagement/'));
    assert.ok(!flagged('https://ex.com/de-de/resident-self-service/'));
    assert.ok(!flagged('https://ex.com/considerations/outside-zone/'));
  });
});

void describe('ExternalLinksAnalyzer.isAffiliateLink', () => {
  void it('flags real affiliate signals', () => {
    assert.ok(ExternalLinksAnalyzer.isAffiliateLink('https://partner.com/go?aff=123'), 'aff= param');
    assert.ok(ExternalLinksAnalyzer.isAffiliateLink('https://www.amazon.com/dp/X?tag=mysite-20'), 'amazon tag');
    assert.ok(ExternalLinksAnalyzer.isAffiliateLink('https://shareasale.com/r.cfm?b=1'), 'named network');
    assert.ok(ExternalLinksAnalyzer.isAffiliateLink('https://site.com/affiliate/go'), 'path segment');
    assert.ok(ExternalLinksAnalyzer.isAffiliateLink('https://site.com/x?utm_source=affiliate'), 'utm_source=affiliate');
  });

  void it('does not flag a vendor "powered by" link with a generic ref param (regression: CookieYes)', () => {
    assert.ok(
      !ExternalLinksAnalyzer.isAffiliateLink(
        'https://www.cookieyes.com/product/cookie-consent/?ref=cypbcyb&utm_source=cookie-banner&utm_medium=powered-by-cookieyes',
      ),
    );
  });

  void it('does not flag generic ref/tag params (referrer, category filters)', () => {
    assert.ok(!ExternalLinksAnalyzer.isAffiliateLink('https://news.com/article?ref=homepage'));
    assert.ok(!ExternalLinksAnalyzer.isAffiliateLink('https://blog.com/posts?tag=seo'));
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
    assert.ok(/third-party payload/i.test(benchmarkFor('Large third-party payload') ?? ''));
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

  void it('flags realistic unpinned ranges (>= , > , x-ranges) and leaves normal pins alone', () => {
    const flagged = PackageAnalyzer.analyze({
      dependencies: { a: '>=2.0.0', b: '>1', c: '1.x', d: '18.x' },
    });
    // All four are unpinned → the warning fires and the safe pins below do not.
    assert.ok(flagged.warnings.some((w) => /wildcard|open-ended/i.test(w.message ?? '')));

    const safe = PackageAnalyzer.analyze({
      dependencies: { a: '^1.2.3', b: '~1.2.0', c: '1.2.3', d: 'github:user/repo' },
    });
    assert.ok(!safe.warnings.some((w) => /wildcard|open-ended/i.test(w.message ?? '')));
  });

  void it('version-checks Next/React even when next is a devDependency', () => {
    const r = PackageAnalyzer.analyze({
      devDependencies: { next: '^13.4.0' },
      dependencies: { react: '^17.0.2' },
    });
    assert.ok(
      r.issues.some((i) => /newer React/i.test(i.message ?? '')),
      'Next-in-devDependencies must still trigger the React-mismatch check',
    );
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
  void it('returns nothing for an unrecognised framework (null)', () => {
    const root = fakeRepo('app/utils.ts', `import _ from 'lodash';\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: null, srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(r.issues.length, 0);
    assert.strictEqual(r.warnings.length, 0);
  });

  void it('does NOT run Next-only patterns on a non-Next framework', () => {
    // `cache: "no-store"` is a Next-data-cache concern; it must not fire on Nuxt.
    const root = fakeRepo('app/fetcher.ts', `export const load = () => fetch('/x', { cache: "no-store" });\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Nuxt', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'Next.js data cache'), 'Next-only pattern must not fire on Nuxt');
  });

  void it('runs framework-agnostic import checks on a non-Next framework (lodash on Nuxt)', () => {
    const root = fakeRepo('app/utils.ts', `import _ from 'lodash';\nexport const d = _.debounce(() => {}, 100);\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Nuxt', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'lodash imported as a whole library'), 'universal lodash check must run on Nuxt');
  });

  void it('flags a full moment.js import (framework-agnostic)', () => {
    const root = fakeRepo('src/date.ts', `import moment from 'moment';\nexport const now = () => moment();\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Astro', srcDirs: ['src'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'moment.js imported'), 'universal moment check must run on Astro');
  });

  void it('flags SvelteKit `export const ssr = false` in a +page route', () => {
    const root = fakeRepo('src/routes/+page.ts', `export const ssr = false;\nexport const load = () => ({});\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'SvelteKit', srcDirs: ['src'] });
    fs.rmSync(root, { recursive: true, force: true });
    const hit = find(r.issues, 'Route disables SSR');
    assert.ok(hit, 'SvelteKit ssr=false on a route must fire');
    assert.strictEqual(hit?.severity, 'high');
  });

  void it('does NOT flag `ssr = false` outside a +page/+layout route file', () => {
    const root = fakeRepo('src/lib/config.ts', `export const ssr = false;\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'SvelteKit', srcDirs: ['src'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'Route disables SSR'), 'non-route ssr=false must not fire');
  });

  void it('flags cache: "no-store"', () => {
    const root = fakeRepo(
      'app/fetcher.ts',
      `export async function load() {\n  return fetch('/api/x', { cache: "no-store" });\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'disable the Next.js data cache'));
  });

  void it('flags dynamic import with ssr: false even when callback has its own parens', () => {
    const root = fakeRepo(
      'app/page.tsx',
      `import dynamic from 'next/dynamic';\nconst Heavy = dynamic(() => import('./Heavy'), { ssr: false });\nexport default function P() { return <Heavy />; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    const hit = find(r.issues, 'ssr: false break SEO');
    assert.ok(hit, `expected ssr:false finding, got ${JSON.stringify([...r.issues, ...r.warnings])}`);
    assert.strictEqual(hit?.severity, 'high');
  });

  void it('does NOT flag ssr: false in a client-only widget path (analytics)', () => {
    // `ssr: false` is the correct pattern for client-only third-party widgets —
    // the finding text exempts them, so flagging HIGH here is a false positive.
    const root = fakeRepo(
      'src/components/Analytics/index.tsx',
      `import dynamic from 'next/dynamic';\nconst GA = dynamic(() => import('./ga'), { ssr: false });\nexport default function A() { return <GA />; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['src'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find(r.issues, 'ssr: false break SEO'), 'analytics widget ssr:false must not be flagged');
  });

  void it('still flags ssr: false in a content path even when a widget also uses it', () => {
    // Mixed repo: a legitimate widget AND a content page both disable SSR. The
    // content page must still fire; the widget must not inflate the count.
    const root = fakeRepo(
      'src/app/page.tsx',
      `import dynamic from 'next/dynamic';\nconst Body = dynamic(() => import('./Body'), { ssr: false });\nexport default function P() { return <Body />; }\n`,
    );
    fs.writeFileSync(
      path.join(root, 'src/app/tracking.tsx'),
      `import dynamic from 'next/dynamic';\nconst T = dynamic(() => import('./t'), { ssr: false });\nexport default function T2() { return <T />; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['src'] });
    fs.rmSync(root, { recursive: true, force: true });
    const hit = find(r.issues, 'ssr: false break SEO');
    assert.ok(hit, 'content-path ssr:false must still fire');
    assert.ok(hit?.detail?.includes('page.tsx'), 'content example must be cited');
    assert.ok(!hit?.detail?.includes('tracking.tsx'), 'widget example must be excluded from the finding');
    assert.ok(hit?.detail?.includes('1 dynamic import'), 'count must exclude the widget');
  });

  void it('flags force-dynamic export', () => {
    const root = fakeRepo(
      'app/icon.tsx',
      `export const dynamic = 'force-dynamic';\nexport default function Icon() { return null; }\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'force-dynamic'));
  });

  void it('flags full-lib lodash imports', () => {
    const root = fakeRepo('app/utils.ts', `import _ from 'lodash';\nexport const d = _.debounce(() => {}, 100);\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'lodash imported as a whole library'));
  });

  void it('does NOT flag method-specific lodash imports', () => {
    const root = fakeRepo(
      'app/utils.ts',
      `import debounce from 'lodash.debounce';\nimport throttle from 'lodash/throttle';\nexport { debounce, throttle };\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'lodash imported as a whole library'));
  });

  void it('flags CSS inlined in _app via dangerouslySetInnerHTML', () => {
    const root = fakeRepo(
      'pages/_app.tsx',
      `import fs from 'fs';\nexport default function App() {\n  return <style dangerouslySetInnerHTML={{ __html: fs.readFileSync('a.css','utf8') }} />;\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['pages'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(find(r.warnings, 'CSS inlined via dangerouslySetInnerHTML in _app'));
  });

  void it('does NOT flag CSS-inline pattern in non-_app files', () => {
    const root = fakeRepo(
      'pages/index.tsx',
      `import fs from 'fs';\nexport default function P() {\n  return <style dangerouslySetInnerHTML={{ __html: fs.readFileSync('a.css','utf8') }} />;\n}\n`,
    );
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['pages'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'CSS inlined'));
  });

  void it('skips node_modules and similar dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'src-pat-skip-'));
    const nm = path.join(root, 'app', 'node_modules', 'evil');
    fs.mkdirSync(nm, { recursive: true });
    // place a violating pattern inside node_modules
    fs.writeFileSync(path.join(nm, 'leaked.ts'), `export const dynamic = 'force-dynamic';\n`);
    const r = SourcePatternAnalyzer.analyze(root, { framework: 'Next.js', srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(!find([...r.issues, ...r.warnings], 'force-dynamic'));
  });
});

// ============================================================
// Detector ↔ analyzer name parity (latent-trap guard)
//
// SourcePatternAnalyzer once gated on the literal 'nextjs' while the detector
// emits 'Next.js', so the analyzer silently never ran in production. Hand-built
// frameworkInfo in the unit tests masked it. These integration tests run the
// REAL detector output straight into the downstream analyzers, so any future
// drift in the framework name string fails here.
// ============================================================
import { RepoFrameworkDetector } from '../lib/analyzers/repo/framework-detector';

void describe('repo framework name parity', () => {
  void it('detects a Next.js repo as exactly "Next.js"', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-parity-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14.2.0' } }));
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'page.tsx'), `export default function P() { return null; }`);
    const info = RepoFrameworkDetector.detect(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(info.framework, 'Next.js');
  });

  void it('feeds detector output into SourcePatternAnalyzer and the Next.js checks fire', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-parity-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14.2.0' } }));
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'page.tsx'), `export default function P() { return null; }`);
    fs.writeFileSync(
      path.join(root, 'app', 'fetcher.ts'),
      `export async function load() {\n  return fetch('/api/x', { cache: "no-store" });\n}\n`,
    );

    const info = RepoFrameworkDetector.detect(root);
    // Pass the detector's OWN output through — not a hand-built literal.
    const r = SourcePatternAnalyzer.analyze(root, { framework: info.framework, srcDirs: info.srcDirs });
    fs.rmSync(root, { recursive: true, force: true });

    assert.ok(
      find(r.warnings, 'disable the Next.js data cache'),
      'SourcePatternAnalyzer must fire on the detector-reported framework name',
    );
  });
});

// ============================================================
// Repo-analysis bug fixes (route extraction / comparison / detection / mapping)
// ============================================================
import { RouteExtractor } from '../lib/analyzers/repo/route-extractor';
import { RouteSitemapComparator } from '../lib/analyzers/repo/route-sitemap-comparator';
import { FrameworkConfigValidator } from '../lib/analyzers/repo/framework-config-validator';
import { SourceMapper, applyMatcher } from '../lib/analyzers/repo/source-mapper';
import { renderRepoDetailHtml } from '../lib/reports/sections/source-code-analysis';

/** Build a multi-file fake repo under a temp dir; returns the root. */
function fakeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-fix-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

const NEXT_FI: {
  framework: string;
  router: string | null;
  version: string | null;
  packageJson: Record<string, unknown>;
  srcDirs: string[];
  configFile: string | null;
} = {
  framework: 'Next.js',
  router: 'app',
  version: null,
  packageJson: {},
  srcDirs: ['app', 'src'],
  configFile: null,
};

void describe('RouteSitemapComparator — dynamic-segment regex safety', () => {
  void it('does not throw and covers a dashed dynamic segment ([product-id])', () => {
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/shop/[product-id]', file: 'p.tsx', isDynamic: true }],
      { 'https://ex.com/shop/abc': {} },
      'https://ex.com',
    );
    assert.strictEqual(r.stats.coveredRoutes, 1);
  });

  void it('treats a dashed catch-all ([...all-slugs]) as a catch-all match', () => {
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/docs/[...all-slugs]', file: 'p.tsx', isDynamic: true }],
      { 'https://ex.com/docs/a/b/c': {} },
      'https://ex.com',
    );
    assert.strictEqual(r.stats.coveredRoutes, 1);
  });
});

void describe('RouteSitemapComparator — origin host filtering', () => {
  void it('does not count a cross-origin sitemap URL as covering a local route', () => {
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/pricing', file: 'p.tsx', isDynamic: false }],
      { 'https://staging.other.com/pricing': {} },
      'https://example.com',
    );
    assert.strictEqual(r.stats.coveredRoutes, 0);
    assert.strictEqual(r.stats.uncoveredRoutes, 1);
  });

  void it('still covers a same-origin sitemap URL', () => {
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/pricing', file: 'p.tsx', isDynamic: false }],
      { 'https://example.com/pricing': {} },
      'https://example.com',
    );
    assert.strictEqual(r.stats.coveredRoutes, 1);
  });

  void it('treats apex and www as the same site (no false uncovered on a www-canonical sitemap)', () => {
    // apex origin, www sitemap (a 301-to-www site reached via the apex)
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/pricing', file: 'p.tsx', isDynamic: false }],
      { 'https://www.example.com/pricing': {} },
      'https://example.com',
    );
    assert.strictEqual(r.stats.coveredRoutes, 1);
    assert.strictEqual(r.stats.uncoveredRoutes, 0);

    // and the inverse: www origin, apex sitemap
    const r2 = RouteSitemapComparator.compare(
      [{ pattern: '/pricing', file: 'p.tsx', isDynamic: false }],
      { 'https://example.com/pricing': {} },
      'https://www.example.com',
    );
    assert.strictEqual(r2.stats.coveredRoutes, 1);
  });

  void it('matches on path alone when no origin is supplied (back-compat)', () => {
    const r = RouteSitemapComparator.compare(
      [{ pattern: '/pricing', file: 'p.tsx', isDynamic: false }],
      { 'https://anything.com/pricing': {} },
      '',
    );
    assert.strictEqual(r.stats.coveredRoutes, 1);
  });
});

void describe('RouteExtractor — Next.js parallel routes', () => {
  void it('collapses @slot pages into a single route per URL pattern', () => {
    const root = fakeTree({
      'app/dashboard/page.tsx': 'export default function P(){return null}',
      'app/dashboard/@team/page.tsx': 'export default function P(){return null}',
      'app/dashboard/@analytics/page.tsx': 'export default function P(){return null}',
    });
    const routes = RouteExtractor.extract(root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    const dashboard = routes.filter((r) => r.pattern === '/dashboard');
    assert.strictEqual(dashboard.length, 1, `expected one /dashboard route, got ${JSON.stringify(routes)}`);
  });
});

void describe('RepoFrameworkDetector — router detection & version cleaning', () => {
  void it('does not count a pages/ dir holding only _document as a Pages Router', () => {
    const root = fakeTree({
      'package.json': JSON.stringify({ dependencies: { next: '^14' } }),
      'app/layout.tsx': 'x',
      'app/page.tsx': 'x',
      'pages/_document.tsx': 'x',
    });
    const info = RepoFrameworkDetector.detect(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(info.router, 'app');
  });

  void it('returns null version for a non-semver git specifier instead of fabricating one', () => {
    const root = fakeTree({
      'package.json': JSON.stringify({ dependencies: { next: 'github:vercel/next.js#v14.1.0' } }),
    });
    const info = RepoFrameworkDetector.detect(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(info.version, null);
  });

  void it('still cleans a normal caret range', () => {
    const root = fakeTree({ 'package.json': JSON.stringify({ dependencies: { next: '^14.2.0' } }) });
    const info = RepoFrameworkDetector.detect(root);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(info.version, '14.2.0');
  });
});

void describe('FrameworkConfigValidator — Next.js app-dir resolution & comment stripping', () => {
  void it('resolves a top-level app/ built with .jsx (no false robots/sitemap, metadata check still runs)', () => {
    const root = fakeTree({
      'app/layout.jsx': 'export default function L(){return null}', // no metadata export
      'app/page.jsx': 'export default function P(){return null}',
      'app/robots.ts': 'export default ()=>({})',
      'app/sitemap.ts': 'export default ()=>([])',
    });
    const r = FrameworkConfigValidator.validate(root, { ...NEXT_FI, srcDirs: ['app'] });
    fs.rmSync(root, { recursive: true, force: true });
    const msgs = [...r.issues, ...r.warnings].map((i) => i.message ?? '');
    assert.ok(!msgs.some((m) => /Missing robots/.test(m)), 'robots.ts exists under app/ — no false missing');
    assert.ok(!msgs.some((m) => /Missing sitemap/.test(m)), 'sitemap.ts exists under app/ — no false missing');
    assert.ok(
      msgs.some((m) => /metadata/i.test(m)),
      'metadata check must run on the real app dir',
    );
  });

  void it('does not read a config key that appears only inside a /* */ comment', () => {
    const root = fakeTree({
      'next.config.js': '/* example:\n  images: { formats: [] },\n  trailingSlash: true,\n*/\nmodule.exports = {};\n',
    });
    const r = FrameworkConfigValidator.validate(root, {
      ...NEXT_FI,
      router: null,
      srcDirs: [],
      configFile: 'next.config.js',
    });
    fs.rmSync(root, { recursive: true, force: true });
    const msgs = [...r.issues, ...r.warnings].map((i) => i.message ?? '');
    assert.ok(
      msgs.some((m) => /trailingSlash/.test(m)),
      'commented-out trailingSlash must not count as configured',
    );
    assert.ok(
      msgs.some((m) => /images/.test(m)),
      'commented-out images must not count as configured',
    );
  });
});

// ============================================================
// LLM repo analyzer (the --llm repo pass) — pure / bounded logic only.
// The populated model path is intentionally NOT unit-tested (it would hit the
// network); we test parsing, source gathering, and the no-source degrade.
// ============================================================
import {
  parseLlmRepoFindings,
  gatherSourceFiles,
  analyzeRepoWithLlm,
  type RepoContext,
} from '../lib/analyzers/repo/llm-repo-analyzer';

const EMPTY_CTX: RepoContext = {
  framework: 'Next.js',
  version: '14.2.0',
  router: 'app',
  configFile: null,
  knownIssues: [],
  crawlFindings: [],
  sourceMapFiles: [],
};

void describe('parseLlmRepoFindings', () => {
  void it('parses valid findings and validates enums', () => {
    const text = JSON.stringify([
      { severity: 'high', title: 'CSR for main content', detail: 'd', fix: 'f', kind: 'novel', file: 'app/page.tsx' },
      { severity: 'medium', title: 'Confirms dupe titles', detail: 'd2', fix: 'f2', kind: 'confirmation' },
    ]);
    const out = parseLlmRepoFindings(text, new Set(['app/page.tsx']));
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].message, 'CSR for main content');
    assert.strictEqual(out[0].file, 'app/page.tsx');
    assert.strictEqual(out[1].kind, 'confirmation');
  });

  void it('drops a finding citing a file that was not provided (anti-hallucination)', () => {
    const text = JSON.stringify([
      { severity: 'high', title: 'Phantom', detail: 'd', fix: 'f', kind: 'novel', file: 'app/does-not-exist.tsx' },
    ]);
    assert.strictEqual(parseLlmRepoFindings(text, new Set(['app/page.tsx'])).length, 0);
  });

  void it('drops items with invalid severity or kind', () => {
    const text = JSON.stringify([
      { severity: 'urgent', title: 'bad sev', detail: '', fix: '', kind: 'novel' },
      { severity: 'low', title: 'bad kind', detail: '', fix: '', kind: 'made-up' },
    ]);
    assert.strictEqual(parseLlmRepoFindings(text, new Set()).length, 0);
  });

  void it('strips ```json fences and tolerates leading prose', () => {
    const text = 'Here you go:\n```json\n[{"severity":"low","title":"t","detail":"","fix":"","kind":"novel"}]\n```';
    assert.strictEqual(parseLlmRepoFindings(text, new Set()).length, 1);
  });

  void it('returns [] on garbage / empty', () => {
    assert.deepStrictEqual(parseLlmRepoFindings('not json at all', new Set()), []);
    assert.deepStrictEqual(parseLlmRepoFindings('', new Set()), []);
    assert.deepStrictEqual(parseLlmRepoFindings('{"not":"array"}', new Set()), []);
  });
});

void describe('gatherSourceFiles', () => {
  void it('gathers existing entry + source-map files, caps count, truncates large files', () => {
    const root = fakeTree({
      'app/layout.tsx': 'export default function L(){return null}',
      'app/page.tsx': 'export default function P(){return null}',
      'components/Big.tsx': 'x'.repeat(20000),
    });
    const ctx = { ...EMPTY_CTX, sourceMapFiles: ['components/Big.tsx'] };
    const files = gatherSourceFiles(root, ctx, 10);
    fs.rmSync(root, { recursive: true, force: true });
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('app/layout.tsx'));
    assert.ok(paths.includes('app/page.tsx'));
    assert.ok(paths.includes('components/Big.tsx'));
    const big = files.find((f) => f.path === 'components/Big.tsx');
    assert.ok((big?.content.length ?? 0) < 20000, 'large file must be truncated');
    assert.ok(big?.content.includes('truncated'));
  });

  void it('respects the maxFiles cap', () => {
    const root = fakeTree({
      'app/layout.tsx': 'a',
      'app/page.tsx': 'b',
      'pages/_app.tsx': 'c',
    });
    const files = gatherSourceFiles(root, EMPTY_CTX, 2);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(files.length, 2);
  });

  void it('refuses a source-map path that escapes the repo root (traversal guard)', () => {
    const root = fakeTree({ 'app/layout.tsx': 'ok' });
    // Plant a file OUTSIDE the repo root and try to reach it via ../
    const outside = path.join(path.dirname(root), 'secret.txt');
    fs.writeFileSync(outside, 'TOPSECRET');
    const ctx = { ...EMPTY_CTX, sourceMapFiles: [`../${path.basename(outside)}`] };
    const files = gatherSourceFiles(root, ctx, 10);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
    assert.ok(!files.some((f) => f.content.includes('TOPSECRET')), 'must not read files outside the repo');
  });
});

void describe('analyzeRepoWithLlm — degrade', () => {
  void it('returns [] (no model call) when no source files are gatherable', async () => {
    const root = fakeTree({ 'README.md': 'no source here' });
    // Empty dir of source entry points → gatherSourceFiles yields [] → returns []
    // before any transport call, so this is network-free regardless of env keys.
    const out = await analyzeRepoWithLlm(root, EMPTY_CTX, { cacheDir: path.join(root, '.cache') });
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepStrictEqual(out, []);
  });
});

void describe('RouteExtractor — Remix flat-route escape', () => {
  void it('unwraps a [.] literal escape into a real dot (not a stray bracket / dynamic)', () => {
    const root = fakeTree({
      'app/routes/concerts.trending[.]json.tsx': 'export default ()=>null',
      'app/routes/blog.$slug.tsx': 'export default ()=>null',
    });
    const routes = RouteExtractor.extract(root, {
      framework: 'Remix',
      router: null,
      version: null,
      packageJson: {},
      srcDirs: ['app'],
      configFile: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
    const escaped = routes.find((r) => r.file.includes('trending'));
    assert.strictEqual(escaped?.pattern, '/concerts/trending.json');
    assert.strictEqual(escaped?.isDynamic, false);
    // $-dynamic still works alongside the escape handling
    assert.ok(routes.some((r) => r.pattern === '/blog/[slug]' && r.isDynamic));
  });

  void it('splits a $-dynamic param from a trailing escaped literal in the same segment', () => {
    const root = fakeTree({
      'app/routes/users.$id[.]json.tsx': 'export default ()=>null',
      'app/routes/$.tsx': 'export default ()=>null',
    });
    const routes = RouteExtractor.extract(root, {
      framework: 'Remix',
      router: null,
      version: null,
      packageJson: {},
      srcDirs: ['app'],
      configFile: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
    // $id[.]json -> dynamic param `id` + literal `.json`, not a bracket-swallowing [id[.]json]
    const resource = routes.find((r) => r.file.includes('users'));
    assert.strictEqual(resource?.pattern, '/users/[id].json');
    assert.strictEqual(resource?.isDynamic, true);
    // bare $ is still the catch-all splat
    assert.ok(routes.some((r) => r.pattern === '/[...catchall]'));
  });

  void it('keeps a non-ASCII dynamic param name dynamic (no regression to literal)', () => {
    const root = fakeTree({ 'app/routes/users.$слаг.tsx': 'export default ()=>null' });
    const routes = RouteExtractor.extract(root, {
      framework: 'Remix',
      router: null,
      version: null,
      packageJson: {},
      srcDirs: ['app'],
      configFile: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
    const r = routes.find((x) => x.file.includes('users'));
    assert.strictEqual(r?.pattern, '/users/[слаг]');
    assert.strictEqual(r?.isDynamic, true);
  });
});

void describe('SourceMapper — Open Graph / structured-data key remap', () => {
  void it('fires the OG and structured-data mappers on the real "Low … coverage" messages', () => {
    const root = fakeTree({
      'app/layout.tsx': 'export const metadata = {}; export default ()=>null',
    });
    const fi = { ...NEXT_FI, srcDirs: ['app'] };
    const og = SourceMapper.map({ 'Low Open Graph tag coverage across the site': 1 }, root, fi);
    const sd = SourceMapper.map({ 'Low structured data coverage detected': 1 }, root, fi);
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(Object.keys(og).length > 0, 'Open Graph mapper must match "Low Open Graph tag coverage"');
    assert.ok(Object.keys(sd).length > 0, 'structured-data mapper must match "Low structured data coverage"');
  });
});

void describe('renderRepoDetailHtml — whitelist HTML rendering', () => {
  void it('renders intended <code>/<br> markup but escapes injected tags', () => {
    assert.strictEqual(
      renderRepoDetailHtml('Found <code>app/page.tsx</code> issue'),
      'Found <code>app/page.tsx</code> issue',
    );
    const xss = renderRepoDetailHtml('file <code><script>alert(1)</script>.tsx</code>');
    assert.ok(!xss.includes('<script>'), 'injected <script> must be escaped, never emitted raw');
    assert.ok(xss.includes('&lt;script&gt;'), 'injected tag is escaped');
    assert.ok(xss.includes('<code>'), 'intended <code> still renders');
  });
});

void describe('SourceMapper — alt detection & key merge', () => {
  void it('flags an <img> whose only alt-like attribute is a hyphenated data-alt', () => {
    const root = fakeTree({ 'src/D.tsx': 'export default ()=> <img data-alt="x" src="y" />' });
    const m = SourceMapper.map({ 'Pages have images without alt text': 1 }, root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(JSON.stringify(m).includes('D.tsx'), 'data-alt must not satisfy the has-alt check');
  });

  void it('merges locations when one analysis key matches two mapper substrings', () => {
    const root = fakeTree({ 'app/page.tsx': 'export default ()=> <img src="y" />' });
    const m = SourceMapper.map({ 'Title is missing and images without alt text': 1 }, root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    const contexts = new Set((Object.values(m)[0] ?? []).map((l) => l.context));
    assert.ok(contexts.has('page without metadata export'), 'title mapper locations must survive');
    assert.ok(contexts.has('image without alt attribute'), 'alt mapper locations must survive');
  });

  void it('does NOT source-map title/description LENGTH findings (not statically determinable)', () => {
    // "too short"/"too long" are content-length facts, not structural ones — the
    // value is composed at runtime/CMS. Mapping them cited "page without metadata
    // export" and attached the IDENTICAL files to the mutually-exclusive
    // too-short and too-long findings. Length findings must produce no mapping.
    const root = fakeTree({ 'app/page.tsx': 'export const metadata = { title: "x" };\nexport default ()=> null' });
    for (const key of [
      'Some pages have titles that are too short',
      'Some pages have titles that are too long',
      'Some pages have descriptions that are too short',
      'Some pages have descriptions that are too long',
    ]) {
      const m = SourceMapper.map({ [key]: 1 }, root, { ...NEXT_FI });
      assert.deepStrictEqual(m, {}, `length finding "${key}" must not be source-mapped`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/**
 * Binds each mapping rule to the ACTUAL analyzer source that emits its finding
 * message: `needle` is a stable literal substring that must appear in `file`.
 * This is what makes drift detection AUTOMATIC — a silent rename in the analyzer
 * removes the needle from the file and fails CI, where the static-examples guard
 * alone would not (its example strings live in the test, not the analyzer). Every
 * rule kind MUST have an entry here (asserted below), so a new rule can't ship
 * without being pinned to a real emission site.
 */
const REAL_SOURCE_PROBES: Record<string, Array<{ file: string; needle: string }>> = {
  'missing-title': [{ file: 'lib/crawler/page-data-builder.ts', needle: 'Title is missing' }],
  'missing-description': [{ file: 'lib/crawler/page-data-builder.ts', needle: 'Description meta tag is missing' }],
  'missing-canonical': [{ file: 'lib/crawler/page-data-builder.ts', needle: 'Canonicals are not set for some pages' }],
  'multiple-h1': [{ file: 'lib/analyzers/seo/heading-analyzer.ts', needle: 'Some pages have more than one h1 tag' }],
  'structured-data': [
    { file: 'lib/analyzers/site-wide/structured-data-validator.ts', needle: 'Low structured data coverage' },
  ],
  'open-graph': [{ file: 'lib/analyzers/site-wide/social-media-validator.ts', needle: 'Low Open Graph tag coverage' }],
  'missing-alt': [{ file: 'lib/analyzers/seo/anchor-text-analyzer.ts', needle: 'Image links without alt text' }],
  'deprecated-html': [
    { file: 'lib/analyzers/seo/deprecated-html-analyzer.ts', needle: 'Deprecated HTML elements found (' },
  ],
  'meta-refresh': [
    { file: 'lib/analyzers/seo/technical-seo-analyzer.ts', needle: 'Page uses meta refresh redirect' },
    { file: 'lib/analyzers/seo/technical-seo-analyzer.ts', needle: 'Page uses delayed meta refresh' },
  ],
};

// The test suite is run from the repo root (package.json `test` script), so the
// analyzer files resolve relative to cwd. A wrong cwd surfaces as a loud ENOENT,
// never a silent pass.
const REPO_ROOT_FOR_PROBES = process.cwd();

void describe('SourceMapper — drift guard (matchers vs real emitted messages)', () => {
  // The mapping registry is coupled to the FREE-TEXT finding messages analyzers
  // emit (analysis.details keys). When a message is renamed, a matcher silently
  // stops firing and the feature degrades with no error — which is exactly how
  // the alt-text mapper went dead (the real finding is "Image links without alt
  // text", but the old keys were "images without alt" / "alt text is missing",
  // which match nothing). Two layers guard this: (1) the static `examples` each
  // rule documents, and (2) REAL_SOURCE_PROBES below, which reads the emitting
  // analyzer source so a silent rename there fails CI automatically.

  void it('every rule lists ≥1 example and its matcher matches each one', () => {
    for (const rule of SourceMapper.rules) {
      assert.ok(rule.examples.length > 0, `rule "${rule.kind}" must document ≥1 real emitted example`);
      for (const ex of rule.examples) {
        assert.ok(
          applyMatcher(rule.match, ex),
          `rule "${rule.kind}" matcher no longer matches its documented emitted message: "${ex}" — ` +
            `the analyzer message was likely renamed; update both the analyzer and the rule's examples`,
        );
      }
    }
  });

  void it('no rule is dead (would have caught the alt-text regression)', () => {
    for (const rule of SourceMapper.rules) {
      assert.ok(
        rule.examples.some((ex) => applyMatcher(rule.match, ex)),
        `rule "${rule.kind}" matches none of its real emitted messages — it is dead`,
      );
    }
  });

  void it('maps the REAL alt finding "Image links without alt text" end-to-end', () => {
    // The regression test proper: drive map() with the ACTUAL emitted string
    // (not a synthetic "...images without alt..." variant) and assert a location
    // is produced. This is what the unit tests above this block missed.
    const root = fakeTree({ 'app/page.tsx': 'export default ()=> <img src="y" />' });
    const m = SourceMapper.map({ 'Image links without alt text': 1 }, root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(JSON.stringify(m).includes('page.tsx'), 'the real emitted alt finding must resolve to a source location');
  });

  void it('does not match content-LENGTH findings (no accidental over-broad matcher)', () => {
    const lengthFindings = [
      'Some pages have titles that are too short',
      'Some pages have descriptions that are too long',
    ];
    for (const rule of SourceMapper.rules) {
      for (const lf of lengthFindings) {
        assert.ok(!applyMatcher(rule.match, lf), `rule "${rule.kind}" must not match length finding "${lf}"`);
      }
    }
  });

  void it('every rule kind is pinned to a real emission site (no rule ships unprobed)', () => {
    for (const rule of SourceMapper.rules) {
      assert.ok(
        REAL_SOURCE_PROBES[rule.kind]?.length,
        `rule "${rule.kind}" has no REAL_SOURCE_PROBES entry — pin it to the analyzer file:needle that emits its message`,
      );
    }
  });

  void it('each probe needle still exists in its analyzer source (AUTOMATIC rename detection)', () => {
    for (const [kind, probes] of Object.entries(REAL_SOURCE_PROBES)) {
      for (const { file, needle } of probes) {
        const abs = path.join(REPO_ROOT_FOR_PROBES, file);
        const content = fs.readFileSync(abs, 'utf8');
        assert.ok(
          content.includes(needle),
          `"${needle}" no longer appears in ${file} — the analyzer message for rule "${kind}" was renamed; ` +
            `update the analyzer AND this probe (and the rule's matcher/examples in source-mapper.ts)`,
        );
      }
    }
  });

  void it('every probe needle is matched by its own rule (real source ⇄ matcher are in sync)', () => {
    const byKind = new Map(SourceMapper.rules.map((r) => [r.kind, r]));
    for (const [kind, probes] of Object.entries(REAL_SOURCE_PROBES)) {
      const rule = byKind.get(kind);
      assert.ok(rule, `probe references unknown rule kind "${kind}"`);
      for (const { needle } of probes) {
        assert.ok(
          applyMatcher(rule!.match, needle),
          `rule "${kind}" matcher does not match its real emitted needle "${needle}"`,
        );
      }
    }
  });
});

void describe('SourceMapper — deprecated HTML & meta refresh (B2 reach)', () => {
  void it('maps deprecated HTML elements to source (real emitted "… (N instances)" string)', () => {
    const root = fakeTree({ 'src/Old.tsx': 'export default ()=> <center><font size="3">hi</font></center>' });
    const m = SourceMapper.map({ 'Deprecated HTML elements found (2 instances)': 1 }, root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    assert.ok(JSON.stringify(m).includes('Old.tsx'), 'a lowercase <font>/<center> must resolve to a source location');
  });

  void it('does NOT flag a capitalised <Font> component as the deprecated <font> element', () => {
    const root = fakeTree({ 'src/C.tsx': 'import { Font } from "x";\nexport default ()=> <Font>hi</Font>' });
    const m = SourceMapper.map({ 'Deprecated HTML elements found (1 instances)': 1 }, root, { ...NEXT_FI });
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepStrictEqual(m, {}, 'a custom <Font> component is not the deprecated <font> DOM element');
  });

  void it('maps a meta refresh redirect — both JSX (httpEquiv) and raw HTML (http-equiv)', () => {
    const jsx = fakeTree({ 'src/R.tsx': 'export default ()=> <meta httpEquiv="refresh" content="0;url=/x" />' });
    const html = fakeTree({ 'src/p.html': '<head><meta http-equiv="refresh" content="5"></head>' });
    const mJsx = SourceMapper.map({ 'Page uses meta refresh redirect': 1 }, jsx, { ...NEXT_FI });
    const mHtml = SourceMapper.map({ 'Page uses delayed meta refresh': 1 }, html, { ...NEXT_FI });
    fs.rmSync(jsx, { recursive: true, force: true });
    fs.rmSync(html, { recursive: true, force: true });
    assert.ok(JSON.stringify(mJsx).includes('R.tsx'), 'JSX httpEquiv="refresh" must map');
    assert.ok(JSON.stringify(mHtml).includes('p.html'), 'raw http-equiv="refresh" must map');
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
    assert.strictEqual(isVolatileFinding('Large third-party payload'), true);
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

  void it('extracts a kind slug when present, leaves it undefined otherwise', () => {
    const withKind = parseAnomalies(
      '[{"title":"T","kind":"clutch-badge-403","evidence":"e","severity":"medium","section":"ux"}]',
      URL,
    );
    assert.strictEqual(withKind[0].kind, 'clutch-badge-403');
    const without = parseAnomalies('[{"title":"T","evidence":"e","severity":"medium","section":"ux"}]', URL);
    assert.strictEqual(without[0].kind, undefined);
  });
});

// Anomaly consolidation — one finding per defect class across pages
import { consolidateAnomalies } from '../lib/phase2/phase2-runner';
import type { Anomaly } from '../lib/phase2/llm-anomaly';

void describe('consolidateAnomalies', () => {
  const mk = (over: Partial<Anomaly>): Anomaly => ({
    section: 'ux',
    title: 'Some issue',
    severity: 'medium',
    url: 'https://example.com/a',
    evidence: 'e',
    recommendation: 'fix it',
    ...over,
  });

  void it('groups reworded titles sharing a kind into one finding with N occurrences', () => {
    const out = consolidateAnomalies([
      mk({ kind: 'clutch-badge-403', title: 'Clutch badges fail to load (403)', url: 'https://example.com/1' }),
      mk({ kind: 'clutch-badge-403', title: 'Four Clutch embeds return HTTP 403', url: 'https://example.com/2' }),
      mk({ kind: 'clutch-badge-403', title: 'Clutch trust badges 403 Forbidden', url: 'https://example.com/3' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 3);
    // Representative keeps the first item's title.
    assert.strictEqual(out[0].title, 'Clutch badges fail to load (403)');
  });

  void it('keeps the worst severity in the group as the representative', () => {
    const out = consolidateAnomalies([
      mk({ kind: 'k', severity: 'medium', url: 'https://example.com/1' }),
      mk({ kind: 'k', severity: 'high', url: 'https://example.com/2' }),
      mk({ kind: 'k', severity: 'low', url: 'https://example.com/3' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].severity, 'high');
  });

  void it('falls back to normalized title when kind is absent (older caches)', () => {
    const out = consolidateAnomalies([
      mk({ title: 'Contact form submits via GET (3 fields)', url: 'https://example.com/1' }),
      mk({ title: 'Contact form submits via GET (7 fields)', url: 'https://example.com/2' }),
    ]);
    // normalizeMessage strips the trailing "(N …)" so both titles collapse.
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 2);
  });

  void it('keeps distinct kinds with distinct titles separate', () => {
    const out = consolidateAnomalies([
      mk({ kind: 'a', title: 'Defect A', section: 'ux', url: 'https://example.com/1' }),
      mk({ kind: 'b', title: 'Defect B', section: 'ux', url: 'https://example.com/2' }),
    ]);
    assert.strictEqual(out.length, 2);
  });

  void it('merges identical titles even when the LLM assigned different kinds', () => {
    // The LLM sometimes files the SAME defect under inconsistent kind slugs
    // across pages (the contact-form-GET split). An identical normalized title
    // is a strong same-defect signal, so they still consolidate into one finding
    // rather than rendering as near-duplicate findings with split severities.
    const out = consolidateAnomalies([
      mk({ kind: 'contact-form-get', title: 'Contact form submits via GET', url: 'https://example.com/1' }),
      mk({ kind: 'contact-form-empty-action', title: 'Contact form submits via GET', url: 'https://example.com/2' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 2);
  });

  void it('bridges different kind slugs for one defect via kind-token overlap', () => {
    // The LLM emitted three slugs for the SAME empty-action GET form across
    // pages, each with a different title — neither exact-kind nor title labels
    // match, so only the Jaccard kind-token bridge (≥0.6) collapses them.
    const out = consolidateAnomalies([
      mk({
        kind: 'form-empty-action',
        title: 'Submission form has empty action and uses GET',
        url: 'https://example.com/1',
      }),
      mk({ kind: 'form-empty-action-get', title: 'Lead form submits to itself via GET', url: 'https://example.com/2' }),
      mk({ kind: 'contact-form-get-action', title: 'Footer form posts to empty action', url: 'https://example.com/3' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 3);
  });

  void it('does not over-merge related-but-distinct kinds below the overlap threshold', () => {
    // {link,broken,outbound} vs {link,broken,internal}: Jaccard 0.5 < 0.6 —
    // different defects, must stay separate.
    const out = consolidateAnomalies([
      mk({ kind: 'link-broken-outbound', title: 'Outbound links 404', url: 'https://example.com/1' }),
      mk({ kind: 'link-broken-internal', title: 'Internal links 404', url: 'https://example.com/2' }),
    ]);
    assert.strictEqual(out.length, 2);
  });

  void it('merges the same kind across sections into the dominant section', () => {
    const out = consolidateAnomalies([
      mk({ kind: 'form-get', section: 'ux', severity: 'high', url: 'https://example.com/1' }),
      mk({ kind: 'form-get', section: 'ux', severity: 'medium', url: 'https://example.com/2' }),
      mk({ kind: 'form-get', section: 'technical', severity: 'medium', url: 'https://example.com/3' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 3);
    // ux appears twice vs technical once → dominant section is ux.
    assert.strictEqual(out[0].section, 'ux');
    // worst severity across the group is kept.
    assert.strictEqual(out[0].severity, 'high');
  });

  void it('keeps title-fallback grouping section-scoped when kind is absent', () => {
    const out = consolidateAnomalies([
      mk({ title: 'Broken thing', section: 'ux', url: 'https://example.com/1' }),
      mk({ title: 'Broken thing', section: 'technical', url: 'https://example.com/2' }),
    ]);
    // No kind → conservative: different sections stay separate.
    assert.strictEqual(out.length, 2);
  });

  void it('de-duplicates occurrences by url and is order-stable', () => {
    const out = consolidateAnomalies([
      mk({ kind: 'k', url: 'https://example.com/dup' }),
      mk({ kind: 'k', url: 'https://example.com/dup' }),
      mk({ kind: 'k', url: 'https://example.com/other' }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].occurrences?.length, 2);
    assert.deepStrictEqual(
      out[0].occurrences?.map((o) => o.url),
      ['https://example.com/dup', 'https://example.com/other'],
    );
  });
});

import { isNextjsAudit } from '../lib/scoring/nextjs-recommendations';

void describe('isNextjsAudit (framework vs crawl fingerprint)', () => {
  void it('returns true for an explicit Next.js framework', () => {
    assert.strictEqual(isNextjsAudit('Next.js', []), true);
  });

  void it('uses the /_next/ fingerprint only when no --repo framework is known', () => {
    assert.strictEqual(isNextjsAudit(null, ['GET https://x.com/_next/static/chunk.js 200']), true);
    assert.strictEqual(isNextjsAudit(undefined, ['__NEXT_DATA__ present']), true);
    assert.strictEqual(isNextjsAudit('', ['no fingerprint here']), false);
  });

  void it('does NOT flip a non-Next repo to Next.js on a stray /_next/ URL', () => {
    // The bug: an 11ty/React source tree whose LIVE site links a /_next/ asset
    // was getting Next.js fix advice on top of src/_includes/*.html files.
    assert.strictEqual(isNextjsAudit('React', ['GET https://x.com/_next/static/chunk.js 200']), false);
    assert.strictEqual(isNextjsAudit('Astro', ['__NEXT_DATA__ leaked from an embed']), false);
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

  void it('consolidates same-route query variants into one finding and returns all broken URLs', () => {
    const mk = (wc: number, hash: string) =>
      page({ contentQuality: { wordCount: wc } as PageInfo['contentQuality'], contentHash: hash });
    const pages = {
      // unfiltered series: pages 2–3 are the broken tail
      'https://ex.com/insights/page/1': mk(900, 'a'),
      'https://ex.com/insights/page/2': mk(10, 'empty'),
      'https://ex.com/insights/page/3': mk(10, 'empty'),
      // SAME route, just a ?postType filter — same termination bug
      'https://ex.com/insights/page/1?postType=case-study': mk(900, 'b'),
      'https://ex.com/insights/page/2?postType=case-study': mk(9, 'empty2'),
      'https://ex.com/insights/page/3?postType=case-study': mk(9, 'empty2'),
    };
    const result = BrokenPaginationAnalyzer.analyzeSiteWide(pages as unknown as Record<string, PageInfo>);
    const crawlBudget = result.issues.filter((i) => /crawl budget/i.test(i.message ?? ''));
    assert.strictEqual(crawlBudget.length, 1, 'two query variants of one route must collapse to a single finding');
    assert.ok(/insights\/page\/\{N\}/.test(crawlBudget[0].message ?? ''));
    assert.ok(!/postType/.test(crawlBudget[0].message ?? ''), 'consolidated message uses the query-stripped route');
    assert.ok(/2 query variants/.test(crawlBudget[0].detail ?? ''), 'detail notes the variant count');
    // Both variants' tail URLs are returned so the orchestrator can suppress them elsewhere.
    assert.ok(result.brokenUrls.includes('https://ex.com/insights/page/2'));
    assert.ok(result.brokenUrls.includes('https://ex.com/insights/page/2?postType=case-study'));
  });
});

// ============================================================
// Soft404Analyzer — empty-listing / "no results" detection
// ============================================================
void describe('Soft404Analyzer empty-listing detection', () => {
  // Mock a Playwright page: #getBodyText calls evaluate(fn) with no 2nd arg;
  // #checkErrorElements calls evaluate(fn, selectors) WITH a 2nd arg → false.
  const mockChromePage = (bodyText: string) =>
    ({ evaluate: async (_fn: unknown, arg?: unknown) => (arg !== undefined ? false : bodyText) }) as never;
  const mockParsed = (h1: string) =>
    ({ querySelector: (sel: string) => (sel === 'h1' && h1 ? { textContent: h1 } : null) }) as never;
  const pageData = (wordCount: number, title = 'Siro Sales Insights | Page 7 | Siro') =>
    ({ status: 200, title, contentQuality: { wordCount }, metaMap: {} }) as never;

  void it('flags a thin empty-results listing page as a soft 404', async () => {
    const r = await Soft404Analyzer.analyze(
      mockChromePage('No insights found Try adjusting your filters or check back later for new insights.'),
      mockParsed('Insights'),
      'https://e.com/insights/page/7',
      pageData(19),
    );
    assert.strictEqual(r.soft404Data.isSoft404, true, 'empty listing + thin ⇒ soft 404');
    assert.ok(r.soft404Data.confidence >= 50, `confidence ${r.soft404Data.confidence} should clear 50`);
  });

  void it('does NOT flag a sparse-but-real listing (a guides index with one entry)', async () => {
    const r = await Soft404Analyzer.analyze(
      mockChromePage('Siro Guide The No-Nonsense Guide to Recording Field Sales and Service Conversations'),
      mockParsed('Guides'),
      'https://e.com/guides',
      pageData(17, 'Sales Guides | Siro'),
    );
    assert.strictEqual(r.soft404Data.isSoft404, false, 'real item text, no empty-state placeholder');
  });

  void it('does NOT flag a long article that merely mentions "no results" in prose', async () => {
    const r = await Soft404Analyzer.analyze(
      mockChromePage('When you search and get no results found, it can be frustrating. Here is a long guide ...'),
      mockParsed('How to handle empty searches'),
      'https://e.com/blog/empty-searches',
      pageData(800, 'How to handle empty searches'),
    );
    assert.strictEqual(r.soft404Data.isSoft404, false, 'thinness gate prevents a real article from being flagged');
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
    const findings = result.issues.filter((i) => /infinite scroll without pagination fallback/i.test(i.message ?? ''));
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

  void it('ignores an embedded example URL when categorizing (https:// must not match Security)', () => {
    // A finding message often ends with a cited URL. The `https://` scheme would
    // otherwise match the Security rule's `/\bHTTPS\b/` and misroute the score.
    assert.strictEqual(
      scoredCategoryOf('Broken pagination wastes crawl budget — https://www.siro.ai/insights/page/{N}'),
      'seo',
    );
    assert.strictEqual(scoredCategoryOf('Some pages have titles that are too long — https://example.com/about'), 'seo');
    // A genuine security finding that happens to cite a URL still routes to security.
    assert.strictEqual(scoredCategoryOf('Missing Permissions-Policy header — https://example.com/'), 'security');
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
import { PageIndex, verifyFinding, verifyDetails } from '../lib/phase3/finding-verifier';
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
    const ex =
      'The title "Shared Title" is used on 2 pages: <a href="https://e.com/a">a</a> <a href="https://e.com/b">b</a>';
    const r = verifyFinding('Some pages have duplicate title', detail([ex]), pages);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('refutes a duplicate-title claim when captured titles actually differ', () => {
    const pages = idx({
      'https://e.com/a': { title: 'Title One' },
      'https://e.com/b': { title: 'Title Two' },
    });
    const ex =
      'The title "Title One" is used on 2 pages: <a href="https://e.com/a">a</a> <a href="https://e.com/b">b</a>';
    const r = verifyFinding('Duplicate page titles found', detail([ex]), pages);
    assert.strictEqual(r.status, 'refuted');
  });

  void it('confirms a parameterized-URLs-share-a-title finding via the duplicate-title-param verifier', () => {
    const pages = idx({
      'https://e.com/insights/page/2': { title: 'Insights | Page 2' },
      'https://e.com/insights/page/2?postType=case-study': { title: 'Insights | Page 2' },
    });
    const ex =
      'The title "Insights | Page 2" is shared by 2 parameterized URLs of the same page: <a href="https://e.com/insights/page/2">a</a> <a href="https://e.com/insights/page/2?postType=case-study">b</a>';
    const r = verifyFinding('Parameterized URLs share a title', detail([ex]), pages);
    assert.strictEqual(r.status, 'confirmed');
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
    assert.strictEqual(
      verifyFinding('Image links without alt text', detail(['https://e.com/x']), some).status,
      'confirmed',
    );
    // 0 / absent → unchecked, NEVER refuted (the count is a broader proxy).
    assert.strictEqual(
      verifyFinding('Image links without alt text', detail(['https://e.com/x']), zero).status,
      'unchecked',
    );
    assert.strictEqual(
      verifyFinding('Image links without alt text', detail(['https://e.com/x']), absent).status,
      'unchecked',
    );
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
    const has = idx({
      'https://e.com/x': { anchorTextData: { emptyAnchors: ['/', '/'] } as PageInfo['anchorTextData'] },
    });
    const none = idx({ 'https://e.com/x': { anchorTextData: { emptyAnchors: [] } as PageInfo['anchorTextData'] } });
    const absent = idx({ 'https://e.com/x': {} });
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), has).status, 'confirmed');
    assert.strictEqual(
      verifyFinding('Links with empty anchor text', detail(['https://e.com/x']), has).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Some pages have links without any text', detail(['https://e.com/x']), has).status,
      'confirmed',
    );
    // confirm-only: 0 / absent → unchecked, NEVER refuted
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), none).status, 'unchecked');
    assert.strictEqual(verifyFinding('Empty anchor text', detail(['https://e.com/x']), absent).status, 'unchecked');
  });

  void it('does NOT treat "Multiple pages target the same keyword in their H1" as a multiple-h1 finding', () => {
    // Regression: keyword-cannibalisation is about distinct pages sharing a
    // keyword, not one page with several H1s. The single-page H1 count (0/1)
    // must not auto-drop it.
    const pages = idx({ 'https://e.com/x': { headings: { h1Count: 1 } as PageInfo['headings'] } });
    assert.strictEqual(
      verifyFinding('Multiple pages target the same keyword in their H1', detail(['https://e.com/x']), pages).status,
      'unchecked',
    );
  });

  void it('does NOT match other anchor findings as empty-anchor', () => {
    const pages = idx({ 'https://e.com/x': { anchorTextData: { emptyAnchors: [] } as PageInfo['anchorTextData'] } });
    assert.strictEqual(
      verifyFinding('Anchor text over-optimization detected', detail(['https://e.com/x']), pages).status,
      'unchecked',
    );
    assert.strictEqual(
      verifyFinding('Same anchor text links to different pages', detail(['https://e.com/x']), pages).status,
      'unchecked',
    );
  });

  void it('confirms oversized / legacy-format image findings from imageOptimization', () => {
    const over = idx({
      'https://e.com/x': {
        imageOptimization: { oversizedImages: [{}], legacyFormats: 0 } as PageInfo['imageOptimization'],
      },
    });
    const legacy = idx({
      'https://e.com/x': {
        imageOptimization: { oversizedImages: [], legacyFormats: 2 } as PageInfo['imageOptimization'],
      },
    });
    // The byte-size `oversizedImages` list backs the "image files larger than
    // recommended" message — NOT the display-scaling one (owned by live verifier).
    assert.strictEqual(
      verifyFinding('Pages have image files larger than recommended', detail(['https://e.com/x']), over).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Some images are significantly larger than their display size', detail(['https://e.com/x']), over)
        .status,
      'unchecked',
    );
    assert.strictEqual(
      verifyFinding('Pages serve images only as JPG/PNG instead of WebP/AVIF', detail(['https://e.com/x']), legacy)
        .status,
      'confirmed',
    );
  });

  void it('confirms unused-code / unused-css against codeCoverage, leaves within-bounds unchecked', () => {
    const heavy = idx({
      'https://e.com/x': {
        codeCoverage: { js: { unused: 600_000 }, css: { unused: 50_000, ratio: 70 } } as PageInfo['codeCoverage'],
      },
    });
    const light = idx({
      'https://e.com/x': {
        codeCoverage: { js: { unused: 1_000 }, css: { unused: 1_000, ratio: 5 } } as PageInfo['codeCoverage'],
      },
    });
    assert.strictEqual(
      verifyFinding('Large amount of unused code', detail(['https://e.com/x']), heavy).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('High percentage of unused CSS', detail(['https://e.com/x']), heavy).status,
      'confirmed',
    );
    // confirm-only → within bounds stays unchecked, not refuted
    assert.strictEqual(
      verifyFinding('Large amount of unused code', detail(['https://e.com/x']), light).status,
      'unchecked',
    );
    assert.strictEqual(
      verifyFinding('High percentage of unused CSS', detail(['https://e.com/x']), light).status,
      'unchecked',
    );
  });

  void it('confirms render-blocking / dom-children / third-party payload from persisted metrics', () => {
    const p = idx({
      'https://e.com/x': {
        resourceOptimization: { renderBlocking: { totalBlocking: 9 } } as PageInfo['resourceOptimization'],
        domComplexityData: { maxChildren: 90, totalNodes: 1200 } as PageInfo['domComplexityData'],
        thirdPartyData: { totalSize: 900_000 } as PageInfo['thirdPartyData'],
      },
    });
    assert.strictEqual(
      verifyFinding('Some pages have too many render-blocking resources', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Element with too many children', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(verifyFinding('Excessive DOM size', detail(['https://e.com/x']), p).status, 'confirmed');
    assert.strictEqual(
      verifyFinding('Large third-party payload', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
  });

  void it('does NOT match render-blocking THIRD-PARTY scripts as the generic render-blocking kind', () => {
    const p = idx({
      'https://e.com/x': {
        resourceOptimization: { renderBlocking: { totalBlocking: 0 } } as PageInfo['resourceOptimization'],
      },
    });
    // This finding is about third-party scripts specifically → left for the LLM/CLI pass.
    assert.strictEqual(
      verifyFinding('Render-blocking third-party scripts', detail(['https://e.com/x']), p).status,
      'unchecked',
    );
  });

  void it('confirms tracking-before-consent from consentData, never refutes', () => {
    const has = idx({
      'https://e.com/x': {
        consentData: {
          trackingBeforeConsent: ['googletagmanager.com'],
          cookiesBeforeConsent: [],
        } as unknown as PageInfo['consentData'],
      },
    });
    const none = idx({
      'https://e.com/x': {
        consentData: { trackingBeforeConsent: [], cookiesBeforeConsent: [] } as unknown as PageInfo['consentData'],
      },
    });
    assert.strictEqual(
      verifyFinding('Multiple tracking cookies set before consent', detail(['https://e.com/x']), has).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Multiple tracking cookies set before consent', detail(['https://e.com/x']), none).status,
      'unchecked',
    );
  });

  void it('confirms color-contrast AAA vs AA against colorContrastData without cross-matching', () => {
    const p = idx({
      'https://e.com/x': { colorContrastData: { aaFailures: 5, aaaFailures: 20 } as PageInfo['colorContrastData'] },
    });
    // "passes AA but fails AAA" → AAA reader (must NOT hit the AA matcher despite containing "AA")
    assert.strictEqual(
      verifyFinding('Color contrast passes AA but fails AAA (20 elements)', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    // "fails WCAG AA" → AA reader
    assert.strictEqual(
      verifyFinding('Color contrast fails WCAG AA (5 elements)', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    // 0 failures → confirm-only stays unchecked
    const none = idx({
      'https://e.com/x': { colorContrastData: { aaFailures: 0, aaaFailures: 0 } as PageInfo['colorContrastData'] },
    });
    assert.strictEqual(
      verifyFinding('Color contrast passes AA but fails AAA (3 elements)', detail(['https://e.com/x']), none).status,
      'unchecked',
    );
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
    assert.strictEqual(
      verifyFinding('External scripts missing Subresource Integrity (SRI)', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Missing Permissions-Policy header', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Missing cross-origin isolation headers', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('No prefers-reduced-motion CSS support', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Form inputs missing autocomplete attribute', detail(['https://e.com/x']), p).status,
      'confirmed',
    );
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
      'https://e.com/a': {
        description: 'EasyCare and Siro show how EasyCoach uses AI to analyze calls and coach reps',
      },
      'https://e.com/b': {
        description: 'EasyCare and Siro show how EasyCoach uses AI to analyze calls and coach reps',
      },
    });
    const dex =
      'Description "EasyCare and Siro show how EasyCoach uses AI to an..." is duplicated for this page <a href="https://e.com/a">a</a>';
    assert.strictEqual(
      verifyFinding('Some pages have identical descriptions', detail([dex]), dpages).status,
      'confirmed',
    );
  });

  void it('reads too-many-h2 from the persisted h2Count field (confirm-only)', () => {
    const over = idx({ 'https://e.com/x': { headings: { h2Count: 17 } as PageInfo['headings'] } });
    const under = idx({ 'https://e.com/x': { headings: { h2Count: 2 } as PageInfo['headings'] } });
    assert.strictEqual(
      verifyFinding('Some pages have more than 10 h2 tags', detail(['https://e.com/x']), over).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Some pages have more than 10 h2 tags', detail(['https://e.com/x']), under).status,
      'unchecked',
    );
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
      depthFromHome: new Map<string, number>([
        ['https://e.com', 0],
        ['https://e.com/deep', 22],
      ]),
      robotsDisallow: ['/admin/*'],
      robotsUserAgents: ['*'],
      sitemapUrls: new Set<string>(),
      sitemapCapped: false,
    };
    assert.strictEqual(
      verifyFinding('Orphan page (no internal links point to it)', detail(['https://e.com/orphan']), pages, site)
        .status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Page unreachable from homepage via internal links', detail(['https://e.com/orphan']), pages, site)
        .status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Page is more than 4 clicks from homepage', detail(['https://e.com/deep']), pages, site).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Page has very low internal link equity', detail(['https://e.com/low']), pages, site).status,
      'confirmed',
    );
    // No SiteData → unchecked, never a false drop
    assert.strictEqual(
      verifyFinding('Orphan page (no internal links point to it)', detail(['https://e.com/orphan']), pages).status,
      'unchecked',
    );
  });

  void it('confirms robots.txt findings from SiteData', () => {
    const pages = idx({ 'https://e.com/': {} });
    const site = {
      incoming: new Map<string, string[]>(),
      depthFromHome: new Map<string, number>(),
      robotsDisallow: ['/admin/*'],
      robotsUserAgents: ['*'],
      sitemapUrls: new Set<string>(),
      sitemapCapped: false,
    };
    assert.strictEqual(
      verifyFinding('Sensitive paths exposed in robots.txt', detail(['/admin']), pages, site).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Pattern matching characters used in robots.txt', detail(['/admin/*']), pages, site).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('No explicit AI crawler rules in robots.txt', detail(['x']), pages, site).status,
      'confirmed',
    );
    // When GPTBot IS named → the AI-rules finding is left unchecked (not confirmed)
    const withAi = { ...site, robotsUserAgents: ['*', 'gptbot'] };
    assert.strictEqual(
      verifyFinding('No explicit AI crawler rules in robots.txt', detail(['x']), pages, withAi).status,
      'unchecked',
    );
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
      sitemapCapped: false,
    };
    // Example cites an uncrawled sitemap URL
    assert.strictEqual(
      verifyFinding('Sitemap URLs were not successfully crawled', detail(['https://e.com/ghost']), pages, site).status,
      'confirmed',
    );
    // Count-only finding (no URL) → site-level fallback counts /b
    assert.strictEqual(
      verifyFinding(
        'Indexable pages missing from sitemap',
        detail(['45 indexable page(s) are not listed in the sitemap']),
        pages,
        site,
      ).status,
      'confirmed',
    );
    // …but when the sitemap set may be capped/incomplete, the count-only
    // fallback must stay unchecked rather than risk a false "not listed".
    const cappedSite = { ...site, sitemapCapped: true };
    assert.strictEqual(
      verifyFinding(
        'Indexable pages missing from sitemap',
        detail(['45 indexable page(s) are not listed in the sitemap']),
        pages,
        cappedSite,
      ).status,
      'unchecked',
    );
  });

  void it('confirms too-many-fonts from fontData.totalFonts', () => {
    const many = idx({ 'https://e.com/x': { fontData: { totalFonts: 7 } as PageInfo['fontData'] } });
    const few = idx({ 'https://e.com/x': { fontData: { totalFonts: 2 } as PageInfo['fontData'] } });
    assert.strictEqual(
      verifyFinding('Too many font files loaded', detail(['https://e.com/x']), many).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Too many font files loaded', detail(['https://e.com/x']), few).status,
      'unchecked',
    );
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
    assert.strictEqual(
      verifyFinding('Canonicals are not set for some pages', detail(['https://e.com/x']), pages).status,
      'confirmed',
    );
  });

  void it('still UNCHECKED when the page was not analyzed (no indexability)', () => {
    const pages = idx({ 'https://e.com/x': {} });
    assert.strictEqual(
      verifyFinding('Canonicals are not set for some pages', detail(['https://e.com/x']), pages).status,
      'unchecked',
    );
  });

  void it('confirms missing-description on an analyzed page with no description', () => {
    const pages = idx({ 'https://e.com/x': { ...analyzed } });
    assert.strictEqual(
      verifyFinding('Description meta tag is missing', detail(['https://e.com/x']), pages).status,
      'confirmed',
    );
  });

  void it('reads noindex from indexability.hasNoindexTag (confirm) and can refute', () => {
    const yes = idx({ 'https://e.com/x': { indexability: { hasNoindexTag: true } } as Partial<PageInfo> });
    const no = idx({ 'https://e.com/x': { indexability: { hasNoindexTag: false } } as Partial<PageInfo> });
    const unknown = idx({ 'https://e.com/x': {} });
    assert.strictEqual(
      verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), yes).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), no).status,
      'refuted',
    );
    assert.strictEqual(
      verifyFinding('Pages in sitemap are marked noindex', detail(['https://e.com/x']), unknown).status,
      'unchecked',
    );
  });

  void it('reads redirect from hasRedirects (confirm) and refutes when not redirecting', () => {
    const yes = idx({ 'https://e.com/x': { hasRedirects: true, redirectCount: 1 } });
    const no = idx({ 'https://e.com/x': { hasRedirects: false, redirectCount: 0 } });
    assert.strictEqual(verifyFinding('3xx redirects in sitemap', detail(['https://e.com/x']), yes).status, 'confirmed');
    assert.strictEqual(verifyFinding('3xx redirects in sitemap', detail(['https://e.com/x']), no).status, 'refuted');
  });

  void it('verifies soft-404 from the persisted soft404 block', () => {
    const yes = idx({
      'https://e.com/x': { soft404: { isSoft404: true, confidence: 80, signals: [] } } as Partial<PageInfo>,
    });
    const no = idx({
      'https://e.com/x': { soft404: { isSoft404: false, confidence: 0, signals: [] } } as Partial<PageInfo>,
    });
    assert.strictEqual(verifyFinding('Soft 404 page', detail(['https://e.com/x']), yes).status, 'confirmed');
    assert.strictEqual(verifyFinding('Soft 404 page', detail(['https://e.com/x']), no).status, 'refuted');
  });
});

void describe('finding-verifier — threshold & boolean verifiers', () => {
  void it('confirms a CWV finding when the stored metric breaches the threshold, refutes when not', () => {
    const bad = idx({ 'https://e.com/x': { LCP: 4000 } });
    const ok = idx({ 'https://e.com/x': { LCP: 1800 } });
    const none = idx({ 'https://e.com/x': {} });
    assert.strictEqual(
      verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), bad).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), ok).status,
      'refuted',
    );
    assert.strictEqual(
      verifyFinding('Some pages have LCP more than 2500ms', detail(['https://e.com/x']), none).status,
      'unchecked',
    );
  });

  void it('does NOT match a non-threshold metric mention ("LCP image not preloaded")', () => {
    const pages = idx({ 'https://e.com/x': { LCP: 1000 } });
    assert.strictEqual(
      verifyFinding('LCP image not preloaded', detail(['https://e.com/x']), pages).status,
      'unchecked',
    );
  });

  void it('verifies title/description length against the same bar the analyzer used', () => {
    const longTitle = idx({ 'https://e.com/x': { titleLength: 72 } });
    const shortTitle = idx({ 'https://e.com/x': { titleLength: 20 } });
    assert.strictEqual(
      verifyFinding('Some pages have titles that are too long', detail(['https://e.com/x']), longTitle).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Some pages have titles that are too long', detail(['https://e.com/x']), shortTitle).status,
      'refuted',
    );
    // "too short" must not fire on a 0-length (that's "missing", a different finding).
    const zero = idx({ 'https://e.com/x': { titleLength: 0 } });
    assert.strictEqual(
      verifyFinding('Some pages have titles that are too short', detail(['https://e.com/x']), zero).status,
      'refuted',
    );
  });

  void it('thin content is confirm-only (never refutes — the analyzer bar varies)', () => {
    const thin = idx({ 'https://e.com/x': { contentQuality: { wordCount: 50 } as PageInfo['contentQuality'] } });
    const fat = idx({ 'https://e.com/x': { contentQuality: { wordCount: 1200 } as PageInfo['contentQuality'] } });
    assert.strictEqual(
      verifyFinding('Page has very thin content', detail(['https://e.com/x']), thin).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyFinding('Page has very thin content', detail(['https://e.com/x']), fat).status,
      'unchecked',
    );
  });

  void it('verifies console errors and per-page broken outbound links', () => {
    const errs = idx({
      'https://e.com/x': { consoleAnalysis: { errorCount: 3, warningCount: 0 } as PageInfo['consoleAnalysis'] },
    });
    assert.strictEqual(
      verifyFinding('JavaScript console errors detected', detail(['https://e.com/x']), errs).status,
      'confirmed',
    );
    const broken = idx({
      'https://e.com/x': {
        outboundLinkHealth: { broken: [{ url: 'x' }] } as unknown as PageInfo['outboundLinkHealth'],
      },
    });
    assert.strictEqual(
      verifyFinding('Page has 2 broken outbound link(s)', detail(['https://e.com/x']), broken).status,
      'confirmed',
    );
  });
});

// ============================================================
// LLM finding-verify — pure parsing + signal collection
// ============================================================
import { parseLlmVerdicts, extractCliResult } from '../lib/phase3/llm-finding-verify';
import { buildPageSignals, collectUncheckedContexts } from '../lib/phase3/finding-verifier';

void describe('llm finding-verify parsing', () => {
  void it('keeps only known indices and normalizes unknown verdicts to unsure', () => {
    const raw =
      '```json\n{"verdicts":[{"index":0,"verdict":"confirmed","reason":"ok"},{"index":1,"verdict":"weird"},{"index":9,"verdict":"refuted"}]}\n```';
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
    const env = JSON.stringify({
      type: 'result',
      result: '{"verdicts":[{"index":0,"verdict":"confirmed"}]}',
      is_error: false,
    });
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
      'Duplicate page titles found': {
        severity: 'high',
        count: 2,
        examples: ['t "A" used on 2: https://e.com/x https://e.com/y'],
      },
    };
    const summary = verifyDetails(details, idxObj);
    const ctxs = collectUncheckedContexts(details, summary.results, idxObj);
    assert.ok(
      ctxs.some((c) => c.key === 'Content may lack topical focus'),
      'unchecked finding is collected',
    );
    assert.ok(
      ctxs.every((c) => c.message && c.example),
      'each context has message + example',
    );
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

  void it('keeps all severities including LOW', () => {
    assert.ok(findings.some((f) => f.title === 'Canonicals are not set for some pages'));
    const low = findings.find((f) => f.title === 'Minor cosmetic thing');
    assert.ok(low, 'LOW finding kept');
    assert.strictEqual(low?.severity, 'LOW');
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

import {
  checkFindingSignals,
  brokenOutboundVerdict,
  titleDescriptionVerdict,
  sharedTitleKeyword,
  resolveSiteOrigin,
  cannibalisationElement,
  type LiveSignals,
} from '../lib/phase3/live-verifier';

void describe('live-verifier: checker refute contract', () => {
  // A clean baseline page (no defects present at load).
  const base: LiveSignals = {
    url: 'https://x.example/',
    finalUrl: 'https://x.example/',
    status: 200,
    ttfbMs: 100,
    htmlBytes: 1000,
    totalBytes: 1000,
    totalRequests: 1,
    title: 'T',
    description: 'd',
    canonical: 'https://x.example/',
    h1Count: 1,
    iframeCount: 0,
    wordCount: 800,
    semanticRatio: 0.5,
    emptyAnchorCount: 0,
    inputsWithoutAutocomplete: 0,
    selfPostGetForms: 0,
    scriptsNoSri: 0,
    maxChildren: 5,
    jpgPngImages: 0,
    modernImages: 2,
    renderBlockingTotal: 0,
    renderBlockingThirdParty: 0,
    thirdPartyOrigins: 0,
    thirdPartyRequests: 0,
    thirdPartyBytes: 0,
    adScriptBytes: 0,
    largestImageBytes: 0,
    oversizedImages: 0,
    clsValue: 0,
    tbtMs: 0,
    unusedCssRatio: -1,
    unusedJsRatio: -1,
    preConsentTrackingCookies: 0,
    contrastViolations: -1,
    mainCount: 1,
    resourceHintCount: 2,
    privacyLinkCount: 1,
    tlsMs: 50,
    eeatSignals: 2,
    headers: {},
    htmlLang: 'en',
    inlineCssBytes: 0,
    inputsWithoutLabel: 0,
    duplicateHreflang: 0,
    jsonLdBlocks: 1,
    hasSocialTags: true,
    imageCount: 0,
    lazyImageCount: 0,
    videoCount: 0,
    hasVideoObjectSchema: false,
    videosWithoutCaptions: 0,
    videosWithoutPoster: 0,
    videosWithoutTitle: 0,
    autoplayVideosNoControls: 0,
    hasManifestLink: false,
    hasThemeColor: false,
    hasAppleTouchIcon: false,
    hasNoscript: false,
    h2Count: 0,
    inlineJsBytes: 0,
    httpInternalLinks: 0,
    redirectStatuses: [],
    hasHeadingSkip: false,
    textHtmlRatio: 0.5,
    hasFreshnessSignal: false,
    internalLinkCount: 5,
    lcpMs: 0,
    fcpMs: 0,
    fontRequests: 0,
    fontBytes: 0,
    consoleErrors: 0,
    hasAuthorByline: true,
    redirectCount: 0,
    hasImagePreload: true,
    totalLinkCount: 10,
    affiliateLinksNoRel: 0,
    hasNoindexMeta: false,
    totalImageBytes: 0,
  };

  void it('autocomplete is confirm-only: 0 inputs at load → unverified, NOT refuted (forms can mount on interaction)', () => {
    const r = checkFindingSignals('Form inputs missing autocomplete attribute', base, 1);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('autocomplete confirms when inputs without autocomplete are present at load', () => {
    const r = checkFindingSignals(
      'Form inputs missing autocomplete attribute',
      { ...base, inputsWithoutAutocomplete: 4 },
      1,
    );
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

  // ---- tranche-1 gap closers: redirect-chain, canonical-mismatch, lcp-preload ----

  void it('canonical-mismatch confirms when the live canonical differs from the page URL', () => {
    const r = checkFindingSignals(
      "Some loc and canonical don't match",
      { ...base, url: 'https://x.example/a', finalUrl: 'https://x.example/a', canonical: 'https://x.example/b' },
      1,
    );
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('canonical-mismatch refutes when canonical matches the page URL (single occurrence)', () => {
    const r = checkFindingSignals(
      "Some loc and canonical don't match",
      { ...base, url: 'https://x.example/a', finalUrl: 'https://x.example/a', canonical: 'https://x.example/a/' },
      1,
    );
    assert.strictEqual(r.status, 'refuted'); // trailing-slash-only difference is normalized away
  });

  void it('canonical-mismatch is plural-guarded: a clean first page on a multi-occurrence finding does not drop it', () => {
    const r = checkFindingSignals(
      "Some loc and canonical don't match",
      { ...base, url: 'https://x.example/a', finalUrl: 'https://x.example/a', canonical: 'https://x.example/a' },
      5,
    );
    assert.strictEqual(r.status, 'unverified');
  });

  void it('canonical-mismatch with no canonical is inconclusive (that is the missing-canonical finding), never a refute', () => {
    const r = checkFindingSignals("Some loc and canonical don't match", { ...base, canonical: null }, 1);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('redirect-chain confirms when ≥2 redirect hops were followed', () => {
    const r = checkFindingSignals('Multiple redirects detected', { ...base, redirectCount: 3 }, 1);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('redirect-chain is confirm-only: a short chain on this fetch stays unverified, never refuted', () => {
    // count=1 so the plural guard is NOT what produces unverified — the checker itself must.
    const r = checkFindingSignals('Pages sit behind a long redirect chain', { ...base, redirectCount: 0 }, 1);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('lcp-preload confirms when the (homepage) page has no LCP-image preload', () => {
    const r = checkFindingSignals('LCP images not preloaded across site', { ...base, hasImagePreload: false }, 1);
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('lcp-preload is confirm-only: a homepage WITH an image preload cannot refute the site-wide claim', () => {
    const r = checkFindingSignals('LCP images not preloaded across site', { ...base, hasImagePreload: true }, 1);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('session-id confirms when the cited URL carries a real session-id query param', () => {
    const r = checkFindingSignals(
      'Session ID detected in URL',
      { ...base, url: 'https://x.example/p?sid=ABC123', finalUrl: 'https://x.example/p?sid=ABC123' },
      1,
    );
    assert.strictEqual(r.status, 'confirmed');
  });

  void it('session-id refutes the "resident/residential" substring false positive (no real session param)', () => {
    const r = checkFindingSignals(
      'Session ID detected in URL',
      { ...base, url: 'https://x.example/contractors/sector/residential/', finalUrl: 'https://x.example/x' },
      1,
    );
    assert.strictEqual(r.status, 'refuted');
  });

  void it('too-many-links confirms over the threshold and is confirm-only under it (links can hydrate)', () => {
    assert.strictEqual(
      checkFindingSignals('Too many on-page links', { ...base, totalLinkCount: 400 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Too many on-page links', { ...base, totalLinkCount: 10 }, 1).status,
      'unverified',
    );
  });

  void it('affiliate-link confirms when unmarked affiliate links are present, confirm-only when absent', () => {
    assert.strictEqual(
      checkFindingSignals('Affiliate link without sponsored/nofollow', { ...base, affiliateLinksNoRel: 3 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Affiliate link without sponsored/nofollow', { ...base, affiliateLinksNoRel: 0 }, 1).status,
      'unverified',
    );
  });

  // ---- tranche-2: matcher widening + new stable checkers ----

  void it('form-labels matcher now owns the "placeholder as their only label" and "fields lack <label>" wordings', () => {
    for (const t of [
      'Contact form inputs use placeholder as their only label',
      'Form fields lack `<label>` and grouping semantics',
    ]) {
      assert.doesNotMatch(checkFindingSignals(t, base, 1).reason, /no live checker/i, `"${t}" should be owned`);
      // present signal → confirmed (routes to form-labels, not some refuting checker)
      assert.strictEqual(checkFindingSignals(t, { ...base, inputsWithoutLabel: 2 }, 1).status, 'confirmed', t);
    }
  });

  void it('missing-description confirms when no meta description, refutes when present (single occurrence)', () => {
    assert.strictEqual(
      checkFindingSignals('Description meta tag is missing', { ...base, description: null }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Description meta tag is missing', { ...base, description: 'present' }, 1).status,
      'refuted',
    );
  });

  void it('missing-description does NOT steal the description-length "too long/short" findings', () => {
    // A "too long" finding must route to description-length and CONFIRM on a 400-char
    // description — proving it didn't fall through to missing-description (which would
    // refute on a present description).
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have descriptions that are too long',
        { ...base, description: 'x'.repeat(400) },
        1,
      ).status,
      'confirmed',
    );
  });

  void it('noindex confirms on a meta-robots noindex and on an X-Robots-Tag header, refutes when neither', () => {
    assert.strictEqual(
      checkFindingSignals('Pages in sitemap are marked noindex', { ...base, hasNoindexMeta: true }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Pages in sitemap are marked noindex', { ...base, headers: { 'x-robots-tag': 'noindex' } }, 1)
        .status,
      'confirmed',
    );
    assert.strictEqual(checkFindingSignals('Pages in sitemap are marked noindex', base, 1).status, 'refuted');
  });

  // ---- tier-a: matcher widening for kinds surfaced once LOW is live-checked ----

  void it('duplicate matcher owns the "identical titles/descriptions" wording (not just "duplicate")', () => {
    for (const t of [
      'Some pages have identical titles',
      'Some pages have identical descriptions',
      'Pages have identical meta descriptions',
    ]) {
      assert.doesNotMatch(checkFindingSignals(t, base, 2).reason, /no live checker/i, `"${t}" should be owned`);
    }
  });

  void it('form-empty-action checker owns "Form submits to itself via GET" (confirm-only, never refutes)', () => {
    const t = 'Form submits to itself via GET';
    // Owned — not the "no live checker" fallback (CLAUDE.md invariant).
    assert.doesNotMatch(checkFindingSignals(t, base, 1).reason, /no live checker/i, `"${t}" should be owned`);
    // Present at load → confirmed.
    assert.strictEqual(checkFindingSignals(t, { ...base, selfPostGetForms: 1 }, 1).status, 'confirmed');
    // Absent at load → unverified (forms can hydrate), NOT refuted.
    assert.strictEqual(checkFindingSignals(t, { ...base, selfPostGetForms: 0 }, 1).status, 'unverified');
  });

  void it('near-duplicate-content matcher owns the "very similar content" wording', () => {
    for (const t of ['Pages have very similar content', 'A notable share of pages have highly similar content']) {
      assert.doesNotMatch(checkFindingSignals(t, base, 2).reason, /no live checker/i, `"${t}" should be owned`);
    }
  });

  void it('url-case checker confirms uppercase in the URL path and refutes an all-lowercase URL', () => {
    const t = 'URL contains uppercase letters';
    assert.doesNotMatch(checkFindingSignals(t, base, 1).reason, /no live checker/i, 'url-case should be owned');
    assert.strictEqual(
      checkFindingSignals(t, { ...base, url: 'https://x.example/Foo/Bar' }, 1).status,
      'confirmed',
      'uppercase path → confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(t, { ...base, url: 'https://x.example/foo/bar' }, 1).status,
      'refuted',
      'lowercase path → refuted',
    );
  });

  // ---- tier-b: new signal-backed checkers ----

  void it('h2-count confirms > threshold and refutes at/under it', () => {
    const t = 'Some pages have more than 10 h2 tags';
    assert.strictEqual(checkFindingSignals(t, { ...base, h2Count: 14 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals(t, { ...base, h2Count: 4 }, 1).status, 'refuted');
  });

  void it('inline-js confirms over the byte threshold (confirm-only under it)', () => {
    const t = 'Large amount of inline JavaScript';
    assert.doesNotMatch(checkFindingSignals(t, base, 1).reason, /no live checker/i);
    assert.strictEqual(checkFindingSignals(t, { ...base, inlineJsBytes: 80_000 }, 1).status, 'confirmed');
    assert.strictEqual(checkFindingSignals(t, { ...base, inlineJsBytes: 1_000 }, 1).status, 'unverified');
  });

  void it('PWA / head presence checkers confirm on absence and refute on presence', () => {
    const cases: [string, keyof LiveSignals][] = [
      ['No web app manifest', 'hasManifestLink'],
      ['No theme-color meta tag', 'hasThemeColor'],
      ['No Apple touch icon', 'hasAppleTouchIcon'],
      ['No noscript fallback content', 'hasNoscript'],
    ];
    for (const [t, field] of cases) {
      assert.strictEqual(checkFindingSignals(t, base, 1).status, 'confirmed', `${t} → confirmed when absent`);
      assert.strictEqual(
        checkFindingSignals(t, { ...base, [field]: true }, 1).status,
        'refuted',
        `${t} → refuted when present`,
      );
    }
  });

  void it('video poster/title/autoplay + http-internal-links confirm when present (confirm-only)', () => {
    assert.strictEqual(
      checkFindingSignals('Videos without poster image', { ...base, videosWithoutPoster: 2 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Videos without accessible title', { ...base, videosWithoutTitle: 1 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Autoplay video without pause controls', { ...base, autoplayVideosNoControls: 1 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Internal links use HTTP instead of HTTPS', { ...base, httpInternalLinks: 3 }, 1).status,
      'confirmed',
    );
    // confirm-only: none-at-load stays unverified, never refuted
    assert.strictEqual(
      checkFindingSignals('Videos without poster image', { ...base, videosWithoutPoster: 0 }, 1).status,
      'unverified',
    );
  });

  // ---- tier-c: deferred-floor kinds now owned (confirm / refute / site-level relabel) ----

  void it('redirect checkers confirm on a live redirect (confirm-only, never refute)', () => {
    assert.strictEqual(
      checkFindingSignals('Requested URLs redirect before serving the page', { ...base, redirectCount: 1 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Requested URLs redirect before serving the page', { ...base, redirectCount: 0 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Temporary redirect used instead of permanent', { ...base, redirectStatuses: [302] }, 1)
        .status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Temporary redirect used instead of permanent', { ...base, redirectStatuses: [301] }, 1)
        .status,
      'unverified',
    );
  });

  void it('skipped-heading + freshness confirm/refute on the rendered document', () => {
    assert.strictEqual(
      checkFindingSignals('Some pages have incorrect h tags structure: preceding tag h2 is missing', {
        ...base,
        hasHeadingSkip: true,
      }).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have incorrect h tags structure: preceding tag h2 is missing', {
        ...base,
        hasHeadingSkip: false,
      }).status,
      'refuted',
    );
    // freshness is CONFIRM-ONLY: the live DOM signal (incl. bare <time>) is broader
    // than FreshnessAnalyzer's structured-date definition, so it must never refute.
    assert.strictEqual(
      checkFindingSignals('No content freshness signals found', { ...base, hasFreshnessSignal: false }).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('No content freshness signals found', { ...base, hasFreshnessSignal: true }).status,
      'unverified',
    );
    // a Last-Modified header alone (no DOM signal) → not "no freshness" → unverified, never confirmed
    assert.strictEqual(
      checkFindingSignals('No content freshness signals found', {
        ...base,
        hasFreshnessSignal: false,
        headers: { 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
      }).status,
      'unverified',
    );
  });

  void it('text-to-HTML ratio confirms when low (confirm-only)', () => {
    assert.strictEqual(
      checkFindingSignals('Low text-to-HTML ratio', { ...base, textHtmlRatio: 0.05 }).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Low text-to-HTML ratio', { ...base, textHtmlRatio: 0.6 }).status,
      'unverified',
    );
  });

  void it('click-depth wording and cross-page aggregates are owned (site-level, not "no live checker")', () => {
    for (const t of [
      'Page is more than 4 clicks from homepage',
      'Low anchor text diversity',
      'Significant internal linking opportunities',
      'Most pages lack freshness signals',
    ]) {
      const r = checkFindingSignals(t, base, 1);
      assert.doesNotMatch(r.reason, /no live checker/i, `"${t}" should be owned`);
      assert.strictEqual(r.status, 'unverified', `"${t}" is a site-level non-decision`);
    }
  });

  void it('total-image-size confirms over the threshold, confirm-only under it (lazy images)', () => {
    assert.strictEqual(
      checkFindingSignals('Some pages have excessive total image size', { ...base, totalImageBytes: 50_000_000 }, 1)
        .status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have excessive total image size', { ...base, totalImageBytes: 1000 }, 1).status,
      'unverified',
    );
  });

  // ---- registry-gap closers: every category-A finding kind is now OWNED ----

  void it('title-length confirms a too-short title and refutes one within range', () => {
    assert.strictEqual(
      checkFindingSignals('Some pages have titles that are too short', { ...base, title: 'short' }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have titles that are too short',
        { ...base, title: 'A perfectly adequate descriptive page title' },
        1,
      ).status,
      'refuted',
    );
  });

  void it('description-length confirms a too-long description and refutes one within range', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have descriptions that are too long',
        { ...base, description: 'x'.repeat(365) },
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have descriptions that are too long',
        { ...base, description: 'y'.repeat(140) },
        1,
      ).status,
      'refuted',
    );
  });

  void it('title/description length checkers do NOT own headline/manifest "too long" findings — locks matcher scope', () => {
    // These real corpus messages contain "too long" but neither "title" nor
    // "description" (nor "url"), so they must fall through, never be refuted
    // against the page's title/description length.
    for (const t of ['Article headline too long for rich results', 'Manifest name too long']) {
      const r = checkFindingSignals(t, { ...base, title: 'short', description: 'x'.repeat(400) }, 1);
      assert.notStrictEqual(r.status, 'refuted', `"${t}" must not be refuted by a length checker`);
      assert.match(r.reason, /no live checker/i, `"${t}" should not route to title/description-length`);
    }
  });

  void it('url-length owns URL "too long" findings — judged on the URL, NOT the page title/description', () => {
    const longUrl = `https://x.example/${'a'.repeat(150)}`;
    for (const t of ['Some URLs are too long', 'URL is too long (120 chars, max recommended: 100)']) {
      // A short title + long description must not influence the verdict: the URL
      // is what's measured. With a 150+ char sampled URL the checker confirms.
      const r = checkFindingSignals(
        t,
        { ...base, url: longUrl, finalUrl: longUrl, title: 'short', description: 'x'.repeat(400) },
        1,
      );
      assert.strictEqual(r.status, 'confirmed', `"${t}" should be owned by url-length and confirm on a long URL`);
      assert.match(r.reason, /url is \d+ chars/i, `"${t}" must be judged on URL length, not title/description`);
    }
    // A short URL refutes — proving the verdict tracks the URL, not the long description.
    assert.strictEqual(
      checkFindingSignals(
        'Some URLs are too long',
        { ...base, url: 'https://x.example/a', finalUrl: 'https://x.example/a', description: 'x'.repeat(400) },
        1,
      ).status,
      'refuted',
    );
  });

  void it('url-length checkers use the right basis per finding: per-page = path+query vs RECOMMENDED, site-wide = full-URL vs MAX', () => {
    // A long-origin / short-path URL: full length ≫ 100 but path+query = 8 (≤ 75).
    const longOriginShortPath = `https://shop.${'x'.repeat(90)}.example.com/p?ref=x`;
    // Site-wide "Some URLs are too long" (url-architecture-analyzer basis: full URL > 100) → confirmed.
    assert.strictEqual(
      checkFindingSignals(
        'Some URLs are too long',
        { ...base, url: longOriginShortPath, finalUrl: longOriginShortPath },
        1,
      ).status,
      'confirmed',
    );
    // Per-page "URL is too long" (analyzer basis: path+query > 75) on the SAME URL → refuted (short path).
    assert.strictEqual(
      checkFindingSignals(
        'URL is too long (short path here)',
        { ...base, url: longOriginShortPath, finalUrl: longOriginShortPath },
        1,
      ).status,
      'refuted',
    );
  });

  void it('url-length / url-depth measure the SAMPLED page (s.url), not the first cited example', () => {
    // Guardrail for the multi-sample aggregation fix: the checker must read the
    // sampled page's own URL (s.url), so each sampled example is evaluated on its
    // own merits rather than re-measuring f.exampleUrl N times.
    assert.strictEqual(
      checkFindingSignals('Some URLs are too long', { ...base, url: `https://x.example/${'a'.repeat(150)}` }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'URL is too deep (6 levels, max recommended: 3)',
        { ...base, url: 'https://x.example/a/b/c/d/e/f' },
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'URL is too deep (6 levels, max recommended: 3)',
        { ...base, url: 'https://x.example/a/b' },
        1,
      ).status,
      'refuted',
    );
  });

  void it('social-tags matcher does NOT own per-tag social findings (would falsely refute when other social meta exists)', () => {
    // hasSocialTags is an OR over all og/twitter meta, so routing a specific-tag
    // finding here would refute it whenever ANY social tag is present.
    for (const t of [
      'Default social image used on most pages',
      'Social images use relative URLs',
      'Social images below recommended dimensions',
      'Many pages missing Twitter Card tags',
      'Low Open Graph tag coverage',
    ]) {
      const r = checkFindingSignals(t, { ...base, hasSocialTags: true }, 1);
      assert.notStrictEqual(r.status, 'refuted', `"${t}" must not be refuted by social-tags`);
      assert.match(r.reason, /no live checker/i, `"${t}" should not route to social-tags`);
    }
    // The site-wide "missing social media tags" finding IS owned and confirms/refutes.
    assert.strictEqual(
      checkFindingSignals('Pages missing social media tags', { ...base, hasSocialTags: false }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Pages missing social media tags', { ...base, hasSocialTags: true }, 1).status,
      'refuted',
    );
  });

  void it('form-labels is confirm-only (present → confirmed, none at load → unverified, never refuted)', () => {
    assert.strictEqual(
      checkFindingSignals('Form inputs missing labels', { ...base, inputsWithoutLabel: 3 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Form inputs missing labels', { ...base, inputsWithoutLabel: 0 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Placeholder used instead of label', { ...base, inputsWithoutLabel: 0 }, 1).status,
      'unverified',
    );
  });

  void it('inline-css is confirm-only over the warning threshold', () => {
    assert.strictEqual(
      checkFindingSignals('Large inline CSS', { ...base, inlineCssBytes: 80_000 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Large inline CSS', { ...base, inlineCssBytes: 1_000 }, 1).status,
      'unverified',
    );
  });

  void it('hreflang-duplicate confirms a duplicate and refutes none', () => {
    assert.strictEqual(
      checkFindingSignals('Some alternates are duplicated in head links', { ...base, duplicateHreflang: 2 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some alternates are duplicated in head links', { ...base, duplicateHreflang: 0 }, 1).status,
      'refuted',
    );
  });

  void it('multiple-h1 confirms >1 and refutes ≤1', () => {
    assert.strictEqual(
      checkFindingSignals('Some pages have more than one h1 tag', { ...base, h1Count: 3 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have more than one h1 tag', { ...base, h1Count: 1 }, 1).status,
      'refuted',
    );
  });

  void it('social-tags confirms when absent and refutes when present', () => {
    assert.strictEqual(
      checkFindingSignals('Pages missing social media tags', { ...base, hasSocialTags: false }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Pages missing social media tags', { ...base, hasSocialTags: true }, 1).status,
      'refuted',
    );
  });

  void it('video-schema confirms a video w/o schema, refutes when schema present, unverified when no video mounted', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Video content without VideoObject schema',
        { ...base, videoCount: 1, hasVideoObjectSchema: false },
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Video content without VideoObject schema',
        { ...base, videoCount: 1, hasVideoObjectSchema: true },
        1,
      ).status,
      'refuted',
    );
    assert.strictEqual(
      checkFindingSignals('Video content without VideoObject schema', { ...base, videoCount: 0 }, 1).status,
      'unverified',
    );
  });

  void it('video-schema does NOT own "Invalid VideoObject schema" (schema present → would falsely refute)', () => {
    const r = checkFindingSignals(
      'Invalid VideoObject schema',
      { ...base, videoCount: 1, hasVideoObjectSchema: true },
      1,
    );
    assert.notStrictEqual(r.status, 'refuted');
    assert.match(r.reason, /no live checker/i);
  });

  void it('video-captions is confirm-only', () => {
    assert.strictEqual(
      checkFindingSignals('Videos without captions or transcripts', { ...base, videosWithoutCaptions: 2 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Videos without captions or transcripts', { ...base, videosWithoutCaptions: 0 }, 1).status,
      'unverified',
    );
  });

  void it('lazy-loading confirms many images with zero lazy, stays unverified otherwise (never refutes)', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have many images but none use lazy loading',
        { ...base, imageCount: 10, lazyImageCount: 0 },
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Some pages have many images but none use lazy loading',
        { ...base, imageCount: 10, lazyImageCount: 4 },
        1,
      ).status,
      'unverified',
    );
  });

  void it('dead-end confirms exactly-zero internal links, never refutes on present links', () => {
    assert.strictEqual(
      checkFindingSignals('Dead-end page (no outgoing internal links)', { ...base, internalLinkCount: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Dead-end page (no outgoing internal links)', { ...base, internalLinkCount: 8 }, 1).status,
      'unverified',
    );
  });

  void it('structured-data-coverage (site-wide) confirms no JSON-LD on the homepage, unverified otherwise', () => {
    assert.strictEqual(
      checkFindingSignals('Low structured data coverage', { ...base, jsonLdBlocks: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Low structured data coverage', { ...base, jsonLdBlocks: 3 }, 1).status,
      'unverified',
    );
  });

  void it('crawl-budget / high-error-rate aggregates are OWNED (site-level unverified), not a "no live checker" gap', () => {
    for (const t of ['Significant crawl budget waste detected', 'High error rate in API/Technical']) {
      const r = checkFindingSignals(t, base, 1);
      assert.strictEqual(r.status, 'unverified');
      assert.doesNotMatch(r.reason, /no live checker/i, `"${t}" should be owned`);
    }
  });

  void it('coverage matcher catches "unused JavaScript" wording (not just "unused code/css")', () => {
    assert.strictEqual(
      checkFindingSignals('High percentage of unused JavaScript', { ...base, unusedJsRatio: 0.8 }, 1).status,
      'confirmed',
    );
  });

  // ---- Tier-2 gap-closers (ported from the offline verifier; all confirm-only) ----

  void it('vitals owns LCP / FCP confirm-only (over → confirmed, unmeasured → unverified, never refuted)', () => {
    assert.strictEqual(
      checkFindingSignals('Some pages have LCP more than 2500ms', { ...base, lcpMs: 4200 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have LCP more than 2500ms', { ...base, lcpMs: 1500 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have LCP more than 2500ms', { ...base, lcpMs: 0 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have FCP more than 1800ms', { ...base, fcpMs: 2400 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Some pages have FCP more than 1800ms', { ...base, fcpMs: 900 }, 1).status,
      'unverified',
    );
  });

  void it('vitals owns TTI but returns unverified (lab metric, no PerformanceObserver) — not a no-checker gap', () => {
    const r = checkFindingSignals('Some pages have TTI more than 3800ms', base, 1);
    assert.strictEqual(r.status, 'unverified');
    assert.doesNotMatch(r.reason, /no live checker/i);
  });

  void it('fonts confirm-only: payload by bytes, count by file number', () => {
    assert.strictEqual(
      checkFindingSignals('Large web font payload', { ...base, fontBytes: 400_000 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Large web font payload', { ...base, fontBytes: 50_000 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Too many font files loaded', { ...base, fontRequests: 7 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Too many font files loaded', { ...base, fontRequests: 2 }, 1).status,
      'unverified',
    );
  });

  void it('console-errors confirm-only: errors at load → confirmed, none → unverified (never refuted)', () => {
    assert.strictEqual(
      checkFindingSignals('Critical JavaScript errors detected', { ...base, consoleErrors: 3 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Critical JavaScript errors detected', { ...base, consoleErrors: 0 }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('JavaScript console errors detected', { ...base, consoleErrors: 1 }, 1).status,
      'confirmed',
    );
  });

  void it('author-attribution confirm-only: no byline → confirmed, byline present → unverified (heuristic, never refuted)', () => {
    assert.strictEqual(
      checkFindingSignals('YMYL page without author attribution', { ...base, hasAuthorByline: false }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('YMYL page without author attribution', { ...base, hasAuthorByline: true }, 1).status,
      'unverified',
    );
    assert.strictEqual(
      checkFindingSignals('Most content pages lack author attribution', { ...base, hasAuthorByline: false }, 1).status,
      'confirmed',
    );
  });

  void it('console-errors does NOT own "unused JavaScript" (stays with coverage)', () => {
    // Had console-errors wrongly matched, consoleErrors:0 would yield unverified;
    // coverage instead confirms on the high unused ratio.
    assert.strictEqual(
      checkFindingSignals('High percentage of unused JavaScript', { ...base, unusedJsRatio: 0.85, consoleErrors: 0 }, 1)
        .status,
      'confirmed',
    );
  });

  void it('missing-main confirms when no <main> landmark and refutes when present', () => {
    assert.strictEqual(
      checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 1 }, 1).status, 'refuted');
  });

  void it('missing-main matches the <main> titles but NOT <nav>/<header> landmark titles (which it must not refute against mainCount)', () => {
    // Real report titles that SHOULD route to the <main> checker.
    assert.strictEqual(
      checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Many pages missing <main> landmark', { ...base, mainCount: 0 }, 1).status,
      'confirmed',
    );
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
    assert.strictEqual(
      checkFindingSignals('No privacy policy link found', { ...base, privacyLinkCount: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('No privacy policy link found', { ...base, privacyLinkCount: 1 }, 1).status,
      'refuted',
    );
  });

  void it('a multi-occurrence missing-main refute is downgraded to unverified (only the first page was checked)', () => {
    assert.strictEqual(
      checkFindingSignals('Missing `<main>` element', { ...base, mainCount: 1 }, 19).status,
      'unverified',
    );
  });

  void it('tls is confirm-only: slow handshake confirms, fast/reused stays unverified (never refutes)', () => {
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: 446 }, 2).status, 'confirmed');
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: 20 }, 2).status, 'unverified');
    assert.strictEqual(checkFindingSignals('Slow TLS negotiation', { ...base, tlsMs: null }, 2).status, 'unverified');
  });

  void it('resource-hints (site-wide page) confirms when the homepage has none, stays unverified when present', () => {
    assert.strictEqual(
      checkFindingSignals('Most pages lack resource hints', { ...base, resourceHintCount: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Most pages lack resource hints', { ...base, resourceHintCount: 3 }, 1).status,
      'unverified',
    );
  });

  void it('eeat (site-wide page) confirms when no signals on the homepage, stays unverified otherwise', () => {
    assert.strictEqual(
      checkFindingSignals('Low E-E-A-T signals across site', { ...base, eeatSignals: 0 }, 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Low E-E-A-T signals across site', { ...base, eeatSignals: 3 }, 1).status,
      'unverified',
    );
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
      // Slice 2 — header / robots kinds must all be owned (never the fallback).
      'Page blocked via X-Robots-Tag: noindex (HTTP header)',
      'Missing Permissions-Policy header',
      'Missing cross-origin isolation headers',
      'Server technology disclosed in response headers',
      'Page uses Vary: User-Agent (dynamic serving)',
      'Content-Language header mismatches html lang attribute',
      'Page served without compression',
      'Brotli compression not detected',
      'No explicit AI crawler rules in robots.txt',
      'AI crawlers blocked in robots.txt',
      // Tier-1 gap closers — every one must now resolve to a real checker.
      'URL is too long (120 chars, max recommended: 100)',
      'Some URLs are too long',
      'URL is too deep (6 levels, max recommended: 3)',
      'Form inputs missing labels',
      'Form inputs across the site are missing labels',
      'Placeholder used instead of label',
      'Large inline CSS',
      'Some alternates are duplicated in head links',
      'Some pages have more than one h1 tag',
      'Pages missing social media tags',
      'Low structured data coverage',
      'Video content without VideoObject schema',
      'Videos without captions or transcripts',
      'Some pages have many images but none use lazy loading',
      'Dead-end page (no outgoing internal links)',
      'Significant crawl budget waste detected',
      'High error rate in API/Technical',
      'No Sitemap declared in robots.txt',
      'High percentage of unused JavaScript',
      // Tier-2 gap closers (ported from the offline verifier).
      'Some pages have LCP more than 2500ms',
      'Some pages have FCP more than 1800ms',
      'Some pages have TTI more than 3800ms',
      'Large web font payload',
      'Excessive web font payload',
      'Too many font files loaded',
      'Critical JavaScript errors detected',
      'JavaScript console errors detected',
      'YMYL page without author attribution',
      'Most content pages lack author attribution',
      'Most pages lack author attribution',
      // Tranche-1 gap closers.
      "Some loc and canonical don't match",
      'Multiple redirects detected',
      'Pages sit behind a long redirect chain',
      'LCP images not preloaded across site',
      'Session ID detected in URL',
      'Too many on-page links',
      'Affiliate link without sponsored/nofollow',
      'CSS/JS files may be blocked',
      // Tranche-2 gap closers.
      'Contact form inputs use placeholder as their only label',
      'Form fields lack `<label>` and grouping semantics',
      'Description meta tag is missing',
      'Pages in sitemap are marked noindex',
      'Some pages have excessive total image size',
      'A notable share of pages have near-duplicate content',
      'Low AI content structure score',
    ];
    for (const t of titles) {
      assert.doesNotMatch(
        checkFindingSignals(t, base, 1).reason,
        /no live checker for this finding kind/i,
        `"${t}" should be owned by a checker`,
      );
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
    const f = (urls: string[]): ReportFinding => ({
      title: 't',
      severity: 'HIGH',
      count: 1,
      exampleUrl: urls[0],
      exampleUrls: urls,
    });
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

  void it('renders no screenshot for a finding with no illustrable evidence kind, even when sampled', () => {
    // Regression: cross-page / network / header claims (keyword cannibalisation,
    // TBT, missing SRI, broken outbound links) match no evidence kind. A
    // context-free full-page screenshot illustrates nothing about them, so none
    // should be attached — even though the cited page WAS sampled.
    const msg = 'External scripts missing Subresource Integrity (SRI)';
    assert.strictEqual(evidenceKindFor(msg), null, 'guard: this finding has no evidence kind');
    const arts = withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), evidence);
    const md = buildReportMarkdown(arts);
    assert.doesNotMatch(md, /\*\*Screenshot\*\*/);
    assert.doesNotMatch(md, /evidence-shots/);
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
    const fwd = buildReportMarkdown(
      withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), evidence),
    );
    const rev = buildReportMarkdown(
      withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), reversed),
    );
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
    const fwd = buildReportMarkdown(
      withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), collide),
    );
    const rev = buildReportMarkdown(
      withEvidence(mkArtifacts([msg], { [msg]: ['https://example.com/about'] }), reversed),
    );
    assert.strictEqual(fwd, rev, 'collision pick is insertion-order independent');
    // The lexicographically-first dir key wins, in either order.
    assert.match(fwd, /src="evidence\/aaa_dir\/screenshot\.mobile\.png"/);
    assert.doesNotMatch(fwd, /src="evidence\/zzz_dir\//);
  });
});

import {
  verifySitemapMembership,
  verifyReachability,
  verifyOrphan,
  verifyClickDepth,
  verifyLinkEquity,
  type LiveSite,
  type ReportFinding,
} from '../lib/phase3/live-verifier';

void describe('live-verifier: site-level verifiers', () => {
  const f = (title: string, url: string): ReportFinding => ({
    title,
    severity: 'HIGH',
    count: 1,
    exampleUrl: url,
    exampleUrls: [url],
  });
  const site: LiveSite = {
    sitemapUrls: new Set(['https://e.com/a']),
    sitemapCapped: false,
    reachable: new Set(['https://e.com/a']),
    reachabilityCapped: false,
  };

  void it('sitemap: cited page absent from sitemap → confirmed; present → refuted', () => {
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/orphan'), site).status,
      'confirmed',
    );
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/a'), site).status,
      'refuted',
    );
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
    const empty: LiveSite = {
      sitemapUrls: new Set(),
      sitemapCapped: false,
      reachable: new Set(),
      reachabilityCapped: false,
    };
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/x'), empty).status,
      'unverified',
    );
  });

  // ---- tranche-4: persisted full-crawl graph (uncapped orphan/depth/equity) ----

  // A site built from the persisted crawl graph: NOT capped, carries the inbound
  // graph + click-depth map. /a has inbound + depth 1; /buried is deep; /lonely
  // has zero inbound and is unreachable.
  const graphSite: LiveSite = {
    sitemapUrls: new Set(['https://e.com/a']),
    sitemapCapped: false,
    reachable: new Set(['https://e.com/a', 'https://e.com/buried']),
    reachabilityCapped: false,
    incoming: new Map([
      ['https://e.com/a', ['https://e.com/', 'https://e.com/x']],
      ['https://e.com/buried', ['https://e.com/a']],
    ]),
    depthFromHome: new Map([
      ['https://e.com/', 0],
      ['https://e.com/a', 1],
      ['https://e.com/buried', 6],
    ]),
  };

  void it('orphan: zero-inbound (absent from the inbound graph) → confirmed; has-inbound → refuted', () => {
    assert.strictEqual(verifyOrphan(f('Orphan page', 'https://e.com/lonely'), graphSite).status, 'confirmed');
    assert.strictEqual(verifyOrphan(f('Orphan page', 'https://e.com/a'), graphSite).status, 'refuted');
  });

  void it('orphan without an inbound graph falls back to reachability', () => {
    // graphSite minus the incoming map → reachability fallback (uncapped here).
    const noGraph: LiveSite = { ...graphSite, incoming: undefined };
    assert.strictEqual(verifyOrphan(f('Orphan page', 'https://e.com/lonely'), noGraph).status, 'confirmed');
    assert.strictEqual(verifyOrphan(f('Orphan page', 'https://e.com/a'), noGraph).status, 'refuted');
  });

  void it('click-depth: deeper than the bar → confirmed; shallow → unverified (confirm-only)', () => {
    assert.strictEqual(
      verifyClickDepth(f('Page is 6 clicks from homepage', 'https://e.com/buried'), graphSite).status,
      'confirmed',
    );
    assert.strictEqual(
      verifyClickDepth(f('Page is 1 click from homepage', 'https://e.com/a'), graphSite).status,
      'unverified',
    );
  });

  void it('low-link-equity: ≤ bar inbound → confirmed; above bar → unverified (confirm-only proxy)', () => {
    // /buried has 1 inbound (≤3) → confirmed; give /a 4 inbound → above bar → unverified.
    assert.strictEqual(
      verifyLinkEquity(f('Page has very low internal link equity', 'https://e.com/buried'), graphSite).status,
      'confirmed',
    );
    const wellLinked: LiveSite = {
      ...graphSite,
      incoming: new Map([
        ['https://e.com/a', ['https://e.com/', 'https://e.com/x', 'https://e.com/y', 'https://e.com/z']],
      ]),
    };
    assert.strictEqual(
      verifyLinkEquity(f('Page has very low internal link equity', 'https://e.com/a'), wellLinked).status,
      'unverified',
    );
  });

  void it('persisted reachability is uncapped: an unreached page confirms (no 120-page-cap unverified)', () => {
    assert.strictEqual(
      verifyReachability(f('Page unreachable from homepage', 'https://e.com/lonely'), graphSite).status,
      'confirmed',
    );
  });
});

import {
  crawlProfileToThrottle,
  firstExampleUrl,
  writeRefutedReport,
  loadPhase2State,
  verdictBreakdownLine,
} from '../lib/phase3/verify-runner';
import { NETWORK_CONDITIONS, CPU_CONDITIONS, SEVERITY } from '../lib/constants';
import type { LiveVerdict } from '../lib/phase3/live-verifier';

void describe('phase3: verdictBreakdownLine (Slice 0 taxonomy)', () => {
  const v = (status: LiveVerdict['status'], reasonCode: LiveVerdict['reasonCode']): LiveVerdict => ({
    title: 't',
    severity: 'HIGH',
    status,
    reason: 'r',
    reasonCode,
    confidence: 'medium',
    kind: 'k',
  });

  void it('breaks the unverified set down by reason code, most-common first', () => {
    const line = verdictBreakdownLine([
      v('confirmed', 'confirmed'),
      v('unverified', 'site-level'),
      v('unverified', 'site-level'),
      v('unverified', 'volatile'),
    ]);
    assert.match(line, /2 site-level \/ cross-page/);
    assert.match(line, /1 volatile signal/);
    assert.ok(line.indexOf('site-level') < line.indexOf('volatile'), 'most common category comes first');
    assert.ok(!/confirmed/.test(line), 'confirmed findings are not part of the unverified breakdown');
  });

  void it('returns empty string when nothing is unverified', () => {
    assert.strictEqual(verdictBreakdownLine([v('confirmed', 'confirmed'), v('refuted', 'refuted')]), '');
  });
});

void describe('phase3: phase2-state.json boundary', () => {
  void it('round-trips the Phase 2 render state (suppression, narratives, anomalies, noScore)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2state-'));
    const state = {
      version: 1,
      generatedAt: '2026-06-04T00:00:00.000Z',
      suppressed: ['Duplicate page titles found'],
      narratives: { seo: 'Anchored narrative.' },
      anomalies: [
        {
          section: 'ux',
          title: 'Dead button',
          severity: 'high',
          url: 'https://e.com/',
          evidence: 'e',
          recommendation: 'r',
        },
      ],
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
    fs.writeFileSync(
      path.join(dir, 'phase2-state.json'),
      JSON.stringify({ version: 2, suppressed: [], narratives: {}, anomalies: [], noScore: false }),
    );
    assert.strictEqual(loadPhase2State(dir), null, 'unknown version degrades to the absent-state fallback');
  });
});

void describe('phase3: refuted-findings report', () => {
  void it('firstExampleUrl extracts the first real URL and skips templated {N} series keys', () => {
    assert.strictEqual(
      firstExampleUrl(['The page <a href="https://e.com/x">x</a> has a short title']),
      'https://e.com/x',
    );
    assert.strictEqual(
      firstExampleUrl(['[https://e.com/insights/page/{N}](https://e.com/insights/page/{N})', 'https://e.com/real']),
      'https://e.com/real',
    );
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
      {
        title: 'Some URLs are not listed in sitemap',
        severity: 'medium',
        kind: 'site-graph',
        exampleUrl: 'https://e.com/',
        reason: 'cited page IS present in the sitemap',
      },
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
      {
        title: 'Duplicate page titles found',
        severity: 'medium',
        kind: 'duplicate-title',
        exampleUrl: 'https://e.com/a',
        reason: 'titles differ in the crawl data',
      },
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
    assert.ok(
      t,
      'a perf crawl yields a throttle (regression guard: the map-vs-condition shape bug returned undefined)',
    );
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
    url: 'https://e.com/p',
    finalUrl: 'https://e.com/p',
    status,
    ttfbMs: 100,
    htmlBytes: 1000,
    totalBytes: 1000,
    totalRequests: 1,
    title: 'T',
    description: 'd',
    canonical: 'https://e.com/p',
    h1Count: 1,
    iframeCount: 0,
    wordCount: 800,
    semanticRatio: 0.5,
    emptyAnchorCount: 0,
    inputsWithoutAutocomplete: 0,
    selfPostGetForms: 0,
    scriptsNoSri: 0,
    maxChildren: 5,
    jpgPngImages: 0,
    modernImages: 2,
    renderBlockingTotal: 0,
    renderBlockingThirdParty: 0,
    thirdPartyOrigins: 0,
    thirdPartyRequests: 0,
    thirdPartyBytes: 0,
    adScriptBytes: 0,
    largestImageBytes: 0,
    oversizedImages: 0,
    clsValue: 0,
    tbtMs: 0,
    unusedCssRatio: -1,
    unusedJsRatio: -1,
    preConsentTrackingCookies: 0,
    contrastViolations: -1,
    mainCount: 1,
    resourceHintCount: 2,
    privacyLinkCount: 1,
    tlsMs: 50,
    eeatSignals: 2,
    headers: {},
    htmlLang: 'en',
    inlineCssBytes: 0,
    inputsWithoutLabel: 0,
    duplicateHreflang: 0,
    jsonLdBlocks: 1,
    hasSocialTags: true,
    imageCount: 0,
    lazyImageCount: 0,
    videoCount: 0,
    hasVideoObjectSchema: false,
    videosWithoutCaptions: 0,
    videosWithoutPoster: 0,
    videosWithoutTitle: 0,
    autoplayVideosNoControls: 0,
    hasManifestLink: false,
    hasThemeColor: false,
    hasAppleTouchIcon: false,
    hasNoscript: false,
    h2Count: 0,
    inlineJsBytes: 0,
    httpInternalLinks: 0,
    redirectStatuses: [],
    hasHeadingSkip: false,
    textHtmlRatio: 0.5,
    hasFreshnessSignal: false,
    internalLinkCount: 5,
    lcpMs: 0,
    fcpMs: 0,
    fontRequests: 0,
    fontBytes: 0,
    consoleErrors: 0,
    hasAuthorByline: true,
    redirectCount: 0,
    hasImagePreload: true,
    totalLinkCount: 10,
    affiliateLinksNoRel: 0,
    hasNoindexMeta: false,
    totalImageBytes: 0,
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
  const f = (title: string, url: string): ReportFinding => ({
    title,
    severity: 'HIGH',
    count: 1,
    exampleUrl: url,
    exampleUrls: [url],
  });

  void it('sitemap: /Foo cited but only /foo in sitemap → NOT refuted (distinct resources)', () => {
    const site: LiveSite = {
      sitemapUrls: new Set(['https://e.com/foo']),
      sitemapCapped: false,
      reachable: new Set(),
      reachabilityCapped: true,
    };
    // /Foo is genuinely missing; case-insensitive matching would wrongly drop it.
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/Foo'), site).status,
      'confirmed',
    );
  });

  void it('sitemap: exact case match → refuted', () => {
    const site: LiveSite = {
      sitemapUrls: new Set(['https://e.com/Foo']),
      sitemapCapped: false,
      reachable: new Set(),
      reachabilityCapped: true,
    };
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/Foo'), site).status,
      'refuted',
    );
  });

  void it('sitemap: truncated index + page absent → unverified, NOT a false confirm', () => {
    const site: LiveSite = {
      sitemapUrls: new Set(['https://e.com/foo']),
      sitemapCapped: true,
      reachable: new Set(),
      reachabilityCapped: true,
    };
    // The page could live in an unread child sitemap → must not assert "absent".
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/other'), site).status,
      'unverified',
    );
    // A present page still refutes even when truncated (presence is authoritative).
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://e.com/foo'), site).status,
      'refuted',
    );
  });

  void it('host case is ignored (URL normalizes host), path case is preserved', () => {
    const site: LiveSite = {
      sitemapUrls: new Set(['https://e.com/foo']),
      sitemapCapped: false,
      reachable: new Set(),
      reachabilityCapped: true,
    };
    assert.strictEqual(
      verifySitemapMembership(f('Indexable pages missing from sitemap', 'https://E.com/foo'), site).status,
      'refuted',
    );
  });
});

import {
  duplicateVerdict,
  robotsAiVerdict,
  robotsSitemapVerdict,
  robotsCssJsBlockedVerdict,
} from '../lib/phase3/live-verifier';

void describe('live-verifier: Slice 2 header checkers', () => {
  const base: LiveSignals = {
    url: 'https://x.example/',
    finalUrl: 'https://x.example/',
    status: 200,
    ttfbMs: 100,
    htmlBytes: 1000,
    totalBytes: 1000,
    totalRequests: 1,
    title: 'T',
    description: 'd',
    canonical: 'https://x.example/',
    h1Count: 1,
    iframeCount: 0,
    wordCount: 800,
    semanticRatio: 0.5,
    emptyAnchorCount: 0,
    inputsWithoutAutocomplete: 0,
    selfPostGetForms: 0,
    scriptsNoSri: 0,
    maxChildren: 5,
    jpgPngImages: 0,
    modernImages: 2,
    renderBlockingTotal: 0,
    renderBlockingThirdParty: 0,
    thirdPartyOrigins: 0,
    thirdPartyRequests: 0,
    thirdPartyBytes: 0,
    adScriptBytes: 0,
    largestImageBytes: 0,
    oversizedImages: 0,
    clsValue: 0,
    tbtMs: 0,
    unusedCssRatio: -1,
    unusedJsRatio: -1,
    preConsentTrackingCookies: 0,
    contrastViolations: -1,
    mainCount: 1,
    resourceHintCount: 2,
    privacyLinkCount: 1,
    tlsMs: 50,
    eeatSignals: 2,
    headers: {},
    htmlLang: 'en',
    inlineCssBytes: 0,
    inputsWithoutLabel: 0,
    duplicateHreflang: 0,
    jsonLdBlocks: 1,
    hasSocialTags: true,
    imageCount: 0,
    lazyImageCount: 0,
    videoCount: 0,
    hasVideoObjectSchema: false,
    videosWithoutCaptions: 0,
    videosWithoutPoster: 0,
    videosWithoutTitle: 0,
    autoplayVideosNoControls: 0,
    hasManifestLink: false,
    hasThemeColor: false,
    hasAppleTouchIcon: false,
    hasNoscript: false,
    h2Count: 0,
    inlineJsBytes: 0,
    httpInternalLinks: 0,
    redirectStatuses: [],
    hasHeadingSkip: false,
    textHtmlRatio: 0.5,
    hasFreshnessSignal: false,
    internalLinkCount: 5,
    lcpMs: 0,
    fcpMs: 0,
    fontRequests: 0,
    fontBytes: 0,
    consoleErrors: 0,
    hasAuthorByline: true,
    redirectCount: 0,
    hasImagePreload: true,
    totalLinkCount: 10,
    affiliateLinksNoRel: 0,
    hasNoindexMeta: false,
    totalImageBytes: 0,
  };
  const withHeaders = (h: Record<string, string>): LiveSignals => ({ ...base, headers: h });

  void it('empty header map → unverified (unreachable), never a false refute', () => {
    const r = checkFindingSignals('Page blocked via X-Robots-Tag: noindex (HTTP header)', base, 1);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'unreachable');
  });

  void it('x-robots noindex: present → confirmed, absent → refuted', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Page blocked via X-Robots-Tag: noindex (HTTP header)',
        withHeaders({ 'x-robots-tag': 'noindex, nofollow' }),
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Page blocked via X-Robots-Tag: noindex (HTTP header)',
        withHeaders({ 'content-type': 'text/html' }),
        1,
      ).status,
      'refuted',
    );
  });

  void it('missing Permissions-Policy: absent → confirmed, present → refuted', () => {
    assert.strictEqual(
      checkFindingSignals('Missing Permissions-Policy header', withHeaders({ 'content-type': 'text/html' }), 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Missing Permissions-Policy header',
        withHeaders({ 'permissions-policy': 'geolocation=()' }),
        1,
      ).status,
      'refuted',
    );
  });

  void it('cross-origin isolation: needs BOTH COOP and COEP to refute', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Missing cross-origin isolation headers',
        withHeaders({ 'cross-origin-opener-policy': 'same-origin' }),
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Missing cross-origin isolation headers',
        withHeaders({ 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }),
        1,
      ).status,
      'refuted',
    );
  });

  void it('server disclosure: Server/X-Powered-By present → confirmed', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Server technology disclosed in response headers',
        withHeaders({ 'x-powered-by': 'Express' }),
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Server version disclosed in response headers',
        withHeaders({ 'content-type': 'text/html' }),
        1,
      ).status,
      'refuted',
    );
  });

  void it('compression: generic finding confirmed when uncompressed, refuted when gzip/br', () => {
    assert.strictEqual(
      checkFindingSignals('Page served without compression', withHeaders({ 'content-type': 'text/html' }), 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Page served without compression', withHeaders({ 'content-encoding': 'gzip' }), 1).status,
      'refuted',
    );
  });

  void it('compression: Brotli-specific finding refuted only by br encoding', () => {
    assert.strictEqual(
      checkFindingSignals('Brotli compression not detected', withHeaders({ 'content-encoding': 'gzip' }), 1).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals('Brotli compression not detected', withHeaders({ 'content-encoding': 'br' }), 1).status,
      'refuted',
    );
  });

  void it('content-language mismatch: differing primary subtags confirm, matching refute, missing → inconclusive', () => {
    assert.strictEqual(
      checkFindingSignals(
        'Content-Language header mismatches html lang attribute',
        { ...withHeaders({ 'content-language': 'fr' }), htmlLang: 'en' },
        1,
      ).status,
      'confirmed',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Content-Language header mismatches html lang attribute',
        { ...withHeaders({ 'content-language': 'en-US' }), htmlLang: 'en' },
        1,
      ).status,
      'refuted',
    );
    assert.strictEqual(
      checkFindingSignals(
        'Content-Language header mismatches html lang attribute',
        { ...withHeaders({ 'content-language': 'fr' }), htmlLang: '' },
        1,
      ).code,
      'inconclusive',
    );
  });
});

void describe('live-verifier: robotsAiVerdict', () => {
  void it('"no explicit AI crawler rules": confirmed when none named, refuted when present', () => {
    assert.strictEqual(
      robotsAiVerdict('No explicit AI crawler rules in robots.txt', 'User-agent: *\nDisallow: /admin').status,
      'confirmed',
    );
    assert.strictEqual(
      robotsAiVerdict(
        'No explicit AI crawler rules in robots.txt',
        'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /',
      ).status,
      'refuted',
    );
  });

  void it('"AI crawlers blocked": confirmed when an AI bot has Disallow: /, refuted otherwise', () => {
    assert.strictEqual(
      robotsAiVerdict('AI crawlers blocked in robots.txt', 'User-agent: ClaudeBot\nDisallow: /').status,
      'confirmed',
    );
    assert.strictEqual(
      robotsAiVerdict('AI crawlers blocked in robots.txt', 'User-agent: GPTBot\nDisallow: /private').status,
      'refuted',
    );
  });

  void it('consecutive user-agent lines share the following directives', () => {
    assert.strictEqual(
      robotsAiVerdict('AI crawlers blocked in robots.txt', 'User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /').status,
      'confirmed',
    );
  });

  void it('unfetchable robots.txt → unverified (unreachable)', () => {
    const r = robotsAiVerdict('AI crawlers blocked in robots.txt', null);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'unreachable');
  });
});

void describe('live-verifier: robotsSitemapVerdict', () => {
  void it('confirms when robots.txt declares no Sitemap directive', () => {
    assert.strictEqual(robotsSitemapVerdict('User-agent: *\nDisallow: /admin').status, 'confirmed');
  });

  void it('refutes when a Sitemap: directive is present (comments stripped)', () => {
    assert.strictEqual(
      robotsSitemapVerdict('# a comment\nUser-agent: *\nSitemap: https://x.example/sitemap.xml').status,
      'refuted',
    );
    // A commented-out Sitemap line does not count.
    assert.strictEqual(
      robotsSitemapVerdict('# Sitemap: https://x.example/sitemap.xml\nUser-agent: *').status,
      'confirmed',
    );
  });

  void it('unfetchable robots.txt → unverified (unreachable)', () => {
    const r = robotsSitemapVerdict(null);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'unreachable');
  });
});

void describe('live-verifier: robotsCssJsBlockedVerdict', () => {
  void it('confirms a wildcard JS/CSS Disallow under "*" with no Allow override', () => {
    assert.strictEqual(robotsCssJsBlockedVerdict('User-agent: *\nDisallow: /*.js$').status, 'confirmed');
    assert.strictEqual(robotsCssJsBlockedVerdict('User-agent: Googlebot\nDisallow: /*.css').status, 'confirmed');
  });

  void it('refutes when an Allow override re-exposes CSS/JS', () => {
    assert.strictEqual(
      robotsCssJsBlockedVerdict('User-agent: *\nDisallow: /*.js$\nAllow: /assets/app.js').status,
      'refuted',
    );
  });

  void it('refutes when no wildcard CSS/JS block exists (ordinary disallows are fine)', () => {
    assert.strictEqual(robotsCssJsBlockedVerdict('User-agent: *\nDisallow: /admin\nDisallow: /cart').status, 'refuted');
  });

  void it('a JS/CSS block scoped to a NON-major bot does not confirm', () => {
    assert.strictEqual(robotsCssJsBlockedVerdict('User-agent: AhrefsBot\nDisallow: /*.js$').status, 'refuted');
  });

  void it('unfetchable robots.txt → unverified (unreachable)', () => {
    const r = robotsCssJsBlockedVerdict(null);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'unreachable');
  });
});

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

import {
  aggregateSampledVerdict,
  defaultConfidence,
  MAX_SAMPLES_PER_FINDING,
  type CheckResult,
} from '../lib/phase3/live-verifier';

void describe('live-verifier: aggregateSampledVerdict (Slice 1 multi-example sampling)', () => {
  const C: CheckResult = { status: 'confirmed', reason: 'defect here', code: 'confirmed' };
  const R: CheckResult = { status: 'refuted', reason: 'clean now', code: 'refuted' };
  const U: CheckResult = { status: 'unverified', reason: 'lazy content', code: 'under-observable' };

  void it('any sampled page defective → confirmed (high when all, medium when partial)', () => {
    assert.strictEqual(aggregateSampledVerdict([C, C, C], 3).confidence, 'high');
    const mixed = aggregateSampledVerdict([C, R, R], 3);
    assert.strictEqual(mixed.status, 'confirmed');
    assert.strictEqual(mixed.confidence, 'medium');
  });

  void it('all sampled clean AND sample covers the finding (sampled ≥ count) → refuted', () => {
    assert.strictEqual(aggregateSampledVerdict([R, R, R], 3).status, 'refuted');
    assert.strictEqual(aggregateSampledVerdict([R], 1).status, 'refuted'); // single-occurrence
  });

  void it('all sampled clean but sample does NOT cover the finding → plural-undersampled, never refuted', () => {
    const r = aggregateSampledVerdict([R, R, R], 44);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'plural-undersampled');
  });

  void it('confirm-only checker (no refutes) never drops — clean sample stays unverified', () => {
    const r = aggregateSampledVerdict([U, U], 2);
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.code, 'under-observable');
  });

  void it('a mix of clean + unreachable does not refute (sample not fully clean-observed)', () => {
    const unreachable: CheckResult = { status: 'unverified', reason: 'could not load', code: 'unreachable' };
    const r = aggregateSampledVerdict([R, unreachable], 2);
    assert.strictEqual(r.status, 'unverified');
  });

  void it('empty results (nothing loaded) → unreachable', () => {
    assert.strictEqual(aggregateSampledVerdict([], 3).code, 'unreachable');
  });

  void it('MAX_SAMPLES_PER_FINDING is bounded (cost guard)', () => {
    assert.ok(MAX_SAMPLES_PER_FINDING >= 1 && MAX_SAMPLES_PER_FINDING <= 5);
  });
});

import { liveSignalsSnapshot } from '../lib/phase3/live-verifier';

void describe('live-verifier: liveSignalsSnapshot (Slice 3 LLM evidence)', () => {
  const sig = {
    url: 'https://x.example/a',
    finalUrl: 'https://x.example/a',
    status: 200,
    ttfbMs: 120,
    htmlBytes: 2000,
    totalBytes: 5000,
    totalRequests: 12,
    title: 'A title here',
    description: 'desc',
    canonical: 'https://x.example/a',
    h1Count: 1,
    iframeCount: 0,
    wordCount: 500,
    semanticRatio: 0.4321,
    emptyAnchorCount: 2,
    inputsWithoutAutocomplete: 0,
    scriptsNoSri: 1,
    maxChildren: 9,
    jpgPngImages: 3,
    modernImages: 1,
    renderBlockingTotal: 2,
    renderBlockingThirdParty: 1,
    thirdPartyOrigins: 4,
    thirdPartyRequests: 6,
    thirdPartyBytes: 1234,
    adScriptBytes: 0,
    largestImageBytes: 9000,
    oversizedImages: 1,
    clsValue: 0.123456,
    tbtMs: 90,
    unusedCssRatio: 0.62,
    unusedJsRatio: -1,
    preConsentTrackingCookies: 1,
    contrastViolations: -1,
    mainCount: 0,
    resourceHintCount: 0,
    privacyLinkCount: 0,
    tlsMs: 40,
    eeatSignals: 1,
    headers: { 'content-encoding': 'br', 'x-frame-options': 'DENY', 'set-cookie': 'big', 'x-custom': 'noise' },
    htmlLang: 'en',
    inlineCssBytes: 0,
    inputsWithoutLabel: 0,
    duplicateHreflang: 0,
    jsonLdBlocks: 1,
    hasSocialTags: true,
    imageCount: 0,
    lazyImageCount: 0,
    videoCount: 0,
    hasVideoObjectSchema: false,
    videosWithoutCaptions: 0,
    videosWithoutPoster: 0,
    videosWithoutTitle: 0,
    autoplayVideosNoControls: 0,
    hasManifestLink: false,
    hasThemeColor: false,
    hasAppleTouchIcon: false,
    hasNoscript: false,
    h2Count: 0,
    inlineJsBytes: 0,
    httpInternalLinks: 0,
    redirectStatuses: [],
    hasHeadingSkip: false,
    textHtmlRatio: 0.5,
    hasFreshnessSignal: false,
    internalLinkCount: 5,
    lcpMs: 0,
    fcpMs: 0,
    fontRequests: 0,
    fontBytes: 0,
    consoleErrors: 0,
    hasAuthorByline: true,
    redirectCount: 0,
    hasImagePreload: true,
    totalLinkCount: 10,
    affiliateLinksNoRel: 0,
    hasNoindexMeta: false,
    totalImageBytes: 0,
    selfPostGetForms: 0,
  };

  void it('summarises signals, rounds ratios, nulls unmeasured coverage/contrast, and keeps only relevant headers', () => {
    const snap = liveSignalsSnapshot(sig);
    assert.strictEqual(snap.titleLength, 'A title here'.length);
    assert.strictEqual(snap.semanticRatio, 0.43);
    assert.strictEqual(snap.clsValue, 0.123);
    assert.strictEqual(snap.unusedCssPct, 62);
    assert.strictEqual(snap.unusedJsPct, null, 'unmeasured JS coverage → null');
    assert.strictEqual(snap.contrastViolations, null, 'unmeasured contrast → null');
    const headers = snap.headers as Record<string, string>;
    assert.ok(headers['content-encoding'] === 'br' && headers['x-frame-options'] === 'DENY');
    assert.ok(!('set-cookie' in headers) && !('x-custom' in headers), 'irrelevant headers dropped');
  });
});

void describe('live-verifier: defaultConfidence', () => {
  void it('confirmed/refuted on a stable signal are high-confidence', () => {
    assert.strictEqual(defaultConfidence('confirmed', 'confirmed'), 'high');
    assert.strictEqual(defaultConfidence('refuted', 'refuted'), 'high');
  });
  void it('LLM verdicts are low-confidence; other unverified are medium', () => {
    assert.strictEqual(defaultConfidence('confirmed', 'llm-unsure'), 'low');
    assert.strictEqual(defaultConfidence('unverified', 'site-level'), 'medium');
  });
});

import { isSuspectedInfinitePagination } from '../lib/analyzers/seo/pagination-analyzer';

void describe('pagination probe: isSuspectedInfinitePagination', () => {
  const base = {
    clicks: 3,
    controlPersists: true,
    urlAdvanced: true,
    emptyAfterClick: false,
    contentChanged: true,
    duplicateStreak: 0,
  };

  void it('FALSE POSITIVE GUARD: in-page/hash "next" that never advances the URL is never flagged', () => {
    // agntcms /docs case: clicking "next" only changed the hash, content identical.
    assert.strictEqual(
      isSuspectedInfinitePagination({ ...base, urlAdvanced: false, contentChanged: false, duplicateStreak: 3 }),
      false,
    );
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
    assert.strictEqual(
      isSuspectedInfinitePagination({ ...base, controlPersists: false, emptyAfterClick: true }),
      false,
    );
  });
});

// ============================================================
// Phase 2: issue-aware visual evidence (overlays / CLS pair / SERP)
// ============================================================
import { evidenceKindFor, looksLikeProseExample } from '../lib/phase2/phase2-runner';

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
      files: [
        'screenshot.mobile.png',
        'screenshot.desktop.png',
        'screenshot.firstload.png',
        'overlays.json',
        'requests.json',
      ],
    };
  }

  function evidenceArts(msg: string, ev: { dir: string; files: string[] }): AuditArtifacts {
    const a = mkArtifacts([msg], { [msg]: ['https://example.com/about'] });
    a.runDir = ev.dir;
    a.manifest.evidence = { 'https_example.com_about': { url: 'https://example.com/about', files: ev.files } };
    return a;
  }

  void it('looksLikeProseExample distinguishes guidance prose from code samples', () => {
    // Prose guidance — must NOT be fenced as code.
    assert.ok(looksLikeProseExample('Replace dead links with archived versions or remove them entirely.'));
    assert.ok(looksLikeProseExample('Change light gray text (#999) on white to darker gray (#595959) for 7:1 ratio.'));
    assert.ok(
      looksLikeProseExample(
        'Use try/catch for error-prone code. Test with JavaScript disabled for graceful degradation.',
      ),
    );
    // Real code — must stay fenced.
    assert.ok(!looksLikeProseExample('<link rel="canonical" href="https://example.com/page">'));
    assert.ok(!looksLikeProseExample('gtag("consent", "default", { ad_storage: "denied" });'));
    assert.ok(!looksLikeProseExample('User-agent: *\nAllow: /'));
    assert.ok(!looksLikeProseExample('sudo certbot --nginx -d example.com'));
  });

  void it('maps finding messages to their evidence kind', () => {
    assert.deepStrictEqual(evidenceKindFor('Some images are missing alt text'), {
      type: 'overlay',
      kind: 'missing-alt',
    });
    // "Image links without alt text" must hit missing-alt, NOT empty-anchor.
    assert.deepStrictEqual(evidenceKindFor('Image links without alt text'), { type: 'overlay', kind: 'missing-alt' });
    assert.deepStrictEqual(evidenceKindFor('Some pages have CLS more than 0.1'), { type: 'cls' });
    assert.deepStrictEqual(evidenceKindFor('Pages have titles that are too long'), { type: 'serp', field: 'title' });
    assert.deepStrictEqual(evidenceKindFor('Links with empty anchor text'), { type: 'overlay', kind: 'empty-anchor' });
    assert.deepStrictEqual(evidenceKindFor('Insufficient color contrast detected'), {
      type: 'overlay',
      kind: 'contrast',
    });
    assert.deepStrictEqual(evidenceKindFor('Canonicals are not set for some pages'), {
      type: 'head',
      aspect: 'canonical',
    });
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

  function mkEvidence3(
    over: Record<string, unknown> = {},
    extraDirs: Record<string, { url: string; files: string[] }> = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlays3-'));
    const pageDir = path.join(dir, 'evidence', 'https_example.com_about');
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'overlays.json'), JSON.stringify({ ...OVERLAYS3, ...over }));
    const files = ['screenshot.mobile.png', 'screenshot.firstload.png', 'screenshot.nojs.png', 'overlays.json'];
    return { dir, evidence: { 'https_example.com_about': { url: 'https://example.com/about', files }, ...extraDirs } };
  }

  function arts3(
    msg: string,
    ev: { dir: string; evidence: Record<string, { url: string; files: string[] }> },
  ): AuditArtifacts {
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
    assert.deepStrictEqual(evidenceKindFor('Form inputs missing autocomplete attribute'), {
      type: 'overlay',
      kind: 'autocomplete',
    });
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
    fs.writeFileSync(
      path.join(ev.dir, 'incoming-links.json'),
      JSON.stringify({ 'https://example.com/': ['https://example.com/blog'] }),
    );
    fs.writeFileSync(
      path.join(ev.dir, 'metadata.json'),
      JSON.stringify({ sitemaps: { urls: { 'https://example.com/': {} } } }),
    );
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
    fs.writeFileSync(
      path.join(ev.dir, 'metadata.json'),
      JSON.stringify({ sitemaps: { urls: { 'https://example.com/': {} } } }),
    );
    const md = buildReportMarkdown(arts3('Orphan page (no internal links point to it)', ev));
    assert.match(md, /Link-graph facts/);
    assert.match(md, /0 inbound links/);
    assert.match(md, /not in sitemap ✗/);
  });
});

// ============================================================
// Repo-specific fix coverage (Tier 1: framework-uniform recommendations)
// ============================================================
import { resolveFix } from '../lib/phase2/phase2-runner';
import { NEXTJS_FIX_OVERRIDES } from '../lib/scoring/nextjs-recommendations';

void describe('uniform fix recommendations', () => {
  // The legacy one-size-fits-all line that Tier 1 replaced. No resolved fix
  // should ever equal it again.
  const LEGACY_FALLBACK =
    'Review the affected pages listed above and apply the standard best practice for this issue. Prioritise the pages with the highest traffic or business value first.';

  // Authoritative corpus: the deterministic finding messages produced on a real
  // Next.js audit (siro.ai reference run). Excludes AI-discovered findings,
  // which carry their own remediation.
  const REAL_MESSAGES = [
    'Some pages have too many requests',
    'Some pages have links without any text',
    'Empty anchor text',
    'Some images are significantly larger than their display size',
    'Pages serve images only as JPG/PNG instead of WebP/AVIF',
    'Some pages have too many render-blocking resources',
    'Too many third-party origins',
    'Low semantic HTML usage',
    'External scripts missing Subresource Integrity (SRI)',
    'No author information found',
    'Large amount of inline JavaScript',
    'Low text-to-HTML ratio',
    'Temporary redirect used instead of permanent',
    'Missing Permissions-Policy header',
    'Missing cross-origin isolation headers',
    'Large amount of unused code',
    'Some pages have LCP more than 2500ms',
    'Some pages have TBT more than 200ms',
    'Some pages have descriptions that are too short',
    'Canonicals are not set for some pages',
    'Pages have image files larger than recommended',
    'Large third-party payload',
    'Render-blocking third-party scripts',
    'Heavy advertising scripts',
    'LCP image not preloaded',
    'Some pages have CLS more than 0.1',
    'Some pages have titles that are too long',
    'Missing preconnect for font services',
    'Some pages have titles that are too short',
    'Some pages have more than one h1 tag',
    'Form inputs missing autocomplete attribute',
    'Excessive DOM size',
    'High percentage of unused CSS',
    'Some pages have descriptions that are too long',
    'Description meta tag is missing',
    'Duplicate page titles found',
    'Duplicate meta descriptions found',
    'Parameterized URLs share a title',
    'Parameterized URLs share a description',
    'Low structured data coverage',
    'Indexable pages missing from sitemap',
    'Orphan page (no internal links point to it)',
    'Page has very low internal link equity',
    'Paginated page has incorrect canonical',
    'LCP images not preloaded across site',
    'Most pages lack resource hints',
  ];

  void it('never resolves to the legacy generic fallback line (generic or Next.js)', () => {
    for (const msg of REAL_MESSAGES) {
      for (const isNext of [false, true]) {
        const { fix } = resolveFix(msg, isNext);
        assert.ok(fix && fix.trim().length > 0, `empty fix for "${msg}" (next=${isNext})`);
        assert.notStrictEqual(fix, LEGACY_FALLBACK, `"${msg}" (next=${isNext}) still uses the legacy fallback`);
      }
    }
  });

  void it('gives findings that previously rendered raw HTML on Next.js sites a catalogued, framework-aware fix', () => {
    // These were the visibly-generic gaps in the siro report: a base catalog
    // entry existed but no Next.js override, so a raw <img>/<script> example
    // shipped to a Next.js site. They must now resolve from the catalog.
    const MUST_BE_NEXT_SPECIFIC = [
      'Some pages have CLS more than 0.1',
      'Some pages have LCP more than 2500ms',
      'Some pages have too many requests',
      'Some pages have titles that are too long',
      'Some pages have titles that are too short',
      'Some pages have descriptions that are too short',
      'Some pages have more than one h1 tag',
      'Page has very low internal link equity',
      'Orphan page (no internal links point to it)',
      'Paginated page has incorrect canonical',
      'Low structured data coverage',
      'Large third-party payload',
    ];
    for (const msg of MUST_BE_NEXT_SPECIFIC) {
      const { fix, fromCatalog } = resolveFix(msg, true);
      assert.ok(fromCatalog, `"${msg}" should resolve from the catalog on Next.js, not the category default`);
      // Framework-aware: names a Next.js API, or the React/Next units a
      // component-level fix is expressed in (component, route, JSON-LD).
      assert.match(
        fix,
        /next\/|metadata api|server component|generatemetadata|app router|\bcomponents?\b|\broutes?\b|json-ld/i,
        `"${msg}" Next.js fix should be framework-aware`,
      );
    }
  });

  void it('spelling findings resolve to a proofreading fix, not the Next.js redirects() default', () => {
    // Regression: "Spelling errors detected (N instances)" had no catalog entry
    // and classified as `technical`, so it inherited DEFAULT_FIX_NEXTJS.technical
    // ("Resolve this in the Next.js config or route source (redirects()…)").
    for (const isNext of [false, true]) {
      const { fix, fromCatalog } = resolveFix('Spelling errors detected (54 instances)', isNext);
      assert.ok(fromCatalog, 'spelling should resolve from the catalog, not the category default');
      assert.match(fix, /proofread|spell[- ]?check|misspell/i, 'spelling fix should be about proofreading');
      assert.doesNotMatch(
        fix,
        /redirects?\(\)|metadata api/i,
        'spelling fix must not be the redirect/metadata default',
      );
    }
  });

  void it('Core Web Vitals fixes on Next.js use next/image, not a raw <img> example', () => {
    for (const msg of ['Some pages have CLS more than 0.1', 'Some pages have LCP more than 2500ms']) {
      const { example } = resolveFix(msg, true);
      assert.ok(example, `expected an example for "${msg}"`);
      assert.doesNotMatch(example!, /<img\b/i, `"${msg}" Next.js example must not use a raw <img>`);
      assert.match(example!, /next\/image|<Image\b/, `"${msg}" Next.js example should use next/image`);
    }
  });

  void it('no catalogued example contains a hardcoded foreign brand', () => {
    const merged = { ...ScoreCalculator.getFixRecommendations() };
    for (const [key, rec] of Object.entries(merged)) {
      if (rec.example) assert.doesNotMatch(rec.example, /FocusReactive/i, `base catalog "${key}" leaks a brand name`);
    }
    for (const [key, rec] of Object.entries(NEXTJS_FIX_OVERRIDES)) {
      if (rec.example)
        assert.doesNotMatch(rec.example, /FocusReactive/i, `Next.js override "${key}" leaks a brand name`);
    }
  });
});

// ============================================================
// LLM usage tracker (token/cost accounting)
// ============================================================
import {
  recordApiUsage,
  recordCliUsage,
  recordCacheHit,
  getLlmUsageSnapshot,
  resetLlmUsage,
  estimateApiCostUsd,
} from '../lib/utils/llm-usage-tracker';
import { extractCliUsage } from '../lib/phase2/claude-cli';

void describe('LLM usage tracker', () => {
  void it('prices API tokens per model family', () => {
    // Sonnet: $3/M in, $15/M out → 1M in + 1M out = $18
    assert.ok(
      Math.abs(estimateApiCostUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 18) <
        1e-6,
    );
    // Opus: $15/M in, $75/M out → $90
    assert.ok(
      Math.abs(estimateApiCostUsd('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 90) <
        1e-6,
    );
    // Haiku: $1/M in, $5/M out → $6
    assert.ok(
      Math.abs(estimateApiCostUsd('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 6) <
        1e-6,
    );
    // Unknown model → sonnet-class default ($18)
    assert.ok(
      Math.abs(estimateApiCostUsd('some-future-model', { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 18) <
        1e-6,
    );
    // No usage → 0
    assert.strictEqual(estimateApiCostUsd('claude-sonnet-4-6', undefined), 0);
  });

  void it('aggregates API usage into total + per-category with estimated=true', () => {
    resetLlmUsage();
    recordApiUsage('narrative', 'claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 200 });
    recordApiUsage('narrative', 'claude-sonnet-4-6', { input_tokens: 500, output_tokens: 100 });
    recordApiUsage('verify', 'claude-sonnet-4-6', { input_tokens: 2000, output_tokens: 50 });
    const snap = getLlmUsageSnapshot();
    assert.strictEqual(snap.totalCalls, 3);
    assert.strictEqual(snap.cachedCalls, 0);
    assert.strictEqual(snap.inputTokens, 3500);
    assert.strictEqual(snap.outputTokens, 350);
    assert.strictEqual(snap.estimated, true);
    assert.strictEqual(snap.byCategory.narrative.calls, 2);
    assert.strictEqual(snap.byCategory.verify.calls, 1);
    assert.ok(snap.costUsd > 0);
    // Total cost == sum of category costs
    const sum = Object.values(snap.byCategory).reduce((s, c) => s + c.costUsd, 0);
    assert.ok(Math.abs(snap.costUsd - sum) < 1e-9);
  });

  void it('records CLI usage with the real total_cost_usd and estimated=false', () => {
    resetLlmUsage();
    recordCliUsage('repo', { input_tokens: 1234, output_tokens: 56 }, 0.0123);
    const snap = getLlmUsageSnapshot();
    assert.strictEqual(snap.totalCalls, 1);
    assert.strictEqual(snap.estimated, false);
    assert.ok(Math.abs(snap.costUsd - 0.0123) < 1e-9);
    assert.deepStrictEqual(snap.byCategory.repo.transports, ['cli']);
  });

  void it('counts cache hits separately from billed calls (free)', () => {
    resetLlmUsage();
    recordCacheHit('anomaly');
    recordCacheHit('anomaly');
    recordApiUsage('anomaly', 'claude-sonnet-4-6', { input_tokens: 100, output_tokens: 10 });
    const snap = getLlmUsageSnapshot();
    assert.strictEqual(snap.totalCalls, 1);
    assert.strictEqual(snap.cachedCalls, 2);
    assert.strictEqual(snap.byCategory.anomaly.calls, 1);
    assert.strictEqual(snap.byCategory.anomaly.cached, 2);
  });

  void it('reset clears all accumulated usage', () => {
    resetLlmUsage();
    recordApiUsage('narrative', 'claude-sonnet-4-6', { input_tokens: 1, output_tokens: 1 });
    resetLlmUsage();
    const snap = getLlmUsageSnapshot();
    assert.strictEqual(snap.totalCalls, 0);
    assert.deepStrictEqual(snap.byCategory, {});
  });

  void it('cache-only category appears with zero billed cost', () => {
    resetLlmUsage();
    recordCacheHit('finding-verify');
    const snap = getLlmUsageSnapshot();
    assert.strictEqual(snap.totalCalls, 0);
    assert.strictEqual(snap.cachedCalls, 1);
    assert.strictEqual(snap.byCategory['finding-verify'].costUsd, 0);
  });
});

void describe('extractCliUsage', () => {
  void it('parses usage + total_cost_usd from the JSON envelope', () => {
    const env = JSON.stringify({
      result: 'ok',
      total_cost_usd: 0.0456,
      usage: { input_tokens: 321, output_tokens: 12, cache_read_input_tokens: 100 },
    });
    const u = extractCliUsage(env);
    assert.strictEqual(u.costUsd, 0.0456);
    assert.strictEqual(u.usage?.input_tokens, 321);
    assert.strictEqual(u.usage?.output_tokens, 12);
    assert.strictEqual(u.usage?.cache_read_input_tokens, 100);
  });

  void it('returns empty object on non-JSON / bare text', () => {
    assert.deepStrictEqual(extractCliUsage('just some text, no brace'), {});
    assert.deepStrictEqual(extractCliUsage('{ broken json'), {});
    assert.deepStrictEqual(extractCliUsage(''), {});
  });
});

// ============================================================
// Phase 4 — Competitive Content Research
// ============================================================
import { extractTopKeywords, normaliseOrigin } from '../lib/phase4/competitor-crawl';
import { computeCompetitiveGaps } from '../lib/phase4/competitive-gap';
import { filterValidCompetitors } from '../lib/phase4/competitor-discovery';
import { extractJson } from '../lib/phase4/llm-client';
import type { CompetitorProfile, KeywordInjection } from '../lib/phase4/types';

// Build a minimal PageInfo carrying only the topic signal the gap analyzer reads.
function cpPage(url: string, words: string[], wordCount = 600): PageInfo {
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
  const topKeywords = Object.entries(freq).map(([word, count]) => ({
    word,
    count,
    density: Number(((count / wordCount) * 100).toFixed(2)),
  }));
  return { url, contentQuality: { wordCount, topKeywords } } as unknown as PageInfo;
}

function mkCompetitor(host: string, pages: Record<string, PageInfo>): CompetitorProfile {
  return {
    origin: `https://${host}`,
    host,
    pagesCrawled: Object.keys(pages).length,
    pagesAttempted: Object.keys(pages).length,
    pages,
    discovered: false,
  };
}

void describe('Phase 4 — extractTopKeywords', () => {
  void it('filters stop words and short words, ranks by frequency', () => {
    const kws = extractTopKeywords('the and a kubernetes kubernetes kubernetes deployment deployment cat');
    const words = kws.map((k) => k.word);
    assert.ok(!words.includes('the'), 'stop word "the" excluded');
    assert.ok(!words.includes('cat'), 'short word (<4 chars) "cat" excluded');
    assert.strictEqual(words[0], 'kubernetes', 'most frequent word ranked first');
    assert.strictEqual(kws[0].count, 3);
  });

  void it('is deterministic and caps at 10 keywords', () => {
    const text = Array.from({ length: 20 }, (_, i) => `term${i} term${i}`).join(' ');
    const a = extractTopKeywords(text);
    const b = extractTopKeywords(text);
    assert.strictEqual(a.length, 10);
    assert.deepStrictEqual(a, b);
  });

  void it('returns [] for empty text', () => {
    assert.deepStrictEqual(extractTopKeywords(''), []);
    assert.deepStrictEqual(extractTopKeywords('   '), []);
  });
});

void describe('Phase 4 — normaliseOrigin', () => {
  void it('adds https and strips path', () => {
    assert.strictEqual(normaliseOrigin('example.com'), 'https://example.com');
    assert.strictEqual(normaliseOrigin('https://example.com/blog/post'), 'https://example.com');
    assert.strictEqual(normaliseOrigin('http://example.com'), 'http://example.com');
  });
  void it('returns null on junk', () => {
    assert.strictEqual(normaliseOrigin(''), null);
    assert.strictEqual(normaliseOrigin('not a url with spaces'), null);
  });
});

void describe('Phase 4 — computeCompetitiveGaps', () => {
  // Our site covers "pricing" but NOT "kubernetes"; both competitors cover
  // "kubernetes" across multiple pages → it must surface as a missing gap.
  const ourPages: Record<string, PageInfo> = {
    'https://us.com/pricing': cpPage('https://us.com/pricing', ['pricing', 'pricing', 'pricing', 'plans']),
  };
  const compA = mkCompetitor('a.com', {
    'https://a.com/k8s-1': cpPage('https://a.com/k8s-1', ['kubernetes', 'kubernetes', 'kubernetes', 'cluster'], 1800),
    'https://a.com/k8s-2': cpPage('https://a.com/k8s-2', ['kubernetes', 'kubernetes', 'cluster', 'cluster']),
  });
  const compB = mkCompetitor('b.com', {
    'https://b.com/k8s': cpPage('https://b.com/k8s', ['kubernetes', 'kubernetes', 'deployment']),
  });

  void it('surfaces a topic competitors cover that we do not', () => {
    const gaps = computeCompetitiveGaps(ourPages, [compA, compB]);
    const k8s = gaps.find((g) => g.keywords.includes('kubernetes'));
    assert.ok(k8s, 'kubernetes gap detected');
    assert.strictEqual(k8s!.ourPages, 0);
    assert.strictEqual(k8s!.gapType, 'missing');
    assert.ok(k8s!.coveringCompetitors >= 2, 'both competitors counted');
    assert.ok(k8s!.competitorBestWordCount >= 1800, 'tracks deepest competitor word count');
  });

  void it('is deterministic (same input → identical ranked output)', () => {
    const a = computeCompetitiveGaps(ourPages, [compA, compB]);
    const b = computeCompetitiveGaps(ourPages, [compA, compB]);
    assert.deepStrictEqual(a, b);
  });

  void it('returns [] when no competitor has crawled pages', () => {
    const empty = mkCompetitor('x.com', {});
    assert.deepStrictEqual(computeCompetitiveGaps(ourPages, [empty]), []);
  });

  void it('joins injected search volume onto matching gaps and re-ranks', () => {
    const injection: KeywordInjection = { keywords: [{ term: 'kubernetes', volume: 90000, difficulty: 40 }] };
    const gaps = computeCompetitiveGaps(ourPages, [compA, compB], injection);
    const k8s = gaps.find((g) => g.keywords.includes('kubernetes'));
    assert.ok(k8s, 'gap present');
    assert.strictEqual(k8s!.searchVolume, 90000);
    assert.strictEqual(k8s!.difficulty, 40);
  });
});

void describe('Phase 4 — filterValidCompetitors (anti-hallucination guard)', () => {
  void it('drops invalid, private, self, and duplicate hosts', () => {
    const out = filterValidCompetitors(
      [
        'https://good.com',
        'good.com', // duplicate host (normalised)
        'http://127.0.0.1', // private host
        'http://localhost:3000', // private host
        'not a url', // unparseable
        42, // non-string
        'https://us.com', // our own host
        'ftp://nope.com', // unsupported protocol
      ],
      'us.com',
    );
    assert.deepStrictEqual(out, ['https://good.com']);
  });

  void it('caps the list at MAX_COMPETITORS (5)', () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://c${i}.com`);
    const out = filterValidCompetitors(many, 'us.com');
    assert.strictEqual(out.length, 5);
  });
});

void describe('Phase 4 — extractJson', () => {
  void it('parses fenced and prose-wrapped JSON', () => {
    assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(extractJson('Here you go: {"competitors":["x"]} done'), { competitors: ['x'] });
    assert.deepStrictEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  });
  void it('returns null on unparseable input', () => {
    assert.strictEqual(extractJson('not json at all'), null);
    assert.strictEqual(extractJson(null), null);
  });
});

// ============================================================
// Phase 4 — topic-extract (cleaner topic signal)
// ============================================================
import { isContentTerm, extractPageTerms, buildTermIndex } from '../lib/phase4/topic-extract';

void describe('Phase 4 — isContentTerm', () => {
  void it('accepts real content words', () => {
    for (const w of ['kubernetes', 'marketing', 'content', 'workflows']) {
      assert.ok(isContentTerm(w), `${w} should be a content term`);
    }
  });
  void it('rejects URL/GTM fragments, code tokens, no-vowel and over-long junk', () => {
    assert.strictEqual(isContentTerm('srchttpswwwgoogletagmanagercomnshtmlidgtmn3wstxz'), false); // long + http/gtm
    assert.strictEqual(isContentTerm('https'), false);
    assert.strictEqual(isContentTerm('const'), false); // code token
    assert.strictEqual(isContentTerm('await'), false); // code token
    assert.strictEqual(isContentTerm('bcdfg'), false); // no vowel (y counts as one, so rhythm-like words pass)
    assert.strictEqual(isContentTerm('the'), false); // stop word / too short
    assert.strictEqual(isContentTerm('ai'), false); // too short
  });
  void it('does not reject ambiguous product words (resource contains "src")', () => {
    assert.ok(isContentTerm('resource'));
    assert.ok(isContentTerm('config')); // product word, kept
  });
});

void describe('Phase 4 — extractPageTerms', () => {
  void it('pulls bigrams from title + h1 and filters topKeyword noise', () => {
    const page = {
      url: 'https://x.com/p',
      title: 'Content Modeling Guide',
      headings: { h1: ['Structured content basics'] },
      contentQuality: {
        wordCount: 500,
        topKeywords: [
          { word: 'modeling', count: 5, density: 1 },
          { word: 'srchttpsgtmabc', count: 9, density: 2 }, // GTM junk → dropped
          { word: 'const', count: 8, density: 1 }, // code token → dropped
        ],
      },
    } as unknown as PageInfo;
    const terms = extractPageTerms(page);
    assert.ok(terms.has('content modeling'), 'title bigram present');
    assert.ok(terms.has('structured content'), 'h1 bigram present');
    assert.ok(terms.has('modeling'), 'clean topKeyword kept');
    assert.ok(!terms.has('const'), 'code token dropped');
    assert.ok(![...terms].some((t) => t.includes('gtm') || t.includes('http')), 'no GTM/URL fragments');
  });
});

void describe('Phase 4 — buildTermIndex', () => {
  void it('maps terms to the set of page URLs', () => {
    const pages: Record<string, PageInfo> = {
      'https://x.com/a': {
        url: 'https://x.com/a',
        title: 'Kubernetes Guide',
        headings: { h1: [] },
        contentQuality: { wordCount: 100, topKeywords: [] },
      } as unknown as PageInfo,
      'https://x.com/b': {
        url: 'https://x.com/b',
        title: 'Kubernetes Networking',
        headings: { h1: [] },
        contentQuality: { wordCount: 100, topKeywords: [] },
      } as unknown as PageInfo,
    };
    const idx = buildTermIndex(pages);
    assert.strictEqual(idx.get('kubernetes')?.urls.size, 2, 'kubernetes appears on both pages');
    assert.ok(idx.has('kubernetes guide'));
  });
});

// ============================================================
// Phase 4 — scoreGap (opportunity-score spread, #3)
// ============================================================
import { scoreGap } from '../lib/phase4/competitive-gap';

void describe('Phase 4 — scoreGap discrimination', () => {
  void it('ranks a high-signal gap well above a low-signal one', () => {
    const strong = scoreGap({
      gapType: 'missing',
      competitorPages: 50,
      coveringCompetitors: 5,
      competitorBestWordCount: 3600,
      keywords: ['documentation reference'],
    });
    const weak = scoreGap({
      gapType: 'depth',
      competitorPages: 2,
      coveringCompetitors: 1,
      competitorBestWordCount: 400,
      keywords: ['tip'],
    });
    assert.ok(strong > weak + 25, `strong (${strong}) should clearly outrank weak (${weak})`);
  });

  void it('spreads scores across a varied gap set (not all equal)', () => {
    const gaps = [
      {
        gapType: 'missing' as const,
        competitorPages: 51,
        coveringCompetitors: 5,
        competitorBestWordCount: 2800,
        keywords: ['documentation'],
      },
      {
        gapType: 'missing' as const,
        competitorPages: 30,
        coveringCompetitors: 1,
        competitorBestWordCount: 2789,
        keywords: ['builder'],
      },
      {
        gapType: 'missing' as const,
        competitorPages: 12,
        coveringCompetitors: 2,
        competitorBestWordCount: 1700,
        keywords: ['collection'],
      },
      {
        gapType: 'missing' as const,
        competitorPages: 4,
        coveringCompetitors: 1,
        competitorBestWordCount: 1100,
        keywords: ['workflows'],
      },
    ];
    const scores = gaps.map(scoreGap);
    assert.strictEqual(new Set(scores).size, scores.length, `expected distinct scores, got ${JSON.stringify(scores)}`);
  });

  void it('lets injected search volume raise and difficulty lower the score, clamped 0–100', () => {
    const base = scoreGap({ gapType: 'missing', competitorPages: 10, coveringCompetitors: 2, keywords: ['x'] });
    const hot = scoreGap({
      gapType: 'missing',
      competitorPages: 10,
      coveringCompetitors: 2,
      keywords: ['x'],
      searchVolume: 90000,
    });
    const hard = scoreGap({
      gapType: 'missing',
      competitorPages: 10,
      coveringCompetitors: 2,
      keywords: ['x'],
      searchVolume: 90000,
      difficulty: 90,
    });
    assert.ok(hot > base, 'volume raises score');
    assert.ok(hard < hot, 'difficulty lowers score');
    for (const s of [base, hot, hard]) assert.ok(s >= 0 && s <= 100, `clamped: ${s}`);
  });
});

// ============================================================
// Phase 4 — bestTopicLabel (#4 phrase labels)
// ============================================================
import { bestTopicLabel, titleCase as p4TitleCase } from '../lib/phase4/topic-extract';
import type { TermIndexEntry } from '../lib/phase4/topic-extract';

function termIdx(entries: Record<string, number>): Map<string, TermIndexEntry> {
  const m = new Map<string, TermIndexEntry>();
  for (const [word, n] of Object.entries(entries)) {
    m.set(word, { word, urls: new Set(Array.from({ length: n }, (_, i) => `u${i}`)), totalDensity: 0, avgDensity: 0 });
  }
  return m;
}

void describe('Phase 4 — bestTopicLabel', () => {
  void it('prefers the most-supported on-topic phrase over the bare seed', () => {
    const idx = termIdx({ content: 9, 'content modeling': 5, 'structured content': 2 });
    const label = bestTopicLabel('content', ['content', 'content modeling', 'structured content'], idx);
    assert.strictEqual(label, 'content modeling');
  });
  void it('falls back to the seed when the cluster has no phrase', () => {
    const idx = termIdx({ pricing: 4 });
    assert.strictEqual(bestTopicLabel('pricing', ['pricing', 'plans'], idx), 'pricing');
  });
  void it('is deterministic on ties (support → length → lexical)', () => {
    // Equal support (3) and equal length (14) → lexical tiebreak decides.
    const idx = termIdx({ access: 6, 'access control': 3, 'access manager': 3 });
    const kws = ['access', 'access control', 'access manager'];
    const a = bestTopicLabel('access', kws, idx);
    const b = bestTopicLabel('access', [...kws].reverse(), idx);
    assert.strictEqual(a, b, 'order-independent');
    assert.strictEqual(a, 'access control', 'equal support+length → lexical first');
  });
  void it('titleCase renders phrases for display', () => {
    assert.strictEqual(p4TitleCase('content modeling'), 'Content Modeling');
    assert.strictEqual(p4TitleCase('access'), 'Access');
  });
});

// ============================================================
// Phase 4 — applyPlanTopics (#2 LLM topic relabel)
// ============================================================
import { applyPlanTopics } from '../lib/phase4/content-synthesis';
import type { CompetitiveGap, ContentPlanItem } from '../lib/phase4/types';

function mkGap(topic: string): CompetitiveGap {
  return {
    topic,
    keywords: [topic],
    ourPages: 0,
    ourBestWordCount: 0,
    ourExamples: [],
    competitorPages: 3,
    coveringCompetitors: 1,
    competitorBestWordCount: 0,
    bestCompetitor: null,
    gapType: 'missing',
    opportunityScore: 50,
    examples: [],
  };
}
function mkItem(topic?: string): ContentPlanItem {
  return {
    priority: 1,
    topic,
    title: 't',
    targetKeywords: [],
    rationale: 'r',
    format: 'f',
    suggestedWordCount: 1000,
    brief: 'b',
  };
}

void describe('Phase 4 — applyPlanTopics', () => {
  void it('relabels gaps from the matching plan item topic (1:1, in order)', () => {
    const gaps = [mkGap('documentation payload'), mkGap('visual development')];
    applyPlanTopics(gaps, [mkItem('Documentation Reference'), mkItem('Visual Development')]);
    assert.deepStrictEqual(
      gaps.map((g) => g.topic),
      ['Documentation Reference', 'Visual Development'],
    );
  });
  void it('keeps the original label when the plan item has no usable topic', () => {
    const gaps = [mkGap('content modeling'), mkGap('access control')];
    applyPlanTopics(gaps, [mkItem('   '), mkItem(undefined)]);
    assert.deepStrictEqual(
      gaps.map((g) => g.topic),
      ['content modeling', 'access control'],
    );
  });
  void it('handles a shorter plan than gaps without error', () => {
    const gaps = [mkGap('a topic'), mkGap('b topic')];
    applyPlanTopics(gaps, [mkItem('A Topic')]);
    assert.deepStrictEqual(
      gaps.map((g) => g.topic),
      ['A Topic', 'b topic'],
    );
  });
});

// ============================================================
// Phase 4 — LLM topic taxonomy (Frontier 2)
// ============================================================
import { parseTaxonomy } from '../lib/phase4/topic-taxonomy';

void describe('Phase 4 — parseTaxonomy', () => {
  void it('parses valid topics, lowercases keywords, dedupes labels', () => {
    const raw =
      '```json\n{"topics":[{"label":"Content Modeling","keywords":["Content Modeling","Schema","fields"]},{"label":"Content Modeling","keywords":["dup"]},{"label":"Access Control","keywords":["roles","permissions"]}]}\n```';
    const t = parseTaxonomy(raw);
    assert.ok(t);
    assert.strictEqual(t!.length, 2, 'duplicate label dropped');
    assert.deepStrictEqual(t![0], { label: 'Content Modeling', keywords: ['content modeling', 'schema', 'fields'] });
  });
  void it('drops entries with no label or no keywords; returns null when nothing usable', () => {
    assert.strictEqual(parseTaxonomy('{"topics":[{"keywords":["x"]},{"label":"No Keywords","keywords":[]}]}'), null);
    assert.strictEqual(parseTaxonomy('not json'), null);
    assert.strictEqual(parseTaxonomy(null), null);
  });
});

void describe('Phase 4 — computeCompetitiveGaps with LLM topics', () => {
  // Our site covers "pricing"; competitors cover a "Content Modeling" topic.
  const ourPages: Record<string, PageInfo> = {
    'https://us.com/pricing': cpPage('https://us.com/pricing', ['pricing', 'pricing', 'plans']),
  };
  const compA = mkCompetitor('a.com', {
    'https://a.com/modeling': cpPage('https://a.com/modeling', ['modeling', 'modeling', 'schema'], 1500),
    'https://a.com/schema': cpPage('https://a.com/schema', ['schema', 'fields'], 900),
  });
  const compB = mkCompetitor('b.com', {
    'https://b.com/structured': cpPage('https://b.com/structured', ['schema', 'structured']),
  });

  void it('uses the supplied LLM topic label and maps pages by its keywords', () => {
    const topics = [{ label: 'Content Modeling', keywords: ['modeling', 'schema', 'structured'] }];
    const gaps = computeCompetitiveGaps(ourPages, [compA, compB], null, topics);
    const g = gaps.find((x) => x.topic === 'Content Modeling');
    assert.ok(g, 'topic uses the LLM label verbatim');
    assert.strictEqual(g!.ourPages, 0, 'we do not cover it');
    assert.strictEqual(g!.gapType, 'missing');
    assert.ok(g!.competitorPages >= 2 && g!.coveringCompetitors === 2, 'mapped across both competitors');
  });

  void it('falls back to lexical clustering when no topics are supplied', () => {
    const lexical = computeCompetitiveGaps(ourPages, [compA, compB]);
    assert.ok(lexical.length > 0, 'still produces gaps without LLM topics');
  });
});

// ============================================================
// Phase 4 — create-vs-expand actionability
// ============================================================
import { buildContentPlan, resolvePlanActions } from '../lib/phase4/content-plan';

void describe('Phase 4 — create vs expand', () => {
  function gap(over: Partial<CompetitiveGap>): CompetitiveGap {
    return {
      topic: 'content modeling',
      keywords: ['content modeling', 'schema'],
      ourPages: 0,
      ourBestWordCount: 0,
      ourExamples: [],
      competitorPages: 5,
      coveringCompetitors: 2,
      competitorBestWordCount: 2000,
      bestCompetitor: 'a.com',
      gapType: 'missing',
      opportunityScore: 80,
      examples: [],
      ...over,
    };
  }

  void it('resolvePlanActions: create with no page, expand when we have one', () => {
    const acts = resolvePlanActions([
      gap({ ourPages: 0 }),
      gap({ ourPages: 2, gapType: 'thin', ourBestExample: 'https://us.com/x' }),
    ]);
    assert.strictEqual(acts[0].action, 'create');
    assert.deepStrictEqual(acts[1], { action: 'expand', targetPage: 'https://us.com/x' });
  });

  void it('de-dups expand targets: a page is claimed by the highest-priority topic only', () => {
    // Both gaps map to the same best page; only the first (higher priority) expands it.
    const acts = resolvePlanActions([
      gap({ topic: 'a', ourPages: 2, gapType: 'thin', ourBestExample: 'https://us.com/manifesto' }),
      gap({ topic: 'b', ourPages: 1, gapType: 'thin', ourBestExample: 'https://us.com/manifesto' }),
    ]);
    assert.deepStrictEqual(acts[0], { action: 'expand', targetPage: 'https://us.com/manifesto' });
    assert.strictEqual(acts[1].action, 'create', 'second topic on the same page becomes create');
    assert.strictEqual(acts[1].targetPage, undefined);
  });

  void it('buildContentPlan surfaces the target page URL for expand items', () => {
    const plan = buildContentPlan([
      gap({
        ourPages: 1,
        gapType: 'thin',
        ourExamples: ['https://us.com/cms'],
        ourBestExample: 'https://us.com/cms',
        ourBestWordCount: 420,
      }),
      gap({ topic: 'access control', ourPages: 0 }),
    ]);
    assert.strictEqual(plan[0].action, 'expand');
    assert.strictEqual(plan[0].targetPage, 'https://us.com/cms');
    assert.ok(plan[0].brief.includes('https://us.com/cms'), 'brief names the page to expand');
    assert.strictEqual(plan[1].action, 'create');
    assert.strictEqual(plan[1].targetPage, undefined);
    assert.ok(/create a new page/i.test(plan[1].brief));
  });
});

// ─── Report-doc QA fixes (tier-twins, form action, transient 5xx, spelling,
//     cookie-banner precision, first-party host) ──────────────────────────────
import { analyzeUrlStructure, isFirstPartyHost } from '../lib/utils';
import { TechnicalSEOAnalyzer } from '../lib/analyzers/seo/technical-seo-analyzer';
import { ThirdPartyAnalyzer } from '../lib/analyzers/performance/third-party-analyzer';
import { FormAccessibilityAnalyzer } from '../lib/analyzers/accessibility/form-accessibility-analyzer';
import { collectFailedRequests } from '../lib/phase2/llm-anomaly';
import { detectMisspellings } from '../lib/analyzers/content/spelling-grammar-analyzer';
import { hasGenericConsentBanner } from '../lib/analyzers/security/cookie-consent-analyzer';

void describe('Report-doc fix — tier-twin collapse (report-rules.md §5)', () => {
  void it('URL length: ONE "URL is too long" message at a fixed MEDIUM severity across both bands', () => {
    const issuesFor = (pathLen: number) =>
      analyzeUrlStructure('https://example.com/' + 'a'.repeat(pathLen), 'https://example.com').issues;
    const hi = issuesFor(110).find((i) => /url is too long/i.test(i.message ?? '')); // > URL_LENGTH_MAX (100)
    const lo = issuesFor(80).find((i) => /url is too long/i.test(i.message ?? '')); // > RECOMMENDED (75), < MAX
    assert.ok(hi && lo, 'both bands emit a URL-length issue');
    assert.strictEqual((hi!.message ?? '').split('(')[0].trim(), 'URL is too long');
    assert.strictEqual((lo!.message ?? '').split('(')[0].trim(), 'URL is too long');
    assert.strictEqual(hi!.severity, lo!.severity, 'severity is fixed across bands (determinism)');
    assert.strictEqual(hi!.severity, 'medium');
    assert.ok(!issuesFor(80).some((i) => /longer than recommended/i.test(i.message ?? '')), 'dropped twin gone');
  });

  void it('HTML size: ONE "Large HTML document" at fixed MEDIUM across both bands', () => {
    const findingsFor = (bytes: number) => {
      const issues: Parameters<typeof TechnicalSEOAnalyzer.checkHTMLSize>[2] = [];
      const warnings: Parameters<typeof TechnicalSEOAnalyzer.checkHTMLSize>[3] = [];
      TechnicalSEOAnalyzer.checkHTMLSize(
        { htmlSize: bytes } as unknown as Parameters<typeof TechnicalSEOAnalyzer.checkHTMLSize>[0],
        'https://e.com/p',
        issues,
        warnings,
      );
      return [...issues, ...warnings];
    };
    const big = findingsFor(4 * 1024 * 1024); // > 3MB
    const mid = findingsFor(2 * 1024 * 1024); // > 1MB, < 3MB
    assert.strictEqual(big.length, 1);
    assert.strictEqual(mid.length, 1);
    assert.strictEqual(big[0].message, 'Large HTML document');
    assert.strictEqual(mid[0].message, 'Large HTML document');
    assert.strictEqual(big[0].severity, 'medium');
    assert.strictEqual(mid[0].severity, 'medium');
    assert.ok(!findingsFor(4 * 1024 * 1024).some((f) => /exceeds 3mb/i.test(f.message ?? '')), 'dropped twin gone');
  });

  void it('third-party payload: ONE "Large third-party payload" at fixed MEDIUM across both bands', async () => {
    const mockPage = { evaluate: async () => [] } as unknown as Parameters<typeof ThirdPartyAnalyzer.analyze>[0];
    const run = async (bytes: number) => {
      const reqs = {
        'https://cdn.thirdparty.io/a.js': { size: bytes, resourceType: 'script' },
      } as unknown as Parameters<typeof ThirdPartyAnalyzer.analyze>[1];
      const { issues, warnings } = await ThirdPartyAnalyzer.analyze(mockPage, reqs, 'https://example.com/', 'https://example.com');
      return [...issues, ...warnings].filter((f) => /third-party payload/i.test(f.message ?? ''));
    };
    const crit = await run(1_200_000); // > 1MB critical band
    const warn = await run(600_000); // > 500KB warning band
    assert.strictEqual(crit.length, 1);
    assert.strictEqual(warn.length, 1);
    assert.strictEqual(crit[0].message, 'Large third-party payload');
    assert.strictEqual(warn[0].message, 'Large third-party payload');
    assert.strictEqual(crit[0].severity, 'medium');
    assert.strictEqual(warn[0].severity, 'medium');
    assert.ok(!(await run(1_200_000)).some((f) => /excessive/i.test(f.message ?? '')), 'dropped twin gone');
  });
});

void describe('Report-doc fix — deterministic form-action finding (narrowed to GET data-form)', () => {
  const dummyPage = {} as unknown as Parameters<typeof FormAccessibilityAnalyzer.analyze>[0];
  const run = async (html: string) => {
    const parsed = parseHtml(html) as unknown as Parameters<typeof FormAccessibilityAnalyzer.analyze>[1];
    const { issues, warnings } = await FormAccessibilityAnalyzer.analyze(dummyPage, parsed, 'https://e.com/');
    return [...issues, ...warnings];
  };
  const fires = (fs: { message?: string }[]) => fs.some((f) => f.message === 'Form submits to itself via GET');

  void it('FIRES on a GET data form with empty action (fields leak to URL)', async () => {
    const fs = await run(
      '<form method="get" action=""><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Send</button></form>',
    );
    assert.ok(fires(fs), 'contact-style GET+empty-action form should fire');
    assert.strictEqual(fs.find((f) => f.message === 'Form submits to itself via GET')!.severity, 'medium');
  });
  void it('does NOT fire on a search box (empty action, GET, single search input)', async () => {
    assert.ok(!fires(await run('<form method="get" action="" role="search"><input type="search" name="q"></form>')));
  });
  void it('does NOT fire on a POST self-post form', async () => {
    assert.ok(
      !fires(await run('<form method="post" action=""><input type="email" name="email"><button type="submit">Go</button></form>')),
    );
  });
  void it('does NOT fire on a form with a real off-page action', async () => {
    assert.ok(!fires(await run('<form method="get" action="/search"><input type="text" name="query"></form>')));
  });
  void it('does NOT fire on a GET sort/filter/faceted-nav form (bookmarkable URL state is intentional)', async () => {
    assert.ok(
      !fires(
        await run(
          '<form method="get" action=""><select name="category"><option>a</option></select><select name="sort"><option>price</option></select><input type="text" name="min_price"></form>',
        ),
      ),
    );
  });
  void it('does NOT fire on a GET search box with a non-canonical field name', async () => {
    assert.ok(!fires(await run('<form method="get" action=""><input type="text" name="keywords"></form>')));
  });
  void it('does NOT fire on retail filter/store-locator GET forms whose field names contain product/location words', async () => {
    // mobile/card/postal previously over-matched SENSITIVE_NAME_RE → filter-form FP.
    assert.ok(!fires(await run('<form method="get" action=""><input type="text" name="mobile_brand"></form>')));
    assert.ok(!fires(await run('<form method="get" action=""><input type="text" name="card_type"></form>')));
    assert.ok(!fires(await run('<form method="get" action=""><input type="text" name="postal_code"></form>')));
    assert.ok(!fires(await run('<form method="get" action=""><input type="text" name="street_filter"></form>')));
  });
  void it('FIRES on a GET login form (credentials would leak to the URL)', async () => {
    assert.ok(
      fires(await run('<form method="get" action=""><input type="text" name="user"><input type="password" name="pass"></form>')),
    );
  });
});

void describe('Report-doc fix — transient 5xx not treated as broken (RH)', () => {
  void it('excludes 502/503/504 from failed requests but keeps 404/500', () => {
    const reqs = {
      requests: {
        'https://e.com/img-a.jpg': { status: 502 },
        'https://e.com/img-b.jpg': { status: 503 },
        'https://e.com/img-c.jpg': { status: 504 },
        'https://e.com/missing.js': { status: 404 },
        'https://e.com/err.js': { status: 500 },
        'https://e.com/ok.js': { status: 200 },
      },
    } as unknown as Parameters<typeof collectFailedRequests>[0];
    const statuses = collectFailedRequests(reqs)
      .map((r) => r.status)
      .sort((a, b) => a - b);
    assert.deepStrictEqual(statuses, [404, 500]);
  });
});

void describe('Report-doc fix — spelling brand/proper-noun guard (Arrive)', () => {
  void it('does NOT flag an always-capitalized brand but DOES flag a lowercase misspelling', () => {
    const brandOnly = detectMisspellings('Welcome to Definately. Definately builds software with Definately tools.');
    assert.ok(!brandOnly.misspellings.some((m) => m.word === 'definately'), 'always-capitalized brand not flagged');
    const inProse = detectMisspellings('This feature is definately useful and definately fast.');
    assert.ok(
      inProse.misspellings.some((m) => m.word === 'definately' && m.correction === 'definitely'),
      'genuine lowercase misspelling still flagged',
    );
  });
});

void describe('Report-doc fix — cookie banner precision (FR)', () => {
  void it('does NOT treat a footer "Cookie Policy" LINK as a consent banner', () => {
    const parsed = parseHtml(
      '<footer><a id="cookie-policy" href="/cookies">Cookie Policy</a></footer>',
    ) as unknown as Parameters<typeof hasGenericConsentBanner>[0];
    assert.strictEqual(hasGenericConsentBanner(parsed), false);
  });
  void it('does NOT treat a semantic <footer> landmark with policy links as a banner', () => {
    const parsed = parseHtml(
      '<footer class="site-footer gdpr-links"><a href="/privacy">Privacy Settings</a></footer>',
    ) as unknown as Parameters<typeof hasGenericConsentBanner>[0];
    assert.strictEqual(hasGenericConsentBanner(parsed), false);
  });
  void it('DOES detect a real banner container that exposes a consent action', () => {
    const parsed = parseHtml(
      '<div class="cookie-consent-banner">We use cookies. <button>Accept all</button> <button>Reject</button></div>',
    ) as unknown as Parameters<typeof hasGenericConsentBanner>[0];
    assert.strictEqual(hasGenericConsentBanner(parsed), true);
  });
});

void describe('Report-doc fix — first-party host www/sibling-subdomain (Lunacy)', () => {
  void it('treats a sibling asset subdomain as first-party when the origin is www', () => {
    assert.strictEqual(isFirstPartyHost('assets.lunacy.com', 'www.lunacy.com'), true);
    assert.strictEqual(isFirstPartyHost('www.lunacy.com', 'lunacy.com'), true);
  });
  void it('still classifies a genuine third party as third-party', () => {
    assert.strictEqual(isFirstPartyHost('cdn.jsdelivr.net', 'www.lunacy.com'), false);
    assert.strictEqual(isFirstPartyHost('googletagmanager.com', 'lunacy.com'), false);
  });
});

void describe('Sitemap-parser fix — relative <loc> resolution', () => {
  void it('resolves a path-only <loc> in a <url> entry against the sitemap that referenced it', () => {
    const doc = parseHtml('<urlset><url><loc>/en/foo</loc></url></urlset>');
    const urls = doc.querySelectorAll('url');
    const result = { sitemaps: {}, urls: {}, total: 0, errors: [] as Array<{ message: string; detail: string; severity: string }> };
    SitemapParser.processSitemap(
      urls as unknown as Parameters<typeof SitemapParser.processSitemap>[0],
      'https://example.com',
      'https://example.com/sitemap.xml',
      result as unknown as Parameters<typeof SitemapParser.processSitemap>[3],
    );
    assert.strictEqual(result.total, 1);
    assert.deepStrictEqual(Object.keys(result.urls), ['https://example.com/en/foo']);
    // The URL is recovered, but the site's sitemap is still non-conformant —
    // that must surface as its own finding, not pass silently.
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].message, 'Sitemap contains non-absolute <loc> URLs');
    assert.strictEqual(result.errors[0].severity, SEVERITY.MEDIUM);
  });

  void it('leaves an already-absolute <loc> unchanged', () => {
    const doc = parseHtml('<urlset><url><loc>https://example.com/page</loc></url></urlset>');
    const urls = doc.querySelectorAll('url');
    const result = { sitemaps: {}, urls: {}, total: 0, errors: [] as Array<{ message: string; detail: string; severity: string }> };
    SitemapParser.processSitemap(
      urls as unknown as Parameters<typeof SitemapParser.processSitemap>[0],
      'https://example.com',
      'https://example.com/sitemap.xml',
      result as unknown as Parameters<typeof SitemapParser.processSitemap>[3],
    );
    assert.deepStrictEqual(Object.keys(result.urls), ['https://example.com/page']);
  });

  void it('still reports "Invalid URL format" for a <loc> unresolvable even against the sitemap URL', () => {
    const doc = parseHtml('<urlset><url><loc>http://</loc></url></urlset>');
    const urls = doc.querySelectorAll('url');
    const result = { sitemaps: {}, urls: {}, total: 0, errors: [] as Array<{ message: string; detail: string; severity: string }> };
    SitemapParser.processSitemap(
      urls as unknown as Parameters<typeof SitemapParser.processSitemap>[0],
      'https://example.com',
      'https://example.com/sitemap.xml',
      result as unknown as Parameters<typeof SitemapParser.processSitemap>[3],
    );
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0].message, /Invalid URL format/);
  });
});

void describe('previousScoreFrom', () => {
  void it('keeps a real 0 instead of discarding it as unmeasured', () => {
    assert.strictEqual(previousScoreFrom({ summary: { overallScore: 0 } }), 0);
  });

  void it('returns null for unmeasured or missing history', () => {
    assert.strictEqual(previousScoreFrom({ summary: { overallScore: null } }), null);
    assert.strictEqual(previousScoreFrom(undefined), null);
  });
});

void describe('computeTotalPagesProcessed — success rate must never exceed 100%', () => {
  // Live repro: `--limit=5` caps the sitemap frontier to 5, but the
  // "missing from sitemap" second pass isn't capped — 33 extra pages get
  // crawled and counted into totalWithoutError, while the old
  // `pageData.total = uniquePages.size` stayed at 5. The CLI summary then
  // divided 38 successful by a denominator of 5 and printed "760.0%".
  void it('counts every processed page (success + error), not just the sitemap frontier', () => {
    const total = computeTotalPagesProcessed({ totalWithoutError: 38, totalWithError: 0 });
    assert.strictEqual(total, 38);
  });

  void it('includes failed pages in the denominator too', () => {
    const total = computeTotalPagesProcessed({ totalWithoutError: 30, totalWithError: 8 });
    assert.strictEqual(total, 38);
  });
});

function makeCrawlResults(): CrawlResults {
  return {
    pageData: {
      pages: {},
      processedPages: new Set<string>(),
      totalWithoutError: 0,
      totalWithError: 0,
      byError: {},
      attempts: {},
    },
  } as unknown as CrawlResults;
}

function failOnce(results: CrawlResults, url: string): void {
  const origLog = console.log;
  console.log = () => {};
  try {
    handlePageError(
      new Error('net::ERR_TIMED_OUT timeout'),
      url,
      results,
      false,
      () => {},
      (u) => {
        results.pageData.attempts[u] = (results.pageData.attempts[u] || 0) + 1;
      },
      () => {},
    );
  } finally {
    console.log = origLog;
  }
}

void describe('page counts', () => {
  void it('counts a URL that fails twice and then succeeds only once, then not at all', () => {
    const results = makeCrawlResults();
    failOnce(results, 'https://a.test/x');
    failOnce(results, 'https://a.test/x');
    assert.strictEqual(results.pageData.totalWithError, 1);
    assert.deepStrictEqual(results.pageData.byError.timeout, ['https://a.test/x']);
    assert.deepStrictEqual(results.pageData.byError.crashed, ['https://a.test/x']);

    results.pageData.pages['https://a.test/x'] = { url: 'https://a.test/x', status: 200 } as never;
    reconcileRetrySuccess(results, 'https://a.test/x');
    assert.strictEqual(results.pageData.totalWithError, 0);
    assert.deepStrictEqual(results.pageData.byError.timeout, []);
    assert.strictEqual(results.pageData.byError.total_timeout, 0);
    assert.strictEqual(results.pageData.byError.totalCrashed, 0);

    const c = computePageCounts(results.pageData.pages, results.pageData.byError);
    assert.deepStrictEqual(c, { crawled: 1, successful: 1, withErrors: 0, failedToLoad: 0 });
  });

  void it('counts a failure whose earlier attempt bypassed handlePageError (outer timeout)', () => {
    const results = makeCrawlResults();
    // Outer catch in crawler-engine bumps attempts without recording a failure.
    results.pageData.attempts['https://a.test/y'] = 1;
    failOnce(results, 'https://a.test/y');
    assert.strictEqual(results.pageData.totalWithError, 1);
    assert.deepStrictEqual(results.pageData.byError.timeout, ['https://a.test/y']);
    const c = computePageCounts(results.pageData.pages, results.pageData.byError);
    assert.strictEqual(c.failedToLoad, 1);
  });

  void it('reconciles a restored-inflated state with duplicate URLs', () => {
    const results = makeCrawlResults();
    results.pageData.totalWithError = 3;
    results.pageData.attempts['https://a.test/y'] = 2;
    results.pageData.byError = {
      timeout: ['https://a.test/y', 'https://a.test/y'],
      total_timeout: 2,
      crashed: ['https://a.test/y', 'https://a.test/y', 'https://a.test/z'],
      totalCrashed: 3,
    };
    failOnce(results, 'https://a.test/y');
    assert.strictEqual(results.pageData.totalWithError, 3, 'restored attempt must not re-count');
    reconcileRetrySuccess(results, 'https://a.test/y');
    assert.deepStrictEqual(results.pageData.byError.timeout, []);
    assert.deepStrictEqual(results.pageData.byError.crashed, ['https://a.test/z']);
    assert.strictEqual(results.pageData.byError.totalCrashed, 1);
  });

  void it('derives counts from per-URL data, ignoring inflated counters and status-code keys', () => {
    const pages = {
      a: { status: 200 },
      b: { statusCode: 200 },
      c: { status: 404 },
      d: {},
    };
    const byError = {
      timeout: ['x', 'x', 'c'],
      crashed: ['x', 'y'],
      totalCrashed: 99,
      '404': ['c'],
      total404: 1,
    };
    const c = computePageCounts(pages, byError);
    assert.deepStrictEqual(c, { crawled: 4, successful: 2, withErrors: 2, failedToLoad: 2 });
    assert.strictEqual(c.successful + c.withErrors, c.crawled);
  });

  void it('handles legacy pageData without byError', () => {
    const c = computePageCounts({ a: { status: 200 }, b: { status: 500 } }, undefined);
    assert.deepStrictEqual(c, { crawled: 2, successful: 1, withErrors: 1, failedToLoad: 0 });
  });
});

void describe('page counts header', () => {
  const statValue = (html: string, label: string): number | null => {
    const m = new RegExp(`${label}:</span>\\s*<span[^>]*>(\\d+)<`).exec(html);
    return m ? Number(m[1]) : null;
  };

  void it('shows Failed to load and sums Successful + With Errors to Pages Crawled', () => {
    const html = renderPageCountStats(
      computePageCounts({ a: { status: 200 }, b: { status: 404 }, c: {} }, { timeout: ['z', 'z'] }),
    );
    assert.strictEqual(statValue(html, 'Pages Crawled'), 3);
    assert.strictEqual((statValue(html, 'Successful') ?? 0) + (statValue(html, 'With Errors') ?? 0), 3);
    assert.strictEqual(statValue(html, 'Failed to load'), 1);
  });

  void it('omits Failed to load when nothing failed', () => {
    const html = renderPageCountStats(computePageCounts({ a: { status: 200 } }, {}));
    assert.ok(!html.includes('Failed to load'));
    assert.strictEqual(statValue(html, 'Successful'), 1);
  });
});

// ============================================================
// Language confidence threshold in report consumers
// ============================================================
void describe('language confidence', () => {
  const page = (url: string, detectedLanguage: string | null, detectedConfidence: number, match: boolean | null) =>
    ({
      url,
      languageDetection: {
        detectedLanguage,
        detectedConfidence,
        match,
        declaredLanguage: 'en',
        htmlLang: 'en',
        contentLanguageHeader: null,
        topCandidates: [],
      },
    }) as unknown as PageInfo;
  const weak = page('https://example.com/weak', 'it', 0.3, false);
  const strong = page('https://example.com/strong', 'fr', 0.8, false);
  const jsonFor = (pages: PageInfo[]) => ({
    pageData: { pages: Object.fromEntries(pages.map((p) => [p.url, p])), totalWithoutError: pages.length, totalWithError: 0 },
    analysis: { summary: {} },
  });

  void it('language confidence: content-insights getContentInsights', () => {
    const render = (pages: PageInfo[]) =>
      getContentInsights({ jsonData: jsonFor(pages) } as unknown as Parameters<typeof getContentInsights>[0]);
    assert.ok(!render([weak]).includes('Language mismatches'));
    assert.ok(render([weak, strong]).includes('Language mismatches'));
  });

  void it('language confidence: scripts chart data', () => {
    const chart = calculateChartData(jsonFor([weak, strong]) as unknown as Record<string, unknown>);
    assert.deepStrictEqual(chart.languageDist, { fr: 1 });
  });

  void it('language confidence: data-processor', () => {
    assert.strictEqual(extractPageInsights([weak]).languageMismatches, 0);
    assert.strictEqual(extractPageInsights([weak, strong]).languageMismatches, 1);
  });

  void it('language confidence: cli-summary', () => {
    const json = getJsonSummary(
      jsonFor([weak, strong]) as unknown as Parameters<typeof getJsonSummary>[0],
      'example.com',
      '/tmp/report.html',
    );
    assert.strictEqual(json.insights?.languageMismatches, 1);
  });

  void it('language confidence: pages-table', () => {
    assert.ok(!getNewInsightCells(weak).includes('>IT<'));
    assert.ok(getNewInsightCells(weak).includes('—'));
    assert.ok(getNewInsightCells(strong).includes('FR'));
    assert.ok(getNewInsightCells(page('https://example.com/n', null, 0, null)).includes('—'));
  });

  void it('language confidence: generateCSV row', () => {
    const csv = (p: PageInfo) => {
      const [header, row] = generatePagesCSV(jsonFor([p]) as unknown as Parameters<typeof generatePagesCSV>[0]).split('\n');
      const idx = header.split(',').indexOf('Detected Language');
      return row.split(',').slice(idx, idx + 2);
    };
    assert.deepStrictEqual(csv(weak), ['', '']);
    assert.deepStrictEqual(csv(page('https://example.com/n', null, 0, null)), ['', '']);
    assert.deepStrictEqual(csv(strong), ['fr', 'No']);
  });
});
