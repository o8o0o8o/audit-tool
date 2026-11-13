/**
 * Outbound Link Health Checker
 * Verifies that external links are not broken (404/5xx).
 * Uses HEAD requests with caching and rate limiting to avoid hammering external servers.
 */

import { SEVERITY } from '../../constants';
import { getHostname, shortenUrl } from '../../utils';
import type { Issue, PageInfo } from '../../types';
import { LINK_CHECK_HEADERS, classifyLinkStatus, needsGetRetry, stripFragment } from '../../utils/link-status';
import * as https from 'https';
import * as http from 'http';

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
  static async analyze(
    pageData: PageInfo,
    url: string,
    origin: string,
    config: { maxOutboundChecks?: number; outboundTimeout?: number } = {},
  ) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      totalChecked: 0,
      broken: [] as { url: string; status: number }[],
      /** Refused the check (403/429/999…): bot protection, not evidence the page is gone. */
      blocked: [] as { url: string; status: number }[],
      redirected: [] as { url: string; redirectTo: string | null | undefined; status: number | undefined }[],
      timeouts: [] as string[],
      healthy: 0,
    };

    const links: { href?: string; url?: string }[] = Array.isArray(pageData.links)
      ? (pageData.links as { href?: string; url?: string }[])
      : [];
    const originHost = getHostname(origin);
    if (!originHost) {
      return { info, issues, warnings };
    }

    // Filter to external links only
    const externalLinks = [];
    for (const link of links) {
      const href = link.href ?? link.url;
      if (!href) continue;
      try {
        const linkUrl = new URL(href, url);
        if (linkUrl.hostname !== originHost && (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:')) {
          externalLinks.push(stripFragment(linkUrl.href));
        }
      } catch {
        // Invalid URL
      }
    }

    // Deduplicate
    const uniqueLinks = [...new Set(externalLinks)];

    // Limit checks per page to avoid excessive requests
    const maxChecks = config.maxOutboundChecks ?? 20;
    const linksToCheck = uniqueLinks.slice(0, maxChecks);

    // Check each link sequentially per domain to respect rate limiting
    // (Promise.allSettled fires all in parallel, bypassing the per-domain delay)
    const checkTimeout = config.outboundTimeout ?? 5000;
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

      const verdict = classifyLinkStatus(result.status);
      if (verdict === 'dead') {
        info.broken.push({ url: linkUrl, status: result.status });
      } else if (verdict === 'blocked') {
        info.blocked.push({ url: linkUrl, status: result.status });
      } else if (verdict === 'unknown') {
        info.timeouts.push(linkUrl);
      } else if (result.redirected && result.status < 400) {
        info.redirected.push({ url: linkUrl, redirectTo: result.redirectTo, status: result.status });
      } else {
        info.healthy++;
      }
    }

    // Report broken outbound links
    if (info.broken.length > 0) {
      const brokenList = info.broken
        .slice(0, 5)
        .map((b) => `<li><a href="${b.url}">${b.url}</a> (HTTP ${b.status})</li>`)
        .join('');
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
  static analyzeSiteWide(allPages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const pages = Object.values(allPages);

    const allBroken = new Map(); // url -> { status, foundOn: [] }

    for (const page of pages) {
      const linkHealth = page.outboundLinkHealth;
      if (!linkHealth) continue;

      for (const broken of linkHealth.broken || []) {
        if (!allBroken.has(broken.url)) {
          allBroken.set(broken.url, { status: broken.status, foundOn: [] });
        }
        allBroken.get(broken.url).foundOn.push(page.url);
      }
    }

    // One issue per broken outbound link (stable, count-free message) so the
    // report's occurrence count matches the affected-link list instead of
    // contradicting it, and each broken URL is listed individually.
    for (const [brokenUrl, data] of allBroken.entries()) {
      issues.push({
        message: 'Broken outbound link',
        detail: `<a href="${brokenUrl}">${shortenUrl(brokenUrl)}</a> (HTTP ${data.status}) — found on ${data.foundOn.length} page(s); broken outbound links hurt user trust and may negatively signal to search engines.`,
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
  static async #checkUrl(urlToCheck: string, timeoutMs: number = 5000) {
    // Check cache first
    if (urlCache.has(urlToCheck)) {
      return urlCache.get(urlToCheck);
    }

    // Rate limit per domain
    const hostname = getHostname(urlToCheck);
    if (!hostname) {
      return null;
    }

    const lastRequest = domainRequestTimes.get(hostname) ?? 0;
    const now = Date.now();
    if (now - lastRequest < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - (now - lastRequest)));
    }
    domainRequestTimes.set(hostname, Date.now());

    // Follow up to 5 redirects so a link that 301s to a dead page is reported as dead.
    let current = urlToCheck;
    let firstLocation: string | null = null;
    let result: Awaited<ReturnType<typeof OutboundLinkChecker.checkOnce>> = { status: 0, error: true };
    for (let hop = 0; hop <= 5; hop++) {
      result = await OutboundLinkChecker.checkOnce(current, timeoutMs);
      if (!result.redirected || !result.redirectTo) break;
      let next: string;
      try {
        next = new URL(result.redirectTo, current).href;
      } catch {
        break;
      }
      firstLocation ??= next;
      if (next === current) break;
      current = next;
    }
    const final = firstLocation ? { ...result, redirected: true, redirectTo: firstLocation } : result;
    // Don't cache errors/timeouts — they may be transient (network blip, DNS)
    if (final.status) urlCache.set(urlToCheck, final);
    return final;
  }

  /** HEAD, confirmed with GET on any error: HEAD is often refused (405/501) or answered differently. */
  static async checkOnce(urlToCheck: string, timeoutMs: number) {
    const head = await OutboundLinkChecker.#request(urlToCheck, 'HEAD', timeoutMs);
    return needsGetRetry(head.status) ? OutboundLinkChecker.#request(urlToCheck, 'GET', timeoutMs) : head;
  }

  static #request(
    urlToCheck: string,
    method: 'HEAD' | 'GET',
    timeoutMs: number,
  ): Promise<{ status: number; redirected?: boolean; redirectTo?: string | null; timeout?: boolean; error?: boolean }> {
    return new Promise((resolve) => {
      const protocol = urlToCheck.startsWith('https') ? https : http;
      let req: http.ClientRequest;
      try {
        req = protocol.request(urlToCheck, { method, timeout: timeoutMs, headers: LINK_CHECK_HEADERS });
      } catch {
        resolve({ status: 0, error: true });
        return;
      }

      // Outer watchdog uses the CONFIGURED timeout (not a hard-coded 5s) and
      // destroys the socket when it fires, so a hung connection can't linger.
      const timeout = setTimeout(() => {
        req.destroy();
        resolve({ status: 0, timeout: true });
      }, timeoutMs);

      req.on('response', (res) => {
        clearTimeout(timeout);
        res.destroy(); // status + headers are all we need; never download a GET body
        resolve({
          status: res.statusCode ?? 0,
          redirected: res.statusCode! >= 300 && res.statusCode! < 400,
          redirectTo: res.headers.location ?? null,
        });
      });

      req.on('error', () => {
        clearTimeout(timeout);
        resolve({ status: 0, error: true });
      });

      req.on('timeout', () => {
        req.destroy();
        clearTimeout(timeout);
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

export { OutboundLinkChecker };
