/**
 * Cookie Consent / GDPR Analyzer
 * Checks for cookie consent implementation and basic compliance patterns
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage, PageInfo, ConsentData, NetworkRequest } from '../../types';

interface CookieInfo {
  name: string;
  domain: string;
  isThirdParty: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expires: number;
}

interface ConsentBannerDetection {
  detected: boolean;
  platform: string | null;
  method: string | null;
}

interface PolicyLinks {
  hasPrivacyPolicy: boolean;
  hasCookiePolicy: boolean;
  links: { type: string; href: string }[];
}

class CookieConsentAnalyzer {
  // Common cookie consent platforms
  static #consentPlatforms = [
    { name: 'OneTrust', patterns: ['onetrust', 'optanon', 'cookiepro'] },
    { name: 'CookieBot', patterns: ['cookiebot', 'cookieconsent'] },
    { name: 'TrustArc', patterns: ['trustarc', 'truste', 'consent.trustarc'] },
    { name: 'Quantcast', patterns: ['quantcast', '__cmpapi'] },
    { name: 'CookieYes', patterns: ['cookieyes', 'cookie-law-info'] },
    { name: 'GDPR Cookie Consent', patterns: ['gdpr-cookie-consent', 'moove_gdpr'] },
    { name: 'Osano', patterns: ['osano'] },
    { name: 'Termly', patterns: ['termly'] },
    { name: 'iubenda', patterns: ['iubenda'] },
    { name: 'Usercentrics', patterns: ['usercentrics'] },
    { name: 'Didomi', patterns: ['didomi'] },
    { name: 'Cookie Notice', patterns: ['cookie-notice', 'cn-'] },
    { name: 'EU Cookie Law', patterns: ['eu-cookie-law'] },
  ];

  // Common cookie types that require consent
  static #trackingCookiePatterns = [
    '_ga',
    '_gid',
    '_gat', // Google Analytics
    'fbp',
    '_fbp',
    'fr', // Facebook
    '__hssc',
    '__hstc',
    'hubspot', // HubSpot
    '_hjid',
    '_hjSession', // Hotjar
    '_clck',
    '_clsk', // Microsoft Clarity
    'intercom', // Intercom
    '_gcl', // Google Ads
    'NID',
    'IDE', // Google DoubleClick
  ];

  /**
   * Analyze cookie consent implementation
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {Object} requests - Network requests
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, requests: NetworkRequest[], url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const consentData: ConsentData & { policyLinks?: { type: string; href: string }[]; cookies?: CookieInfo[] } = {
      hasConsentBanner: false,
      consentPlatform: null,
      hasCookiePolicy: false,
      hasPrivacyPolicy: false,
      cookiesBeforeConsent: [],
      trackingBeforeConsent: [],
      totalCookies: 0,
      thirdPartyCookies: 0,
      bannerDetectionMethod: null,
    };

    // 1. Check for consent banner/platform
    const consentDetection = await this.#detectConsentBanner(chromePage, parsedPage, requests);
    consentData.hasConsentBanner = consentDetection.detected;
    consentData.consentPlatform = consentDetection.platform;
    consentData.bannerDetectionMethod = consentDetection.method;

    // 2. Check for privacy/cookie policy links
    const policyLinks = this.#findPolicyLinks(parsedPage);
    consentData.hasCookiePolicy = policyLinks.hasCookiePolicy;
    consentData.hasPrivacyPolicy = policyLinks.hasPrivacyPolicy;
    consentData.policyLinks = policyLinks.links;

    // 3. Analyze cookies set on page load
    const cookieAnalysis = await this.#analyzeCookies(chromePage);
    consentData.totalCookies = cookieAnalysis.total;
    consentData.thirdPartyCookies = cookieAnalysis.thirdParty;
    consentData.cookies = cookieAnalysis.cookies;

    // 4. Check for tracking scripts before consent
    const trackingAnalysis = this.#analyzeTrackingBeforeConsent(requests, consentData.hasConsentBanner);
    consentData.trackingBeforeConsent = trackingAnalysis.trackingScripts;

    // 5. Check for tracking cookies before consent
    const trackingCookies = this.#checkTrackingCookies(cookieAnalysis.cookies);
    consentData.cookiesBeforeConsent = trackingCookies;

    // Generate issues

    // No consent banner but has tracking
    if (!consentData.hasConsentBanner && trackingCookies.length > 0) {
      issues.push({
        message: 'Tracking cookies without consent banner',
        detail: `<a href="${url}">${url}</a> sets tracking cookies (${trackingCookies.slice(0, 3).join(', ')}) without visible consent mechanism. This may violate GDPR/CCPA.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Has consent banner but cookies set before interaction
    if (consentData.hasConsentBanner && trackingCookies.length > 3) {
      warnings.push({
        message: 'Multiple tracking cookies set before consent',
        detail: `<a href="${url}">${url}</a> sets ${trackingCookies.length} tracking cookies before user consents. Verify consent-first implementation.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Missing privacy policy
    if (!consentData.hasPrivacyPolicy) {
      warnings.push({
        message: 'No privacy policy link found',
        detail: `<a href="${url}">${url}</a> has no visible privacy policy link. Required for GDPR/CCPA compliance.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Third-party cookies without consent
    if (consentData.thirdPartyCookies > 0 && !consentData.hasConsentBanner) {
      warnings.push({
        message: 'Third-party cookies without consent',
        detail: `<a href="${url}">${url}</a> has ${consentData.thirdPartyCookies} third-party cookie(s) without a consent mechanism.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Consent banner detected but possibly not compliant
    if (consentData.hasConsentBanner && !consentData.consentPlatform) {
      warnings.push({
        message: 'Custom consent implementation detected',
        detail: `<a href="${url}">${url}</a> has a cookie banner but doesn't use a recognized consent platform. Verify it meets compliance requirements (reject option, granular control).`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, consentData };
  }

  /**
   * Detect consent banner
   * @private
   */
  static async #detectConsentBanner(
    chromePage: ChromePage,
    parsedPage: ParsedPage,
    requests: NetworkRequest[],
  ): Promise<ConsentBannerDetection> {
    const result: ConsentBannerDetection = {
      detected: false,
      platform: null,
      method: null,
    };

    // Method 1: Check for known consent platform scripts/styles
    for (const req of requests) {
      for (const platform of this.#consentPlatforms) {
        if (platform.patterns.some((p) => req.url.toLowerCase().includes(p))) {
          result.detected = true;
          result.platform = platform.name;
          result.method = 'script-detection';
          return result;
        }
      }
    }

    // Method 2: Check HTML for consent-related elements
    const html = parsedPage.toString().toLowerCase();
    for (const platform of this.#consentPlatforms) {
      if (platform.patterns.some((p) => html.includes(p))) {
        result.detected = true;
        result.platform = platform.name;
        result.method = 'html-detection';
        return result;
      }
    }

    // Method 3: Check for generic cookie banner patterns
    const bannerSelectors = [
      '[class*="cookie-banner"]',
      '[class*="cookie-consent"]',
      '[class*="gdpr"]',
      '[class*="privacy-banner"]',
      '[id*="cookie"]',
      '[id*="consent"]',
      '[class*="cc-window"]',
      '[class*="cky-consent"]',
    ];

    for (const selector of bannerSelectors) {
      try {
        if (parsedPage.querySelector(selector)) {
          result.detected = true;
          result.method = 'generic-banner';
          return result;
        }
      } catch {
        // Invalid selector
      }
    }

    // Method 4: Check for visible banner via Playwright
    try {
      const hasBanner = await chromePage.evaluate(() => {
        const keywords = ['cookie', 'consent', 'privacy', 'gdpr', 'accept all', 'reject all'];
        const elements = document.querySelectorAll('div, aside, section');

        for (const el of elements) {
          const style = getComputedStyle(el);
          // Check if visible and fixed/sticky (common for banners)
          if (style.position === 'fixed' || style.position === 'sticky') {
            const text = el.textContent.toLowerCase();
            if (keywords.some((k) => text.includes(k)) && text.length < 2000) {
              return true;
            }
          }
        }
        return false;
      });

      if (hasBanner) {
        result.detected = true;
        result.method = 'visual-detection';
      }
    } catch {
      // Evaluation failed
    }

    return result;
  }

  /**
   * Find privacy/cookie policy links
   * @private
   */
  static #findPolicyLinks(parsedPage: ParsedPage): PolicyLinks {
    const result: PolicyLinks = {
      hasPrivacyPolicy: false,
      hasCookiePolicy: false,
      links: [],
    };

    const links = parsedPage.querySelectorAll('a');

    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const text = link.textContent.toLowerCase();

      if (text.includes('privacy') || href.includes('privacy')) {
        result.hasPrivacyPolicy = true;
        result.links.push({ type: 'privacy', href });
      }

      if (text.includes('cookie') || href.includes('cookie')) {
        result.hasCookiePolicy = true;
        result.links.push({ type: 'cookie', href });
      }
    }

    return result;
  }

  /**
   * Analyze cookies
   * @private
   */
  static async #analyzeCookies(chromePage: ChromePage) {
    try {
      const cookies = await chromePage.context().cookies();

      let thirdParty = 0;
      const pageHost = new URL(chromePage.url()).hostname;

      const cookieList = cookies.map((cookie) => {
        const isThirdParty = !cookie.domain.includes(pageHost) && !pageHost.includes(cookie.domain.replace(/^\./, ''));
        if (isThirdParty) thirdParty++;

        return {
          name: cookie.name,
          domain: cookie.domain,
          isThirdParty,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expires: cookie.expires,
        };
      });

      return {
        total: cookies.length,
        thirdParty,
        cookies: cookieList,
      };
    } catch {
      return { total: 0, thirdParty: 0, cookies: [] };
    }
  }

  /**
   * Check for tracking cookies
   * @private
   */
  static #checkTrackingCookies(cookies: CookieInfo[]) {
    const trackingCookies = [];

    for (const cookie of cookies) {
      for (const pattern of this.#trackingCookiePatterns) {
        if (cookie.name.toLowerCase().includes(pattern.toLowerCase())) {
          trackingCookies.push(cookie.name);
          break;
        }
      }
    }

    return trackingCookies;
  }

  /**
   * Analyze tracking before consent
   * @private
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- requests may be NetworkRequest[] or Record<string, unknown>
  static #analyzeTrackingBeforeConsent(requests: Record<string, any>, _hasConsent: boolean) {
    const trackingScripts = [];

    const trackingDomains = [
      'google-analytics.com',
      'googletagmanager.com',
      'facebook.net',
      'hotjar.com',
      'clarity.ms',
      'segment.com',
      'mixpanel.com',
    ];

    for (const [reqUrl] of Object.entries(requests)) {
      for (const domain of trackingDomains) {
        if (reqUrl.includes(domain)) {
          trackingScripts.push(domain);
          break;
        }
      }
    }

    return { trackingScripts: [...new Set(trackingScripts)] };
  }

  /**
   * Site-wide cookie consent analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithConsent = 0;
    let pagesWithoutPrivacyPolicy = 0;
    const platformsUsed = new Set();

    for (const [_url, page] of Object.entries(pages)) {
      if (page.consentData) {
        if (page.consentData.hasConsentBanner) {
          pagesWithConsent++;
          if (page.consentData.consentPlatform) {
            platformsUsed.add(page.consentData.consentPlatform);
          }
        }

        if (!page.consentData.hasPrivacyPolicy) {
          pagesWithoutPrivacyPolicy++;
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    // Inconsistent consent implementation
    if (pagesWithConsent > 0 && pagesWithConsent < totalPages) {
      warnings.push({
        message: 'Inconsistent cookie consent implementation',
        detail: `Only ${pagesWithConsent} of ${totalPages} pages have a consent banner. Ensure consistent implementation site-wide.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Multiple consent platforms (unusual)
    if (platformsUsed.size > 1) {
      warnings.push({
        message: 'Multiple consent platforms detected',
        detail: `Found ${platformsUsed.size} different consent platforms: ${Array.from(platformsUsed).join(', ')}. Consider standardizing.`,
        severity: SEVERITY.LOW,
      });
    }

    // No privacy policy on many pages
    if (pagesWithoutPrivacyPolicy > totalPages * 0.5) {
      warnings.push({
        message: 'Many pages lack privacy policy link',
        detail: `${pagesWithoutPrivacyPolicy} of ${totalPages} pages have no visible privacy policy link.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { CookieConsentAnalyzer };
