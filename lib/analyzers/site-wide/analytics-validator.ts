import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

/**
 * Site-wide Analytics Validator
 * Analyzes analytics and tracking implementation across all pages.
 */
class AnalyticsValidator {
  /**
   * Validate analytics implementation across all pages.
   *
   * @param {Object} allPages - Object containing all page data { url: pageData }
   * @returns {Object} { issues: [], warnings: [], coverageStats: {}, trackingIds: {} }
   */
  static validateAnalyticsImplementation(allPages: Record<string, PageInfo>) {
    console.log('\nAnalyzing analytics and tracking implementation across pages...');

    const analyticsStats = {
      pagesWithGA4: 0,
      pagesWithUA: 0,
      pagesWithGTM: 0,
      pagesWithFacebookPixel: 0,
      pagesWithLinkedIn: 0,
      pagesWithTwitter: 0,
      pagesWithTikTok: 0,
      pagesWithPinterest: 0,
      pagesWithHotjar: 0,
      pagesWithClarity: 0,
      pagesWithoutAnalytics: 0,
      pagesWithCookieConsent: 0,
      pagesWithPrivacyPolicy: 0,
      ga4Ids: new Map(), // ID -> count
      uaIds: new Map(),
      gtmIds: new Map(),
      consentTools: new Map(), // tool name -> count
      totalIssues: 0,
      totalWarnings: 0,
    };

    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    let pagesAnalyzed = 0;

    // Analyze each page's analytics data
    for (const url in allPages) {
      const page = allPages[url];

      if (!page.analytics) continue;

      pagesAnalyzed++;
      const analytics = page.analytics;

      // Track coverage
      if (analytics.hasGA4) analyticsStats.pagesWithGA4++;
      if (analytics.hasUniversalAnalytics) analyticsStats.pagesWithUA++;
      if (analytics.hasGTM) analyticsStats.pagesWithGTM++;
      if (analytics.hasFacebookPixel) analyticsStats.pagesWithFacebookPixel++;
      if (analytics.hasLinkedInTag) analyticsStats.pagesWithLinkedIn++;
      if (analytics.hasTwitterPixel) analyticsStats.pagesWithTwitter++;
      if (analytics.hasTikTokPixel) analyticsStats.pagesWithTikTok++;
      if (analytics.hasPinterestTag) analyticsStats.pagesWithPinterest++;
      if (analytics.hasHotjar) analyticsStats.pagesWithHotjar++;
      if (analytics.hasMicrosoftClarity) analyticsStats.pagesWithClarity++;

      if (analytics.hasCookieConsent) {
        analyticsStats.pagesWithCookieConsent++;
        if (analytics.consentTool) {
          analyticsStats.consentTools.set(
            analytics.consentTool,
            (analyticsStats.consentTools.get(analytics.consentTool) || 0) + 1,
          );
        }
      }

      if (analytics.hasPrivacyPolicy) analyticsStats.pagesWithPrivacyPolicy++;

      const hasAnyTracking =
        analytics.hasGA4 ||
        analytics.hasUniversalAnalytics ||
        analytics.hasGTM ||
        analytics.hasFacebookPixel ||
        analytics.hasLinkedInTag ||
        analytics.hasTwitterPixel ||
        analytics.hasTikTokPixel ||
        analytics.hasPinterestTag;

      if (!hasAnyTracking) {
        analyticsStats.pagesWithoutAnalytics++;
      }

      // Track unique tracking IDs (handle missing/undefined trackingIds)
      const trackingIds = analytics.trackingIds || {};
      (trackingIds.ga4 || []).forEach((id: any) => {
        analyticsStats.ga4Ids.set(id, (analyticsStats.ga4Ids.get(id) || 0) + 1);
      });

      (trackingIds.ua || []).forEach((id: any) => {
        analyticsStats.uaIds.set(id, (analyticsStats.uaIds.get(id) || 0) + 1);
      });

      (trackingIds.gtm || []).forEach((id: any) => {
        analyticsStats.gtmIds.set(id, (analyticsStats.gtmIds.get(id) || 0) + 1);
      });

      // Count issues and warnings
      analyticsStats.totalIssues += analytics.issues?.length || 0;
      analyticsStats.totalWarnings += analytics.warnings?.length || 0;
    }

    const totalPages = pagesAnalyzed;
    const ga4Coverage = totalPages > 0 ? Math.round((analyticsStats.pagesWithGA4 / totalPages) * 100) : 0;
    const gtmCoverage = totalPages > 0 ? Math.round((analyticsStats.pagesWithGTM / totalPages) * 100) : 0;
    const consentCoverage = totalPages > 0 ? Math.round((analyticsStats.pagesWithCookieConsent / totalPages) * 100) : 0;

    console.log(`GA4 coverage: ${analyticsStats.pagesWithGA4}/${totalPages} pages (${ga4Coverage}%)`);
    console.log(`GTM coverage: ${analyticsStats.pagesWithGTM}/${totalPages} pages (${gtmCoverage}%)`);
    console.log(
      `Cookie consent coverage: ${analyticsStats.pagesWithCookieConsent}/${totalPages} pages (${consentCoverage}%)`,
    );

    // Report 1: Pages without any analytics
    if (analyticsStats.pagesWithoutAnalytics > totalPages * 0.1 && totalPages > 10) {
      issues.push({
        title: `Many pages missing analytics`,
        description: `${analyticsStats.pagesWithoutAnalytics} page(s) (${Math.round((analyticsStats.pagesWithoutAnalytics / totalPages) * 100)}%) have no analytics or tracking tools. Consider adding GA4 for visitor insights.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report 2: Inconsistent GA4 tracking IDs
    if (analyticsStats.ga4Ids.size > 1) {
      const idsList = Array.from(analyticsStats.ga4Ids.entries())
        .map(([id, count]) => `<li>${id}: ${count} page(s)</li>`)
        .join('');

      issues.push({
        title: `Inconsistent GA4 measurement IDs across pages`,
        description: `Found ${analyticsStats.ga4Ids.size} different GA4 measurement IDs across your site. All pages should use the same ID:<ul>${idsList}</ul>`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 3: Inconsistent GTM container IDs
    if (analyticsStats.gtmIds.size > 1) {
      const idsList = Array.from(analyticsStats.gtmIds.entries())
        .map(([id, count]) => `<li>${id}: ${count} page(s)</li>`)
        .join('');

      issues.push({
        title: `Inconsistent GTM container IDs across pages`,
        description: `Found ${analyticsStats.gtmIds.size} different GTM container IDs. All pages should use the same container:<ul>${idsList}</ul>`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 4: Inconsistent UA tracking IDs
    if (analyticsStats.uaIds.size > 1) {
      const idsList = Array.from(analyticsStats.uaIds.entries())
        .map(([id, count]) => `<li>${id}: ${count} page(s)</li>`)
        .join('');

      issues.push({
        title: `Inconsistent Universal Analytics IDs across pages`,
        description: `Found ${analyticsStats.uaIds.size} different UA tracking IDs across your site:<ul>${idsList}</ul>`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 5: Low GA4 coverage
    if (ga4Coverage < 90 && totalPages > 10) {
      issues.push({
        title: `Low GA4 coverage across site`,
        description: `Only ${ga4Coverage}% of pages (${analyticsStats.pagesWithGA4}/${totalPages}) have GA4 tracking. Ensure all pages include your analytics code.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 6: Cookie consent coverage issues
    const hasTracking =
      analyticsStats.pagesWithGA4 > 0 ||
      analyticsStats.pagesWithUA > 0 ||
      analyticsStats.pagesWithGTM > 0 ||
      analyticsStats.pagesWithFacebookPixel > 0;

    if (hasTracking && consentCoverage < 80) {
      issues.push({
        title: `Inconsistent cookie consent implementation`,
        description: `Your site uses tracking but only ${consentCoverage}% of pages (${analyticsStats.pagesWithCookieConsent}/${totalPages}) have cookie consent. GDPR/CCPA requires consent on all pages with tracking.`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 7: Multiple consent tools detected
    if (analyticsStats.consentTools.size > 1) {
      const toolsList = Array.from(analyticsStats.consentTools.entries())
        .map(([tool, count]) => `<li>${tool}: ${count} page(s)</li>`)
        .join('');

      issues.push({
        title: `Multiple cookie consent tools detected`,
        description: `Found ${analyticsStats.consentTools.size} different consent tools across your site. Use one consistent solution:<ul>${toolsList}</ul>`,
        severity: SEVERITY.HIGH,
      });
    }

    // Report 8: Both UA and GA4 detected (migration check)
    if (analyticsStats.pagesWithUA > 0 && analyticsStats.pagesWithGA4 > 0) {
      const uaCoverage = Math.round((analyticsStats.pagesWithUA / totalPages) * 100);
      issues.push({
        title: `Both Universal Analytics and GA4 detected`,
        description: `Your site has both UA (${uaCoverage}% coverage) and GA4 (${ga4Coverage}% coverage). Universal Analytics stopped collecting data in July 2024. Complete migration to GA4 and remove UA code.`,
        severity: SEVERITY.HIGH,
      });
    } else if (analyticsStats.pagesWithUA > 0 && analyticsStats.pagesWithGA4 === 0) {
      issues.push({
        title: `Still using Universal Analytics only`,
        description: `Your site only uses Universal Analytics, which stopped collecting data in July 2024. Migrate to GA4 immediately to continue tracking visitors.`,
        severity: SEVERITY.CRITICAL,
      });
    }

    // Report 9: Privacy policy coverage
    if (hasTracking) {
      const privacyCoverage =
        totalPages > 0 ? Math.round((analyticsStats.pagesWithPrivacyPolicy / totalPages) * 100) : 0;
      if (privacyCoverage < 80) {
        issues.push({
          title: `Privacy policy link missing on many pages`,
          description: `Your site uses tracking but only ${privacyCoverage}% of pages (${analyticsStats.pagesWithPrivacyPolicy}/${totalPages}) have a privacy policy link. Privacy policies are required by GDPR/CCPA.`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    console.log(`Unique GA4 IDs: ${analyticsStats.ga4Ids.size}`);
    console.log(`Unique GTM containers: ${analyticsStats.gtmIds.size}`);
    console.log(`Total analytics issues: ${analyticsStats.totalIssues}`);

    return {
      issues,
      warnings,
      coverageStats: {
        ga4Coverage,
        gtmCoverage,
        consentCoverage,
        pagesWithGA4: analyticsStats.pagesWithGA4,
        pagesWithUA: analyticsStats.pagesWithUA,
        pagesWithGTM: analyticsStats.pagesWithGTM,
        pagesWithoutAnalytics: analyticsStats.pagesWithoutAnalytics,
        pagesWithCookieConsent: analyticsStats.pagesWithCookieConsent,
        pagesWithPrivacyPolicy: analyticsStats.pagesWithPrivacyPolicy,
        totalPages,
      },
      trackingIds: {
        uniqueGA4Ids: analyticsStats.ga4Ids.size,
        uniqueUAIds: analyticsStats.uaIds.size,
        uniqueGTMIds: analyticsStats.gtmIds.size,
        ga4Ids: Array.from(analyticsStats.ga4Ids.keys()),
        uaIds: Array.from(analyticsStats.uaIds.keys()),
        gtmIds: Array.from(analyticsStats.gtmIds.keys()),
        consentTools: Array.from(analyticsStats.consentTools.keys()),
        trackingTools: {
          ga4: analyticsStats.pagesWithGA4,
          ua: analyticsStats.pagesWithUA,
          gtm: analyticsStats.pagesWithGTM,
          facebook: analyticsStats.pagesWithFacebookPixel,
          linkedin: analyticsStats.pagesWithLinkedIn,
          twitter: analyticsStats.pagesWithTwitter,
          tiktok: analyticsStats.pagesWithTikTok,
          pinterest: analyticsStats.pagesWithPinterest,
          hotjar: analyticsStats.pagesWithHotjar,
          clarity: analyticsStats.pagesWithClarity,
        },
        totalIssues: analyticsStats.totalIssues,
        totalWarnings: analyticsStats.totalWarnings,
      },
    };
  }
}

export { AnalyticsValidator };
