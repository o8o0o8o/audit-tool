/**
 * Historical Progress Section
 * Displays trend charts and progress metrics over time
 */

/**
 * Generate the historical progress section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @param {Object} data.trendData - Historical trend data
 * @param {Object} data.previousAudit - Previous audit for comparison
 * @returns {string} HTML string for the historical progress section
 */
function getHistoricalProgress(data) {
  const { jsonData, trendData, previousAudit } = data;

  const currentScore = jsonData.analysis?.summary?.overallScore || 0;
  const currentIssues = jsonData.analysis?.summary?.totalIssues || 0;
  const auditCount = trendData?.labels?.length || 1;

  // Show first audit message if no previous audit
  if (!previousAudit || !trendData || auditCount < 2) {
    return `
      <div class="charts-section">
        <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Historical Progress</h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
          ${getInfoCard('Current Score', currentScore, '#8b5cf6', '#7c3aed', 'Out of 100')}
          ${getInfoCard('Total Issues', currentIssues, '#f59e0b', '#d97706', 'Found in this audit')}
          ${getInfoCard('Total Audits', auditCount, '#3b82f6', '#2563eb', 'Tracked over time')}
        </div>
        <div style="padding: 30px; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border-radius: 12px; text-align: center; border: 2px dashed #3b82f6;">
          <div style="font-size: 48px; margin-bottom: 15px;">📊</div>
          <h3 style="color: #1e40af; margin-bottom: 10px;">This is your first audit!</h3>
          <p style="color: #1e40af; max-width: 500px; margin: 0 auto; line-height: 1.6;">
            Run another audit later to see trends and compare progress over time.
            Historical charts will appear after your second audit.
          </p>
          <p style="color: #6b7280; font-size: 13px; margin-top: 15px;">
            💡 Tip: Schedule regular audits (weekly/monthly) to track SEO improvements
          </p>
        </div>
      </div>
    `;
  }

  const scoreDelta = currentScore - previousAudit.summary.overallScore;
  const issuesDelta = currentIssues - previousAudit.summary.totalIssues;

  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Historical Progress</h2>
      <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Track your SEO improvements over ${auditCount} audit${auditCount > 1 ? 's' : ''}</p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
        ${getDeltaCard('Score Change', scoreDelta, scoreDelta >= 0, 'Since last audit')}
        ${getDeltaCard('Issues Change', issuesDelta, issuesDelta <= 0, 'Since last audit', true)}
        ${getInfoCard('Total Audits', auditCount, '#3b82f6', '#2563eb', 'Tracked over time')}
        ${getInfoCard('Current Score', currentScore, '#8b5cf6', '#7c3aed', 'Out of 100')}
      </div>

      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-title">Overall Score Trend</div>
          <div class="chart-container">
            <canvas id="scoreTrendChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Total Issues Trend</div>
          <div class="chart-container">
            <canvas id="issuesTrendChart"></canvas>
          </div>
        </div>
      </div>

      ${getIssueTrendsSection(trendData)}
    </div>
  `;
}

/**
 * Generate the issue trends section with sparkline charts
 * @param {Object} trendData - Trend data including issueTrends
 * @returns {string} HTML string for the issue trends section
 */
function getIssueTrendsSection(trendData) {
  if (!trendData.issueTrends || Object.keys(trendData.issueTrends).length === 0) {
    return '';
  }

  // Get top 10 most significant trending issues
  const sortedIssues = Object.entries(trendData.issueTrends)
    .map(([issue, data]) => ({
      issue,
      ...data,
      // Priority score: critical/high severity + high count + significant change
      priorityScore: getSeverityWeight(data.severity) * data.latestCount * (1 + Math.abs(data.change) / 10)
    }))
    .filter(item => item.latestCount > 0 || item.trend === 'fixed') // Only show active or recently fixed
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 10);

  if (sortedIssues.length === 0) {
    return '';
  }

  const issueRows = sortedIssues.map((item, index) => {
    const trendIcon = getTrendIcon(item.trend);
    const severityColor = getSeverityColor(item.severity);
    const changeText = getChangeText(item);
    const firstCount = item.counts[0] || 0;
    const latestCount = item.latestCount;

    return `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #9ca3af; font-size: 12px;">${index + 1}.</span>
            <span style="font-size: 13px; color: #374151;">${escapeHtml(truncateIssue(item.issue, 60))}</span>
          </div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${severityColor}; color: white;">
            ${item.severity.toUpperCase()}
          </span>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          <div style="font-size: 12px; color: #6b7280;">${firstCount} pages</div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          <div style="font-size: 14px; font-weight: 600; color: #1f2937;">${latestCount} pages</div>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
            ${trendIcon}
            <span style="font-size: 12px; color: ${getTrendColor(item.trend)};">${changeText}</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div style="margin-top: 30px;">
      <h3 style="color: #1f2937; margin-bottom: 15px; display: flex; align-items: center; gap: 8px;">
        📊 Issue Changes Between Audits
        <span style="font-size: 12px; font-weight: 400; color: #6b7280;">(Top 10 most impactful)</span>
      </h3>
      <p style="color: #6b7280; font-size: 13px; margin-bottom: 15px;">
        Comparing affected pages: first audit → current audit. ↓ = improving (fewer pages), ↑ = worsening (more pages)
      </p>
      <div style="background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f9fafb;">
              <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Issue</th>
              <th style="padding: 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Severity</th>
              <th style="padding: 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">First Audit</th>
              <th style="padding: 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Now</th>
              <th style="padding: 12px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;">Change</th>
            </tr>
          </thead>
          <tbody>
            ${issueRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Helper functions for issue trends
 */
function getSeverityWeight(severity) {
  const weights = { critical: 4, high: 3, medium: 2, low: 1 };
  return weights[severity?.toLowerCase()] || 1;
}

function getSeverityColor(severity) {
  const colors = {
    critical: '#dc2626',
    high: '#ea580c',
    medium: '#f59e0b',
    low: '#6b7280'
  };
  return colors[severity?.toLowerCase()] || '#6b7280';
}

function getTrendIcon(trend) {
  const icons = {
    improving: '<span style="color: #10b981; font-size: 16px;">↓</span>',
    worsening: '<span style="color: #ef4444; font-size: 16px;">↑</span>',
    stable: '<span style="color: #6b7280; font-size: 16px;">→</span>',
    new: '<span style="color: #f59e0b; font-size: 14px;">🆕</span>',
    fixed: '<span style="color: #10b981; font-size: 14px;">✓</span>'
  };
  return icons[trend] || icons.stable;
}

function getTrendColor(trend) {
  const colors = {
    improving: '#10b981',
    worsening: '#ef4444',
    stable: '#6b7280',
    new: '#f59e0b',
    fixed: '#10b981'
  };
  return colors[trend] || '#6b7280';
}

function getChangeText(item) {
  if (item.trend === 'new') return 'New';
  if (item.trend === 'fixed') return 'Fixed';
  if (item.change === 0) return 'No change';
  const sign = item.change > 0 ? '+' : '';
  return `${sign}${item.change} (${sign}${item.changePercent}%)`;
}

function truncateIssue(issue, maxLength) {
  if (issue.length <= maxLength) return issue;
  return issue.substring(0, maxLength - 3) + '...';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate a delta card (shows change with color coding)
 */
function getDeltaCard(title, value, isPositive, subtitle, invertSign = false) {
  const displayValue = invertSign ? value : value;
  const gradient = isPositive
    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
    : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';

  return `
    <div style="background: ${gradient}; color: white; padding: 20px; border-radius: 8px; text-align: center;">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">${title}</div>
      <div style="font-size: 32px; font-weight: 700;">${displayValue > 0 ? '+' : ''}${displayValue}</div>
      <div style="font-size: 12px; opacity: 0.9;">${subtitle}</div>
    </div>
  `;
}

/**
 * Generate an info card (static value)
 */
function getInfoCard(title, value, gradientStart, gradientEnd, subtitle) {
  return `
    <div style="background: linear-gradient(135deg, ${gradientStart} 0%, ${gradientEnd} 100%); color: white; padding: 20px; border-radius: 8px; text-align: center;">
      <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">${title}</div>
      <div style="font-size: 32px; font-weight: 700;">${value}</div>
      <div style="font-size: 12px; opacity: 0.9;">${subtitle}</div>
    </div>
  `;
}

module.exports = { getHistoricalProgress };
