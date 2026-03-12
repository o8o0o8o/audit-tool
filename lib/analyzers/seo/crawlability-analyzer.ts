import type { ChromePage, ParsedPage, PageInfo } from '../../types';

class CrawlabilityAnalyzer {
  static async analyzeCrawlability(
    chromePage: ChromePage,
    parsedPage: ParsedPage,
    url: string,
    pageData: PageInfo = { url: '' },
  ) {
    const crawlabilityData = {
      isCrawlable: true,
      blockingFactors: [] as string[],
      warnings: [] as string[],
      hasRobotsTxtBlock: false,
      hasAuthRequired: false,
      redirectChain: [] as string[],
      loadTime: 0,
      resourcesBlocked: [] as string[],
    };

    // 1. Use pre-captured redirect chain (avoid navigation)

    const capturedRedirectChain = pageData.redirectChain || [];
    if (capturedRedirectChain.length > 0) {
      crawlabilityData.redirectChain = capturedRedirectChain.map((r: any) => r.url);

      if (capturedRedirectChain.length > 3) {
        crawlabilityData.warnings.push(`Long redirect chain (${capturedRedirectChain.length} redirects)`);
      }
    }

    // 2. Check authentication requirements

    const statusCode = pageData.status;
    if (statusCode === 401 || statusCode === 403) {
      crawlabilityData.isCrawlable = false;
      crawlabilityData.hasAuthRequired = true;
      crawlabilityData.blockingFactors.push(`Authentication required (HTTP ${statusCode})`);
    }

    // 3. Check for JavaScript-heavy content (potential crawl issue)
    const bodyContent = parsedPage.querySelector('body')?.textContent?.trim() || '';
    const scriptTags = parsedPage.querySelectorAll('script').length;

    if (scriptTags > 20 && bodyContent.length < 500) {
      crawlabilityData.warnings.push('Page is heavily JavaScript-dependent with minimal HTML content');
    }

    // 4. Check for infinite scroll or lazy loading (crawlability concern)
    const hasInfiniteScroll = parsedPage.querySelector('[data-infinite], .infinite-scroll, [data-lazy-load]');
    if (hasInfiniteScroll) {
      crawlabilityData.warnings.push('Infinite scroll or lazy loading detected (may hide content from crawlers)');
    }

    // 5. Check load time (use TTFB from page data if available)

    crawlabilityData.loadTime = pageData.TTFB || pageData.loadTime || 0;
    if (crawlabilityData.loadTime > 10000) {
      crawlabilityData.warnings.push(
        `Very slow load time (${Math.round(crawlabilityData.loadTime / 1000)}s) - may timeout for crawlers`,
      );
    }

    // 6. Check for frames/iframes (crawlability issue)
    const iframes = parsedPage.querySelectorAll('iframe');
    if (iframes.length > 5) {
      crawlabilityData.warnings.push(`Many iframes (${iframes.length}) - content may not be indexed`);
    }

    // 7. Check for "crawler traps" - patterns that might confuse crawlers
    const allLinks = parsedPage.querySelectorAll('a[href]');
    let calendarLinks = 0;
    let sortingLinks = 0;

    for (const link of allLinks) {
      const href = link.getAttribute('href') || '';
      if (href.match(/[?&](year|month|date|calendar)=/i)) calendarLinks++;
      if (href.match(/[?&](sort|order|filter)=/i)) sortingLinks++;
    }

    if (calendarLinks > 20) {
      crawlabilityData.warnings.push('Many calendar/date links - potential crawler trap');
    }
    if (sortingLinks > 10) {
      crawlabilityData.warnings.push('Many sorting/filtering links - potential crawler trap');
    }

    return crawlabilityData;
  }
}

export { CrawlabilityAnalyzer };
