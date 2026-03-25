/**
 * Configuration Info Section
 * Displays robots.txt, sitemap, and crawl coverage information
 */

import { escapeHtml, makeUrlClickable } from '../html-utils';
import { extractAnalysis } from '../data-processor';
import type { PageInfo, ReportSectionData } from '../../types';

/**
 * Generate the configuration info section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @param {Array} data.pages - Array of page data
 * @returns {string} HTML string for the config info section
 */
function getConfigInfo(data: ReportSectionData) {
  const { jsonData, pages } = data;

  return `
    <div class="info-section">
      <h2>Configuration & Sitemaps</h2>
      <div class="info-grid">
        ${getRobotsCard(jsonData)}
        ${getSitemapsCard(jsonData)}
        ${getIssuesCard(jsonData)}
        ${getCoverageCard(jsonData, pages)}
      </div>
      ${getAuditConfigCard(jsonData)}
      ${getAnalysisConfigCard(jsonData)}
    </div>
  `;
}

/**
 * Generate the robots.txt info card
 */
function getRobotsCard(jsonData: Record<string, unknown>) {
  const robots = (jsonData.robots ?? {}) as Record<string, unknown>;
  const robotsSitemaps = (robots.sitemaps ?? []) as unknown[];
  const userAgents = (robots['user-agent'] ?? {}) as Record<string, unknown>;
  const analysisObj = extractAnalysis(jsonData);
  const overallIssues = (analysisObj.overall ?? []) as unknown[];
  const hasRobotsErrors =
    overallIssues.some((err: unknown) => err && typeof err === 'string' && err.toLowerCase().includes('robots')) ||
    false;

  let robotsStatus = 'success';
  let robotsStatusText = 'Found';

  if (hasRobotsErrors) {
    const errors = Array.from(overallIssues).filter(
      (err: unknown) => err && typeof err === 'string' && err.toLowerCase().includes('robots'),
    ) as string[];
    if (errors.some((e: string) => e.includes('Error fetching'))) {
      robotsStatus = 'error';
      robotsStatusText = 'Not Found';
    } else if (errors.some((e: string) => e.includes('empty'))) {
      robotsStatus = 'warning';
      robotsStatusText = 'Empty';
    }
  }

  const sitemapsList =
    robotsSitemaps.length > 0
      ? `
    <ul>
      ${robotsSitemaps
        .slice(0, 3)
        .map((sm: unknown) => `<li>${escapeHtml(sm)}</li>`)
        .join('')}
      ${robotsSitemaps.length > 3 ? `<li>... and ${robotsSitemaps.length - 3} more</li>` : ''}
    </ul>
  `
      : '<p style="color: var(--color-warning);">⚠ No sitemaps listed in robots.txt</p>';

  return `
    <div class="info-card ${robotsStatus}">
      <h3>🤖 Robots.txt</h3>
      <p><span class="label">Status:</span> ${robotsStatusText}</p>
      <p><span class="label">Sitemaps Listed:</span> ${robotsSitemaps.length}</p>
      ${sitemapsList}
      <p><span class="label">User-Agent Rules:</span> ${Object.keys(userAgents).length}</p>
    </div>
  `;
}

/**
 * Generate the sitemaps info card
 */
function getSitemapsCard(jsonData: Record<string, unknown>) {
  const sitemaps = (jsonData.sitemaps ?? {}) as Record<string, unknown>;
  const totalUrls = (sitemaps.total ?? 0) as number;

  // Get list of individual sitemaps (not the aggregated data)
  const individualSitemaps = Object.keys(sitemaps).filter(
    (key) => key !== 'urls' && key !== 'total' && typeof sitemaps[key] === 'object',
  );

  const analysisData = extractAnalysis(jsonData);
  const overallIssues = (analysisData.overall ?? []) as unknown[];
  const hasSitemapErrors =
    overallIssues.some((err: unknown) => err && typeof err === 'string' && err.toLowerCase().includes('sitemap')) ||
    false;

  const sitemapStatus = totalUrls > 0 ? 'success' : 'error';

  const sitemapsList =
    individualSitemaps.length > 0
      ? `
    <ul>
      ${individualSitemaps
        .slice(0, 3)
        .map((sm) => {
          const smData = (sitemaps[sm] ?? {}) as Record<string, unknown>;
          return `<li>${escapeHtml(sm)} <span style="color: var(--color-text-disabled);">(${smData.total ?? 0} URLs)</span></li>`;
        })
        .join('')}
      ${individualSitemaps.length > 3 ? `<li>... and ${individualSitemaps.length - 3} more</li>` : ''}
    </ul>
  `
      : '<p style="color: var(--color-error);">✗ No sitemaps found</p>';

  const errorsNote = hasSitemapErrors
    ? '<p style="color: var(--color-warning); margin-top: 8px;">⚠ Issues detected (see analysis below)</p>'
    : '';

  return `
    <div class="info-card ${sitemapStatus}">
      <h3>🗺️ Sitemaps</h3>
      <p><span class="label">Total Sitemaps:</span> ${individualSitemaps.length}</p>
      <p><span class="label">Total URLs:</span> ${totalUrls.toLocaleString()}</p>
      ${sitemapsList}
      ${errorsNote}
    </div>
  `;
}

/**
 * Generate the related issues card
 */
function getIssuesCard(jsonData: Record<string, unknown>) {
  const analysisObj = extractAnalysis(jsonData);
  const bySeverity = (analysisObj.bySeverity ?? {}) as Record<string, unknown[]>;

  // Filter for robots.txt and sitemap related issues
  const filterRobotsSitemap = (issues: unknown[]) =>
    issues.filter(
      (issue: unknown): issue is string =>
        typeof issue === 'string' &&
        (issue.toLowerCase().includes('robots') || issue.toLowerCase().includes('sitemap')),
    );
  const robotsSitemapIssues = {
    critical: filterRobotsSitemap(bySeverity.critical || []),
    high: filterRobotsSitemap(bySeverity.high || []),
    medium: filterRobotsSitemap(bySeverity.medium || []),
    low: filterRobotsSitemap(bySeverity.low || []),
  };

  const totalRobotsSitemapIssues =
    robotsSitemapIssues.critical.length +
    robotsSitemapIssues.high.length +
    robotsSitemapIssues.medium.length +
    robotsSitemapIssues.low.length;

  let issuesStatus = 'success';
  if (robotsSitemapIssues.critical.length > 0 || robotsSitemapIssues.high.length > 0) {
    issuesStatus = 'error';
  } else if (robotsSitemapIssues.medium.length > 0) {
    issuesStatus = 'warning';
  }

  if (totalRobotsSitemapIssues === 0) {
    return `
      <div class="info-card ${issuesStatus}">
        <h3>⚠️ Related Issues</h3>
        <p style="color: var(--color-success);">✓ No robots.txt or sitemap issues detected</p>
      </div>
    `;
  }

  const badgeCounts = [
    robotsSitemapIssues.critical.length > 0
      ? `<p><span class="issue-badge critical">CRITICAL</span> ${robotsSitemapIssues.critical.length}</p>`
      : '',
    robotsSitemapIssues.high.length > 0
      ? `<p><span class="issue-badge high">HIGH</span> ${robotsSitemapIssues.high.length}</p>`
      : '',
    robotsSitemapIssues.medium.length > 0
      ? `<p><span class="issue-badge medium">MEDIUM</span> ${robotsSitemapIssues.medium.length}</p>`
      : '',
    robotsSitemapIssues.low.length > 0
      ? `<p><span class="issue-badge low">LOW</span> ${robotsSitemapIssues.low.length}</p>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const issuesList = [
    ...robotsSitemapIssues.critical.slice(0, 2),
    ...robotsSitemapIssues.high.slice(0, 2),
    ...robotsSitemapIssues.medium.slice(0, 2),
  ]
    .map((issue) => {
      const cleanIssue = issue.replace(/\s*\[(critical|high|medium|low)\]\s*$/i, '');
      return `<li>${escapeHtml(cleanIssue)}</li>`;
    })
    .join('');

  return `
    <div class="info-card ${issuesStatus}">
      <h3>⚠️ Related Issues</h3>
      <p><span class="label">Total Issues:</span> ${totalRobotsSitemapIssues}</p>
      ${badgeCounts}
      <ul style="margin-top: 8px;">
        ${issuesList}
        ${totalRobotsSitemapIssues > 6 ? `<li>... and ${totalRobotsSitemapIssues - 6} more issues</li>` : ''}
      </ul>
    </div>
  `;
}

/**
 * Generate the crawl coverage card
 */
function getCoverageCard(jsonData: Record<string, unknown>, pages: PageInfo[]) {
  const sitemapData = (jsonData.sitemaps ?? {}) as Record<string, unknown>;
  const sitemapTotal = (sitemapData.total ?? 0) as number;
  const pagesCrawled = pages.length;
  const notCrawled = sitemapTotal - pagesCrawled;

  if (notCrawled <= 0) {
    return `
      <div class="info-card success">
        <h3>✅ Crawl Coverage</h3>
        <p style="color: var(--color-success);">All URLs from sitemap were successfully crawled</p>
        <p><span class="label">Sitemap URLs:</span> ${sitemapTotal}</p>
        <p><span class="label">Pages Crawled:</span> ${pagesCrawled}</p>
      </div>
    `;
  }

  const coveragePercent = ((pagesCrawled / sitemapTotal) * 100).toFixed(1);
  const cardClass = notCrawled > sitemapTotal * 0.1 ? 'error' : 'warning';

  // Find URLs in sitemap but not in crawled pages
  const sitemapUrls = new Set(Object.keys((sitemapData.urls ?? {}) as Record<string, unknown>));
  const crawledUrls = new Set(pages.map((p) => p.url));
  const missingUrls = Array.from(sitemapUrls).filter((url) => !crawledUrls.has(url));
  const showUrls = missingUrls.slice(0, 10);

  const missingUrlsHtml =
    missingUrls.length > 0
      ? `
    <details style="margin-top: 8px;">
      <summary style="cursor: pointer; color: var(--color-info); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold);">
        Show ${missingUrls.length} missing URL(s)
      </summary>
      <ul style="margin-top: 8px; font-size: var(--font-size-xs); max-height: 200px; overflow-y: auto;">
        ${showUrls.map((url) => `<li style="word-break: break-all; margin: 4px 0;">${makeUrlClickable(url)}</li>`).join('')}
        ${missingUrls.length > 10 ? `<li style="color: var(--color-text-disabled);">... and ${missingUrls.length - 10} more</li>` : ''}
      </ul>
    </details>
  `
      : '';

  return `
    <div class="info-card ${cardClass}">
      <h3>⚠️ Crawl Coverage</h3>
      <p><span class="label">Coverage:</span> ${coveragePercent}%</p>
      <p><span class="label">Sitemap URLs:</span> ${sitemapTotal.toLocaleString()}</p>
      <p><span class="label">Pages Crawled:</span> ${pagesCrawled.toLocaleString()}</p>
      <p><span class="label" style="color: var(--color-warning);">Not Crawled:</span> ${notCrawled.toLocaleString()}</p>
      <p style="margin-top: 8px; font-size: var(--font-size-xs); color: var(--color-text-muted);">
        ${notCrawled} URL(s) from the sitemap were not successfully crawled.
        This may be due to errors, timeouts, or redirects.
      </p>
      ${missingUrlsHtml}
    </div>
  `;
}

/**
 * Generate the audit configuration card
 */
function getAuditConfigCard(jsonData: Record<string, unknown>) {
  const timing = (jsonData.timing ?? {}) as Record<string, unknown>;
  const phases = (timing.phases ?? []) as Array<Record<string, unknown>>;

  if (phases.length === 0 && !timing.elapsedTimeFormatted) return '';

  const phaseRows = phases
    .map(
      (p: Record<string, unknown>) =>
        `<div class="perf-budget-row" data-phase-ms="${p.durationMs ?? 0}">
      <span class="perf-budget-label">${escapeHtml(p.name)}</span>
      <span class="perf-budget-value">${escapeHtml(p.duration)}</span>
    </div>`,
    )
    .join('');

  return `
    <div style="margin-top: 20px; padding: 16px; background: var(--color-bg-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);">
      <h3 style="margin: 0 0 12px; color: var(--gray-800); font-size: 15px;">Audit Timing</h3>
      ${timing.elapsedTimeFormatted ? `<p style="color: var(--color-text-muted); font-size: var(--font-size-sm); margin-bottom: 12px;">Total duration: <strong>${escapeHtml(timing.elapsedTimeFormatted)}</strong></p>` : ''}
      <div class="timing-phases">
        ${phaseRows}
      </div>
    </div>
  `;
}

/**
 * Generate analysis configuration card
 */
function getAnalysisConfigCard(jsonData: Record<string, unknown>) {
  const config = (jsonData.config ?? {}) as Record<string, unknown>;
  const analysis = (config.analysis ?? {}) as Record<string, unknown>;
  const flags = [];

  if (config.perf) flags.push('Performance metrics');
  if (config.saveHtml) flags.push('HTML snapshots');
  if (config.screenshots) flags.push('Screenshots');
  if (config.concurrency) flags.push(`Concurrency: ${config.concurrency}`);
  if (config.preset) flags.push(`Preset: ${config.preset}`);

  const analysisSettings = [];
  if (analysis.similarityThreshold) analysisSettings.push(`Similarity threshold: ${analysis.similarityThreshold}`);
  if (analysis.jsUnusedThreshold) analysisSettings.push(`JS unused threshold: ${analysis.jsUnusedThreshold}%`);
  if (analysis.cssUnusedThreshold) analysisSettings.push(`CSS unused threshold: ${analysis.cssUnusedThreshold}%`);
  if (analysis.maxOutboundChecks) analysisSettings.push(`Max outbound checks: ${analysis.maxOutboundChecks}`);
  if (analysis.outboundTimeout) analysisSettings.push(`Outbound timeout: ${analysis.outboundTimeout}ms`);

  if (flags.length === 0 && analysisSettings.length === 0) return '';

  return `
    <div style="margin-top: 20px; padding: 16px; background: var(--color-bg-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);">
      <h3 style="margin: 0 0 12px; color: var(--gray-800); font-size: 15px;">Audit Configuration</h3>
      ${
        flags.length > 0
          ? `
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
          ${flags.map((f) => `<span style="background: var(--color-bg-surface-alt); color: var(--color-text-secondary); padding: 4px 10px; border-radius: var(--radius-sm); font-size: var(--font-size-xs);">${escapeHtml(f)}</span>`).join('')}
        </div>
      `
          : ''
      }
      ${
        analysisSettings.length > 0
          ? `
        <div style="border-top: 1px solid #e5e7eb; padding-top: 10px;">
          <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: 6px;">Analysis Settings</div>
          ${analysisSettings.map((s) => `<div style="font-size: var(--font-size-xs); color: var(--color-text-secondary); margin: 3px 0;">${escapeHtml(s)}</div>`).join('')}
        </div>
      `
          : ''
      }
    </div>
  `;
}

export { getConfigInfo };
