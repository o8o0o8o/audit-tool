/**
 * Open Redirect Analyzer
 * Detects URL parameters that may be vulnerable to open redirect attacks
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo, ParsedPage } from '../../types';

// Parameter names commonly used for redirects
const REDIRECT_PARAMS = [
  'redirect',
  'redirect_uri',
  'redirect_url',
  'return',
  'returnto',
  'return_url',
  'return_to',
  'next',
  'url',
  'goto',
  'target',
  'dest',
  'destination',
  'rurl',
  'redir',
  'continue',
  'callback',
  'forward',
  'out',
  'link',
  'ref',
];

class OpenRedirectAnalyzer {
  static analyze(pageData: PageInfo, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      suspiciousParams: { url: string; param: string; value: string }[];
      suspiciousLinks: { href: string; param: string }[];
    } = {
      suspiciousParams: [],
      suspiciousLinks: [],
    };

    // 1. Check the current page URL for redirect-like parameters
    try {
      const pageUrl = new URL(url);
      for (const [param, value] of pageUrl.searchParams.entries()) {
        if (this.isRedirectParam(param) && this.isUrlLikeValue(value)) {
          info.suspiciousParams.push({ url, param, value: value.substring(0, 100) });
        }
      }
    } catch {
      // Invalid URL, skip
    }

    // 2. Check links on the page for redirect parameters
    // Only same-site links: an open redirect is a flaw in this site's endpoints. A third-party
    // share intent (linkedin share-offsite?url=, x.com/intent/tweet?url=) is not.
    const pageHost = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const links = parsedPage.querySelectorAll('a[href]');
    const seenHrefs = new Set<string>();
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      try {
        const linkUrl = new URL(href, url);
        if (linkUrl.hostname.replace(/^www\./, '') !== pageHost) continue;
        if (seenHrefs.has(linkUrl.href)) continue;
        seenHrefs.add(linkUrl.href);
        for (const [param, value] of linkUrl.searchParams.entries()) {
          if (this.isRedirectParam(param) && this.isUrlLikeValue(value)) {
            info.suspiciousLinks.push({ href: href.substring(0, 200), param });
            break; // One finding per link is enough
          }
        }
      } catch {
        // Skip invalid URLs
      }
    }

    if (info.suspiciousParams.length > 0) {
      warnings.push({
        message: 'Potential open redirect in page URL parameters',
        detail: `Page URL contains ${info.suspiciousParams.length} parameter(s) with redirect-like names and URL values: ${info.suspiciousParams.map((p) => p.param).join(', ')}. Verify server-side validation prevents redirection to arbitrary domains.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.suspiciousLinks.length > 3) {
      warnings.push({
        message: 'Links with potential open redirect parameters',
        detail: `${info.suspiciousLinks.length} links contain URL parameters that may control redirects (${[...new Set(info.suspiciousLinks.map((l) => l.param))].slice(0, 5).join(', ')}). Ensure server-side redirect validation is in place.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  private static isRedirectParam(param: string): boolean {
    const lower = param.toLowerCase();
    return REDIRECT_PARAMS.some((rp) => lower === rp || lower.endsWith('_' + rp) || lower.endsWith(rp));
  }

  private static isUrlLikeValue(value: string): boolean {
    if (!value) return false;
    // Check if value looks like a URL
    return (
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('//') ||
      value.startsWith('/') ||
      /^[a-z]+:\/\//i.test(value)
    );
  }
}

export { OpenRedirectAnalyzer };
