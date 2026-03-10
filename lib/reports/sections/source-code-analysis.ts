/**
 * Source Code Analysis Section
 * Displays repository analysis results: framework detection, config validation,
 * route coverage, and issue-to-source mapping
 */

import { escapeHtml } from '../html-utils';

/**
 * Get severity badge HTML
 */
function getSeverityBadge(severity: string) {
  const colors = {
    critical: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' },
    high: { bg: '#fffbeb', border: '#fed7aa', text: '#92400e' },
    medium: { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af' },
    low: { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  };
  const c = (colors as Record<string, any>)[severity] || colors.medium;
  return `<span style="display: inline-block; padding: 2px 8px; background: ${c.bg}; border: 1px solid ${c.border}; border-radius: 4px; color: ${c.text}; font-size: 11px; font-weight: 600; text-transform: uppercase;">${escapeHtml(severity)}</span>`;
}

/**
 * Generate the source code analysis section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full JSON audit data
 * @returns {string} HTML string
 */
function getSourceCodeAnalysis(data: any) {
  const { jsonData } = data;
  const repo = jsonData?.repoAnalysis;

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
function getFrameworkInfo(repo: any) {
  if (!repo.framework) {
    return `
      <div style="padding: 15px; background: #fffbeb; border-radius: 8px; border-left: 4px solid #f59e0b; margin-bottom: 20px;">
        <p style="margin: 0; color: #92400e;">Could not detect a web framework from the repository.</p>
      </div>
    `;
  }

  const routerInfo = repo.router ? ` (${escapeHtml(repo.router)} router)` : '';
  const configInfo = repo.configFile ? `<code>${escapeHtml(repo.configFile)}</code>` : 'none found';

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
        <div style="font-size: 24px; font-weight: 700;">${escapeHtml(repo.framework)}</div>
        <div style="font-size: 13px; opacity: 0.9;">Framework${routerInfo}</div>
      </div>
      <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
        <div style="font-size: 24px; font-weight: 700;">${repo.version ? escapeHtml(repo.version) : 'N/A'}</div>
        <div style="font-size: 13px; opacity: 0.9;">Version</div>
      </div>
      <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
        <div style="font-size: 16px; font-weight: 700;">${configInfo}</div>
        <div style="font-size: 13px; opacity: 0.9;">Config File</div>
      </div>
    </div>
  `;
}

/**
 * Config validation results
 */
function getConfigValidation(repo: any) {
  const issues = repo.configIssues || [];
  const warnings = repo.configWarnings || [];

  if (issues.length === 0 && warnings.length === 0) {
    return `
      <div style="padding: 15px; background: #f0fdf4; border-radius: 8px; border-left: 4px solid #10b981; margin-bottom: 20px;">
        <p style="margin: 0; color: #065f46; font-weight: 600;">All framework configuration checks passed.</p>
      </div>
    `;
  }

  const allFindings = [
    ...issues.map(i => ({ ...i, type: 'issue' })),
    ...warnings.map(w => ({ ...w, type: 'warning' })),
  ];

  const rows = allFindings.map(f => `
    <tr>
      <td style="padding: 10px 12px;">${getSeverityBadge(f.severity)}</td>
      <td style="padding: 10px 12px; font-weight: 500;">${escapeHtml(f.message)}</td>
      <td style="padding: 10px 12px; font-size: 13px; color: #4b5563;">${escapeHtml(f.detail || '')}</td>
    </tr>
  `).join('');

  return `
    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: #1f2937;">Framework Configuration</h3>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
              <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase; width: 100px;">Severity</th>
              <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Finding</th>
              <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Details</th>
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
function getRouteCoverage(repo: any) {
  const stats = repo.routeCoverage;
  if (!stats) return '';

  const details = repo.routeDetails || {};
  const coveragePercent = stats.totalRoutes > 0
    ? Math.round((stats.coveredRoutes / stats.totalRoutes) * 100)
    : 0;

  const coverageColor = coveragePercent >= 80 ? '#10b981' :
                        coveragePercent >= 50 ? '#f59e0b' : '#ef4444';

  // Uncovered routes table
  let uncoveredHtml = '';
  const uncovered = details.uncoveredRoutes || [];
  if (uncovered.length > 0) {
    const uncoveredRows = uncovered.slice(0, 20).map(r => `
      <tr>
        <td style="padding: 8px 12px;"><code>${escapeHtml(r.pattern)}</code></td>
        <td style="padding: 8px 12px; font-size: 13px; color: #6b7280;"><code>${escapeHtml(r.file)}</code></td>
        <td style="padding: 8px 12px;">${r.isDynamic
          ? '<span style="color: #7c3aed; font-size: 12px;">dynamic</span>'
          : '<span style="color: #2563eb; font-size: 12px;">static</span>'}</td>
      </tr>
    `).join('');

    uncoveredHtml = `
      <div style="margin-top: 15px;">
        <h4 style="margin: 0 0 10px; color: #991b1b;">Routes Not in Sitemap${uncovered.length > 20 ? ` (showing 20 of ${uncovered.length})` : ''}</h4>
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #fef2f2; border-bottom: 1px solid #fecaca;">
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #991b1b;">Route Pattern</th>
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #991b1b;">Source File</th>
                <th style="padding: 8px 12px; text-align: left; font-size: 12px; color: #991b1b;">Type</th>
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
    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: #1f2937;">Route-to-Sitemap Coverage</h3>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 15px;">
        <div style="text-align: center; padding: 15px; background: #f9fafb; border-radius: 8px;">
          <div style="font-size: 28px; font-weight: 700; color: ${coverageColor};">${coveragePercent}%</div>
          <div style="font-size: 12px; color: #6b7280;">Coverage</div>
        </div>
        <div style="text-align: center; padding: 15px; background: #f9fafb; border-radius: 8px;">
          <div style="font-size: 28px; font-weight: 700; color: #1f2937;">${stats.totalRoutes}</div>
          <div style="font-size: 12px; color: #6b7280;">Total Routes</div>
        </div>
        <div style="text-align: center; padding: 15px; background: #f9fafb; border-radius: 8px;">
          <div style="font-size: 28px; font-weight: 700; color: #10b981;">${stats.coveredRoutes}</div>
          <div style="font-size: 12px; color: #6b7280;">In Sitemap</div>
        </div>
        <div style="text-align: center; padding: 15px; background: #f9fafb; border-radius: 8px;">
          <div style="font-size: 28px; font-weight: 700; color: #ef4444;">${stats.uncoveredRoutes}</div>
          <div style="font-size: 12px; color: #6b7280;">Missing</div>
        </div>
        <div style="text-align: center; padding: 15px; background: #f9fafb; border-radius: 8px;">
          <div style="font-size: 28px; font-weight: 700; color: #7c3aed;">${stats.dynamicRoutes || 0}</div>
          <div style="font-size: 12px; color: #6b7280;">Dynamic</div>
        </div>
      </div>

      ${uncoveredHtml}
    </div>
  `;
}

/**
 * Source mapping (issue -> source file locations)
 */
function getSourceMapping(repo: any) {
  const mapping = repo.sourceMapping;
  if (!mapping || Object.keys(mapping).length === 0) return '';

  const entries = Object.entries(mapping);

  const rows = entries.map(([issueKey, locations]: [string, any]) => {
    const locationHtml = locations.slice(0, 5).map((loc: any) => {
      const fileRef = loc.line > 1
        ? `<code>${escapeHtml(loc.file)}:${loc.line}</code>`
        : `<code>${escapeHtml(loc.file)}</code>`;
      return `
        <div style="margin-bottom: 6px;">
          <div>${fileRef}</div>
          <div style="font-size: 12px; color: #6b7280;">${escapeHtml(loc.suggestion)}</div>
        </div>
      `;
    }).join('');

    const moreCount = locations.length > 5 ? locations.length - 5 : 0;

    return `
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 12px; vertical-align: top; font-weight: 500; max-width: 300px;">${escapeHtml(issueKey)}</td>
        <td style="padding: 12px; vertical-align: top;">
          ${locationHtml}
          ${moreCount > 0 ? `<div style="font-size: 12px; color: #9ca3af;">...and ${moreCount} more location(s)</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px; color: #1f2937;">Issue-to-Source Mapping</h3>
      <p style="margin: 0 0 15px; color: #6b7280; font-size: 14px;">
        The following audit issues were traced to source file locations in the repository.
      </p>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
              <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Issue</th>
              <th style="padding: 10px 12px; text-align: left; font-size: 12px; color: #6b7280; text-transform: uppercase;">Source Location(s)</th>
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

export { getSourceCodeAnalysis };