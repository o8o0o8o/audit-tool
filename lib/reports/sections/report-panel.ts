/**
 * Report panels: every top-level section of the HTML report is a native
 * `<details>` card. The header carries the section title and a one-line
 * summary, so a folded section still tells the reader what is inside. Only the
 * sections a reader needs first (summary, issues) are open by default.
 */

import { escapeHtml } from '../html-utils';

export interface PanelOptions {
  /** Section id; the panel element gets `panel-<id>`, the body keeps its own `id` wrapper. */
  id: string;
  title: string;
  /** Short plain-text summary shown in the header (escaped). */
  meta?: string;
  /** Pre-rendered HTML chips shown after the meta text (not escaped). */
  chips?: string;
  open?: boolean;
  body: string;
}

/**
 * The section generators render their own `<h2>` title. Inside a panel the
 * header already shows it, so the first `<h2>` is marked and hidden by CSS
 * (kept in the DOM for search and for callers that render sections alone).
 */
function markSectionHeading(body: string): string {
  return body.replace(/<h2\b/, '<h2 data-panel-heading');
}

export function renderPanel(o: PanelOptions): string {
  const meta = o.meta ? `<span class="report-panel__meta">${escapeHtml(o.meta)}</span>` : '';
  const chips = o.chips ? `<span class="report-panel__chips">${o.chips}</span>` : '';
  return `<details class="report-panel" id="panel-${o.id}" data-panel="${o.id}"${o.open ? ' open' : ''}>
        <summary class="report-panel__header">
          <span class="report-panel__heading">
            <span class="report-panel__title">${escapeHtml(o.title)}</span>
            ${meta}
          </span>
          ${chips}
          <span class="report-panel__chevron" aria-hidden="true"></span>
        </summary>
        <div class="report-panel__body">${markSectionHeading(o.body)}</div>
      </details>`;
}

/** Small severity count chip used in panel and sub-panel headers. */
export function severityChip(severity: 'critical' | 'high' | 'medium' | 'low', count: number): string {
  if (count <= 0) return '';
  return `<span class="sev-chip sev-chip--${severity}">${count} ${severity}</span>`;
}

type Sev = 'critical' | 'high' | 'medium' | 'low';
const SEVS: Sev[] = ['critical', 'high', 'medium', 'low'];
const asSev = (v: unknown): Sev => {
  const s = String(v ?? '').toLowerCase();
  return (SEVS as string[]).includes(s) ? (s as Sev) : 'low';
};

/** Severity chips for a list of findings, or one "No issues" chip. */
export function findingChips(findings: Array<[string, { severity?: unknown }]>): string {
  if (findings.length === 0) return '<span class="sev-chip sev-chip--ok">No issues</span>';
  const counts: Record<Sev, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const [, d] of findings) counts[asSev(d.severity)]++;
  return SEVS.map((s) => severityChip(s, counts[s])).join('');
}

/** One row per finding: severity label, message, affected count. */
export function renderFindingList(
  className: string,
  findings: Array<[string, { severity?: unknown; count?: number }]>,
): string {
  return `<ul class="finding-list ${className}">${findings
    .map(([message, d]) => {
      const sev = asSev(d.severity);
      return `<li><span class="sev-chip sev-chip--${sev}">${sev}</span><span>${escapeHtml(message)}</span>${
        d.count ? `<span class="finding-count" title="Affected pages or instances">${d.count}</span>` : ''
      }</li>`;
    })
    .join('')}</ul>`;
}

/** A folded block inside a section (Agentic Browsing, Domain & Exposure, Analytics & Tags). */
export function renderSubpanel(o: {
  id: string;
  className: string;
  heading: string;
  chips: string;
  body: string;
  open?: boolean;
}): string {
  return `<details class="report-subpanel ${o.className}" id="${o.id}"${o.open ? ' open' : ''}>
      <summary>
        <h3>${o.heading}</h3>
        <span class="report-panel__chips">${o.chips}</span>
        <span class="report-panel__chevron" aria-hidden="true"></span>
      </summary>
      <div class="report-subpanel__body">${o.body}</div>
    </details>`;
}

export function getPanelStyles(): string {
  return `
          /* ===== Report panels ===== */
          .report-panel {
              background: var(--color-bg-surface);
              border: 1px solid var(--color-border-default);
              border-radius: var(--radius-card);
              margin-bottom: var(--space-5);
              scroll-margin-top: 64px;
          }
          .report-panel[open] { margin-bottom: var(--space-7); }
          .report-panel__header {
              display: flex;
              align-items: center;
              gap: var(--space-4);
              padding: var(--space-5) var(--space-7);
              cursor: pointer;
              list-style: none;
              user-select: none;
              border-radius: var(--radius-card);
          }
          .report-panel__header::-webkit-details-marker { display: none; }
          .report-panel__header:hover { background: rgba(255, 255, 255, 0.02); }
          .report-panel__header:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
          .report-panel__heading {
              display: flex;
              align-items: baseline;
              flex-wrap: wrap;
              gap: 4px var(--space-4);
              min-width: 0;
              flex: 1 1 auto;
          }
          .report-panel__title {
              font-size: var(--font-size-lg);
              font-weight: var(--font-weight-semibold);
              color: var(--color-text-primary);
              letter-spacing: -0.01em;
          }
          .report-panel__meta {
              font-size: var(--font-size-sm);
              color: var(--color-text-muted);
          }
          .report-panel__chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
          .report-panel__chevron {
              flex: none;
              width: 28px;
              height: 28px;
              border-radius: 50%;
              border: 1px solid var(--color-border-default);
              position: relative;
              transition: transform var(--transition-fast), border-color var(--transition-fast);
          }
          .report-panel__chevron::before {
              content: '';
              position: absolute;
              left: 50%;
              top: 50%;
              width: 7px;
              height: 7px;
              border-right: 1.5px solid var(--color-text-secondary);
              border-bottom: 1.5px solid var(--color-text-secondary);
              transform: translate(-50%, -70%) rotate(45deg);
          }
          .report-panel__header:hover .report-panel__chevron { border-color: var(--color-accent); }
          .report-panel[open] > .report-panel__header .report-panel__chevron { transform: rotate(180deg); }
          .report-panel[open] > .report-panel__header {
              border-bottom: 1px solid var(--color-border-default);
              border-radius: var(--radius-card) var(--radius-card) 0 0;
          }
          .report-panel__body {
              padding: var(--space-6) var(--space-7) var(--space-7);
              overflow-x: auto;
          }
          /* The panel is the card: flatten the section card each generator renders inside it. */
          .report-panel__body > :is(.section, .charts-section, .executive-summary, .info-section, .issues-section),
          .report-panel__body > div > :is(.section, .charts-section, .executive-summary, .info-section, .issues-section) {
              background: transparent;
              border: 0;
              box-shadow: none;
              padding: 0;
              margin: 0;
              border-radius: 0;
          }
          .report-panel__body [data-panel-heading] { display: none !important; }
          .panel-empty { color: var(--color-text-muted); font-size: var(--font-size-sm); }
          .report-panel__body [data-panel-heading] + p {
              text-align: left !important;
              margin-bottom: var(--space-6) !important;
          }

          /* Summary hero: score on the left, category health on the right */
          .summary-hero {
              display: grid;
              grid-template-columns: minmax(220px, 300px) 1fr;
              gap: var(--space-8);
              align-items: center;
              margin-bottom: var(--space-7);
          }
          .summary-hero__score { text-align: center; }
          .summary-hero .summary-score { margin-bottom: var(--space-4); }
          .summary-hero__estimate { font-size: var(--font-size-sm); color: var(--color-text-secondary); line-height: 1.5; }
          .summary-hero__label {
              font-size: var(--font-size-xs);
              text-transform: uppercase;
              letter-spacing: 0.06em;
              color: var(--color-text-muted);
              margin-bottom: var(--space-4);
          }
          .summary-hero__categories { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4) var(--space-7); }
          .summary-hero__categories .summary-hero__label { grid-column: 1 / -1; margin-bottom: 0; }
          .summary-category .progress-bar-container { height: 6px; margin: 6px 0 0; background: rgba(255, 255, 255, 0.08); }
          .summary-category > div:first-child { display: flex; justify-content: space-between; font-size: var(--font-size-sm); }
          .report-panel__body .executive-summary .summary-card-hint { text-transform: none; letter-spacing: 0; opacity: 0.7; }
          @media (max-width: 900px) {
              .summary-hero { grid-template-columns: 1fr; }
              .summary-hero__categories { grid-template-columns: 1fr; }
          }

          /* Audit timing rows: label left, duration right, one line each */
          .report-panel__body .timing-phases .perf-budget-row {
              display: flex;
              justify-content: space-between;
              gap: var(--space-5);
              max-width: 520px;
              padding: 6px 0;
          }
          .report-panel__body .timing-phases .perf-budget-label { white-space: nowrap; color: var(--color-text-secondary); }
          .report-panel__body .timing-phases .perf-budget-value { font-variant-numeric: tabular-nums; }

          /* Severity chips (panel and sub-panel headers) */
          .sev-chip {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 2px 10px;
              border-radius: var(--radius-pill);
              font-size: var(--font-size-xs);
              font-weight: var(--font-weight-medium);
              white-space: nowrap;
              border: 1px solid var(--color-border-default);
              color: var(--color-text-secondary);
          }
          .sev-chip::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
          .sev-chip--critical { color: var(--red-400); border-color: rgba(255, 107, 107, 0.4); }
          .sev-chip--high { color: var(--orange-500); border-color: rgba(255, 154, 77, 0.4); }
          .sev-chip--medium { color: var(--amber-400); border-color: rgba(255, 201, 77, 0.35); }
          .sev-chip--low { color: var(--color-text-muted); }
          .sev-chip--ok { color: var(--color-success); border-color: rgba(0, 229, 109, 0.3); }

          /* Sub-panels inside a section (Agentic Browsing, Domain & Exposure, Analytics & Tags) */
          .report-subpanel {
              border: 1px solid var(--color-border-default);
              border-radius: var(--radius-lg);
              margin-top: var(--space-4);
              background: rgba(255, 255, 255, 0.015);
          }
          .report-subpanel > summary {
              display: flex;
              align-items: center;
              gap: var(--space-4);
              padding: var(--space-4) var(--space-5);
              cursor: pointer;
              list-style: none;
          }
          .report-subpanel > summary::-webkit-details-marker { display: none; }
          .report-subpanel > summary h3 {
              margin: 0 !important;
              font-size: var(--font-size-md) !important;
              font-weight: var(--font-weight-semibold);
              color: var(--color-text-primary) !important;
              flex: 1 1 auto;
          }
          .report-subpanel > summary .report-panel__chevron { width: 24px; height: 24px; }
          .report-subpanel[open] > summary .report-panel__chevron { transform: rotate(180deg); }
          .report-subpanel[open] > summary { border-bottom: 1px solid var(--color-border-default); }
          .report-subpanel__body { padding: var(--space-5); }
          .report-subpanel__body table { width: 100%; border-collapse: collapse; margin-bottom: var(--space-5); }
          .report-subpanel__body th {
              text-align: left;
              padding: 8px 10px;
              font-size: var(--font-size-xs);
              text-transform: uppercase;
              letter-spacing: 0.04em;
              color: var(--color-text-muted);
              font-weight: var(--font-weight-semibold);
              border-bottom: 1px solid var(--color-border-default);
          }
          .report-subpanel__body td {
              padding: 8px 10px;
              border-bottom: 1px solid rgba(255, 255, 255, 0.05);
              font-size: var(--font-size-sm);
              vertical-align: top;
          }
          .finding-list { list-style: none; margin: 0 0 var(--space-4); padding: 0; }
          .finding-list li {
              display: flex;
              align-items: baseline;
              gap: var(--space-3);
              padding: 8px 0;
              border-bottom: 1px solid rgba(255, 255, 255, 0.05);
              font-size: var(--font-size-sm);
          }
          .finding-list li:last-child { border-bottom: 0; }
          .finding-list .finding-count { margin-left: auto; color: var(--color-text-muted); white-space: nowrap; }
          .subpanel-note { font-size: var(--font-size-sm); color: var(--color-text-muted); margin-top: var(--space-3); }

          @media (max-width: 640px) {
              /* Issues table on a phone: let issue names wrap, drop the effort column */
              .issues-table col:first-child { width: 20px !important; }
              .issues-table col:nth-child(2) { width: 68px !important; }
              .issues-table col:last-child { width: 0 !important; }
              .issues-table th:last-child, .issues-table-row td:last-child { display: none; }
              .issues-table-row td { padding: 8px 6px; font-size: var(--font-size-sm); }
              .issues-table-row td:nth-child(3) { white-space: normal !important; overflow-wrap: anywhere; }
              .report-panel__header { padding: var(--space-4); }
              .report-panel__body { padding: var(--space-4); }
              .report-panel__chips { display: none; }
          }
          @media print {
              .report-panel, .report-subpanel { border: 0 !important; break-inside: auto; }
              .report-panel__chevron, .report-panel__chips { display: none !important; }
              .report-panel__header { padding: 12px 0 !important; }
              .report-panel__body { padding: 0 0 16px !important; }
          }
  `;
}

/** Opens the panel holding an element before the report scrolls to it; `e` toggles every panel. */
export function getPanelScript(): string {
  return `
      <script>
      (function() {
          function openAncestors(el) {
              var node = el;
              while (node) {
                  if (node.tagName === 'DETAILS' && !node.open) node.open = true;
                  node = node.parentElement;
              }
          }
          window.revealInReport = function(id, smooth) {
              var el = id && document.getElementById(id);
              if (!el) return false;
              openAncestors(el);
              // A section's own wrapper sits right in the panel body: scroll to the panel header instead.
              var parent = el.parentElement;
              var target = parent && parent.classList.contains('report-panel__body') ? parent.parentElement : el;
              target.scrollIntoView({ behavior: smooth === false ? 'auto' : 'smooth', block: 'start' });
              return true;
          };
          window.setAllPanels = function(open) {
              document.querySelectorAll('details.report-panel').forEach(function(d) { d.open = open; });
          };
          var toggleBtn = document.getElementById('togglePanels');
          function syncToggle() {
              if (!toggleBtn) return;
              var panels = Array.from(document.querySelectorAll('details.report-panel'));
              toggleBtn.textContent = panels.every(function(d) { return d.open; }) ? 'Collapse all' : 'Expand all';
          }
          if (toggleBtn) {
              toggleBtn.addEventListener('click', function() {
                  window.setAllPanels(toggleBtn.textContent === 'Expand all');
                  syncToggle();
              });
              document.addEventListener('toggle', function(e) {
                  if (e.target.classList && e.target.classList.contains('report-panel')) syncToggle();
              }, true);
          }
          // Close the Export menu on an outside click or Escape.
          document.addEventListener('click', function(e) {
              document.querySelectorAll('details.export-menu[open]').forEach(function(m) {
                  if (!m.contains(e.target)) m.open = false;
              });
          });
          document.addEventListener('keydown', function(e) {
              if (e.key === 'Escape') document.querySelectorAll('details.export-menu[open]').forEach(function(m) { m.open = false; });
          });
          // In-page links (e.g. the score-rules link) open the folded panel they point into.
          document.addEventListener('click', function(e) {
              var a = e.target.closest && e.target.closest('a[href^="#"]');
              if (!a) return;
              var id = a.getAttribute('href').slice(1);
              if (!id) return;
              if (window.revealInReport(id)) {
                  e.preventDefault();
                  history.replaceState(null, '', '#' + id);
              }
          });
          if (location.hash.length > 1) {
              var id = decodeURIComponent(location.hash.slice(1));
              setTimeout(function() { window.revealInReport(id, false); }, 50);
          }
      })();
      </script>`;
}
