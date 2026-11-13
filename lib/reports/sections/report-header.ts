/**
 * HTML report header: brand bar with one Export menu, the audited site, the
 * audit type and run facts on one line, the crawl counts as tiles, and the
 * crawl scope as a single muted line.
 */

import { escapeHtml } from '../html-utils';
import type { PageCounts } from '../../utils/page-counts';

export interface HeaderStat {
  label: string;
  value: number;
  /** CSS colour variable name, e.g. `--color-success`. */
  tone?: string;
}

export interface ReportHeaderOptions {
  /** Audited site, or "a vs b" for a comparison. */
  site: string;
  /** Link for the site name; omitted for comparisons. */
  siteUrl?: string;
  title: string;
  brandName?: string;
  brandLogo?: string;
  auditType: string;
  generatedIso: string;
  generatedLocal: string;
  duration?: string;
  stats: HeaderStat[];
  /** Secondary crawl facts, joined into one muted line. */
  scope: string[];
}

/** Crawl count tiles: Successful + With Errors always sum to Pages Crawled; load failures are listed apart. */
export function pageCountStats(counts: PageCounts): HeaderStat[] {
  return [
    { label: 'Pages Crawled', value: counts.crawled },
    { label: 'Successful', value: counts.successful, tone: '--color-success' },
    { label: 'With Errors', value: counts.withErrors, tone: counts.withErrors > 0 ? '--color-error' : undefined },
    ...(counts.failedToLoad > 0
      ? [{ label: 'Failed to load', value: counts.failedToLoad, tone: '--color-warning' }]
      : []),
  ];
}

export function renderStatTiles(stats: HeaderStat[]): string {
  return stats
    .map(
      (s) => `<div class="stat">
                      <span class="stat-value"${s.tone ? ` style="color: var(${s.tone});"` : ''}>${s.value}</span>
                      <span class="stat-label">${escapeHtml(s.label)}</span>
                  </div>`,
    )
    .join('\n                  ');
}

const EXPORT_ITEMS: Array<[string, string, string]> = [
  ["exportCSV('summary')", 'Summary', 'CSV'],
  ["exportCSV('issues')", 'All issues', 'CSV'],
  ['showIssueFilterModal()', 'Filtered issues…', 'CSV'],
  ["exportCSV('pages')", 'Pages', 'CSV'],
  ["exportCSV('performance')", 'Performance', 'CSV'],
  ['exportMarkdown()', 'Report', 'Markdown'],
  ['saveToPDF()', 'Report', 'PDF'],
  ['exportAll()', 'Everything', 'ZIP'],
];

function exportMenu(): string {
  const items = EXPORT_ITEMS.map(
    ([action, label, format]) =>
      `<button type="button" class="export-menu__item" onclick="${action}; this.closest('details').open = false;">
                              <span>${label}</span><span class="export-menu__format">${format}</span>
                          </button>`,
  ).join('\n                          ');
  return `<details class="export-menu">
                      <summary class="fr-btn fr-btn--sm fr-btn--outline">Export<span class="export-menu__caret" aria-hidden="true"></span></summary>
                      <div class="export-menu__list" role="menu">
                          ${items}
                      </div>
                  </details>`;
}

export function renderReportHeader(o: ReportHeaderOptions): string {
  const site = o.siteUrl
    ? `<a class="report-site" href="${escapeHtml(o.siteUrl)}" target="_blank" rel="noopener">${escapeHtml(o.site)}</a>`
    : `<span class="report-site">${escapeHtml(o.site)}</span>`;
  const facts = [
    `<span>Audit type: ${escapeHtml(o.auditType)}</span>`,
    `<span>Generated <time datetime="${o.generatedIso}" id="reportTimestamp">${escapeHtml(o.generatedLocal)}</time></span>`,
    ...(o.duration ? [`<span>Duration ${escapeHtml(o.duration)}</span>`] : []),
  ].join('<span class="report-facts__sep" aria-hidden="true">·</span>');
  const scope = o.scope.length
    ? `<p class="report-scope">${o.scope.map((s) => escapeHtml(s)).join('<span class="report-facts__sep" aria-hidden="true">·</span>')}</p>`
    : '';
  return `<header>
              <div class="fr-header-bar">
                  <a class="fr-wordmark" href="https://focusreactive.com" target="_blank" rel="noopener">Focus Reactive<span class="fr-wordmark-dot">.</span></a>
                  <div class="report-toolbar">
                      ${exportMenu()}
                      <button type="button" onclick="shareReport()" class="fr-btn fr-btn--sm fr-btn--outline">Share</button>
                  </div>
              </div>
              ${o.brandLogo ? `<img class="report-brand-logo" src="${escapeHtml(o.brandLogo)}" alt="Logo">` : ''}
              ${site}
              <h1>${o.brandName ? escapeHtml(o.brandName) + ' - ' : ''}${escapeHtml(o.title)}</h1>
              <p class="report-facts">${facts}</p>
              <div class="stats">
                  ${renderStatTiles(o.stats)}
              </div>
              ${scope}
          </header>`;
}

export function getHeaderStyles(): string {
  return `
          /* ===== Report header ===== */
          header { padding-bottom: var(--space-7); margin-bottom: var(--space-6); }
          header .fr-header-bar { margin-bottom: var(--space-7); }
          .report-toolbar { display: flex; gap: var(--space-3); align-items: center; }
          .report-brand-logo { max-height: 40px; margin-bottom: var(--space-3); display: block; }
          .report-site {
              display: inline-block;
              font-size: var(--font-size-md);
              font-weight: var(--font-weight-medium);
              color: var(--color-accent);
              text-decoration: none;
              margin-bottom: var(--space-2);
          }
          a.report-site:hover { text-decoration: underline; color: var(--color-accent); }
          header h1 { margin-bottom: var(--space-3); }
          .report-facts, .report-scope {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 4px 0;
              color: var(--color-text-muted);
              font-size: var(--font-size-sm);
          }
          .report-facts__sep { margin: 0 10px; opacity: 0.5; }
          .report-scope { margin-top: var(--space-4); font-size: var(--font-size-xs); }
          header .stats {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
              gap: var(--space-3);
              margin-top: var(--space-6);
              max-width: 760px;
          }
          header .stat {
              display: flex;
              flex-direction: column;
              gap: 2px;
              padding: var(--space-4) var(--space-5);
              border: 1px solid var(--color-border-default);
              border-radius: var(--radius-lg);
              background: var(--color-bg-surface);
          }
          header .stat-value { font-size: var(--font-size-xl, 24px); font-weight: var(--font-weight-semibold); line-height: 1.2; }
          header .stat-label { font-size: var(--font-size-xs); color: var(--color-text-muted); }

          /* Export menu */
          .export-menu { position: relative; }
          .export-menu > summary { list-style: none; }
          .export-menu > summary::-webkit-details-marker { display: none; }
          .export-menu__caret {
              width: 6px; height: 6px;
              border-right: 1.5px solid currentColor;
              border-bottom: 1.5px solid currentColor;
              transform: translateY(-2px) rotate(45deg);
          }
          .export-menu__list {
              position: absolute;
              right: 0;
              top: calc(100% + 8px);
              min-width: 240px;
              padding: 6px;
              background: var(--color-bg-surface);
              border: 1px solid var(--color-border-default);
              border-radius: var(--radius-lg);
              box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
              z-index: 200;
          }
          .export-menu__item {
              display: flex;
              justify-content: space-between;
              gap: var(--space-5);
              width: 100%;
              padding: 8px 12px;
              background: transparent;
              border: 0;
              border-radius: var(--radius-md);
              color: var(--color-text-primary);
              font: inherit;
              font-size: var(--font-size-sm);
              text-align: left;
              cursor: pointer;
          }
          .export-menu__item:hover { background: rgba(255, 255, 255, 0.06); }
          .export-menu__format { color: var(--color-text-muted); font-size: var(--font-size-xs); }

          /* Sticky section navigation */
          .section-tabs {
              display: flex;
              gap: 2px;
              margin: 0 0 var(--space-6);
              padding: 6px;
              background: rgba(10, 10, 10, 0.85);
              backdrop-filter: blur(8px);
              border: 1px solid var(--color-border-default);
              border-radius: var(--radius-pill);
              box-shadow: none;
              overflow-x: auto;
              scrollbar-width: none;
          }
          .section-tabs::-webkit-scrollbar { display: none; }
          .section-tabs .section-tab {
              flex: none;
              padding: 6px 14px;
              border: 0;
              border-radius: var(--radius-pill);
              background: transparent;
              color: var(--color-text-secondary);
              font-size: var(--font-size-sm);
              font-weight: var(--font-weight-medium);
              text-decoration: none;
              white-space: nowrap;
          }
          .section-tabs .section-tab:hover { color: var(--color-text-primary); background: rgba(255, 255, 255, 0.06); }
          .section-tabs .section-tab.active { color: var(--color-on-accent); background: var(--color-accent); border: 0; }
          .section-tabs .section-tabs__toggle {
              margin-left: auto;
              border: 1px solid var(--color-border-default);
              color: var(--color-text-muted);
              font-size: var(--font-size-xs);
              cursor: pointer;
          }

          @media (max-width: 768px) {
              /* One scrollable row of tabs rather than a wrapped block */
              .section-tabs { flex-wrap: nowrap !important; border-radius: var(--radius-lg); }
              .section-tabs .section-tab { padding: 6px 12px; font-size: var(--font-size-sm); }
          }
          @media (max-width: 640px) {
              header .stats { grid-template-columns: repeat(2, 1fr); }
              .report-toolbar .fr-btn:not(summary) { display: none; }
          }
          @media print {
              .report-toolbar, .export-menu { display: none !important; }
              header .stat { border: 1px solid #ccc !important; background: #fff !important; }
          }
  `;
}
