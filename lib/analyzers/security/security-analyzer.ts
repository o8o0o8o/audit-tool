import { getHeader } from '../../utils';
import type { ChromePage, ParsedPage } from '../../types';

interface InsecureCookieDetail {
  name: string;
  domain: string;
  issues: string[];
  sameSite?: string;
}

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
      sameSiteIssues: 0,
      mixedContent: 0,
      formsWithoutCSRF: 0,
      inlineScripts: 0,
      securityScore: 0,
    };

    const isHttps = url.startsWith('https://');

    // 1. Check security headers (use pre-captured headers to avoid navigation).
    // Per-header deduction values follow Mozilla HTTP Observatory's published rubric:
    // https://github.com/mozilla/http-observatory/blob/main/httpobs/docs/scoring.md
    const headers = responseHeaders || {};

    const securityHeaderDeductions: Array<{ header: string; name: string; deduction: number }> = [
      { header: 'content-security-policy', name: 'Content-Security-Policy', deduction: 25 },
      { header: 'strict-transport-security', name: 'Strict-Transport-Security', deduction: 20 },
      { header: 'x-frame-options', name: 'X-Frame-Options', deduction: 20 },
      { header: 'referrer-policy', name: 'Referrer-Policy', deduction: 5 },
      { header: 'x-content-type-options', name: 'X-Content-Type-Options', deduction: 5 },
    ];

    let headerDeductionTotal = 0;
    for (const { header, name, deduction } of securityHeaderDeductions) {
      if (!getHeader(headers, header)) {
        (securityIssues.missingHeaders as string[]).push(name);
        headerDeductionTotal += deduction;
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

      // Check SameSite attribute
      const sameSite = cookie.sameSite || 'None';
      if (sameSite === 'None' && !cookie.secure) {
        issues.push('SameSite=None without Secure flag (cookie will be rejected by browsers)');
        securityIssues.sameSiteIssues++;
      } else if (sameSite === 'None' && isSensitiveCookie) {
        issues.push('Sensitive cookie with SameSite=None (vulnerable to CSRF)');
        securityIssues.sameSiteIssues++;
      }

      // Count each cookie only once, even if it has multiple issues
      if (issues.length > 0 && !insecureCookieSet.has(cookieKey)) {
        insecureCookieSet.add(cookieKey);
        securityIssues.insecureCookies++;
        // Store first 10 details for reporting
        if (securityIssues.insecureCookieDetails.length < 10) {
          (securityIssues.insecureCookieDetails as InsecureCookieDetail[]).push({
            name: cookie.name,
            domain: cookie.domain,
            issues: issues,
            sameSite: sameSite,
          });
        }
      }
    }

    // 3. Check for mixed content (HTTP resources on HTTPS page)
    if (isHttps) {
      const allResources = parsedPage.querySelectorAll('script[src], link[href], img[src], iframe[src]');
      for (const resource of allResources) {
        const src = resource.getAttribute('src') ?? resource.getAttribute('href');
        if (src?.startsWith('http://')) {
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
        const hasCSRFToken = Array.from(form.querySelectorAll('input')).some((input) => {
          const name = input.getAttribute('name')?.toLowerCase() ?? '';
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

    // Calculate security score (0-100) using Mozilla HTTP Observatory deductions.
    // Per-header deduction is summed above; cookies/mixed-content/CSRF follow the
    // same rubric. Inline scripts are kept as a soft signal (Observatory doesn't
    // score them directly).
    let score = 100;
    score -= isHttps ? 0 : 50; // Observatory: HTTPS not in use → severe penalty
    score -= headerDeductionTotal;
    score -= Math.min(securityIssues.mixedContent, 1) * 20; // any mixed content → -20
    score -= securityIssues.insecureCookies * 5;
    score -= securityIssues.sameSiteIssues * 10; // SameSite=None+sensitive or without Secure
    score -= securityIssues.formsWithoutCSRF * 5;
    score -= Math.min(securityIssues.inlineScripts, 10) * 2;
    securityIssues.securityScore = Math.max(0, score);

    return securityIssues;
  }
}

export { SecurityAnalyzer };
