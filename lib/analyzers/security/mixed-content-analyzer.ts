/**
 * Mixed Content Analyzer
 * Detects HTTP resources loaded on HTTPS pages
 */

import { SEVERITY } from '../../constants';
import { getTopEntries, getFileNameFromUrl, isSameDomain } from '../../utils';
import type { Issue, PageInfo } from '../../types';

// Resource types and their security impact
const RESOURCE_SEVERITY = {
  // Active mixed content - blocked by browsers
  script: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  stylesheet: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  iframe: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  object: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  embed: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  xhr: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },
  fetch: { severity: SEVERITY.CRITICAL, type: 'active', blocked: true },

  // Passive mixed content - may show warnings
  image: { severity: SEVERITY.MEDIUM, type: 'passive', blocked: false },
  img: { severity: SEVERITY.MEDIUM, type: 'passive', blocked: false },
  video: { severity: SEVERITY.MEDIUM, type: 'passive', blocked: false },
  audio: { severity: SEVERITY.MEDIUM, type: 'passive', blocked: false },
  font: { severity: SEVERITY.MEDIUM, type: 'passive', blocked: false },

  // Other
  other: { severity: SEVERITY.LOW, type: 'unknown', blocked: false },
};

class MixedContentAnalyzer {
  /**
   * Analyze mixed content for a page
   * @param {object} pageData - Page data with resource information
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      isHttps: boolean;
      activeMixedContent: { url: string; type: string; blocked: boolean }[];
      passiveMixedContent: { url: string; type: string; blocked: boolean }[];
      totalMixedResources: number;
      blockedResources: number;
      htmlMixedContent?: { type: string; url: string }[];
    } = {
      isHttps: false,
      activeMixedContent: [],
      passiveMixedContent: [],
      totalMixedResources: 0,
      blockedResources: 0,
    };

    // Check if page is HTTPS
    try {
      info.isHttps = new URL(url).protocol === 'https:';
    } catch {
      return { issues, warnings, info };
    }

    // Skip if page is HTTP (no mixed content issue)
    if (!info.isHttps) {
      return { issues, warnings, info };
    }

    // Analyze resources
    const resources = pageData.resources ?? [];
    const mixedContent = this.detectMixedContent(resources);

    info.activeMixedContent = mixedContent.active;
    info.passiveMixedContent = mixedContent.passive;
    info.totalMixedResources = mixedContent.active.length + mixedContent.passive.length;
    info.blockedResources = mixedContent.active.length;

    // Check for mixed content in HTML (links, forms, etc.)
    const htmlMixed = this.detectHtmlMixedContent(pageData);
    if (htmlMixed.length > 0) {
      info.htmlMixedContent = htmlMixed;
    }

    // Report active mixed content (critical - blocked by browsers)
    if (info.activeMixedContent.length > 0) {
      const examples = info.activeMixedContent
        .slice(0, 5)
        .map((r) => `${r.type}: ${getFileNameFromUrl(r.url)}`)
        .join(', ');

      issues.push({
        message: 'Active mixed content detected (blocked)',
        detail: `${info.activeMixedContent.length} resources loaded over HTTP are blocked by browsers: ${examples}. These break page functionality.`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report passive mixed content (warning)
    if (info.passiveMixedContent.length > 0) {
      const examples = info.passiveMixedContent
        .slice(0, 5)
        .map((r) => `${r.type}: ${getFileNameFromUrl(r.url)}`)
        .join(', ');

      warnings.push({
        message: 'Passive mixed content detected',
        detail: `${info.passiveMixedContent.length} resources (images, video, audio) loaded over HTTP: ${examples}. Browsers may show security warnings.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for insecure form actions
    if (htmlMixed.some((m) => m.type === 'form')) {
      issues.push({
        message: 'Form submits to insecure HTTP URL',
        detail: 'Form action points to HTTP URL. User data may be transmitted insecurely.',
        severity: SEVERITY.CRITICAL,
      });
    }

    // Check for HTTP links to same domain
    const insecureInternalLinks = htmlMixed.filter((m) => m.type === 'link' && isSameDomain(m.url, url));
    if (insecureInternalLinks.length > 0) {
      warnings.push({
        message: 'Internal links use HTTP instead of HTTPS',
        detail: `${insecureInternalLinks.length} internal links use HTTP. Update to HTTPS or use protocol-relative URLs.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Detect mixed content in resources
   * @param {Array} resources - Resource list
   * @returns {object} Active and passive mixed content
   */
  static detectMixedContent(resources: { url?: string; type?: string; resourceType?: string }[]) {
    const active: { url: string; type: string; blocked: boolean }[] = [];
    const passive: { url: string; type: string; blocked: boolean }[] = [];

    for (const resource of resources) {
      const resourceUrl = resource.url ?? '';

      // Skip if not HTTP
      if (!resourceUrl.startsWith('http://')) {
        continue;
      }

      const type = (resource.type ?? resource.resourceType ?? 'other').toLowerCase();
      const config =
        (RESOURCE_SEVERITY as Record<string, { severity: string; type: string; blocked: boolean }>)[type] ||
        RESOURCE_SEVERITY.other;

      const mixedResource = {
        url: resourceUrl,
        type: type,
        blocked: config.blocked,
      };

      if (config.type === 'active') {
        active.push(mixedResource);
      } else {
        passive.push(mixedResource);
      }
    }

    return { active, passive };
  }

  /**
   * Detect mixed content in HTML elements
   * @param {object} pageData - Page data
   * @returns {Array} Mixed content items
   */
  static detectHtmlMixedContent(pageData: PageInfo) {
    const mixed = [];

    // Check form actions
    const forms = pageData.forms ?? [];
    for (const form of forms) {
      if (form.action?.startsWith('http://')) {
        mixed.push({ type: 'form', url: form.action });
      }
    }

    // Check links
    const links: { href?: string; url?: string }[] = Array.isArray(pageData.links)
      ? (pageData.links as { href?: string; url?: string }[])
      : [];
    for (const link of links) {
      const href = link.href ?? link;
      if (typeof href === 'string' && href.startsWith('http://')) {
        mixed.push({ type: 'link', url: href });
      }
    }

    // Check iframes
    const iframes = pageData.iframes ?? [];
    for (const iframe of iframes) {
      if (iframe.src?.startsWith('http://')) {
        mixed.push({ type: 'iframe', url: iframe.src });
      }
    }

    return mixed;
  }



  /**
   * Analyze mixed content across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      httpsPages: 0,
      httpPages: 0,
      pagesWithActiveMixed: 0,
      pagesWithPassiveMixed: 0,
      totalActiveMixed: 0,
      totalPassiveMixed: 0,
      commonMixedOrigins: {} as Record<string, number>,
    };

    const pagesWithIssues = [];

    for (const [url, pageData] of Object.entries(pages)) {
      try {
        const isHttps = new URL(url).protocol === 'https:';
        if (isHttps) {
          stats.httpsPages++;
        } else {
          stats.httpPages++;
          continue; // Skip HTTP pages
        }
      } catch {
        continue;
      }

      const resources = pageData.resources ?? [];
      const mixedContent = this.detectMixedContent(resources);

      if (mixedContent.active.length > 0) {
        stats.pagesWithActiveMixed++;
        stats.totalActiveMixed += mixedContent.active.length;
        pagesWithIssues.push({ url, active: mixedContent.active.length, passive: mixedContent.passive.length });

        // Track origins
        for (const resource of mixedContent.active) {
          try {
            const origin = new URL(resource.url).origin;
            stats.commonMixedOrigins[origin] = (stats.commonMixedOrigins[origin] || 0) + 1;
          } catch {}
        }
      }

      if (mixedContent.passive.length > 0) {
        stats.pagesWithPassiveMixed++;
        stats.totalPassiveMixed += mixedContent.passive.length;

        // Track origins
        for (const resource of mixedContent.passive) {
          try {
            const origin = new URL(resource.url).origin;
            stats.commonMixedOrigins[origin] = (stats.commonMixedOrigins[origin] || 0) + 1;
          } catch {}
        }
      }
    }

    // Site-wide issues
    if (stats.pagesWithActiveMixed > 0) {
      const examples = pagesWithIssues
        .slice(0, 3)
        .map((p) => p.url)
        .join(', ');
      issues.push({
        message: 'Active mixed content across site',
        detail: `${stats.pagesWithActiveMixed} HTTPS pages load HTTP scripts/styles that are blocked. Total blocked resources: ${stats.totalActiveMixed}. Example pages: ${examples}`,
        severity: SEVERITY.CRITICAL,
      });
    }

    if (stats.pagesWithPassiveMixed > 0) {
      warnings.push({
        message: 'Passive mixed content across site',
        detail: `${stats.pagesWithPassiveMixed} pages load images/media over HTTP. Total: ${stats.totalPassiveMixed} resources. Consider upgrading to HTTPS.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report common insecure origins
    const topOrigins = getTopEntries(Object.entries(stats.commonMixedOrigins) as [string, number][], 5);

    if (topOrigins.length > 0) {
      warnings.push({
        message: 'Common HTTP resource origins',
        detail: `Top insecure origins: ${topOrigins.map(([origin, count]) => `${origin} (${count} resources)`).join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    // Check if site is still on HTTP
    if (stats.httpPages > 0 && stats.httpsPages === 0) {
      issues.push({
        message: 'Site not using HTTPS',
        detail: `All ${stats.httpPages} pages use HTTP. HTTPS is a ranking factor and required for security.`,
        severity: SEVERITY.CRITICAL,
      });
    } else if (stats.httpPages > 0) {
      warnings.push({
        message: 'Some pages still on HTTP',
        detail: `${stats.httpPages} pages use HTTP while ${stats.httpsPages} use HTTPS. Ensure all pages redirect to HTTPS.`,
        severity: SEVERITY.HIGH,
      });
    }

    return { issues, warnings, stats };
  }
}

export { MixedContentAnalyzer };
