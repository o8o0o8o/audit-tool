/**
 * Ad Density Analyzer
 * Measures ad area vs viewport area per Better Ads Standards
 * Flags if ads exceed 30% of viewport height
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage } from '../../types';

// Common ad container selectors and patterns
const AD_SELECTORS = [
  // Google AdSense
  'ins.adsbygoogle',
  '[data-ad-client]',
  '[data-ad-slot]',
  // Google Publisher Tags
  'div[id^="google_ads"]',
  'div[id^="div-gpt-ad"]',
  '.gpt-ad',
  // Generic ad containers
  '[class*="ad-container"]',
  '[class*="ad-slot"]',
  '[class*="ad-wrapper"]',
  '[class*="ad-banner"]',
  '[id*="ad-container"]',
  '[id*="ad-slot"]',
  // Ad iframes
  'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="amazon-adsystem"]',
  'iframe[id*="google_ads"]',
  // Common ad networks
  '[data-freestar]',
  '[class*="adthrive"]',
  '[class*="mediavine"]',
  '[class*="ezoic"]',
];

class AdDensityAnalyzer {
  static async analyze(chromePage: ChromePage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      totalAds: number;
      adAreaPercent: number;
      stickyAds: number;
      adNetworks: string[];
      adElements: { selector: string; width: number; height: number; isSticky: boolean }[];
    } = {
      totalAds: 0,
      adAreaPercent: 0,
      stickyAds: 0,
      adNetworks: [],
      adElements: [],
    };

    try {
      const result = await chromePage.evaluate((selectors: string[]) => {
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const viewportArea = viewportWidth * viewportHeight;

        let totalAdArea = 0;
        let stickyCount = 0;
        const ads: { selector: string; width: number; height: number; isSticky: boolean }[] = [];
        const networks = new Set<string>();
        const countedElements = new Set<Element>();

        // Find ad elements
        for (const selector of selectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              // Avoid double-counting nested ad elements
              if (countedElements.has(el)) continue;

              // Check if this element is inside an already-counted parent
              let isNested = false;
              for (const counted of countedElements) {
                if (counted.contains(el)) {
                  isNested = true;
                  break;
                }
              }
              if (isNested) continue;

              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;

              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;

              countedElements.add(el);

              const area = rect.width * rect.height;
              totalAdArea += area;

              const isSticky = style.position === 'fixed' || style.position === 'sticky';
              if (isSticky) stickyCount++;

              ads.push({
                selector: selector.substring(0, 60),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                isSticky,
              });

              // Detect network
              const outerHtml = el.outerHTML.substring(0, 500).toLowerCase();
              if (outerHtml.includes('adsbygoogle') || outerHtml.includes('googlesyndication'))
                networks.add('Google AdSense');
              if (outerHtml.includes('div-gpt-ad') || outerHtml.includes('doubleclick'))
                networks.add('Google Ad Manager');
              if (outerHtml.includes('amazon-adsystem')) networks.add('Amazon Ads');
              if (outerHtml.includes('mediavine')) networks.add('Mediavine');
              if (outerHtml.includes('adthrive')) networks.add('AdThrive');
              if (outerHtml.includes('ezoic')) networks.add('Ezoic');
            }
          } catch {
            // Invalid selector, skip
          }
        }

        return {
          totalAds: countedElements.size,
          adAreaPercent: viewportArea > 0 ? Math.round((totalAdArea / viewportArea) * 100) : 0,
          stickyCount,
          networks: Array.from(networks),
          ads: ads.slice(0, 20),
        };
      }, AD_SELECTORS);

      info.totalAds = result.totalAds;
      info.adAreaPercent = result.adAreaPercent;
      info.stickyAds = result.stickyCount;
      info.adNetworks = result.networks;
      info.adElements = result.ads;
    } catch {
      return { issues, warnings, info };
    }

    // Better Ads Standard: ads should not exceed 30% of viewport
    if (info.adAreaPercent > 30) {
      issues.push({
        message: `Ad density exceeds 30% of viewport (${info.adAreaPercent}%)`,
        detail: `${info.totalAds} ad elements cover ${info.adAreaPercent}% of the initial viewport. The Coalition for Better Ads recommends ads occupy less than 30% of the vertical page height. Ad networks: ${info.adNetworks.join(', ') || 'unknown'}.`,
        severity: SEVERITY.HIGH,
      });
    } else if (info.adAreaPercent > 20) {
      warnings.push({
        message: `High ad density (${info.adAreaPercent}% of viewport)`,
        detail: `${info.totalAds} ad elements cover ${info.adAreaPercent}% of the viewport. Approaching the 30% threshold.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.stickyAds > 0) {
      warnings.push({
        message: `Sticky/fixed ad detected (${info.stickyAds})`,
        detail: `${info.stickyAds} ad(s) use fixed or sticky positioning. Large sticky ads can degrade the mobile experience and may violate Better Ads Standards.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { AdDensityAnalyzer };
