import { describe, it } from 'node:test';
import assert from 'node:assert';

import { getExecutiveSummary } from '../lib/reports/sections/executive-summary';
import type { ReportSectionData, PageInfo } from '../lib/types';

function summaryData(opts: { pagesCrawled: number; sitemapTotal: number | null }): ReportSectionData {
  const pages: PageInfo[] = Array.from(
    { length: opts.pagesCrawled },
    (_, i) => ({ url: `https://e.com/${i}` }) as PageInfo,
  );
  return {
    jsonData: {
      analysis: {
        details: {},
        bySeverity: {},
        summary: {
          overallScore: 72,
          categoryScores: {
            seo: 80,
            technical: 90,
            performance: 60,
            accessibility: 70,
            security: 65,
          },
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
        },
      },
      pageData: { pages: Object.fromEntries(pages.map((p) => [p.url, p])) },
      ...(opts.sitemapTotal !== null ? { sitemaps: { 'sitemap.xml': { total: opts.sitemapTotal } } } : {}),
    },
    pages,
  } as unknown as ReportSectionData;
}

void describe('getExecutiveSummary: "Site Health" only claims what was actually crawled', () => {
  void it('keeps "Site Health" and adds no scope note when every sitemap URL was crawled', () => {
    const html = getExecutiveSummary(summaryData({ pagesCrawled: 10, sitemapTotal: 10 }));
    assert.match(html, /Site Health/);
    assert.doesNotMatch(html, /Based on \d+ of \d+ pages/);
  });

  void it('drops "Site Health" when the real sitemap total is unknown — e.g. the no-sitemap origin-only fallback — since the real site size still isn\'t known', () => {
    const html = getExecutiveSummary(summaryData({ pagesCrawled: 2, sitemapTotal: null }));
    assert.doesNotMatch(html, /Site Health/);
    assert.match(html, /Based on 2 pages — no sitemap was found for this site/);
  });

  void it('uses singular "page" wording for the single-page origin-fallback case', () => {
    const html = getExecutiveSummary(summaryData({ pagesCrawled: 1, sitemapTotal: null }));
    assert.match(html, /Based on 1 page — no sitemap was found for this site/);
    assert.doesNotMatch(html, /Based on 1 pages/);
  });

  void it('drops "Site Health", shows a plain "Score" label and the honest crawled/total count on a bounded run', () => {
    const html = getExecutiveSummary(summaryData({ pagesCrawled: 10, sitemapTotal: 84 }));
    assert.doesNotMatch(html, /Site Health/);
    assert.match(html, /Based on 10 of 84 pages found on this site/);
  });
});
