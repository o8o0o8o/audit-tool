class SecurityAnalyzer {
  static async analyzeSecurity(chromePage, parsedPage, url) {
    const securityIssues = {
      missingHeaders: [],
      insecureCookies: 0,
      mixedContent: 0,
      formsWithoutCSRF: 0,
      inlineScripts: 0,
      securityScore: 0,
    };

    const isHttps = url.startsWith('https://');

    // 1. Check security headers
    let response = chromePage.response;
    if (!response) {
      try {
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        console.log(`Failed to get response for security check at ${url}:`, error.message);
        return securityIssues; // Return empty security data
      }
    }
    const headers = await response?.headers() || {};

    const securityHeaders = {
      'content-security-policy': 'Content-Security-Policy',
      'x-frame-options': 'X-Frame-Options',
      'x-content-type-options': 'X-Content-Type-Options',
      'strict-transport-security': 'Strict-Transport-Security',
      'referrer-policy': 'Referrer-Policy',
    };

    for (const [header, name] of Object.entries(securityHeaders)) {
      if (!headers[header] && !headers[header.toLowerCase()]) {
        securityIssues.missingHeaders.push(name);
      }
    }

    // 2. Check cookies for security attributes
    const cookies = await chromePage.context().cookies();
    for (const cookie of cookies) {
      if (isHttps && !cookie.secure) {
        securityIssues.insecureCookies++;
      }
      if (!cookie.httpOnly && (cookie.name.toLowerCase().includes('session') || cookie.name.toLowerCase().includes('auth'))) {
        securityIssues.insecureCookies++;
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
        const hasCSRFToken = form.querySelectorAll('input').some(input => {
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

module.exports = { SecurityAnalyzer };
