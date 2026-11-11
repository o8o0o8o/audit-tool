import * as fs from 'fs';
import * as path from 'path';
import pkg from './package.json';
import type { ReportSectionData } from './lib/types';

// Import validators for input sanitization
import { sanitizeDomainName } from './validators';

// Import report modules
import { ReportDataProcessor } from './lib/reports/data-processor';
import { computePageCounts, type PageCounts } from './lib/utils/page-counts';
import { escapeHtml } from './lib/reports/html-utils';
import { getComparisonHeader, shortDomain } from './lib/reports/comparison-helpers';
import { categorize } from './lib/phase2/categorize';
import { auditTypeLabel, matchesChecks, type CheckName, type HtmlSectionId } from './lib/presets';

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

export interface HtmlReportSelection {
  /** Sections to render, in this order; `undefined` ⇒ every section in default order. */
  sections?: HtmlSectionId[];
  /** Check groups whose findings are kept; `undefined` ⇒ no finding filter. */
  checks?: CheckName[];
  /** Preset the audit ran with; shown as the audit type. `undefined` ⇒ "Full audit". */
  preset?: string;
  /** --no-score: omit every score and the scoring-rules block. */
  noScore?: boolean;
}

const NAV_LINKS: Partial<Record<HtmlSectionId, string>> = {
  'executive-summary':
    '<a href="#executive-summary" title="Executive Summary">📊<span class="nav-label">Summary</span></a>',
  'issues-detail': '<a href="#issues-detail" title="Issues">📋<span class="nav-label">Issues</span></a>',
  performance: '<a href="#performance" title="Performance">⚡<span class="nav-label">Performance</span></a>',
  charts: '<a href="#charts" title="Charts">📈<span class="nav-label">Charts</span></a>',
  'content-insights':
    '<a href="#content-insights" title="Content Insights">🔍<span class="nav-label">Insights</span></a>',
  'pages-table': '<a href="#pages-table" title="Pages Table">📄<span class="nav-label">Pages</span></a>',
};

const TAB_LABELS: Partial<Record<HtmlSectionId, string>> = {
  'executive-summary': 'Summary',
  'issues-detail': 'Issues',
  performance: 'Performance',
  charts: 'Charts',
  'content-insights': 'Insights',
  'technology-stack': 'Tech Stack',
  'pages-table': 'Pages',
};

const DEFAULT_NAV_ORDER: HtmlSectionId[] = [
  'executive-summary',
  'issues-detail',
  'performance',
  'charts',
  'content-insights',
  'pages-table',
];
const DEFAULT_TAB_ORDER: HtmlSectionId[] = [
  'executive-summary',
  'issues-detail',
  'performance',
  'charts',
  'content-insights',
  'technology-stack',
  'pages-table',
];
const DEFAULT_BODY_ORDER: HtmlSectionId[] = [
  'history',
  'executive-summary',
  'issues-detail',
  'performance',
  'charts',
  'technology-stack',
  'source-code',
  'content-insights',
  'pages-table',
];

function filterFindingsByChecks(jsonData: Record<string, unknown>, checks: readonly CheckName[]): void {
  const analysis = jsonData.analysis as
    | { details?: Record<string, unknown>; bySeverity?: Record<string, string[]>; overall?: unknown[] }
    | undefined;
  if (!analysis) return;
  const keep = (message: string) => matchesChecks(message, categorize(message), checks);
  if (analysis.details) {
    analysis.details = Object.fromEntries(Object.entries(analysis.details).filter(([message]) => keep(message)));
  }
  if (analysis.bySeverity) {
    for (const severity of Object.keys(analysis.bySeverity)) {
      analysis.bySeverity[severity] = analysis.bySeverity[severity].filter(keep);
    }
  }
  if (Array.isArray(analysis.overall)) {
    analysis.overall = analysis.overall.filter((m) => typeof m !== 'string' || keep(m));
  }
}


/** Header stats: Successful + With Errors always sum to Pages Crawled; load failures are listed apart. */
export function renderPageCountStats(counts: PageCounts): string {
  const stat = (label: string, value: number, color?: string) => `<div class="stat">
                      <span class="stat-label">${label}:</span>
                      <span class="stat-value"${color ? ` style="color: var(${color});"` : ''}>${value}</span>
                  </div>`;
  return [
    stat('Pages Crawled', counts.crawled),
    stat('Successful', counts.successful, '--color-success'),
    stat('With Errors', counts.withErrors, '--color-error'),
    ...(counts.failedToLoad > 0 ? [stat('Failed to load', counts.failedToLoad, '--color-warning')] : []),
  ].join('\n                  ');
}

function generateHTML(
  file: string,
  domainName: string,
  outputPath: string | null = null,
  comparisonOpts?: ComparisonOptions,
  selection: HtmlReportSelection = {},
) {
  // Sanitize domain name to prevent injection
  const safeDomainName = sanitizeDomainName(domainName);
  const isComparison = !!comparisonOpts;

  // Determine output path
  const htmlOutputPath = outputPath ?? `${safeDomainName}.html`;

  console.log('\n📝 Generating HTML report…');

  // Load all data using the data processor with error recovery
  let reportData;
  let loadError = null;

  try {
    if (isComparison && comparisonOpts) {
      reportData = ReportDataProcessor.prepareComparisonReportData(
        file,
        comparisonOpts.compareFile,
        domainName,
        comparisonOpts.compareDomainName,
      );
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
  if (selection.checks) filterFindingsByChecks(jsonData as Record<string, unknown>, selection.checks);

  const rawPageData = pageData as { pages?: Record<string, unknown>; byError?: Record<string, unknown> };
  const crawlCounts = computePageCounts(
    rawPageData.pages as Parameters<typeof computePageCounts>[0],
    rawPageData.byError ?? {},
  );

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
    noScore: selection.noScore === true,
  };

  const bodyFragments: Record<HtmlSectionId, () => string> = {
    history: () => getHistoricalProgress(sectionData),
    'executive-summary': () => `<div id="executive-summary">
          ${getExecutiveSummary(sectionData)}
          </div>`,
    'issues-detail': () => `<div id="issues-detail">
          ${getIssuesDetail(sectionData)}
          </div>`,
    performance: () => `<div id="performance">
          ${getPerformanceStats(sectionData)}
          </div>`,
    charts: () => `<div id="charts">
          ${getChartsSection()}
          </div>`,
    'technology-stack': () => `<div id="technology-stack">
          ${getTechnologyStack(sectionData)}
          </div>`,
    'source-code': () => getSourceCodeAnalysis(sectionData),
    'content-insights': () => `<div id="content-insights">
          ${getContentInsights(sectionData)}
          </div>`,
    'pages-table': () => `<div id="pages-table">
          ${getPagesTable(sectionData)}
          </div>`,
  };
  const chosen = selection.sections;
  const inOrder = (defaults: HtmlSectionId[]) => (chosen ? chosen.filter((id) => defaults.includes(id)) : defaults);
  const navLinks = inOrder(DEFAULT_NAV_ORDER)
    .map((id) => NAV_LINKS[id])
    .join('\n          ');
  const sectionTabs = inOrder(DEFAULT_TAB_ORDER)
    .map(
      (id, i) =>
        `<button class="section-tab${i === 0 ? ' active' : ''}" data-target="${id}">${TAB_LABELS[id]}</button>`,
    )
    .join('\n              ');
  const bodyHtml = inOrder(DEFAULT_BODY_ORDER).map((id) => bodyFragments[id]());
  // The default layout keeps config info just before the pages table; a preset puts it last.
  const configAt = chosen ? bodyHtml.length : bodyHtml.length - 1;
  bodyHtml.splice(configAt, 0, getConfigInfo(sectionData));
  const sectionsHtml = bodyHtml.join('\n\n          ');

  const safeCompareDomain = isComparison && comparisonOpts ? sanitizeDomainName(comparisonOpts.compareDomainName) : '';

  const htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${isComparison ? `Comparison: ${escapeHtml(safeDomainName)} vs ${escapeHtml(safeCompareDomain)}` : `Audit report - ${escapeHtml(safeDomainName)}`}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
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
          ${navLinks}
      </nav>

      <div class="container">
          <header>
              <div class="fr-header-bar">
                  <a class="fr-wordmark" href="https://focusreactive.com" target="_blank" rel="noopener">Focus Reactive<span class="fr-wordmark-dot">.</span></a>
                  <span class="fr-header-tag">Audit</span>
              </div>
              ${jsonData.branding?.logo ? `<img src="${escapeHtml(jsonData.branding.logo)}" alt="Logo" style="max-height:40px;margin-bottom:10px;">` : ''}
              <h1>${jsonData.branding?.name ? escapeHtml(jsonData.branding.name) + ' - ' : ''}${isComparison ? 'SEO Comparison Report' : 'Audit report'}</h1>
              <p class="subtitle">Audit type: ${escapeHtml(auditTypeLabel(selection.preset))}</p>
              <p class="subtitle">${isComparison ? `${escapeHtml(safeDomainName)} vs ${escapeHtml(safeCompareDomain)}` : escapeHtml(safeDomainName)}</p>
              <p class="subtitle">Generated on <time datetime="${new Date().toISOString()}" id="reportTimestamp">${new Date().toLocaleString()}</time></p>
              ${(timing as Record<string, unknown>).elapsedTimeFormatted ? `<p class="subtitle">Duration: ${escapeHtml((timing as Record<string, unknown>).elapsedTimeFormatted as string)}</p>` : ''}
              <div class="stats">
                  ${renderPageCountStats(crawlCounts)}
                  ${
                    (jsonData.sitemaps?.total ?? 0) > pages.length
                      ? `
                  <div class="stat">
                      <span class="stat-label">Not Crawled:</span>
                      <span class="stat-value" style="color: var(--color-warning);">${(jsonData.sitemaps?.total ?? 0) - pages.length}</span>
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
                      <span class="stat-value" style="color: var(--color-link);">${pagesFromSitemap}</span>
                  </div>
                  ${
                    pagesDiscovered > 0
                      ? `
                  <div class="stat">
                      <span class="stat-label">Discovered:</span>
                      <span class="stat-value" style="color: var(--color-warning);">${pagesDiscovered}</span>
                  </div>
                  `
                      : ''
                  }
                  <div class="stat">
                      <span class="stat-label">Multilanguage:</span>
                      <span class="stat-value" style="color: ${jsonData.isMultiLang ? 'var(--color-success)' : 'var(--color-text-muted)'};">${jsonData.isMultiLang ? 'Yes' : 'No'}</span>
                  </div>
              </div>

              <div class="export-section">
                  <div class="export-section-inner">
                      <div class="export-section-label">
                          📊 <strong>Export Data:</strong> Download audit data for analysis in Excel, Google Sheets, or other tools
                      </div>
                      <div class="export-section-actions">
                          <button onclick="exportCSV('pages')" class="export-btn fr-btn fr-btn--sm">📄 Pages CSV</button>
                          <button onclick="showIssueFilterModal()" class="export-btn fr-btn fr-btn--sm">⚠️ Issues CSV</button>
                          <button onclick="exportCSV('performance')" class="export-btn fr-btn fr-btn--sm">⚡ Performance CSV</button>
                          <button onclick="exportCSV('issues')" class="export-btn fr-btn fr-btn--sm">📋 All Issues CSV</button>
                          <button onclick="exportCSV('summary')" class="export-btn fr-btn fr-btn--sm">📊 Summary CSV</button>
                          <button onclick="saveToPDF()" class="pdf-btn fr-btn fr-btn--sm fr-btn--outline">📥 Save to PDF</button>
                          <button onclick="exportMarkdown()" class="export-btn fr-btn fr-btn--sm fr-btn--outline">📝 Markdown</button>
                          <button onclick="exportAll()" class="export-btn fr-btn fr-btn--sm fr-btn--outline">📦 Export All</button>
                      </div>
                  </div>
              </div>

              <!-- Issue Export Filter Modal -->
              <div id="issueFilterModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
                  <div style="background: var(--color-bg-surface); border: 1px solid var(--color-border-default); padding: 25px; border-radius: 16px; max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
                      <h3 style="margin: 0 0 20px; color: var(--color-text-primary);">Export Issues - Filter Options</h3>
                      <div style="margin-bottom: 15px;">
                          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--color-text-secondary);">Severity Levels:</label>
                          <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterCritical" checked> <span style="color: var(--color-error);">Critical</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterHigh" checked> <span style="color: var(--color-warning);">High</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterMedium" checked> <span style="color: var(--color-info);">Medium</span>
                              </label>
                              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                  <input type="checkbox" id="filterLow" checked> <span style="color: var(--color-text-muted);">Low</span>
                              </label>
                          </div>
                      </div>
                      <div style="margin-bottom: 20px;">
                          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--color-text-secondary);">Minimum Affected Pages:</label>
                          <input type="number" id="filterMinPages" value="1" min="1" style="width: 100%; padding: 8px 12px; border: 1px solid var(--color-border-default); border-radius: 6px; font-size: 14px; background: transparent; color: var(--color-text-primary);">
                      </div>
                      <div style="display: flex; gap: 10px; justify-content: flex-end;">
                          <button onclick="hideIssueFilterModal()" class="fr-btn fr-btn--sm fr-btn--outline">Cancel</button>
                          <button onclick="exportFilteredIssues()" class="fr-btn fr-btn--sm">Export CSV</button>
                      </div>
                  </div>
              </div>
          </header>

          ${
            loadError
              ? `
          <div class="section" style="background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <h2 style="color: var(--color-error); margin-top: 0;">⚠️ Report Generation Error</h2>
              <p style="color: var(--color-error-text);">An error occurred while loading the audit data. Some sections may be incomplete or missing.</p>
              <details style="margin-top: 10px;">
                  <summary style="cursor: pointer; color: var(--color-error); font-weight: 600;">Error Details</summary>
                  <pre style="background: var(--color-error-bg); padding: 10px; border-radius: 4px; margin-top: 10px; overflow-x: auto; color: var(--color-error-text);">${escapeHtml((loadError as Error).message)}${(loadError as Error).stack ? '\n\n' + escapeHtml((loadError as Error).stack) : ''}</pre>
              </details>
              <p style="color: var(--color-text-muted); margin-top: 15px; font-size: 14px;">
                  <strong>Troubleshooting:</strong> Check that the audit data file exists and is not corrupted.
                  Try re-running the audit with <code>--proceed</code> flag to resume from the last checkpoint.
              </p>
          </div>
          `
              : ''
          }

          ${
            isComparison && sectionData.comparison
              ? getComparisonHeader(
                  shortDomain(sectionData.comparison.originDomainName),
                  shortDomain(sectionData.comparison.compareDomainName),
                  {
                    matched: sectionData.comparison.matchedPaths.length,
                    originOnly: sectionData.comparison.originOnlyPaths.length,
                    compareOnly: sectionData.comparison.compareOnlyPaths.length,
                  },
                )
              : ''
          }

          <!-- Section tabs for quick navigation -->
          <div class="section-tabs" id="sectionTabs">
              ${sectionTabs}
          </div>

          ${sectionsHtml}

          <footer>
              <div class="fr-footer-inner">
                  <a class="fr-wordmark" href="https://focusreactive.com" target="_blank" rel="noopener">Focus Reactive<span class="fr-wordmark-dot">.</span></a>
                  <div class="fr-footer-meta">
                      <p>Audit Tool v${pkg.version} - Generated ${new Date().toISOString()}</p>
                      <p>Node.js ${process.version} | Playwright | ${pages.length} pages analyzed</p>
                  </div>
                  <div class="fr-footer-actions">
                      <button onclick="shareReport()" class="fr-btn fr-btn--sm fr-btn--outline">Share</button>
                      <button onclick="window.print()" class="fr-btn fr-btn--sm fr-btn--outline">Print</button>
                  </div>
              </div>
          </footer>
      </div>

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
  const compareArg = args.find((a) => a.startsWith('--compare='));
  const compareFile = compareArg ? compareArg.substring('--compare='.length) : null;
  const positionalArgs = args.filter((a) => !a.startsWith('--'));

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
