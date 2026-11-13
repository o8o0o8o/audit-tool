import { detectImportantPageLinks } from '../../utils';
import type { ChromePage, ParsedPage } from '../../types';
import { consentMarkupIdentifiers } from '../security/cookie-consent-analyzer';

class AnalyticsTrackingAnalyzer {
  static async analyzeAnalyticsTracking(chromePage: ChromePage, parsedPage: ParsedPage, _url: string) {
    const analyticsData = {
      hasGA4: false,
      hasUniversalAnalytics: false,
      hasGTM: false,
      hasFacebookPixel: false,
      hasLinkedInTag: false,
      hasTwitterPixel: false,
      hasTikTokPixel: false,
      hasPinterestTag: false,
      hasHotjar: false,
      hasMicrosoftClarity: false,
      trackingIds: {
        ga4: [] as string[],
        ua: [] as string[],
        gtm: [] as string[],
        fbPixel: [] as string[],
        linkedIn: [] as string[],
        twitter: [] as string[],
        tiktok: [] as string[],
        pinterest: [] as string[],
        hotjar: [] as string[],
        clarity: [] as string[],
      },
      hasCookieConsent: false,
      consentTool: null as string | null,
      hasPrivacyPolicy: false,
      issues: [] as string[],
      warnings: [] as string[],
    };

    // Get page HTML content
    const htmlContent = parsedPage.toString();

    // 1. Check for Google Analytics 4 (GA4)
    const ga4Matches = htmlContent.match(/G-[A-Z0-9]{10,}/g);
    if (ga4Matches) {
      analyticsData.hasGA4 = true;
      analyticsData.trackingIds.ga4 = [...new Set(ga4Matches)];

      if (analyticsData.trackingIds.ga4.length > 1) {
        analyticsData.warnings.push(`Multiple GA4 measurement IDs found: ${analyticsData.trackingIds.ga4.join(', ')}`);
      }
    }

    // Check for gtag.js script
    const hasGtagScript = parsedPage.querySelector('script[src*="googletagmanager.com/gtag/js"]');
    if (hasGtagScript && !analyticsData.hasGA4) {
      analyticsData.warnings.push('gtag.js script loaded but no GA4 measurement ID found');
    }

    // 2. Check for Universal Analytics (legacy)
    const uaMatches = htmlContent.match(/UA-\d{4,10}-\d{1,4}/g);
    if (uaMatches) {
      analyticsData.hasUniversalAnalytics = true;
      analyticsData.trackingIds.ua = [...new Set(uaMatches)];
      analyticsData.warnings.push(
        'Using legacy Universal Analytics (UA). UA was sunset in July 2024 — migrate to GA4 immediately',
      );

      if (analyticsData.trackingIds.ua.length > 1) {
        analyticsData.warnings.push(`Multiple UA tracking IDs found: ${analyticsData.trackingIds.ua.join(', ')}`);
      }
    }

    // Check for analytics.js or ga.js
    const hasAnalyticsJs =
      parsedPage.querySelector('script[src*="google-analytics.com/analytics.js"]') ??
      parsedPage.querySelector('script[src*="google-analytics.com/ga.js"]');
    if (hasAnalyticsJs && !analyticsData.hasUniversalAnalytics) {
      analyticsData.warnings.push('Google Analytics script loaded but no UA tracking ID found');
    }

    // 3. Check for Google Tag Manager
    const gtmMatches = htmlContent.match(/GTM-[A-Z0-9]{6,}/g);
    if (gtmMatches) {
      analyticsData.hasGTM = true;
      analyticsData.trackingIds.gtm = [...new Set(gtmMatches)];

      if (analyticsData.trackingIds.gtm.length > 1) {
        analyticsData.warnings.push(`Multiple GTM containers found: ${analyticsData.trackingIds.gtm.join(', ')}`);
      }
    }

    // Check GTM placement - should have both <head> and <body> snippets
    if (analyticsData.hasGTM) {
      const gtmHeadScript = parsedPage.querySelector('script[src*="googletagmanager.com/gtm.js"]');
      const gtmBodyNoscript = parsedPage.querySelector('noscript iframe[src*="googletagmanager.com/ns.html"]');

      if (!gtmHeadScript) {
        analyticsData.issues.push('GTM container ID found but missing <head> script snippet');
      }
      if (!gtmBodyNoscript) {
        analyticsData.warnings.push('GTM missing <body> noscript fallback snippet');
      }
    }

    // 4. Check for Facebook/Meta Pixel
    const fbPixelMatches = htmlContent.match(/fbq\s*\(\s*['"]init['"],\s*['"](\d{15,16})['"]/);
    if (fbPixelMatches || htmlContent.includes('connect.facebook.net/en_US/fbevents.js')) {
      analyticsData.hasFacebookPixel = true;
      if (fbPixelMatches) {
        analyticsData.trackingIds.fbPixel.push(fbPixelMatches[1]);
      }
    }

    // 5. Check for LinkedIn Insight Tag
    const linkedInMatches = htmlContent.match(/_linkedin_partner_id\s*=\s*['"](\d+)['"]/);
    if (linkedInMatches || htmlContent.includes('snap.licdn.com/li.lms-analytics/insight.min.js')) {
      analyticsData.hasLinkedInTag = true;
      if (linkedInMatches) {
        analyticsData.trackingIds.linkedIn.push(linkedInMatches[1]);
      }
    }

    // 6. Check for Twitter/X Pixel
    if (htmlContent.includes('twq(') || htmlContent.includes('static.ads-twitter.com/uwt.js')) {
      analyticsData.hasTwitterPixel = true;
      const twitterIdMatches = htmlContent.match(/twq\s*\(\s*['"]init['"],\s*['"]([a-z0-9]+)['"]/);
      if (twitterIdMatches) {
        analyticsData.trackingIds.twitter.push(twitterIdMatches[1]);
      }
    }

    // 7. Check for TikTok Pixel
    if (htmlContent.includes('ttq.') || htmlContent.includes('analytics.tiktok.com')) {
      analyticsData.hasTikTokPixel = true;
      const tiktokIdMatches = htmlContent.match(/ttq\.load\s*\(\s*['"]([A-Z0-9]+)['"]/);
      if (tiktokIdMatches) {
        analyticsData.trackingIds.tiktok.push(tiktokIdMatches[1]);
      }
    }

    // 8. Check for Pinterest Tag
    if (htmlContent.includes('pintrk(') || htmlContent.includes('s.pinimg.com/ct/core.js')) {
      analyticsData.hasPinterestTag = true;
      const pinterestIdMatches = htmlContent.match(/pintrk\s*\(\s*['"]load['"],\s*['"](\d+)['"]/);
      if (pinterestIdMatches) {
        analyticsData.trackingIds.pinterest.push(pinterestIdMatches[1]);
      }
    }

    // 9. Check for Hotjar
    if (htmlContent.includes('hj(') || htmlContent.match(/static\.hotjar\.com\/c\/hotjar-(\d+)\.js/)) {
      analyticsData.hasHotjar = true;
      const hotjarIdMatches = htmlContent.match(/hjid:\s*(\d+)/);
      if (hotjarIdMatches) {
        analyticsData.trackingIds.hotjar.push(hotjarIdMatches[1]);
      }
    }

    // 10. Check for Microsoft Clarity
    if (htmlContent.includes('clarity(') || htmlContent.includes('clarity.ms/tag/')) {
      analyticsData.hasMicrosoftClarity = true;
      const clarityIdMatches = htmlContent.match(/clarity\.ms\/tag\/([a-z0-9]+)/i);
      if (clarityIdMatches) {
        analyticsData.trackingIds.clarity.push(clarityIdMatches[1]);
      }
    }

    // 11. Check for Cookie Consent Tools
    const consentTools = [
      { name: 'OneTrust', patterns: ['cdn.cookielaw.org', 'optanon.blob.core.windows.net'] },
      { name: 'Cookiebot', patterns: ['consent.cookiebot.com'] },
      { name: 'Cookie Consent', patterns: ['cookieconsent.'] },
      { name: 'Osano', patterns: ['cmp.osano.com'] },
      { name: 'Iubenda', patterns: ['cdn.iubenda.com'] },
      { name: 'TrustArc', patterns: ['consent.trustarc.com'] },
      { name: 'Didomi', patterns: ['sdk.privacy-center.org'] },
      { name: 'Termly', patterns: ['app.termly.io/embed'] },
    ];

    // Script URLs, ids and classes only: an article about cookie consent (or quoting a CMP's
    // script tag in a code sample) is not a consent implementation.
    const consentMarkup = consentMarkupIdentifiers(parsedPage);
    for (const tool of consentTools) {
      const hasConsentTool = tool.patterns.some((pattern) => consentMarkup.includes(pattern));
      if (hasConsentTool) {
        analyticsData.hasCookieConsent = true;
        analyticsData.consentTool = tool.name;
        break;
      }
    }

    // Check for generic cookie consent patterns
    if (!analyticsData.hasCookieConsent) {
      const genericConsentPatterns = [/cookie.?consent/i, /gdpr.?consent/i, /cookie.?banner/i, /consent.?banner/i];

      for (const pattern of genericConsentPatterns) {
        if (consentMarkup.split('\n').some((v) => pattern.test(v))) {
          analyticsData.hasCookieConsent = true;
          analyticsData.consentTool = 'Custom/Unknown';
          break;
        }
      }
    }

    // 12. Check for Privacy Policy link (uses shared utility)
    const importantLinks = detectImportantPageLinks(parsedPage);
    if (importantLinks.hasPrivacyPolicy) {
      analyticsData.hasPrivacyPolicy = true;
    }

    // Validation: Check if analytics are present but no cookie consent
    const hasAnyTracking =
      analyticsData.hasGA4 ||
      analyticsData.hasUniversalAnalytics ||
      analyticsData.hasGTM ||
      analyticsData.hasFacebookPixel ||
      analyticsData.hasLinkedInTag ||
      analyticsData.hasTwitterPixel ||
      analyticsData.hasTikTokPixel ||
      analyticsData.hasPinterestTag;

    if (hasAnyTracking && !analyticsData.hasCookieConsent) {
      analyticsData.issues.push(
        'Tracking scripts detected but no cookie consent mechanism found (GDPR/CCPA compliance issue)',
      );
    }

    if (hasAnyTracking && !analyticsData.hasPrivacyPolicy) {
      analyticsData.warnings.push('Tracking scripts detected but no privacy policy link found');
    }

    // Validation: Check if no analytics at all
    if (!hasAnyTracking) {
      analyticsData.warnings.push('No analytics or tracking tools detected (consider adding GA4 for insights)');
    }

    // Validation: Check script placement in <head>
    const headScripts = parsedPage.querySelectorAll('head script');
    const hasAnalyticsInHead = Array.from(headScripts).some((script) => {
      const src = script.getAttribute('src') ?? '';
      const content = script.textContent || '';
      return (
        src.includes('googletagmanager.com') ||
        src.includes('google-analytics.com') ||
        content.includes('gtag(') ||
        content.includes('ga(')
      );
    });

    if (hasAnyTracking && !hasAnalyticsInHead && !analyticsData.hasGTM) {
      analyticsData.warnings.push('Analytics scripts should be placed in <head> for optimal tracking');
    }

    return analyticsData;
  }
}

export { AnalyticsTrackingAnalyzer };
