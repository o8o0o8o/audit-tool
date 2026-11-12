/**
 * Back/forward cache eligibility heuristics. Chrome restores pages instantly on
 * Back/Forward only when they are bfcache-eligible; the two most common
 * blockers visible from outside are `Cache-Control: no-store` on the document
 * and `unload` handlers. Unload registrations are counted by an init script
 * (see BFCACHE_INIT_SCRIPT) that runs before page scripts.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

export const UNLOAD_COUNTER_KEY = '__seoAuditUnloadHandlers';

/** Init script: count `unload` listeners added to window. Must run before page scripts. */
export function installUnloadCounter(): void {
  const w = window as unknown as Record<string, number>;
  w.__seoAuditUnloadHandlers = 0;
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (this === window && type === 'unload') w.__seoAuditUnloadHandlers++;
    return original.call(this, type, listener, options);
  };
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

export function bfcacheIssues(headers: Record<string, string>, unloadHandlers: number): Issue[] {
  const issues: Issue[] = [];
  const cc = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cache-control')?.[1] ?? '';
  if (/\bno-store\b/i.test(cc)) {
    issues.push({
      message: 'Page not eligible for back/forward cache (Cache-Control: no-store)',
      detail: `The document is served with "Cache-Control: ${cc}". Browsers usually keep no-store pages out of the back/forward cache, so Back/Forward reloads the page instead of restoring it instantly. Use no-store only on pages with private data.`,
      severity: SEVERITY.LOW,
    });
  }
  if (unloadHandlers > 0) {
    issues.push({
      message: 'unload event handler blocks back/forward cache',
      detail: `${unloadHandlers} unload handler${unloadHandlers > 1 ? 's are' : ' is'} registered on window. Pages with unload handlers are not put in the back/forward cache by Chrome and Firefox. Use pagehide or visibilitychange instead (often added by an analytics or chat script).`,
      severity: SEVERITY.LOW,
    });
  }
  return issues;
}

export class BfcacheAnalyzer {
  static async analyze(page: PageLike, headers: Record<string, string> = {}) {
    let unload: number;
    try {
      unload = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const counted = typeof w.__seoAuditUnloadHandlers === 'number' ? (w.__seoAuditUnloadHandlers as number) : 0;
        return counted + (typeof window.onunload === 'function' ? 1 : 0);
      });
    } catch {
      unload = 0;
    }
    const issues = bfcacheIssues(headers, unload);
    return {
      issues,
      warnings: [] as Issue[],
      info: { unloadHandlers: unload, noStore: issues.some((i) => /no-store/.test(i.message ?? '')) },
    };
  }
}
