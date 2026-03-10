class CachingAnalyzer {
  static async analyzeCaching(chromePage, requests, url) {
    const cachingAnalysis = {
      hasCDN: false,
      cdnProvider: null,
      htmlCacheable: false,
      staticCached: 0,
      staticUncached: 0,
      hasServiceWorker: false,
      cacheScore: 0,
      issues: [],
    };

    // 1. Check for CDN usage via headers and domains
    const cdnIndicators = {
      headers: ['cf-ray', 'x-cache', 'x-amz-cf-id', 'x-cdn', 'server', 'via'],
      domains: ['cloudflare', 'cloudfront', 'fastly', 'akamai', 'cdn77', 'maxcdn', 'bunnycdn', 'keycdn'],
      providers: {
        'cf-ray': 'Cloudflare',
        'x-amz-cf-id': 'CloudFront',
        'fastly': 'Fastly',
        'akamai': 'Akamai',
      }
    };

    // Check response headers for CDN indicators
    for (const [reqUrl, reqData] of Object.entries(requests)) {
      const headers = reqData.headers || {};

      // Check CDN headers
      for (const header of cdnIndicators.headers) {
        if (headers[header]) {
          cachingAnalysis.hasCDN = true;
          // Identify provider
          for (const [indicator, provider] of Object.entries(cdnIndicators.providers)) {
            if (header === indicator || headers[header]?.toLowerCase().includes(indicator)) {
              cachingAnalysis.cdnProvider = provider;
              break;
            }
          }
        }
      }

      // Check CDN domains in URLs
      for (const domain of cdnIndicators.domains) {
        if (reqUrl.includes(domain)) {
          cachingAnalysis.hasCDN = true;
          if (!cachingAnalysis.cdnProvider) {
            cachingAnalysis.cdnProvider = domain.charAt(0).toUpperCase() + domain.slice(1);
          }
        }
      }
    }

    // 2. Check HTML page caching
    const pageResponse = requests[url];
    if (pageResponse?.headers) {
      const cacheControl = pageResponse.headers['cache-control'] || '';
      const expires = pageResponse.headers['expires'];
      const etag = pageResponse.headers['etag'];

      cachingAnalysis.htmlCacheable = (
        cacheControl.includes('max-age') ||
        cacheControl.includes('public') ||
        expires ||
        etag
      ) && !cacheControl.includes('no-store') && !cacheControl.includes('no-cache');
    }

    // 3. Analyze static resources caching
    const staticExtensions = ['.js', '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico'];

    for (const [reqUrl, reqData] of Object.entries(requests)) {
      const urlPath = reqUrl.toLowerCase().split('?')[0]; // strip query params
      const isStatic = staticExtensions.some(ext => urlPath.endsWith(ext));

      if (isStatic) {
        const headers = reqData.headers || {};
        const cacheControl = headers['cache-control'] || '';
        const expires = headers['expires'];
        const etag = headers['etag'];

        const isCached = (
          (cacheControl && (cacheControl.includes('max-age') || cacheControl.includes('public'))) ||
          expires ||
          etag
        ) && !cacheControl.includes('no-store') && !cacheControl.includes('no-cache');

        if (isCached) {
          cachingAnalysis.staticCached++;
        } else {
          cachingAnalysis.staticUncached++;
          if (cachingAnalysis.staticUncached <= 5) {
            cachingAnalysis.issues.push(`Uncached: ${reqUrl.substring(0, 50)}...`);
          }
        }
      }
    }

    // 4. Check for Service Worker
    try {
      cachingAnalysis.hasServiceWorker = await chromePage.evaluate(() => {
        return 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
      });
    } catch (error) {
      // Service worker check failed, assume false
      cachingAnalysis.hasServiceWorker = false;
    }

    // 5. Calculate caching effectiveness score (0-100)
    let score = 0;

    // CDN usage: +30 points
    if (cachingAnalysis.hasCDN) score += 30;

    // HTML cacheability: +10 points
    if (cachingAnalysis.htmlCacheable) score += 10;

    // Static resources caching: up to 40 points
    const totalStatic = cachingAnalysis.staticCached + cachingAnalysis.staticUncached;
    if (totalStatic > 0) {
      const cachingRatio = cachingAnalysis.staticCached / totalStatic;
      score += Math.round(cachingRatio * 40);
    }

    // Service Worker: +20 points
    if (cachingAnalysis.hasServiceWorker) score += 20;

    cachingAnalysis.cacheScore = score;

    return cachingAnalysis;
  }
}

module.exports = { CachingAnalyzer };
