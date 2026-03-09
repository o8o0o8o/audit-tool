/**
 * CTA Detector Analyzer
 * Detects conversion elements on pages: forms, buttons, phone links, email links
 * Results feed into AboveFoldAnalyzer which already expects pageData.ctas
 */

const { SEVERITY } = require('../../constants');

class CTADetectorAnalyzer {
  /**
   * Detect CTAs and conversion elements on the page
   * @param {object} chromePage - Playwright page object
   * @param {object} parsedPage - Parsed HTML
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static async analyzeCTAs(chromePage, parsedPage, url) {
    const issues = [];
    const warnings = [];

    const ctas = await chromePage.evaluate(() => {
      const results = [];
      const viewport = { width: window.innerWidth, height: window.innerHeight };

      // Detect forms
      const forms = document.querySelectorAll('form');
      forms.forEach(form => {
        const rect = form.getBoundingClientRect();
        const action = form.getAttribute('action') || '';
        const method = (form.getAttribute('method') || 'get').toLowerCase();
        const inputs = form.querySelectorAll('input, textarea, select');
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');

        results.push({
          type: 'form',
          text: submitBtn?.textContent?.trim() || 'Submit',
          action,
          method,
          inputCount: inputs.length,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          aboveFold: rect.top < viewport.height,
        });
      });

      // Detect buttons with CTA text patterns
      const ctaPatterns = /\b(buy|order|subscribe|sign\s*up|register|get\s+started|try|download|contact|book|schedule|request|start|join|add\s+to\s+cart|checkout|donate|apply|enroll)\b/i;

      const buttons = document.querySelectorAll('button, [role="button"], a.btn, a.button, .cta, [class*="cta"], input[type="submit"]');
      buttons.forEach(btn => {
        // Skip buttons inside forms (already counted)
        if (btn.closest('form') && btn.tagName !== 'A') return;

        const text = (btn.textContent || btn.value || '').trim();
        if (!text || text.length > 100) return;

        const rect = btn.getBoundingClientRect();
        const isCTA = ctaPatterns.test(text);
        const href = btn.getAttribute('href') || '';

        results.push({
          type: isCTA ? 'cta-button' : 'button',
          text: text.substring(0, 80),
          href,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          aboveFold: rect.top < viewport.height,
        });
      });

      // Detect phone links
      const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
      phoneLinks.forEach(link => {
        const rect = link.getBoundingClientRect();
        results.push({
          type: 'phone',
          text: link.textContent?.trim().substring(0, 50) || '',
          href: link.getAttribute('href'),
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          aboveFold: rect.top < viewport.height,
        });
      });

      // Detect email links
      const emailLinks = document.querySelectorAll('a[href^="mailto:"]');
      emailLinks.forEach(link => {
        const rect = link.getBoundingClientRect();
        results.push({
          type: 'email',
          text: link.textContent?.trim().substring(0, 50) || '',
          href: link.getAttribute('href'),
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          aboveFold: rect.top < viewport.height,
        });
      });

      return results;
    });

    // Analyze findings
    const formCount = ctas.filter(c => c.type === 'form').length;
    const ctaButtonCount = ctas.filter(c => c.type === 'cta-button').length;
    const phoneCount = ctas.filter(c => c.type === 'phone').length;
    const emailCount = ctas.filter(c => c.type === 'email').length;
    const aboveFoldCTAs = ctas.filter(c => c.aboveFold && (c.type === 'cta-button' || c.type === 'form'));

    // No CTA above the fold
    if (aboveFoldCTAs.length === 0 && ctas.length > 0) {
      warnings.push({
        message: 'No conversion elements above the fold',
        detail: `<a href="${url}">${url}</a> has ${ctas.length} conversion element(s) but none are visible without scrolling.`,
        severity: SEVERITY.LOW,
      });
    }

    // No conversion elements at all (for non-blog/article pages this may be an issue)
    if (formCount === 0 && ctaButtonCount === 0 && phoneCount === 0 && emailCount === 0) {
      warnings.push({
        message: 'Page has no detectable conversion elements',
        detail: `<a href="${url}">${url}</a> has no forms, CTA buttons, phone links, or email links.`,
        severity: SEVERITY.LOW,
      });
    }

    return {
      ctas,
      summary: {
        total: ctas.length,
        forms: formCount,
        ctaButtons: ctaButtonCount,
        buttons: ctas.filter(c => c.type === 'button').length,
        phoneLinks: phoneCount,
        emailLinks: emailCount,
        aboveFoldCount: aboveFoldCTAs.length,
      },
      issues,
      warnings,
    };
  }

  /**
   * Site-wide CTA analysis
   * @param {object} allPages - All page data
   * @returns {object} Site-wide analysis results
   */
  static analyzeSiteWide(allPages) {
    const issues = [];
    const warnings = [];
    const pages = Object.values(allPages);

    let pagesWithoutCTAs = 0;
    let pagesWithForms = 0;
    let pagesWithPhoneLinks = 0;
    let totalCTAs = 0;

    for (const page of pages) {
      const ctaData = page.ctaData;
      if (!ctaData?.summary) continue;

      totalCTAs += ctaData.summary.total;
      if (ctaData.summary.total === 0) pagesWithoutCTAs++;
      if (ctaData.summary.forms > 0) pagesWithForms++;
      if (ctaData.summary.phoneLinks > 0) pagesWithPhoneLinks++;
    }

    if (pagesWithoutCTAs > pages.length * 0.5 && pages.length > 5) {
      warnings.push({
        title: `${pagesWithoutCTAs} of ${pages.length} pages have no conversion elements`,
        description: `Over half of the pages lack forms, CTA buttons, or contact links. Consider adding conversion paths where appropriate.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }
}

module.exports = { CTADetectorAnalyzer };
