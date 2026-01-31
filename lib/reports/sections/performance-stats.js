/**
 * Performance Statistics Section
 * Displays statistical analysis of performance metrics
 */

const { METRIC_INFO, THRESHOLDS } = require('../metrics-metadata');

/**
 * Generate the performance statistics section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the performance stats section
 */
function getPerformanceStats(data) {
  const { jsonData } = data;
  const pages = jsonData.pageData?.pages || {};
  const pagesArray = Object.values(pages);
  // Check for pages with Core Web Vitals (stored at top level as TTFB, LCP, CLS)
  const pagesWithPerf = pagesArray.filter(p => p.TTFB || p.LCP || p.CLS);

  if (pagesWithPerf.length === 0) return '';

  // Calculate statistics - metrics are stored at top level (TTFB, LCP, CLS)
  const ttfbValues = pagesWithPerf.map(p => p.TTFB || 0).filter(v => v > 0).sort((a, b) => a - b);
  const lcpValues = pagesWithPerf.map(p => p.LCP || 0).filter(v => v > 0).sort((a, b) => a - b);
  const clsValues = pagesWithPerf.map(p => p.CLS || 0).filter(v => v >= 0).sort((a, b) => a - b);
  const pageSizes = pagesArray.map(p => p.totalResponseSize || 0).filter(v => v > 0).sort((a, b) => a - b);

  const avg = arr => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : 0;
  const median = arr => arr.length > 0 ? arr[Math.floor(arr.length / 2)] : 0;
  const p75 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.75)] : 0;
  const p95 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : 0;

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Performance Statistics</h2>
      <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Statistical analysis based on ${pagesWithPerf.length} pages with performance data</p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${ttfbValues.length > 0 ? getStatCard('ttfb', '⚡ TTFB', '#8b5cf6', '#7c3aed', ttfbValues, 'ms', avg, median, p75, p95) : ''}
        ${lcpValues.length > 0 ? getStatCard('lcp', '🎨 LCP', '#ec4899', '#db2777', lcpValues, 'ms', avg, median, p75, p95) : ''}
        ${clsValues.length > 0 ? getClsCard(clsValues, avg, median, p75, p95) : ''}
        ${pageSizes.length > 0 ? getPageSizeCard(pageSizes, avg, median, p75, p95) : ''}
      </div>
    </div>
  `;
}

/**
 * Generate a stat card with description from METRIC_INFO
 */
function getStatCard(metricKey, icon, gradientStart, gradientEnd, values, unit, avg, median, p75, p95) {
  const info = METRIC_INFO[metricKey] || {};
  const fullName = info.fullName || metricKey.toUpperCase();
  const description = info.description || '';
  const threshold = info.threshold || '';
  const learnMore = info.learnMore || '';

  return `
    <div style="background: linear-gradient(135deg, ${gradientStart} 0%, ${gradientEnd} 100%); color: white; padding: 20px; border-radius: 8px;" title="${description}">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 4px;">${icon} ${fullName}</div>
      <div style="font-size: 11px; opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}${unit}${learnMore ? ` • <a href="${learnMore}" target="_blank" style="color: white; text-decoration: underline;">Learn more</a>` : ''}</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
        <div><strong>Average:</strong> ${avg(values)}${unit}</div>
        <div><strong>Median:</strong> ${median(values)}${unit}</div>
        <div><strong>75th %ile:</strong> ${p75(values)}${unit}</div>
        <div><strong>95th %ile:</strong> ${p95(values)}${unit}</div>
      </div>
    </div>
  `;
}

/**
 * Generate CLS stat card (special formatting)
 */
function getClsCard(clsValues, avg, median, p75, p95) {
  const info = METRIC_INFO.cls || {};
  const description = info.description || 'Measures visual stability by tracking unexpected layout shifts';
  const threshold = THRESHOLDS.CLS || 0.1;
  const learnMore = info.learnMore || '';

  return `
    <div style="background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%); color: white; padding: 20px; border-radius: 8px;" title="${description}">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 4px;">📐 Cumulative Layout Shift</div>
      <div style="font-size: 11px; opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}${learnMore ? ` • <a href="${learnMore}" target="_blank" style="color: white; text-decoration: underline;">Learn more</a>` : ''}</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
        <div><strong>Average:</strong> ${(parseFloat(avg(clsValues)) / 1000).toFixed(3)}</div>
        <div><strong>Median:</strong> ${median(clsValues).toFixed(0)}</div>
        <div><strong>75th %ile:</strong> ${p75(clsValues).toFixed(0)}</div>
        <div><strong>95th %ile:</strong> ${p95(clsValues).toFixed(0)}</div>
      </div>
    </div>
  `;
}

/**
 * Generate page size stat card (special formatting)
 */
function getPageSizeCard(pageSizes, avg, median, p75, p95) {
  const info = METRIC_INFO.pageSize || {};
  const description = info.description || 'Total size of all resources loaded by the page';
  const threshold = (THRESHOLDS.PAGE_SIZE / (1024 * 1024)).toFixed(1);

  return `
    <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 20px; border-radius: 8px;" title="${description}">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 4px;">📦 Total Page Size</div>
      <div style="font-size: 11px; opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}MB • Smaller pages load faster</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
        <div><strong>Average:</strong> ${(parseFloat(avg(pageSizes)) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>Median:</strong> ${(median(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>75th %ile:</strong> ${(p75(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>95th %ile:</strong> ${(p95(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
      </div>
    </div>
  `;
}

module.exports = { getPerformanceStats };
