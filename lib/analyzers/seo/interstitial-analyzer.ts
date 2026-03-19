/**
 * Intrusive Interstitial / Popup Detector
 * Detects overlays, modals, and popups that may violate Google's
 * intrusive interstitial guidelines (covering >30% viewport)
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage } from '../../types';

class InterstitialAnalyzer {
  static async analyze(chromePage: ChromePage, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      detected: boolean;
      overlays: {
        selector: string;
        coveragePercent: number;
        zIndex: number;
        position: string;
      }[];
      cookieBanner: boolean;
      popupLibraries: string[];
    } = {
      detected: false,
      overlays: [],
      cookieBanner: false,
      popupLibraries: [],
    };

    try {
      const result = await chromePage.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const viewportArea = viewportWidth * viewportHeight;
        const overlays: {
          selector: string;
          coveragePercent: number;
          zIndex: number;
          position: string;
        }[] = [];
        let cookieBanner = false;

        // Find elements that may be overlays
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
          const style = window.getComputedStyle(el);

          // Skip hidden elements
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }

          const position = style.position;
          const zIndex = parseInt(style.zIndex, 10) || 0;

          // Only check fixed/absolute positioned elements with high z-index
          if ((position !== 'fixed' && position !== 'absolute') || zIndex < 100) {
            continue;
          }

          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          const coveragePercent = (area / viewportArea) * 100;

          // Only flag elements covering >30% of viewport
          if (coveragePercent < 30) continue;

          // Check if it's a cookie banner (acceptable exception)
          const text = (el.textContent || '').toLowerCase();
          const isCookieBanner =
            text.includes('cookie') ||
            text.includes('consent') ||
            text.includes('gdpr') ||
            text.includes('privacy');

          if (isCookieBanner) {
            cookieBanner = true;
            continue;
          }

          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : '';

          overlays.push({
            selector: `${tag}${id}${cls}`.substring(0, 80),
            coveragePercent: Math.round(coveragePercent),
            zIndex,
            position,
          });
        }

        // Check for known popup/modal libraries
        const libraries: string[] = [];
        if (document.querySelector('.optinmonster, [data-optinmonster]'))
          libraries.push('OptinMonster');
        if (document.querySelector('.sumo-overlay, .sumome'))
          libraries.push('Sumo');
        if (document.querySelector('.hustle-modal, .hustle-popup'))
          libraries.push('Hustle');
        if (document.querySelector('.pum-overlay, .pum-container'))
          libraries.push('Popup Maker');
        if (document.querySelector('.mailchimp-popup, .mc-modal'))
          libraries.push('Mailchimp');
        if (document.querySelector('.intercom-lightweight-app'))
          libraries.push('Intercom');

        return { overlays, cookieBanner, libraries };
      });

      info.overlays = result.overlays;
      info.detected = result.overlays.length > 0;
      info.cookieBanner = result.cookieBanner;
      info.popupLibraries = result.libraries;
    } catch {
      return { issues, warnings, info };
    }

    if (info.overlays.length > 0) {
      const worst = info.overlays.sort((a, b) => b.coveragePercent - a.coveragePercent)[0];
      issues.push({
        message: 'Intrusive interstitial/popup detected',
        detail: `${info.overlays.length} overlay(s) cover more than 30% of the viewport. Largest: "${worst.selector}" covers ${worst.coveragePercent}% (z-index: ${worst.zIndex}). Google may penalize pages with intrusive interstitials on mobile.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (info.popupLibraries.length > 0) {
      warnings.push({
        message: 'Popup/modal library detected',
        detail: `Popup library found: ${info.popupLibraries.join(', ')}. Ensure popups comply with Google's intrusive interstitial guidelines (don't block content before user interaction).`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { InterstitialAnalyzer };
