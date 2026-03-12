import type { ChromePage, ParsedPage } from '../../types';

class SecurityAnalyzer {
  static async analyzeSecurity(
    chromePage: ChromePage,
    parsedPage: ParsedPage,
    url: string,
    responseHeaders: Record<string, string> = {},
  ) {
    const securityIssues = {
      missingHeaders: [],
      insecureCookies: 0,
      insecureCookieDetails: [], // Track details for reporting
      mixedContent: 0,
      formsWithoutCSRF: 0,
      inlineScripts: 0,
      securityScore: 0,
    };

    const isHttps = url.startsWith('https://');

    // 1. Check security headers (use pre-captured headers to avoid navigation)
    const headers = responseHeaders || {};

    const securityHeaders = {
      'content-security-policy': 'Content-Security-Policy',
      'x-frame-options': 'X-Frame-Options',
      'x-content-type-options': 'X-Content-Type-Options',
      'strict-transport-security': 'Strict-Transport-Security',
      'referrer-policy': 'Referrer-Policy',
    };

    for (const [header, name] of Object.entries(securityHeaders)) {
      if (!headers[header] && !headers[header.toLowerCase()]) {
        (securityIssues.missingHeaders as string[]).push(name);
      }
    }

    // 2. Check cookies for security attributes
    // Use a Set to track unique insecure cookies (by name+domain) to avoid double-counting
    const insecureCookieSet = new Set();
    const cookies = await chromePage.context().cookies();

    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}@${cookie.domain}`;
      const issues = [];

      // Check secure flag on HTTPS sites
      if (isHttps && !cookie.secure) {
        issues.push('missing Secure flag');
      }

      // Check HttpOnly for session/auth cookies
      const isSensitiveCookie =
        cookie.name.toLowerCase().includes('session') ||
        cookie.name.toLowerCase().includes('auth') ||
        cookie.name.toLowerCase().includes('token');
      if (!cookie.httpOnly && isSensitiveCookie) {
        issues.push('missing HttpOnly flag on sensitive cookie');
      }

      // Count each cookie only once, even if it has multiple issues
      if (issues.length > 0 && !insecureCookieSet.has(cookieKey)) {
        insecureCookieSet.add(cookieKey);
        securityIssues.insecureCookies++;
        // Store first 10 details for reporting
        if (securityIssues.insecureCookieDetails.length < 10) {
          (securityIssues.insecureCookieDetails as Record<string, any>[]).push({
            name: cookie.name,
            domain: cookie.domain,
            issues: issues,
          });
        }
      }
    }

    // 3. Check for mixed content (HTTP resources on HTTPS page)
    if (isHttps) {
      const allResources = parsedPage.querySelectorAll('script[src], link[href], img[src], iframe[src]');
      for (const resource of allResources) {
        const src = resource.getAttribute('src') || resource.getAttribute('href');
        if (src && src.startsWith('http://')) {
          securityIssues.mixedContent++;
        }
      }
    }

    // 4. Check forms for CSRF protection
    const forms = parsedPage.querySelectorAll('form');
    for (const form of forms) {
      const method = form.getAttribute('method')?.toLowerCase();
      if (method === 'post') {
        // Check for CSRF token (common patterns)
        const hasCSRFToken = Array.from(form.querySelectorAll('input')).some((input: any) => {
          const name = input.getAttribute('name')?.toLowerCase() || '';
          return name.includes('csrf') || name.includes('token') || name.includes('_token');
        });
        if (!hasCSRFToken) {
          securityIssues.formsWithoutCSRF++;
        }
      }
    }

    // 5. Check for inline scripts (XSS risk)
    const inlineScripts = parsedPage.querySelectorAll('script:not([src])');
    securityIssues.inlineScripts = inlineScripts.length;

    // Calculate security score (0-100)
    let score = 100;
    score -= securityIssues.missingHeaders.length * 10; // -10 per missing header
    score -= securityIssues.insecureCookies * 5; // -5 per insecure cookie
    score -= securityIssues.mixedContent * 3; // -3 per mixed content
    score -= securityIssues.formsWithoutCSRF * 8; // -8 per form without CSRF
    score -= Math.min(securityIssues.inlineScripts, 10) * 2; // -2 per inline script (max 10)
    securityIssues.securityScore = Math.max(0, score);

    return securityIssues;
  }
}

export { SecurityAnalyzer };
