/**
 * Third-Party Script Analyzer
 * Quantifies third-party script impact on page load performance
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, PageInfo, NetworkRequest } from '../../types';

class ThirdPartyAnalyzer {
  // Known third-party categories
  static #categories = {
    analytics: [
      'google-analytics.com',
      'googletagmanager.com',
      'analytics.google.com',
      'hotjar.com',
      'clarity.ms',
      'mouseflow.com',
      'fullstory.com',
      'segment.com',
      'mixpanel.com',
      'amplitude.com',
      'heap.io',
      'plausible.io',
      'matomo',
      'piwik',
    ],
    advertising: [
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'facebook.net',
      'fbcdn.net',
      'ads-twitter.com',
      'amazon-adsystem.com',
      'criteo.com',
      'outbrain.com',
      'taboola.com',
      'adsrvr.org',
    ],
    social: [
      'facebook.com',
      'twitter.com',
      'linkedin.com',
      'pinterest.com',
      'instagram.com',
      'tiktok.com',
      'addthis.com',
      'sharethis.com',
    ],
    video: ['youtube.com', 'youtu.be', 'vimeo.com', 'wistia.com', 'vidyard.com', 'jwplayer.com', 'brightcove.com'],
    customerService: [
      'intercom.io',
      'zendesk.com',
      'drift.com',
      'crisp.chat',
      'freshdesk.com',
      'livechat.com',
      'tawk.to',
      'olark.com',
    ],
    cdn: [
      'cloudflare.com',
      'jsdelivr.net',
      'unpkg.com',
      'cdnjs.cloudflare.com',
      'bootstrapcdn.com',
      'jquery.com',
      'googleapis.com/ajax',
    ],
    fonts: ['fonts.googleapis.com', 'fonts.gstatic.com', 'use.typekit.net', 'fast.fonts.net'],
    maps: ['maps.googleapis.com', 'maps.google.com', 'mapbox.com', 'openstreetmap.org', 'leafletjs.com'],
    other: [],
  };

  /**
   * Analyze third-party scripts
   * @param {Object} chromePage - Playwright page object
   * @param {Object} requests - Network requests
   * @param {string} url - Page URL
   * @param {string} origin - Site origin
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, requests: NetworkRequest[], url: string, origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const originHost = new URL(origin).hostname;
    const thirdPartyData: Record<string, any> = {
      scripts: [] as Record<string, any>[],
      totalSize: 0,
      totalTime: 0,
      byCategory: {} as Record<string, any>,
      blockingScripts: [] as Record<string, any>[],
      count: 0,
    };

    // Analyze requests
    for (const [reqUrl, req] of Object.entries(requests) as [string, any][]) {
      try {
        const reqHost = new URL(reqUrl).hostname;

        // Skip first-party requests
        if (this.#isFirstParty(reqHost, originHost)) {
          continue;
        }

        const category = this.#categorize(reqHost);
        const size = req.size || 0;
        const duration = req.duration || 0;

        const scriptInfo = {
          url: reqUrl.substring(0, 150),
          host: reqHost,
          category,
          size,
          duration,
          resourceType: req.resourceType,
          status: req.status,
        };

        thirdPartyData.scripts.push(scriptInfo);
        thirdPartyData.totalSize += size;
        thirdPartyData.totalTime += duration;
        thirdPartyData.count++;

        // Track by category
        if (!thirdPartyData.byCategory[category]) {
          thirdPartyData.byCategory[category] = {
            count: 0,
            size: 0,
            time: 0,
            hosts: new Set(),
          };
        }
        thirdPartyData.byCategory[category].count++;
        thirdPartyData.byCategory[category].size += size;
        thirdPartyData.byCategory[category].time += duration;
        thirdPartyData.byCategory[category].hosts.add(reqHost);
      } catch {
        // Invalid URL, skip
      }
    }

    // Check for render-blocking third-party scripts
    thirdPartyData.blockingScripts = await this.#findBlockingScripts(chromePage, originHost);

    // Convert Sets to Arrays for serialization
    for (const cat of Object.keys(thirdPartyData.byCategory)) {
      thirdPartyData.byCategory[cat].hosts = Array.from(thirdPartyData.byCategory[cat].hosts);
    }

    // Generate issues

    // Too much third-party payload
    if (thirdPartyData.totalSize > 1000000) {
      // 1MB
      issues.push({
        message: 'Excessive third-party payload',
        detail: `<a href="${url}">${url}</a> loads ${(thirdPartyData.totalSize / 1024).toFixed(0)}KB from third parties. This significantly impacts load time.`,
        severity: SEVERITY.HIGH,
      });
    } else if (thirdPartyData.totalSize > 500000) {
      // 500KB
      warnings.push({
        message: 'Large third-party payload',
        detail: `<a href="${url}">${url}</a> loads ${(thirdPartyData.totalSize / 1024).toFixed(0)}KB from third parties.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Too many third-party requests
    if (thirdPartyData.count > 50) {
      issues.push({
        message: 'Too many third-party requests',
        detail: `<a href="${url}">${url}</a> makes ${thirdPartyData.count} third-party requests. Consider reducing or deferring.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Render-blocking third-party scripts
    if (thirdPartyData.blockingScripts.length > 0) {
      issues.push({
        message: 'Render-blocking third-party scripts',
        detail: `<a href="${url}">${url}</a> has ${thirdPartyData.blockingScripts.length} render-blocking third-party script(s): ${thirdPartyData.blockingScripts
          .slice(0, 3)
          .map((s: any) => s.host)
          .join(', ')}. Add async or defer.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Heavy advertising scripts
    const adCategory = thirdPartyData.byCategory.advertising;
    if (adCategory && adCategory.size > 300000) {
      warnings.push({
        message: 'Heavy advertising scripts',
        detail: `Advertising scripts total ${(adCategory.size / 1024).toFixed(0)}KB. Consider lazy-loading ads below the fold.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Multiple analytics providers
    const analyticsCategory = thirdPartyData.byCategory.analytics;
    if (analyticsCategory && analyticsCategory.hosts.length > 3) {
      warnings.push({
        message: 'Multiple analytics providers',
        detail: `${analyticsCategory.hosts.length} analytics providers detected: ${analyticsCategory.hosts.join(', ')}. Consider consolidating.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, thirdPartyData };
  }

  /**
   * Check if host is first-party
   * @private
   */
  static #isFirstParty(reqHost: string, originHost: string) {
    // Same domain or subdomain
    return reqHost === originHost || reqHost.endsWith('.' + originHost) || originHost.endsWith('.' + reqHost);
  }

  /**
   * Categorize a third-party host
   * @private
   */
  static #categorize(host: string) {
    for (const [category, domains] of Object.entries(this.#categories)) {
      for (const domain of domains) {
        if (host.includes(domain)) {
          return category;
        }
      }
    }
    return 'other';
  }

  /**
   * Find render-blocking third-party scripts
   * @private
   */
  static async #findBlockingScripts(chromePage: ChromePage, originHost: string) {
    try {
      return await chromePage.evaluate((origin) => {
        const blocking = [];
        const scripts = document.querySelectorAll('script[src]');

        for (const script of scripts) {
          const el = script as HTMLScriptElement;
          const src = el.src;
          if (!src) continue;

          try {
            const scriptHost = new URL(src).hostname;

            // Check if third-party and blocking
            const isThirdParty = !scriptHost.includes(origin) && !origin.includes(scriptHost);
            const isBlocking = !el.async && !el.defer;

            if (isThirdParty && isBlocking) {
              blocking.push({
                src: src.substring(0, 100),
                host: scriptHost,
              });
            }
          } catch {
            // Invalid URL
          }
        }

        return blocking;
      }, originHost);
    } catch {
      return [];
    }
  }

  /**
   * Site-wide third-party analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Record<string, any>[] = [];
    const warnings: Record<string, any>[] = [];

    let pagesWithBlockingScripts = 0;
    const allHosts = new Set();
    const categoryTotals: Record<string, any> = {};

    for (const [_url, page] of Object.entries(pages)) {
      if (page.thirdPartyData) {
        if ((page.thirdPartyData.blockingScripts?.length ?? 0) > 0) {
          pagesWithBlockingScripts++;
        }

        for (const script of page.thirdPartyData.scripts || []) {
          allHosts.add(script.host);
        }

        for (const [cat, data] of Object.entries(page.thirdPartyData.byCategory || {}) as [string, any][]) {
          if (!categoryTotals[cat]) {
            categoryTotals[cat] = { size: 0, count: 0 };
          }
          categoryTotals[cat].size += data.size;
          categoryTotals[cat].count += data.count;
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    if (pagesWithBlockingScripts > totalPages * 0.3) {
      issues.push({
        message: 'Many pages have render-blocking third-party scripts',
        detail: `${pagesWithBlockingScripts} of ${totalPages} pages have blocking third-party scripts. Add async/defer attributes.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (allHosts.size > 30) {
      warnings.push({
        message: 'Many third-party domains used',
        detail: `Site connects to ${allHosts.size} different third-party domains. Review and reduce unnecessary services.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { ThirdPartyAnalyzer };
