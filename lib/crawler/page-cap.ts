/**
 * The page cap of a full audit: the crawl stops after `DEFAULT_PAGE_CAP` page loads unless
 * `--max-pages` says otherwise. When the site has more pages than the cap, the pages are not taken
 * in sitemap order but spread over the site's templates, so the run sees as many kinds of page as
 * it can. The sitemap URLs left out are kept in `HELD_SITEMAP_FILE`, and
 * `--proceed --max-pages=<more>` continues the same run with them.
 */
import { languagePrefix, pathSegments, templateKey } from '../leads/page-selector';

export const DEFAULT_PAGE_CAP = 5000;

/** Sitemap entries the cap left out, by URL; read back by a `--proceed` run. */
export const HELD_SITEMAP_FILE = 'sitemap-held.json.gz';

/** Recorded in the run's metadata only when the cap stopped the crawl. */
export interface PageCapInfo {
  cap: number;
  pagesLoaded: number;
  /** Sitemap URLs after `--exclude` / `--limit`, before the cap. */
  sitemapUrls: number | null;
  /** Sitemap URLs not loaded because of the cap. */
  sitemapHeld: number;
}

/** `--max-pages`: absent → the default, 0 → no cap. Lead scans and single-page audits have their own limits. */
export function resolvePageCap(maxPages: number | null | undefined, lead: boolean, singlePage: boolean): number | null {
  if (lead || singlePage) return null;
  if (maxPages === 0) return null;
  return maxPages && maxPages > 0 ? Math.floor(maxPages) : DEFAULT_PAGE_CAP;
}

/**
 * Page loads a full audit may make: `--limit=N` allows N sitemap pages and N found through links,
 * and the cap bounds the total.
 */
export function fullAuditPageBudget(limit: number | null | undefined, cap: number | null): number | null {
  const fromLimit = limit ? limit * 2 : null;
  if (fromLimit && cap) return Math.min(fromLimit, cap);
  return fromLimit ?? cap;
}

/** Of a capped run, the loads given to sitemap pages; the rest is for pages found only through links. */
export function sitemapShare(cap: number): number {
  return Math.max(1, Math.floor(cap * 0.9));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Inside one template: the language and the section under it (`/de/blog/2024/x` → `de|2024`). */
function sectionKey(url: string): string {
  try {
    const { pathname } = new URL(url);
    const segments = pathSegments(pathname);
    return `${languagePrefix(pathname) ?? ''}|${segments.length >= 3 ? segments[1].toLowerCase() : ''}`;
  } catch {
    return '|';
  }
}

const byHash = (a: string, b: string) => hash(a) - hash(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * All `urls`, most useful first: one page of every template, then a second of every template, and
 * so on; inside a template the pages alternate between its languages and sections. The order
 * depends only on the set of URLs, so the first N of a larger N are the same pages: a continued run
 * adds pages and never swaps them. `seen` counts pages already loaded per template (they go later).
 */
export function orderForCoverage(
  urls: Iterable<string>,
  opts: { home?: string | null; seen?: Map<string, number> } = {},
): string[] {
  const templates = new Map<string, Map<string, string[]>>();
  for (const url of new Set(urls)) {
    const template = templateKey(url) ?? '?';
    const sections = templates.get(template) ?? new Map<string, string[]>();
    templates.set(template, sections);
    const section = sectionKey(url);
    const list = sections.get(section) ?? [];
    sections.set(section, list);
    list.push(url);
  }
  const ranked: Array<{ url: string; rank: number }> = [];
  for (const [template, sections] of templates) {
    const lists = [...sections.keys()].sort(byHash).map((k) => sections.get(k)!.sort(byHash));
    let rank = opts.seen?.get(template) ?? 0;
    for (let round = 0, left = true; left; round++) {
      left = false;
      for (const list of lists) {
        if (round >= list.length) continue;
        ranked.push({ url: list[round], rank: rank++ });
        left = true;
      }
    }
  }
  const homeKey = opts.home ? opts.home.replace(/\/+$/, '') : null;
  const isHome = (u: string) => homeKey !== null && u.replace(/\/+$/, '') === homeKey;
  ranked.sort((a, b) => Number(isHome(b.url)) - Number(isHome(a.url)) || a.rank - b.rank || byHash(a.url, b.url));
  return ranked.map((r) => r.url);
}

/** Pages already loaded, counted per template. */
export function templateCounts(urls: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const t = templateKey(url) ?? '?';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}
