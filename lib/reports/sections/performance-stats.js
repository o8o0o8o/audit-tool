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
  const cruxData = jsonData.cruxData || null;
  // Check for pages with Core Web Vitals (stored at top level as TTFB, LCP, CLS)
  const pagesWithPerf = pagesArray.filter(p => p.TTFB || p.LCP || p.CLS);

  if (pagesWithPerf.length === 0 && !cruxData) return '';

  // Calculate statistics - metrics are stored at top level (TTFB, LCP, CLS)
  const ttfbValues = pagesWithPerf.map(p => p.TTFB || 0).filter(v => v > 0).sort((a, b) => a - b);
  const lcpValues = pagesWithPerf.map(p => p.LCP || 0).filter(v => v > 0).sort((a, b) => a - b);
  const clsValues = pagesWithPerf.map(p => p.CLS || 0).filter(v => v >= 0).sort((a, b) => a - b);
  const pageSizes = pagesArray.map(p => p.totalResponseSize || 0).filter(v => v > 0).sort((a, b) => a - b);

  const avg = arr => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : 0;
  const p50 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.5)] : 0;
  const median = p50;
  const p75 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.75)] : 0;
  const p95 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : 0;
  const p99 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.99)] : 0;

  // Build CrUX comparison section if available
  const cruxSection = cruxData ? getCrUXSection(cruxData, { ttfbValues, lcpValues, clsValues }, p75) : '';

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Performance Statistics</h2>
      <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Statistical analysis based on ${pagesWithPerf.length} pages with performance data</p>

      ${cruxSection}

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${ttfbValues.length > 0 ? getStatCard('ttfb', '⚡ TTFB', '#8b5cf6', '#7c3aed', ttfbValues, 'ms', avg, p50, p75, p95, p99) : ''}
        ${lcpValues.length > 0 ? getStatCard('lcp', '🎨 LCP', '#ec4899', '#db2777', lcpValues, 'ms', avg, p50, p75, p95, p99) : ''}
        ${clsValues.length > 0 ? getClsCard(clsValues, avg, p50, p75, p95, p99) : ''}
        ${pageSizes.length > 0 ? getPageSizeCard(pageSizes, avg, p50, p75, p95, p99) : ''}
      </div>

      ${getCodeCoverageStats(pagesArray)}
      ${getSlowestPagesSection(pagesArray)}
    </div>
  `;
}

/**
 * Generate CrUX comparison section
 */
function getCrUXSection(cruxData, labMetrics, p75Fn) {
  if (!cruxData || !cruxData.metrics) return '';

  const labP75 = {
    LCP: labMetrics.lcpValues.length > 0 ? p75Fn(labMetrics.lcpValues) : null,
    CLS: labMetrics.clsValues.length > 0 ? p75Fn(labMetrics.clsValues) : null,
    TTFB: labMetrics.ttfbValues.length > 0 ? p75Fn(labMetrics.ttfbValues) : null,
  };

  const metricsHtml = ['LCP', 'CLS', 'INP', 'TTFB', 'FCP'].map(metric => {
    const fieldData = cruxData.metrics[metric];
    if (!fieldData) return '';

    const fieldP75 = Number(fieldData.percentiles?.p75);
    if (isNaN(fieldP75)) return '';

    const dist = fieldData.distribution || {};
    const labValue = labP75[metric];

    // Format values
    const fieldDisplay = metric === 'CLS' ? fieldP75.toFixed(2) : `${Math.round(fieldP75)}ms`;
    const labDisplay = labValue !== null
      ? (metric === 'CLS' ? labValue.toFixed(3) : `${Math.round(labValue)}ms`)
      : 'N/A';

    // Determine threshold status
    const thresholds = { LCP: 2500, CLS: 0.1, INP: 200, TTFB: 800, FCP: 1800 };
    const threshold = thresholds[metric];
    const isPassing = metric === 'CLS' ? fieldP75 <= threshold : fieldP75 <= threshold;
    const statusColor = isPassing ? '#10b981' : '#ef4444';
    const statusText = isPassing ? 'Good' : 'Needs Improvement';

    // Compare lab vs field
    let comparisonText = '';
    if (labValue !== null) {
      const diff = labValue - fieldP75;
      const percentDiff = fieldP75 > 0 ? Math.round(Math.abs(diff / fieldP75) * 100) : 0;
      if (diff > fieldP75 * 0.2) {
        comparisonText = `<span style="color: #f59e0b; font-size: 11px;">Lab ${percentDiff}% slower</span>`;
      } else if (diff < -fieldP75 * 0.2) {
        comparisonText = `<span style="color: #10b981; font-size: 11px;">Lab ${percentDiff}% faster</span>`;
      }
    }

    return `
      <div style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e5e7eb;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span style="font-weight: 600; color: #374151;">${metric}</span>
          <span style="font-size: 12px; color: ${statusColor}; font-weight: 600;">${statusText}</span>
        </div>
        <div style="display: flex; gap: 20px; margin-bottom: 10px;">
          <div style="flex: 1;">
            <div style="font-size: 11px; color: #6b7280; margin-bottom: 2px;">🌐 Field (Real Users)</div>
            <div style="font-size: 18px; font-weight: 700; color: #1f2937;">p75: ${fieldDisplay}</div>
          </div>
          <div style="flex: 1;">
            <div style="font-size: 11px; color: #6b7280; margin-bottom: 2px;">🔬 Lab (Test)</div>
            <div style="font-size: 18px; font-weight: 600; color: #6b7280;">p75: ${labDisplay}</div>
          </div>
        </div>
        ${comparisonText}
        <div style="margin-top: 10px;">
          <div style="display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #e5e7eb;">
            <div style="width: ${dist.good || 0}%; background: #10b981;" title="Good: ${dist.good || 0}%"></div>
            <div style="width: ${dist.needsImprovement || 0}%; background: #f59e0b;" title="Needs Improvement: ${dist.needsImprovement || 0}%"></div>
            <div style="width: ${dist.poor || 0}%; background: #ef4444;" title="Poor: ${dist.poor || 0}%"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: #6b7280; margin-top: 4px;">
            <span>Good ${dist.good || 0}%</span>
            <span>NI ${dist.needsImprovement || 0}%</span>
            <span>Poor ${dist.poor || 0}%</span>
          </div>
        </div>
      </div>
    `;
  }).filter(Boolean).join('');

  if (!metricsHtml) return '';

  // Collection period info
  const period = cruxData.collectionPeriod;
  const periodText = period
    ? `Data from ${period.firstDate?.year || ''}/${period.firstDate?.month || ''}/${period.firstDate?.day || ''} to ${period.lastDate?.year || ''}/${period.lastDate?.month || ''}/${period.lastDate?.day || ''}`
    : 'Last 28 days';

  return `
    <div style="margin-bottom: 30px; padding: 20px; background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border-radius: 12px; border: 2px solid #10b981;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <div>
          <h3 style="margin: 0; color: #065f46; display: flex; align-items: center; gap: 8px;">
            🌐 Chrome UX Report (CrUX) - Real User Data
            <span style="background: #10b981; color: white; font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600;">FIELD DATA</span>
          </h3>
          <p style="margin: 5px 0 0; font-size: 12px; color: #047857;">
            Real-world performance from actual Chrome users. ${periodText}.
          </p>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 11px; color: #047857;">Origin: ${cruxData.target || 'N/A'}</div>
          <div style="font-size: 11px; color: #047857;">Type: ${cruxData.targetType === 'origin' ? 'Origin-level' : 'URL-level'}</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
        ${metricsHtml}
      </div>
      <p style="margin: 15px 0 0; font-size: 11px; color: #047857; text-align: center;">
        ℹ️ Field data from real users is more accurate than lab tests. Lab tests show controlled conditions; field data shows actual user experience.
      </p>
    </div>
  `;
}

/**
 * Generate a stat card with description from METRIC_INFO
 */
function getStatCard(metricKey, icon, gradientStart, gradientEnd, values, unit, avg, p50, p75, p95, p99) {
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
function getClsCard(clsValues, avg, p50, p75, p95, p99) {
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
        <div><strong>P50:</strong> ${p50(clsValues).toFixed(0)}</div>
        <div><strong>P75:</strong> ${p75(clsValues).toFixed(0)}</div>
        <div><strong>P95:</strong> ${p95(clsValues).toFixed(0)}</div>
        <div><strong>P99:</strong> ${p99(clsValues).toFixed(0)}</div>
      </div>
    </div>
  `;
}

/**
 * Generate page size stat card (special formatting)
 */
function getPageSizeCard(pageSizes, avg, p50, p75, p95, p99) {
  const info = METRIC_INFO.pageSize || {};
  const description = info.description || 'Total size of all resources loaded by the page';
  const threshold = (THRESHOLDS.PAGE_SIZE / (1024 * 1024)).toFixed(1);

  return `
    <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 20px; border-radius: 8px;" title="${description}">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 4px;">📦 Total Page Size</div>
      <div style="font-size: 11px; opacity: 0.75; margin-bottom: 12px;">Target: ≤${threshold}MB • Smaller pages load faster</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
        <div><strong>Average:</strong> ${(parseFloat(avg(pageSizes)) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P50:</strong> ${(p50(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P75:</strong> ${(p75(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P95:</strong> ${(p95(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
        <div><strong>P99:</strong> ${(p99(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
      </div>
    </div>
  `;
}

/**
 * Generate code coverage summary cards
 */
function getCodeCoverageStats(pagesArray) {
  const jsPages = pagesArray.filter(p => p.codeCoverage?.js?.ratio != null);
  const cssPages = pagesArray.filter(p => p.codeCoverage?.css?.ratio != null);

  if (jsPages.length === 0 && cssPages.length === 0) return '';

  const avgJsUnused = jsPages.length > 0
    ? (jsPages.reduce((s, p) => s + p.codeCoverage.js.ratio, 0) / jsPages.length).toFixed(1)
    : null;
  const avgCssUnused = cssPages.length > 0
    ? (cssPages.reduce((s, p) => s + p.codeCoverage.css.ratio, 0) / cssPages.length).toFixed(1)
    : null;

  const jsColor = avgJsUnused > 60 ? '#ef4444' : avgJsUnused > 40 ? '#f59e0b' : '#10b981';
  const cssColor = avgCssUnused > 60 ? '#ef4444' : avgCssUnused > 40 ? '#f59e0b' : '#10b981';

  return `
    <div style="margin-bottom: 30px;">
      <h3 style="color: #1f2937; margin-bottom: 12px;">📦 Code Coverage</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
        ${avgJsUnused !== null ? `
          <div style="background: white; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: ${jsColor};">${avgJsUnused}%</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Avg Unused JavaScript</div>
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${jsPages.length} pages analyzed</div>
          </div>
        ` : ''}
        ${avgCssUnused !== null ? `
          <div style="background: white; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: ${cssColor};">${avgCssUnused}%</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Avg Unused CSS</div>
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">${cssPages.length} pages analyzed</div>
          </div>
        ` : ''}
        ${avgJsUnused !== null ? `
          <div style="background: white; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: #374151;">${(jsPages.reduce((s, p) => s + (p.codeCoverage.js.totalBytes || 0), 0) / (1024 * 1024)).toFixed(1)}MB</div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">Total JS Loaded</div>
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">across all pages</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Generate slowest pages table
 */
function getSlowestPagesSection(pagesArray) {
  const slowest = pagesArray
    .filter(p => p.TTFB && p.TTFB > 0)
    .sort((a, b) => (b.TTFB || 0) - (a.TTFB || 0))
    .slice(0, 5);

  if (slowest.length === 0) return '';

  const rows = slowest.map((p, i) => {
    const ttfbColor = p.TTFB > 1500 ? '#ef4444' : p.TTFB > 800 ? '#f59e0b' : '#10b981';
    const lcpColor = p.LCP > 4000 ? '#ef4444' : p.LCP > 2500 ? '#f59e0b' : '#10b981';
    let shortUrl;
    try { shortUrl = new URL(p.url).pathname; } catch { shortUrl = p.url; }
    if (shortUrl.length > 50) shortUrl = '...' + shortUrl.slice(-47);

    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">${i + 1}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; word-break: break-all;">
          <a href="${p.url}" target="_blank" style="color: #2563eb; text-decoration: none;">${shortUrl}</a>
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: ${ttfbColor}; text-align: right;">${p.TTFB}ms</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: ${lcpColor}; text-align: right;">${p.LCP ? p.LCP + 'ms' : '—'}</td>
        <td style="padding: 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${p.CLS !== undefined ? p.CLS : '—'}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="margin-top: 20px;">
      <h3 style="color: #1f2937; margin-bottom: 12px;">🐢 Slowest Pages</h3>
      <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <table style="width: 100%; border-collapse: collapse; min-width: auto;">
          <thead>
            <tr style="background: #f9fafb;">
              <th style="padding: 8px; text-align: left; font-size: 11px; color: #6b7280;">#</th>
              <th style="padding: 8px; text-align: left; font-size: 11px; color: #6b7280;">URL</th>
              <th style="padding: 8px; text-align: right; font-size: 11px; color: #6b7280;">TTFB</th>
              <th style="padding: 8px; text-align: right; font-size: 11px; color: #6b7280;">LCP</th>
              <th style="padding: 8px; text-align: right; font-size: 11px; color: #6b7280;">CLS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

module.exports = { getPerformanceStats };
