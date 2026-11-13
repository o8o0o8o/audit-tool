import * as fs from 'fs';
import * as path from 'path';
import pkg from './package.json';
import type { ReportSectionData, PageData, PageInfo, AnalysisDetail } from './lib/types';
import { ScoreCalculator } from './lib/scoring/score-calculator';

// Import validators for input sanitization
import { sanitizeDomainName } from './validators';

// Import report modules
import { ReportDataProcessor } from './lib/reports/data-processor';
import { FileManager } from './lib/storage/file-manager';
import { computePageCounts, type PageCounts } from './lib/utils/page-counts';
import { escapeHtml } from './lib/reports/html-utils';
import { extractSummary } from './lib/reports/data-processor';
import { statPercentile } from './lib/utils';
import { renderPanel, severityChip, getPanelScript } from './lib/reports/sections/report-panel';
import { renderReportHeader, renderStatTiles, pageCountStats } from './lib/reports/sections/report-header';
import { collectUiFindings } from './lib/reports/sections/ui-issues';
import { countDetectedTechnologies } from './lib/reports/sections/technology-stack';
import { getIssueTableCounts } from './lib/reports/sections/issues-detail';
import { getAgenticBrowsingSection, resolveAgenticState } from './lib/reports/sections/agentic-browsing';
import { getAnalyticsTagsSection, getDomainExposureSection } from './lib/reports/sections/domain-exposure';
import type { SiteChecksData } from './lib/analyzers/site-checks/site-checks-types';
import { getComparisonHeader, shortDomain } from './lib/reports/comparison-helpers';
import { categorize, VISUAL_FINDING_MESSAGES } from './lib/phase2/categorize';
import { auditTypeLabel, matchesChecks, type CheckName, type HtmlSectionId } from './lib/presets';

// Import section generators
import {
  getStyles,
  getScripts,
  getExecutiveSummary,
  getIssuesDetail,
  getUiIssues,
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

/** Short labels for the sticky section navigation. */
const TAB_LABELS: Record<HtmlSectionId, string> = {
  'executive-summary': 'Summary',
  'issues-detail': 'Issues',
  'ui-issues': 'UI Issues',
  performance: 'Performance',
  charts: 'Charts',
  'technology-stack': 'Tech Stack',
  'source-code': 'Source Code',
  'content-insights': 'Insights',
  history: 'History',
  'pages-table': 'Pages',
};

/** Panel titles; the section generators' own headings are hidden inside a panel. */
const PANEL_TITLES: Record<HtmlSectionId, string> = {
  'executive-summary': 'Summary',
  'issues-detail': 'Issues',
  'ui-issues': 'UI issues',
  performance: 'Performance',
  charts: 'Charts',
  'technology-stack': 'Technology stack',
  'source-code': 'Source code',
  'content-insights': 'Content & technical insights',
  history: 'History',
  'pages-table': 'All pages',
};

/** Open by default: what a reader needs first. Everything else is folded with a one-line summary. */
const OPEN_BY_DEFAULT = new Set<HtmlSectionId>(['executive-summary', 'issues-detail']);

const DEFAULT_BODY_ORDER: HtmlSectionId[] = [
  'executive-summary',
  'issues-detail',
  'ui-issues',
  'performance',
  'charts',
  'technology-stack',
  'source-code',
  'content-insights',
  'history',
  'pages-table',
];

/** Whether the run's visual analyzers ran — `visual` in the run's metadata (absent ⇒ false). */
function readVisualFlag(file: string): boolean {
  try {
    const metadata = FileManager.readJsonFile(path.join(path.dirname(file), 'metadata.json.gz')) as { visual?: unknown } | null;
    return metadata?.visual === true;
  } catch {
    return false;
  }
}

/** The run's `agentic` metadata flag; undefined when the metadata is missing or predates the flag. */
function readAgenticFlag(file: string): boolean | undefined {
  try {
    const metadata = FileManager.readJsonFile(path.join(path.dirname(file), 'metadata.json.gz')) as { agentic?: unknown } | null;
    return typeof metadata?.agentic === 'boolean' ? metadata.agentic : undefined;
  } catch {
    return undefined;
  }
}

function readSiteChecks(file: string): SiteChecksData | null {
  try {
    const metadata = FileManager.readJsonFile(path.join(path.dirname(file), 'metadata.json.gz')) as { siteChecks?: SiteChecksData } | null;
    return metadata?.siteChecks ?? null;
  } catch {
    return null;
  }
}

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


/** Scores and counts in the saved summary cover every finding; after a checks filter they must be rebuilt. */
function recalculateSummary(jsonData: Record<string, unknown>, pageData: PageData): void {
  const analysis = jsonData.analysis as
    | { details?: Record<string, AnalysisDetail>; bySeverity?: Record<string, string[]>; summary?: unknown }
    | undefined;
  if (!analysis?.details) return;
  const bySeverity: Record<string, string[]> = { ...analysis.bySeverity };
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    bySeverity[severity] ??= analysis.bySeverity
      ? []
      : Object.entries(analysis.details)
          .filter(([, d]) => String(d.severity ?? '').toLowerCase() === severity)
          .map(([message]) => message);
  }
  analysis.summary = ScoreCalculator.calculateSummary(
    { bySeverity, details: analysis.details },
    pageData,
    (pageData.pages ?? {}) as Record<string, PageInfo>,
  );
}

/** Header stats: Successful + With Errors always sum to Pages Crawled; load failures are listed apart. */
export function renderPageCountStats(counts: PageCounts): string {
  return renderStatTiles(pageCountStats(counts));
}

const emptyState = (text: string) => `<p class="panel-empty">${escapeHtml(text)}</p>`;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/** "LCP p75 1.65 s · TTFB p75 159 ms · CLS p75 0.00" from the crawled pages' lab metrics. */
function performanceMeta(pages: PageInfo[]): string {
  const values = (get: (p: PageInfo) => number | undefined, min: number) =>
    pages
      .map(get)
      .filter((v): v is number => typeof v === 'number' && v >= min)
      .sort((x, y) => x - y);
  const lcp = values((p) => p.LCP, 1);
  const ttfb = values((p) => p.TTFB, 1);
  const cls = values((p) => p.CLS, 0);
  const parts = [
    lcp.length ? `LCP p75 ${fmtMs(statPercentile(lcp, 0.75))}` : '',
    ttfb.length ? `TTFB p75 ${fmtMs(statPercentile(ttfb, 0.75))}` : '',
    cls.length ? `CLS p75 ${statPercentile(cls, 0.75).toFixed(2)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No lab performance data';
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
  if (!isComparison && !loadError) {
    // A checks filter that excludes UX findings leaves the visual check out of this report entirely.
    const visualInReport = !selection.checks || matchesChecks(VISUAL_FINDING_MESSAGES[0], 'ux', selection.checks);
    (jsonData as Record<string, unknown>).visual = visualInReport && readVisualFlag(file);
  }
  if (selection.checks && !loadError) {
    filterFindingsByChecks(jsonData as Record<string, unknown>, selection.checks);
    recalculateSummary(jsonData as Record<string, unknown>, pageData as PageData);
  }

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
    runDir: path.dirname(file),
  };

  const agenticAnalysis = (jsonData as { analysis?: { details?: Record<string, AnalysisDetail>; summary?: { categoryScores?: { agentic?: number } } } }).analysis;
  const agenticHtml = isComparison || loadError || (selection.checks && !selection.checks.includes('agentic'))
    ? ''
    : getAgenticBrowsingSection(
        resolveAgenticState(readAgenticFlag(file), rawPageData.pages as Record<string, PageInfo> | undefined),
        agenticAnalysis?.details ?? {},
        selection.noScore ? undefined : agenticAnalysis?.summary?.categoryScores?.agentic,
      );

  const domainExposureHtml = isComparison || loadError
    ? ''
    : getDomainExposureSection(readSiteChecks(file), agenticAnalysis?.details ?? {}) +
      getAnalyticsTagsSection(readSiteChecks(file), agenticAnalysis?.details ?? {});

  const bodyFragments: Record<HtmlSectionId, () => string> = {
    history: () => {
      const html = getHistoricalProgress(sectionData);
      return html ? `<div id="history">${html}</div>` : '';
    },
    'executive-summary': () => `<div id="executive-summary">
          ${getExecutiveSummary(sectionData)}
          </div>`,
    'issues-detail': () => `<div id="issues-detail">
          ${getIssuesDetail(sectionData)}
          ${agenticHtml}${domainExposureHtml}
          </div>`,
    'ui-issues': () => getUiIssues(sectionData),
    performance: () => {
      const html = getPerformanceStats(sectionData);
      return `<div id="performance">${html.trim() ? html : emptyState('No performance data in this audit. Run it with --perf to measure Core Web Vitals.')}</div>`;
    },
    charts: () => `<div id="charts">
          ${getChartsSection()}
          </div>`,
    'technology-stack': () => `<div id="technology-stack">
          ${getTechnologyStack(sectionData)}
          </div>`,
    'source-code': () => getSourceCodeAnalysis(sectionData),
    'content-insights': () => {
      const html = getContentInsights(sectionData);
      return `<div id="content-insights">${html.trim() ? html : emptyState('No content insights: no crawled pages carry content data.')}</div>`;
    },
    'pages-table': () => `<div id="pages-table">
          ${getPagesTable(sectionData)}
          </div>`,
  };

  const summary = extractSummary(jsonData as Record<string, unknown>);
  // Issues header counts come from the Issues table itself (variants merged), so they match the rows below.
  const tableCounts = isComparison || loadError
    ? { total: 0, critical: 0, high: 0, medium: 0, low: 0 }
    : getIssueTableCounts(jsonData as Record<string, unknown>);
  const severityChips = (['critical', 'high', 'medium', 'low'] as const)
    .map((sev) => severityChip(sev, tableCounts[sev]))
    .join('');
  const overallScore = summary.overallScore;
  const uiFindingCount = () =>
    collectUiFindings(
      pages,
      ((jsonData as { analysis?: { details?: Record<string, AnalysisDetail> } }).analysis?.details ?? {}) as Parameters<
        typeof collectUiFindings
      >[1],
    ).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** One-line summary shown in each panel header, so a folded section still says what is inside. */
  const panelMeta: Record<HtmlSectionId, () => string> = {
    'executive-summary': () =>
      [
        !selection.noScore && typeof overallScore === 'number' ? `Site health ${overallScore}/100` : '',
        `${crawlCounts.crawled} pages crawled`,
      ]
        .filter(Boolean)
        .join(' · '),
    'issues-detail': () =>
      isComparison
        ? 'Side-by-side issue comparison'
        : tableCounts.total > 0
          ? `${plural(tableCounts.total, 'issue type')}, most severe first`
          : 'No issues found',
    'ui-issues': () => {
      const n = uiFindingCount();
      return n > 0 ? `${plural(n, 'visual defect')} with screenshots` : 'No UI issues found';
    },
    performance: () => performanceMeta(pages),
    charts: () => 'Issue severity and frequency, status codes, word count, indexability',
    'technology-stack': () => {
      const n = countDetectedTechnologies(pages);
      return n > 0 ? `${n} ${n === 1 ? 'technology' : 'technologies'} detected` : 'No technologies detected';
    },
    'source-code': () => 'Findings from the linked source repository',
    'content-insights': () => 'Internal linking, CTAs, code coverage, outbound links, response headers',
    history: () => {
      const labels = (trendData as { labels?: unknown[] } | null)?.labels?.length ?? 1;
      return labels >= 2 ? `Trends across ${labels} audits` : 'Trends appear after your second audit';
    },
    'pages-table': () => `${plural(pages.length, 'page')} · filter, sort and export`,
  };

  const chosen = selection.sections;
  // The UI Issues section exists only when the visual check ran and is in this report.
  const hidden = new Set<HtmlSectionId>(jsonData.visual === true ? [] : ['ui-issues']);
  const order = (chosen ? chosen.filter((id) => DEFAULT_BODY_ORDER.includes(id)) : DEFAULT_BODY_ORDER).filter(
    (id) => !hidden.has(id),
  );
  const rendered = order
    .map((id) => ({ id, html: bodyFragments[id]() }))
    .filter((s) => s.html.trim() !== '');
  const panels = rendered.map(({ id, html }) =>
    renderPanel({
      id,
      title: PANEL_TITLES[id],
      meta: loadError ? undefined : html.includes('class="panel-empty"') ? 'No data' : panelMeta[id](),
      chips: id === 'issues-detail' ? severityChips : undefined,
      open: OPEN_BY_DEFAULT.has(id),
      body: html,
    }),
  );
  const configPanel = renderPanel({
    id: 'configuration',
    title: 'Crawl setup',
    meta: 'robots.txt, sitemaps, crawl coverage and timing',
    body: `<div id="configuration">${getConfigInfo(sectionData)}</div>`,
  });
  // The default layout keeps the crawl setup just before the pages table; a preset puts it last.
  const lastIsPages = !chosen && rendered.at(-1)?.id === 'pages-table';
  panels.splice(lastIsPages ? panels.length - 1 : panels.length, 0, configPanel);
  // Tabs point at the section wrapper; the panel script opens the folded panel around it.
  const tabs: Array<[string, string]> = rendered.map((r) => [
    r.id === 'source-code' ? 'source-code-analysis' : r.id,
    TAB_LABELS[r.id],
  ]);
  tabs.splice(lastIsPages ? tabs.length - 1 : tabs.length, 0, ['configuration', 'Setup']);
  const sectionTabs = tabs
    .map(
      ([anchor, label], i) =>
        `<a class="section-tab${i === 0 ? ' active' : ''}" href="#${anchor}" data-target="${anchor}">${label}</a>`,
    )
    .join('\n              ');
  const sectionsHtml = panels.join('\n\n          ');

  const safeCompareDomain = isComparison && comparisonOpts ? sanitizeDomainName(comparisonOpts.compareDomainName) : '';
  const generatedAt = new Date();
  const timingInfo = timing as Record<string, unknown>;
  const notCrawled = (jsonData.sitemaps?.total ?? 0) - pages.length;
  const headerStats = [
    ...pageCountStats(crawlCounts),
    ...(notCrawled > 0 ? [{ label: 'Not Crawled', value: notCrawled, tone: '--color-warning' }] : []),
  ];
  const scope = [
    `${pagesFromSitemap} from sitemap`,
    ...(pagesDiscovered > 0 ? [`${pagesDiscovered} discovered via links`] : []),
    ...(pagesWithMetrics.length > 0 ? [`${pagesWithMetrics.length} with performance data`] : []),
    jsonData.isMultiLang ? 'Multilanguage site' : 'Single language',
  ];

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

      <div class="container">
          ${renderReportHeader({
            site: isComparison ? `${safeDomainName} vs ${safeCompareDomain}` : safeDomainName,
            siteUrl: isComparison ? undefined : `https://${safeDomainName}`,
            title: isComparison ? 'Comparison report' : 'Audit report',
            brandName: jsonData.branding?.name,
            brandLogo: jsonData.branding?.logo,
            auditType: auditTypeLabel(selection.preset),
            generatedIso: generatedAt.toISOString(),
            generatedLocal: generatedAt.toLocaleString(),
            duration: timingInfo.elapsedTimeFormatted as string | undefined,
            stats: headerStats,
            scope,
          })}

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

          ${
            loadError
              ? `
          <div class="section" style="background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <h2 style="color: var(--color-error); margin-top: 0;">Report generation error</h2>
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

          <!-- Sticky section navigation: jumps to a section and unfolds it -->
          <nav class="section-tabs" id="sectionTabs" aria-label="Report sections">
              ${sectionTabs}
              <button type="button" class="section-tab section-tabs__toggle" id="togglePanels" title="Expand or collapse every section (E)">Expand all</button>
          </nav>

          ${sectionsHtml}

          <footer>
              <div class="fr-footer-inner">
                  <a class="fr-wordmark" href="https://focusreactive.com" target="_blank" rel="noopener">Focus Reactive<span class="fr-wordmark-dot">.</span></a>
                  <div class="fr-footer-meta">
                      <p>Audit Tool v${pkg.version} - Generated ${generatedAt.toISOString()}</p>
                      <p>Node.js ${process.version} | Playwright | ${pages.length} pages analyzed · Press <kbd>?</kbd> for keyboard shortcuts</p>
                  </div>
                  <div class="fr-footer-actions">
                      <button onclick="copyScoreSummary()" class="fr-btn fr-btn--sm fr-btn--outline">Copy summary</button>
                      <button onclick="window.print()" class="fr-btn fr-btn--sm fr-btn--outline">Print</button>
                  </div>
              </div>
          </footer>
      </div>

      <!-- Back to top button -->
      <button class="back-to-top" id="backToTop" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="Back to top (T)" aria-label="Back to top">↑</button>

      <!-- Global search -->
      <div class="global-search" id="globalSearch">
          <input type="text" id="globalSearchInput" placeholder="Search report..." autocomplete="off">
          <span class="search-count" id="searchCount"></span>
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
      ${getPanelScript()}
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
