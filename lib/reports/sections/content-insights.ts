/**
 * Content Insights Section
 * Displays new data from Phase 1-3 analyzers:
 * - Language detection
 * - Content similarity
 * - Internal PageRank distribution
 * - CTA/conversion analysis
 * - Code coverage
 * - Outbound link health
 * - Response header analysis
 * - Word count by section
 */

import { escapeHtml } from '../html-utils';
import { shortDomain, formatPercentDelta } from '../comparison-helpers';
import type { PageInfo, ReportSectionData, ComparisonData } from '../../types';

/**
 * Generate the content insights section
 * @param {Object} data - Report data
 * @returns {string} HTML string
 */
function getContentInsights(data: ReportSectionData) {
  const { jsonData, comparison } = data;

  if (comparison) {
    return getComparisonContentInsights(jsonData, comparison);
  }

  const pageData = (jsonData.pageData ?? {}) as Record<string, unknown>;
  const pages = (pageData.pages ?? {}) as Record<string, PageInfo>;
  const pagesArray: PageInfo[] = Object.values(pages);

  if (pagesArray.length === 0) return '';

  const sections = [
    getPageRankSection(pagesArray),
    getContentSimilaritySection(pagesArray),
    getLanguageSection(pagesArray),
    getCTASection(pagesArray),
    getCodeCoverageSection(pagesArray),
    getOutboundLinksSection(pagesArray),
    getResponseHeadersSection(pagesArray),
    getWordCountBreakdown(pagesArray),
  ].filter(Boolean);

  if (sections.length === 0) return '';

  return `
    <div class="charts-section" id="content-insights">
      <h2 style="text-align: center; color: var(--gray-800); margin-bottom: 10px;">🔍 Content & Technical Insights</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">Advanced analysis across ${pagesArray.length} pages</p>
      ${sections.join('')}
    </div>
  `;
}

function extractPages(jsonData: Record<string, unknown>): PageInfo[] {
  const pageData = (jsonData.pageData ?? {}) as Record<string, unknown>;
  const pages = (pageData.pages ?? {}) as Record<string, PageInfo>;
  return Object.values(pages);
}

function getComparisonContentInsights(jsonData: Record<string, unknown>, comparison: ComparisonData) {
  const originPages = extractPages(jsonData);
  const comparePages = extractPages(comparison.compareJsonData);

  if (originPages.length === 0 && comparePages.length === 0) return '';

  const originLabel = shortDomain(comparison.originDomainName);
  const compareLabel = shortDomain(comparison.compareDomainName);

  const sections = [
    getComparisonCTASection(originPages, comparePages, originLabel, compareLabel),
    getComparisonCodeCoverageSection(originPages, comparePages, originLabel, compareLabel),
    getComparisonOutboundLinksSection(originPages, comparePages, originLabel, compareLabel),
  ].filter(Boolean);

  if (sections.length === 0) return '';

  return `
    <div class="charts-section" id="content-insights">
      <h2 style="text-align: center; color: var(--gray-800); margin-bottom: 10px;">🔍 Content & Technical Insights (Comparison)</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">${originLabel}: ${originPages.length} pages | ${compareLabel}: ${comparePages.length} pages</p>
      ${sections.join('')}
    </div>
  `;
}

function getComparisonCTASection(
  originPages: PageInfo[],
  comparePages: PageInfo[],
  originLabel: string,
  compareLabel: string,
) {
  const getCTAStats = (pages: PageInfo[]) => {
    const withCTA = pages.filter((p) => p.ctaData?.summary);
    let forms = 0,
      buttons = 0,
      phone = 0,
      email = 0,
      noCTAs = 0;
    for (const page of withCTA) {
      const s = page.ctaData?.summary;
      if (!s) continue;
      forms += s.forms ?? 0;
      buttons += s.ctaButtons ?? 0;
      phone += s.phoneLinks ?? 0;
      email += s.emailLinks ?? 0;
      if (s.total === 0) noCTAs++;
    }
    return { forms, buttons, phone, email, noCTAs, total: withCTA.length };
  };

  const o = getCTAStats(originPages);
  const c = getCTAStats(comparePages);
  if (o.total === 0 && c.total === 0) return '';

  const dualStat = (label: string, icon: string, oVal: number, cVal: number, color: string) => `
    <div style="background: var(--color-bg-surface); padding: 12px; border-radius: var(--radius-lg); text-align: center; border: 1px solid var(--color-border-default);">
      <div style="font-size: var(--font-size-md);">${icon}</div>
      <div style="display: flex; justify-content: center; gap: 12px; margin: 4px 0;">
        <div><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: ${color};">${oVal}</span></div>
        <div><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: ${color};">${cVal}</span></div>
      </div>
      <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${label}</div>
      ${oVal !== cVal ? `<div style="font-size: var(--font-size-2xs); margin-top: 2px;">${formatPercentDelta(oVal, cVal, true)}</div>` : ''}
    </div>`;

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🎯 Conversion Elements</h3>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
        ${dualStat('Forms', '📝', o.forms, c.forms, 'var(--color-info)')}
        ${dualStat('CTA Buttons', '🔘', o.buttons, c.buttons, 'var(--purple-500)')}
        ${dualStat('Phone Links', '📞', o.phone, c.phone, 'var(--color-success)')}
        ${dualStat('Email Links', '✉️', o.email, c.email, 'var(--color-warning)')}
      </div>
    </div>`;
}

function getComparisonCodeCoverageSection(
  originPages: PageInfo[],
  comparePages: PageInfo[],
  originLabel: string,
  compareLabel: string,
) {
  const getCoverage = (pages: PageInfo[]) => {
    const withCoverage = pages.filter((p) => (p.codeCoverage?.totalBytes ?? 0) > 0);
    let totalJS = 0,
      unusedJS = 0,
      totalCSS = 0,
      unusedCSS = 0;
    for (const page of withCoverage) {
      totalJS += page.codeCoverage?.js?.total ?? 0;
      unusedJS += page.codeCoverage?.js?.unused ?? 0;
      totalCSS += page.codeCoverage?.css?.total ?? 0;
      unusedCSS += page.codeCoverage?.css?.unused ?? 0;
    }
    return {
      jsRatio: totalJS > 0 ? Math.round((unusedJS / totalJS) * 100) : 0,
      cssRatio: totalCSS > 0 ? Math.round((unusedCSS / totalCSS) * 100) : 0,
      count: withCoverage.length,
    };
  };

  const o = getCoverage(originPages);
  const c = getCoverage(comparePages);
  if (o.count === 0 && c.count === 0) return '';

  const barColor = (ratio: number) =>
    ratio > 60 ? 'var(--color-error)' : ratio > 40 ? 'var(--color-warning)' : 'var(--color-success)';

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">📦 Code Coverage</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div style="background: var(--color-bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
          <div style="font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); margin-bottom: 10px;">JavaScript Unused</div>
          <div style="display: flex; gap: 16px; justify-content: center;">
            <div style="text-align: center;"><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${barColor(o.jsRatio)};">${o.jsRatio}%</span></div>
            <div style="text-align: center;"><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${barColor(c.jsRatio)};">${c.jsRatio}%</span></div>
          </div>
          <div style="text-align: center; margin-top: 6px;">${formatPercentDelta(o.jsRatio, c.jsRatio, true)}</div>
        </div>
        <div style="background: var(--color-bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
          <div style="font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); margin-bottom: 10px;">CSS Unused</div>
          <div style="display: flex; gap: 16px; justify-content: center;">
            <div style="text-align: center;"><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${barColor(o.cssRatio)};">${o.cssRatio}%</span></div>
            <div style="text-align: center;"><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${barColor(c.cssRatio)};">${c.cssRatio}%</span></div>
          </div>
          <div style="text-align: center; margin-top: 6px;">${formatPercentDelta(o.cssRatio, c.cssRatio, true)}</div>
        </div>
      </div>
    </div>`;
}

function getComparisonOutboundLinksSection(
  originPages: PageInfo[],
  comparePages: PageInfo[],
  originLabel: string,
  compareLabel: string,
) {
  const getStats = (pages: PageInfo[]) => {
    const withData = pages.filter((p) => (p.outboundLinkHealth?.totalChecked ?? 0) > 0);
    let checked = 0,
      broken = 0,
      redirected = 0;
    const brokenUrls = new Map<string, { status: number; count: number; site: string }>();
    for (const page of withData) {
      const h = page.outboundLinkHealth;
      if (!h) continue;
      checked += h.totalChecked ?? 0;
      broken += h.broken?.length ?? 0;
      redirected += h.redirected?.length ?? 0;
      for (const b of h.broken ?? []) {
        const key = b.url;
        if (!brokenUrls.has(key)) brokenUrls.set(key, { status: b.status, count: 0, site: '' });
        const entry = brokenUrls.get(key);
        if (entry) entry.count++;
      }
    }
    return { checked, broken, redirected, brokenUrls };
  };

  const o = getStats(originPages);
  const c = getStats(comparePages);
  if (o.checked === 0 && c.checked === 0) return '';

  // Merge broken URLs from both origins with site labels
  const allBroken = new Map<string, { status: number; originCount: number; compareCount: number }>();
  Array.from(o.brokenUrls.entries()).forEach(([url, data]) => {
    allBroken.set(url, { status: data.status, originCount: data.count, compareCount: 0 });
  });
  Array.from(c.brokenUrls.entries()).forEach(([url, data]) => {
    if (allBroken.has(url)) {
      allBroken.get(url)!.compareCount = data.count;
    } else {
      allBroken.set(url, { status: data.status, originCount: 0, compareCount: data.count });
    }
  });

  const brokenList = Array.from(allBroken.entries())
    .sort((a, b) => b[1].originCount + b[1].compareCount - (a[1].originCount + a[1].compareCount))
    .slice(0, 15)
    .map(([url, data]) => {
      const statusColor =
        data.status >= 500
          ? 'var(--red-600)'
          : data.status >= 400
            ? 'var(--orange-ea580c, #ea580c)'
            : 'var(--color-text-muted)';
      const oLabel =
        data.originCount > 0
          ? `<span style="color: var(--color-info);">${data.originCount}</span>`
          : '<span style="color: var(--color-border-strong);">0</span>';
      const cLabel =
        data.compareCount > 0
          ? `<span style="color: var(--purple-400);">${data.compareCount}</span>`
          : '<span style="color: var(--color-border-strong);">0</span>';
      const badge =
        data.originCount > 0 && data.compareCount === 0
          ? '<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:9999px;font-size:var(--font-size-2xs);margin-left:4px;">Fixed</span>'
          : data.originCount === 0 && data.compareCount > 0
            ? '<span style="background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:9999px;font-size:var(--font-size-2xs);margin-left:4px;">New</span>'
            : '';
      return `<tr style="border-bottom: 1px solid var(--color-bg-surface-alt);"><td style="padding: 6px 8px; font-size: var(--font-size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0;" title="${escapeHtml(url)}"><a href="${escapeHtml(url)}" target="_blank" style="color: #dc2626; display: block; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(url)}</a>${badge}</td><td style="padding: 6px 8px; font-size: var(--font-size-xs); text-align: center; color: ${statusColor}; font-weight: var(--font-weight-semibold); white-space: nowrap;">${data.status ?? '?'}</td><td style="padding: 6px 8px; font-size: var(--font-size-xs); text-align: center; white-space: nowrap;">${oLabel}</td><td style="padding: 6px 8px; font-size: var(--font-size-xs); text-align: center; white-space: nowrap;">${cLabel}</td></tr>`;
    })
    .join('');

  const brokenTable =
    allBroken.size > 0
      ? `
      <table style="width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--color-border-default); border-radius: var(--radius-md); overflow: hidden; margin-top: 12px;">
        <colgroup><col><col style="width: 70px;"><col style="width: 80px;"><col style="width: 80px;"></colgroup>
        <thead><tr style="background: var(--color-bg-page); border-bottom: 2px solid #e5e7eb;">
          <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); font-weight: var(--font-weight-semibold);">Broken URL</th>
          <th style="padding: 8px; font-size: var(--font-size-xs); color: var(--color-text-muted); font-weight: var(--font-weight-semibold); text-align: center;">Status</th>
          <th style="padding: 8px; font-size: var(--font-size-xs); color: var(--color-info); font-weight: var(--font-weight-semibold); text-align: center;">${escapeHtml(originLabel)}</th>
          <th style="padding: 8px; font-size: var(--font-size-xs); color: var(--purple-400); font-weight: var(--font-weight-semibold); text-align: center;">${escapeHtml(compareLabel)}</th>
        </tr></thead>
        <tbody>${brokenList}</tbody>
      </table>`
      : '';

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🔗 Outbound Link Health</h3>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
        <div style="background: var(--color-success-bg); padding: 12px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-xs); color: #047857; margin-bottom: 4px;">Checked</div>
          <div style="display: flex; justify-content: center; gap: 12px;">
            <div><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #059669;">${o.checked}</span></div>
            <div><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #059669;">${c.checked}</span></div>
          </div>
        </div>
        <div style="background: ${o.broken > 0 || c.broken > 0 ? '#fef2f2' : '#f0fdf4'}; padding: 12px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-xs); color: ${o.broken > 0 || c.broken > 0 ? '#991b1b' : '#047857'}; margin-bottom: 4px;">Broken</div>
          <div style="display: flex; justify-content: center; gap: 12px;">
            <div><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: ${o.broken > 0 ? 'var(--red-600)' : 'var(--green-emerald-600)'};">${o.broken}</span></div>
            <div><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: ${c.broken > 0 ? 'var(--red-600)' : 'var(--green-emerald-600)'};">${c.broken}</span></div>
          </div>
        </div>
        <div style="background: var(--amber-100); padding: 12px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-xs); color: #a16207; margin-bottom: 4px;">Redirected</div>
          <div style="display: flex; justify-content: center; gap: 12px;">
            <div><span style="font-size: var(--font-size-2xs); color: var(--color-info);">${originLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #92400e;">${o.redirected}</span></div>
            <div><span style="font-size: var(--font-size-2xs); color: var(--purple-400);">${compareLabel}</span><br><span style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #92400e;">${c.redirected}</span></div>
          </div>
        </div>
      </div>
      ${brokenTable}
    </div>`;
}

function getPageRankSection(pages: PageInfo[]) {
  const ranked = pages
    .filter((p) => p.internalPageRank != null)
    .sort((a, b) => (b.internalPageRank ?? 0) - (a.internalPageRank ?? 0));

  if (ranked.length < 2) return '';

  const top10 = ranked.slice(0, 10);
  const bottom5 = ranked.slice(-5).reverse();

  const topRows = top10
    .map((p, i) => {
      let shortUrl;
      try {
        shortUrl = new URL(p.url).pathname;
      } catch {
        shortUrl = p.url;
      }
      if (shortUrl.length > 50) shortUrl = '...' + shortUrl.slice(-47);
      const prVal = p.internalPageRank ?? 0;
      const topVal = top10[0].internalPageRank ?? 0;
      const barWidth = topVal > 0 ? Math.round((prVal / topVal) * 100) : 0;
      return `
      <tr>
        <td style="padding: 6px 8px; font-size: var(--font-size-xs); color: var(--color-text-disabled);">${i + 1}</td>
        <td style="padding: 6px 8px; font-size: var(--font-size-sm);"><a href="${escapeHtml(p.url)}" target="_blank" style="color: #2563eb; text-decoration: none;">${escapeHtml(shortUrl)}</a></td>
        <td style="padding: 6px 8px; width: 200px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="flex: 1; height: 8px; background: var(--color-border-default); border-radius: var(--radius-sm); overflow: hidden;">
              <div style="width: ${barWidth}%; height: 100%; background: linear-gradient(90deg, var(--indigo-500), var(--purple-500)); border-radius: var(--radius-sm);"></div>
            </div>
            <span style="font-size: var(--font-size-xs); color: var(--color-text-muted); min-width: 40px;">${(prVal * 100).toFixed(1)}</span>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  const bottomRows = bottom5
    .map((p, i) => {
      let shortUrl;
      try {
        shortUrl = new URL(p.url).pathname;
      } catch {
        shortUrl = p.url;
      }
      if (shortUrl.length > 40) shortUrl = '...' + shortUrl.slice(-37);
      return `<tr><td style="padding: 4px 8px; font-size: var(--font-size-xs); color: var(--color-text-disabled);">${ranked.length - i}</td><td style="padding: 4px 8px; font-size: var(--font-size-xs);"><a href="${escapeHtml(p.url)}" target="_blank" style="color: var(--color-text-muted);">${escapeHtml(shortUrl)}</a></td><td style="padding: 4px 8px; font-size: var(--font-size-xs); color: #ef4444;">${((p.internalPageRank ?? 0) * 100).toFixed(2)}</td></tr>`;
    })
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🏆 Internal PageRank Distribution</h3>
      <p style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 15px;">Estimated internal link equity. Higher scores indicate pages receiving more internal link authority.</p>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <h4 style="font-size: var(--font-size-sm); color: #059669; margin-bottom: 8px;">Top 10 Pages</h4>
          <table style="width: 100%; border-collapse: collapse;"><tbody>${topRows}</tbody></table>
        </div>
        <div>
          <h4 style="font-size: var(--font-size-sm); color: #dc2626; margin-bottom: 8px;">Lowest Equity Pages</h4>
          <table style="width: 100%; border-collapse: collapse;"><tbody>${bottomRows}</tbody></table>
        </div>
      </div>
    </div>`;
}

function getContentSimilaritySection(pages: PageInfo[]) {
  const withSimilarity = pages.filter((p) => ((p.contentSimilarity?.groupSize as number) ?? 0) > 1);
  if (withSimilarity.length === 0) return '';

  // Group by similarity groups
  const groups: Record<string, { urls: string[]; size: number }> = {};
  for (const page of withSimilarity) {
    const cs = page.contentSimilarity as Record<string, unknown>;
    const similarPages = (cs.similarPages ?? []) as string[];
    const key = [page.url, ...similarPages].sort().join('|');
    if (!groups[key]) {
      groups[key] = {
        urls: [page.url, ...similarPages],
        size: cs.groupSize as number,
      };
    }
  }

  const groupList = Object.values(groups).slice(0, 5);
  const groupHtml = groupList
    .map((g) => {
      const urls = g.urls
        .slice(0, 4)
        .map((u: string) => {
          let short;
          try {
            short = new URL(u).pathname;
          } catch {
            short = u;
          }
          return `<li style="font-size: var(--font-size-xs); margin: 2px 0;"><a href="${escapeHtml(u)}" target="_blank" style="color: #2563eb;">${escapeHtml(short)}</a></li>`;
        })
        .join('');
      return `<div style="background: var(--amber-100); padding: 10px; border-radius: var(--radius-md); margin-bottom: 8px;">
      <div style="font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: #92400e; margin-bottom: 4px;">${g.size} similar pages</div>
      <ul style="margin: 0; padding-left: 16px;">${urls}${g.urls.length > 4 ? `<li style="font-size: var(--font-size-xs); color: #92400e;">...and ${g.urls.length - 4} more</li>` : ''}</ul>
    </div>`;
    })
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">📑 Near-Duplicate Content</h3>
      <div style="display: flex; gap: 15px; margin-bottom: 15px;">
        <div style="background: var(--amber-100); padding: 15px 20px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: #92400e;">${withSimilarity.length}</div>
          <div style="font-size: var(--font-size-xs); color: #a16207;">Pages affected</div>
        </div>
        <div style="background: var(--amber-100); padding: 15px 20px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: #92400e;">${Object.keys(groups).length}</div>
          <div style="font-size: var(--font-size-xs); color: #a16207;">Similarity groups</div>
        </div>
      </div>
      ${groupHtml}
    </div>`;
}

function getLanguageSection(pages: PageInfo[]) {
  const withLang = pages.filter((p) => p.languageDetection?.detectedLanguage);
  if (withLang.length === 0) return '';

  const langCounts: Record<string, number> = {};
  let mismatches = 0;
  let missingLang = 0;

  for (const page of withLang) {
    const detection = page.languageDetection;
    if (!detection?.detectedLanguage) continue;
    const lang = detection.detectedLanguage;
    langCounts[lang] = (langCounts[lang] ?? 0) + 1;
    if (detection.match === false) mismatches++;
    if (!detection.htmlLang) missingLang++;
  }

  const langBars = Object.entries(langCounts)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 5)
    .map(([lang, count]) => {
      const pct = Math.round(((count as number) / withLang.length) * 100);
      const label = `${count} pages (${pct}%)`;
      // For narrow bars, show label outside so it doesn't get clipped
      const labelInside = pct >= 15;
      return `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
        <span style="min-width: 30px; font-weight: var(--font-weight-semibold); font-size: var(--font-size-sm); text-transform: uppercase;">${escapeHtml(lang)}</span>
        <div style="flex: 1; height: 20px; background: var(--color-border-default); border-radius: var(--radius-sm); position: relative;">
          <div style="width: ${pct}%; height: 100%; background: #3b82f6; border-radius: var(--radius-sm);"></div>
          <span style="position: absolute; top: 0; left: 8px; line-height: 20px; font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: ${labelInside ? 'white' : '#374151'};">${label}</span>
        </div>
      </div>`;
    })
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🌐 Language Detection</h3>
      <div style="display: flex; gap: 15px; margin-bottom: 15px;">
        ${
          mismatches > 0
            ? `<div style="background: var(--color-error-bg); padding: 12px 16px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #dc2626;">${mismatches}</div>
          <div style="font-size: var(--font-size-xs); color: #991b1b;">Language mismatches</div>
        </div>`
            : ''
        }
        ${
          missingLang > 0
            ? `<div style="background: var(--amber-100); padding: 12px 16px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #92400e;">${missingLang}</div>
          <div style="font-size: var(--font-size-xs); color: #a16207;">Missing lang attr</div>
        </div>`
            : ''
        }
      </div>
      ${langBars}
    </div>`;
}

function getCTASection(pages: PageInfo[]) {
  const withCTA = pages.filter((p) => p.ctaData?.summary);
  if (withCTA.length === 0) return '';

  let totalForms = 0,
    totalCTAButtons = 0,
    totalPhone = 0,
    totalEmail = 0;
  let pagesWithNoCTAs = 0,
    pagesWithAboveFoldCTA = 0;

  for (const page of withCTA) {
    const s = page.ctaData!.summary;
    totalForms += s.forms ?? 0;
    totalCTAButtons += s.ctaButtons ?? 0;
    totalPhone += s.phoneLinks ?? 0;
    totalEmail += s.emailLinks ?? 0;
    if (s.total === 0) pagesWithNoCTAs++;
    if (s.aboveFoldCount > 0) pagesWithAboveFoldCTA++;
  }

  const cards = [
    { label: 'Forms', value: totalForms, icon: '📝', color: 'var(--color-info)' },
    { label: 'CTA Buttons', value: totalCTAButtons, icon: '🔘', color: 'var(--purple-500)' },
    { label: 'Phone Links', value: totalPhone, icon: '📞', color: 'var(--color-success)' },
    { label: 'Email Links', value: totalEmail, icon: '✉️', color: 'var(--color-warning)' },
  ]
    .map(
      (c) => `
    <div style="background: var(--color-bg-surface); padding: 15px; border-radius: var(--radius-lg); text-align: center; border: 1px solid var(--color-border-default);">
      <div style="font-size: var(--font-size-lg);">${c.icon}</div>
      <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${c.color};">${c.value}</div>
      <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${c.label}</div>
    </div>`,
    )
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🎯 Conversion Elements</h3>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 15px;">${cards}</div>
      <div style="display: flex; gap: 12px;">
        <div style="padding: 10px 16px; background: ${pagesWithNoCTAs > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: var(--radius-md); font-size: var(--font-size-sm);">
          <strong>${pagesWithNoCTAs}</strong> pages with no CTAs
        </div>
        <div style="padding: 10px 16px; background: var(--color-success-bg); border-radius: var(--radius-md); font-size: var(--font-size-sm);">
          <strong>${pagesWithAboveFoldCTA}</strong> pages with above-fold CTAs
        </div>
      </div>
    </div>`;
}

function getCodeCoverageSection(pages: PageInfo[]) {
  const withCoverage = pages.filter((p) => (p.codeCoverage?.totalBytes ?? 0) > 0);
  if (withCoverage.length === 0) return '';

  let totalJS = 0,
    unusedJS = 0,
    totalCSS = 0,
    unusedCSS = 0;
  for (const page of withCoverage) {
    totalJS += page.codeCoverage?.js?.total ?? 0;
    unusedJS += page.codeCoverage?.js?.unused ?? 0;
    totalCSS += page.codeCoverage?.css?.total ?? 0;
    unusedCSS += page.codeCoverage?.css?.unused ?? 0;
  }

  const jsRatio = totalJS > 0 ? Math.round((unusedJS / totalJS) * 100) : 0;
  const cssRatio = totalCSS > 0 ? Math.round((unusedCSS / totalCSS) * 100) : 0;
  const jsColor = jsRatio > 60 ? 'var(--color-error)' : jsRatio > 40 ? 'var(--color-warning)' : 'var(--color-success)';
  const cssColor =
    cssRatio > 70 ? 'var(--color-error)' : cssRatio > 50 ? 'var(--color-warning)' : 'var(--color-success)';

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">📦 Code Coverage</h3>
      <p style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 15px;">Based on ${withCoverage.length} pages with coverage data</p>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div style="background: var(--color-bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
          <div style="font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); margin-bottom: 10px;">JavaScript</div>
          <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${jsColor};">${jsRatio}% unused</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: 4px;">${(unusedJS / 1024).toFixed(0)}KB unused of ${(totalJS / 1024).toFixed(0)}KB total</div>
          <div style="height: 8px; background: var(--color-border-default); border-radius: var(--radius-sm); margin-top: 10px; overflow: hidden;">
            <div style="width: ${100 - jsRatio}%; height: 100%; background: #10b981; border-radius: var(--radius-sm);"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: var(--font-size-2xs); color: var(--color-text-muted); margin-top: 4px;">
            <span>Used ${100 - jsRatio}%</span><span>Unused ${jsRatio}%</span>
          </div>
        </div>
        <div style="background: var(--color-bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
          <div style="font-size: var(--font-size-base); font-weight: var(--font-weight-semibold); margin-bottom: 10px;">CSS</div>
          <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); color: ${cssColor};">${cssRatio}% unused</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: 4px;">${(unusedCSS / 1024).toFixed(0)}KB unused of ${(totalCSS / 1024).toFixed(0)}KB total</div>
          <div style="height: 8px; background: var(--color-border-default); border-radius: var(--radius-sm); margin-top: 10px; overflow: hidden;">
            <div style="width: ${100 - cssRatio}%; height: 100%; background: #3b82f6; border-radius: var(--radius-sm);"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: var(--font-size-2xs); color: var(--color-text-muted); margin-top: 4px;">
            <span>Used ${100 - cssRatio}%</span><span>Unused ${cssRatio}%</span>
          </div>
        </div>
      </div>
    </div>`;
}

function getOutboundLinksSection(pages: PageInfo[]) {
  const withData = pages.filter((p) => (p.outboundLinkHealth?.totalChecked ?? 0) > 0);
  if (withData.length === 0) return '';

  let totalChecked = 0,
    totalBroken = 0,
    totalRedirected = 0;
  const brokenUrls = new Map();

  for (const page of withData) {
    const h = page.outboundLinkHealth;
    if (!h) continue;
    totalChecked += h.totalChecked ?? 0;
    totalBroken += h.broken?.length ?? 0;
    totalRedirected += h.redirected?.length ?? 0;
    for (const b of h.broken ?? []) {
      if (!brokenUrls.has(b.url)) brokenUrls.set(b.url, { status: b.status, count: 0 });
      brokenUrls.get(b.url).count++;
    }
  }

  if (totalChecked === 0) return '';

  const brokenList = Array.from(brokenUrls.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([url, data]) => {
      const statusColor =
        data.status >= 500
          ? 'var(--red-600)'
          : data.status >= 400
            ? 'var(--orange-ea580c, #ea580c)'
            : 'var(--color-text-muted)';
      return `<tr style="border-bottom: 1px solid var(--color-bg-surface-alt);"><td style="padding: 6px 8px; font-size: var(--font-size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0;" title="${escapeHtml(url)}"><a href="${escapeHtml(url)}" target="_blank" style="color: #dc2626; display: block; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(url)}</a></td><td style="padding: 6px 8px; font-size: var(--font-size-xs); text-align: center; color: ${statusColor}; font-weight: var(--font-weight-semibold); white-space: nowrap;">${data.status ?? '?'}</td><td style="padding: 6px 8px; font-size: var(--font-size-xs); text-align: center; white-space: nowrap;">${data.count}</td></tr>`;
    })
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🔗 Outbound Link Health</h3>
      <div style="display: flex; gap: 12px; margin-bottom: 15px;">
        <div style="background: var(--color-success-bg); padding: 12px 20px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #059669;">${totalChecked}</div>
          <div style="font-size: var(--font-size-xs); color: #047857;">Checked</div>
        </div>
        <div style="background: ${totalBroken > 0 ? '#fef2f2' : '#f0fdf4'}; padding: 12px 20px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: ${totalBroken > 0 ? 'var(--red-600)' : 'var(--green-emerald-600)'};">${totalBroken}</div>
          <div style="font-size: var(--font-size-xs); color: ${totalBroken > 0 ? '#991b1b' : '#047857'};">Broken</div>
        </div>
        <div style="background: var(--amber-100); padding: 12px 20px; border-radius: var(--radius-lg); text-align: center;">
          <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: #92400e;">${totalRedirected}</div>
          <div style="font-size: var(--font-size-xs); color: #a16207;">Redirected</div>
        </div>
      </div>
      ${brokenList ? `<table style="width: 100%; table-layout: fixed; border-collapse: collapse; border: 1px solid var(--color-border-default); border-radius: var(--radius-md); overflow: hidden;"><colgroup><col><col style="width: 70px;"><col style="width: 80px;"></colgroup><thead><tr style="background: var(--color-bg-page); border-bottom: 2px solid #e5e7eb;"><th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); font-weight: var(--font-weight-semibold);">Broken URL</th><th style="padding: 8px; font-size: var(--font-size-xs); color: var(--color-text-muted); font-weight: var(--font-weight-semibold); text-align: center;">Status</th><th style="padding: 8px; font-size: var(--font-size-xs); color: var(--color-text-muted); font-weight: var(--font-weight-semibold); text-align: center;">Pages</th></tr></thead><tbody>${brokenList}</tbody></table>` : ''}
    </div>`;
}

function getResponseHeadersSection(pages: PageInfo[]) {
  const withData = pages.filter((p) => p.responseHeaderAnalysis);
  if (withData.length === 0) return '';

  let withXRobotsNoindex = 0,
    withDynamicServing = 0,
    withPreloadHints = 0,
    withHttpCanonical = 0;
  for (const page of withData) {
    const h = page.responseHeaderAnalysis;
    if (!h) continue;
    if (h.noindexViaHeader) withXRobotsNoindex++;
    if (h.dynamicServing) withDynamicServing++;
    if ((h.preloadHints?.length ?? 0) > 0) withPreloadHints++;
    if (h.httpCanonical) withHttpCanonical++;
  }

  // Only show if there's something interesting
  if (withXRobotsNoindex === 0 && withDynamicServing === 0 && withPreloadHints === 0 && withHttpCanonical === 0)
    return '';

  const items = [];
  if (withXRobotsNoindex > 0)
    items.push(
      `<span style="background: var(--color-error-bg); color: #991b1b; padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-xs);">${withXRobotsNoindex} noindex via X-Robots-Tag</span>`,
    );
  if (withDynamicServing > 0)
    items.push(
      `<span style="background: var(--amber-100); color: #92400e; padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-xs);">${withDynamicServing} dynamic serving (Vary: User-Agent)</span>`,
    );
  if (withPreloadHints > 0)
    items.push(
      `<span style="background: var(--color-success-bg); color: #059669; padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-xs);">${withPreloadHints} with Link preload hints</span>`,
    );
  if (withHttpCanonical > 0)
    items.push(
      `<span style="background: var(--blue-50); color: #1d4ed8; padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-xs);">${withHttpCanonical} with HTTP canonical</span>`,
    );

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">📨 Response Header Signals</h3>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">${items.join('')}</div>
    </div>`;
}

function getWordCountBreakdown(pages: PageInfo[]) {
  const withData = pages.filter((p) => p.contentQuality?.wordCountBySection);
  if (withData.length < 3) return '';

  const totals = { main: 0, nav: 0, header: 0, footer: 0, sidebar: 0 };
  for (const page of withData) {
    const s = page.contentQuality?.wordCountBySection as Record<string, number> | undefined;
    if (!s || Array.isArray(s)) continue;
    totals.main += s.main ?? 0;
    totals.nav += s.nav ?? 0;
    totals.header += s.header ?? 0;
    totals.footer += s.footer ?? 0;
    totals.sidebar += s.sidebar ?? 0;
  }

  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  if (total === 0) return '';

  const boilerplate = totals.nav + totals.header + totals.footer;
  const boilerplateRatio = Math.round((boilerplate / total) * 100);

  const segments = [
    { label: 'Main Content', value: totals.main, color: 'var(--color-success)' },
    { label: 'Navigation', value: totals.nav, color: 'var(--color-warning)' },
    { label: 'Header', value: totals.header, color: 'var(--color-info)' },
    { label: 'Footer', value: totals.footer, color: 'var(--purple-500)' },
    { label: 'Sidebar', value: totals.sidebar, color: '#ec4899' },
  ].filter((s) => s.value > 0);

  const bars = segments
    .map((s) => {
      const pct = Math.round((s.value / total) * 100);
      return `<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
      <span style="min-width: 100px; font-size: var(--font-size-xs); color: var(--color-text-secondary);">${s.label}</span>
      <div style="flex: 1; height: 16px; background: var(--color-border-default); border-radius: var(--radius-sm); overflow: hidden;">
        <div style="width: ${pct}%; height: 100%; background: ${s.color}; border-radius: var(--radius-sm);"></div>
      </div>
      <span style="min-width: 80px; font-size: var(--font-size-xs); color: var(--color-text-muted); text-align: right;">${Math.round(s.value / withData.length)} avg (${pct}%)</span>
    </div>`;
    })
    .join('');

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">📊 Word Count by Section</h3>
      <p style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 15px;">Average word distribution across ${withData.length} pages. Boilerplate ratio: <strong style="color: ${boilerplateRatio > 50 ? 'var(--color-error)' : 'var(--color-success)'};">${boilerplateRatio}%</strong></p>
      ${bars}
    </div>`;
}

export { getContentInsights };
