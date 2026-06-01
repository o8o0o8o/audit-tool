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
import { escapeHtml, getPaginationSeriesKey, getPaginationPageNumber, formatSampleList } from '../../utils';
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
  static analyzeSiteWide(
    pages: Record<string, PageInfo>,
    opts: { truncatedSeries?: Record<string, number> } = {},
  ): { issues: Issue[]; warnings: Issue[] } {
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

    if (broken.length === 0) return { issues, warnings };

    // 3. Emit one HIGH issue per broken series (cap the listing).
    broken.sort((a, b) => b.tail.length - a.tail.length);
    const SHOWN = 10;
    for (const { key, tail, truncated } of broken.slice(0, SHOWN)) {
      const first = tail[0];
      const last = tail[tail.length - 1];
      const range = first.pageNum === last.pageNum ? `page ${first.pageNum}` : `pages ${first.pageNum}–${last.pageNum}`;
      const truncatedNote = truncated
        ? ' The crawler stopped following this series at its discovery cap, so the real broken tail is likely longer.'
        : '';
      const sampleUrls = tail.slice(0, 5).map((p) => p.url);
      issues.push({
        message: `Broken pagination wastes crawl budget — ${key}`,
        detail:
          `The <code>${escapeHtml(key)}</code> pagination series advances into ${tail.length} empty, ` +
          `duplicate, or not-found page(s) (${range}). The "next" link keeps returning HTTP 200 with no real ` +
          `content, so crawlers (Googlebot) follow it indefinitely and waste crawl budget on pages that will ` +
          `never be indexed.${truncatedNote} Remove the "next" link on the last real page (or return a 404 for ` +
          `out-of-range pages) so pagination terminates. Affected: ${formatSampleList(sampleUrls)}`,
        severity: SEVERITY.HIGH,
      });
    }

    if (broken.length > SHOWN) {
      issues.push({
        message: `${broken.length - SHOWN} more pagination series show broken/infinite "next" links`,
        detail: 'Multiple paginated series advance past their real last page. Audit pagination termination site-wide.',
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { BrokenPaginationAnalyzer };
