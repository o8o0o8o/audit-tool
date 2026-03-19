/**
 * Score Calculator
 * Calculates SEO scores, identifies quick wins, and provides fix recommendations
 */

import { SEVERITY } from '../constants';
import type { PageInfo, PageData, AnalysisDetail, FixRecommendation } from '../types';

class ScoreCalculator {
  /**
   * Calculate summary statistics
   * @param {object} analysisData - Analysis data with bySeverity
   * @param {object} pageData - Page data
   * @param {object} pages - All page objects
   * @returns {object} Summary statistics
   */
  static calculateSummary(
    analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    pageData: PageData,
    pages: Record<string, PageInfo>,
  ) {
    const summary: Record<string, unknown> = {
      totalIssues: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
    };

    // Count from bySeverity arrays (source of truth)
    summary.criticalCount = analysisData.bySeverity.critical.length;
    summary.highCount = analysisData.bySeverity.high.length;
    summary.mediumCount = analysisData.bySeverity.medium.length;
    summary.lowCount = analysisData.bySeverity.low.length;
    summary.totalIssues =
      (summary.criticalCount as number) +
      (summary.highCount as number) +
      (summary.mediumCount as number) +
      (summary.lowCount as number);

    // Calculate category scores first (overall depends on them)
    summary.categoryScores = this.calculateCategoryScores(analysisData, pages);

    // Calculate overall SEO score as weighted average of categories
    summary.overallScore = this.calculateOverallScore(
      analysisData,
      pages,
      summary.categoryScores as Record<string, number>,
    );

    // Calculate pass rate
    const totalPages = pageData.totalWithoutError + pageData.totalWithError;
    summary.passRate = totalPages > 0 ? Math.round((pageData.totalWithoutError / totalPages) * 100) : 0;

    // Identify quick wins
    summary.quickWins = this.identifyQuickWins(analysisData.details);

    return summary;
  }

  /**
   * Calculate overall SEO score as a weighted average of category scores.
   * This ensures the overall score is always consistent with category scores.
   * @param {object} analysisData - Analysis data
   * @param {object} pages - All page objects
   * @param {object} categoryScores - Pre-calculated category scores
   * @returns {number} Overall score (0-100)
   */
  static calculateOverallScore(
    _analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    _pages: Record<string, PageInfo>,
    categoryScores: Record<string, number>,
  ) {
    const weights = {
      seo: 0.3,
      performance: 0.25,
      technical: 0.2,
      accessibility: 0.15,
      security: 0.1,
    };

    let score = 0;
    for (const [category, weight] of Object.entries(weights)) {
      score += (categoryScores[category] || 0) * weight;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Calculate category-specific scores
   * @param {object} analysisData - Analysis data
   * @param {object} pages - All page objects
   * @returns {object} Category scores
   */
  static calculateCategoryScores(
    analysisData: { bySeverity: Record<string, string[]>; details: Record<string, AnalysisDetail> },
    pages: Record<string, PageInfo>,
  ) {
    const pagesArray = Object.values(pages || {}) as PageInfo[];

    const scores: Record<string, number> = {
      seo: 100,
      performance: 100,
      accessibility: 70,
      security: 70,
      technical: 100,
    };

    if (pagesArray.length === 0) return scores;

    // Severity weights for issue-type counting
    const severityWeight: Record<string, number> = {
      critical: 5,
      high: 3,
      medium: 1,
      low: 0.3,
    };

    // Category patterns - comprehensive to ensure all issues are categorized
    const categoryPatterns: Record<string, string[]> = {
      seo: [
        'title',
        'description',
        'canonical',
        'h1',
        'h2',
        'heading',
        'sitemap',
        'robots',
        'schema',
        'structured data',
        'alt',
        'hreflang',
        'alternate',
        'meta',
        'og:',
        'twitter',
        'social',
        'link',
        'noindex',
        'nofollow',
        'keyword',
        'content',
        'word count',
        'readability',
        'thin',
        'eeat',
        'e-e-a-t',
        'author',
        'orphan',
        'not in sitemap',
        'not listed',
        'aeo',
        'llms.txt',
        'ai ',
        'freshness',
        'duplicate',
        'pagination',
        'language',
        'near-duplicate',
        'similar content',
        'pagerank',
        'link equity',
        'conversion',
        'cta',
        'outbound',
        'broken outbound',
        'spelling',
        'misspell',
      ],
      performance: [
        'ttfb',
        'lcp',
        'cls',
        'fcp',
        'inp',
        'tbt',
        'tti',
        'speed',
        'size',
        'request',
        'cache',
        'caching',
        'cdn',
        'render-blocking',
        'render blocking',
        'compression',
        'minif',
        'image',
        'lazy',
        'webp',
        'avif',
        'font',
        'third-party',
        'third party',
        'oversiz',
        'format',
        'resource',
        'critical path',
        'preload',
        'prefetch',
        'service worker',
        'pwa',
        'unused javascript',
        'unused css',
        'code coverage',
        'dom size',
        'dom complexity',
        'dom depth',
        'dom nesting',
        'dom children',
      ],
      technical: [
        'redirect',
        '404',
        '500',
        'error',
        'http',
        'https',
        'ssl',
        'mixed content',
        'url',
        'trailing slash',
        'crawl',
        'block',
        'user-agent',
        'javascript',
        'css/js',
        'status',
        'timeout',
        'doctype',
        'iframe',
        'refresh',
        'cms',
        'framework',
        'x-robots-tag',
        'response header',
        'vary',
        'soft 404',
        'deprecated',
        'document.write',
        'interstitial',
        'popup',
        'overlay',
        'ad density',
        'open redirect',
        'dns',
        'ipv6',
        'aaaa',
        'nameserver',
      ],
    };

    // Use details (which has affected page counts) for volume-aware scoring
    const details = analysisData.details || {};
    const categoryWeightedCounts: Record<string, number> = { seo: 0, performance: 0, technical: 0 };
    const categorized = new Set();
    const totalPages = Math.max(pagesArray.length, 1);

    // First pass: score using details (has severity + affected page count)
    for (const [issue, _data] of Object.entries(details)) {
      const data = _data as AnalysisDetail;
      const lowerIssue = issue.toLowerCase();
      const severity = data.severity || 'medium';
      const weight = severityWeight[severity] || 1;
      const affectedCount = data.count || data.examples?.length || 1;

      // Scale penalty by proportion of affected pages (min 1x, max 5x)
      const breadthMultiplier = Math.min(1 + (affectedCount / totalPages) * 4, 5);
      const weightedPenalty = weight * breadthMultiplier;

      for (const [category, patterns] of Object.entries(categoryPatterns)) {
        if (patterns.some((p) => lowerIssue.includes(p))) {
          categoryWeightedCounts[category] += weightedPenalty;
          categorized.add(issue);
          break;
        }
      }

      // Uncategorized issues from details split across SEO and Technical
      if (!categorized.has(issue)) {
        categoryWeightedCounts.seo += weightedPenalty * 0.5;
        categoryWeightedCounts.technical += weightedPenalty * 0.5;
        categorized.add(issue);
      }
    }

    // Second pass: handle bySeverity entries not in details (fallback)
    for (const [severity, _issues] of Object.entries(analysisData.bySeverity)) {
      const issues = _issues as string[];
      const weight = severityWeight[severity] || 1;
      for (const issue of issues) {
        // Strip severity suffix like " [critical]" for matching
        const cleanIssue = issue.replace(/\s*\[(?:critical|high|medium|low)\]\s*$/i, '');
        if (categorized.has(cleanIssue)) continue;

        const lowerIssue = cleanIssue.toLowerCase();
        let matched = false;
        for (const [category, patterns] of Object.entries(categoryPatterns)) {
          if (patterns.some((p) => lowerIssue.includes(p))) {
            categoryWeightedCounts[category] += weight;
            matched = true;
            break;
          }
        }
        if (!matched) {
          categoryWeightedCounts.seo += weight * 0.5;
          categoryWeightedCounts.technical += weight * 0.5;
        }
      }
    }

    // Convert weighted counts to scores using logarithmic curve
    // log curve: moderate issues cause noticeable drop, many issues hit diminishing returns
    const logPenalty = (weightedCount: number, scale: number) => {
      if (weightedCount <= 0) return 0;
      return Math.min(Math.log2(1 + weightedCount) * scale, 90);
    };

    scores.seo = Math.max(0, Math.round(100 - logPenalty(categoryWeightedCounts.seo, 8)));
    scores.performance = Math.max(0, Math.round(100 - logPenalty(categoryWeightedCounts.performance, 9)));
    scores.technical = Math.max(0, Math.round(100 - logPenalty(categoryWeightedCounts.technical, 9)));

    // Calculate accessibility from page-level data
    let accessibilitySum = 0,
      accessibilityCount = 0;
    pagesArray.forEach((page) => {
      // Check a11yScore from AccessibilityAnalyzer (most comprehensive)
      if (page.accessibility?.a11yScore != null) {
        accessibilitySum += page.accessibility.a11yScore;
        accessibilityCount++;
      } else if (page.accessibility?.violationCount != null) {
        // Fallback: convert violation count to a 0-100 score
        const violationScore = Math.max(0, 100 - page.accessibility.violationCount * 10);
        accessibilitySum += violationScore;
        accessibilityCount++;
      }
      // Also factor in formData.accessibilityScore if available
      if (page.formData?.accessibilityScore != null) {
        accessibilitySum += page.formData.accessibilityScore;
        accessibilityCount++;
      }
    });
    scores.accessibility = accessibilityCount > 0 ? Math.round(accessibilitySum / accessibilityCount) : 70;

    // Calculate security from page-level securityScore
    let securitySum = 0,
      securityCount = 0;
    pagesArray.forEach((page) => {
      if (page.security?.securityScore != null) {
        securitySum += page.security.securityScore;
        securityCount++;
      }
    });
    scores.security = securityCount > 0 ? Math.round(securitySum / securityCount) : 70;

    return scores;
  }

  /**
   * Identify quick win issues
   * @param {object} issueDetails - Issue details from analysis
   * @returns {Array} Quick wins sorted by impact
   */
  static identifyQuickWins(issueDetails: Record<string, AnalysisDetail>) {
    const quickWins: Array<{
      issue: string;
      severity: string;
      affectedPages: number;
      impact: string;
      effort: string;
      effortMinutes: number;
      fix: string;
      example?: string;
      resources: Array<{ text: string; url: string }>;
      impactScore: number;
      examples: string[];
    }> = [];
    const fixRecommendations = this.getFixRecommendations();

    // Analyze each issue for quick win potential
    Object.entries(issueDetails).forEach(([issue, _data]) => {
      const data = _data as AnalysisDetail;
      const recommendation = fixRecommendations[issue] || ({} as Partial<FixRecommendation>);
      const affectedCount = data.count || data.examples?.length || 0;

      // Quick win criteria: high/critical severity, multiple pages, easy fix
      if (affectedCount > 0 && recommendation.effort) {
        const impactScore = this.calculateImpactScore(data.severity, affectedCount);
        const effortMinutes = this.parseEffort(recommendation.effort);

        // Quick win if: high impact and low effort (< 30 min)
        if (impactScore >= 40 && effortMinutes <= 30) {
          quickWins.push({
            issue,
            severity: data.severity,
            affectedPages: affectedCount,
            impact: impactScore >= 70 ? 'High' : 'Medium',
            effort: recommendation.effort,
            effortMinutes,
            fix: recommendation.fix,
            example: recommendation.example,
            resources: recommendation.resources ?? [],
            impactScore,
            examples: (data.examples || []).slice(0, 3), // First 3 examples
          });
        }
      }
    });

    // Sort by impact score (descending), then by effort (ascending)
    quickWins.sort((a, b) => {
      if (b.impactScore !== a.impactScore) {
        return b.impactScore - a.impactScore;
      }
      return a.effortMinutes - b.effortMinutes;
    });

    return quickWins.slice(0, 10); // Top 10 quick wins
  }

  /**
   * Calculate impact score for an issue
   * @param {string} severity - Issue severity
   * @param {number} affectedCount - Number of affected pages
   * @returns {number} Impact score
   */
  static calculateImpactScore(severity: string, affectedCount: number) {
    const severityWeights: Record<string, number> = {
      [SEVERITY.CRITICAL]: 100,
      [SEVERITY.HIGH]: 70,
      [SEVERITY.MEDIUM]: 40,
      [SEVERITY.LOW]: 20,
    };

    const baseScore = severityWeights[severity] || 20;
    const pageMultiplier = Math.min(affectedCount / 10, 3); // Max 3x multiplier
    return Math.round(baseScore * (1 + pageMultiplier * 0.3));
  }

  /**
   * Parse effort string to minutes
   * @param {string} effortStr - Effort string (e.g., "5 minutes", "1 hour")
   * @returns {number} Effort in minutes
   */
  static parseEffort(effortStr: string) {
    // Parse effort strings like "5 minutes", "1 hour", "30 min"
    const match = effortStr.match(/(\d+)\s*(min|minute|hour|hr)/i);
    if (!match) return 60; // Default 1 hour

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (unit.startsWith('h')) return value * 60;
    return value;
  }

  /**
   * Get fix recommendations for common issues
   * @returns {object} Fix recommendations by issue
   */
  static getFixRecommendations(): Record<string, FixRecommendation> {
    return {
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
        example:
          'Product: "Buy our blue ceramic coffee mug..."\nCategory: "Browse all coffee mugs in various colors..."',
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
      // Structural SEO issues - previously missing, critical for low-scoring sites
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
        resources: [
          { text: 'Third-Party Performance', url: 'https://web.dev/articles/optimizing-third-party-javascript' },
        ],
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
      'HTML document exceeds 3MB': {
        effort: '30 minutes',
        fix: 'Reduce HTML size by removing inline scripts/styles, using external files, implementing pagination, or lazy loading content.',
        example: 'Move inline CSS to external stylesheets. Paginate long lists. Use API-driven content loading.',
        resources: [],
      },
      'Some pages have oversized images': {
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
        example:
          '<script src="https://cdn.example.com/lib.js" integrity="sha384-..." crossorigin="anonymous"></script>',
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
  }
}

export { ScoreCalculator };
