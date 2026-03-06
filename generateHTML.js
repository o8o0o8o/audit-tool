const fs = require("fs");
const path = require("path");

// Import validators for input sanitization
const { sanitizeDomainName } = require("./validators");

// Import report modules
const { ReportDataProcessor } = require("./lib/reports/data-processor");
const { THRESHOLDS } = require("./lib/reports/metrics-metadata");
const {
  escapeHtml,
  formatBytes,
  getStatusColor,
  getMetricColor,
  getTextLengthColor,
  hasMetaTag,
  getMissingMetaTags,
  hasHeadingStructureIssue,
  getMetricTooltip,
  getTextLengthTooltip,
} = require("./lib/reports/html-utils");

// Import section generators
const {
  getStyles,
  getScripts,
  getExecutiveSummary,
  getQuickWins,
  getTopIssues,
  getPerformanceStats,
  getHistoricalProgress,
  getChartsSection,
  getConfigInfo,
  getPagesTable,
  getTechnologyStack,
} = require("./lib/reports/sections");

function generateHTML(file, domainName, outputPath = null) {
  // Sanitize domain name to prevent injection
  const safeDomainName = sanitizeDomainName(domainName);

  // Determine output path
  const htmlOutputPath = outputPath || `${safeDomainName}.html`;

  // Load all data using the data processor with error recovery
  let reportData;
  let loadError = null;

  try {
    reportData = ReportDataProcessor.prepareReportData(file, domainName);
  } catch (error) {
    loadError = error;
    console.error(`⚠️  Error loading report data: ${error.message}`);
    console.error('Attempting partial recovery...');

    // Attempt to create minimal report data for error display
    reportData = {
      jsonData: {
        analysis: { overall: [], details: {}, bySeverity: {}, summary: { totalIssues: 0 } },
        sitemaps: { total: 0 },
        isMultiLang: false,
        scoring: null,
        quickWins: [],
      },
      pageData: { totalWithoutError: 0, totalWithError: 0 },
      pages: [],
      timing: {},
      trendData: null,
      previousAudit: null,
    };
  }

  const { jsonData, pageData, pages, timing, trendData, previousAudit } = reportData;

  const pagesWithMetrics = pages.filter(p => p.TTFB !== undefined);

  // Count pages by source
  const pagesFromSitemap = pages.filter(p => p.foundIn === 'sitemap').length;
  const pagesDiscovered = pages.filter(p => p.foundIn === 'discovered').length;

  let htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SEO Audit Report - ${escapeHtml(safeDomainName)}</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      ${getStyles()}
  </head>
  <body>
      <div class="container">
          <header>
              <h1>SEO Audit Report</h1>
              <p class="subtitle">${escapeHtml(safeDomainName)}</p>
              <p class="subtitle">Generated on ${new Date().toLocaleString()}</p>
              ${timing.elapsedTimeFormatted ? `<p class="subtitle">Duration: ${escapeHtml(timing.elapsedTimeFormatted)}</p>` : ''}
              <div class="stats">
                  <div class="stat">
                      <span class="stat-label">URLs in Sitemap:</span>
                      <span class="stat-value">${jsonData.sitemaps?.total || 0}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Pages Crawled:</span>
                      <span class="stat-value">${pages.length}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Successful:</span>
                      <span class="stat-value" style="color: #10b981;">${pageData.totalWithoutError || 0}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">With Errors:</span>
                      <span class="stat-value" style="color: #ef4444;">${pageData.totalWithError || 0}</span>
                  </div>
                  ${(jsonData.sitemaps?.total || 0) > pages.length ? `
                  <div class="stat">
                      <span class="stat-label">Not Crawled:</span>
                      <span class="stat-value" style="color: #f59e0b;">${(jsonData.sitemaps?.total || 0) - pages.length}</span>
                  </div>
                  ` : ''}
                  ${pagesWithMetrics.length > 0 ? `
                  <div class="stat">
                      <span class="stat-label">With Performance Data:</span>
                      <span class="stat-value">${pagesWithMetrics.length}</span>
                  </div>
                  ` : ''}
                  <div class="stat">
                      <span class="stat-label">From Sitemap:</span>
                      <span class="stat-value" style="color: #2563eb;">${pagesFromSitemap}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Discovered:</span>
                      <span class="stat-value" style="color: #f59e0b;">${pagesDiscovered}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Multilanguage:</span>
                      <span class="stat-value" style="color: ${jsonData.isMultiLang ? '#10b981' : '#9ca3af'};">${jsonData.isMultiLang ? 'Yes' : 'No'}</span>
                  </div>
              </div>

              <div class="export-section" style="margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 8px; backdrop-filter: blur(10px);">
                  <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                      <div style="font-size: 14px; opacity: 0.9;">
                          📊 <strong>Export Data:</strong> Download audit data for analysis in Excel, Google Sheets, or other tools
                      </div>
                      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                          <button onclick="exportCSV('pages')" class="export-btn">📄 Pages CSV</button>
                          <button onclick="showIssueFilterModal()" class="export-btn">⚠️ Issues CSV</button>
                          <button onclick="exportCSV('performance')" class="export-btn">⚡ Performance CSV</button>
                          <button onclick="exportCSV('quickwins')" class="export-btn">🎯 Quick Wins CSV</button>
                          <button onclick="exportCSV('summary')" class="export-btn">📊 Summary CSV</button>
                          <button onclick="saveToPDF()" class="pdf-btn">📥 Save to PDF</button>
                      </div>
                  </div>
              </div>

              <!-- Issue Export Filter Modal -->
              <div id="issueFilterModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
                  <div style="background: white; padding: 25px; border-radius: 12px; max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                      <h3 style="margin: 0 0 20px; color: #1f2937;">Export Issues - Filter Options</h3>
                      <div style="margin-bottom: 15px;">
                          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">Severity Levels:</label>
                          <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterCritical" checked> <span style="color: #ef4444;">Critical</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterHigh" checked> <span style="color: #f59e0b;">High</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterMedium" checked> <span style="color: #3b82f6;">Medium</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterLow" checked> <span style="color: #6b7280;">Low</span>
                              </label>
                          </div>
                      </div>
                      <div style="margin-bottom: 20px;">
                          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">Minimum Affected Pages:</label>
                          <input type="number" id="filterMinPages" value="1" min="1" style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                      </div>
                      <div style="display: flex; gap: 10px; justify-content: flex-end;">
                          <button onclick="hideIssueFilterModal()" style="padding: 8px 16px; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer;">Cancel</button>
                          <button onclick="exportFilteredIssues()" style="padding: 8px 16px; border: none; background: #3b82f6; color: white; border-radius: 6px; cursor: pointer;">Export CSV</button>
                      </div>
                  </div>
              </div>
          </header>

          ${loadError ? `
          <div class="section" style="background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <h2 style="color: #dc2626; margin-top: 0;">⚠️ Report Generation Error</h2>
              <p style="color: #991b1b;">An error occurred while loading the audit data. Some sections may be incomplete or missing.</p>
              <details style="margin-top: 10px;">
                  <summary style="cursor: pointer; color: #dc2626; font-weight: 600;">Error Details</summary>
                  <pre style="background: #fee2e2; padding: 10px; border-radius: 4px; margin-top: 10px; overflow-x: auto; color: #991b1b;">${escapeHtml(loadError.message)}${loadError.stack ? '\n\n' + escapeHtml(loadError.stack) : ''}</pre>
              </details>
              <p style="color: #6b7280; margin-top: 15px; font-size: 14px;">
                  <strong>Troubleshooting:</strong> Check that the audit data file exists and is not corrupted.
                  Try re-running the audit with <code>--proceed</code> flag to resume from the last checkpoint.
              </p>
          </div>
          ` : ''}

          ${getHistoricalProgress({ jsonData, trendData, previousAudit })}

          ${getExecutiveSummary({ jsonData })}

          ${getQuickWins({ jsonData })}

          ${getTopIssues({ jsonData })}

          ${getPerformanceStats({ jsonData })}

          ${getChartsSection()}

          ${getTechnologyStack({ pages })}

          ${getConfigInfo({ jsonData, pages })}

          ${getPagesTable({ pages, hasPerformanceMetrics: pagesWithMetrics.length > 0 })}

          <footer>
              <p>SEO Audit Tool - Generated with Node.js & Playwright</p>
          </footer>
      </div>

      <!-- Modal for detailed information -->
      <div class="modal-overlay" id="infoModal">
          <div class="modal-content">
              <div class="modal-header">
                  <h3 class="modal-title" id="modalTitle">Details</h3>
                  <button class="modal-close" id="modalClose">&times;</button>
              </div>
              <div class="modal-body">
                  <div class="modal-url" id="modalUrl"></div>
                  <div id="modalBody"></div>
              </div>
          </div>
      </div>

      ${getScripts({ pageData, jsonData, trendData, domainName })}
  </body>
  </html>`;

  try {
    fs.writeFileSync(htmlOutputPath, htmlContent);
    console.log(`✅ HTML report generated: ${htmlOutputPath}`);
  } catch (writeError) {
    console.error(`❌ Failed to write HTML report to ${htmlOutputPath}: ${writeError.message}`);
    throw writeError;
  }
}

module.exports = { generateHTML };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node generateHTML.js <json-file>');
    console.error('Example: node generateHTML.js audit-results/SEOAnalysis__example.com.json');
    console.error('Example: node generateHTML.js audit-results/domain.com/2026-01-01_12-00-00/manifest.json.gz');
    process.exit(1);
  }

  const jsonFile = args[0];
  if (!fs.existsSync(jsonFile)) {
    console.error(`Error: File not found: ${jsonFile}`);
    process.exit(1);
  }

  const basename = path.basename(jsonFile);
  let domainName;
  let outputPath;

  // Check if this is a multi-file format (manifest.json.gz)
  if (basename === 'manifest.json.gz' || basename === 'manifest.json') {
    // Extract domain from directory structure: audit-results/domain.com/timestamp/manifest.json.gz
    const dir = path.dirname(jsonFile);
    const parentDir = path.dirname(dir);
    domainName = path.basename(parentDir);

    // Output to same directory as manifest
    outputPath = path.join(dir, `${domainName}.html`);
    console.log(`Generating HTML report for ${domainName}...`);
  } else {
    // Legacy format: SEOAnalysis__domain.com.json.gz
    // Use sanitizeDomainName for consistent domain handling
    const rawDomain = basename.replace('SEOAnalysis__', '').replace(/\.json(\.gz)?$/, '');
    domainName = sanitizeDomainName(rawDomain);
    console.log(`Generating HTML report for ${domainName}...`);
  }

  generateHTML(jsonFile, domainName, outputPath);
}
