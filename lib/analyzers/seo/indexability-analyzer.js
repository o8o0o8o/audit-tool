class IndexabilityAnalyzer {
  static async analyzeIndexability(chromePage, parsedPage, url, statusCode) {
    const indexabilityData = {
      isIndexable: true,
      blockingFactors: [],
      warnings: [],
      metaRobots: null,
      xRobotsTag: null,
      statusCode: statusCode,
      canonicalPointsElsewhere: false,
      hasNoindexTag: false,
      hasNofollowTag: false,
      blockedByRobotsTxt: false,
    };

    // 1. Check HTTP status code
    if (statusCode && statusCode >= 400) {
      indexabilityData.isIndexable = false;
      indexabilityData.blockingFactors.push(`HTTP ${statusCode} error`);
    }

    // 2. Check meta robots tag
    const robotsMeta = parsedPage.querySelector('meta[name="robots"]');
    const contentValue = robotsMeta?.getAttribute('content')?.toLowerCase() || '';
    indexabilityData.metaRobots = contentValue || null;

    if (contentValue) {
      if (contentValue.includes('noindex')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.blockingFactors.push('Meta robots: noindex');
      }
      if (contentValue.includes('nofollow')) {
        indexabilityData.hasNofollowTag = true;
        indexabilityData.warnings.push('Meta robots: nofollow (links won\'t be followed)');
      }
      if (contentValue.includes('none')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.hasNofollowTag = true;
        indexabilityData.blockingFactors.push('Meta robots: none (noindex + nofollow)');
      }
    }

    // 3. Check X-Robots-Tag HTTP header
    let response = chromePage.response;
    if (!response) {
      try {
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        // If we can't get response, we already have statusCode
      }
    }

    const headers = await response?.headers() || {};
    const xRobotsTag = headers['x-robots-tag'] || headers['X-Robots-Tag'];

    if (xRobotsTag) {
      indexabilityData.xRobotsTag = xRobotsTag.toLowerCase();

      if (xRobotsTag.toLowerCase().includes('noindex')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.blockingFactors.push('X-Robots-Tag: noindex');
      }
      if (xRobotsTag.toLowerCase().includes('nofollow')) {
        indexabilityData.hasNofollowTag = true;
        indexabilityData.warnings.push('X-Robots-Tag: nofollow');
      }
    }

    // 4. Check if canonical points elsewhere (soft blocking)
    const canonicalTag = parsedPage.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonicalTag?.getAttribute('href');

    if (canonicalUrl) {
      // Normalize URLs for comparison
      const normalizedCanonical = canonicalUrl.split('#')[0].replace(/\/$/, '');
      const normalizedCurrent = url.split('#')[0].replace(/\/$/, '');

      if (normalizedCanonical !== normalizedCurrent && !normalizedCurrent.includes(normalizedCanonical)) {
        indexabilityData.canonicalPointsElsewhere = true;
        indexabilityData.warnings.push(`Canonical points to different page: ${canonicalUrl}`);
      }
    }

    // 5. Check viewport meta (mobile indexing consideration)
    const viewportMeta = parsedPage.querySelector('meta[name="viewport"]');
    if (!viewportMeta) {
      indexabilityData.warnings.push('Missing viewport meta tag (mobile-first indexing concern)');
    }

    // 6. Check for pagination without proper rel tags
    const hasPagination = parsedPage.querySelector('[href*="page="], [href*="/page/"]');
    if (hasPagination) {
      const hasRelNext = parsedPage.querySelector('link[rel="next"]');
      const hasRelPrev = parsedPage.querySelector('link[rel="prev"]');
      if (!hasRelNext && !hasRelPrev) {
        indexabilityData.warnings.push('Pagination detected but missing rel="next/prev" tags');
      }
    }

    return indexabilityData;
  }
}

module.exports = { IndexabilityAnalyzer };
