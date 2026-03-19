/**
 * HTTP Protocol Analyzer
 * Detects HTTP/1.1 vs HTTP/2 vs HTTP/3 and analyzes protocol usage
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

class HTTPProtocolAnalyzer {
  /**
   * Analyze HTTP protocol for a page
   * @param {object} pageData - Page data with protocol information
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      protocol: null as string | null,
      protocolVersion: null as number | null,
      supportsHttp2: false,
      supportsHttp3: false,
      resourceProtocols: {} as Record<string, number>,
      multiplexingBenefit: null as {
        resourceCount: number;
        http1EstimatedRounds: number;
        estimatedSavings: string;
      } | null,
      altSvc: null as string | null,
    };

    // Get protocol from page data
    const protocol = String(pageData.protocol ?? pageData.httpVersion ?? this.detectProtocol(pageData) ?? '');
    info.protocol = protocol || null;
    info.protocolVersion = this.parseProtocolVersion(protocol || null);

    // Check Alt-Svc header for HTTP/3 support
    const altSvc = pageData.headers?.['alt-svc'] ?? pageData.altSvc;
    if (altSvc) {
      info.altSvc = altSvc;
      if (altSvc.includes('h3')) {
        info.supportsHttp3 = true;
      }
    }

    // Analyze resource protocols
    const resources = pageData.resources ?? [];
    for (const resource of resources) {
      const resourceProtocol = String(resource.protocol ?? 'unknown');
      if (!info.resourceProtocols[resourceProtocol]) {
        info.resourceProtocols[resourceProtocol] = 0;
      }
      info.resourceProtocols[resourceProtocol]++;
    }

    // Check if HTTP/2 or better
    info.supportsHttp2 = info.protocolVersion! >= 2;

    // Calculate multiplexing benefit
    if (resources.length > 0) {
      info.multiplexingBenefit = this.calculateMultiplexingBenefit(resources, info.supportsHttp2);
    }

    // Report issues
    if (info.protocolVersion === 1 || info.protocolVersion === 1.1) {
      issues.push({
        message: 'Site using HTTP/1.1',
        detail:
          'HTTP/2 offers significant performance benefits including multiplexing, header compression, and server push. Upgrade to HTTP/2.',
        severity: SEVERITY.MEDIUM,
      });

      // Calculate potential savings
      const uniqueOrigins = this.countUniqueOrigins(resources);
      if (uniqueOrigins > 1 || resources.length > 6) {
        warnings.push({
          message: 'HTTP/1.1 connection limitations affecting performance',
          detail: `With ${resources.length} resources from ${uniqueOrigins} origins, HTTP/1.1's 6 connection limit causes queuing. HTTP/2 multiplexing would help.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    } else if (info.protocolVersion === 2 && !info.supportsHttp3) {
      warnings.push({
        message: 'Consider enabling HTTP/3',
        detail:
          'HTTP/3 (QUIC) offers improved performance especially on mobile networks with its 0-RTT connection establishment and better congestion control.',
        severity: SEVERITY.LOW,
      });
    }

    // Check for mixed protocols (some resources on HTTP/1.1)
    if (info.resourceProtocols['h1'] || info.resourceProtocols['http/1.1']) {
      const http1Resources = (info.resourceProtocols['h1'] || 0) + (info.resourceProtocols['http/1.1'] || 0);
      if (http1Resources > 0 && (info.resourceProtocols['h2'] || info.resourceProtocols['http/2'])) {
        warnings.push({
          message: 'Mixed HTTP protocol versions',
          detail: `${http1Resources} resources loaded over HTTP/1.1 while others use HTTP/2. This can cause performance inconsistencies.`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Warn about domain sharding (anti-pattern for HTTP/2)
    const uniqueOrigins = this.countUniqueOrigins(resources);
    if (info.supportsHttp2 && uniqueOrigins > 4) {
      warnings.push({
        message: 'Domain sharding detected with HTTP/2',
        detail: `Resources loaded from ${uniqueOrigins} different origins. Domain sharding is an anti-pattern for HTTP/2 - consolidate to fewer origins.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Detect protocol from page data
   * @param {object} pageData
   * @returns {string}
   */
  static detectProtocol(pageData: PageInfo): string {
    // Check various sources
    if ((pageData.response as { protocol?: string })?.protocol)
      return (pageData.response as { protocol?: string }).protocol!;
    if (pageData.timing?.protocol) return String(pageData.timing.protocol);

    // Check performance entries
    const perfEntry = pageData.performanceEntry ?? pageData.navigationTiming;
    if (perfEntry?.nextHopProtocol) return String(perfEntry.nextHopProtocol);

    return 'unknown';
  }

  /**
   * Parse protocol version number
   * @param {string} protocol
   * @returns {number}
   */
  static parseProtocolVersion(protocol: string | null) {
    if (!protocol) return null;

    const normalized = protocol.toLowerCase();

    if (normalized.includes('h3') || normalized.includes('http/3')) return 3;
    if (normalized.includes('h2') || normalized.includes('http/2')) return 2;
    if (normalized.includes('http/1.1')) return 1.1;
    if (normalized.includes('http/1.0')) return 1.0;
    if (normalized.includes('http/1')) return 1;

    return null;
  }

  /**
   * Count unique origins from resources
   * @param {Array} resources
   * @returns {number}
   */
  static countUniqueOrigins(resources: { url?: string }[]) {
    const origins = new Set();
    for (const resource of resources) {
      try {
        const origin = new URL(resource.url!).origin;
        origins.add(origin);
      } catch {}
    }
    return origins.size;
  }

  /**
   * Calculate potential multiplexing benefit
   * @param {Array} resources
   * @param {boolean} supportsHttp2
   * @returns {object}
   */
  static calculateMultiplexingBenefit(resources: unknown[], supportsHttp2: boolean) {
    const totalResources = resources.length;
    const maxHttp1Connections = 6;

    // Estimate parallel loading rounds needed
    const http1Rounds = Math.ceil(totalResources / maxHttp1Connections);
    // All resources can be multiplexed with HTTP/2 (effectively 1 round)

    // Estimate time savings (rough)
    const avgResourceTime = 100; // ms estimate
    const http1Time = http1Rounds * avgResourceTime;
    const http2Time = avgResourceTime + totalResources * 5; // Small overhead per resource

    return {
      resourceCount: totalResources,
      http1EstimatedRounds: http1Rounds,
      estimatedSavings: supportsHttp2
        ? 'Already using HTTP/2'
        : `~${Math.round(((http1Time - http2Time) / http1Time) * 100)}% faster with HTTP/2`,
    };
  }

  /**
   * Analyze HTTP protocol across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      pagesAnalyzed: 0,
      protocolDistribution: {} as Record<string, number>,
      supportsHttp2: 0,
      supportsHttp3: 0,
      http1Only: 0,
      avgResourcesPerPage: 0,
    };

    let totalResources = 0;

    for (const [_url, pageData] of Object.entries(pages)) {
      stats.pagesAnalyzed++;

      const protocol = String(pageData.protocol ?? pageData.httpVersion ?? this.detectProtocol(pageData) ?? '');
      const version = this.parseProtocolVersion(protocol || null);

      // Count protocols
      const protocolKey = version ? `HTTP/${version}` : 'Unknown';
      stats.protocolDistribution[protocolKey] = (stats.protocolDistribution[protocolKey] || 0) + 1;

      if (version! >= 2) stats.supportsHttp2++;
      if (version! >= 3 || pageData.headers?.['alt-svc']?.includes('h3')) stats.supportsHttp3++;
      if (version === 1 || version === 1.1) stats.http1Only++;

      totalResources += (pageData.resources ?? []).length;
    }

    if (stats.pagesAnalyzed > 0) {
      stats.avgResourcesPerPage = Math.round(totalResources / stats.pagesAnalyzed);
    }

    // Site-wide issues
    if (stats.http1Only > stats.pagesAnalyzed * 0.5) {
      issues.push({
        message: 'Majority of site using HTTP/1.1',
        detail: `${stats.http1Only}/${stats.pagesAnalyzed} pages use HTTP/1.1. Upgrade server to HTTP/2 for better performance.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (stats.supportsHttp2 > 0 && stats.supportsHttp3 === 0) {
      warnings.push({
        message: 'HTTP/3 not detected',
        detail:
          'Site uses HTTP/2 but HTTP/3 is not available. Consider enabling HTTP/3 for improved mobile performance.',
        severity: SEVERITY.LOW,
      });
    }

    // Protocol summary
    const protocolSummary = Object.entries(stats.protocolDistribution)
      .map(([proto, count]) => `${proto}: ${count} pages`)
      .join(', ');

    if (Object.keys(stats.protocolDistribution).length > 1) {
      warnings.push({
        message: 'Mixed protocol versions across site',
        detail: `Protocol distribution: ${protocolSummary}`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }
}

export { HTTPProtocolAnalyzer };
