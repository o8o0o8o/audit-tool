/**
 * Source Code Analysis Section
 * Displays repository analysis results: framework detection, config validation,
 * route coverage, and issue-to-source mapping
 */

import { escapeHtml, getSeverityBadge } from '../html-utils';
import type { ReportSectionData } from '../../types';

/**
 * Render a repo-analyzer `detail` string as HTML. The analyzers intentionally
 * embed `<code>` (and `<br>`) markup but interpolate repo-derived file paths
 * raw, so we escape EVERYTHING first (neutralizing any `<script>`/attribute
 * injection from a crafted filename) and then restore only the attribute-less
 * formatting tags the analyzers emit. Restoring `<code>`/`<br>` is inert — they
 * carry no attributes and cannot execute — so this stays XSS-safe while letting
 * the intended inline-code styling render instead of showing literal tags.
 */
function renderRepoDetailHtml(detail: string): string {
  return escapeHtml(detail)
    .replace(/&lt;code&gt;/g, '<code>')
    .replace(/&lt;\/code&gt;/g, '</code>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>');
}

/**
 * Generate the source code analysis section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full JSON audit data
 * @returns {string} HTML string
 */
function getSourceCodeAnalysis(data: ReportSectionData) {
  const { jsonData } = data;
  const repo = jsonData?.repoAnalysis as Record<string, unknown> | undefined;

  if (!repo) return '';

  const frameworkHtml = getFrameworkInfo(repo);
  const configHtml = getConfigValidation(repo);
  const routeHtml = getRouteCoverage(repo);
  const sourceMappingHtml = getSourceMapping(repo);

  return `
    <div class="section" id="source-code-analysis">
      <h2>📂 Source Code Analysis</h2>

      ${frameworkHtml}
      ${configHtml}
      ${routeHtml}
      ${sourceMappingHtml}
    </div>
  `;
}

/**
 * Framework detection info
 */
function getFrameworkInfo(repo: Record<string, unknown>) {
  if (!repo.framework) {
    return `
      <div style="padding: 15px; background: var(--color-warning-bg); border-radius: var(--radius-lg); border-left: 4px solid var(--color-warning); margin-bottom: 20px;">
        <p style="margin: 0; color: var(--color-warning-text);">Could not detect a web framework from the repository.</p>
      </div>
    `;
  }

  const routerInfo = repo.router ? ` (${escapeHtml(repo.router)} router)` : '';
  const configInfo = repo.configFile ? `<code>${escapeHtml(repo.configFile)}</code>` : 'none found';

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: var(--radius-xl); color: white; text-align: center;">
        <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold);">${escapeHtml(repo.framework)}</div>
        <div style="font-size: var(--font-size-sm); opacity: 0.9;">Framework${routerInfo}</div>
      </div>
      <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 20px; border-radius: var(--radius-xl); color: white; text-align: center;">
        <div style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold);">${repo.version ? escapeHtml(repo.version) : 'N/A'}</div>
        <div style="font-size: var(--font-size-sm); opacity: 0.9;">Version</div>
      </div>
      <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 20px; border-radius: var(--radius-xl); color: white; text-align: center;">
        <div style="font-size: var(--font-size-md); font-weight: var(--font-weight-bold);">${configInfo}</div>
        <div style="font-size: var(--font-size-sm); opacity: 0.9;">Config File</div>
      </div>
    </div>
  `;
}

/**
 * Config validation results
 */
function getConfigValidation(repo: Record<string, unknown>) {
  const issues = (repo.configIssues ?? []) as Array<Record<string, unknown>>;
  const warnings = (repo.configWarnings ?? []) as Array<Record<string, unknown>>;

  if (issues.length === 0 && warnings.length === 0) {
    return `
      <div style="padding: 15px; background: var(--color-success-bg); border-radius: var(--radius-lg); border-left: 4px solid var(--color-success); margin-bottom: 20px;">
        <p style="margin: 0; color: var(--color-success-text); font-weight: var(--font-weight-semibold);">All framework configuration checks passed.</p>
      </div>
    `;
  }

  const allFindings: Array<Record<string, unknown>> = [
    ...issues.map((i) => ({ ...i, type: 'issue' })),
    ...warnings.map((w) => ({ ...w, type: 'warning' })),
  ];

  const rows = allFindings
    .map(
      (f) => `
    <tr>
      <td style="padding: 10px 12px;">${getSeverityBadge(f.severity as string)}</td>
      <td style="padding: 10px 12px; font-weight: var(--font-weight-medium);">${escapeHtml(f.message)}</td>
      <td style="padding: 10px 12px; font-size: var(--font-size-sm); color: #4b5563;">${renderRepoDetailHtml((f.detail as string) ?? '')}</td>
    </tr>
  `,
    )
    .join('');

  return `
    <div style="background: var(--color-bg-surface); border-radius: var(--radius-xl); padding: 20px; box-shadow: var(--shadow-sm); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: var(--gray-800);">Framework Configuration</h3>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--color-bg-page); border-bottom: 2px solid #e5e7eb;">
              <th style="padding: 10px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); text-transform: uppercase; width: 100px;">Severity</th>
              <th style="padding: 10px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); text-transform: uppercase;">Finding</th>
              <th style="padding: 10px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); text-transform: uppercase;">Details</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Route coverage comparison
 */
function getRouteCoverage(repo: Record<string, unknown>) {
  const stats = repo.routeCoverage as Record<string, number> | undefined;
  if (!stats) return '';

  const details = (repo.routeDetails ?? {}) as Record<string, unknown>;
  const coveragePercent = stats.totalRoutes > 0 ? Math.round((stats.coveredRoutes / stats.totalRoutes) * 100) : 0;

  const coverageColor =
    coveragePercent >= 80
      ? 'var(--color-success)'
      : coveragePercent >= 50
        ? 'var(--color-warning)'
        : 'var(--color-error)';

  // Uncovered routes table
  let uncoveredHtml = '';
  const uncovered = (details.uncoveredRoutes ?? []) as Array<Record<string, unknown>>;
  if (uncovered.length > 0) {
    const uncoveredRows = uncovered
      .slice(0, 20)
      .map(
        (r: Record<string, unknown>) => `
      <tr>
        <td style="padding: 8px 12px;"><code>${escapeHtml(r.pattern)}</code></td>
        <td style="padding: 8px 12px; font-size: var(--font-size-sm); color: var(--color-text-muted);"><code>${escapeHtml(r.file)}</code></td>
        <td style="padding: 8px 12px;">${
          r.isDynamic
            ? '<span style="color: #7c3aed; font-size: var(--font-size-xs);">dynamic</span>'
            : '<span style="color: #2563eb; font-size: var(--font-size-xs);">static</span>'
        }</td>
      </tr>
    `,
      )
      .join('');

    uncoveredHtml = `
      <div style="margin-top: 15px;">
        <h4 style="margin: 0 0 10px; color: var(--color-error-text);">Routes Not in Sitemap${uncovered.length > 20 ? ` (showing 20 of ${uncovered.length})` : ''}</h4>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: var(--color-error-bg); border-bottom: 1px solid #fecaca;">
                <th style="padding: 8px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-error-text);">Route Pattern</th>
                <th style="padding: 8px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-error-text);">Source File</th>
                <th style="padding: 8px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-error-text);">Type</th>
              </tr>
            </thead>
            <tbody>
              ${uncoveredRows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  return `
    <div style="background: var(--color-bg-surface); border-radius: var(--radius-xl); padding: 20px; box-shadow: var(--shadow-sm); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: var(--gray-800);">Route-to-Sitemap Coverage</h3>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 15px;">
        <div style="text-align: center; padding: 15px; background: var(--color-bg-page); border-radius: var(--radius-lg);">
          <div style="font-size: 28px; font-weight: var(--font-weight-bold); color: ${coverageColor};">${coveragePercent}%</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">Coverage</div>
        </div>
        <div style="text-align: center; padding: 15px; background: var(--color-bg-page); border-radius: var(--radius-lg);">
          <div style="font-size: 28px; font-weight: var(--font-weight-bold); color: var(--gray-800);">${stats.totalRoutes}</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">Total Routes</div>
        </div>
        <div style="text-align: center; padding: 15px; background: var(--color-bg-page); border-radius: var(--radius-lg);">
          <div style="font-size: 28px; font-weight: var(--font-weight-bold); color: var(--color-success);">${stats.coveredRoutes}</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">In Sitemap</div>
        </div>
        <div style="text-align: center; padding: 15px; background: var(--color-bg-page); border-radius: var(--radius-lg);">
          <div style="font-size: 28px; font-weight: var(--font-weight-bold); color: var(--color-error);">${stats.uncoveredRoutes}</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">Missing</div>
        </div>
        <div style="text-align: center; padding: 15px; background: var(--color-bg-page); border-radius: var(--radius-lg);">
          <div style="font-size: 28px; font-weight: var(--font-weight-bold); color: #7c3aed;">${stats.dynamicRoutes || 0}</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">Dynamic</div>
        </div>
      </div>

      ${uncoveredHtml}
    </div>
  `;
}

/**
 * Source mapping (issue -> source file locations)
 */
function getSourceMapping(repo: Record<string, unknown>) {
  const mapping = repo.sourceMapping as Record<string, unknown> | undefined;
  if (!mapping || Object.keys(mapping).length === 0) return '';

  const entries = Object.entries(mapping);

  const rows = entries
    .map(([issueKey, locations]: [string, unknown]) => {
      const locs = locations as Array<Record<string, unknown>>;
      const locationHtml = locs
        .slice(0, 5)
        .map((loc: Record<string, unknown>) => {
          const fileRef =
            (loc.line as number) > 1
              ? `<code>${escapeHtml(loc.file)}:${loc.line}</code>`
              : `<code>${escapeHtml(loc.file)}</code>`;
          return `
        <div style="margin-bottom: 6px;">
          <div>${fileRef}</div>
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${escapeHtml(loc.suggestion)}</div>
        </div>
      `;
        })
        .join('');

      const moreCount = locs.length > 5 ? locs.length - 5 : 0;

      return `
      <tr style="border-bottom: 1px solid var(--color-border-default);">
        <td style="padding: 12px; vertical-align: top; font-weight: var(--font-weight-medium); max-width: 300px;">${escapeHtml(issueKey)}</td>
        <td style="padding: 12px; vertical-align: top;">
          ${locationHtml}
          ${moreCount > 0 ? `<div style="font-size: var(--font-size-xs); color: var(--color-text-disabled);">...and ${moreCount} more location(s)</div>` : ''}
        </td>
      </tr>
    `;
    })
    .join('');

  return `
    <div style="background: var(--color-bg-surface); border-radius: var(--radius-xl); padding: 20px; box-shadow: var(--shadow-sm); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: var(--gray-800);">Issue-to-Source Mapping</h3>
      <p style="margin: 0 0 15px; color: var(--color-text-muted); font-size: var(--font-size-base);">
        The following audit issues were traced to source file locations in the repository.
      </p>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: var(--color-bg-page); border-bottom: 2px solid #e5e7eb;">
              <th style="padding: 10px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); text-transform: uppercase;">Issue</th>
              <th style="padding: 10px 12px; text-align: left; font-size: var(--font-size-xs); color: var(--color-text-muted); text-transform: uppercase;">Source Location(s)</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export { getSourceCodeAnalysis, renderRepoDetailHtml };
