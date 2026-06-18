/**
 * Broken Pagination Analyzer (site-wide)
 *
 * Detects "infinite" / broken pagination: a "next" link that keeps advancing
 * into pages which return HTTP 200 but render an empty or duplicate listing
 * (or are outright soft/hard 404s). Search engine crawlers follow such links
 * indefinitely, burning crawl budget on pages that will never be indexed.
 *
 * Strategy: group crawled pages by their pagination series key (e.g.
 * `/blog/page/{N}`), order each series by page number, then walk from the
 * highest page backwards collecting a contiguous "broken tail":
 *   - a soft 404 (200 + "not found" content), or
 *   - a hard 4xx/5xx, or
 *   - a thin page that near-duplicates its neighbour in the series
 *     (the classic "empty listing repeats forever" pattern).
 *
 * A series whose tail is broken — or which was truncated at the crawl-time
 * discovery cap with a broken last page — is reported as a HIGH crawl-budget
 * issue.
 */

import { CRAWL_SETTINGS, SEVERITY } from '../../constants';
import { getPaginationSeriesKey, getPaginationPageNumber } from '../../utils';
import type { Issue, PageInfo } from '../../types';

interface SeriesPage {
  url: string;
  pageNum: number;
  wordCount: number;
  contentHash: string | null;
  isSoft404: boolean;
  status: number;
}

class BrokenPaginationAnalyzer {
  static #wordCount(page: PageInfo): number {
    return page.contentQuality?.wordCount ?? page.wordCount ?? 0;
  }

  /**
   * Whether `page` looks broken given its in-series neighbour (the next page
   * already classified as broken, or the next-lower page when starting the
   * tail). Empty-listing detection requires BOTH thin content AND a
   * near-duplicate neighbour to keep false positives low.
   */
  static #isBrokenTailPage(page: SeriesPage, neighbour: SeriesPage | undefined): boolean {
    if (page.isSoft404) return true;
    if (page.status >= 400) return true;
    if (page.status !== 200) return false;

    const thinWords = CRAWL_SETTINGS.BROKEN_PAGINATION_THIN_WORDS;
    const thin = page.wordCount <= thinWords;
    if (!thin || !neighbour) return false;

    const neighbourThin = neighbour.wordCount <= thinWords;
    const hashDup = !!page.contentHash && page.contentHash === neighbour.contentHash;
    // Tolerate page-number text differing between otherwise-identical empty
    // listings ("Page 25" vs "Page 26") by also matching on near-equal size.
    const sizeDup = neighbourThin && Math.abs(page.wordCount - neighbour.wordCount) <= 5;
    return hashDup || sizeDup;
  }

  /**
   * @param pages Crawled pages keyed by URL.
   * @param opts.truncatedSeries Series keys that hit the crawl-time discovery
   *   cap (from `pageData.truncatedPaginationSeries`). A truncated series with
   *   a broken final page is high-confidence broken.
   */
  /**
   * Reduce a pagination series key to the underlying paginated ROUTE by
   * dropping query params that are not the pagination param itself.
   * `/insights/page/{N}` and `/insights/page/{N}?postType=case-study` both
   * reduce to `/insights/page/{N}` — the same non-terminating "next", just a
   * filtered view. A query-based series (`/list?page={N}&sort=asc`) keeps only
   * the `page={N}` part. Used to consolidate same-route variants into one
   * finding instead of one-per-filter.
   */
  static #defectKey(seriesKey: string): string {
    const qIdx = seriesKey.indexOf('?');
    if (qIdx === -1) return seriesKey;
    const path = seriesKey.slice(0, qIdx);
    const paginationParams = seriesKey
      .slice(qIdx + 1)
      .split('&')
      .filter((p) => p.includes('{N}'));
    return paginationParams.length ? `${path}?${paginationParams.join('&')}` : path;
  }

  static analyzeSiteWide(
    pages: Record<string, PageInfo>,
    opts: { truncatedSeries?: Record<string, number> } = {},
  ): { issues: Issue[]; warnings: Issue[]; brokenUrls: string[] } {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const truncatedSeries = opts.truncatedSeries ?? {};

    // 1. Group crawled pages by series key.
    const series = new Map<string, SeriesPage[]>();
    for (const [url, page] of Object.entries(pages)) {
      const key = getPaginationSeriesKey(url);
      if (!key) continue;
      const pageNum = getPaginationPageNumber(url);
      if (pageNum == null) continue;
      const entry: SeriesPage = {
        url,
        pageNum,
        wordCount: BrokenPaginationAnalyzer.#wordCount(page),
        contentHash: page.contentHash ?? null,
        isSoft404: page.soft404?.isSoft404 ?? false,
        status: page.status ?? 0,
      };
      const list = series.get(key);
      if (list) list.push(entry);
      else series.set(key, [entry]);
    }

    // 2. For each series, find the broken trailing run.
    const minTail = CRAWL_SETTINGS.BROKEN_PAGINATION_MIN_TAIL;
    const thinWords = CRAWL_SETTINGS.BROKEN_PAGINATION_THIN_WORDS;
    const broken: { key: string; tail: SeriesPage[]; truncated: boolean }[] = [];

    for (const [key, list] of series) {
      const sorted = list.sort((a, b) => a.pageNum - b.pageNum);
      const wasTruncated = key in truncatedSeries;

      const tail: SeriesPage[] = [];
      for (let i = sorted.length - 1; i >= 0; i--) {
        const neighbour = tail.length > 0 ? tail[tail.length - 1] : sorted[i - 1];
        if (BrokenPaginationAnalyzer.#isBrokenTailPage(sorted[i], neighbour)) {
          tail.push(sorted[i]);
        } else {
          break;
        }
      }
      tail.reverse(); // chronological (ascending page number)

      // When the series was truncated at the discovery cap, the crawl stopped
      // because pagination was generating pages without end — strong evidence
      // of runaway "next". In that case a single thin/empty/soft-404 highest
      // page is enough, even without a duplicate neighbour to pair it with.
      // (A legitimate large catalog's last page still has real listing content,
      // so the thin-words gate protects against false positives.)
      if (wasTruncated && tail.length === 0 && sorted.length > 0) {
        const highest = sorted[sorted.length - 1];
        if (highest.isSoft404 || highest.status >= 400 || highest.wordCount <= thinWords) {
          tail.push(highest);
        }
      }

      // Flag when the broken tail is long enough on its own, or when the crawl
      // truncated the series (so the real tail is even longer than we saw) and
      // its last crawled page is already broken.
      const flag = tail.length >= minTail || (wasTruncated && tail.length >= 1);
      if (flag) broken.push({ key, tail, truncated: wasTruncated });
    }

    // Every broken tail URL across all series — phantom pages the orchestrator
    // suppresses from OTHER findings (the fix is to terminate pagination, not
    // to add canonicals/alt/etc. to pages that should not exist).
    const brokenUrls = broken.flatMap(({ tail }) => tail.map((p) => p.url));

    if (broken.length === 0) return { issues, warnings, brokenUrls };

    // 3. Consolidate series that are the SAME paginated route differing only by
    // a non-pagination query param (e.g. `/insights/page/{N}` and
    // `/insights/page/{N}?postType=case-study`) — one termination bug, one
    // finding. Keep each variant's tail separate so we can sample across them.
    const groups = new Map<string, { key: string; variants: SeriesPage[][]; truncated: boolean }>();
    for (const { key, tail, truncated } of broken) {
      const dk = BrokenPaginationAnalyzer.#defectKey(key);
      const g = groups.get(dk);
      if (g) {
        g.variants.push(tail);
        g.truncated = g.truncated || truncated;
      } else {
        groups.set(dk, { key: dk, variants: [tail], truncated });
      }
    }

    // Deterministic order: worst (longest combined tail) first, key as tie-break.
    const grouped = [...groups.values()].sort(
      (a, b) => b.variants.flat().length - a.variants.flat().length || a.key.localeCompare(b.key),
    );

    // 4. Emit one HIGH issue per consolidated route (cap the listing).
    const SHOWN = 10;
    for (const { key, variants, truncated } of grouped.slice(0, SHOWN)) {
      const allTail = variants.flat();
      const nums = allTail.map((p) => p.pageNum).sort((a, b) => a - b);
      const lo = nums[0];
      const hi = nums[nums.length - 1];
      const range = lo === hi ? `page ${lo}` : `pages ${lo}–${hi}`;
      const truncatedNote = truncated
        ? ' The crawler stopped following this series at its discovery cap, so the real broken tail is likely longer.'
        : '';
      const variantNote =
        variants.length > 1
          ? ` The same route is paginated under ${variants.length} query variants (e.g. filtered views), all sharing this non-terminating "next".`
          : '';
      // Round-robin across variants so the sample shows each filtered view.
      const sampleUrls: string[] = [];
      for (let i = 0; sampleUrls.length < 5; i++) {
        let added = false;
        for (const v of variants) {
          if (v[i]) {
            sampleUrls.push(v[i].url);
            added = true;
            if (sampleUrls.length >= 5) break;
          }
        }
        if (!added) break;
      }
      // Sample URLs render as proper anchor links after a <br>, NOT joined into
      // the prose. A bare "Affected: a, b, c" list let the curated report's URL
      // extractor glue the ", " separators onto each href (→ ".../page/7,") and
      // made the cluster-label helper cut the label at the first bare URL. The
      // series key lives in the message (the report header) — repeating it here
      // as `<code>…</code>` was redundant and, since the key is itself a full URL
      // (`…/page/{N}`), tripped both the URL extractor and the label cutter.
      const sampleLinks = sampleUrls.map((u) => `<a href="${u}">${u}</a>`).join('<br>');
      issues.push({
        message: `Broken pagination wastes crawl budget — ${key}`,
        detail:
          `This pagination series advances into ${allTail.length} empty, duplicate, or not-found ` +
          `page(s) (${range}) that return HTTP 200 with no real content, so crawlers (Googlebot) follow the ` +
          `"next" link indefinitely and waste crawl budget on pages that will never be indexed.${variantNote}${truncatedNote}` +
          `<br>Affected pages:<br>${sampleLinks}`,
        severity: SEVERITY.HIGH,
      });
    }

    if (grouped.length > SHOWN) {
      issues.push({
        message: 'Additional pagination series show broken/infinite "next" links',
        detail: `${grouped.length - SHOWN} further paginated routes advance past their real last page. Audit pagination termination site-wide.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, brokenUrls };
  }
}

export { BrokenPaginationAnalyzer };
