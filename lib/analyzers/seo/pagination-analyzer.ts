/**
 * Pagination SEO Analyzer
 * Analyzes pagination implementation for SEO best practices
 */

import { CRAWL_SETTINGS, SEVERITY } from '../../constants';
import { removeTrailingSlash, hasRobotsDirective, getPaginationSeriesKey } from '../../utils';
import type { ChromePage, ParsedPage, Issue, PageInfo, PaginationProbeResult } from '../../types';

class PaginationAnalyzer {
  /**
   * Analyze pagination implementation
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const paginationData = {
      hasPagination: false,
      type: null as string | null, // 'numbered', 'load-more', 'infinite-scroll', 'prev-next'
      hasRelPrevNext: false,
      relPrev: null as string | null,
      relNext: null as string | null,
      hasCanonical: false,
      canonicalPointsToSelf: false,
      paginationLinks: [] as { page: number; href: string }[],
      currentPage: null as number | null,
      totalPages: null as number | null,
      infiniteScrollDetected: false,
      loadMoreDetected: false,
      issues: [] as Issue[],
      nextUrl: null as string | null,
      nextIsJsControl: false,
      nextProbe: null as PaginationProbeResult | null,
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
      paginationData.currentPage = paginationData.currentPage ?? uiPagination.currentPage;
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
      paginationData.type = paginationData.type ?? 'load-more';
    }

    // 6. Check canonical behavior on paginated pages
    const canonical = parsedPage.querySelector('link[rel="canonical"]');
    if (canonical) {
      paginationData.hasCanonical = true;
      const canonicalHref = canonical.getAttribute('href');
      paginationData.canonicalPointsToSelf = this.#canonicalMatchesUrl(canonicalHref ?? null, url);
    }

    // 7. Detect the "next" control and whether it is JS-driven (no static href).
    //    Cheap DOM read only — the active probe (clicking) runs as a separate
    //    decoupled step so it never eats the per-page analyzer time budget.
    const nextControl = await this.#detectNextControl(chromePage);
    paginationData.nextUrl = relLinks.next ?? nextControl.href;
    // JS-driven only when a control exists but neither rel=next nor a usable
    // static href is present (so crawlers can't enumerate the series via URLs).
    paginationData.nextIsJsControl = nextControl.found && !relLinks.next && !nextControl.href;

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
    if (paginationData.hasPagination && paginationData.currentPage! > 1) {
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
    if (metaRobots && paginationData.hasPagination && paginationData.currentPage! > 1) {
      const robotsContent = metaRobots.getAttribute('content') ?? '';
      if (hasRobotsDirective(robotsContent, 'noindex')) {
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
  static #checkRelPrevNext(parsedPage: ParsedPage) {
    const prevLink = parsedPage.querySelector('link[rel="prev"]');
    const nextLink = parsedPage.querySelector('link[rel="next"]');

    return {
      hasPrevNext: !!(prevLink ?? nextLink),
      prev: prevLink?.getAttribute('href') ?? null,
      next: nextLink?.getAttribute('href') ?? null,
    };
  }

  /**
   * Analyze URL for pagination patterns
   * @private
   */
  static #analyzeUrlPagination(url: string) {
    const patterns = [
      /[?&]page=(\d+)/i,
      /[?&]p=(\d+)/i,
      /\/page\/(\d+)/i,
      /\/p\/(\d+)/i,
      /\/(\d{1,4})\/?$/, // Only match small numbers to avoid false-positives on product/article IDs
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
  static async #detectPaginationUI(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const result = {
          detected: false,
          type: null as string | null,
          links: [] as { page: number; href: string }[],
          currentPage: null as number | null,
          totalPages: null as number | null,
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
          const href = (link as HTMLAnchorElement).href;
          const pageNum = parseInt(text, 10);

          if (!isNaN(pageNum)) {
            pageNumbers.push(pageNum);
            result.links.push({ page: pageNum, href });
          }
        }

        // Find current page
        const currentIndicators = paginationContainer.querySelectorAll(
          '.current, .active, [aria-current="page"], span.page-numbers:not(a)',
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
    } catch {
      return {
        detected: false,
        type: null,
        links: [] as { page: number; href: string }[],
        currentPage: null,
        totalPages: null,
      };
    }
  }

  /**
   * Detect infinite scroll implementation
   * @private
   */
  static async #detectInfiniteScroll(chromePage: ChromePage, _parsedPage: ParsedPage) {
    try {
      // Only deliberate loading hooks count. Two heuristics were removed because
      // they produced false positives (flagging product/home pages that have no
      // listing at all):
      //   • `[class*="infinite"]` — a substring match that also caught
      //     decorative "infinite" marquee/animation classes.
      //   • a raw-HTML regex scan for /infinite[-_]?scroll/ — which matched the
      //     string anywhere in bundled slider/carousel library code.
      // Both flagged the *word* "infinite", not an actual infinite-scrolled
      // content list. We now require an explicit infinite-scroll container or a
      // JS sentinel/trigger element — the unambiguous signals that list content
      // is loaded on scroll.
      const result = await chromePage.evaluate(() => {
        const hasContainer = document.querySelector('[data-infinite-scroll]') !== null;

        // Sentinel / trigger elements are the reliable marker: a deliberate hook
        // an IntersectionObserver watches to load the next batch of list items.
        const sentinels = document.querySelectorAll(
          '.load-more-sentinel, .scroll-sentinel, [data-sentinel], .infinite-scroll-trigger',
        );

        return { detected: hasContainer || sentinels.length > 0 };
      });

      return { detected: result.detected };
    } catch {
      return { detected: false };
    }
  }

  /**
   * Detect "Load More" buttons
   * @private
   */
  static async #detectLoadMore(chromePage: ChromePage) {
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
          if (
            text.includes('load more') ||
            text.includes('show more') ||
            text.includes('view more') ||
            text.includes('see more')
          ) {
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
    } catch {
      return { detected: false };
    }
  }

  /**
   * Detect a "next" pagination control and resolve its target href.
   * Returns `found` (a next control exists) and `href` (a usable, navigable
   * static URL, or null for JS-driven controls like buttons / `href="#"`).
   * @private
   */
  static async #detectNextControl(
    chromePage: ChromePage,
  ): Promise<{ found: boolean; href: string | null }> {
    try {
      return await chromePage.evaluate(() => {
        // Ordered by specificity. rel=next is handled separately by the caller.
        const selectors = [
          'a[rel="next"]',
          '[class*="pagination"] a.next',
          '[class*="pagination"] .next a',
          'a.next',
          'a[aria-label*="next" i]',
          'button[aria-label*="next" i]',
          'a[rel="nofollow"][class*="next"]',
        ];

        const isNextText = (t: string) => {
          const s = t.trim().toLowerCase();
          return (
            s === 'next' ||
            s === 'next page' ||
            s === 'older' ||
            s === 'older posts' ||
            s === '›' ||
            s === '»' ||
            s === '→'
          );
        };

        let el: Element | null = null;
        for (const sel of selectors) {
          try {
            const found = document.querySelector(sel);
            if (found) {
              el = found;
              break;
            }
          } catch {
            // invalid selector — skip
          }
        }

        // Fall back to text-based matching on anchors / buttons.
        if (!el) {
          const candidates = document.querySelectorAll('a, button');
          for (const c of candidates) {
            if (isNextText(c.textContent || '') || isNextText(c.getAttribute('aria-label') || '')) {
              el = c;
              break;
            }
          }
        }

        if (!el) return { found: false, href: null };

        // Disabled controls don't waste crawl budget.
        const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
        const isDisabled = (el as HTMLButtonElement).disabled === true || ariaDisabled;
        if (isDisabled) return { found: false, href: null };

        const rawHref = el.getAttribute('href');
        const resolved = (el as HTMLAnchorElement).href || '';
        const usable =
          !!rawHref &&
          rawHref.trim() !== '' &&
          !rawHref.startsWith('#') &&
          !rawHref.toLowerCase().startsWith('javascript:');

        return { found: true, href: usable ? resolved : null };
      });
    } catch {
      return { found: false, href: null };
    }
  }

  // Series probed this run, plus a global probe budget — keeps the active
  // probe from running on every listing page of a large site.
  static #probedSeries = new Set<string>();
  static #probeCount = 0;

  /** Reset per-audit probe state (call at the start of a crawl). */
  static resetProbeState(): void {
    this.#probedSeries.clear();
    this.#probeCount = 0;
  }

  /**
   * Whether a JS-"next" probe should run for `url`: only when within the global
   * probe budget and this series (or page, for URL-less JS pagination) has not
   * been probed yet.
   */
  static shouldProbeNext(url: string): boolean {
    if (this.#probeCount >= CRAWL_SETTINGS.BROKEN_PAGINATION_MAX_PROBES) return false;
    // For JS pagination the URL usually doesn't change, so fall back to a
    // path-based key to dedupe near-identical listing pages.
    let key = getPaginationSeriesKey(url);
    if (!key) {
      try {
        key = new URL(url).pathname;
      } catch {
        key = url;
      }
    }
    if (this.#probedSeries.has(key)) return false;
    this.#probedSeries.add(key);
    // Consume budget here (same JS turn as the check) so concurrent crawl
    // batches can't all pass the gate before the probe runs and increments.
    this.#probeCount++;
    return true;
  }

  /**
   * Active probe for JS-driven "next" pagination. Opens an ISOLATED page in the
   * same browser context (never the shared analysis page), clicks "next" up to
   * a bounded number of times, and decides whether it advances into empty /
   * duplicate content forever. Always closes the isolated page.
   *
   * Returns issues to merge plus the structured probe result. Returns an empty
   * result on any failure — best-effort, never throws.
   */
  static async probeJsNext(
    chromePage: ChromePage,
    url: string,
  ): Promise<{ nextProbe: PaginationProbeResult | null; issues: Issue[]; warnings: Issue[] }> {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const maxClicks = CRAWL_SETTINGS.BROKEN_PAGINATION_MAX_PROBE_CLICKS;
    const deadline = Date.now() + CRAWL_SETTINGS.BROKEN_PAGINATION_PROBE_TIMEOUT_MS;

    let probePage: ChromePage | null = null;
    try {
      const context = chromePage.context();
      probePage = await context.newPage();
      await probePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });

      // Signature = visible listing size. Reused after each click to detect
      // "content stopped changing" (duplicate) and "content emptied out".
      const signature = async () =>
        probePage!.evaluate(() => {
          const main = document.querySelector('main, [role="main"], .content, #content') || document.body;
          const text = (main as HTMLElement)?.innerText || '';
          const items = document.querySelectorAll(
            'article, li, .card, [class*="item"], [class*="result"], [class*="post"]',
          ).length;
          return { len: text.replace(/\s+/g, ' ').trim().length, items };
        });

      const nextEnabled = async () =>
        probePage!.evaluate(() => {
          const sels = ['a[rel="next"]', 'a.next', '[class*="pagination"] a.next', 'a[aria-label*="next" i]', 'button[aria-label*="next" i]'];
          for (const s of sels) {
            try {
              const el = document.querySelector(s) as HTMLElement | null;
              if (el) {
                const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
                if (!disabled) return true;
              }
            } catch {
              /* skip */
            }
          }
          // Text fallback
          for (const el of document.querySelectorAll('a, button')) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === 'next' || t === '›' || t === '»' || t === '→' || t === 'older') {
              const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) return true;
            }
          }
          return false;
        });

      const clickNext = async () =>
        probePage!.evaluate(() => {
          const sels = ['a[rel="next"]', 'a.next', '[class*="pagination"] a.next', 'a[aria-label*="next" i]', 'button[aria-label*="next" i]'];
          let el: HTMLElement | null = null;
          for (const s of sels) {
            try {
              el = document.querySelector(s) as HTMLElement | null;
              if (el) break;
            } catch {
              /* skip */
            }
          }
          if (!el) {
            for (const c of document.querySelectorAll('a, button')) {
              const t = (c.textContent || '').trim().toLowerCase();
              if (t === 'next' || t === '›' || t === '»' || t === '→' || t === 'older') {
                el = c as HTMLElement;
                break;
              }
            }
          }
          if (!el) return false;
          el.click();
          return true;
        });

      let prev = await signature();
      let clicks = 0;
      let contentChanged = false;
      let duplicateStreak = 0;
      let emptyAfterClick = false;

      for (let i = 0; i < maxClicks; i++) {
        if (Date.now() > deadline) break;
        if (!(await nextEnabled())) break; // terminated cleanly — finite pagination
        if (!(await clickNext())) break;
        clicks++;
        // Give the click time to fetch/render (bounded).
        await probePage.waitForTimeout(800).catch(() => {});
        const cur = await signature();

        // "Emptied out" = the main content text collapsed to near-nothing.
        // Don't key off item-element count: a div-based listing whose item
        // classes don't match our selectors reads items===0 on every page,
        // including healthy ones, which would false-positive.
        if (cur.len < 30) emptyAfterClick = true;
        const changed = Math.abs(cur.len - prev.len) > 20 || cur.items !== prev.items;
        if (changed) {
          contentChanged = true;
          duplicateStreak = 0;
        } else {
          duplicateStreak++;
        }
        prev = cur;
      }

      const controlPersists = await nextEnabled();
      // Broken: after exhausting our clicks the "next" control is STILL enabled
      // while content has stopped changing or gone empty. Require strong
      // evidence — emptied out, never changed at all, or two consecutive
      // duplicate loads — so genuine JS pagination isn't flagged.
      const suspectedInfinite =
        clicks > 0 && controlPersists && (emptyAfterClick || !contentChanged || duplicateStreak >= 2);

      const nextProbe: PaginationProbeResult = {
        clicks,
        contentChanged,
        controlPersists,
        emptyAfterClick,
        suspectedInfinite,
      };

      if (suspectedInfinite) {
        issues.push({
          message: 'Broken "next" pagination wastes crawl budget',
          detail: `<a href="${url}">${url}</a> has a "next" control that stays clickable while loading empty or duplicate content. Crawlers can follow it indefinitely, wasting crawl budget. Disable/remove "next" on the last page of results.`,
          severity: SEVERITY.HIGH,
        });
      }

      return { nextProbe, issues, warnings };
    } catch {
      return { nextProbe: null, issues, warnings };
    } finally {
      if (probePage) await probePage.close().catch(() => {});
    }
  }

  /**
   * Check if canonical matches current URL
   * @private
   */
  static #canonicalMatchesUrl(canonical: string | null, url: string) {
    if (!canonical) return false;

    try {
      const canonicalUrl = new URL(canonical, url);
      const currentUrl = new URL(url);

      // Compare without trailing slashes
      const canonicalPath = removeTrailingSlash(canonicalUrl.pathname) + canonicalUrl.search;
      const currentPath = removeTrailingSlash(currentUrl.pathname) + currentUrl.search;

      return canonicalUrl.origin === currentUrl.origin && canonicalPath === currentPath;
    } catch {
      return false;
    }
  }

  /**
   * Site-wide pagination analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let infiniteScrollPages = 0;
    let pagesWithRelPrevNext = 0;
    let pagesWithBadCanonical = 0;

    for (const [_url, page] of Object.entries(pages)) {
      if (page.paginationData?.hasPagination) {
        if (page.paginationData.infiniteScrollDetected) {
          infiniteScrollPages++;
        }

        if (page.paginationData.hasRelPrevNext) {
          pagesWithRelPrevNext++;
        }

        if (
          page.paginationData.currentPage != null &&
          page.paginationData.currentPage > 1 &&
          !page.paginationData.canonicalPointsToSelf
        ) {
          pagesWithBadCanonical++;
        }
      }
    }

    if (infiniteScrollPages > 0 && pagesWithRelPrevNext === 0) {
      issues.push({
        message: `${infiniteScrollPages} pages use infinite scroll without pagination fallback`,
        detail:
          'Infinite scroll pages should have static pagination links or ensure all content URLs are in the sitemap.',
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

export { PaginationAnalyzer };
