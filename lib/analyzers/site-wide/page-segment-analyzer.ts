import type { PageInfo } from '../../types';
import { SEVERITY } from '../../constants';

/**
 * Page Segment Analyzer
 * Analyzes URL patterns to group pages into segments (blog, product, category, etc.)
 * Similar to Ahrefs' page grouping/segmentation feature.
 */
class PageSegmentAnalyzer {
  // Common URL patterns for different page types
  static SEGMENT_PATTERNS = [
    {
      type: 'blog',
      patterns: ['/blog/', '/news/', '/article/', '/articles/', '/post/', '/posts/', '/journal/'],
      label: 'Blog/News',
    },
    { type: 'product', patterns: ['/product/', '/products/', '/item/', '/items/', '/p/', '/shop/'], label: 'Products' },
    {
      type: 'category',
      patterns: ['/category/', '/categories/', '/collection/', '/collections/', '/c/', '/catalog/'],
      label: 'Categories',
    },
    { type: 'tag', patterns: ['/tag/', '/tags/', '/t/', '/topic/', '/topics/'], label: 'Tags' },
    { type: 'search', patterns: ['/search', '?q=', '?s=', '?query=', '?search='], label: 'Search Pages' },
    {
      type: 'account',
      patterns: ['/account/', '/login', '/register', '/signup', '/profile/', '/user/', '/my-'],
      label: 'Account',
    },
    { type: 'checkout', patterns: ['/checkout/', '/cart/', '/basket/', '/order/', '/payment/'], label: 'Checkout' },
    { type: 'legal', patterns: ['/privacy', '/terms', '/legal/', '/policy/', '/disclaimer', '/gdpr'], label: 'Legal' },
    { type: 'contact', patterns: ['/contact', '/about', '/faq', '/help/', '/support/'], label: 'Info Pages' },
    {
      type: 'media',
      patterns: ['/video/', '/videos/', '/gallery/', '/media/', '/podcast/', '/podcasts/'],
      label: 'Media',
    },
    { type: 'landing', patterns: ['/lp/', '/landing/', '/promo/', '/campaign/'], label: 'Landing Pages' },
    { type: 'api', patterns: ['/api/', '/graphql', '/rest/', '/_next/', '/_nuxt/'], label: 'API/Technical' },
  ];

  /**
   * Analyze page segments across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { segments: {}, issues: [], stats: {} }
   */
  static analyzeSegments(allPages: Record<string, PageInfo>) {
    console.log('\nAnalyzing page segments...');

    const segments: Record<string, any> = {};
    const urlSegmentMap: Record<string, string> = {}; // URL -> segment type

    // Initialize segment categories
    this.SEGMENT_PATTERNS.forEach(({ type, label }) => {
      segments[type] = {
        type,
        label,
        count: 0,
        pages: [],
        avgWordCount: 0,
        totalWordCount: 0,
        issueCount: 0,
        avgScore: 0,
        totalScore: 0,
        statusBreakdown: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
      };
    });

    // Add "other" category for unclassified pages
    segments.other = {
      type: 'other',
      label: 'Other Pages',
      count: 0,
      pages: [],
      avgWordCount: 0,
      totalWordCount: 0,
      issueCount: 0,
      avgScore: 0,
      totalScore: 0,
      statusBreakdown: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    };

    // Classify each page
    for (const url in allPages) {
      const page = allPages[url];
      const segmentType = this.classifyUrl(url);

      urlSegmentMap[url] = segmentType;

      const segment = segments[segmentType];
      segment.count++;
      segment.pages.push(url);

      // Aggregate word count
      const wordCount = page.contentQuality?.wordCount || 0;
      segment.totalWordCount += wordCount;

      // Aggregate score
      const score = page.score?.overall || 0;
      segment.totalScore += score;

      // Count issues
      const pageIssues = this.countPageIssues(page);
      segment.issueCount += pageIssues;

      // Status breakdown
      const status = page.status || page.statusCode || 200;
      const statusGroup = Math.floor(status / 100) + 'xx';
      if (segment.statusBreakdown[statusGroup] !== undefined) {
        segment.statusBreakdown[statusGroup]++;
      }
    }

    // Calculate averages
    Object.keys(segments).forEach((type) => {
      const segment = segments[type];
      if (segment.count > 0) {
        segment.avgWordCount = Math.round(segment.totalWordCount / segment.count);
        segment.avgScore = Math.round(segment.totalScore / segment.count);
      }
      // Don't include full page list in output (too large)
      delete segment.pages;
      delete segment.totalWordCount;
      delete segment.totalScore;
    });

    // Remove empty segments
    const activeSegments: Record<string, any> = {};
    Object.keys(segments).forEach((type) => {
      if (segments[type].count > 0) {
        activeSegments[type] = segments[type];
      }
    });

    // Generate issues
    const issues = this.generateSegmentIssues(activeSegments, allPages);

    // Calculate stats
    const totalPages = Object.keys(allPages).length;
    const stats = {
      totalSegments: Object.keys(activeSegments).length,
      largestSegment: this.findLargestSegment(activeSegments),
      segmentDistribution: this.calculateDistribution(activeSegments, totalPages),
    };

    console.log(`Page segments identified: ${stats.totalSegments}`);
    console.log(`Largest segment: ${stats.largestSegment.label} (${stats.largestSegment.count} pages)`);

    return {
      segments: activeSegments,
      urlSegmentMap,
      issues,
      stats,
    };
  }

  /**
   * Classify a URL into a segment type
   * @param {string} url - The URL to classify
   * @returns {string} Segment type
   */
  static classifyUrl(url: string) {
    const urlLower = url.toLowerCase();

    // Extract pathname for end-of-path matching
    let pathname = urlLower;
    try {
      pathname = new URL(urlLower).pathname;
    } catch {
      // If URL parsing fails, use the whole string
    }

    for (const { type, patterns } of this.SEGMENT_PATTERNS) {
      for (const pattern of patterns) {
        // Check if URL contains the pattern (e.g., /blog/post-title)
        if (urlLower.includes(pattern)) {
          return type;
        }
        // Also check if pathname ends with pattern without trailing slash (e.g., /blog)
        const patternWithoutTrailingSlash = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
        if (pathname === patternWithoutTrailingSlash || pathname.endsWith(patternWithoutTrailingSlash)) {
          return type;
        }
      }
    }

    return 'other';
  }

  /**
   * Count issues for a single page
   * @param {Object} page - Page data
   * @returns {number} Number of issues
   */
  static countPageIssues(page: PageInfo) {
    let count = 0;

    // Count from various sources
    if (page.indexability?.issues) count += page.indexability.issues.length;
    if (page.accessibility?.issues) count += page.accessibility.issues.length;
    if (page.security?.issues) count += page.security.issues.length;
    if (page.seo?.issues) count += page.seo.issues.length;

    return count;
  }

  /**
   * Find the largest segment
   * @param {Object} segments - Segment data
   * @returns {Object} Largest segment info
   */
  static findLargestSegment(segments: Record<string, any>) {
    let largest = { type: 'other', label: 'Other', count: 0 };

    Object.values(segments).forEach((segment: Record<string, any>) => {
      if (segment.count > largest.count) {
        largest = { type: segment.type, label: segment.label, count: segment.count };
      }
    });

    return largest;
  }

  /**
   * Calculate distribution percentages
   * @param {Object} segments - Segment data
   * @param {number} total - Total page count
   * @returns {Object} Distribution percentages
   */
  static calculateDistribution(segments: Record<string, any>, total: number) {
    const distribution: Record<string, any> = {};

    Object.entries(segments).forEach(([type, segment]: [string, any]) => {
      distribution[type] = {
        label: segment.label,
        count: segment.count,
        percentage: total > 0 ? Math.round((segment.count / total) * 100) : 0,
      };
    });

    return distribution;
  }

  /**
   * Generate issues based on segment analysis
   * @param {Object} segments - Segment data
   * @param {Object} allPages - All page data
   * @returns {Array} Issues array
   */
  static generateSegmentIssues(segments: Record<string, any>, allPages: Record<string, PageInfo>) {
    const issues: Record<string, any>[] = [];
    const totalPages = Object.keys(allPages).length;

    // Issue 1: Search pages being indexed (potential duplicate content)
    if (segments.search && segments.search.count > 10) {
      const indexableSearchPages = segments.search.statusBreakdown['2xx'] || 0;
      if (indexableSearchPages > 10) {
        issues.push({
          message: `Search pages may cause duplicate content`,
          detail: `${indexableSearchPages} search result pages are returning 2xx status. Consider blocking search pages from indexing to prevent duplicate content issues.`,
          severity: SEVERITY.MEDIUM,
          segment: 'search',
        });
      }
    }

    // Issue 2: Thin content in specific segments
    Object.values(segments).forEach((segment: Record<string, any>) => {
      if (
        segment.count > 5 &&
        segment.avgWordCount < 100 &&
        segment.type !== 'search' &&
        segment.type !== 'api' &&
        segment.type !== 'account' &&
        segment.type !== 'checkout'
      ) {
        issues.push({
          message: `${segment.label} have thin content`,
          detail: `${segment.count} page(s) in ${segment.label} segment have an average of only ${segment.avgWordCount} words. Consider adding more content.`,
          severity: SEVERITY.MEDIUM,
          segment: segment.type,
        });
      }
    });

    // Issue 3: High error rate in segment
    Object.values(segments).forEach((segment: Record<string, any>) => {
      const errorRate =
        segment.count > 0
          ? ((segment.statusBreakdown['4xx'] + segment.statusBreakdown['5xx']) / segment.count) * 100
          : 0;

      if (errorRate > 20 && segment.count > 5) {
        issues.push({
          message: `High error rate in ${segment.label}`,
          detail: `${errorRate.toFixed(0)}% of pages in ${segment.label} return 4xx/5xx errors (${segment.statusBreakdown['4xx'] + segment.statusBreakdown['5xx']} pages). Investigate and fix these errors.`,
          severity: SEVERITY.HIGH,
          segment: segment.type,
        });
      }
    });

    // Issue 4: Unbalanced site structure
    const otherPercentage = segments.other ? (segments.other.count / totalPages) * 100 : 0;

    if (otherPercentage > 70 && totalPages > 20) {
      issues.push({
        message: `Unstructured URL patterns`,
        detail: `${otherPercentage.toFixed(0)}% of pages don't follow standard URL patterns. Consider organizing pages into clear categories (blog, products, etc.) for better SEO.`,
        severity: SEVERITY.LOW,
        segment: 'other',
      });
    }

    // Issue 5: API/technical pages being indexed
    if (segments.api && segments.api.count > 0) {
      const indexableApi = segments.api.statusBreakdown['2xx'] || 0;
      if (indexableApi > 0) {
        issues.push({
          message: `API/technical pages may be indexed`,
          detail: `${indexableApi} API or technical pages are returning 2xx status and may be indexed. These should typically return 404 or be blocked by robots.txt.`,
          severity: SEVERITY.MEDIUM,
          segment: 'api',
        });
      }
    }

    return issues;
  }
}

export { PageSegmentAnalyzer };
