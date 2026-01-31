/**
 * Configuration Info Section
 * Displays robots.txt, sitemap, and crawl coverage information
 */

const { escapeHtml, makeUrlClickable } = require('../html-utils');

/**
 * Generate the configuration info section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @param {Array} data.pages - Array of page data
 * @returns {string} HTML string for the config info section
 */
function getConfigInfo(data) {
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
    </div>
  `;
}

/**
 * Generate the robots.txt info card
 */
function getRobotsCard(jsonData) {
  const robots = jsonData.robots || {};
  const robotsSitemaps = robots.sitemaps || [];
  const userAgents = robots['user-agent'] || {};
  const hasRobotsErrors = jsonData.analysis?.overall?.some(err =>
    err && typeof err === 'string' && err.toLowerCase().includes('robots')
  ) || false;

  let robotsStatus = 'success';
  let robotsStatusText = 'Found';

  if (hasRobotsErrors) {
    const errors = Array.from(jsonData.analysis?.overall || []).filter(err =>
      err && typeof err === 'string' && err.toLowerCase().includes('robots')
    );
    if (errors.some(e => e.includes('Error fetching'))) {
      robotsStatus = 'error';
      robotsStatusText = 'Not Found';
    } else if (errors.some(e => e.includes('empty'))) {
      robotsStatus = 'warning';
      robotsStatusText = 'Empty';
    }
  }

  const sitemapsList = robotsSitemaps.length > 0 ? `
    <ul>
      ${robotsSitemaps.slice(0, 3).map(sm => `<li>${escapeHtml(sm)}</li>`).join('')}
      ${robotsSitemaps.length > 3 ? `<li>... and ${robotsSitemaps.length - 3} more</li>` : ''}
    </ul>
  ` : '<p style="color: #f59e0b;">⚠ No sitemaps listed in robots.txt</p>';

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
function getSitemapsCard(jsonData) {
  const sitemaps = jsonData.sitemaps || {};
  const totalUrls = sitemaps.total || 0;

  // Get list of individual sitemaps (not the aggregated data)
  const individualSitemaps = Object.keys(sitemaps).filter(key =>
    key !== 'urls' && key !== 'total' && typeof sitemaps[key] === 'object'
  );

  const hasSitemapErrors = jsonData.analysis?.overall?.some(err =>
    err && typeof err === 'string' && err.toLowerCase().includes('sitemap')
  ) || false;

  const sitemapStatus = totalUrls > 0 ? 'success' : 'error';

  const sitemapsList = individualSitemaps.length > 0 ? `
    <ul>
      ${individualSitemaps.slice(0, 3).map(sm => {
        const smData = sitemaps[sm];
        return `<li>${escapeHtml(sm)} <span style="color: #9ca3af;">(${smData.total || 0} URLs)</span></li>`;
      }).join('')}
      ${individualSitemaps.length > 3 ? `<li>... and ${individualSitemaps.length - 3} more</li>` : ''}
    </ul>
  ` : '<p style="color: #ef4444;">✗ No sitemaps found</p>';

  const errorsNote = hasSitemapErrors
    ? '<p style="color: #f59e0b; margin-top: 8px;">⚠ Issues detected (see analysis below)</p>'
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
function getIssuesCard(jsonData) {
  const analysis = jsonData.analysis || {};
  const bySeverity = analysis.bySeverity || {};

  // Filter for robots.txt and sitemap related issues
  const robotsSitemapIssues = {
    critical: (bySeverity.critical || []).filter(issue =>
      issue && typeof issue === 'string' && (
        issue.toLowerCase().includes('robots') ||
        issue.toLowerCase().includes('sitemap')
      )
    ),
    high: (bySeverity.high || []).filter(issue =>
      issue && typeof issue === 'string' && (
        issue.toLowerCase().includes('robots') ||
        issue.toLowerCase().includes('sitemap')
      )
    ),
    medium: (bySeverity.medium || []).filter(issue =>
      issue && typeof issue === 'string' && (
        issue.toLowerCase().includes('robots') ||
        issue.toLowerCase().includes('sitemap')
      )
    ),
    low: (bySeverity.low || []).filter(issue =>
      issue && typeof issue === 'string' && (
        issue.toLowerCase().includes('robots') ||
        issue.toLowerCase().includes('sitemap')
      )
    ),
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
        <p style="color: #10b981;">✓ No robots.txt or sitemap issues detected</p>
      </div>
    `;
  }

  const badgeCounts = [
    robotsSitemapIssues.critical.length > 0 ? `<p><span class="issue-badge critical">CRITICAL</span> ${robotsSitemapIssues.critical.length}</p>` : '',
    robotsSitemapIssues.high.length > 0 ? `<p><span class="issue-badge high">HIGH</span> ${robotsSitemapIssues.high.length}</p>` : '',
    robotsSitemapIssues.medium.length > 0 ? `<p><span class="issue-badge medium">MEDIUM</span> ${robotsSitemapIssues.medium.length}</p>` : '',
    robotsSitemapIssues.low.length > 0 ? `<p><span class="issue-badge low">LOW</span> ${robotsSitemapIssues.low.length}</p>` : '',
  ].filter(Boolean).join('');

  const issuesList = [
    ...robotsSitemapIssues.critical.slice(0, 2),
    ...robotsSitemapIssues.high.slice(0, 2),
    ...robotsSitemapIssues.medium.slice(0, 2)
  ].map(issue => {
    const cleanIssue = issue.replace(/\s*\[(critical|high|medium|low)\]\s*$/i, '');
    return `<li>${escapeHtml(cleanIssue)}</li>`;
  }).join('');

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
function getCoverageCard(jsonData, pages) {
  const sitemapTotal = jsonData.sitemaps?.total || 0;
  const pagesCrawled = pages.length;
  const notCrawled = sitemapTotal - pagesCrawled;

  if (notCrawled <= 0) {
    return `
      <div class="info-card success">
        <h3>✅ Crawl Coverage</h3>
        <p style="color: #10b981;">All URLs from sitemap were successfully crawled</p>
        <p><span class="label">Sitemap URLs:</span> ${sitemapTotal}</p>
        <p><span class="label">Pages Crawled:</span> ${pagesCrawled}</p>
      </div>
    `;
  }

  const coveragePercent = ((pagesCrawled / sitemapTotal) * 100).toFixed(1);
  const cardClass = notCrawled > (sitemapTotal * 0.1) ? 'error' : 'warning';

  // Find URLs in sitemap but not in crawled pages
  const sitemapUrls = new Set(Object.keys(jsonData.sitemaps?.urls || {}));
  const crawledUrls = new Set(pages.map(p => p.url));
  const missingUrls = Array.from(sitemapUrls).filter(url => !crawledUrls.has(url));
  const showUrls = missingUrls.slice(0, 10);

  const missingUrlsHtml = missingUrls.length > 0 ? `
    <details style="margin-top: 8px;">
      <summary style="cursor: pointer; color: #3b82f6; font-size: 12px; font-weight: 600;">
        Show ${missingUrls.length} missing URL(s)
      </summary>
      <ul style="margin-top: 8px; font-size: 11px; max-height: 200px; overflow-y: auto;">
        ${showUrls.map(url => `<li style="word-break: break-all; margin: 4px 0;">${makeUrlClickable(url)}</li>`).join('')}
        ${missingUrls.length > 10 ? `<li style="color: #9ca3af;">... and ${missingUrls.length - 10} more</li>` : ''}
      </ul>
    </details>
  ` : '';

  return `
    <div class="info-card ${cardClass}">
      <h3>⚠️ Crawl Coverage</h3>
      <p><span class="label">Coverage:</span> ${coveragePercent}%</p>
      <p><span class="label">Sitemap URLs:</span> ${sitemapTotal.toLocaleString()}</p>
      <p><span class="label">Pages Crawled:</span> ${pagesCrawled.toLocaleString()}</p>
      <p><span class="label" style="color: #f59e0b;">Not Crawled:</span> ${notCrawled.toLocaleString()}</p>
      <p style="margin-top: 8px; font-size: 12px; color: #6b7280;">
        ${notCrawled} URL(s) from the sitemap were not successfully crawled.
        This may be due to errors, timeouts, or redirects.
      </p>
      ${missingUrlsHtml}
    </div>
  `;
}

module.exports = { getConfigInfo };
