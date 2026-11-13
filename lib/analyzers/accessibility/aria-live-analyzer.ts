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
        // One entry per element (an element with both aria-live and a role is one region), hidden
        // regions skipped. Explicit aria-live wins over the role's implicit politeness.
        const isHidden = (el: Element) => {
          if (el.closest('[hidden], [aria-hidden="true"]')) return true;
          const style = getComputedStyle(el);
          return style.display === 'none' || style.visibility === 'hidden';
        };
        const regions = Array.from(
          new Set(document.querySelectorAll('[aria-live], [role="alert"], [role="status"], [role="log"], [role="timer"]')),
        ).filter((el) => !isHidden(el) && el.getAttribute('aria-live') !== 'off');
        const ariaLiveElements = regions.filter((el) => el.hasAttribute('aria-live'));
        const alertElements = regions.filter((el) => !el.hasAttribute('aria-live') && el.getAttribute('role') === 'alert');
        const statusElements = regions.filter((el) => !el.hasAttribute('aria-live') && el.getAttribute('role') === 'status');
        const logElements = regions.filter((el) => !el.hasAttribute('aria-live') && el.getAttribute('role') === 'log');
        const timerElements = regions.filter((el) => !el.hasAttribute('aria-live') && el.getAttribute('role') === 'timer');

        let assertive = 0;
        let polite = 0;
        let empty = 0;
        let large = 0;
        for (const el of regions) {
          const value = el.getAttribute('aria-live') ?? (el.getAttribute('role') === 'alert' ? 'assertive' : 'polite');
          if (value === 'assertive') assertive++;
          else polite++;
          const text = (el.textContent || '').trim();
          if (!text) empty++;
          if (text.length > 500) large++;
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

      info.totalLiveRegions = result.ariaLive + result.alerts + result.status + result.logs + result.timers;
      info.assertiveRegions = result.assertive;
      info.politeRegions = result.polite;
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

    // Empty live regions are not reported: a region must exist (empty) before content is
    // injected for screen readers to announce it, so an empty region at load is the correct pattern.

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
