/**
 * Connection Timing Analyzer
 * Analyzes DNS lookup, TCP connection, and TLS negotiation times
 */

import { SEVERITY } from '../../constants';
import { shortenUrl } from '../../utils';
import type { Issue, ChromePage, PageInfo, NetworkRequest } from '../../types';

interface ResourceTimingEntry {
  url: string;
  origin: string;
  initiatorType: string;
  dns: number;
  tcp: number;
  tls: number;
  ttfb: number;
  download: number;
  total: number;
  size: number;
  protocol: string;
}

interface SlowEntry {
  url: string;
  origin: string;
  time: number;
}

interface OriginTimingEntry {
  isFirstParty: boolean;
  requestCount: number;
  totalDns: number;
  totalTcp: number;
  totalTls: number;
  totalSize: number;
  protocol: string;
}

interface NavigationTimingResult {
  dns: number;
  tcp: number;
  tls: number;
  ttfb: number;
  download: number;
  total: number;
  protocol: string;
}

class ConnectionTimingAnalyzer {
  /**
   * Analyze connection timing
   * @param {Object} chromePage - Playwright page object
   * @param {Object} requests - Network requests
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, requests: NetworkRequest[], url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const timingData = {
      document: null as NavigationTimingResult | null,
      dns: { total: 0, slow: [] as SlowEntry[] },
      tcp: { total: 0, slow: [] as SlowEntry[] },
      tls: { total: 0, slow: [] as SlowEntry[] },
      ttfb: { total: 0, slow: [] as SlowEntry[] },
      uniqueOrigins: [] as string[],
      originTimings: {} as Record<string, OriginTimingEntry>,
      resourceTimings: [] as ResourceTimingEntry[],
    };

    // 1. Get Navigation Timing for main document
    const navTiming = await this.#getNavigationTiming(chromePage);
    timingData.document = navTiming;

    // 2. Get Resource Timing for all requests
    const resourceTimings = await this.#getResourceTimings(chromePage);
    timingData.resourceTimings = resourceTimings;

    // 3. Analyze timings by origin
    const originAnalysis = this.#analyzeByOrigin(resourceTimings, url);
    timingData.uniqueOrigins = originAnalysis.origins;
    timingData.originTimings = originAnalysis.timings;

    // 4. Identify slow connections
    const slowAnalysis = this.#findSlowConnections(resourceTimings);
    timingData.dns.slow = slowAnalysis.slowDns;
    timingData.tcp.slow = slowAnalysis.slowTcp;
    timingData.tls.slow = slowAnalysis.slowTls;
    timingData.ttfb.slow = slowAnalysis.slowTtfb;

    // Calculate totals
    timingData.dns.total = resourceTimings.reduce((sum: number, r: ResourceTimingEntry) => sum + (r.dns || 0), 0);
    timingData.tcp.total = resourceTimings.reduce((sum: number, r: ResourceTimingEntry) => sum + (r.tcp || 0), 0);
    timingData.tls.total = resourceTimings.reduce((sum: number, r: ResourceTimingEntry) => sum + (r.tls || 0), 0);

    // Generate issues

    // Slow document DNS
    if (navTiming && navTiming.dns > 100) {
      issues.push({
        message: 'Slow DNS lookup for main document',
        detail: `<a href="${url}">${url}</a> DNS lookup took ${navTiming.dns}ms. Consider DNS prefetching or changing DNS provider.`,
        severity: navTiming.dns > 200 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    }

    // Slow document TLS
    if (navTiming && navTiming.tls > 100) {
      warnings.push({
        message: 'Slow TLS negotiation',
        detail: `<a href="${url}">${url}</a> TLS negotiation took ${navTiming.tls}ms. Ensure TLS 1.3 is enabled and session resumption is configured.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Slow document TTFB
    if (navTiming && navTiming.ttfb > 600) {
      issues.push({
        message: 'Slow server response time (TTFB)',
        detail: `<a href="${url}">${url}</a> server response took ${navTiming.ttfb}ms. Optimize server-side processing, use caching, or consider a CDN.`,
        severity: navTiming.ttfb > 1000 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    }

    // Too many unique origins
    if (timingData.uniqueOrigins.length > 15) {
      warnings.push({
        message: 'Too many third-party origins',
        detail: `<a href="${url}">${url}</a> connects to ${timingData.uniqueOrigins.length} different origins. Each requires DNS lookup and connection setup. Consider reducing or using dns-prefetch.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Slow third-party DNS
    if (slowAnalysis.slowDns.length > 3) {
      warnings.push({
        message: 'Multiple slow DNS lookups',
        detail: `${slowAnalysis.slowDns.length} resources had DNS lookups over 50ms. Add <link rel="dns-prefetch"> for: ${slowAnalysis.slowDns
          .slice(0, 3)
          .map((d) => d.origin)
          .join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    // Missing preconnect for slow origins
    const slowOrigins = this.#getSlowOrigins(originAnalysis.timings);
    if (slowOrigins.length > 0) {
      const hasPreconnect = await this.#checkPreconnect(chromePage, slowOrigins);
      if (!hasPreconnect) {
        warnings.push({
          message: 'Slow third-party connections without preconnect',
          detail: `Consider adding preconnect for: ${slowOrigins.slice(0, 3).join(', ')}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings, timingData };
  }

  /**
   * Get navigation timing for main document
   * @private
   */
  static async #getNavigationTiming(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return null;

        return {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          tls: nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0,
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          total: Math.round(nav.responseEnd - nav.startTime),
          protocol: nav.nextHopProtocol,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Get resource timing for all resources
   * @private
   */
  static async #getResourceTimings(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];

        return resources.map((r) => {
          let origin;
          try {
            origin = new URL(r.name).origin;
          } catch {
            origin = 'unknown';
          }

          return {
            url: r.name.substring(0, 100),
            origin,
            initiatorType: r.initiatorType,
            dns: Math.round(r.domainLookupEnd - r.domainLookupStart),
            tcp: Math.round(r.connectEnd - r.connectStart),
            tls: r.secureConnectionStart > 0 ? Math.round(r.connectEnd - r.secureConnectionStart) : 0,
            ttfb: Math.round(r.responseStart - r.requestStart),
            download: Math.round(r.responseEnd - r.responseStart),
            total: Math.round(r.duration),
            size: r.transferSize || 0,
            protocol: r.nextHopProtocol,
          };
        });
      });
    } catch {
      return [];
    }
  }

  /**
   * Analyze timings by origin
   * @private
   */
  static #analyzeByOrigin(resourceTimings: ResourceTimingEntry[], pageUrl: string) {
    const timings: Record<string, OriginTimingEntry> = {};
    const pageOrigin = new URL(pageUrl).origin;

    for (const resource of resourceTimings) {
      const origin = resource.origin;
      if (!origin || origin === 'unknown') continue;

      if (!timings[origin]) {
        timings[origin] = {
          isFirstParty: origin === pageOrigin,
          requestCount: 0,
          totalDns: 0,
          totalTcp: 0,
          totalTls: 0,
          totalSize: 0,
          protocol: resource.protocol,
        };
      }

      timings[origin].requestCount++;
      timings[origin].totalDns += resource.dns || 0;
      timings[origin].totalTcp += resource.tcp || 0;
      timings[origin].totalTls += resource.tls || 0;
      timings[origin].totalSize += resource.size || 0;
    }

    return {
      origins: Object.keys(timings),
      timings,
    };
  }

  /**
   * Find slow connections
   * @private
   */
  static #findSlowConnections(resourceTimings: ResourceTimingEntry[]) {
    const slowDns: SlowEntry[] = [];
    const slowTcp: SlowEntry[] = [];
    const slowTls: SlowEntry[] = [];
    const slowTtfb: SlowEntry[] = [];

    for (const resource of resourceTimings) {
      if (resource.dns > 50) {
        slowDns.push({ url: resource.url, origin: resource.origin, time: resource.dns });
      }
      if (resource.tcp > 50) {
        slowTcp.push({ url: resource.url, origin: resource.origin, time: resource.tcp });
      }
      if (resource.tls > 50) {
        slowTls.push({ url: resource.url, origin: resource.origin, time: resource.tls });
      }
      if (resource.ttfb > 200) {
        slowTtfb.push({ url: resource.url, origin: resource.origin, time: resource.ttfb });
      }
    }

    return { slowDns, slowTcp, slowTls, slowTtfb };
  }

  /**
   * Get origins with slow total connection time
   * @private
   */
  static #getSlowOrigins(originTimings: Record<string, OriginTimingEntry>) {
    const slowOrigins: string[] = [];

    for (const [origin, data] of Object.entries(originTimings)) {
      if (data.isFirstParty) continue;

      const avgConnectionTime = (data.totalDns + data.totalTcp + data.totalTls) / data.requestCount;
      if (avgConnectionTime > 100) {
        slowOrigins.push(origin);
      }
    }

    return slowOrigins;
  }

  /**
   * Check for preconnect hints
   * @private
   */
  static async #checkPreconnect(chromePage: ChromePage, origins: string[]) {
    try {
      return await chromePage.evaluate((targetOrigins) => {
        const preconnects = document.querySelectorAll('link[rel="preconnect"]');
        const preconnectOrigins = Array.from(preconnects).map((l) => {
          try {
            return new URL((l as HTMLLinkElement).href).origin;
          } catch {
            return null;
          }
        });

        return targetOrigins.some((o) => preconnectOrigins.includes(o));
      }, origins);
    } catch {
      return false;
    }
  }

  /**
   * Site-wide connection timing analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithSlowTtfb = 0;
    const slowTtfbUrls: string[] = [];
    const totalUniqueOrigins = new Set<string>();

    for (const [url, page] of Object.entries(pages)) {
      if (page.timingData) {
        // dns timing tracked but not currently used for site-wide reporting
        if ((page.timingData.document?.ttfb ?? 0) > 600) {
          pagesWithSlowTtfb++;
          slowTtfbUrls.push(url);
        }
        for (const origin of page.timingData.uniqueOrigins ?? []) {
          totalUniqueOrigins.add(origin);
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    if (pagesWithSlowTtfb > totalPages * 0.3) {
      for (const url of slowTtfbUrls) {
        issues.push({
          message: 'Slow server response (TTFB)',
          detail: `<a href="${url}">${shortenUrl(url)}</a> — TTFB over 600ms; investigate backend/server latency.`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    if (totalUniqueOrigins.size > 50) {
      warnings.push({
        message: 'Site connects to many unique origins',
        detail: `Site connects to ${totalUniqueOrigins.size} unique origins. Large number of third-party connections increases page load time. Review and consolidate external services.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { ConnectionTimingAnalyzer };
