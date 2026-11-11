import { FAILURE_CATEGORIES } from '../crawler/resilience';

export interface PageCounts {
  /** Pages stored by the crawl (have a page record). */
  crawled: number;
  /** Stored pages with a proven 200 status. */
  successful: number;
  /** Stored pages with any other (or no) status. Always crawled - successful. */
  withErrors: number;
  /** Distinct URLs that never loaded (load failures with no page record). */
  failedToLoad: number;
}

type StoredPage = { status?: unknown; statusCode?: unknown } | null | undefined;

/**
 * Single definition of the page counts shown in every report. Derived from
 * per-URL data only (never the running counters), so audits whose counters were
 * inflated by per-attempt counting still add up.
 */
export function computePageCounts(
  pages: Record<string, StoredPage> | null | undefined,
  byError: Record<string, unknown> | null | undefined,
): PageCounts {
  const pageMap = pages ?? {};
  const urls = Object.keys(pageMap);
  let successful = 0;
  for (const url of urls) {
    const page = pageMap[url];
    const code = Number(page?.status ?? page?.statusCode);
    if (code === 200) successful++;
  }

  const stored = new Set(urls);
  const failed = new Set<string>();
  const errors = byError ?? {};
  for (const category of FAILURE_CATEGORIES) {
    const list = errors[category];
    if (!Array.isArray(list)) continue;
    for (const url of list) {
      if (typeof url === 'string' && !stored.has(url)) failed.add(url);
    }
  }

  return {
    crawled: urls.length,
    successful,
    withErrors: urls.length - successful,
    failedToLoad: failed.size,
  };
}
