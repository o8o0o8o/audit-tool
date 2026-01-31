/**
 * Pagination SEO Analyzer
 * Analyzes pagination implementation for SEO best practices
 */

const { SEVERITY } = require('../../constants');

class PaginationAnalyzer {
  /**
   * Analyze pagination implementation
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage, parsedPage, url) {
    const issues = [];
    const warnings = [];

    const paginationData = {
      hasPagination: false,
      type: null, // 'numbered', 'load-more', 'infinite-scroll', 'prev-next'
      hasRelPrevNext: false,
      relPrev: null,
      relNext: null,
      hasCanonical: false,
      canonicalPointsToSelf: false,
      paginationLinks: [],
      currentPage: null,
      totalPages: null,
      infiniteScrollDetected: false,
      loadMoreDetected: false,
      issues: [],
    };

    // 1. Check for rel="prev" and rel="next" (deprecated but still used)
    const relLinks = this.#checkRelPrevNext(parsedPage);
    paginationData.hasRelPrevNext = relLinks.hasPrevNext;
    paginationData.relPrev = relLinks.prev;
    paginationData.relNext = relLinks.next;

    // 2. Detect pagination patterns in URL
    const urlPagination = this.#analyzeUrlPagination(url);
    if (urlPagination.isPaginated) {
      paginationData.hasPagination = true;
      paginationData.currentPage = urlPagination.currentPage;
      paginationData.type = 'url-based';
    }

    // 3. Detect pagination UI elements
    const uiPagination = await this.#detectPaginationUI(chromePage);
    if (uiPagination.detected) {
      paginationData.hasPagination = true;
      paginationData.type = uiPagination.type;
      paginationData.paginationLinks = uiPagination.links;
      paginationData.currentPage = paginationData.currentPage || uiPagination.currentPage;
      paginationData.totalPages = uiPagination.totalPages;
    }

    // 4. Detect infinite scroll
    const infiniteScroll = await this.#detectInfiniteScroll(chromePage, parsedPage);
    if (infiniteScroll.detected) {
      paginationData.hasPagination = true;
      paginationData.infiniteScrollDetected = true;
      paginationData.type = 'infinite-scroll';
    }

    // 5. Detect "Load More" buttons
    const loadMore = await this.#detectLoadMore(chromePage);
    if (loadMore.detected) {
      paginationData.hasPagination = true;
      paginationData.loadMoreDetected = true;
      paginationData.type = paginationData.type || 'load-more';
    }

    // 6. Check canonical behavior on paginated pages
    const canonical = parsedPage.querySelector('link[rel="canonical"]');
    if (canonical) {
      paginationData.hasCanonical = true;
      const canonicalHref = canonical.getAttribute('href');
      paginationData.canonicalPointsToSelf = this.#canonicalMatchesUrl(canonicalHref, url);
    }

    // Generate issues

    // Infinite scroll without SEO fallback
    if (paginationData.infiniteScrollDetected) {
      const hasStaticLinks = paginationData.paginationLinks.length > 0 || paginationData.hasRelPrevNext;

      if (!hasStaticLinks) {
        issues.push({
          message: 'Infinite scroll without pagination fallback',
          detail: `<a href="${url}">${url}</a> uses infinite scroll but has no static pagination links. Search engines may not discover all content. Add paginated links or a sitemap covering all items.`,
          severity: SEVERITY.HIGH,
        });
      } else {
        warnings.push({
          message: 'Infinite scroll detected - verify SEO implementation',
          detail: `<a href="${url}">${url}</a> uses infinite scroll. Ensure all content is accessible via static URLs.`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Load more without proper pagination
    if (paginationData.loadMoreDetected && paginationData.paginationLinks.length === 0) {
      warnings.push({
        message: '"Load More" pattern without pagination links',
        detail: `<a href="${url}">${url}</a> has a "Load More" button but no numbered pagination. Ensure all content has static URLs for indexing.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Paginated page with canonical to first page (bad practice)
    if (paginationData.hasPagination && paginationData.currentPage > 1) {
      if (paginationData.hasCanonical && !paginationData.canonicalPointsToSelf) {
        issues.push({
          message: 'Paginated page canonicals to different URL',
          detail: `<a href="${url}">${url}</a> is page ${paginationData.currentPage} but canonical points elsewhere. Each page should self-canonicalize or content may not be indexed.`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Missing rel="next" on pages with clear pagination
    if (paginationData.hasPagination && paginationData.paginationLinks.length > 0 && !paginationData.hasRelPrevNext) {
      warnings.push({
        message: 'Paginated content without rel="prev/next"',
        detail: `<a href="${url}">${url}</a> has pagination but no rel="prev/next" links. While Google deprecated these, they can still help other search engines.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check for pagination-specific noindex (sometimes intentional)
    const metaRobots = parsedPage.querySelector('meta[name="robots"]');
    if (metaRobots && paginationData.hasPagination && paginationData.currentPage > 1) {
      const robotsContent = metaRobots.getAttribute('content') || '';
      if (robotsContent.toLowerCase().includes('noindex')) {
        warnings.push({
          message: 'Paginated page is noindexed',
          detail: `<a href="${url}">${url}</a> (page ${paginationData.currentPage}) has noindex. Ensure this is intentional and content is accessible elsewhere.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings, paginationData };
  }

  /**
   * Check for rel="prev" and rel="next"
   * @private
   */
  static #checkRelPrevNext(parsedPage) {
    const prevLink = parsedPage.querySelector('link[rel="prev"]');
    const nextLink = parsedPage.querySelector('link[rel="next"]');

    return {
      hasPrevNext: !!(prevLink || nextLink),
      prev: prevLink?.getAttribute('href') || null,
      next: nextLink?.getAttribute('href') || null,
    };
  }

  /**
   * Analyze URL for pagination patterns
   * @private
   */
  static #analyzeUrlPagination(url) {
    const patterns = [
      /[?&]page=(\d+)/i,
      /[?&]p=(\d+)/i,
      /\/page\/(\d+)/i,
      /\/p\/(\d+)/i,
      /\/(\d+)\/?$/,
      /-page-(\d+)/i,
      /_page_(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return {
          isPaginated: true,
          currentPage: parseInt(match[1], 10),
        };
      }
    }

    return { isPaginated: false, currentPage: null };
  }

  /**
   * Detect pagination UI elements
   * @private
   */
  static async #detectPaginationUI(chromePage) {
    try {
      return await chromePage.evaluate(() => {
        const result = {
          detected: false,
          type: null,
          links: [],
          currentPage: null,
          totalPages: null,
        };

        // Common pagination selectors
        const selectors = [
          '.pagination',
          '.pager',
          '.page-numbers',
          '[class*="pagination"]',
          '[class*="pager"]',
          'nav[aria-label*="pagination"]',
          'ul.pages',
          '.wp-pagenavi',
        ];

        let paginationContainer = null;
        for (const selector of selectors) {
          paginationContainer = document.querySelector(selector);
          if (paginationContainer) break;
        }

        if (!paginationContainer) {
          return result;
        }

        result.detected = true;
        result.type = 'numbered';

        // Find pagination links
        const links = paginationContainer.querySelectorAll('a[href]');
        const pageNumbers = [];

        for (const link of links) {
          const text = link.textContent.trim();
          const href = link.href;
          const pageNum = parseInt(text, 10);

          if (!isNaN(pageNum)) {
            pageNumbers.push(pageNum);
            result.links.push({ page: pageNum, href });
          }
        }

        // Find current page
        const currentIndicators = paginationContainer.querySelectorAll(
          '.current, .active, [aria-current="page"], span.page-numbers:not(a)'
        );
        for (const indicator of currentIndicators) {
          const pageNum = parseInt(indicator.textContent.trim(), 10);
          if (!isNaN(pageNum)) {
            result.currentPage = pageNum;
            break;
          }
        }

        // Estimate total pages
        if (pageNumbers.length > 0) {
          result.totalPages = Math.max(...pageNumbers);
        }

        return result;
      });
    } catch (e) {
      return { detected: false };
    }
  }

  /**
   * Detect infinite scroll implementation
   * @private
   */
  static async #detectInfiniteScroll(chromePage, parsedPage) {
    try {
      // Check for common infinite scroll indicators
      const result = await chromePage.evaluate(() => {
        // Check for IntersectionObserver usage (common in infinite scroll)
        const hasIntersectionObserver = typeof IntersectionObserver !== 'undefined';

        // Check for scroll event listeners that might trigger loading
        // This is a heuristic - can't directly check listeners
        const indicators = [
          // Common infinite scroll libraries/patterns
          document.querySelector('[data-infinite-scroll]'),
          document.querySelector('.infinite-scroll'),
          document.querySelector('[class*="infinite"]'),
          // Waypoint indicators
          document.querySelector('.waypoint'),
          document.querySelector('[data-waypoint]'),
        ];

        const hasIndicator = indicators.some(el => el !== null);

        // Check for sentinel elements (end-of-list markers)
        const sentinels = document.querySelectorAll(
          '.load-more-sentinel, .scroll-sentinel, [data-sentinel], .infinite-scroll-trigger'
        );

        return {
          detected: hasIndicator || sentinels.length > 0,
          hasIntersectionObserver,
          sentinelCount: sentinels.length,
        };
      });

      // Also check HTML for common patterns
      const html = parsedPage.toString();
      const infinitePatterns = [
        /infinite[-_]?scroll/i,
        /endless[-_]?scroll/i,
        /load[-_]?more[-_]?on[-_]?scroll/i,
      ];

      const htmlHasPattern = infinitePatterns.some(p => p.test(html));

      return {
        detected: result.detected || htmlHasPattern,
      };
    } catch (e) {
      return { detected: false };
    }
  }

  /**
   * Detect "Load More" buttons
   * @private
   */
  static async #detectLoadMore(chromePage) {
    try {
      return await chromePage.evaluate(() => {
        const loadMoreSelectors = [
          'button:contains("Load More")',
          'button:contains("Show More")',
          'a:contains("Load More")',
          '.load-more',
          '.show-more',
          '[data-load-more]',
          '[class*="load-more"]',
          '[class*="show-more"]',
        ];

        // Custom contains selector since :contains isn't standard
        const buttons = document.querySelectorAll('button, a.btn, a.button');
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase();
          if (text.includes('load more') || text.includes('show more') ||
              text.includes('view more') || text.includes('see more')) {
            return { detected: true, text: btn.textContent.trim() };
          }
        }

        // Check class-based selectors
        for (const selector of loadMoreSelectors.slice(4)) {
          if (document.querySelector(selector)) {
            return { detected: true };
          }
        }

        return { detected: false };
      });
    } catch (e) {
      return { detected: false };
    }
  }

  /**
   * Check if canonical matches current URL
   * @private
   */
  static #canonicalMatchesUrl(canonical, url) {
    if (!canonical) return false;

    try {
      const canonicalUrl = new URL(canonical, url);
      const currentUrl = new URL(url);

      // Compare without trailing slashes
      const canonicalPath = canonicalUrl.pathname.replace(/\/$/, '') + canonicalUrl.search;
      const currentPath = currentUrl.pathname.replace(/\/$/, '') + currentUrl.search;

      return canonicalUrl.origin === currentUrl.origin && canonicalPath === currentPath;
    } catch (e) {
      return false;
    }
  }

  /**
   * Site-wide pagination analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages) {
    const issues = [];
    const warnings = [];

    let paginatedPages = 0;
    let infiniteScrollPages = 0;
    let pagesWithRelPrevNext = 0;
    let pagesWithBadCanonical = 0;

    for (const [url, page] of Object.entries(pages)) {
      if (page.paginationData?.hasPagination) {
        paginatedPages++;

        if (page.paginationData.infiniteScrollDetected) {
          infiniteScrollPages++;
        }

        if (page.paginationData.hasRelPrevNext) {
          pagesWithRelPrevNext++;
        }

        if (page.paginationData.currentPage > 1 && !page.paginationData.canonicalPointsToSelf) {
          pagesWithBadCanonical++;
        }
      }
    }

    if (infiniteScrollPages > 0 && pagesWithRelPrevNext === 0) {
      issues.push({
        message: `${infiniteScrollPages} pages use infinite scroll without pagination fallback`,
        detail: 'Infinite scroll pages should have static pagination links or ensure all content URLs are in the sitemap.',
        severity: SEVERITY.HIGH,
      });
    }

    if (pagesWithBadCanonical > 0) {
      issues.push({
        message: `${pagesWithBadCanonical} paginated pages have incorrect canonicals`,
        detail: 'Paginated pages (page 2, 3, etc.) should self-canonicalize to ensure content is indexed.',
        severity: SEVERITY.HIGH,
      });
    }

    return { issues, warnings };
  }
}

module.exports = { PaginationAnalyzer };
