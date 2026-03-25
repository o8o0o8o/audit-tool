/**
 * Performance Statistics Section
 * Displays statistical analysis of performance metrics
 */

import { METRIC_INFO, THRESHOLDS } from '../metrics-metadata';
import { escapeHtml, getMetricColor } from '../html-utils';
import { extractComparisonLabels, formatPercentDelta } from '../comparison-helpers';
import { statAvg, statPercentile, shortenUrl } from '../../utils';
import type { PageInfo, ReportSectionData, MetricInfoEntry, ComparisonData } from '../../types';

/**
 * Generate the performance statistics section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the performance stats section
 */
function getPerformanceStats(data: ReportSectionData) {
  if (data.comparison) {
    return getComparisonPerformanceStats(data.jsonData, data.comparison);
  }

  const { jsonData } = data;
  const pageData = jsonData.pageData as Record<string, unknown> | undefined;
  const pages = (pageData?.pages ?? {}) as Record<string, PageInfo>;
  const pagesArray: PageInfo[] = Object.values(pages);
  const cruxData = (jsonData.cruxData ?? null) as Record<string, unknown> | null;
  // Check for pages with Core Web Vitals (stored at top level as TTFB, LCP, CLS, INP)
  const pagesWithPerf = pagesArray.filter((p) => p.TTFB ?? p.LCP ?? p.CLS ?? p.INP);

  if (pagesWithPerf.length === 0 && !cruxData) return '';

  // Calculate statistics - metrics are stored at top level (TTFB, LCP, CLS)
  const ttfbValues = pagesWithPerf
    .map((p) => p.TTFB ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const lcpValues = pagesWithPerf
    .map((p) => p.LCP ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const clsValues = pagesWithPerf
    .map((p) => p.CLS ?? 0)
    .filter((v) => v >= 0)
    .sort((a, b) => a - b);
  const fcpValues = pagesWithPerf
    .map((p) => p.FCP ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const inpValues = pagesWithPerf
    .map((p) => p.INP ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const pageSizes = pagesArray
    .map((p) => p.totalResponseSize ?? 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const avg = (arr: number[]): string | number =>
    arr.length > 0 ? statAvg(arr).toFixed(0) : 0;
  const p50 = (arr: number[]) => statPercentile(arr, 0.5);
  const p75 = (arr: number[]) => statPercentile(arr, 0.75);
  const p95 = (arr: number[]) => statPercentile(arr, 0.95);
  const p99 = (arr: number[]) => statPercentile(arr, 0.99);

  // Build CrUX comparison section if available
  const cruxSection = cruxData
    ? getCrUXSection(cruxData, { ttfbValues, lcpValues, clsValues, fcpValues, inpValues }, p75)
    : '';

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: var(--gray-800); margin-bottom: 10px;">📈 Performance Statistics</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">Statistical analysis based on ${pagesWithPerf.length} pages with performance data</p>

      ${cruxSection}

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${ttfbValues.length > 0 ? getStatCard('ttfb', '⚡ TTFB', 'var(--purple-500)', 'var(--purple-600)', ttfbValues, 'ms', avg, p50, p75, p95, p99) : ''}
        ${lcpValues.length > 0 ? getStatCard('lcp', '🎨 LCP', 'var(--pink-500)', '#db2777', lcpValues, 'ms', avg, p50, p75, p95, p99) : ''}
        ${clsValues.length > 0 ? getClsCard(clsValues, avg, p50, p75, p95, p99) : ''}
        ${inpValues.length > 0 ? getStatCard('inp', '👆 INP', 'var(--orange-500)', '#ea580c', inpValues, 'ms', avg, p50, p75, p95, p99) : ''}
        ${pageSizes.length > 0 ? getPageSizeCard(pageSizes, avg, p50, p75, p95, p99) : ''}
      </div>

      ${getVitalsAttributionSection(pagesArray)}
      ${getSlowestPagesSection(pagesArray)}
    </div>
  `;
}

/**
 * Generate CrUX comparison section
 */
function getCrUXSection(
  cruxData: Record<string, unknown>,
  labMetrics: {
    ttfbValues: number[];
    lcpValues: number[];
    clsValues: number[];
    fcpValues: number[];
    inpValues: number[];
  },
  p75Fn: (arr: number[]) => number,
) {
  if (!cruxData?.metrics) return '';

  const labP75 = {
    LCP: labMetrics.lcpValues.length > 0 ? p75Fn(labMetrics.lcpValues) : null,
    CLS: labMetrics.clsValues.length > 0 ? p75Fn(labMetrics.clsValues) : null,
    TTFB: labMetrics.ttfbValues.length > 0 ? p75Fn(labMetrics.ttfbValues) : null,
    FCP: labMetrics.fcpValues.length > 0 ? p75Fn(labMetrics.fcpValues) : null,
    INP: labMetrics.inpValues.length > 0 ? p75Fn(labMetrics.inpValues) : null,
  };

  const metrics = cruxData.metrics as Record<string, Record<string, unknown>> | undefined;
  const metricsHtml = ['LCP', 'CLS', 'INP', 'TTFB', 'FCP']
    .map((metric) => {
      const fieldData = metrics?.[metric] as Record<string, unknown> | undefined;
      if (!fieldData) return '';

      const percentiles = fieldData.percentiles as Record<string, unknown> | undefined;
      const fieldP75 = Number(percentiles?.p75);
      if (isNaN(fieldP75)) return '';

      const dist = (fieldData.distribution ?? {}) as Record<string, number>;
      const labValue = (labP75 as Record<string, number | null>)[metric];

      // Format values
      const fieldDisplay = metric === 'CLS' ? fieldP75.toFixed(2) : `${Math.round(fieldP75)}ms`;
      const labDisplay =
        labValue != null ? (metric === 'CLS' ? labValue.toFixed(3) : `${Math.round(labValue)}ms`) : 'N/A';

      // Determine threshold status
      const thresholds: Record<string, number> = { LCP: 2500, CLS: 0.1, INP: 200, TTFB: 800, FCP: 1800 };
      const threshold = thresholds[metric];
      const isPassing = metric === 'CLS' ? fieldP75 <= threshold : fieldP75 <= threshold;
      const statusColor = isPassing ? 'var(--color-success)' : 'var(--color-error)';
      const statusText = isPassing ? 'Good' : 'Needs Improvement';

      // Compare lab vs field
      let comparisonText = '';
      if (labValue != null) {
        const diff = labValue - fieldP75;
        const percentDiff = fieldP75 > 0 ? Math.round(Math.abs(diff / fieldP75) * 100) : 0;
        if (diff > fieldP75 * 0.2) {
          comparisonText = `<span style="color: var(--color-warning); font-size: var(--font-size-xs);">Lab ${percentDiff}% slower</span>`;
        } else if (diff < -fieldP75 * 0.2) {
          comparisonText = `<span style="color: var(--color-success); font-size: var(--font-size-xs);">Lab ${percentDiff}% faster</span>`;
        }
      }

      return `
      <div style="background: var(--color-bg-surface); padding: 15px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span style="font-weight: var(--font-weight-semibold); color: var(--color-text-secondary);">${metric}</span>
          <span style="font-size: var(--font-size-xs); color: ${statusColor}; font-weight: var(--font-weight-semibold);">${statusText}</span>
        </div>
        <div style="display: flex; gap: 20px; margin-bottom: 10px;">
          <div style="flex: 1;">
            <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: 2px;">🌐 Field (Real Users)</div>
            <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); color: var(--gray-800);">p75: ${fieldDisplay}</div>
          </div>
          <div style="flex: 1;">
            <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: 2px;">🔬 Lab (Test)</div>
            <div style="font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); color: var(--color-text-muted);">p75: ${labDisplay}</div>
          </div>
        </div>
        ${comparisonText}
        <div style="margin-top: 10px;">
          <div style="display: flex; height: 8px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-border-default);">
            <div style="width: ${dist.good || 0}%; background: var(--color-success);" title="Good: ${dist.good || 0}%"></div>
            <div style="width: ${dist.needsImprovement || 0}%; background: var(--color-warning);" title="Needs Improvement: ${dist.needsImprovement || 0}%"></div>
            <div style="width: ${dist.poor || 0}%; background: var(--color-error);" title="Poor: ${dist.poor || 0}%"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: var(--font-size-2xs); color: var(--color-text-muted); margin-top: 4px;">
            <span>Good ${dist.good || 0}%</span>
            <span>NI ${dist.needsImprovement || 0}%</span>
            <span>Poor ${dist.poor || 0}%</span>
          </div>
        </div>
      </div>
    `;
    })
    .filter(Boolean)
    .join('');

  if (!metricsHtml) return '';

  // Collection period info
  const period = cruxData.collectionPeriod as Record<string, Record<string, unknown>> | undefined;
  const periodText = period
    ? `Data from ${period.firstDate?.year ?? ''}/${period.firstDate?.month ?? ''}/${period.firstDate?.day ?? ''} to ${period.lastDate?.year ?? ''}/${period.lastDate?.month ?? ''}/${period.lastDate?.day ?? ''}`
    : 'Last 28 days';

  return `
    <div style="margin-bottom: 30px; padding: 20px; background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border-radius: var(--radius-xl); border: 2px solid #10b981;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <div>
          <h3 style="margin: 0; color: var(--color-success-text); display: flex; align-items: center; gap: 8px;">
            🌐 Chrome UX Report (CrUX) - Real User Data
            <span style="background: var(--color-success); color: white; font-size: var(--font-size-2xs); padding: 2px 6px; border-radius: var(--radius-sm); font-weight: var(--font-weight-semibold);">FIELD DATA</span>
          </h3>
          <p style="margin: 5px 0 0; font-size: var(--font-size-xs); color: #047857;">
            Real-world performance from actual Chrome users. ${periodText}.
          </p>
        </div>
        <div style="text-align: right;">
          <div style="font-size: var(--font-size-xs); color: #047857;">Origin: ${cruxData.target ?? 'N/A'}</div>
          <div style="font-size: var(--font-size-xs); color: #047857;">Type: ${cruxData.targetType === 'origin' ? 'Origin-level' : 'URL-level'}</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
        ${metricsHtml}
      </div>
      <p style="margin: 15px 0 0; font-size: var(--font-size-xs); color: #047857; text-align: center;">
        ℹ️ Field data from real users is more accurate than lab tests. Lab tests show controlled conditions; field data shows actual user experience.
      </p>
    </div>
  `;
}

/**
 * Generate a stat card with description from METRIC_INFO
 */
function getStatCard(
  metricKey: string,
  icon: string,
  gradientStart: string,
  gradientEnd: string,
  values: number[],
  unit: string,
  avg: (arr: number[]) => string | number,
  p50: (arr: number[]) => number,
  p75: (arr: number[]) => number,
  p95: (arr: number[]) => number,
  p99: (arr: number[]) => number,
) {
  const info = METRIC_INFO[metricKey] ?? {};
  const fullName = info.fullName ?? metricKey.toUpperCase();
  const description = info.description || '';
  const threshold = info.threshold ?? '';
  const learnMore = info.learnMore ?? '';

  return `
    <div style="background: linear-gradient(135deg, ${gradientStart} 0%, ${gradientEnd} 100%); color: white; padding: 20px; border-radius: var(--radius-lg);" title="${description}">
      <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 4px;">${icon} ${fullName}</div>
      <div style="font-size: var(--font-size-xs); opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}${unit}${learnMore ? ` • <a href="${learnMore}" target="_blank" style="color: white; text-decoration: underline;">Learn more</a>` : ''}</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: var(--font-size-xs);">
        <div><strong>Average:</strong> ${avg(values)}${unit}</div>
        <div><strong>P50:</strong> ${p50(values)}${unit}</div>
        <div><strong>P75:</strong> ${p75(values)}${unit}</div>
        <div><strong>P95:</strong> ${p95(values)}${unit}</div>
        <div><strong>P99:</strong> ${p99(values)}${unit}</div>
      </div>
    </div>
  `;
}

/**
 * Generate CLS stat card (special formatting)
 */
function getClsCard(
  clsValues: number[],
  avg: (arr: number[]) => string | number,
  p50: (arr: number[]) => number,
  p75: (arr: number[]) => number,
  p95: (arr: number[]) => number,
  p99: (arr: number[]) => number,
) {
  const info = METRIC_INFO.cls || ({} as MetricInfoEntry);
  const description = info.description || 'Measures visual stability by tracking unexpected layout shifts';
  const threshold = THRESHOLDS.CLS || 0.1;
  const learnMore = info.learnMore ?? '';

  return `
    <div style="background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%); color: white; padding: 20px; border-radius: var(--radius-lg);" title="${description}">
      <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 4px;">📐 Cumulative Layout Shift</div>
      <div style="font-size: var(--font-size-xs); opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}${learnMore ? ` • <a href="${learnMore}" target="_blank" style="color: white; text-decoration: underline;">Learn more</a>` : ''}</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: var(--font-size-xs);">
        <div><strong>Average:</strong> ${parseFloat(String(avg(clsValues))).toFixed(3)}</div>
        <div><strong>P50:</strong> ${p50(clsValues).toFixed(3)}</div>
        <div><strong>P75:</strong> ${p75(clsValues).toFixed(3)}</div>
        <div><strong>P95:</strong> ${p95(clsValues).toFixed(3)}</div>
        <div><strong>P99:</strong> ${p99(clsValues).toFixed(3)}</div>
      </div>
    </div>
  `;
}

/**
 * Generate page size stat card (special formatting)
 */
function getPageSizeCard(
  pageSizes: number[],
  avg: (arr: number[]) => string | number,
  p50: (arr: number[]) => number,
  p75: (arr: number[]) => number,
  p95: (arr: number[]) => number,
  p99: (arr: number[]) => number,
) {
  const info = METRIC_INFO.pageSize || ({} as MetricInfoEntry);
  const description = info.description || 'Total size of all resources loaded by the page';
  const threshold = (THRESHOLDS.PAGE_SIZE / (1024 * 1024)).toFixed(1);

  return `
    <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 20px; border-radius: var(--radius-lg);" title="${description}">
      <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 4px;">📦 Total Page Size</div>
      <div style="font-size: var(--font-size-xs); opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}MB • Smaller pages load faster</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: var(--font-size-xs);">
        <div><strong>Average:</strong> ${(parseFloat(String(avg(pageSizes))) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P50:</strong> ${(p50(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P75:</strong> ${(p75(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P95:</strong> ${(p95(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P99:</strong> ${(p99(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
      </div>
    </div>
  `;
}

/**
 * Generate slowest pages table
 */
function getSlowestPagesSection(pagesArray: PageInfo[]) {
  const slowest = pagesArray
    .filter((p) => p.TTFB && p.TTFB > 0)
    .sort((a, b) => (b.TTFB ?? 0) - (a.TTFB ?? 0))
    .slice(0, 5);

  if (slowest.length === 0) return '';

  const rows = slowest
    .map((p, i) => {
      const ttfbColor = getMetricColor(p.TTFB, THRESHOLDS.TTFB, true);
      const lcpColor = getMetricColor(p.LCP, THRESHOLDS.LCP, true);
      const shortUrl = shortenUrl(p.url);

      return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid var(--color-border-default); font-size: var(--font-size-xs); color: var(--color-text-disabled);">${i + 1}</td>
        <td style="padding: 8px; border-bottom: 1px solid var(--color-border-default); font-size: var(--font-size-sm); word-break: break-all;">
          <a href="${escapeHtml(p.url)}" target="_blank" style="color: var(--color-link); text-decoration: none;">${escapeHtml(shortUrl)}</a>
        </td>
        <td style="padding: 8px; border-bottom: 1px solid var(--color-border-default); font-weight: var(--font-weight-semibold); color: ${ttfbColor}; text-align: right;">${p.TTFB}ms</td>
        <td style="padding: 8px; border-bottom: 1px solid var(--color-border-default); font-weight: var(--font-weight-semibold); color: ${lcpColor}; text-align: right;">${p.LCP ? p.LCP + 'ms' : '—'}</td>
        <td style="padding: 8px; border-bottom: 1px solid var(--color-border-default); text-align: right;">${p.CLS ?? '—'}</td>
      </tr>
    `;
    })
    .join('');

  return `
    <div style="margin-top: 20px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🐢 Slowest Pages</h3>
      <div style="background: var(--color-bg-surface); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm);">
        <table style="width: 100%; border-collapse: collapse; min-width: auto;">
          <thead>
            <tr style="background: var(--color-bg-page);">
              <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted);">#</th>
              <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted);">URL</th>
              <th style="padding: 8px; text-align: right; font-size: var(--font-size-xs); color: var(--color-text-muted);">TTFB</th>
              <th style="padding: 8px; text-align: right; font-size: var(--font-size-xs); color: var(--color-text-muted);">LCP</th>
              <th style="padding: 8px; text-align: right; font-size: var(--font-size-xs); color: var(--color-text-muted);">CLS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Generate vitals attribution section (LCP bottleneck + CLS sources)
 */
function getVitalsAttributionSection(pagesArray: PageInfo[]) {
  const pagesWithAttribution = pagesArray.filter(
    (p) => (p.vitals?.lcpAnalysis as Record<string, unknown> | undefined)?.bottleneck,
  );
  if (pagesWithAttribution.length === 0) return '';

  // Count bottleneck types
  const bottleneckCounts: Record<string, number> = {};
  for (const p of pagesWithAttribution) {
    const bn = (p.vitals!.lcpAnalysis as Record<string, unknown>).bottleneck as string;
    bottleneckCounts[bn] = (bottleneckCounts[bn] || 0) + 1;
  }

  const sorted = Object.entries(bottleneckCounts).sort(([, a]: [string, number], [, b]: [string, number]) => b - a);
  const total = pagesWithAttribution.length;

  const bars = sorted
    .map(([bottleneck, count]: [string, number]) => {
      const pct = Math.round((count / total) * 100);
      const color = bottleneck.toLowerCase().includes('ttfb')
        ? 'var(--purple-500)'
        : bottleneck.toLowerCase().includes('load')
          ? 'var(--pink-500)'
          : bottleneck.toLowerCase().includes('render')
            ? 'var(--color-warning)'
            : 'var(--color-text-muted)';
      return `
      <div style="margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; font-size: var(--font-size-sm); margin-bottom: 2px;">
          <span style="color: var(--color-text-secondary); font-weight: var(--font-weight-medium);">${bottleneck}</span>
          <span style="color: var(--color-text-muted);">${count} pages (${pct}%)</span>
        </div>
        <div style="height: 8px; background: var(--color-border-default); border-radius: var(--radius-sm); overflow: hidden;">
          <div style="width: ${pct}%; height: 100%; background: ${color}; border-radius: var(--radius-sm);"></div>
        </div>
      </div>
    `;
    })
    .join('');

  // Sample recommendations
  const topBottleneck = sorted[0][0];
  const samplePage = pagesWithAttribution.find(
    (p) => (p.vitals!.lcpAnalysis as Record<string, unknown>).bottleneck === topBottleneck,
  );
  const recommendation = (samplePage?.vitals?.lcpAnalysis as Record<string, unknown> | undefined)?.recommendation ?? '';

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🔍 LCP Bottleneck Analysis</h3>
      <div style="background: var(--color-bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--color-border-default);">
        <p style="font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: 15px;">
          Analysis of ${total} pages with LCP data — showing what's slowing down the Largest Contentful Paint.
        </p>
        ${bars}
        ${
          recommendation
            ? `
        <div style="margin-top: 15px; padding: 12px; background: #fffbeb; border-radius: var(--radius-md); border-left: 3px solid var(--color-warning);">
          <div style="font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: #92400e; margin-bottom: 4px;">Top recommendation:</div>
          <div style="font-size: var(--font-size-sm); color: #78350f;">${escapeHtml(recommendation)}</div>
        </div>
        `
            : ''
        }
      </div>
    </div>
  `;
}

// ── Comparison performance stats ─────────────────────────────────────────────

function extractPerfValues(jsonData: Record<string, unknown>) {
  const pageData = jsonData.pageData as Record<string, unknown> | undefined;
  const pages = (pageData?.pages ?? {}) as Record<string, PageInfo>;
  const pagesArray: PageInfo[] = Object.values(pages);
  const pagesWithPerf = pagesArray.filter((p) => p.TTFB ?? p.LCP ?? p.CLS ?? p.INP);

  const extract = (arr: PageInfo[], fn: (p: PageInfo) => number | undefined, filterZero = true) => {
    const vals = arr.map(fn).filter((v): v is number => v !== undefined && v !== null);
    return filterZero ? vals.filter((v) => v > 0).sort((a, b) => a - b) : vals.sort((a, b) => a - b);
  };

  return {
    pagesWithPerf,
    ttfb: extract(pagesWithPerf, (p) => p.TTFB),
    lcp: extract(pagesWithPerf, (p) => p.LCP),
    cls: extract(pagesWithPerf, (p) => p.CLS, false).filter((v) => v >= 0),
    fcp: extract(pagesWithPerf, (p) => p.FCP),
    inp: extract(pagesWithPerf, (p) => p.INP),
    pageSize: extract(pagesArray, (p) => p.totalResponseSize as number | undefined),
  };
}

function getComparisonPerformanceStats(jsonData: Record<string, unknown>, comparison: ComparisonData) {
  const origin = extractPerfValues(jsonData);
  const compare = extractPerfValues(comparison.compareJsonData);

  if (origin.pagesWithPerf.length === 0 && compare.pagesWithPerf.length === 0) return '';

  const avg = (arr: number[]): number => Math.round(statAvg(arr));
  const p75 = (arr: number[]) => statPercentile(arr, 0.75);

  const { originLabel, compareLabel } = extractComparisonLabels(comparison);

  const metrics = [
    {
      key: 'ttfb',
      label: '⚡ TTFB',
      unit: 'ms',
      colors: ['var(--purple-500)', 'var(--purple-600)'],
      oVals: origin.ttfb,
      cVals: compare.ttfb,
    },
    {
      key: 'lcp',
      label: '🎨 LCP',
      unit: 'ms',
      colors: ['var(--pink-500)', '#db2777'],
      oVals: origin.lcp,
      cVals: compare.lcp,
    },
    {
      key: 'cls',
      label: '📐 CLS',
      unit: '',
      colors: ['#14b8a6', '#0d9488'],
      oVals: origin.cls,
      cVals: compare.cls,
      isCls: true,
    },
    {
      key: 'inp',
      label: '👆 INP',
      unit: 'ms',
      colors: ['var(--orange-500)', '#ea580c'],
      oVals: origin.inp,
      cVals: compare.inp,
    },
    {
      key: 'pageSize',
      label: '📦 Page Size',
      unit: 'MB',
      colors: ['var(--amber-500)', 'var(--amber-600)'],
      oVals: origin.pageSize,
      cVals: compare.pageSize,
      isSize: true,
    },
  ];

  const cards = metrics
    .filter((m) => m.oVals.length > 0 || m.cVals.length > 0)
    .map((m) => {
      const oAvg = avg(m.oVals);
      const cAvg = avg(m.cVals);
      const oP75 = p75(m.oVals);
      const cP75 = p75(m.cVals);

      const formatVal = (v: number) => {
        if (m.isCls) return v.toFixed(3);
        if (m.isSize) return (v / (1024 * 1024)).toFixed(2) + 'MB';
        return v + m.unit;
      };

      const delta = formatPercentDelta(oAvg, cAvg, true);

      const info = METRIC_INFO[m.key] ?? ({} as MetricInfoEntry);
      const fullName = info.fullName ?? m.label;

      return `
        <div style="background: linear-gradient(135deg, ${m.colors[0]} 0%, ${m.colors[1]} 100%); color: white; padding: 20px; border-radius: var(--radius-lg);">
          <div style="font-size: var(--font-size-base); opacity: 0.9; margin-bottom: 12px;">${m.label} ${fullName !== m.label ? `(${fullName})` : ''}</div>
          <div class="dual-stat-card">
            <div class="dual-stat-side">
              <div style="grid-column: 1 / -1; font-size: var(--font-size-2xs); font-weight: var(--font-weight-semibold); text-transform: uppercase; opacity: 0.8; margin-bottom: 4px; color: #93c5fd;">${originLabel}</div>
              <div><strong>Avg:</strong> ${formatVal(oAvg)}</div>
              <div><strong>P75:</strong> ${formatVal(oP75)}</div>
            </div>
            <div class="dual-stat-divider"></div>
            <div class="dual-stat-side">
              <div style="grid-column: 1 / -1; font-size: var(--font-size-2xs); font-weight: var(--font-weight-semibold); text-transform: uppercase; opacity: 0.8; margin-bottom: 4px; color: #c4b5fd;">${compareLabel}</div>
              <div><strong>Avg:</strong> ${formatVal(cAvg)}</div>
              <div><strong>P75:</strong> ${formatVal(cP75)}</div>
            </div>
          </div>
          <div style="text-align: center; margin-top: 10px; font-size: var(--font-size-xs);">${delta}</div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: var(--gray-800); margin-bottom: 10px;">📈 Performance Comparison</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">
        ${originLabel}: ${origin.pagesWithPerf.length} pages | ${compareLabel}: ${compare.pagesWithPerf.length} pages with performance data
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${cards}
      </div>

      ${getComparisonSlowestPages(origin.pagesWithPerf, compare.pagesWithPerf, originLabel, compareLabel)}
    </div>
  `;
}

function getComparisonSlowestPages(
  originPages: PageInfo[],
  comparePages: PageInfo[],
  originLabel: string,
  compareLabel: string,
) {
  const getTop5 = (pages: PageInfo[]) =>
    pages
      .filter((p) => p.TTFB && p.TTFB > 0)
      .sort((a, b) => (b.TTFB ?? 0) - (a.TTFB ?? 0))
      .slice(0, 5);

  const originSlowest = getTop5(originPages);
  const compareSlowest = getTop5(comparePages);

  if (originSlowest.length === 0 && compareSlowest.length === 0) return '';

  const renderRows = (pages: PageInfo[], label: string, badgeClass: string) =>
    pages
      .map((p, i) => {
        const ttfbColor =
          (p.TTFB ?? 0) > 1500
            ? 'var(--color-error)'
            : (p.TTFB ?? 0) > 800
              ? 'var(--color-warning)'
              : 'var(--color-success)';
        let shortUrl;
        try {
          shortUrl = new URL(p.url).pathname;
        } catch {
          shortUrl = p.url;
        }
        if (shortUrl.length > 40) shortUrl = '...' + shortUrl.slice(-37);

        return `
      <tr>
        <td style="padding: 6px 8px; font-size: var(--font-size-xs); color: var(--color-text-disabled);">${i + 1}</td>
        <td style="padding: 6px 8px;"><span class="site-badge ${badgeClass}">${escapeHtml(label)}</span></td>
        <td style="padding: 6px 8px; font-size: var(--font-size-sm);">
          <a href="${escapeHtml(p.url)}" target="_blank" style="color: var(--color-link); text-decoration: none;">${escapeHtml(shortUrl)}</a>
        </td>
        <td style="padding: 6px 8px; font-weight: var(--font-weight-semibold); color: ${ttfbColor}; text-align: right;">${p.TTFB}ms</td>
        <td style="padding: 6px 8px; text-align: right;">${p.LCP ? p.LCP + 'ms' : '—'}</td>
      </tr>
    `;
      })
      .join('');

  return `
    <div style="margin-top: 20px;">
      <h3 style="color: var(--gray-800); margin-bottom: 12px;">🐢 Slowest Pages</h3>
      <div style="background: var(--color-bg-surface); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm);">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--color-bg-page);">
              <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); width: 30px;">#</th>
              <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); width: 80px;">Site</th>
              <th style="padding: 8px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted);">URL</th>
              <th style="padding: 8px; text-align: right; font-size: var(--font-size-xs); color: var(--color-text-muted);">TTFB</th>
              <th style="padding: 8px; text-align: right; font-size: var(--font-size-xs); color: var(--color-text-muted);">LCP</th>
            </tr>
          </thead>
          <tbody>
            ${renderRows(originSlowest, originLabel, 'site-badge-origin')}
            ${renderRows(compareSlowest, compareLabel, 'site-badge-compare')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export { getPerformanceStats };
