/**
 * Hidden content: most of the page's text exists in the DOM but is not visible
 * after load (display:none / visibility:hidden / zero-size / opacity 0). Google
 * indexes content in accordions and tabs, so this is deliberately conservative:
 * it only fires when almost nothing is visible but a lot of text is hidden —
 * the pattern of a page whose content never gets revealed (broken JS reveal,
 * stuck loader overlay, content gated behind a click) or of text hidden from
 * users but served to crawlers.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

export const HIDDEN_CONTENT_MESSAGE = 'Most page text is hidden';
export const HIDDEN_MAX_VISIBLE_WORDS = 50;
export const HIDDEN_MIN_HIDDEN_WORDS = 300;

export interface TextVisibility {
  visibleWords: number;
  hiddenWords: number;
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Runs in the browser: count visible vs hidden words in body text nodes. */
export function measureTextVisibility(): TextVisibility {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT']);
  const cache = new Map<Element, boolean>();
  const isVisible = (el: Element): boolean => {
    const known = cache.get(el);
    if (known !== undefined) return known;
    let visible: boolean;
    const anyEl = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof anyEl.checkVisibility === 'function') {
      visible = anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } else {
      const cs = getComputedStyle(el);
      visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }
    if (visible) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        // A zero-size box only hides its text when it clips overflow (collapsed accordion panel).
        const cs = getComputedStyle(el);
        visible = !/hidden|clip/.test(cs.overflow);
      }
    }
    cache.set(el, visible);
    return visible;
  };
  let visibleWords = 0;
  let hiddenWords = 0;
  if (!document.body) return { visibleWords, hiddenWords };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p) {
        if (SKIP.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  let budget = 20000;
  while ((n = walker.nextNode()) && budget-- > 0) {
    const words = (n.textContent ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (words === 0 || !n.parentElement) continue;
    if (isVisible(n.parentElement)) visibleWords += words;
    else hiddenWords += words;
  }
  return { visibleWords, hiddenWords };
}

export function hiddenContentIssues(v: TextVisibility): Issue[] {
  if (v.visibleWords >= HIDDEN_MAX_VISIBLE_WORDS || v.hiddenWords <= HIDDEN_MIN_HIDDEN_WORDS) return [];
  return [
    {
      message: HIDDEN_CONTENT_MESSAGE,
      detail: `Only ${v.visibleWords} words are visible after load, while ${v.hiddenWords} words are in the page but hidden (display:none, visibility:hidden, zero size or transparent). Content in accordions and tabs is normally indexed by Google, so this is only flagged when almost nothing is visible: check that the main content is actually revealed to users (broken reveal script, stuck loader or overlay, content behind a click) and is not text shown only to crawlers.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

export class HiddenContentAnalyzer {
  static async analyze(page: PageLike) {
    let v: TextVisibility | null;
    try {
      v = await page.evaluate(measureTextVisibility);
    } catch {
      v = null;
    }
    return { issues: v ? hiddenContentIssues(v) : [], warnings: [] as Issue[], info: v };
  }
}
