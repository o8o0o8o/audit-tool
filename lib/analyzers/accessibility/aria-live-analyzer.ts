/**
 * ARIA Live Region Analyzer
 * Validates proper usage of aria-live, role="alert", role="status"
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage } from '../../types';

class AriaLiveAnalyzer {
  static async analyze(chromePage: ChromePage, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      totalLiveRegions: number;
      assertiveRegions: number;
      politeRegions: number;
      alertRoles: number;
      statusRoles: number;
      emptyLiveRegions: number;
      largeLiveRegions: number;
    } = {
      totalLiveRegions: 0,
      assertiveRegions: 0,
      politeRegions: 0,
      alertRoles: 0,
      statusRoles: 0,
      emptyLiveRegions: 0,
      largeLiveRegions: 0,
    };

    try {
      const result = await chromePage.evaluate(() => {
        // Find all live region elements
        const ariaLiveElements = document.querySelectorAll('[aria-live]');
        const alertElements = document.querySelectorAll('[role="alert"]');
        const statusElements = document.querySelectorAll('[role="status"]');
        const logElements = document.querySelectorAll('[role="log"]');
        const timerElements = document.querySelectorAll('[role="timer"]');

        let assertive = 0;
        let polite = 0;
        let empty = 0;
        let large = 0;

        // Check aria-live elements
        for (const el of ariaLiveElements) {
          const value = el.getAttribute('aria-live');
          if (value === 'assertive') assertive++;
          else if (value === 'polite') polite++;

          const text = (el.textContent || '').trim();
          if (!text) empty++;
          if (text.length > 500) large++;
        }

        // Alert roles are implicitly aria-live="assertive"
        for (const el of alertElements) {
          const text = (el.textContent || '').trim();
          if (!text) empty++;
          if (text.length > 500) large++;
        }

        // Status roles are implicitly aria-live="polite"
        for (const el of statusElements) {
          const text = (el.textContent || '').trim();
          if (!text) empty++;
        }

        return {
          ariaLive: ariaLiveElements.length,
          alerts: alertElements.length,
          status: statusElements.length,
          logs: logElements.length,
          timers: timerElements.length,
          assertive,
          polite,
          empty,
          large,
        };
      });

      info.totalLiveRegions =
        result.ariaLive + result.alerts + result.status + result.logs + result.timers;
      info.assertiveRegions = result.assertive + result.alerts;
      info.politeRegions = result.polite + result.status;
      info.alertRoles = result.alerts;
      info.statusRoles = result.status;
      info.emptyLiveRegions = result.empty;
      info.largeLiveRegions = result.large;
    } catch {
      return { issues, warnings, info };
    }

    // Report issues
    if (info.assertiveRegions > 3) {
      issues.push({
        message: 'Excessive use of assertive live regions',
        detail: `${info.assertiveRegions} assertive live regions (aria-live="assertive" or role="alert") found. Assertive announcements interrupt the user immediately. Use aria-live="polite" or role="status" when possible.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.emptyLiveRegions > 0) {
      warnings.push({
        message: 'Empty ARIA live regions detected',
        detail: `${info.emptyLiveRegions} live region(s) have no text content. Empty live regions may cause confusion for screen reader users if content is dynamically inserted without proper announcements.`,
        severity: SEVERITY.LOW,
      });
    }

    if (info.largeLiveRegions > 0) {
      warnings.push({
        message: 'Large content in ARIA live regions',
        detail: `${info.largeLiveRegions} live region(s) contain more than 500 characters. Large live region updates cause lengthy screen reader announcements that disrupt the user experience. Keep live region content concise.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { AriaLiveAnalyzer };
