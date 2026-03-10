/**
 * Outbound Link Health Checker
 * Verifies that external links are not broken (404/5xx).
 * Uses HEAD requests with caching and rate limiting to avoid hammering external servers.
 */

const { SEVERITY } = require('../../constants');
const https = require('https');
const http = require('http');

// Cache for external URL check results (shared across all pages in a crawl)
const urlCache = new Map();

// Rate limiting: track requests per domain
const domainRequestTimes = new Map();
const RATE_LIMIT_MS = 500; // Minimum ms between requests to same domain

class OutboundLinkChecker {
  /**
   * Check health of external links on a page
   * @param {object} pageData - Page data with links
   * @param {string} url - Page URL
   * @param {string} origin - Site origin (to identify external links)
   * @param {object} config - Analysis config (maxOutboundChecks, outboundTimeout)
   * @returns {object} Analysis results
   */
  static async analyze(pageData, url, origin, config = {}) {
    const issues = [];
    const warnings = [];
    const info = {
      totalChecked: 0,
      broken: [],
      redirected: [],
      timeouts: [],
      healthy: 0,
    };

    const links = pageData.links || [];
    let originHost;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return { info, issues, warnings };
    }

    // Filter to external links only
    const externalLinks = [];
    for (const link of links) {
      const href = link.href || link.url;
      if (!href) continue;
      try {
        const linkUrl = new URL(href, url);
        if (linkUrl.hostname !== originHost && (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:')) {
          externalLinks.push(linkUrl.href);
        }
      } catch {
        // Invalid URL
      }
    }

    // Deduplicate
    const uniqueLinks = [...new Set(externalLinks)];

    // Limit checks per page to avoid excessive requests
    const maxChecks = config.maxOutboundChecks || 20;
    const linksToCheck = uniqueLinks.slice(0, maxChecks);

    // Check each link sequentially per domain to respect rate limiting
    // (Promise.allSettled fires all in parallel, bypassing the per-domain delay)
    const checkTimeout = config.outboundTimeout || 5000;
    const results = [];
    for (const linkUrl of linksToCheck) {
      try {
        const result = await OutboundLinkChecker.#checkUrl(linkUrl, checkTimeout);
        results.push({ status: 'fulfilled', value: result });
      } catch (err) {
        results.push({ status: 'rejected', reason: err });
      }
    }

    for (let i = 0; i < results.length; i++) {
      info.totalChecked++;
      const linkUrl = linksToCheck[i];

      if (results[i].status === 'rejected') {
        info.timeouts.push(linkUrl);
        continue;
      }

      const result = results[i].value;
      if (!result) {
        info.timeouts.push(linkUrl);
        continue;
      }

      if (result.status >= 400) {
        info.broken.push({ url: linkUrl, status: result.status });
      } else if (result.redirected) {
        info.redirected.push({ url: linkUrl, redirectTo: result.redirectTo, status: result.status });
      } else {
        info.healthy++;
      }
    }

    // Report broken outbound links
    if (info.broken.length > 0) {
      const brokenList = info.broken.slice(0, 5).map(b =>
        `<li><a href="${b.url}">${b.url}</a> (HTTP ${b.status})</li>`
      ).join('');
      issues.push({
        message: `Page has ${info.broken.length} broken outbound link(s)`,
        detail: `<a href="${url}">${url}</a> links to dead external pages:<ul>${brokenList}</ul>${info.broken.length > 5 ? `<p>...and ${info.broken.length - 5} more</p>` : ''}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { info, issues, warnings };
  }

  /**
   * Site-wide outbound link health analysis
   * @param {object} allPages - All page data
   * @returns {object} Site-wide analysis results
   */
  static analyzeSiteWide(allPages) {
    const issues = [];
    const warnings = [];
    const pages = Object.values(allPages);

    const allBroken = new Map(); // url -> { status, foundOn: [] }

    for (const page of pages) {
      const linkHealth = page.outboundLinkHealth;
      if (!linkHealth) continue;

      for (const broken of (linkHealth.broken || [])) {
        if (!allBroken.has(broken.url)) {
          allBroken.set(broken.url, { status: broken.status, foundOn: [] });
        }
        allBroken.get(broken.url).foundOn.push(page.url);
      }
    }

    if (allBroken.size > 0) {
      const sorted = [...allBroken.entries()]
        .sort((a, b) => b[1].foundOn.length - a[1].foundOn.length);

      const list = sorted.slice(0, 10).map(([brokenUrl, data]) =>
        `<li><a href="${brokenUrl}">${brokenUrl}</a> (HTTP ${data.status}) - found on ${data.foundOn.length} page(s)</li>`
      ).join('');

      issues.push({
        title: `${allBroken.size} broken outbound link(s) found across the site`,
        description: `External links returning errors:<ul>${list}</ul>${sorted.length > 10 ? `<p>...and ${sorted.length - 10} more</p>` : ''}<p>Broken outbound links hurt user trust and may negatively signal to search engines.</p>`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }

  /**
   * Check a single URL via HEAD request with caching and rate limiting
   * @param {string} urlToCheck - URL to verify
   * @returns {Promise<object>} { status, redirected, redirectTo }
   * @private
   */
  static async #checkUrl(urlToCheck, timeoutMs = 5000) {
    // Check cache first
    if (urlCache.has(urlToCheck)) {
      return urlCache.get(urlToCheck);
    }

    // Rate limit per domain
    let hostname;
    try {
      hostname = new URL(urlToCheck).hostname;
    } catch {
      return null;
    }

    const lastRequest = domainRequestTimes.get(hostname) || 0;
    const now = Date.now();
    if (now - lastRequest < RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - (now - lastRequest)));
    }
    domainRequestTimes.set(hostname, Date.now());

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ status: 0, timeout: true });
      }, 5000);

      const protocol = urlToCheck.startsWith('https') ? https : http;
      const req = protocol.request(urlToCheck, {
        method: 'HEAD',
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
          'Accept': '*/*',
        },
      }, (res) => {
        clearTimeout(timeout);
        const result = {
          status: res.statusCode,
          redirected: res.statusCode >= 300 && res.statusCode < 400,
          redirectTo: res.headers.location || null,
        };
        urlCache.set(urlToCheck, result);
        resolve(result);
      });

      req.on('error', () => {
        clearTimeout(timeout);
        // Don't cache errors — they may be transient (network blip, DNS)
        resolve({ status: 0, error: true });
      });

      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timeout);
        // Don't cache timeouts — they may be transient
        resolve({ status: 0, timeout: true });
      });

      req.end();
    });
  }

  /**
   * Clear the URL cache (call between audit runs)
   */
  static clearCache() {
    urlCache.clear();
    domainRequestTimes.clear();
  }
}

module.exports = { OutboundLinkChecker };
