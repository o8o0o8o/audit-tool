/**
 * Score Calculator
 * Calculates SEO scores, identifies quick wins, and provides fix recommendations
 */

const { SEVERITY } = require('../constants');

class ScoreCalculator {
  /**
   * Calculate summary statistics
   * @param {object} analysisData - Analysis data with bySeverity
   * @param {object} pageData - Page data
   * @param {object} pages - All page objects
   * @returns {object} Summary statistics
   */
  static calculateSummary(analysisData, pageData, pages) {
    const summary = {
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
    summary.totalIssues = summary.criticalCount + summary.highCount + summary.mediumCount + summary.lowCount;

    // Calculate overall SEO score (0-100)
    summary.overallScore = this.calculateOverallScore(analysisData, pages);

    // Calculate category scores
    summary.categoryScores = this.calculateCategoryScores(analysisData, pages);

    // Calculate pass rate
    const totalPages = pageData.totalWithoutError + pageData.totalWithError;
    summary.passRate = totalPages > 0
      ? Math.round((pageData.totalWithoutError / totalPages) * 100)
      : 0;

    // Identify quick wins
    summary.quickWins = this.identifyQuickWins(analysisData.details);

    return summary;
  }

  /**
   * Calculate overall SEO score
   * @param {object} analysisData - Analysis data
   * @param {object} pages - All page objects
   * @returns {number} Overall score (0-100)
   */
  static calculateOverallScore(analysisData, pages) {
    let score = 100; // Start with perfect score

    // Count unique issue types (not total affected pages)
    const criticalCount = analysisData.bySeverity.critical.length;
    const highCount = analysisData.bySeverity.high.length;
    const mediumCount = analysisData.bySeverity.medium.length;
    const lowCount = analysisData.bySeverity.low.length;

    // Deduct points for unique issues (capped per severity)
    // This prevents massive deductions from sites with many pages
    // Cap counts first to prevent large intermediate values, then calculate deduction
    const cappedCritical = Math.min(criticalCount, 10);  // Max 10 issues count toward score
    const cappedHigh = Math.min(highCount, 13);          // Max 13 issues count toward score
    const cappedMedium = Math.min(mediumCount, 40);      // Max 40 issues count toward score
    const cappedLow = Math.min(lowCount, 50);            // Max 50 issues count toward score

    const criticalDeduction = Math.min(cappedCritical * 3, 30);  // Max -30 for critical
    const highDeduction = Math.min(cappedHigh * 2, 25);          // Max -25 for high
    const mediumDeduction = Math.min(cappedMedium * 0.5, 20);    // Max -20 for medium
    const lowDeduction = Math.min(cappedLow * 0.2, 10);          // Max -10 for low

    score -= criticalDeduction;
    score -= highDeduction;
    score -= mediumDeduction;
    score -= lowDeduction;

    // Get average scores from page metrics
    const pagesArray = Object.values(pages || {});
    if (pagesArray.length > 0) {
      let avgSecurity = 0, avgCaching = 0, avgAccessibility = 0, avgContent = 0;
      let securityCount = 0, cachingCount = 0, accessibilityCount = 0, contentCount = 0;

      pagesArray.forEach(page => {
        if (page.security?.score != null) {
          avgSecurity += page.security.score;
          securityCount++;
        }
        if (page.caching?.score != null) {
          avgCaching += page.caching.score;
          cachingCount++;
        }
        if (page.accessibility?.score != null) {
          avgAccessibility += page.accessibility.score;
          accessibilityCount++;
        }
        if (page.contentQuality?.contentScore != null) {
          avgContent += page.contentQuality.contentScore;
          contentCount++;
        }
      });

      // Calculate average quality scores
      avgSecurity = securityCount > 0 ? avgSecurity / securityCount : 70;
      avgCaching = cachingCount > 0 ? avgCaching / cachingCount : 70;
      avgAccessibility = accessibilityCount > 0 ? avgAccessibility / accessibilityCount : 70;
      avgContent = contentCount > 0 ? avgContent / contentCount : 70;

      // Weight quality scores into overall (if below 70, deduct proportionally)
      const securityImpact = avgSecurity < 70 ? (70 - avgSecurity) * 0.1 : 0;
      const cachingImpact = avgCaching < 70 ? (70 - avgCaching) * 0.05 : 0;
      const accessibilityImpact = avgAccessibility < 70 ? (70 - avgAccessibility) * 0.1 : 0;
      const contentImpact = avgContent < 70 ? (70 - avgContent) * 0.05 : 0;

      score -= securityImpact;
      score -= cachingImpact;
      score -= accessibilityImpact;
      score -= contentImpact;
    }

    // Ensure score is between 0 and 100
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Calculate category-specific scores
   * @param {object} analysisData - Analysis data
   * @param {object} pages - All page objects
   * @returns {object} Category scores
   */
  static calculateCategoryScores(analysisData, pages) {
    const pagesArray = Object.values(pages || {});

    const scores = {
      seo: 100,
      performance: 100,
      accessibility: 70,
      security: 70,
      technical: 100,
    };

    if (pagesArray.length === 0) return scores;

    // Helper to count issues matching patterns across all severities
    const countIssues = (patterns) => {
      let count = 0;
      const allIssues = [
        ...analysisData.bySeverity.critical,
        ...analysisData.bySeverity.high,
        ...analysisData.bySeverity.medium,
        ...analysisData.bySeverity.low,
      ];
      for (const issue of allIssues) {
        const lowerIssue = issue.toLowerCase();
        if (patterns.some(p => lowerIssue.includes(p.toLowerCase()))) {
          count++;
        }
      }
      return count;
    };

    // SEO category: title, description, canonical, h1, sitemap, robots, schema, alt, hreflang
    const seoPatterns = ['title', 'description', 'canonical', 'h1', 'h2', 'heading', 'sitemap',
                         'robots', 'schema', 'alt', 'hreflang', 'alternate', 'meta', 'og:', 'twitter'];
    const seoIssueCount = countIssues(seoPatterns);
    scores.seo = Math.max(0, 100 - Math.min(seoIssueCount * 2, 60));

    // Performance category: TTFB, LCP, CLS, FCP, INP, size, requests, cache, render-blocking
    const perfPatterns = ['ttfb', 'lcp', 'cls', 'fcp', 'inp', 'size', 'request', 'cache',
                          'render-blocking', 'compression', 'minif', 'image', 'font', 'third-party'];
    const perfIssueCount = countIssues(perfPatterns);
    scores.performance = Math.max(0, 100 - Math.min(perfIssueCount * 3, 70));

    // Technical category: redirect, 404, 500, http, ssl, mixed content, url structure
    const techPatterns = ['redirect', '404', '500', 'error', 'http ', 'https', 'ssl', 'mixed content',
                          'url', 'trailing slash', 'duplicate'];
    const techIssueCount = countIssues(techPatterns);
    scores.technical = Math.max(0, 100 - Math.min(techIssueCount * 3, 60));

    // Calculate accessibility average from page scores
    let accessibilitySum = 0, accessibilityCount = 0;
    pagesArray.forEach(page => {
      if (page.accessibility?.score != null) {
        accessibilitySum += page.accessibility.score;
        accessibilityCount++;
      }
    });
    scores.accessibility = accessibilityCount > 0
      ? Math.round(accessibilitySum / accessibilityCount)
      : 70;

    // Calculate security average from page scores
    let securitySum = 0, securityCount = 0;
    pagesArray.forEach(page => {
      if (page.security?.score != null) {
        securitySum += page.security.score;
        securityCount++;
      }
    });
    scores.security = securityCount > 0
      ? Math.round(securitySum / securityCount)
      : 70;

    return scores;
  }

  /**
   * Identify quick win issues
   * @param {object} issueDetails - Issue details from analysis
   * @returns {Array} Quick wins sorted by impact
   */
  static identifyQuickWins(issueDetails) {
    const quickWins = [];
    const fixRecommendations = this.getFixRecommendations();

    // Analyze each issue for quick win potential
    Object.entries(issueDetails).forEach(([issue, data]) => {
      const recommendation = fixRecommendations[issue] || {};
      const affectedCount = data.examples?.length || 0;

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
            resources: recommendation.resources || [],
            impactScore,
            examples: data.examples.slice(0, 3) // First 3 examples
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
  static calculateImpactScore(severity, affectedCount) {
    const severityWeights = {
      [SEVERITY.CRITICAL]: 100,
      [SEVERITY.HIGH]: 70,
      [SEVERITY.MEDIUM]: 40,
      [SEVERITY.LOW]: 20
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
  static parseEffort(effortStr) {
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
  static getFixRecommendations() {
    return {
      'Some pages are missing alt attribute on images': {
        effort: '5 minutes',
        fix: 'Add descriptive alt text to all images. Alt text should describe the image content for screen readers and SEO.',
        example: '<img src="product.jpg" alt="Blue ceramic coffee mug with white handle">',
        resources: [
          { text: 'Image Alt Text Guide', url: 'https://moz.com/learn/seo/alt-text' }
        ]
      },
      'Some pages have missing or empty title': {
        effort: '10 minutes',
        fix: 'Add unique, descriptive title tags (50-60 characters) to each page. Include primary keywords near the beginning.',
        example: '<title>Organic Coffee Beans | Free Shipping | Coffee Shop Name</title>',
        resources: [
          { text: 'Title Tag Guide', url: 'https://moz.com/learn/seo/title-tag' }
        ]
      },
      'Some pages have missing or empty meta description': {
        effort: '15 minutes',
        fix: 'Add compelling meta descriptions (150-160 characters) that summarize page content and encourage clicks.',
        example: '<meta name="description" content="Shop premium organic coffee beans with free shipping. Arabica & robusta blends roasted fresh daily. Order now!">',
        resources: [
          { text: 'Meta Description Guide', url: 'https://moz.com/learn/seo/meta-description' }
        ]
      },
      'Some pages are missing canonical URL': {
        effort: '10 minutes',
        fix: 'Add canonical link tags to prevent duplicate content issues. Point to the preferred version of the page.',
        example: '<link rel="canonical" href="https://example.com/page">',
        resources: [
          { text: 'Canonical URL Guide', url: 'https://moz.com/learn/seo/canonicalization' }
        ]
      },
      'Some pages have more than one h1 tag': {
        effort: '10 minutes',
        fix: 'Use only one H1 tag per page. The H1 should be the main heading and contain primary keywords.',
        example: '<h1>Main Page Heading</h1>\n<!-- Use h2, h3, etc. for subheadings -->',
        resources: []
      },
      'Some pages have TTFB more than 800ms': {
        effort: '30 minutes',
        fix: 'Improve server response time by: 1) Enable server caching, 2) Use a CDN, 3) Optimize database queries, 4) Upgrade hosting if needed.',
        example: 'Add cache headers:\nCache-Control: public, max-age=3600',
        resources: [
          { text: 'TTFB Optimization', url: 'https://web.dev/articles/ttfb' }
        ]
      },
      'Some pages have LCP more than 2500ms': {
        effort: '20 minutes',
        fix: 'Optimize largest contentful paint by: 1) Optimize images (use WebP, lazy loading), 2) Remove render-blocking resources, 3) Use CDN.',
        example: '<img src="hero.webp" loading="lazy" width="800" height="600">',
        resources: [
          { text: 'Optimize LCP', url: 'https://web.dev/articles/optimize-lcp' }
        ]
      },
      'Some pages have duplicate title': {
        effort: '20 minutes',
        fix: 'Make each page title unique. Include page-specific keywords and differentiators.',
        example: 'Products: "Blue Coffee Mug - Coffee Shop"\nBlog: "How to Brew Perfect Coffee - Coffee Shop"',
        resources: []
      },
      'Some pages have duplicate description': {
        effort: '25 minutes',
        fix: 'Write unique meta descriptions for each page. Highlight what makes each page different.',
        example: 'Product: "Buy our blue ceramic coffee mug..."\nCategory: "Browse all coffee mugs in various colors..."',
        resources: []
      },
      'Some pages are not listed in sitemap': {
        effort: '15 minutes',
        fix: 'Add discovered pages to your sitemap.xml file. Ensure all important pages are included for better crawling.',
        example: '<url>\n  <loc>https://example.com/new-page</loc>\n  <lastmod>2025-12-09</lastmod>\n</url>',
        resources: [
          { text: 'Sitemap Guide', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap' }
        ]
      }
    };
  }
}

module.exports = { ScoreCalculator };
