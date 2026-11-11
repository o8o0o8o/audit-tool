/**
 * Score Calculator
 *
 * Anchored to documented methodologies — no string-pattern categorisation or
 * hand-tuned penalty curves.
 *
 *   • Performance   — Lighthouse log-normal CDF per metric, weighted average
 *   • Accessibility — mean of per-page a11yScore (axe-style deductions)
 *   • Security      — mean of per-page securityScore (Observatory deductions)
 *   • SEO           — Ahrefs URL-pass on Error-tier issues
 *   • Technical     — Ahrefs URL-pass on Error-tier issues
 *   • Overall       — weighted average of the above
 *
 * Tier and category are looked up in the issue catalog (lib/scoring/seo-catalog.ts),
 * with severity-based fallback for unknown titles.
 */

import { SCORING } from '../constants';
import { stripIssueSeverity, compareExamplesWorstFirst, blendOverallScore } from '../utils';
import { EXTENDED_FIX_RECOMMENDATIONS } from './fix-recommendations-extended';
import { logNormalScore, urlPassScore, mean } from './methodologies';
import { classifyIssue, type IssueTier, type IssueCategory } from './seo-catalog';
import type {
  PageInfo,
  PageData,
  AnalysisDetail,
  FixRecommendation,
  AuditSummary,
  CategoryScores,
  QuickWinFull,
} from '../types';

interface EnrichedIssue {
  title: string;
  tier: IssueTier;
  category: IssueCategory;
  /** Occurrence count from the analyzer. May exceed totalPages because the
   *  same URL can be counted multiple times by one finding. */
  affected: number;
  /** Unique URLs that this finding flagged, extracted from detail.examples.
   *  Used by URL-pass scoring to count UNIQUE pages with at least one error,
   *  not the sum of (potentially overlapping) occurrence counts. */
  urls: string[];
}

/** Pull each real https?:// URL out of an analyzer example string. Templated
 *  series keys (`…/page/{N}`) aren't real pages, so they're excluded — counting
 *  one would inflate a finding's affected-page tally. */
function extractUrlsFromExample(example: string): string[] {
  const matches = example.match(/https?:\/\/[^\s<>"'`]+/g);
  return matches ? matches.filter((u) => !/[{}]/.test(u)) : [];
}

class ScoreCalculator {
  static calculateSummary(
    analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    pageData: PageData,
    pages: Record<string, PageInfo>,
  ): AuditSummary {
    const criticalCount = analysisData.bySeverity.critical.length;
    const highCount = analysisData.bySeverity.high.length;
    const mediumCount = analysisData.bySeverity.medium.length;
    const lowCount = analysisData.bySeverity.low.length;

    const categoryScores = this.calculateCategoryScores(analysisData, pages);
    const totalPages = pageData.totalWithoutError + pageData.totalWithError;

    return {
      totalIssues: criticalCount + highCount + mediumCount + lowCount,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      categoryScores,
      overallScore: this.calculateOverallScore(analysisData, pages, categoryScores),
      passRate: totalPages > 0 ? Math.round((pageData.totalWithoutError / totalPages) * 100) : 0,
      quickWins: this.identifyQuickWins(analysisData.details),
    };
  }

  /** Weighted mean of category scores, using SCORING.CATEGORY_WEIGHTS. */
  static calculateOverallScore(
    _analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    _pages: Record<string, PageInfo>,
    categoryScores: CategoryScores,
  ): number {
    return blendOverallScore({ ...categoryScores });
  }

  static calculateCategoryScores(
    analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    pages: Record<string, PageInfo>,
  ): CategoryScores {
    const pageArray = Object.values(pages || {}) as PageInfo[];
    const totalPages = Math.max(pageArray.length, 1);
    const issues = enrichIssues(analysisData);

    return {
      seo: roundScore(scoreFromUrlPass(issues, 'seo', totalPages)),
      technical: roundScore(scoreFromUrlPass(issues, 'technical', totalPages)),
      performance: roundScore(scorePerformance(pageArray, issues, totalPages)),
      accessibility: roundScore(scoreAccessibility(pageArray)),
      security: roundScore(scoreSecurity(pageArray)),
    };
  }

  static identifyQuickWins(issueDetails: Record<string, AnalysisDetail>): QuickWinFull[] {
    const fixRecommendations = this.getFixRecommendations();
    const quickWins: QuickWinFull[] = [];

    for (const [title, data] of Object.entries(issueDetails)) {
      const recommendation = fixRecommendations[title] ?? ({} as Partial<FixRecommendation>);
      const affected = data.count || data.examples?.length || 0;
      if (affected <= 0 || !recommendation.effort) continue;

      const desc = classifyIssue(title, data.severity);
      const impactScore = this.calculateImpactScore(desc.tier, affected);
      const effortMinutes = this.parseEffort(recommendation.effort);

      if (impactScore >= SCORING.QUICK_WIN_MIN_IMPACT && effortMinutes <= SCORING.QUICK_WIN_MAX_EFFORT_MINUTES) {
        quickWins.push({
          issue: title,
          severity: data.severity,
          affectedPages: affected,
          impact: impactScore >= 70 ? 'High' : 'Medium',
          effort: recommendation.effort,
          effortMinutes,
          fix: recommendation.fix,
          example: recommendation.example,
          resources: recommendation.resources ?? [],
          impactScore,
          // Sort worst-first before slicing so the retained examples lead with
          // the most severe pages, and don't depend on the concurrent
          // crawl-completion order they were collected in (the comparator's
          // lexicographic tiebreak keeps the sample deterministic).
          examples: [...(data.examples ?? [])].sort(compareExamplesWorstFirst).slice(0, 3),
        });
      }
    }

    // Final `issue` tiebreaker keeps ordering deterministic when impact and
    // effort tie — without it, equal items would fall back to the
    // crawl-completion insertion order, which varies run to run.
    quickWins.sort(
      (a, b) => b.impactScore - a.impactScore || a.effortMinutes - b.effortMinutes || a.issue.localeCompare(b.issue),
    );
    return quickWins.slice(0, SCORING.QUICK_WIN_MAX_RESULTS);
  }

  /**
   * Quick-win impact: tier baseline + bonus for breadth (more affected pages
   * → higher impact, with diminishing returns).
   */
  static calculateImpactScore(tierOrSeverity: string, affectedCount: number): number {
    const tier: IssueTier =
      tierOrSeverity === 'error' || tierOrSeverity === 'warning' || tierOrSeverity === 'notice'
        ? (tierOrSeverity as IssueTier)
        : classifyIssue('', tierOrSeverity).tier;
    const base = SCORING.TIER_IMPACT_BASE[tier] ?? SCORING.TIER_IMPACT_BASE.notice;
    const breadthBonus = Math.min(20, Math.log2(1 + affectedCount) * 4);
    return Math.round(Math.min(100, base + breadthBonus));
  }

  static parseEffort(effortStr: string): number {
    const match = effortStr.match(/(\d+)\s*(min|minute|hour|hr)/i);
    if (!match) return 60;
    const value = parseInt(match[1], 10);
    return match[2].toLowerCase().startsWith('h') ? value * 60 : value;
  }

  /**
   * Coarse effort level for reports. We deliberately do NOT surface time
   * estimates ("~30 minutes", "1-2 hours") — the heuristic isn't precise enough
   * to justify them and readers treat a number as a commitment. Show
   * low / medium / high instead. Thresholds: ≤30 min → low, ≤2 h → medium,
   * otherwise high. A pre-parsed `effortMinutes` is preferred when supplied.
   */
  static effortLevel(effort: string | undefined, effortMinutes?: number): 'low' | 'medium' | 'high' {
    const mins = typeof effortMinutes === 'number' ? effortMinutes : effort ? this.parseEffort(effort) : 60;
    if (mins <= 30) return 'low';
    if (mins <= 120) return 'medium';
    return 'high';
  }

  static getFixRecommendations(): Record<string, FixRecommendation> {
    // Original curated entries take precedence over extended ones when keys
    // collide. Both are normalized at lookup time in phase2-runner.
    return { ...EXTENDED_FIX_RECOMMENDATIONS, ...buildMessageAliases(), ...FIX_RECOMMENDATIONS };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundScore(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 100;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function enrichIssues(analysisData: {
  bySeverity: Record<string, string[]>;
  details: Record<string, AnalysisDetail>;
}): EnrichedIssue[] {
  const issues: EnrichedIssue[] = [];
  const seen = new Set<string>();

  for (const [title, detail] of Object.entries(analysisData.details ?? {})) {
    const { tier, category } = classifyIssue(title, detail.severity);
    const urls: string[] = [];
    for (const example of detail.examples ?? []) {
      urls.push(...extractUrlsFromExample(example));
    }
    issues.push({
      title,
      tier,
      category,
      affected: detail.count || detail.examples?.length || 1,
      urls,
    });
    seen.add(title);
  }

  // bySeverity entries not in details — count as one occurrence each.
  for (const [severity, list] of Object.entries(analysisData.bySeverity ?? {})) {
    for (const labelled of list) {
      const title = stripIssueSeverity(labelled);
      if (seen.has(title)) continue;
      const { tier, category } = classifyIssue(title, severity);
      issues.push({ title, tier, category, affected: 1, urls: [] });
      seen.add(title);
    }
  }

  return issues;
}

/**
 * Ahrefs URL-pass: count UNIQUE URLs touched by any error-tier finding in
 * the category, divide by totalPages × 100. Falls back to occurrence-count
 * semantics for findings whose examples don't carry URLs (defensive).
 */
function scoreFromUrlPass(issues: EnrichedIssue[], category: IssueCategory, totalPages: number): number {
  const errorIssues = issues.filter((i) => i.category === category && i.tier === 'error');

  // Primary path: union of distinct URLs across all error-tier findings.
  const urlSet = new Set<string>();
  let fallbackCount = 0;
  for (const issue of errorIssues) {
    if (issue.urls.length > 0) {
      for (const u of issue.urls) urlSet.add(u);
    } else {
      // Finding had no URL examples (e.g. site-level finding) — credit it as
      // affecting one URL conservatively, so we don't silently drop it.
      fallbackCount += Math.min(issue.affected, totalPages);
    }
  }
  const pagesWithErrors = Math.min(urlSet.size + fallbackCount, totalPages);
  return urlPassScore(pagesWithErrors, totalPages);
}

/**
 * Performance: log-normal CDF on per-page CWV metrics, weighted by
 * PERFORMANCE_METRIC_WEIGHTS. Falls back to URL-pass on perf issues (any
 * tier) when no metrics were collected — e.g., when --perf was not enabled.
 */
function scorePerformance(pages: PageInfo[], issues: EnrichedIssue[], totalPages: number): number | null {
  const cps = SCORING.PERFORMANCE_CONTROL_POINTS;
  const ws = SCORING.PERFORMANCE_METRIC_WEIGHTS;
  const perPageScores: number[] = [];

  for (const page of pages) {
    const lcp = page.LCP ?? page.lcp;
    const tbt = page.TBT ?? page.tbt;
    const cls = page.CLS ?? page.cls;
    const fcp = page.FCP ?? page.fcp;
    const ttfb = page.TTFB ?? page.ttfb;

    let weighted = 0;
    let totalWeight = 0;
    if (Number.isFinite(lcp as number)) {
      weighted += ws.LCP * logNormalScore(lcp as number, cps.LCP.p10, cps.LCP.median);
      totalWeight += ws.LCP;
    }
    // TBT, not INP: INP needs interaction the crawler never performs, so it
    // records 0ms (a perfect score) on every page. TBT is the lab-measurable
    // main-thread-blocking proxy and is collected per page. See
    // SCORING.PERFORMANCE_METRIC_WEIGHTS.
    if (Number.isFinite(tbt as number)) {
      weighted += ws.TBT * logNormalScore(tbt as number, cps.TBT.p10, cps.TBT.median);
      totalWeight += ws.TBT;
    }
    if (Number.isFinite(cls as number)) {
      weighted += ws.CLS * logNormalScore(cls as number, cps.CLS.p10, cps.CLS.median);
      totalWeight += ws.CLS;
    }
    if (Number.isFinite(fcp as number)) {
      weighted += ws.FCP * logNormalScore(fcp as number, cps.FCP.p10, cps.FCP.median);
      totalWeight += ws.FCP;
    }
    if (Number.isFinite(ttfb as number)) {
      weighted += ws.TTFB * logNormalScore(ttfb as number, cps.TTFB.p10, cps.TTFB.median);
      totalWeight += ws.TTFB;
    }

    if (totalWeight > 0) perPageScores.push(weighted / totalWeight);
  }

  if (perPageScores.length > 0) return mean(perPageScores);

  // Fallback when no perf metrics were collected.
  const allPerfOccurrences = issues.filter((i) => i.category === 'performance').reduce((sum, i) => sum + i.affected, 0);
  if (allPerfOccurrences === 0) return null;
  return urlPassScore(allPerfOccurrences, totalPages);
}

/**
 * Accessibility: mean of per-page a11yScore (analyzer-computed, axe-style
 * deductions). Falls back to violationCount and formData.accessibilityScore
 * when a11yScore isn't available.
 */
function scoreAccessibility(pages: PageInfo[]): number | null {
  const samples: number[] = [];
  for (const page of pages) {
    if (page.accessibility?.a11yScore != null) {
      samples.push(page.accessibility.a11yScore);
    } else if (page.accessibility?.violationCount != null) {
      samples.push(Math.max(0, 100 - page.accessibility.violationCount * 10));
    }
    if (page.formData?.accessibilityScore != null) {
      samples.push(page.formData.accessibilityScore);
    }
  }
  return mean(samples);
}

/** Security: mean of per-page securityScore (Observatory-style deductions). */
function scoreSecurity(pages: PageInfo[]): number | null {
  const samples = pages.map((p) => p.security?.securityScore).filter((s): s is number => typeof s === 'number');
  return mean(samples);
}

// ─── Fix recommendations (data only, no logic) ──────────────────────────────

/**
 * Maps the stabilized, count-free finding messages — emitted after the
 * site-wide analyzers switched from baked-in-count titles ("13 pages …") to
 * per-page emission — onto the existing catalog entries that were keyed to the
 * older "<N> pages …" phrasings. Reusing the same entry by reference keeps fix
 * recommendations resolving without duplicating their text. Keep in sync with
 * the analyzers' message constants and docs/report-rules.md.
 */
const FIX_MESSAGE_ALIASES: Record<string, string> = {
  'Soft 404 page': 'soft 404 pages detected',
  'Page has critical JavaScript errors': 'pages have critical JavaScript errors',
  'Page blocked via X-Robots-Tag: noindex (HTTP header)': 'page(s) blocked via X-Robots-Tag: noindex',
  'Important content rendered in Shadow DOM': 'pages have important content in Shadow DOM',
  'Paginated page has incorrect canonical': 'paginated pages have incorrect canonicals',
  'Orphan page (no internal links point to it)': 'orphan pages detected (no internal links pointing to them)',
  'Dead-end page (no outgoing internal links)': 'dead-end pages have no outgoing internal links',
  'Page unreachable from homepage via internal links': 'pages are unreachable from homepage via internal links',
  'Content language does not match declared language': 'page(s) have content language mismatches',
  'Broken external link': 'broken external link(s) verified',
  'Slow server response (TTFB)': 'pages have slow server response',
  'Site connects to many unique origins': 'Site connects to unique origins',
  'High average unused JavaScript site-wide': 'Site-wide: % of JavaScript is unused on average',
  'High average unused CSS site-wide': 'Site-wide: % of CSS is unused on average',
  'Some scripts consistently have high unused code': 'script(s) consistently have high unused code',
  'Long redirect chain': 'Pages with long redirect chains',
  'A notable share of pages have insufficient content': 'pages have insufficient content',
  'Form inputs across the site are missing labels': 'form inputs across site missing labels',
  'Page has form accessibility issues': 'pages have form accessibility issues',
  'Active mixed content on page': 'Active mixed content across site',
  'Videos across the site lack captions': 'videos across site lack captions',
  'Broken outbound link': 'broken outbound link(s) found across the site',
  'Page has very low internal link equity': 'pages have very low internal link equity',
  'Pages have very similar content': 'pages have very similar content',
  'A notable share of pages have near-duplicate content': 'pages have near-duplicate content',
  'Page has too many links': 'page(s) have more than links',
};

/** Resolve {@link FIX_MESSAGE_ALIASES} against the extended catalog by reference. */
function buildMessageAliases(): Record<string, FixRecommendation> {
  const out: Record<string, FixRecommendation> = {};
  for (const [newKey, srcKey] of Object.entries(FIX_MESSAGE_ALIASES)) {
    const rec = EXTENDED_FIX_RECOMMENDATIONS[srcKey];
    if (rec) out[newKey] = rec;
  }
  return out;
}

const FIX_RECOMMENDATIONS: Record<string, FixRecommendation> = {
  'Some pages are missing alt attribute on images': {
    effort: '5 minutes',
    fix: 'Add descriptive alt text to all images. Alt text should describe the image content for screen readers and SEO.',
    example: '<img src="product.jpg" alt="Blue ceramic coffee mug with white handle">',
    resources: [{ text: 'Image Alt Text Guide', url: 'https://moz.com/learn/seo/alt-text' }],
  },
  'Some pages have missing or empty title': {
    effort: '10 minutes',
    fix: 'Add unique, descriptive title tags (50-60 characters) to each page. Include primary keywords near the beginning.',
    example: '<title>Organic Coffee Beans | Free Shipping | Coffee Shop Name</title>',
    resources: [{ text: 'Title Tag Guide', url: 'https://moz.com/learn/seo/title-tag' }],
  },
  'Some pages have missing or empty meta description': {
    effort: '15 minutes',
    fix: 'Add compelling meta descriptions (150-160 characters) that summarize page content and encourage clicks.',
    example:
      '<meta name="description" content="Shop premium organic coffee beans with free shipping. Arabica & robusta blends roasted fresh daily. Order now!">',
    resources: [{ text: 'Meta Description Guide', url: 'https://moz.com/learn/seo/meta-description' }],
  },
  'Some pages are missing canonical URL': {
    effort: '10 minutes',
    fix: 'Add canonical link tags to prevent duplicate content issues. Point to the preferred version of the page.',
    example: '<link rel="canonical" href="https://example.com/page">',
    resources: [{ text: 'Canonical URL Guide', url: 'https://moz.com/learn/seo/canonicalization' }],
  },
  'Canonicals are not set for some pages': {
    effort: '10 minutes',
    fix: 'Add a self-referencing canonical link tag to every indexable page. On paginated and parameterised URLs (e.g. ?postType=…), point the canonical at the preferred version so search engines consolidate ranking signals instead of treating each variant as duplicate content.',
    example: '<link rel="canonical" href="https://example.com/page">',
    resources: [{ text: 'Canonical URL Guide', url: 'https://moz.com/learn/seo/canonicalization' }],
  },
  'Some pages have more than one h1 tag': {
    effort: '10 minutes',
    fix: 'Use only one H1 tag per page. The H1 should be the main heading and contain primary keywords.',
    example: '<h1>Main Page Heading</h1>\n<!-- Use h2, h3, etc. for subheadings -->',
    resources: [],
  },
  'Some pages have TTFB more than 800ms': {
    effort: '30 minutes',
    fix: 'Improve server response time by: 1) Enable server caching, 2) Use a CDN, 3) Optimize database queries, 4) Upgrade hosting if needed.',
    example: 'Add cache headers:\nCache-Control: public, max-age=3600',
    resources: [{ text: 'TTFB Optimization', url: 'https://web.dev/articles/ttfb' }],
  },
  'Some pages have LCP more than 2500ms': {
    effort: '20 minutes',
    fix: 'Optimize largest contentful paint by: 1) Optimize images (use WebP, lazy loading), 2) Remove render-blocking resources, 3) Use CDN.',
    example: '<img src="hero.webp" loading="lazy" width="800" height="600">',
    resources: [{ text: 'Optimize LCP', url: 'https://web.dev/articles/optimize-lcp' }],
  },
  'Some pages have duplicate title': {
    effort: '20 minutes',
    fix: 'Make each page title unique. Include page-specific keywords and differentiators.',
    example: 'Products: "Blue Coffee Mug - Coffee Shop"\nBlog: "How to Brew Perfect Coffee - Coffee Shop"',
    resources: [],
  },
  'Some pages have duplicate description': {
    effort: '25 minutes',
    fix: 'Write unique meta descriptions for each page. Highlight what makes each page different.',
    example: 'Product: "Buy our blue ceramic coffee mug..."\nCategory: "Browse all coffee mugs in various colors..."',
    resources: [],
  },
  'Some pages are not listed in sitemap': {
    effort: '15 minutes',
    fix: 'Add discovered pages to your sitemap.xml file. Ensure all important pages are included for better crawling.',
    example: '<url>\n  <loc>https://example.com/new-page</loc>\n  <lastmod>2025-12-09</lastmod>\n</url>',
    resources: [
      {
        text: 'Sitemap Guide',
        url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
      },
    ],
  },
  'Detected content language does not match declared language': {
    effort: '10 minutes',
    fix: 'Ensure the html lang attribute matches the actual content language. Use ISO 639-1 codes (e.g., "en", "fr", "de").',
    example: '<html lang="en">',
    resources: [],
  },
  'Content-Language header mismatches html lang attribute': {
    effort: '10 minutes',
    fix: 'Align the Content-Language HTTP header with the html lang attribute. Configure your server to send the correct header.',
    example: 'Content-Language: en',
    resources: [],
  },
  'High percentage of unused JavaScript': {
    effort: '30 minutes',
    fix: 'Reduce unused JavaScript through code splitting, lazy loading, and tree shaking. Remove unused libraries.',
    example: 'import(/* webpackChunkName: "chart" */ "./chart.js")',
    resources: [{ text: 'Remove Unused Code', url: 'https://web.dev/articles/remove-unused-code' }],
  },
  'High percentage of unused CSS': {
    effort: '20 minutes',
    fix: 'Purge unused CSS rules using tools like PurgeCSS. Extract critical CSS and defer non-critical styles.',
    example: 'npx purgecss --css style.css --content index.html --output purged.css',
    resources: [{ text: 'Remove Unused CSS', url: 'https://web.dev/articles/unused-css-rules' }],
  },
  'Large amount of unused code': {
    effort: '1-2 hours',
    fix: 'Audit your JS/CSS bundles with source maps or coverage tools. Split large bundles with dynamic imports, remove unused dependencies, and defer non-critical scripts.',
    example:
      '// Dynamic import for non-critical code\nconst module = await import("./heavy-feature.js");\n\n// Defer non-critical CSS\n<link rel="preload" href="non-critical.css" as="style" onload="this.rel=\'stylesheet\'">',
    resources: [
      { text: 'Remove Unused Code', url: 'https://web.dev/articles/remove-unused-code' },
      { text: 'Code Splitting', url: 'https://web.dev/articles/reduce-javascript-payloads-with-code-splitting' },
    ],
  },
  'Page has broken outbound link(s)': {
    effort: '15 minutes',
    fix: 'Fix or remove broken external links. Broken outbound links hurt user trust and may negatively impact SEO.',
    example: 'Replace dead links with archived versions or remove them entirely.',
    resources: [],
  },
  'Some pages have redirect chains or loops': {
    effort: '20 minutes',
    fix: 'Fix redirect chains by pointing directly to the final destination. Eliminate redirect loops by correcting server configuration.',
    example: 'Instead of A→B→C, redirect A→C directly.\nCheck .htaccess, nginx config, or CDN redirect rules.',
    resources: [
      { text: 'Redirect Chains', url: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects' },
    ],
  },
  'Some pages have very thin content': {
    effort: '30 minutes',
    fix: 'Add meaningful, unique content to thin pages. Aim for at least 300 words of substantive content per page.',
    example: 'Expand product descriptions, add FAQs, or consolidate thin pages into comprehensive ones.',
    resources: [
      { text: 'Thin Content Guide', url: 'https://developers.google.com/search/docs/essentials/spam-policies' },
    ],
  },
  'Critical JavaScript errors detected': {
    effort: '30 minutes',
    fix: 'Fix JavaScript errors that prevent page rendering or functionality. Check browser console for specific error messages.',
    example: 'Use try/catch for error-prone code. Test with JavaScript disabled for graceful degradation.',
    resources: [],
  },
  'Some pages have excessive third-party payload': {
    effort: '30 minutes',
    fix: 'Audit and reduce third-party scripts. Defer non-critical scripts, use facade patterns for heavy embeds (YouTube, maps).',
    example:
      '<script src="analytics.js" defer></script>\n<!-- Use lite-youtube-embed instead of full YouTube embed -->',
    resources: [{ text: 'Third-Party Performance', url: 'https://web.dev/articles/optimizing-third-party-javascript' }],
  },
  'Some pages have render-blocking third-party scripts': {
    effort: '15 minutes',
    fix: 'Add async or defer attributes to non-critical third-party scripts to prevent render blocking.',
    example: '<script src="https://cdn.example.com/widget.js" async></script>',
    resources: [{ text: 'Render-Blocking Resources', url: 'https://web.dev/articles/render-blocking-resources' }],
  },
  'Form inputs missing labels': {
    effort: '15 minutes',
    fix: 'Add <label> elements associated with each form input using for/id attributes or by wrapping the input.',
    example: '<label for="email">Email address</label>\n<input type="email" id="email" name="email">',
    resources: [{ text: 'Form Labels', url: 'https://www.w3.org/WAI/tutorials/forms/labels/' }],
  },
  "Some loc and canonical don't match": {
    effort: '15 minutes',
    fix: 'Ensure the canonical URL on each page matches its sitemap <loc> URL. Pick one canonical form and use it consistently.',
    example: 'If sitemap has https://example.com/page/, canonical should also be https://example.com/page/',
    resources: [
      {
        text: 'Canonical Best Practices',
        url: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
      },
    ],
  },
  // 'HTML document exceeds 3MB' was the severe-band twin of 'Large HTML document';
  // the two collapsed into one canonical 'Large HTML document' finding
  // (report-rules.md §5). Its fix recommendation lives in EXTENDED_FIX_RECOMMENDATIONS.
  'Pages have image files larger than recommended': {
    effort: '20 minutes',
    fix: 'Resize images to their display dimensions. Use modern formats (WebP/AVIF). Compress images to reduce file size.',
    example:
      '<picture>\n  <source srcset="image.avif" type="image/avif">\n  <source srcset="image.webp" type="image/webp">\n  <img src="image.jpg" width="800" height="600" loading="lazy">\n</picture>',
    resources: [{ text: 'Image Optimization', url: 'https://web.dev/articles/fast#optimize_your_images' }],
  },
  'LCP image not preloaded': {
    effort: '10 minutes',
    fix: 'Add a preload link for the LCP image in the <head> to ensure it loads as early as possible.',
    example: '<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">',
    resources: [
      {
        text: 'Preload LCP Image',
        url: 'https://web.dev/articles/optimize-lcp#optimize_when_the_resource_is_discovered',
      },
    ],
  },
  'Some pages have identical titles': {
    effort: '20 minutes',
    fix: 'Ensure every page has a unique title tag. Use page-specific keywords and descriptors.',
    example: 'Home: "Company Name - Tagline"\nAbout: "About Us | Company Name"',
    resources: [],
  },
  'Some pages have identical descriptions': {
    effort: '25 minutes',
    fix: 'Write unique meta descriptions for each page. Summarize the specific content of each page.',
    example: 'Tailor each description to the page content with unique selling points.',
    resources: [],
  },
  'Suspicious external link without nofollow': {
    effort: '10 minutes',
    fix: 'Add rel="nofollow" or rel="sponsored" to external links pointing to untrusted or paid content.',
    example: '<a href="https://external.com" rel="nofollow">External Link</a>',
    resources: [],
  },
  'Session ID detected in URL': {
    effort: '15 minutes',
    fix: 'Move session IDs from URLs to cookies. URL-based session IDs create duplicate content and security issues.',
    example: 'Use server-side session management with cookies instead of URL parameters.',
    resources: [],
  },
  'Some pages have skipped heading levels': {
    effort: '10 minutes',
    fix: 'Use headings in sequential order (H1→H2→H3). Do not skip levels (e.g., H1→H3).',
    example: '<h1>Page Title</h1>\n<h2>Section</h2>\n<h3>Subsection</h3>',
    resources: [],
  },
  'Incorrect origin in sitemap': {
    effort: '10 minutes',
    fix: "Ensure all URLs in the sitemap use the correct domain/origin. All <loc> entries should match the site's canonical domain.",
    example: 'If site is https://www.example.com, sitemap URLs should start with https://www.example.com/',
    resources: [],
  },
  'External scripts missing Subresource Integrity (SRI)': {
    effort: '15 minutes',
    fix: 'Add integrity attributes to external script and stylesheet tags to protect against compromised CDNs.',
    example: '<script src="https://cdn.example.com/lib.js" integrity="sha384-..." crossorigin="anonymous"></script>',
    resources: [
      { text: 'SRI Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity' },
    ],
  },
  'Missing Permissions-Policy header': {
    effort: '10 minutes',
    fix: 'Add a Permissions-Policy header to restrict browser features like camera, microphone, and geolocation.',
    example: 'Permissions-Policy: camera=(), microphone=(), geolocation=(self)',
    resources: [
      {
        text: 'Permissions Policy',
        url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy',
      },
    ],
  },
  'Weak Content-Security-Policy directives': {
    effort: '30 minutes',
    fix: "Review and tighten CSP directives. Remove 'unsafe-inline' and 'unsafe-eval' where possible. Use nonces or hashes instead.",
    example:
      "Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-abc123'; style-src 'self' 'unsafe-inline'",
    resources: [{ text: 'CSP Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP' }],
  },
  'Color contrast fails WCAG AA': {
    effort: '20 minutes',
    fix: 'Increase contrast between text and background colors. Use a contrast checker tool to verify ratios meet WCAG AA (4.5:1 for normal text, 3:1 for large text).',
    example: 'Change light gray text (#999) on white to darker gray (#595959) for 7:1 ratio.',
    resources: [{ text: 'Contrast Checker', url: 'https://webaim.org/resources/contrastchecker/' }],
  },
  'Excessive DOM size': {
    effort: '30 minutes',
    fix: 'Reduce DOM complexity by simplifying markup, using virtualization for long lists, and removing unnecessary wrapper elements.',
    example:
      'Use virtual scrolling for lists >100 items. Flatten nested divs. Remove hidden elements from DOM instead of display:none.',
    resources: [{ text: 'DOM Size', url: 'https://developer.chrome.com/docs/lighthouse/performance/dom-size' }],
  },
  'No prefers-reduced-motion CSS support': {
    effort: '15 minutes',
    fix: 'Add @media (prefers-reduced-motion: reduce) CSS rules to disable or simplify animations for users who prefer reduced motion.',
    example:
      '@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: 0.01ms !important;\n    transition-duration: 0.01ms !important;\n  }\n}',
    resources: [{ text: 'prefers-reduced-motion', url: 'https://web.dev/articles/prefers-reduced-motion' }],
  },
  'Intrusive interstitial/popup detected': {
    effort: '20 minutes',
    fix: 'Ensure popups and overlays do not cover more than 30% of the viewport on mobile. Use less intrusive alternatives like banners or inline CTAs.',
    resources: [
      {
        text: 'Interstitial Guidelines',
        url: 'https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials',
      },
    ],
  },
  'Deprecated HTML elements found': {
    effort: '15 minutes',
    fix: 'Replace deprecated HTML elements with modern equivalents. Use CSS for presentational styling instead of HTML elements.',
    example: 'Replace <center> with CSS text-align:center. Replace <font> with CSS font properties.',
    resources: [],
  },
};

export { ScoreCalculator };
