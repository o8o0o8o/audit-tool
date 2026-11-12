/**
 * Scroll-loaded content: text or internal links that appear only after the
 * page is scrolled (infinite scroll, IntersectionObserver lazy sections).
 * Googlebot does not scroll; it renders with a very tall viewport, so content
 * triggered by entering the viewport often still loads — but content that
 * waits for scroll events, or is appended in stages as the user nears the
 * bottom, may never be rendered for indexing unless there is a static fallback
 * (paginated links, server-rendered markup).
 *
 * MUTATES the page (scroll position, lazy content): run it LAST.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

export const SCROLL_LOADED_MESSAGE = 'Content loads only after scrolling';
export const SCROLL_MAX_STEPS = 8;
export const SCROLL_STEP_MS = 300;
export const SCROLL_MAX_TOTAL_MS = 4000;

export interface ContentSnapshot {
  words: number;
  internalLinks: number;
}

export interface ScrollPage {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
}

/** Runs in the browser. */
export function snapshotContent(): ContentSnapshot {
  const text = document.body?.innerText ?? '';
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const hrefs = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    try {
      const u = new URL((a as HTMLAnchorElement).href, location.href);
      if (u.host === location.host && /^https?:$/.test(u.protocol)) hrefs.add(u.origin + u.pathname + u.search);
    } catch {
      /* ignore */
    }
  }
  return { words, internalLinks: hrefs.size };
}

/** Pure decision. */
export function scrollLoadedIssues(before: ContentSnapshot, after: ContentSnapshot): Issue[] {
  const wordGain = after.words - before.words;
  const linkGain = after.internalLinks - before.internalLinks;
  const wordsGrew = wordGain >= 200 && wordGain >= before.words * 0.3;
  const linksGrew = linkGain >= 10;
  if (!wordsGrew && !linksGrew) return [];
  const parts: string[] = [];
  if (wordsGrew) parts.push(`text grew from ${before.words} to ${after.words} words`);
  if (linksGrew) parts.push(`internal links grew from ${before.internalLinks} to ${after.internalLinks}`);
  return [
    {
      message: SCROLL_LOADED_MESSAGE,
      detail: `After scrolling to the bottom, ${parts.join(' and ')}. Googlebot does not scroll: it renders the page in a tall viewport, so content loaded by IntersectionObserver usually still appears, but content that waits for scroll events or loads in stages near the bottom may not be indexed, and its links may not be discovered. Server-render this content or provide a static fallback such as paginated links (&lt;a href&gt; to page 2, 3, ...).`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ScrollLoadedContentAnalyzer {
  static async analyze(page: ScrollPage, sleep: (ms: number) => Promise<void> = defaultSleep) {
    const empty = { issues: [] as Issue[], warnings: [] as Issue[], info: null as null | Record<string, unknown> };
    let before: ContentSnapshot;
    try {
      before = await page.evaluate(snapshotContent);
    } catch {
      return empty;
    }
    let after = before;
    let steps = 0;
    try {
      const started = Date.now();
      for (; steps < SCROLL_MAX_STEPS; steps++) {
        if (Date.now() - started + SCROLL_STEP_MS > SCROLL_MAX_TOTAL_MS) break;
        const atBottom = await page.evaluate((step: number) => {
          const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
          const target = Math.min(h, (step + 1) * Math.max(window.innerHeight, 1) * 1.5);
          window.scrollTo(0, target);
          return window.scrollY + window.innerHeight >= h - 2;
        }, steps);
        await sleep(SCROLL_STEP_MS);
        if (atBottom && steps >= 1) {
          steps++;
          break;
        }
      }
      after = await page.evaluate(snapshotContent);
    } catch {
      /* keep partial */
    } finally {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
      } catch {
        /* ignore */
      }
    }
    return {
      issues: scrollLoadedIssues(before, after),
      warnings: [] as Issue[],
      info: { before, after, steps },
    };
  }
}
