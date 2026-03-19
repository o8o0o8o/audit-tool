import * as fs from 'fs';
import * as path from 'path';
import pkg from './package.json';
import type { ReportSectionData } from './lib/types';

// Import validators for input sanitization
import { sanitizeDomainName } from './validators';

// Import report modules
import { ReportDataProcessor } from './lib/reports/data-processor';
import { escapeHtml } from './lib/reports/html-utils';
import { getComparisonHeader, shortDomain } from './lib/reports/comparison-helpers';

// Import section generators
import {
  getStyles,
  getScripts,
  getExecutiveSummary,
  getIssuesDetail,
  getPerformanceStats,
  getHistoricalProgress,
  getChartsSection,
  getConfigInfo,
  getPagesTable,
  getTechnologyStack,
  getSourceCodeAnalysis,
  getContentInsights,
} from './lib/reports/sections';

interface ComparisonOptions {
  compareFile: string;
  compareDomainName: string;
}

function generateHTML(file: string, domainName: string, outputPath: string | null = null, comparisonOpts?: ComparisonOptions) {
  // Sanitize domain name to prevent injection
  const safeDomainName = sanitizeDomainName(domainName);
  const isComparison = !!comparisonOpts;

  // Determine output path
  const htmlOutputPath = outputPath ?? `${safeDomainName}.html`;

  // Load all data using the data processor with error recovery
  let reportData;
  let loadError = null;

  try {
    if (isComparison) {
      reportData = ReportDataProcessor.prepareComparisonReportData(file, comparisonOpts!.compareFile, domainName, comparisonOpts!.compareDomainName);
    } else {
      reportData = ReportDataProcessor.prepareReportData(file, domainName);
    }
  } catch (error: unknown) {
    loadError = error;
    console.error(`⚠️  Error loading report data: ${(error as Error).message}`);
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

  const pagesWithMetrics = pages.filter((p) => p.TTFB !== undefined);

  // Count pages by source
  const pagesFromSitemap = pages.filter((p) => p.foundIn === 'sitemap').length;
  const pagesDiscovered = pages.filter((p) => p.foundIn === 'discovered').length;

  // Build section data object for report generators
  const sectionData: ReportSectionData = {
    jsonData,
    pages,
    pageData: pageData as ReportSectionData['pageData'],
    timing: timing as Record<string, unknown>,
    trendData: trendData as ReportSectionData['trendData'],
    previousAudit: previousAudit as ReportSectionData['previousAudit'],
    hasPerformanceMetrics: pagesWithMetrics.length > 0,
    comparison: (reportData as Record<string, unknown>).comparison as ReportSectionData['comparison'],
  };

  const safeCompareDomain = isComparison ? sanitizeDomainName(comparisonOpts!.compareDomainName) : '';

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${isComparison ? `SEO Comparison: ${escapeHtml(safeDomainName)} vs ${escapeHtml(safeCompareDomain)}` : `SEO Audit Report - ${escapeHtml(safeDomainName)}`}</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      ${getStyles()}
  </head>
  <body>
      <!-- Reading progress bar -->
      <div class="reading-progress" id="readingProgress"></div>

      <!-- Skip to content for keyboard users -->
      <a href="#executive-summary" class="skip-link">Skip to content</a>

      <!-- Dark mode toggle -->

      <!-- Sticky navigation sidebar -->
      <nav class="report-nav" id="reportNav" aria-label="Report sections">
          <a href="#executive-summary" title="Executive Summary">📊<span class="nav-label">Summary</span></a>
          <a href="#issues-detail" title="Issues">📋<span class="nav-label">Issues</span></a>
          <a href="#performance" title="Performance">⚡<span class="nav-label">Performance</span></a>
          <a href="#charts" title="Charts">📈<span class="nav-label">Charts</span></a>
          <a href="#content-insights" title="Content Insights">🔍<span class="nav-label">Insights</span></a>
          <a href="#pages-table" title="Pages Table">📄<span class="nav-label">Pages</span></a>
      </nav>

      <!-- Floating action button menu -->
      <div class="fab-container">
          <div class="fab-menu" id="fabMenu">
              <div class="fab-label">Share</div>
              <button class="fab-item" onclick="shareReport()">📤 Share Report</button>
              <button class="fab-item" onclick="copyScoreSummary()">📋 Copy Summary</button>
              <div class="fab-divider"></div>
              <div class="fab-label">Export</div>
              <button class="fab-item" onclick="exportCSV('summary')">📊 Summary CSV</button>
              <button class="fab-item" onclick="exportCSV('issues')">⚠️ Issues CSV</button>
              <button class="fab-item" onclick="exportCSV('pages')">📄 Pages CSV</button>
              <button class="fab-item" onclick="exportCSV('performance')">⚡ Performance CSV</button>
              <button class="fab-item" onclick="exportCSV('issues')">📋 Issues CSV</button>
              <button class="fab-item" onclick="exportMarkdown()">📝 Markdown</button>
              <button class="fab-item" onclick="saveToPDF()">📥 PDF</button>
              <button class="fab-item" onclick="exportAll()">📦 Export All</button>
          </div>
          <button class="fab-toggle" id="fabToggle" title="Quick actions">+</button>
      </div>

      <!-- Back to top button -->
      <button class="back-to-top" id="backToTop" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="Back to top (T)" aria-label="Back to top">↑</button>

      <!-- Global search -->
      <div class="global-search" id="globalSearch">
          <input type="text" id="globalSearchInput" placeholder="Search report..." autocomplete="off">
          <span class="search-count" id="searchCount"></span>
      </div>

      <!-- Keyboard shortcut hint -->
      <div class="keyboard-hint" id="keyboardHint">
          Press <kbd>?</kbd> for keyboard shortcuts &middot; <kbd>s</kbd> to search
      </div>

      <div class="container">
          <header>
              ${jsonData.branding?.logo ? `<img src="${escapeHtml(jsonData.branding.logo)}" alt="Logo" style="max-height:40px;margin-bottom:10px;">` : ''}
              <h1>${jsonData.branding?.name ? escapeHtml(jsonData.branding.name) + ' - ' : ''}${isComparison ? 'SEO Comparison Report' : 'SEO Audit Report'}</h1>
              <p class="subtitle">${isComparison ? `${escapeHtml(safeDomainName)} vs ${escapeHtml(safeCompareDomain)}` : escapeHtml(safeDomainName)}</p>
              <p class="subtitle">Generated on <time datetime="${new Date().toISOString()}" id="reportTimestamp">${new Date().toLocaleString()}</time></p>
              ${(timing as Record<string, unknown>).elapsedTimeFormatted ? `<p class="subtitle">Duration: ${escapeHtml((timing as Record<string, unknown>).elapsedTimeFormatted as string)}</p>` : ''}
              <div class="stats">
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
                  ${
                    (jsonData.sitemaps?.total ?? 0) > pages.length
                      ? `
                  <div class="stat">
                      <span class="stat-label">Not Crawled:</span>
                      <span class="stat-value" style="color: #f59e0b;">${(jsonData.sitemaps?.total ?? 0) - pages.length}</span>
                  </div>
                  `
                      : ''
                  }
                  ${
                    pagesWithMetrics.length > 0
                      ? `
                  <div class="stat">
                      <span class="stat-label">With Performance Data:</span>
                      <span class="stat-value">${pagesWithMetrics.length}</span>
                  </div>
                  `
                      : ''
                  }
                  <div class="stat">
                      <span class="stat-label">In Sitemap:</span>
                      <span class="stat-value" style="color: #2563eb;">${pagesFromSitemap}</span>
                  </div>
                  ${
                    pagesDiscovered > 0
                      ? `
                  <div class="stat">
                      <span class="stat-label">Discovered:</span>
                      <span class="stat-value" style="color: #f59e0b;">${pagesDiscovered}</span>
                  </div>
                  `
                      : ''
                  }
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
                          <button onclick="exportCSV('issues')" class="export-btn">📋 All Issues CSV</button>
                          <button onclick="exportCSV('summary')" class="export-btn">📊 Summary CSV</button>
                          <button onclick="saveToPDF()" class="pdf-btn">📥 Save to PDF</button>
                          <button onclick="exportMarkdown()" class="export-btn" style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);">📝 Markdown</button>
                          <button onclick="exportAll()" class="export-btn" style="background: linear-gradient(135deg, #ec4899 0%, #be185d 100%);">📦 Export All</button>
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

          ${
            loadError
              ? `
          <div class="section" style="background: #fef2f2; border: 1px solid #ef4444; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <h2 style="color: #dc2626; margin-top: 0;">⚠️ Report Generation Error</h2>
              <p style="color: #991b1b;">An error occurred while loading the audit data. Some sections may be incomplete or missing.</p>
              <details style="margin-top: 10px;">
                  <summary style="cursor: pointer; color: #dc2626; font-weight: 600;">Error Details</summary>
                  <pre style="background: #fee2e2; padding: 10px; border-radius: 4px; margin-top: 10px; overflow-x: auto; color: #991b1b;">${escapeHtml((loadError as Error).message)}${(loadError as Error).stack ? '\n\n' + escapeHtml((loadError as Error).stack!) : ''}</pre>
              </details>
              <p style="color: #6b7280; margin-top: 15px; font-size: 14px;">
                  <strong>Troubleshooting:</strong> Check that the audit data file exists and is not corrupted.
                  Try re-running the audit with <code>--proceed</code> flag to resume from the last checkpoint.
              </p>
          </div>
          `
              : ''
          }

          ${isComparison && sectionData.comparison ? getComparisonHeader(
              shortDomain(sectionData.comparison.originDomainName),
              shortDomain(sectionData.comparison.compareDomainName),
              {
                matched: sectionData.comparison.matchedPaths.length,
                originOnly: sectionData.comparison.originOnlyPaths.length,
                compareOnly: sectionData.comparison.compareOnlyPaths.length,
              }
          ) : ''}

          <!-- Section tabs for quick navigation -->
          <div class="section-tabs" id="sectionTabs">
              <button class="section-tab active" data-target="executive-summary">Summary</button>
              <button class="section-tab" data-target="issues-detail">Issues</button>
              <button class="section-tab" data-target="performance">Performance</button>
              <button class="section-tab" data-target="charts">Charts</button>
              <button class="section-tab" data-target="content-insights">Insights</button>
              <button class="section-tab" data-target="technology-stack">Tech Stack</button>
              <button class="section-tab" data-target="pages-table">Pages</button>
          </div>

          ${getHistoricalProgress(sectionData)}

          <div id="executive-summary">
          ${getExecutiveSummary(sectionData)}
          </div>

          <div id="issues-detail">
          ${getIssuesDetail(sectionData)}
          </div>

          <div id="performance">
          ${getPerformanceStats(sectionData)}
          </div>

          <div id="charts">
          ${getChartsSection()}
          </div>

          <div id="technology-stack">
          ${getTechnologyStack(sectionData)}
          </div>

          ${getSourceCodeAnalysis(sectionData)}

          <div id="content-insights">
          ${getContentInsights(sectionData)}
          </div>

          ${getConfigInfo(sectionData)}

          <div id="pages-table">
          ${getPagesTable(sectionData)}
          </div>

          <footer>
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                  <p>SEO Audit Tool v${pkg.version} - Generated ${new Date().toISOString()}</p>
                  <p style="opacity: 0.7;">Node.js ${process.version} | Playwright | ${pages.length} pages analyzed</p>
                  <div style="display: flex; gap: 8px;">
                      <button onclick="shareReport()" style="padding: 4px 12px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; cursor: pointer; font-size: 12px;">Share</button>
                      <button onclick="window.print()" style="padding: 4px 12px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; cursor: pointer; font-size: 12px;">Print</button>
                  </div>
              </div>
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

      <!-- Selection bar for bulk actions -->
      <div class="selection-bar" id="selectionBar">
          <span id="selectionCount">0 rows selected</span>
          <div>
              <button onclick="exportSelectedCSV()">Export Selected CSV</button>
              <button onclick="clearSelection()">Clear Selection</button>
          </div>
      </div>

      ${getScripts({ ...sectionData, domainName: safeDomainName })}
  </body>
  </html>`;

  try {
    fs.writeFileSync(htmlOutputPath, htmlContent);
    console.log(`✅ HTML report generated: ${htmlOutputPath}`);
  } catch (writeError: unknown) {
    console.error(`❌ Failed to write HTML report to ${htmlOutputPath}: ${(writeError as Error).message}`);
    throw writeError;
  }
}

export { generateHTML };
// CLI entry point
const isMainModule = typeof require !== 'undefined' && require.main === module;
const isDirectRun = process.argv[1]?.endsWith('generateHTML.ts') || process.argv[1]?.endsWith('generateHTML.js');
if (isMainModule || isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node generateHTML.js <json-file> [--compare=<json-file>]');
    console.error('Example: node generateHTML.js audit-results/SEOAnalysis__example.com.json');
    console.error('Example: node generateHTML.js audit-results/domain.com/2026-01-01_12-00-00/manifest.json.gz');
    console.error('Example: node generateHTML.js origin/manifest.json.gz --compare=compare/manifest.json.gz');
    process.exit(1);
  }

  // Parse --compare argument
  const compareArg = args.find(a => a.startsWith('--compare='));
  const compareFile = compareArg ? compareArg.substring('--compare='.length) : null;
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  const jsonFile = positionalArgs[0];
  if (!fs.existsSync(jsonFile)) {
    console.error(`Error: File not found: ${jsonFile}`);
    process.exit(1);
  }

  if (compareFile && !fs.existsSync(compareFile)) {
    console.error(`Error: Compare file not found: ${compareFile}`);
    process.exit(1);
  }

  const extractDomainFromFile = (file: string): { domainName: string; outputPath?: string } => {
    const bn = path.basename(file);
    if (bn === 'manifest.json.gz' || bn === 'manifest.json') {
      const dir = path.dirname(file);
      const parentDir = path.dirname(dir);
      const domain = path.basename(parentDir);
      return { domainName: domain, outputPath: path.join(dir, `${domain}.html`) };
    }
    const rawDomain = bn.replace('SEOAnalysis__', '').replace(/\.json(\.gz)?$/, '');
    return { domainName: sanitizeDomainName(rawDomain) };
  };

  const originInfo = extractDomainFromFile(jsonFile);
  const domainName = originInfo.domainName;
  const outputPath = originInfo.outputPath;

  if (compareFile) {
    const compareInfo = extractDomainFromFile(compareFile);
    const compOutputPath = outputPath
      ? path.join(path.dirname(outputPath), `${domainName}__vs__${compareInfo.domainName}.html`)
      : `${domainName}__vs__${compareInfo.domainName}.html`;
    console.log(`Generating comparison report: ${domainName} vs ${compareInfo.domainName}...`);
    generateHTML(jsonFile, domainName, compOutputPath, {
      compareFile,
      compareDomainName: compareInfo.domainName,
    });
  } else {
    console.log(`Generating HTML report for ${domainName}...`);
    generateHTML(jsonFile, domainName, outputPath);
  }
}
