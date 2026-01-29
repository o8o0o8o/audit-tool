const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Helper function to read JSON file (handles both compressed and uncompressed)
function readJsonFile(filePath) {
  // Check if .json.gz exists first (new format)
  const gzPath = filePath.endsWith('.gz') ? filePath : filePath + '.gz';
  const jsonPath = filePath.replace(/\.gz$/, '');

  let actualPath;
  let isCompressed = false;

  if (fs.existsSync(gzPath)) {
    actualPath = gzPath;
    isCompressed = true;
  } else if (fs.existsSync(jsonPath)) {
    actualPath = jsonPath;
    isCompressed = false;
  } else {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileContent = fs.readFileSync(actualPath);

  if (isCompressed) {
    const decompressed = zlib.gunzipSync(fileContent);
    return JSON.parse(decompressed.toString('utf-8'));
  } else {
    return JSON.parse(fileContent.toString('utf-8'));
  }
}

function generateHTML(file, domainName, outputPath = null) {
  const jsonData = readJsonFile(file);

  // Determine output path
  const htmlOutputPath = outputPath || `${domainName}.html`;

  // Load history data if available
  // Try new location first, then legacy location
  const newHistoryPath = path.join('audit-results', domainName, 'audit-history.json');
  const legacyHistoryPath = path.join('.audit-history', `${domainName}.history.json`);
  const historyPath = fs.existsSync(newHistoryPath) ? newHistoryPath : legacyHistoryPath;

  let trendData = null;
  let previousAudit = null;

  if (fs.existsSync(historyPath)) {
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (history.audits && history.audits.length > 0) {
        trendData = {
          labels: history.audits.map(a => a.date),
          scores: history.audits.map(a => a.summary.overallScore),
          issues: history.audits.map(a => a.summary.totalIssues),
          critical: history.audits.map(a => a.summary.criticalCount)
        };

        if (history.audits.length >= 2) {
          previousAudit = history.audits[history.audits.length - 2];
        }
      }
    } catch (e) {
      console.log('Could not load history data');
    }
  }

  // Load and merge archived pages if they exist
  if (jsonData.archiveInfo && jsonData.archiveInfo.lastArchivePart) {
    console.log(`Loading ${jsonData.archiveInfo.lastArchivePart} archive file(s)...`);

    // Get directory from the input file path
    const fileDir = path.dirname(file);
    for (let i = 1; i <= jsonData.archiveInfo.lastArchivePart; i++) {
      const archiveFile = path.join(fileDir, `SEOAnalysis__${domainName}__archive_part${i}.json`);
      try {
        console.log(`  - Loading archive part ${i}...`);
        const archiveData = readJsonFile(archiveFile);

        // Merge archived pages
        if (!jsonData.pageData) {
          jsonData.pageData = { pages: {} };
        }
        if (!jsonData.pageData.pages) {
          jsonData.pageData.pages = {};
        }

        jsonData.pageData.pages = {
          ...jsonData.pageData.pages,
          ...archiveData.pages,
        };

        console.log(`    Loaded ${Object.keys(archiveData.pages).length} pages from archive part ${i}`);
      } catch (error) {
        console.warn(`  ⚠️  Could not load archive part ${i}: ${error.message}`);
      }
    }

    console.log(`✓ All archived pages loaded. Total pages: ${Object.keys(jsonData.pageData.pages).length}\n`);
  }

  // Thresholds from robots.js
  const THRESHOLDS = {
    TTFB: 800,
    FCP: 1800,
    LCP: 2500,
    CLS: 0.1,
    PAGE_SIZE: 6000000,
    REQUEST_COUNT: 20,
    TITLE_MIN: 30,
    TITLE_MAX: 60,
    DESCRIPTION_MIN: 120,
    DESCRIPTION_MAX: 160,
    H2_COUNT: 10,
    URL_LENGTH_RECOMMENDED: 75,
    URL_LENGTH_MAX: 100,
    URL_DEPTH_MAX: 3,
  };

  // Escape HTML to prevent XSS
  function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Format bytes to human-readable size
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  // Get status badge color
  function getStatusColor(status) {
    if (status === 200) return '#10b981';
    if (status >= 300 && status < 400) return '#3b82f6';
    if (status >= 400 && status < 500) return '#f59e0b';
    return '#ef4444';
  }

  // Get metric color based on threshold
  function getMetricColor(value, threshold, isInverse = false) {
    if (value === null || value === undefined || value === 'N/A') return '#9ca3af';

    const numValue = parseFloat(value);
    if (isNaN(numValue)) return '#9ca3af';

    if (isInverse) {
      // For metrics where lower is better
      if (numValue <= threshold) return '#10b981'; // Good
      if (numValue <= threshold * 1.5) return '#f59e0b'; // Warning
      return '#ef4444'; // Bad
    } else {
      // For metrics where higher is better
      if (numValue >= threshold) return '#10b981';
      if (numValue >= threshold * 0.8) return '#f59e0b';
      return '#ef4444';
    }
  }

  // Get text length color
  function getTextLengthColor(length, min, max) {
    if (!length) return '#ef4444';
    if (length < min) return '#f59e0b';
    if (length > max) return '#f59e0b';
    return '#10b981';
  }

  // Check if page has meta tag
  function hasMetaTag(page, tagName) {
    if (!page.meta || !Array.isArray(page.meta)) return false;
    return page.meta.some(metaObj => metaObj[tagName] !== undefined);
  }

  // Count missing important meta tags
  function getMissingMetaTags(page) {
    const importantTags = ['robots', 'og:title', 'og:image', 'twitter:card'];
    return importantTags.filter(tag => !hasMetaTag(page, tag));
  }

  // Check heading structure for issues
  // Helper function to make URLs clickable
  function makeUrlClickable(url) {
    const escapedUrl = escapeHtml(url);
    return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; text-decoration: none;">${escapedUrl}</a>`;
  }

  function hasHeadingStructureIssue(headings) {
    if (!headings || !Array.isArray(headings)) return false;

    // Check for skipped levels (e.g., h1 -> h3 with no h2)
    for (let i = 0; i < headings.length - 1; i++) {
      const current = headings[i];
      const next = headings[i + 1];

      // If current level has no tags but next level does, that's a skip
      if (current.count === 0 && next.count > 0) {
        // Check if there's any earlier level with tags
        const hasEarlierTags = headings.slice(0, i).some(h => h.count > 0);
        if (hasEarlierTags) {
          return true; // Found a gap
        }
      }
    }
    return false;
  }

  // Generate tooltip for metrics
  function getMetricTooltip(value, threshold, metricName, unit = '', isInverse = false) {
    if (value === null || value === undefined || value === 'N/A') return '';

    const numValue = parseFloat(value);
    if (isNaN(numValue)) return '';

    if (isInverse) {
      if (numValue <= threshold) return '';
      if (numValue <= threshold * 1.5) {
        return `Warning: ${metricName} is ${value}${unit} (threshold: ≤${threshold}${unit})`;
      }
      return `Error: ${metricName} is ${value}${unit} (threshold: ≤${threshold}${unit})`;
    } else {
      if (numValue >= threshold) return '';
      if (numValue >= threshold * 0.8) {
        return `Warning: ${metricName} is ${value}${unit} (threshold: ≥${threshold}${unit})`;
      }
      return `Error: ${metricName} is ${value}${unit} (threshold: ≥${threshold}${unit})`;
    }
  }

  // Generate tooltip for text length
  function getTextLengthTooltip(length, min, max, fieldName) {
    if (!length) return `Error: ${fieldName} is missing`;
    if (length < min) return `Warning: ${fieldName} is too short (${length} chars, recommended: ${min}-${max})`;
    if (length > max) return `Warning: ${fieldName} is too long (${length} chars, recommended: ${min}-${max})`;
    return '';
  }

  // Get page data
  const pageData = jsonData.pageData || {
    pages: {},
    totalWithoutError: 0,
    totalWithError: 0,
    total: 0,
  };

  // Get timing data
  const timing = jsonData.timing || {
    startTime: null,
    endTime: null,
    elapsedTime: null,
    elapsedTimeFormatted: null,
  };

  // Get all pages
  const pages = Object.values(pageData.pages || {});
  const pagesWithMetrics = pages.filter(p => p.TTFB !== undefined);

  // Count pages by source
  const pagesFromSitemap = pages.filter(p => p.foundIn === 'sitemap').length;
  const pagesDiscovered = pages.filter(p => p.foundIn === 'discovered').length;

  let htmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SEO Audit Report - ${domainName}</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      <style>
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }

          body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #f9fafb;
              color: #111827;
              line-height: 1.6;
              padding: 20px;
          }

          .container {
              max-width: 100%;
              margin: 0 auto;
          }

          header {
              background: white;
              padding: 24px 30px;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              margin-bottom: 20px;
          }

          h1 {
              font-size: 28px;
              font-weight: 700;
              color: #111827;
              margin-bottom: 8px;
          }

          .subtitle {
              color: #6b7280;
              font-size: 14px;
          }

          .stats {
              display: flex;
              gap: 20px;
              margin-top: 12px;
              flex-wrap: wrap;
          }

          .stat {
              font-size: 14px;
          }

          .stat-label {
              color: #6b7280;
          }

          .stat-value {
              font-weight: 600;
              color: #111827;
          }

          .table-container {
              background: white;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              overflow-x: auto;
              overflow-y: visible;
              position: relative;
          }

          .table-container::after {
              content: '';
              position: absolute;
              top: 0;
              right: 0;
              bottom: 0;
              width: 30px;
              background: linear-gradient(to left, rgba(255,255,255,0.9), transparent);
              pointer-events: none;
          }

          table {
              width: 100%;
              min-width: 4500px;
              border-collapse: collapse;
              font-size: 13px;
          }

          thead {
              background: #f9fafb;
              position: sticky;
              top: 0;
              z-index: 10;
          }

          th {
              padding: 12px 8px;
              text-align: left;
              font-weight: 600;
              color: #374151;
              border-bottom: 2px solid #e5e7eb;
              white-space: nowrap;
          }

          th.url-col {
              min-width: 300px;
              max-width: 400px;
          }

          th .threshold {
              display: block;
              font-size: 11px;
              font-weight: 500;
              color: #9ca3af;
              margin-top: 2px;
          }

          td {
              padding: 10px 8px;
              border-bottom: 1px solid #e5e7eb;
              color: #6b7280;
          }

          tr:hover td {
              background: #f9fafb;
          }

          tr:hover td:first-child {
              background: #e5e7eb;
          }

          tr:last-child td {
              border-bottom: none;
          }

          tbody tr td:first-child {
              position: sticky;
              left: 0;
              background: white;
              z-index: 5;
              border-right: 1px solid #e5e7eb;
          }

          tbody tr:hover td:first-child {
              background: #e5e7eb;
          }

          .url-link {
              color: #2563eb;
              text-decoration: none;
              word-break: break-all;
              font-weight: 500;
          }

          .url-link:hover {
              text-decoration: underline;
          }

          .source-badge {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 10px;
              font-weight: 600;
              text-transform: uppercase;
              margin-left: 8px;
              vertical-align: middle;
          }

          .source-sitemap {
              background: #dbeafe;
              color: #1e40af;
          }

          .source-discovered {
              background: #fef3c7;
              color: #92400e;
          }

          .status-badge {
              display: inline-block;
              padding: 3px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
              color: white;
              text-align: center;
              min-width: 40px;
          }

          .metric-cell {
              font-weight: 600;
              text-align: right;
          }

          .text-cell {
              max-width: 200px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
          }

          td[title]:not([title=""]) {
              cursor: pointer;
              position: relative;
          }

          td[title]:not([title=""]):hover {
              background: #f3f4f6;
          }

          td[title]:not([title=""])::after {
              content: 'ℹ';
              position: absolute;
              top: 2px;
              right: 2px;
              font-size: 10px;
              color: #9ca3af;
              opacity: 0.5;
              transition: opacity 0.2s;
          }

          td[title]:not([title=""]):hover::after {
              opacity: 1;
              color: #3b82f6;
          }

          /* Incoming links cell styles */
          .incoming-links-cell[data-count]:not([data-count="0"]):hover {
              background: #f3f4f6;
          }

          /* Modal styles */
          .modal-overlay {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: rgba(0, 0, 0, 0.5);
              z-index: 1000;
              animation: fadeIn 0.2s ease-out;
          }

          .modal-overlay.active {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
          }

          .modal-content {
              background: white;
              border-radius: 8px;
              box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
              max-width: 600px;
              width: 100%;
              max-height: 80vh;
              overflow-y: auto;
              animation: slideUp 0.2s ease-out;
          }

          .modal-header {
              padding: 20px 24px;
              border-bottom: 1px solid #e5e7eb;
              display: flex;
              align-items: center;
              justify-content: space-between;
          }

          .modal-title {
              font-size: 18px;
              font-weight: 600;
              color: #111827;
              margin: 0;
          }

          .modal-close {
              background: none;
              border: none;
              font-size: 24px;
              color: #9ca3af;
              cursor: pointer;
              padding: 0;
              width: 32px;
              height: 32px;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 4px;
              transition: all 0.2s;
          }

          .modal-close:hover {
              background: #f3f4f6;
              color: #111827;
          }

          .modal-body {
              padding: 24px;
              color: #374151;
              line-height: 1.6;
              word-wrap: break-word;
          }

          .modal-body.with-html {
              white-space: normal;
          }

          .modal-body.with-html pre {
              white-space: pre-wrap;
              background: #f9fafb;
              padding: 12px;
              border-radius: 4px;
              font-size: 13px;
              margin: 12px 0;
          }

          .metric-section {
              margin-bottom: 16px;
              padding-bottom: 16px;
              border-bottom: 1px solid #e5e7eb;
          }

          .metric-section:last-child {
              border-bottom: none;
              margin-bottom: 0;
              padding-bottom: 0;
          }

          .metric-section h4 {
              font-size: 14px;
              font-weight: 600;
              color: #111827;
              margin-bottom: 8px;
          }

          .metric-section p {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .threshold-grid {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 8px;
              margin: 12px 0;
          }

          .threshold-item {
              padding: 8px;
              border-radius: 4px;
              font-size: 12px;
              text-align: center;
          }

          .threshold-good {
              background: #f0fdf4;
              color: #166534;
              border: 1px solid #bbf7d0;
          }

          .threshold-warning {
              background: #fffbeb;
              color: #92400e;
              border: 1px solid #fde68a;
          }

          .threshold-bad {
              background: #fef2f2;
              color: #991b1b;
              border: 1px solid #fecaca;
          }

          .source-links {
              margin-top: 12px;
          }

          .source-links h4 {
              font-size: 13px;
              font-weight: 600;
              color: #374151;
              margin-bottom: 8px;
          }

          .source-links a {
              display: block;
              color: #2563eb;
              text-decoration: none;
              font-size: 13px;
              padding: 6px 0;
              transition: color 0.2s;
          }

          .source-links a:hover {
              color: #1d4ed8;
              text-decoration: underline;
          }

          .source-links a::before {
              content: '→ ';
              margin-right: 4px;
          }

          .modal-url {
              font-size: 12px;
              color: #6b7280;
              background: #f9fafb;
              padding: 8px 12px;
              border-radius: 4px;
              word-break: break-all;
              margin-bottom: 16px;
          }

          @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
          }

          @keyframes slideUp {
              from {
                  opacity: 0;
                  transform: translateY(20px);
              }
              to {
                  opacity: 1;
                  transform: translateY(0);
              }
          }

          th.sortable {
              cursor: pointer;
              user-select: none;
              position: relative;
              padding-right: 20px;
          }

          th.sortable:hover {
              background: #f3f4f6;
          }

          th.sortable::after {
              content: '⇅';
              position: absolute;
              right: 8px;
              opacity: 0.3;
              font-size: 12px;
          }

          th.sortable.asc::after {
              content: '↑';
              opacity: 1;
              color: #3b82f6;
          }

          th.sortable.desc::after {
              content: '↓';
              opacity: 1;
              color: #3b82f6;
          }

          footer {
              text-align: center;
              padding: 20px;
              color: #9ca3af;
              font-size: 13px;
              margin-top: 20px;
          }

          .good { color: #10b981; }
          .warning { color: #f59e0b; }
          .bad { color: #ef4444; }
          .neutral { color: #9ca3af; }

          /* Executive Summary Styles */
          .executive-summary {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 30px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
          }

          .executive-summary h2 {
              font-size: 24px;
              font-weight: 700;
              margin-bottom: 20px;
              text-align: center;
          }

          .summary-score {
              text-align: center;
              margin-bottom: 30px;
          }

          .score-circle {
              display: inline-block;
              width: 140px;
              height: 140px;
              border-radius: 50%;
              background: rgba(255, 255, 255, 0.2);
              display: flex;
              align-items: center;
              justify-content: center;
              flex-direction: column;
              margin: 0 auto;
              backdrop-filter: blur(10px);
              border: 3px solid rgba(255, 255, 255, 0.3);
          }

          .score-number {
              font-size: 48px;
              font-weight: 800;
              line-height: 1;
          }

          .score-label {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 1px;
              opacity: 0.9;
              margin-top: 4px;
          }

          .summary-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 15px;
              margin-top: 20px;
          }

          .summary-card {
              background: rgba(255, 255, 255, 0.15);
              backdrop-filter: blur(10px);
              padding: 16px;
              border-radius: 8px;
              text-align: center;
              border: 1px solid rgba(255, 255, 255, 0.2);
          }

          .summary-card-value {
              font-size: 28px;
              font-weight: 700;
              margin-bottom: 4px;
          }

          .summary-card-label {
              font-size: 12px;
              opacity: 0.9;
              text-transform: uppercase;
              letter-spacing: 0.5px;
          }

          .category-scores {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
              gap: 12px;
              margin-top: 20px;
          }

          .category-score-item {
              background: rgba(255, 255, 255, 0.1);
              padding: 12px;
              border-radius: 6px;
              text-align: center;
          }

          .category-score-value {
              font-size: 24px;
              font-weight: 700;
              margin-bottom: 4px;
          }

          .category-score-label {
              font-size: 11px;
              opacity: 0.85;
          }

          /* Quick Wins & Top Issues Styles */
          .quick-wins-section {
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 20px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
          }

          .top-issues-section {
              background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 20px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
          }

          .wins-issues-title {
              font-size: 22px;
              font-weight: 700;
              margin-bottom: 20px;
              text-align: center;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
          }

          .win-card, .issue-card {
              background: rgba(255, 255, 255, 0.15);
              backdrop-filter: blur(10px);
              padding: 20px;
              border-radius: 8px;
              margin-bottom: 15px;
              border: 1px solid rgba(255, 255, 255, 0.2);
              transition: transform 0.2s, box-shadow 0.2s;
          }

          .win-card:hover, .issue-card:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2);
          }

          .win-header, .issue-header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 12px;
              flex-wrap: wrap;
              gap: 10px;
          }

          .win-title, .issue-title {
              font-size: 16px;
              font-weight: 600;
              flex: 1;
              min-width: 200px;
          }

          .win-badges, .issue-badges {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
          }

          .win-badge, .issue-badge-item {
              padding: 4px 10px;
              border-radius: 12px;
              font-size: 11px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              background: rgba(255, 255, 255, 0.25);
          }

          .fix-content {
              margin: 12px 0;
              padding: 12px;
              background: rgba(0, 0, 0, 0.1);
              border-radius: 6px;
              font-size: 14px;
              line-height: 1.6;
          }

          .code-example {
              background: rgba(0, 0, 0, 0.3);
              padding: 12px;
              border-radius: 6px;
              font-family: 'Courier New', monospace;
              font-size: 12px;
              margin: 8px 0;
              white-space: pre-wrap;
              word-wrap: break-word;
          }

          .affected-pages {
              font-size: 12px;
              opacity: 0.9;
              margin-top: 8px;
          }

          .resource-links {
              margin-top: 10px;
              padding-top: 10px;
              border-top: 1px solid rgba(255, 255, 255, 0.2);
          }

          .resource-link {
              display: inline-block;
              color: rgba(255, 255, 255, 0.9);
              text-decoration: none;
              font-size: 13px;
              margin-right: 15px;
              margin-top: 5px;
              transition: color 0.2s;
          }

          .resource-link:hover {
              color: white;
              text-decoration: underline;
          }

          .resource-link::before {
              content: '📚 ';
          }

          /* CSV Export Button Styles */
          .export-btn {
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 500;
              transition: all 0.3s;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }

          .export-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
              background: linear-gradient(135deg, #059669 0%, #047857 100%);
          }

          .export-btn:active {
              transform: translateY(0);
          }

          /* Charts Section Styles */
          .charts-section {
              background: white;
              border-radius: 12px;
              padding: 30px;
              margin: 30px auto;
              max-width: 100%;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .charts-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
              gap: 30px;
              margin-top: 25px;
          }

          .chart-card {
              background: #f9fafb;
              border-radius: 8px;
              padding: 20px;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
          }

          .chart-card-full-width {
              grid-column: 1 / -1;
          }

          .chart-title {
              font-size: 18px;
              font-weight: 600;
              color: #1f2937;
              margin-bottom: 15px;
              text-align: center;
          }

          .chart-container {
              position: relative;
              height: 300px;
              margin: 0 auto;
          }

          #frequencyChart {
              cursor: pointer;
          }

          .no-wins-message {
              text-align: center;
              padding: 40px;
              font-size: 16px;
              opacity: 0.9;
          }

          .progress-bar-container {
              background: rgba(0, 0, 0, 0.2);
              border-radius: 10px;
              height: 20px;
              overflow: hidden;
              margin: 8px 0;
          }

          .progress-bar {
              height: 100%;
              border-radius: 10px;
              transition: width 0.3s ease;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: 600;
          }

          .progress-good {
              background: linear-gradient(90deg, #10b981, #059669);
          }

          .progress-warning {
              background: linear-gradient(90deg, #f59e0b, #d97706);
          }

          .progress-bad {
              background: linear-gradient(90deg, #ef4444, #dc2626);
          }

          .info-section {
              background: white;
              padding: 20px 30px;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              margin-bottom: 20px;
          }

          .info-section h2 {
              font-size: 18px;
              font-weight: 600;
              color: #111827;
              margin-bottom: 16px;
              border-bottom: 2px solid #e5e7eb;
              padding-bottom: 8px;
          }

          .info-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
              gap: 20px;
          }

          .info-card {
              background: #f9fafb;
              padding: 16px;
              border-radius: 6px;
              border-left: 4px solid #3b82f6;
          }

          .info-card.error {
              border-left-color: #ef4444;
              background: #fef2f2;
          }

          .info-card.warning {
              border-left-color: #f59e0b;
              background: #fffbeb;
          }

          .info-card.success {
              border-left-color: #10b981;
              background: #f0fdf4;
          }

          .info-card h3 {
              font-size: 14px;
              font-weight: 600;
              color: #374151;
              margin-bottom: 8px;
          }

          .info-card p {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .info-card ul {
              margin: 8px 0;
              padding-left: 20px;
          }

          .info-card li {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .info-card .label {
              font-weight: 600;
              color: #374151;
          }

          .issue-badge {
              display: inline-block;
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
              margin-right: 4px;
          }

          .issue-badge.critical {
              background: #fecaca;
              color: #991b1b;
          }

          .issue-badge.high {
              background: #fed7aa;
              color: #9a3412;
          }

          .issue-badge.medium {
              background: #fef3c7;
              color: #92400e;
          }

          .issue-badge.low {
              background: #dbeafe;
              color: #1e40af;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <header>
              <h1>SEO Audit Report</h1>
              <p class="subtitle">${escapeHtml(domainName)}</p>
              <p class="subtitle">Generated on ${new Date().toLocaleString()}</p>
              ${timing.elapsedTimeFormatted ? `<p class="subtitle">Duration: ${escapeHtml(timing.elapsedTimeFormatted)}</p>` : ''}
              <div class="stats">
                  <div class="stat">
                      <span class="stat-label">URLs in Sitemap:</span>
                      <span class="stat-value">${jsonData.sitemaps?.total || 0}</span>
                  </div>
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
                  ${(jsonData.sitemaps?.total || 0) > pages.length ? `
                  <div class="stat">
                      <span class="stat-label">Not Crawled:</span>
                      <span class="stat-value" style="color: #f59e0b;">${(jsonData.sitemaps?.total || 0) - pages.length}</span>
                  </div>
                  ` : ''}
                  ${pagesWithMetrics.length > 0 ? `
                  <div class="stat">
                      <span class="stat-label">With Performance Data:</span>
                      <span class="stat-value">${pagesWithMetrics.length}</span>
                  </div>
                  ` : ''}
                  <div class="stat">
                      <span class="stat-label">From Sitemap:</span>
                      <span class="stat-value" style="color: #2563eb;">${pagesFromSitemap}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Discovered:</span>
                      <span class="stat-value" style="color: #f59e0b;">${pagesDiscovered}</span>
                  </div>
                  <div class="stat">
                      <span class="stat-label">Multilanguage:</span>
                      <span class="stat-value" style="color: ${jsonData.isMultiLang ? '#10b981' : '#9ca3af'};">${jsonData.isMultiLang ? 'Yes' : 'No'}</span>
                  </div>
              </div>

              <div style="margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.1); border-radius: 8px; backdrop-filter: blur(10px);">
                  <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                      <div style="font-size: 14px; opacity: 0.9;">
                          📊 <strong>Export Data:</strong> Download audit data for analysis in Excel, Google Sheets, or other tools
                      </div>
                      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                          <button onclick="exportCSV('pages')" class="export-btn">📄 Pages CSV</button>
                          <button onclick="exportCSV('issues')" class="export-btn">⚠️ Issues CSV</button>
                          <button onclick="exportCSV('performance')" class="export-btn">⚡ Performance CSV</button>
                          <button onclick="exportCSV('quickwins')" class="export-btn">🎯 Quick Wins CSV</button>
                          <button onclick="exportCSV('summary')" class="export-btn">📊 Summary CSV</button>
                      </div>
                  </div>
              </div>
          </header>

          ${(() => {
              // Historical Progress Section
              if (!previousAudit || !trendData) return '';

              const currentScore = jsonData.analysis?.summary?.overallScore || 0;
              const scoreDelta = currentScore - previousAudit.summary.overallScore;
              const issuesDelta = (jsonData.analysis?.summary?.totalIssues || 0) - previousAudit.summary.totalIssues;

              return `
                  <div class="charts-section">
                      <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Historical Progress</h2>
                      <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Track your SEO improvements over ${trendData.labels.length} audit${trendData.labels.length > 1 ? 's' : ''}</p>

                      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
                          <div style="background: ${scoreDelta >= 0 ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'}; color: white; padding: 20px; border-radius: 8px; text-align: center;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">Score Change</div>
                              <div style="font-size: 32px; font-weight: 700;">${scoreDelta > 0 ? '+' : ''}${scoreDelta}</div>
                              <div style="font-size: 12px; opacity: 0.9;">Since last audit</div>
                          </div>

                          <div style="background: ${issuesDelta <= 0 ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'}; color: white; padding: 20px; border-radius: 8px; text-align: center;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">Issues Change</div>
                              <div style="font-size: 32px; font-weight: 700;">${issuesDelta > 0 ? '+' : ''}${issuesDelta}</div>
                              <div style="font-size: 12px; opacity: 0.9;">Since last audit</div>
                          </div>

                          <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 20px; border-radius: 8px; text-align: center;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">Total Audits</div>
                              <div style="font-size: 32px; font-weight: 700;">${trendData.labels.length}</div>
                              <div style="font-size: 12px; opacity: 0.9;">Tracked over time</div>
                          </div>

                          <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 20px; border-radius: 8px; text-align: center;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">Current Score</div>
                              <div style="font-size: 32px; font-weight: 700;">${currentScore}</div>
                              <div style="font-size: 12px; opacity: 0.9;">Out of 100</div>
                          </div>
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
                  </div>
              `;
          })()}

          ${(() => {
              // Executive Summary
              const summary = jsonData.analysis?.summary || {};
              const overallScore = summary.overallScore || 0;
              const categoryScores = summary.categoryScores || {};

              // Determine score color
              let scoreClass = 'bad';
              if (overallScore >= 80) scoreClass = 'good';
              else if (overallScore >= 60) scoreClass = 'warning';

              return `
                  <div class="executive-summary">
                      <h2>📊 Executive Summary</h2>

                      <div class="summary-score">
                          <div class="score-circle">
                              <div class="score-number ${scoreClass}">${overallScore}</div>
                              <div class="score-label">SEO Score</div>
                          </div>
                      </div>

                      <div class="summary-grid">
                          <div class="summary-card">
                              <div class="summary-card-value">${summary.totalIssues || 0}</div>
                              <div class="summary-card-label">Total Issues</div>
                          </div>
                          <div class="summary-card">
                              <div class="summary-card-value" style="color: #fca5a5;">${summary.criticalCount || 0}</div>
                              <div class="summary-card-label">Critical</div>
                          </div>
                          <div class="summary-card">
                              <div class="summary-card-value" style="color: #fdba74;">${summary.highCount || 0}</div>
                              <div class="summary-card-label">High</div>
                          </div>
                          <div class="summary-card">
                              <div class="summary-card-value" style="color: #fde047;">${summary.mediumCount || 0}</div>
                              <div class="summary-card-label">Medium</div>
                          </div>
                          <div class="summary-card">
                              <div class="summary-card-value" style="color: #a5f3fc;">${summary.lowCount || 0}</div>
                              <div class="summary-card-label">Low</div>
                          </div>
                          <div class="summary-card">
                              <div class="summary-card-value">${summary.passRate || 0}%</div>
                              <div class="summary-card-label">Pass Rate</div>
                          </div>
                      </div>

                      ${Object.keys(categoryScores).length > 0 ? `
                      <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.2);">
                          <div style="text-align: center; margin-bottom: 16px; font-size: 14px; opacity: 0.9;">Category Health</div>
                          ${(() => {
                              const categories = [
                                  { name: 'SEO', score: categoryScores.seo || 0 },
                                  { name: 'Performance', score: categoryScores.performance || 0 },
                                  { name: 'Accessibility', score: categoryScores.accessibility || 0 },
                                  { name: 'Security', score: categoryScores.security || 0 },
                                  { name: 'Technical', score: categoryScores.technical || 0 }
                              ];

                              return categories.map(cat => {
                                  let progressClass = 'progress-bad';
                                  if (cat.score >= 80) progressClass = 'progress-good';
                                  else if (cat.score >= 60) progressClass = 'progress-warning';

                                  return `
                                  <div style="margin: 12px 0;">
                                      <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 13px;">
                                          <span>${cat.name}</span>
                                          <span style="font-weight: 700;">${cat.score}/100</span>
                                      </div>
                                      <div class="progress-bar-container">
                                          <div class="progress-bar ${progressClass}" style="width: ${cat.score}%;"></div>
                                      </div>
                                  </div>
                                  `;
                              }).join('');
                          })()}
                      </div>
                      ` : ''}
                  </div>
              `;
          })()}

          ${(() => {
              // Quick Wins Section
              const quickWins = jsonData.analysis?.summary?.quickWins || [];

              if (quickWins.length === 0) return '';

              return `
                  <div class="quick-wins-section">
                      <div class="wins-issues-title">
                          <span>🎯</span>
                          <span>Quick Wins</span>
                          <span style="font-size: 14px; opacity: 0.9;">(${quickWins.length} opportunities)</span>
                      </div>

                      <p style="text-align: center; margin-bottom: 25px; font-size: 14px; opacity: 0.95;">
                          High-impact fixes that take less than 30 minutes each
                      </p>

                      ${quickWins.map((win, index) => `
                          <div class="win-card">
                              <div class="win-header">
                                  <div class="win-title">${index + 1}. ${escapeHtml(win.issue)}</div>
                                  <div class="win-badges">
                                      <span class="win-badge">${win.impact} Impact</span>
                                      <span class="win-badge">⏱️ ${win.effort}</span>
                                      <span class="win-badge">${win.affectedPages} page${win.affectedPages > 1 ? 's' : ''}</span>
                                  </div>
                              </div>

                              <div class="fix-content">
                                  <strong style="display: block; margin-bottom: 8px;">✅ How to Fix:</strong>
                                  ${escapeHtml(win.fix)}
                              </div>

                              ${win.example ? `
                              <div class="code-example">${escapeHtml(win.example)}</div>
                              ` : ''}

                              ${win.examples && win.examples.length > 0 ? `
                              <div class="affected-pages">
                                  <strong>Affected pages:</strong>
                                  <div style="margin-top: 5px;">
                                      ${win.examples.slice(0, 3).map(ex => `<div style="margin: 2px 0; opacity: 0.85;">${ex}</div>`).join('')}
                                      ${win.affectedPages > 3 ? `<div style="opacity: 0.7;">... and ${win.affectedPages - 3} more</div>` : ''}
                                  </div>
                              </div>
                              ` : ''}

                              ${win.resources && win.resources.length > 0 ? `
                              <div class="resource-links">
                                  ${win.resources.map(res =>
                                      `<a href="${res.url}" target="_blank" rel="noopener noreferrer" class="resource-link">${escapeHtml(res.text)}</a>`
                                  ).join('')}
                              </div>
                              ` : ''}
                          </div>
                      `).join('')}
                  </div>
              `;
          })()}

          ${(() => {
              // Top 10 Issues Section
              const bySeverity = jsonData.analysis?.bySeverity || {};
              const allIssues = [
                  ...(bySeverity.critical || []).map(issue => ({ issue, severity: 'critical', severityLabel: 'Critical' })),
                  ...(bySeverity.high || []).map(issue => ({ issue, severity: 'high', severityLabel: 'High' })),
                  ...(bySeverity.medium || []).map(issue => ({ issue, severity: 'medium', severityLabel: 'Medium' })),
                  ...(bySeverity.low || []).map(issue => ({ issue, severity: 'low', severityLabel: 'Low' }))
              ];

              const topIssues = allIssues.slice(0, 10);

              if (topIssues.length === 0) return '';

              return `
                  <div class="top-issues-section">
                      <div class="wins-issues-title">
                          <span>⚠️</span>
                          <span>Top ${topIssues.length} Issues to Address</span>
                      </div>

                      <p style="text-align: center; margin-bottom: 25px; font-size: 14px; opacity: 0.95;">
                          Prioritized by severity - fix these first
                      </p>

                      ${topIssues.map((item, index) => {
                          const details = jsonData.analysis?.details?.[item.issue] || {};
                          const affectedCount = details.examples?.length || 0;

                          return `
                          <div class="issue-card">
                              <div class="issue-header">
                                  <div class="issue-title">${index + 1}. ${escapeHtml(item.issue)}</div>
                                  <div class="issue-badges">
                                      <span class="issue-badge-item">${item.severityLabel}</span>
                                      ${affectedCount > 0 ? `<span class="issue-badge-item">${affectedCount} affected</span>` : ''}
                                  </div>
                              </div>

                              ${details.examples && details.examples.length > 0 ? `
                              <div class="affected-pages">
                                  <strong>Examples:</strong>
                                  <div style="margin-top: 5px;">
                                      ${details.examples.slice(0, 2).map(ex => `<div style="margin: 2px 0; opacity: 0.85;">${ex}</div>`).join('')}
                                      ${affectedCount > 2 ? `<div style="opacity: 0.7;">... and ${affectedCount - 2} more</div>` : ''}
                                  </div>
                              </div>
                              ` : ''}
                          </div>
                      `}).join('')}
                  </div>
              `;
          })()}

          <!-- Statistical Summary -->
          ${(() => {
              const pages = jsonData.pageData?.pages || {};
              const pagesArray = Object.values(pages);
              const pagesWithPerf = pagesArray.filter(p => p.vitals);

              if (pagesWithPerf.length === 0) return '';

              // Calculate statistics
              const ttfbValues = pagesWithPerf.map(p => p.vitals.ttfb || 0).filter(v => v > 0).sort((a, b) => a - b);
              const lcpValues = pagesWithPerf.map(p => p.vitals.lcp || 0).filter(v => v > 0).sort((a, b) => a - b);
              const clsValues = pagesWithPerf.map(p => p.vitals.cls || 0).filter(v => v > 0).sort((a, b) => a - b);
              const pageSizes = pagesArray.map(p => p.totalSize || 0).filter(v => v > 0).sort((a, b) => a - b);

              const avg = arr => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : 0;
              const median = arr => arr.length > 0 ? arr[Math.floor(arr.length / 2)] : 0;
              const p75 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.75)] : 0;
              const p95 = arr => arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : 0;

              return `
                  <div class="charts-section">
                      <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📈 Performance Statistics</h2>
                      <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Statistical analysis based on ${pagesWithPerf.length} pages with performance data</p>

                      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px;">
                          ${ttfbValues.length > 0 ? `
                          <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 20px; border-radius: 8px;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">⚡ TTFB (Time to First Byte)</div>
                              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
                                  <div><strong>Average:</strong> ${avg(ttfbValues)}ms</div>
                                  <div><strong>Median:</strong> ${median(ttfbValues)}ms</div>
                                  <div><strong>75th %ile:</strong> ${p75(ttfbValues)}ms</div>
                                  <div><strong>95th %ile:</strong> ${p95(ttfbValues)}ms</div>
                              </div>
                          </div>
                          ` : ''}

                          ${lcpValues.length > 0 ? `
                          <div style="background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; padding: 20px; border-radius: 8px;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">🎨 LCP (Largest Contentful Paint)</div>
                              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
                                  <div><strong>Average:</strong> ${avg(lcpValues)}ms</div>
                                  <div><strong>Median:</strong> ${median(lcpValues)}ms</div>
                                  <div><strong>75th %ile:</strong> ${p75(lcpValues)}ms</div>
                                  <div><strong>95th %ile:</strong> ${p95(lcpValues)}ms</div>
                              </div>
                          </div>
                          ` : ''}

                          ${clsValues.length > 0 ? `
                          <div style="background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%); color: white; padding: 20px; border-radius: 8px;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">📐 CLS (Cumulative Layout Shift)</div>
                              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
                                  <div><strong>Average:</strong> ${(parseFloat(avg(clsValues)) / 1000).toFixed(3)}</div>
                                  <div><strong>Median:</strong> ${median(clsValues).toFixed(0)}</div>
                                  <div><strong>75th %ile:</strong> ${p75(clsValues).toFixed(0)}</div>
                                  <div><strong>95th %ile:</strong> ${p95(clsValues).toFixed(0)}</div>
                              </div>
                          </div>
                          ` : ''}

                          ${pageSizes.length > 0 ? `
                          <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 20px; border-radius: 8px;">
                              <div style="font-size: 14px; opacity: 0.9; margin-bottom: 10px;">📦 Page Size</div>
                              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px;">
                                  <div><strong>Average:</strong> ${(parseFloat(avg(pageSizes)) / (1024 * 1024)).toFixed(2)}MB</div>
                                  <div><strong>Median:</strong> ${(median(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
                                  <div><strong>75th %ile:</strong> ${(p75(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
                                  <div><strong>95th %ile:</strong> ${(p95(pageSizes) / (1024 * 1024)).toFixed(2)}MB</div>
                              </div>
                          </div>
                          ` : ''}
                      </div>
                  </div>
              `;
          })()}

          <!-- Data Visualization Charts -->
          <div class="charts-section">
              <h2 style="text-align: center; color: #1f2937; margin-bottom: 10px;">📊 Data Insights</h2>
              <p style="text-align: center; color: #6b7280; margin-bottom: 25px;">Visual analysis of your SEO audit results</p>

              <div class="charts-grid">
                  <div class="chart-card">
                      <div class="chart-title">Issue Distribution by Severity</div>
                      <div class="chart-container">
                          <canvas id="issueChart"></canvas>
                      </div>
                  </div>

                  <div class="chart-card chart-card-full-width">
                      <div class="chart-title">Top 10 Issues by Frequency</div>
                      <div class="chart-container">
                          <canvas id="frequencyChart"></canvas>
                      </div>
                  </div>

                  <div class="chart-card">
                      <div class="chart-title">Performance Metrics Distribution</div>
                      <div class="chart-container">
                          <canvas id="performanceChart"></canvas>
                      </div>
                  </div>

                  <div class="chart-card">
                      <div class="chart-title">Pages by Status Code</div>
                      <div class="chart-container">
                          <canvas id="statusChart"></canvas>
                      </div>
                  </div>
              </div>
          </div>

          <div class="info-section">
              <h2>Configuration & Sitemaps</h2>
              <div class="info-grid">
                  ${(() => {
                      // Robots.txt info
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

                      return `
                          <div class="info-card ${robotsStatus}">
                              <h3>🤖 Robots.txt</h3>
                              <p><span class="label">Status:</span> ${robotsStatusText}</p>
                              <p><span class="label">Sitemaps Listed:</span> ${robotsSitemaps.length}</p>
                              ${robotsSitemaps.length > 0 ? `
                                  <ul>
                                      ${robotsSitemaps.slice(0, 3).map(sm => `<li>${escapeHtml(sm)}</li>`).join('')}
                                      ${robotsSitemaps.length > 3 ? `<li>... and ${robotsSitemaps.length - 3} more</li>` : ''}
                                  </ul>
                              ` : '<p style="color: #f59e0b;">⚠ No sitemaps listed in robots.txt</p>'}
                              <p><span class="label">User-Agent Rules:</span> ${Object.keys(userAgents).length}</p>
                          </div>
                      `;
                  })()}

                  ${(() => {
                      // Sitemap info
                      const sitemaps = jsonData.sitemaps || {};
                      const sitemapUrls = sitemaps.urls || {};
                      const totalUrls = sitemaps.total || 0;

                      // Get list of individual sitemaps (not the aggregated data)
                      const individualSitemaps = Object.keys(sitemaps).filter(key =>
                          key !== 'urls' && key !== 'total' && typeof sitemaps[key] === 'object'
                      );

                      const hasSitemapErrors = jsonData.analysis?.overall?.some(err =>
                          err && typeof err === 'string' && err.toLowerCase().includes('sitemap')
                      ) || false;

                      let sitemapStatus = totalUrls > 0 ? 'success' : 'error';

                      return `
                          <div class="info-card ${sitemapStatus}">
                              <h3>🗺️ Sitemaps</h3>
                              <p><span class="label">Total Sitemaps:</span> ${individualSitemaps.length}</p>
                              <p><span class="label">Total URLs:</span> ${totalUrls.toLocaleString()}</p>
                              ${individualSitemaps.length > 0 ? `
                                  <ul>
                                      ${individualSitemaps.slice(0, 3).map(sm => {
                                          const smData = sitemaps[sm];
                                          return `<li>${escapeHtml(sm)} <span style="color: #9ca3af;">(${smData.total || 0} URLs)</span></li>`;
                                      }).join('')}
                                      ${individualSitemaps.length > 3 ? `<li>... and ${individualSitemaps.length - 3} more</li>` : ''}
                                  </ul>
                              ` : '<p style="color: #ef4444;">✗ No sitemaps found</p>'}
                              ${hasSitemapErrors ? '<p style="color: #f59e0b; margin-top: 8px;">⚠ Issues detected (see analysis below)</p>' : ''}
                          </div>
                      `;
                  })()}

                  ${(() => {
                      // Issues summary
                      const analysis = jsonData.analysis || {};
                      const summary = analysis.summary || {};
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

                      return `
                          <div class="info-card ${issuesStatus}">
                              <h3>⚠️ Related Issues</h3>
                              ${totalRobotsSitemapIssues === 0 ? `
                                  <p style="color: #10b981;">✓ No robots.txt or sitemap issues detected</p>
                              ` : `
                                  <p><span class="label">Total Issues:</span> ${totalRobotsSitemapIssues}</p>
                                  ${robotsSitemapIssues.critical.length > 0 ? `
                                      <p><span class="issue-badge critical">CRITICAL</span> ${robotsSitemapIssues.critical.length}</p>
                                  ` : ''}
                                  ${robotsSitemapIssues.high.length > 0 ? `
                                      <p><span class="issue-badge high">HIGH</span> ${robotsSitemapIssues.high.length}</p>
                                  ` : ''}
                                  ${robotsSitemapIssues.medium.length > 0 ? `
                                      <p><span class="issue-badge medium">MEDIUM</span> ${robotsSitemapIssues.medium.length}</p>
                                  ` : ''}
                                  ${robotsSitemapIssues.low.length > 0 ? `
                                      <p><span class="issue-badge low">LOW</span> ${robotsSitemapIssues.low.length}</p>
                                  ` : ''}
                                  <ul style="margin-top: 8px;">
                                      ${[
                                          ...robotsSitemapIssues.critical.slice(0, 2),
                                          ...robotsSitemapIssues.high.slice(0, 2),
                                          ...robotsSitemapIssues.medium.slice(0, 2)
                                      ].map(issue => {
                                          const cleanIssue = issue.replace(/\s*\[(critical|high|medium|low)\]\s*$/i, '');
                                          return `<li>${escapeHtml(cleanIssue)}</li>`;
                                      }).join('')}
                                      ${totalRobotsSitemapIssues > 6 ? `<li>... and ${totalRobotsSitemapIssues - 6} more issues</li>` : ''}
                                  </ul>
                              `}
                          </div>
                      `;
                  })()}

                  ${(() => {
                      // Crawl coverage info
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
                              ${missingUrls.length > 0 ? `
                                  <details style="margin-top: 8px;">
                                      <summary style="cursor: pointer; color: #3b82f6; font-size: 12px; font-weight: 600;">
                                          Show ${missingUrls.length} missing URL(s)
                                      </summary>
                                      <ul style="margin-top: 8px; font-size: 11px; max-height: 200px; overflow-y: auto;">
                                          ${showUrls.map(url => `<li style="word-break: break-all; margin: 4px 0;">${makeUrlClickable(url)}</li>`).join('')}
                                          ${missingUrls.length > 10 ? `<li style="color: #9ca3af;">... and ${missingUrls.length - 10} more</li>` : ''}
                                      </ul>
                                  </details>
                              ` : ''}
                          </div>
                      `;
                  })()}
              </div>
          </div>

          <div class="table-container">
              <table>
                  <thead>
                      <tr>
                          <th style="width: 50px; text-align: center;">#</th>
                          <th class="url-col sortable" data-type="text" data-column="1">URL</th>
                          <th class="sortable" data-type="text" data-column="1">
                              Source
                              <span class="threshold">Sitemap/Link</span>
                          </th>
                          <th class="sortable" data-type="number" data-column="2">
                              Incoming Links
                              <span class="threshold">From other pages</span>
                          </th>
                          <th class="sortable" data-type="number">
                              URL Length
                              <span class="threshold">≤ ${THRESHOLDS.URL_LENGTH_RECOMMENDED} chars</span>
                          </th>
                          <th class="sortable" data-type="number">
                              URL Depth
                              <span class="threshold">≤ ${THRESHOLDS.URL_DEPTH_MAX} levels</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Redirects
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              HTTP Links
                              <span class="threshold">0 on HTTPS</span>
                          </th>
                          <th class="sortable" data-type="number" data-column="3">Status</th>
                          <th class="sortable" data-type="number" data-column="3">
                              Title
                              <span class="threshold">${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX} chars</span>
                          </th>
                          <th class="sortable" data-type="number" data-column="4">
                              Description
                              <span class="threshold">${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX} chars</span>
                          </th>
                          ${pagesWithMetrics.length > 0 ? `
                          <th class="sortable" data-type="number">
                              TTFB
                              <span class="threshold">≤ ${THRESHOLDS.TTFB}ms</span>
                          </th>
                          <th class="sortable" data-type="number">
                              FCP
                              <span class="threshold">≤ ${THRESHOLDS.FCP}ms</span>
                          </th>
                          <th class="sortable" data-type="number">
                              LCP
                              <span class="threshold">≤ ${THRESHOLDS.LCP}ms</span>
                          </th>
                          <th class="sortable" data-type="number">
                              CLS
                              <span class="threshold">≤ ${THRESHOLDS.CLS}</span>
                          </th>
                          ` : ''}
                          <th class="sortable" data-type="number">
                              Page Size
                              <span class="threshold">≤ ${formatBytes(THRESHOLDS.PAGE_SIZE)}</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Requests
                              <span class="threshold">≤ ${THRESHOLDS.REQUEST_COUNT}</span>
                          </th>
                          <th class="sortable" data-type="text">Canonical</th>
                          <th class="sortable" data-type="number">
                              H1 Tags
                              <span class="threshold">= 1</span>
                          </th>
                          <th class="sortable" data-type="number">
                              H2 Tags
                              <span class="threshold">≤ ${THRESHOLDS.H2_COUNT}</span>
                          </th>
                          <th class="sortable" data-type="text">
                              H Structure
                              <span class="threshold">No gaps</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Missing Meta
                              <span class="threshold">All present</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Alternates
                              <span class="threshold">Count</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Links w/o Text
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Security Score
                              <span class="threshold">≥ 70</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Missing Headers
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Insecure Cookies
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Mixed Content
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Forms w/o CSRF
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Inline Scripts
                              <span class="threshold">≤ 5</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Cache Score
                              <span class="threshold">≥ 70</span>
                          </th>
                          <th class="sortable" data-type="text">
                              CDN
                              <span class="threshold">Yes</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Cached Static
                              <span class="threshold">All</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Uncached Static
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="text">
                              Service Worker
                              <span class="threshold">Yes</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Images
                              <span class="threshold">Total count</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Lazy Loading
                              <span class="threshold">Images with lazy</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Image Size
                              <span class="threshold">Total KB</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Modern Formats
                              <span class="threshold">WebP/AVIF count</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Render Blocking
                              <span class="threshold">≤ 5</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Uncompressed
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Unminified
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              A11y Score
                              <span class="threshold">≥ 70</span>
                          </th>
                          <th class="sortable" data-type="text">
                              ARIA
                              <span class="threshold">Valid roles</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Form Labels
                              <span class="threshold">All inputs</span>
                          </th>
                          <th class="sortable" data-type="text">
                              Landmarks
                              <span class="threshold">Main/Nav/Header</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Focus Issues
                              <span class="threshold">0</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Content Score
                              <span class="threshold">≥ 70</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Word Count
                              <span class="threshold">≥ 300</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Text/HTML Ratio
                              <span class="threshold">≥ 25%</span>
                          </th>
                          <th class="sortable" data-type="number">
                              Readability
                              <span class="threshold">50-70</span>
                          </th>
                          <th class="sortable" data-type="text">
                              Top Keywords
                              <span class="threshold">Most frequent</span>
                          </th>
                      </tr>
                  </thead>
                  <tbody>
                      ${pages.map((page, index) => {
                        const titleLength = page.title?.length || 0;
                        const descLength = page.description?.length || 0;
                        const titleColor = getTextLengthColor(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX);
                        const descColor = getTextLengthColor(descLength, THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX);
                        const titleTooltip = getTextLengthTooltip(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX, 'Title');
                        const descTooltip = getTextLengthTooltip(descLength, THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX, 'Description');
                        // Handle both old array format and new object format
                        const h1Count = Array.isArray(page.headings)
                          ? (page.headings.filter(h => h.tag === 'h1')[0]?.count || 0)
                          : (page.headings?.h1?.length || 0);
                        const h2Count = Array.isArray(page.headings)
                          ? (page.headings.filter(h => h.tag === 'h2')[0]?.count || 0)
                          : (page.headings?.h2?.length || 0);

                        // Convert object format to array format for structure check
                        const headingsArray = Array.isArray(page.headings)
                          ? page.headings
                          : page.headings ? [
                              { tag: 'h1', count: page.headings.h1?.length || 0 },
                              { tag: 'h2', count: page.headings.h2?.length || 0 },
                              { tag: 'h3', count: page.headings.h3?.length || 0 },
                              { tag: 'h4', count: page.headings.h4?.length || 0 },
                              { tag: 'h5', count: page.headings.h5?.length || 0 },
                              { tag: 'h6', count: page.headings.h6?.length || 0 },
                            ] : null;
                        const hasHStructureIssue = hasHeadingStructureIssue(headingsArray);
                        const missingMeta = getMissingMetaTags(page);
                        const alternatesCount = page.alternates?.length || 0;
                        const linksWithoutText = page.links?.filter(link => !link.text || link.text.trim() === '').length || 0;
                        const securityScore = page.security?.securityScore ?? null;
                        const missingSecHeaders = page.security?.missingHeaders?.length || 0;
                        const mixedContent = page.security?.mixedContent || 0;
                        const insecureCookies = page.security?.insecureCookies || 0;
                        const formsWithoutCSRF = page.security?.formsWithoutCSRF || 0;
                        const inlineScripts = page.security?.inlineScripts || 0;

                        // Build detailed security tooltip
                        let securityTooltip = '';
                        if (securityScore !== null) {
                            const scoreBreakdown = [];
                            scoreBreakdown.push('Security Score Breakdown:');
                            scoreBreakdown.push('');

                            if (missingSecHeaders === 0) {
                                scoreBreakdown.push('✓ All security headers present');
                            } else {
                                scoreBreakdown.push('✗ Missing ' + missingSecHeaders + ' security header(s): ' + (page.security?.missingHeaders?.join(', ') || ''));
                            }

                            if (insecureCookies === 0) {
                                scoreBreakdown.push('✓ Cookies are secure');
                            } else {
                                scoreBreakdown.push('✗ ' + insecureCookies + ' insecure cookie(s)');
                            }

                            if (mixedContent === 0) {
                                scoreBreakdown.push('✓ No mixed content');
                            } else {
                                scoreBreakdown.push('✗ ' + mixedContent + ' HTTP resource(s) on HTTPS page');
                            }

                            if (formsWithoutCSRF === 0) {
                                scoreBreakdown.push('✓ Forms have CSRF protection');
                            } else {
                                scoreBreakdown.push('✗ ' + formsWithoutCSRF + ' form(s) without CSRF tokens');
                            }

                            if (inlineScripts <= 5) {
                                scoreBreakdown.push('✓ Minimal inline scripts (' + inlineScripts + ')');
                            } else {
                                scoreBreakdown.push('⚠ ' + inlineScripts + ' inline scripts (XSS risk)');
                            }

                            scoreBreakdown.push('');
                            if (securityScore >= 70) {
                                scoreBreakdown.push('Overall: Strong security posture');
                            } else if (securityScore >= 50) {
                                scoreBreakdown.push('Overall: Some security improvements needed');
                            } else {
                                scoreBreakdown.push('Overall: Multiple security issues - immediate action required');
                            }

                            securityTooltip = scoreBreakdown.join('\\n');
                        } else {
                            securityTooltip = 'Security analysis not available';
                        }
                        const cacheScore = page.caching?.cacheScore ?? null;
                        const hasCDN = page.caching?.hasCDN || false;
                        const cdnProvider = page.caching?.cdnProvider || null;
                        const uncachedStatic = page.caching?.staticUncached || 0;
                        const cachedStatic = page.caching?.staticCached || 0;
                        const hasServiceWorker = page.caching?.hasServiceWorker || false;

                        // Build detailed caching tooltip
                        let cachingTooltip = '';
                        if (cacheScore !== null) {
                            const cacheBreakdown = [];
                            cacheBreakdown.push('Cache Score Breakdown:');
                            cacheBreakdown.push('');

                            // CDN Status (30 points)
                            if (hasCDN) {
                                cacheBreakdown.push('✓ CDN detected' + (cdnProvider ? ': ' + cdnProvider : '') + ' (+30 points)');
                            } else {
                                cacheBreakdown.push('✗ No CDN detected (0 points)');
                            }

                            // Static Resource Caching (40 points)
                            const totalStatic = cachedStatic + uncachedStatic;
                            if (totalStatic > 0) {
                                const cachingRatio = cachedStatic / totalStatic;
                                const points = Math.round(cachingRatio * 40);
                                if (uncachedStatic === 0) {
                                    cacheBreakdown.push('✓ All static resources cached: ' + cachedStatic + '/' + totalStatic + ' (+' + points + ' points)');
                                } else {
                                    cacheBreakdown.push('⚠ Static resources: ' + cachedStatic + ' cached, ' + uncachedStatic + ' uncached (+' + points + '/40 points)');
                                }
                            } else {
                                cacheBreakdown.push('⚠ No static resources detected (0 points)');
                            }

                            // Service Worker (20 points)
                            if (hasServiceWorker) {
                                cacheBreakdown.push('✓ Service Worker active (+20 points)');
                            } else {
                                cacheBreakdown.push('✗ No Service Worker (0 points)');
                            }

                            // Dynamic Content (10 points max)
                            const dynamicCached = page.caching?.dynamicCached || 0;
                            const dynamicUncached = page.caching?.dynamicUncached || 0;
                            const totalDynamic = dynamicCached + dynamicUncached;
                            if (totalDynamic > 0) {
                                const dynamicRatio = dynamicCached / totalDynamic;
                                const points = Math.round(dynamicRatio * 10);
                                if (points > 0) {
                                    cacheBreakdown.push('✓ Dynamic content: ' + dynamicCached + '/' + totalDynamic + ' cached (+' + points + ' points)');
                                }
                            }

                            cacheBreakdown.push('');
                            cacheBreakdown.push('Total Score: ' + cacheScore + '/100');
                            cacheBreakdown.push('');

                            if (cacheScore >= 70) {
                                cacheBreakdown.push('Overall: Strong caching strategy');
                            } else if (cacheScore >= 50) {
                                cacheBreakdown.push('Overall: Caching could be improved');
                                if (!hasCDN) cacheBreakdown.push('→ Consider using a CDN');
                                if (uncachedStatic > 0) cacheBreakdown.push('→ Add cache headers to ' + uncachedStatic + ' static resources');
                                if (!hasServiceWorker) cacheBreakdown.push('→ Implement Service Worker for offline support');
                            } else {
                                cacheBreakdown.push('Overall: Poor caching configuration - immediate action needed');
                                if (!hasCDN) cacheBreakdown.push('→ Implement CDN (e.g., CloudFlare, Fastly)');
                                if (uncachedStatic > 5) cacheBreakdown.push('→ Critical: ' + uncachedStatic + ' static resources without caching');
                                if (!hasServiceWorker) cacheBreakdown.push('→ Add Service Worker for better performance');
                            }

                            cachingTooltip = cacheBreakdown.join('\\n');
                        } else {
                            cachingTooltip = 'Caching analysis not available';
                        }

                        return `
                          <tr>
                              <td style="text-align: center; color: #9ca3af; font-weight: 500; font-size: 12px;">
                                  ${index + 1}
                              </td>
                              <td>
                                  <a href="${escapeHtml(page.url)}" class="url-link" target="_blank">${escapeHtml(page.url)}</a>
                              </td>
                              <td style="text-align: center;">
                                  <span class="source-badge source-${page.foundIn || 'sitemap'}" title="${page.foundIn === 'discovered' ? (page.discoveredOn ? 'Found on page: ' + escapeHtml(page.discoveredOn) : 'Found through internal links during crawl') : 'Listed in sitemap'}">${page.foundIn === 'discovered' ? 'Link' : 'Sitemap'}</span>
                              </td>
                              <td class="incoming-links-cell"
                                  style="color: ${page.incomingLinksCount > 0 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center; cursor: ${page.incomingLinksCount > 0 ? 'pointer' : 'default'}; position: relative;"
                                  data-url="${escapeHtml(page.url)}"
                                  data-count="${page.incomingLinksCount || 0}"
                                  title="${page.incomingLinksCount > 0 ? 'Click to see ' + page.incomingLinksCount + ' incoming link(s)' : 'No incoming links - page is orphaned (only accessible via sitemap)'}">
                                  ${page.incomingLinksCount || 0}${page.incomingLinksCount > 0 ? ' <span style="font-size: 10px; opacity: 0.7;">ℹ</span>' : ''}
                              </td>
                              <td style="color: ${getMetricColor(page.urlAnalysis?.length || 0, THRESHOLDS.URL_LENGTH_RECOMMENDED, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.length > THRESHOLDS.URL_LENGTH_MAX ? 'Error: URL too long (' + page.urlAnalysis.length + ' chars)' : (page.urlAnalysis?.length > THRESHOLDS.URL_LENGTH_RECOMMENDED ? 'Warning: URL longer than recommended (' + page.urlAnalysis.length + ' chars)' : 'Good: URL length is optimal')}">
                                  ${page.urlAnalysis?.length || 0}
                              </td>
                              <td style="color: ${getMetricColor(page.urlAnalysis?.depth || 0, THRESHOLDS.URL_DEPTH_MAX, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.depth > THRESHOLDS.URL_DEPTH_MAX ? 'Warning: URL is too deep (' + page.urlAnalysis.depth + ' levels)' : 'Good: URL depth is optimal'}">
                                  ${page.urlAnalysis?.depth || 0}
                              </td>
                              <td style="color: ${page.redirectCount > 2 ? '#ef4444' : (page.redirectCount > 0 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="${page.redirectCount > 0 ? 'Warning: ' + page.redirectCount + ' redirect(s) detected' + (page.redirectChain ? ': ' + page.redirectChain.map(r => r.url).join(' → ') : '') : 'Good: No redirects'}">
                                  ${page.redirectCount || 0}
                              </td>
                              <td style="color: ${page.httpLinksCount > 0 ? '#ef4444' : '#10b981'}; font-weight: 600; text-align: center;" title="${page.httpLinksCount > 0 ? 'Error: ' + page.httpLinksCount + ' HTTP link(s) on HTTPS site' : 'Good: No HTTP links'}">
                                  ${page.httpLinksCount || 0}
                              </td>
                              <td><span class="status-badge" style="background: ${getStatusColor(page.status)};">${page.status || 'N/A'}</span></td>
                              <td class="text-cell" title="${titleTooltip || escapeHtml(page.title || 'No title')}">
                                  <span style="color: ${titleColor}; font-weight: 600;">${titleLength}</span>
                                  <span style="color: #9ca3af;"> | </span>
                                  <span>${escapeHtml(page.title?.substring(0, 40) || 'No title')}${(page.title?.length || 0) > 40 ? '...' : ''}</span>
                              </td>
                              <td class="text-cell" title="${descTooltip || escapeHtml(page.description || 'No description')}">
                                  <span style="color: ${descColor}; font-weight: 600;">${descLength}</span>
                                  <span style="color: #9ca3af;"> | </span>
                                  <span>${escapeHtml(page.description?.substring(0, 40) || 'No description')}${(page.description?.length || 0) > 40 ? '...' : ''}</span>
                              </td>
                              ${pagesWithMetrics.length > 0 ? `
                              <td class="metric-cell" style="color: ${getMetricColor(page.TTFB, THRESHOLDS.TTFB, true)};" title="${getMetricTooltip(page.TTFB, THRESHOLDS.TTFB, 'TTFB', 'ms', true)}">
                                  ${page.TTFB || 'N/A'}${page.TTFB ? 'ms' : ''}
                              </td>
                              <td class="metric-cell" style="color: ${getMetricColor(page.FCP, THRESHOLDS.FCP, true)};" title="${getMetricTooltip(page.FCP, THRESHOLDS.FCP, 'FCP', 'ms', true)}">
                                  ${page.FCP || 'N/A'}${page.FCP ? 'ms' : ''}
                              </td>
                              <td class="metric-cell" style="color: ${getMetricColor(page.LCP, THRESHOLDS.LCP, true)};" title="${getMetricTooltip(page.LCP, THRESHOLDS.LCP, 'LCP', 'ms', true)}">
                                  ${page.LCP || 'N/A'}${page.LCP ? 'ms' : ''}
                              </td>
                              <td class="metric-cell" style="color: ${getMetricColor(page.CLS, THRESHOLDS.CLS, true)};" title="${getMetricTooltip(page.CLS, THRESHOLDS.CLS, 'CLS', '', true)}">
                                  ${page.CLS !== undefined ? page.CLS : 'N/A'}
                              </td>
                              ` : ''}
                              <td class="metric-cell" style="color: ${getMetricColor(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, true)};" title="${getMetricTooltip(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, 'Page Size', ' bytes', true)}">
                                  ${formatBytes(page.totalResponseSize || 0)}
                              </td>
                              <td class="metric-cell" style="color: ${getMetricColor(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, true)};" title="${getMetricTooltip(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, 'Requests', '', true)}">
                                  ${page.totalNumberOfRequests || 0}
                              </td>
                              <td style="text-align: center;">
                                  ${page.canonical ?
                                      (page.canonical === page.url ? '<span style="color: #10b981;" title="Canonical URL matches page URL">✓</span>' : '<span style="color: #f59e0b;" title="Canonical URL differs: ' + escapeHtml(page.canonical) + '">⚠</span>')
                                      : '<span style="color: #ef4444;" title="Canonical URL is missing">✗</span>'}
                              </td>
                              <td style="color: ${h1Count === 1 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h1Count === 1 ? 'Perfect: Page has exactly 1 H1 tag' : (h1Count === 0 ? 'Error: Page is missing H1 tag' : 'Error: Page has ' + h1Count + ' H1 tags (should be exactly 1)')}">
                                  ${h1Count}
                              </td>
                              <td style="color: ${h2Count <= THRESHOLDS.H2_COUNT ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h2Count <= THRESHOLDS.H2_COUNT ? 'Good: H2 count is within threshold' : 'Warning: Too many H2 tags (' + h2Count + ', recommended: ≤' + THRESHOLDS.H2_COUNT + ')'}">
                                  ${h2Count}
                              </td>
                              <td style="text-align: center;">
                                  ${hasHStructureIssue ?
                                      '<span style="color: #ef4444;" title="Error: Heading hierarchy has gaps (e.g., h1 to h3 without h2)">✗</span>' :
                                      '<span style="color: #10b981;" title="Good: Heading hierarchy is correct">✓</span>'}
                              </td>
                              <td style="color: ${missingMeta.length === 0 ? '#10b981' : (missingMeta.length <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${missingMeta.length === 0 ? 'Good: All important meta tags are present' : 'Missing meta tags: ' + missingMeta.join(', ')}">
                                  ${missingMeta.length}
                              </td>
                              <td style="color: ${alternatesCount > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${alternatesCount > 0 ? alternatesCount + ' alternate language link(s)' : 'No alternate language links'}">
                                  ${alternatesCount}
                              </td>
                              <td style="color: ${linksWithoutText === 0 ? '#10b981' : (linksWithoutText <= 3 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${linksWithoutText === 0 ? 'Good: All links have text' : 'Warning: ' + linksWithoutText + ' link(s) without text'}">
                                  ${linksWithoutText}
                              </td>
                              <td style="color: ${securityScore === null ? '#9ca3af' : (securityScore >= 70 ? '#10b981' : (securityScore >= 50 ? '#f59e0b' : '#ef4444'))}; font-weight: 600; text-align: center; white-space: pre-line;" title="${securityTooltip}">
                                  ${securityScore !== null ? securityScore : 'N/A'}
                              </td>
                              <td style="color: ${missingSecHeaders === 0 ? '#10b981' : (missingSecHeaders <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${missingSecHeaders === 0 ? 'Good: All security headers present' : 'Missing headers: ' + (page.security?.missingHeaders?.join(', ') || '')}">
                                  ${missingSecHeaders}
                              </td>
                              <td style="color: ${insecureCookies === 0 ? '#10b981' : (insecureCookies <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${insecureCookies === 0 ? 'Good: All cookies are secure' : 'Warning: ' + insecureCookies + ' cookie(s) without Secure/HttpOnly flags'}">
                                  ${insecureCookies}
                              </td>
                              <td style="color: ${mixedContent === 0 ? '#10b981' : (mixedContent <= 3 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${mixedContent === 0 ? 'Good: No mixed content' : 'Warning: ' + mixedContent + ' HTTP resources on HTTPS page'}">
                                  ${mixedContent}
                              </td>
                              <td style="color: ${formsWithoutCSRF === 0 ? '#10b981' : (formsWithoutCSRF <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${formsWithoutCSRF === 0 ? 'Good: All forms have CSRF protection' : 'Warning: ' + formsWithoutCSRF + ' form(s) without CSRF tokens'}">
                                  ${formsWithoutCSRF}
                              </td>
                              <td style="color: ${inlineScripts <= 5 ? '#10b981' : (inlineScripts <= 10 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${inlineScripts <= 5 ? 'Good: Minimal inline scripts' : 'Warning: ' + inlineScripts + ' inline scripts (potential XSS risk)'}">
                                  ${inlineScripts}
                              </td>
                              <td style="color: ${cacheScore === null ? '#9ca3af' : (cacheScore >= 70 ? '#10b981' : (cacheScore >= 50 ? '#f59e0b' : '#ef4444'))}; font-weight: 600; text-align: center; white-space: pre-line;" title="${cachingTooltip}">
                                  ${cacheScore !== null ? cacheScore : 'N/A'}
                              </td>
                              <td style="text-align: center;">
                                  ${hasCDN ?
                                      '<span style="color: #10b981;" title="CDN detected' + (cdnProvider ? ': ' + cdnProvider : '') + '">✓</span>' :
                                      '<span style="color: #f59e0b;" title="No CDN detected">✗</span>'}
                              </td>
                              <td style="color: ${cachedStatic > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${cachedStatic > 0 ? cachedStatic + ' static resources cached' : 'No cached static resources'}">
                                  ${cachedStatic}
                              </td>
                              <td style="color: ${uncachedStatic === 0 ? '#10b981' : (uncachedStatic <= 5 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${uncachedStatic === 0 ? 'Good: All static resources are cached' : 'Warning: ' + uncachedStatic + ' static resources without caching'}">
                                  ${uncachedStatic}
                              </td>
                              <td style="text-align: center;">
                                  ${hasServiceWorker ?
                                      '<span style="color: #10b981;" title="Service Worker is active">✓</span>' :
                                      '<span style="color: #f59e0b;" title="No Service Worker detected">✗</span>'}
                              </td>
                              ${(() => {
                                  const imgOpt = page.imageOptimization || {};
                                  const resOpt = page.resourceOptimization || {};

                                  const totalImages = imgOpt.totalImages || 0;
                                  const lazyImages = imgOpt.withLazyLoading || 0;
                                  const totalImageSize = imgOpt.totalImageSize || 0;
                                  const modernFormats = imgOpt.modernFormats || 0;
                                  const legacyFormats = imgOpt.legacyFormats || 0;

                                  const renderBlocking = resOpt.renderBlocking?.totalBlocking || 0;
                                  const uncompressed = resOpt.compression?.uncompressed || 0;
                                  const unminified = (resOpt.minification?.unminifiedJS || 0) + (resOpt.minification?.unminifiedCSS || 0);

                                  return `
                                      <td style="color: ${totalImages > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${totalImages} total images">
                                          ${totalImages}
                                      </td>
                                      <td style="color: ${totalImages > 0 && lazyImages === 0 ? '#ef4444' : (lazyImages > 0 ? '#10b981' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${lazyImages} images with lazy loading (${totalImages} total)">
                                          ${lazyImages}/${totalImages}
                                      </td>
                                      <td style="color: ${totalImageSize > 1000000 ? '#ef4444' : (totalImageSize > 500000 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="Total image size: ${Math.round(totalImageSize / 1000)}KB">
                                          ${Math.round(totalImageSize / 1000)}
                                      </td>
                                      <td style="color: ${legacyFormats > 0 && modernFormats === 0 ? '#f59e0b' : (modernFormats > 0 ? '#10b981' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${modernFormats} modern format images (WebP/AVIF), ${legacyFormats} legacy format images (JPG/PNG)">
                                          ${modernFormats}/${totalImages}
                                      </td>
                                      <td style="color: ${renderBlocking > 5 ? '#ef4444' : (renderBlocking > 0 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="${renderBlocking} render-blocking resources">
                                          ${renderBlocking}
                                      </td>
                                      <td style="color: ${uncompressed > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${uncompressed} uncompressed text resources">
                                          ${uncompressed}
                                      </td>
                                      <td style="color: ${unminified > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${unminified} unminified resources">
                                          ${unminified}
                                      </td>
                                  `;
                              })()}
                              ${(() => {
                                  const a11y = page.accessibility || {};

                                  const a11yScore = a11y.a11yScore ?? 'N/A';
                                  const ariaValid = a11y.aria?.valid || 0;
                                  const ariaInvalid = a11y.aria?.invalid || 0;
                                  const inputsWithLabels = a11y.forms?.inputsWithLabels || 0;
                                  const inputsWithoutLabels = a11y.forms?.inputsWithoutLabels || 0;
                                  const totalInputs = inputsWithLabels + inputsWithoutLabels;
                                  const hasMain = a11y.semantic?.hasMain || false;
                                  const hasNav = a11y.semantic?.hasNav || false;
                                  const hasHeader = a11y.semantic?.hasHeader || false;
                                  const focusIssues = a11y.keyboard?.elementsWithoutFocus || 0;
                                  const positiveTabindex = a11y.keyboard?.positiveTabindex || 0;

                                  return `
                                      <td style="color: ${a11yScore >= 70 ? '#10b981' : (a11yScore >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Accessibility Score: ${a11yScore}/100">
                                          ${a11yScore}
                                      </td>
                                      <td style="text-align: center;">
                                          ${ariaInvalid > 0 ?
                                              '<span style="color: #ef4444;" title="' + ariaInvalid + ' invalid ARIA roles">✗</span>' :
                                              (ariaValid > 0 ? '<span style="color: #10b981;" title="' + ariaValid + ' valid ARIA roles">✓</span>' : '<span style="color: #9ca3af;">—</span>')}
                                      </td>
                                      <td style="color: ${totalInputs > 0 && inputsWithoutLabels === 0 ? '#10b981' : (inputsWithoutLabels > 0 ? '#ef4444' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${inputsWithLabels} inputs with labels, ${inputsWithoutLabels} without">
                                          ${inputsWithLabels}/${totalInputs}
                                      </td>
                                      <td style="text-align: center;" title="Main: ${hasMain ? 'Yes' : 'No'}, Nav: ${hasNav ? 'Yes' : 'No'}, Header: ${hasHeader ? 'Yes' : 'No'}">
                                          ${hasMain ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>'}
                                          ${hasNav ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #f59e0b;">✗</span>'}
                                          ${hasHeader ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #f59e0b;">✗</span>'}
                                      </td>
                                      <td style="color: ${focusIssues === 0 && positiveTabindex === 0 ? '#10b981' : '#f59e0b'}; font-weight: 600; text-align: center;" title="${focusIssues} elements without focus indicators, ${positiveTabindex} with positive tabindex">
                                          ${focusIssues + positiveTabindex}
                                      </td>
                                  `;
                              })()}
                              ${(() => {
                                  const content = page.contentQuality || {};

                                  const contentScore = content.contentScore ?? 'N/A';
                                  const wordCount = content.wordCount || 0;
                                  const textToHtmlRatio = content.textToHtmlRatio || 0;
                                  const readability = content.readabilityScore || 0;
                                  const topKeywords = content.topKeywords || [];
                                  const topKeywordsStr = topKeywords.slice(0, 3).map(k => `${k.word}(${k.density}%)`).join(', ');

                                  return `
                                      <td style="color: ${contentScore >= 70 ? '#10b981' : (contentScore >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Content Quality Score: ${contentScore}/100">
                                          ${contentScore}
                                      </td>
                                      <td style="color: ${wordCount >= 600 ? '#10b981' : (wordCount >= 300 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${wordCount} words (min: 300, recommended: 600)">
                                          ${wordCount}
                                      </td>
                                      <td style="color: ${textToHtmlRatio >= 25 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="Text-to-HTML ratio: ${textToHtmlRatio}% (min: 25%)">
                                          ${textToHtmlRatio}%
                                      </td>
                                      <td style="color: ${readability >= 60 ? '#10b981' : (readability >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Flesch Reading Ease: ${readability}/100 (60-70 is standard)">
                                          ${readability}
                                      </td>
                                      <td style="font-size: 11px; text-align: left;" title="Top keywords: ${topKeywords.map(k => `${k.word}: ${k.count} times (${k.density}%)`).join(', ')}">
                                          ${topKeywordsStr || '—'}
                                      </td>
                                  `;
                              })()}
                          </tr>
                        `;
                      }).join('')}
                  </tbody>
              </table>
          </div>

          <footer>
              <p>SEO Audit Tool - Generated with Node.js & Playwright</p>
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

      <script>
      (function() {
          const table = document.querySelector('table');
          const headers = table.querySelectorAll('th.sortable');
          const tbody = table.querySelector('tbody');

          // Get cell value with proper parsing
          function getCellValue(row, index) {
              const cell = row.cells[index];
              if (!cell) return '';

              // Get text content, removing extra spaces
              let value = cell.textContent.trim();

              // Handle special cases
              if (value === 'N/A' || value === '✓' || value === '✗' || value === '⚠') {
                  // For N/A, treat as -1 for sorting (will be at the end)
                  if (value === 'N/A') return -Infinity;
                  if (value === '✓') return 1;
                  if (value === '✗') return 0;
                  if (value === '⚠') return 0.5;
              }

              // Try to parse as number (remove non-numeric characters except . and -)
              const numValue = parseFloat(value.replace(/[^0-9.-]/g, ''));
              if (!isNaN(numValue)) {
                  return numValue;
              }

              // Return as lowercase string for text sorting
              return value.toLowerCase();
          }

          // Compare function
          function comparer(index, isAsc) {
              return function(a, b) {
                  const valA = getCellValue(a, index);
                  const valB = getCellValue(b, index);

                  // Handle infinity values
                  if (valA === -Infinity && valB === -Infinity) return 0;
                  if (valA === -Infinity) return isAsc ? 1 : -1;
                  if (valB === -Infinity) return isAsc ? -1 : 1;

                  // Compare values
                  if (typeof valA === 'number' && typeof valB === 'number') {
                      return isAsc ? valA - valB : valB - valA;
                  }

                  // String comparison
                  const strA = String(valA);
                  const strB = String(valB);
                  return isAsc
                      ? strA.localeCompare(strB)
                      : strB.localeCompare(strA);
              };
          }

          // Add click handlers to all sortable headers
          headers.forEach((header, index) => {
              header.addEventListener('click', function() {
                  // Determine sort direction
                  const isAsc = !header.classList.contains('asc');

                  // Remove sort classes from all headers
                  headers.forEach(h => h.classList.remove('asc', 'desc'));

                  // Add appropriate class to clicked header
                  header.classList.toggle('asc', isAsc);
                  header.classList.toggle('desc', !isAsc);

                  // Get column index (actual position in the row)
                  const columnIndex = Array.from(header.parentElement.children).indexOf(header);

                  // Sort rows
                  const rows = Array.from(tbody.querySelectorAll('tr'));
                  rows.sort(comparer(columnIndex, isAsc));

                  // Reattach sorted rows
                  rows.forEach(row => tbody.appendChild(row));
              });
          });
      })();

      // Incoming links data
      const incomingLinksData = ${JSON.stringify(pageData.incomingLinks || {})};

      // Metric information with thresholds and sources
      const metricInfo = {
        'TTFB': {
          name: 'Time to First Byte',
          description: 'Measures how long it takes for the server to send the first byte of response.',
          threshold: '≤ 800ms',
          good: '< 800ms',
          warning: '800-1200ms',
          bad: '> 1200ms',
          sources: [
            { text: 'Web.dev TTFB Guide', url: 'https://web.dev/articles/ttfb' },
            { text: 'Google Search Central', url: 'https://developers.google.com/search/docs/appearance/page-experience' }
          ]
        },
        'FCP': {
          name: 'First Contentful Paint',
          description: 'Measures when the first text or image is painted on screen.',
          threshold: '≤ 1800ms',
          good: '< 1800ms',
          warning: '1800-3000ms',
          bad: '> 3000ms',
          sources: [
            { text: 'Web.dev FCP Guide', url: 'https://web.dev/articles/fcp' },
            { text: 'Core Web Vitals', url: 'https://web.dev/articles/vitals' }
          ]
        },
        'LCP': {
          name: 'Largest Contentful Paint',
          description: 'Measures loading performance. Marks when the largest content element becomes visible.',
          threshold: '≤ 2500ms',
          good: '< 2500ms',
          warning: '2500-4000ms',
          bad: '> 4000ms',
          sources: [
            { text: 'Web.dev LCP Guide', url: 'https://web.dev/articles/lcp' },
            { text: 'Optimize LCP', url: 'https://web.dev/articles/optimize-lcp' }
          ]
        },
        'CLS': {
          name: 'Cumulative Layout Shift',
          description: 'Measures visual stability. Quantifies unexpected layout shifts during page load.',
          threshold: '≤ 0.1',
          good: '< 0.1',
          warning: '0.1-0.25',
          bad: '> 0.25',
          sources: [
            { text: 'Web.dev CLS Guide', url: 'https://web.dev/articles/cls' },
            { text: 'Optimize CLS', url: 'https://web.dev/articles/optimize-cls' }
          ]
        },
        'INP': {
          name: 'Interaction to Next Paint',
          description: 'Measures responsiveness. Time from user interaction to visual update.',
          threshold: '≤ 200ms',
          good: '< 200ms',
          warning: '200-500ms',
          bad: '> 500ms',
          sources: [
            { text: 'Web.dev INP Guide', url: 'https://web.dev/articles/inp' },
            { text: 'Optimize INP', url: 'https://web.dev/articles/optimize-inp' }
          ]
        },
        'Page Size': {
          name: 'Total Page Size',
          description: 'Total size of all resources (HTML, CSS, JS, images, etc.) loaded on the page.',
          threshold: '≤ 6 MB',
          good: '< 3 MB',
          warning: '3-6 MB',
          bad: '> 6 MB',
          sources: [
            { text: 'Page Weight Guide', url: 'https://web.dev/articles/your-first-performance-budget' },
            { text: 'HTTP Archive Stats', url: 'https://httparchive.org/reports/page-weight' }
          ]
        },
        'Requests': {
          name: 'Number of Requests',
          description: 'Total number of HTTP requests made to load the page.',
          threshold: '≤ 20',
          good: '< 20',
          warning: '20-50',
          bad: '> 50',
          sources: [
            { text: 'Reduce Requests', url: 'https://web.dev/articles/reduce-network-payloads' },
            { text: 'HTTP/2 Benefits', url: 'https://web.dev/articles/performance-http2' }
          ]
        },
        'Title': {
          name: 'Page Title',
          description: 'The <title> tag is crucial for SEO and appears in search results and browser tabs.',
          threshold: '30-60 characters',
          good: '50-60 chars',
          warning: '30-50 or 60-70 chars',
          bad: '< 30 or > 70 chars',
          sources: [
            { text: 'Google Title Guidelines', url: 'https://developers.google.com/search/docs/appearance/title-link' },
            { text: 'SEO Best Practices', url: 'https://moz.com/learn/seo/title-tag' }
          ]
        },
        'Description': {
          name: 'Meta Description',
          description: 'Summarizes page content. Often displayed in search results below the title.',
          threshold: '120-160 characters',
          good: '150-160 chars',
          warning: '120-150 or 160-200 chars',
          bad: '< 120 or > 200 chars',
          sources: [
            { text: 'Google Meta Description', url: 'https://developers.google.com/search/docs/appearance/snippet' },
            { text: 'Meta Tag Guide', url: 'https://moz.com/learn/seo/meta-description' }
          ]
        },
        'Security Score': {
          name: 'Security Score',
          description: 'Overall security posture based on headers, HTTPS, cookies, and XSS protection.',
          threshold: '≥ 70/100',
          good: '≥ 70',
          warning: '50-69',
          bad: '< 50',
          sources: [
            { text: 'OWASP Security Headers', url: 'https://owasp.org/www-project-secure-headers/' },
            { text: 'Mozilla Security Guide', url: 'https://infosec.mozilla.org/guidelines/web_security' }
          ]
        },
        'Cache Score': {
          name: 'Caching Score',
          description: 'Measures caching effectiveness: CDN usage, cache headers, service workers.',
          threshold: '≥ 70/100',
          good: '≥ 70',
          warning: '50-69',
          bad: '< 50',
          sources: [
            { text: 'Web.dev Caching Guide', url: 'https://web.dev/articles/http-cache' },
            { text: 'CDN Benefits', url: 'https://web.dev/articles/content-delivery-networks' }
          ]
        },
        'A11y Score': {
          name: 'Accessibility Score',
          description: 'Measures accessibility: ARIA, semantic HTML, keyboard navigation, form labels.',
          threshold: '≥ 70/100',
          good: '≥ 70',
          warning: '50-69',
          bad: '< 50',
          sources: [
            { text: 'Web.dev Accessibility', url: 'https://web.dev/learn/accessibility' },
            { text: 'WCAG Guidelines', url: 'https://www.w3.org/WAI/WCAG21/quickref/' }
          ]
        },
        'Content Score': {
          name: 'Content Quality Score',
          description: 'Evaluates content: word count, text-to-HTML ratio, readability, keyword usage.',
          threshold: '≥ 70/100',
          good: '≥ 70',
          warning: '50-69',
          bad: '< 50',
          sources: [
            { text: 'Content Quality Guide', url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content' },
            { text: 'Writing for SEO', url: 'https://moz.com/learn/seo/on-page-factors' }
          ]
        },
        'Readability': {
          name: 'Flesch Reading Ease',
          description: 'Measures how easy your content is to read (0-100, higher = easier).',
          threshold: '60-70',
          good: '60-70',
          warning: '50-60 or 70-80',
          bad: '< 50 or > 80',
          sources: [
            { text: 'Readability Guide', url: 'https://readable.com/readability/flesch-reading-ease-flesch-kincaid-grade-level/' },
            { text: 'Content Clarity', url: 'https://yoast.com/flesch-reading-ease-score/' }
          ]
        }
      };

      // Modal functionality
      (function() {
          const modal = document.getElementById('infoModal');
          const modalTitle = document.getElementById('modalTitle');
          const modalUrl = document.getElementById('modalUrl');
          const modalBody = document.getElementById('modalBody');
          const modalClose = document.getElementById('modalClose');

          // Function to show issue details in modal
          function showIssueDetails(issueName) {
              const issueData = details[issueName];
              if (!issueData) return;

              const affectedPages = issueData.examples || [];
              const severity = issueData.severity || 'UNKNOWN';

              // Build severity badge
              const severityColors = {
                  'CRITICAL': 'background: #dc2626; color: white;',
                  'HIGH': 'background: #ea580c; color: white;',
                  'MEDIUM': 'background: #f59e0b; color: white;',
                  'LOW': 'background: #3b82f6; color: white;'
              };
              const severityStyle = severityColors[severity] || 'background: #6b7280; color: white;';

              // Build HTML content
              let html = '<div class="issue-details">';

              // Severity badge
              html += '<div style="margin-bottom: 20px;">';
              html += '<span style="' + severityStyle + ' padding: 6px 12px; border-radius: 4px; font-weight: 600; font-size: 14px;">';
              html += severity;
              html += '</span>';
              html += '</div>';

              // Issue description
              html += '<div class="metric-section">';
              html += '<h4>Issue Description</h4>';
              html += '<p style="color: #374151; line-height: 1.6;">' + issueName + '</p>';
              html += '</div>';

              // Affected pages count
              html += '<div class="metric-section">';
              html += '<h4>Affected Pages</h4>';
              html += '<p style="font-size: 24px; font-weight: 600; color: #1f2937;">' + affectedPages.length + ' page(s)</p>';
              html += '</div>';

              // List of affected URLs
              if (affectedPages.length > 0) {
                  html += '<div class="metric-section">';
                  html += '<h4>Affected URLs</h4>';
                  html += '<div style="max-height: 400px; overflow-y: auto; background: #f9fafb; border-radius: 6px; padding: 12px;">';

                  const maxDisplay = 100; // Show up to 100 URLs
                  const urlsToShow = affectedPages.slice(0, maxDisplay);

                  html += '<ul style="list-style: none; padding: 0; margin: 0;">';
                  urlsToShow.forEach((url, index) => {
                      html += '<li style="padding: 8px; margin: 4px 0; background: white; border-radius: 4px; border-left: 3px solid #3b82f6;">';
                      html += '<span style="color: #9ca3af; font-size: 12px; margin-right: 8px;">' + (index + 1) + '.</span>';
                      html += '<a href="' + url + '" target="_blank" style="color: #2563eb; text-decoration: none; word-break: break-all; font-size: 13px;">' + url + '</a>';
                      html += '</li>';
                  });
                  html += '</ul>';

                  if (affectedPages.length > maxDisplay) {
                      html += '<p style="color: #6b7280; font-size: 12px; margin-top: 12px; text-align: center;">... and ' + (affectedPages.length - maxDisplay) + ' more page(s)</p>';
                  }

                  html += '</div>';
                  html += '</div>';
              }

              html += '</div>';

              // Show modal with issue details
              modalTitle.textContent = 'Issue Details';
              modalUrl.textContent = '';
              modalUrl.style.display = 'none';
              modalBody.innerHTML = html;
              modalBody.classList.add('with-html');
              modal.style.display = 'flex';
          }

          // Function to show modal with optional metric info
          function showModal(title, url, content, isHtml = false) {
              modalTitle.textContent = title;
              modalUrl.textContent = url || '';
              modalUrl.style.display = url ? 'block' : 'none';

              // Check if this metric has additional information
              const metricData = metricInfo[title];

              if (metricData && !isHtml) {
                  // Build enhanced HTML content with metric information
                  let html = '<div class="metric-section">';
                  html += '<h4>' + metricData.name + '</h4>';
                  html += '<p>' + metricData.description + '</p>';
                  html += '</div>';

                  html += '<div class="metric-section">';
                  html += '<h4>Thresholds</h4>';
                  html += '<div class="threshold-grid">';
                  html += '<div class="threshold-item threshold-good">';
                  html += '<div style="font-weight: 600;">Good</div>';
                  html += '<div>' + metricData.good + '</div>';
                  html += '</div>';
                  html += '<div class="threshold-item threshold-warning">';
                  html += '<div style="font-weight: 600;">Warning</div>';
                  html += '<div>' + metricData.warning + '</div>';
                  html += '</div>';
                  html += '<div class="threshold-item threshold-bad">';
                  html += '<div style="font-weight: 600;">Bad</div>';
                  html += '<div>' + metricData.bad + '</div>';
                  html += '</div>';
                  html += '</div>';
                  html += '</div>';

                  if (content) {
                      html += '<div class="metric-section">';
                      html += '<h4>Current Value</h4>';
                      html += '<pre>' + content + '</pre>';
                      html += '</div>';
                  }

                  html += '<div class="source-links">';
                  html += '<h4>Learn More</h4>';
                  metricData.sources.forEach(source => {
                      html += '<a href="' + source.url + '" target="_blank" rel="noopener noreferrer">' + source.text + '</a>';
                  });
                  html += '</div>';

                  modalBody.innerHTML = html;
                  modalBody.classList.add('with-html');
              } else if (isHtml) {
                  modalBody.innerHTML = content;
                  modalBody.classList.add('with-html');
              } else {
                  modalBody.textContent = content;
                  modalBody.classList.remove('with-html');
              }

              modal.classList.add('active');
              document.body.style.overflow = 'hidden'; // Prevent background scrolling
          }

          // Function to hide modal
          function hideModal() {
              modal.classList.remove('active');
              document.body.style.overflow = ''; // Restore scrolling
          }

          // Close modal on close button click
          modalClose.addEventListener('click', hideModal);

          // Close modal on overlay click
          modal.addEventListener('click', function(e) {
              if (e.target === modal) {
                  hideModal();
              }
          });

          // Close modal on Escape key
          document.addEventListener('keydown', function(e) {
              if (e.key === 'Escape' && modal.classList.contains('active')) {
                  hideModal();
              }
          });

          // Add click handlers to all cells with title attribute
          document.querySelectorAll('td[title]:not([title=""])').forEach(cell => {
              cell.addEventListener('click', function(e) {
                  // Don't open modal if clicking a link
                  if (e.target.tagName === 'A') return;

                  const tooltipText = cell.getAttribute('title');
                  if (!tooltipText) return;

                  // Get the URL from the first cell of the row
                  const row = cell.closest('tr');
                  const urlCell = row.querySelector('td a.url-link');
                  const url = urlCell ? urlCell.textContent : '';

                  // Determine the column name from header
                  const cellIndex = Array.from(row.cells).indexOf(cell);
                  const headerRow = cell.closest('table').querySelector('thead tr');
                  const headerCell = headerRow.cells[cellIndex];
                  const rawColumnName = headerCell ? headerCell.textContent.split('\\n')[0].trim() : 'Details';

                  // Normalize the column name to match metric info keys
                  const normalizedName = normalizeMetricName(rawColumnName);

                  showModal(normalizedName, url, tooltipText);
              });
          });

          // Helper function to normalize column names for metric lookup
          function normalizeMetricName(columnName) {
              // Remove extra text and normalize
              const normalized = columnName
                  .split('\\n')[0]
                  .trim()
                  .replace(/\s*\(.*?\)\s*/g, '') // Remove anything in parentheses
                  .replace(/\s*ms\s*/gi, '')      // Remove "ms"
                  .replace(/\s*chars?\s*/gi, '')  // Remove "char" or "chars"
                  .replace(/\s*score\s*/gi, ' Score') // Normalize "score"
                  .trim();

              // Check for exact match first
              if (metricInfo[normalized]) return normalized;

              // Try common variations
              const variations = {
                'A11y': 'A11y Score',
                'Accessibility': 'A11y Score',
                'Cache': 'Cache Score',
                'Security': 'Security Score',
                'Content': 'Content Score',
                'Total Page Size': 'Page Size',
                'Number of Requests': 'Requests'
              };

              return variations[normalized] || normalized;
          }

          // Add click handlers for incoming links cells
          document.querySelectorAll('.incoming-links-cell[data-count]').forEach(cell => {
              const count = parseInt(cell.getAttribute('data-count'));
              if (count === 0) return; // Skip cells with no incoming links

              cell.addEventListener('click', function() {
                  const pageUrl = cell.getAttribute('data-url');
                  const incomingLinks = incomingLinksData[pageUrl] || [];

                  if (incomingLinks.length === 0) {
                      showModal('Incoming Links', pageUrl, 'No incoming links found for this page.', false);
                      return;
                  }

                  // Create formatted list of incoming links as HTML
                  let html = '<div class="metric-section">';
                  html += '<h4>Pages Linking Here</h4>';
                  html += '<p>' + incomingLinks.length + ' page(s) link to this URL:</p>';
                  html += '<div style="margin-top: 12px; max-height: 400px; overflow-y: auto;">';
                  incomingLinks.forEach((link, index) => {
                      html += '<div style="padding: 8px; margin: 4px 0; background: #f9fafb; border-radius: 4px; font-size: 12px; word-break: break-all;">';
                      html += '<span style="color: #9ca3af; margin-right: 8px;">' + (index + 1) + '.</span>';
                      html += '<a href="' + link + '" target="_blank" style="color: #2563eb;">' + link + '</a>';
                      html += '</div>';
                  });
                  html += '</div>';
                  html += '</div>';

                  showModal('Incoming Links (' + incomingLinks.length + ')', pageUrl, html, true);
              });
          });
      })();

      // Initialize Charts
      (function initCharts() {
          const jsonData = ${JSON.stringify(jsonData)};
          const summary = jsonData.analysis?.summary || {};
          const details = jsonData.analysis?.details || {};
          const pages = jsonData.pageData?.pages || {};
          const trendData = ${JSON.stringify(trendData)};

          // Historical Trend Charts
          if (trendData && trendData.labels && trendData.labels.length > 0) {
              // Score Trend Chart
              const scoreTrendCtx = document.getElementById('scoreTrendChart');
              if (scoreTrendCtx) {
                  new Chart(scoreTrendCtx, {
                      type: 'line',
                      data: {
                          labels: trendData.labels,
                          datasets: [{
                              label: 'Overall Score',
                              data: trendData.scores,
                              borderColor: '#3b82f6',
                              backgroundColor: 'rgba(59, 130, 246, 0.1)',
                              borderWidth: 3,
                              fill: true,
                              tension: 0.4,
                              pointRadius: 5,
                              pointBackgroundColor: '#3b82f6',
                              pointBorderColor: '#fff',
                              pointBorderWidth: 2
                          }]
                      },
                      options: {
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                              legend: { display: false },
                              tooltip: {
                                  callbacks: {
                                      label: function(context) {
                                          return 'Score: ' + context.parsed.y;
                                      }
                                  }
                              }
                          },
                          scales: {
                              y: {
                                  beginAtZero: true,
                                  max: 100,
                                  ticks: {
                                      callback: function(value) {
                                          return value;
                                      }
                                  }
                              }
                          }
                      }
                  });
              }

              // Issues Trend Chart
              const issuesTrendCtx = document.getElementById('issuesTrendChart');
              if (issuesTrendCtx) {
                  new Chart(issuesTrendCtx, {
                      type: 'line',
                      data: {
                          labels: trendData.labels,
                          datasets: [
                              {
                                  label: 'Total Issues',
                                  data: trendData.issues,
                                  borderColor: '#3b82f6',
                                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                  borderWidth: 2,
                                  fill: true,
                                  tension: 0.4
                              },
                              {
                                  label: 'Critical Issues',
                                  data: trendData.critical,
                                  borderColor: '#ef4444',
                                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                  borderWidth: 2,
                                  fill: true,
                                  tension: 0.4
                              }
                          ]
                      },
                      options: {
                          responsive: true,
                          maintainAspectRatio: false,
                          plugins: {
                              legend: {
                                  position: 'bottom',
                                  labels: { padding: 10, font: { size: 11 } }
                              }
                          },
                          scales: {
                              y: {
                                  beginAtZero: true,
                                  ticks: { precision: 0 }
                              }
                          }
                      }
                  });
              }
          }

          // Chart 1: Issue Distribution by Severity
          const issueCtx = document.getElementById('issueChart');
          if (issueCtx) {
              new Chart(issueCtx, {
                  type: 'doughnut',
                  data: {
                      labels: ['Critical', 'High', 'Medium', 'Low'],
                      datasets: [{
                          data: [
                              summary.criticalCount || 0,
                              summary.highCount || 0,
                              summary.mediumCount || 0,
                              summary.lowCount || 0
                          ],
                          backgroundColor: [
                              '#ef4444',
                              '#f59e0b',
                              '#3b82f6',
                              '#6b7280'
                          ],
                          borderWidth: 2,
                          borderColor: '#fff'
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: {
                              position: 'bottom',
                              labels: { padding: 15, font: { size: 12 } }
                          },
                          tooltip: {
                              callbacks: {
                                  label: function(context) {
                                      const label = context.label || '';
                                      const value = context.parsed || 0;
                                      const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                      return label + ': ' + value + ' (' + percentage + '%)';
                                  }
                              }
                          }
                      }
                  }
              });
          }

          // Chart 2: Top 10 Issues by Frequency
          const topIssues = Object.entries(details)
              .map(([issue, data]) => ({ issue, count: data.examples?.length || 0 }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 10);

          const frequencyCtx = document.getElementById('frequencyChart');
          if (frequencyCtx && topIssues.length > 0) {
              new Chart(frequencyCtx, {
                  type: 'bar',
                  data: {
                      labels: topIssues.map(item => {
                          const issue = item.issue;
                          return issue.length > 100 ? issue.substring(0, 97) + '...' : issue;
                      }),
                      datasets: [{
                          label: 'Affected Pages',
                          data: topIssues.map(item => item.count),
                          backgroundColor: '#3b82f6',
                          borderColor: '#2563eb',
                          borderWidth: 1
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      indexAxis: 'y',
                      onClick: (event, activeElements) => {
                          if (activeElements.length > 0) {
                              const index = activeElements[0].index;
                              const issue = topIssues[index].issue;
                              showIssueDetails(issue);
                          }
                      },
                      plugins: {
                          legend: { display: false },
                          tooltip: {
                              callbacks: {
                                  title: function(context) {
                                      const index = context[0].dataIndex;
                                      return topIssues[index].issue;
                                  },
                                  afterLabel: function() {
                                      return 'Click to view details';
                                  }
                              }
                          }
                      },
                      scales: {
                          x: {
                              beginAtZero: true,
                              ticks: { precision: 0 }
                          }
                      }
                  }
              });
          }

          // Chart 3: Performance Metrics Distribution
          const pagesWithPerf = Object.values(pages).filter(p => p.vitals);
          const avgTTFB = pagesWithPerf.length > 0
              ? pagesWithPerf.reduce((sum, p) => sum + (p.vitals.ttfb || 0), 0) / pagesWithPerf.length
              : 0;
          const avgLCP = pagesWithPerf.length > 0
              ? pagesWithPerf.reduce((sum, p) => sum + (p.vitals.lcp || 0), 0) / pagesWithPerf.length
              : 0;
          const avgCLS = pagesWithPerf.length > 0
              ? pagesWithPerf.reduce((sum, p) => sum + (p.vitals.cls || 0), 0) / pagesWithPerf.length
              : 0;

          const performanceCtx = document.getElementById('performanceChart');
          if (performanceCtx && pagesWithPerf.length > 0) {
              new Chart(performanceCtx, {
                  type: 'bar',
                  data: {
                      labels: ['TTFB (ms)', 'LCP (ms)', 'CLS (×100)'],
                      datasets: [{
                          label: 'Average Value',
                          data: [avgTTFB.toFixed(0), avgLCP.toFixed(0), (avgCLS * 100).toFixed(1)],
                          backgroundColor: ['#8b5cf6', '#ec4899', '#14b8a6'],
                          borderColor: ['#7c3aed', '#db2777', '#0d9488'],
                          borderWidth: 2
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { display: false },
                          tooltip: {
                              callbacks: {
                                  label: function(context) {
                                      let label = context.label || '';
                                      let value = context.parsed.y;
                                      if (label.includes('CLS')) {
                                          value = (value / 100).toFixed(3);
                                      }
                                      return label + ': ' + value;
                                  }
                              }
                          }
                      },
                      scales: {
                          y: {
                              beginAtZero: true
                          }
                      }
                  }
              });
          }

          // Chart 4: Pages by Status Code
          const statusCodes = {};
          Object.values(pages).forEach(page => {
              const code = page.statusCode || 'Unknown';
              const codeGroup = Math.floor(code / 100) * 100;
              const label = codeGroup + 'xx (' + (codeGroup === 200 ? 'Success' : codeGroup === 300 ? 'Redirect' : codeGroup === 400 ? 'Client Error' : codeGroup === 500 ? 'Server Error' : 'Other') + ')';
              statusCodes[label] = (statusCodes[label] || 0) + 1;
          });

          const statusCtx = document.getElementById('statusChart');
          if (statusCtx && Object.keys(statusCodes).length > 0) {
              new Chart(statusCtx, {
                  type: 'pie',
                  data: {
                      labels: Object.keys(statusCodes),
                      datasets: [{
                          data: Object.values(statusCodes),
                          backgroundColor: [
                              '#10b981',
                              '#3b82f6',
                              '#f59e0b',
                              '#ef4444',
                              '#6b7280'
                          ],
                          borderWidth: 2,
                          borderColor: '#fff'
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: {
                              position: 'bottom',
                              labels: { padding: 15, font: { size: 12 } }
                          },
                          tooltip: {
                              callbacks: {
                                  label: function(context) {
                                      const label = context.label || '';
                                      const value = context.parsed || 0;
                                      const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                      return label + ': ' + value + ' (' + percentage + '%)';
                                  }
                              }
                          }
                      }
                  }
              });
          }
      })();

      // Table Sorting Functionality
      (function initTableSorting() {
          let currentSort = { column: -1, ascending: true };

          document.querySelectorAll('th.sortable').forEach((header, index) => {
              header.style.cursor = 'pointer';
              header.style.userSelect = 'none';
              header.style.position = 'relative';

              // Add sort indicator
              const indicator = document.createElement('span');
              indicator.className = 'sort-indicator';
              indicator.style.cssText = 'margin-left: 5px; opacity: 0.3; font-size: 10px;';
              indicator.textContent = '▼';
              header.appendChild(indicator);

              header.addEventListener('click', function() {
                  const table = this.closest('table');
                  const tbody = table.querySelector('tbody');
                  const rows = Array.from(tbody.querySelectorAll('tr'));
                  const columnIndex = Array.from(this.parentNode.children).indexOf(this);
                  const dataType = this.getAttribute('data-type') || 'text';

                  // Toggle sort direction if same column, otherwise ascending
                  if (currentSort.column === columnIndex) {
                      currentSort.ascending = !currentSort.ascending;
                  } else {
                      currentSort.column = columnIndex;
                      currentSort.ascending = true;
                  }

                  // Update all indicators
                  document.querySelectorAll('.sort-indicator').forEach(ind => {
                      ind.style.opacity = '0.3';
                      ind.textContent = '▼';
                  });
                  indicator.style.opacity = '1';
                  indicator.textContent = currentSort.ascending ? '▲' : '▼';

                  // Sort rows
                  rows.sort((a, b) => {
                      const aCell = a.cells[columnIndex];
                      const bCell = b.cells[columnIndex];

                      let aValue = aCell ? aCell.textContent.trim() : '';
                      let bValue = bCell ? bCell.textContent.trim() : '';

                      // Extract numeric values for number columns
                      if (dataType === 'number') {
                          aValue = parseFloat(aValue.replace(/[^0-9.-]/g, '')) || 0;
                          bValue = parseFloat(bValue.replace(/[^0-9.-]/g, '')) || 0;
                          return currentSort.ascending ? aValue - bValue : bValue - aValue;
                      }

                      // Text comparison
                      const comparison = aValue.localeCompare(bValue);
                      return currentSort.ascending ? comparison : -comparison;
                  });

                  // Re-append rows in sorted order
                  rows.forEach(row => tbody.appendChild(row));

                  // Update row numbers
                  rows.forEach((row, idx) => {
                      const numberCell = row.cells[0];
                      if (numberCell) {
                          numberCell.textContent = idx + 1;
                      }
                  });
              });
          });
      })();

      // CSV Export Functionality
      function escapeCSV(value) {
          if (value === null || value === undefined) return '';
          const str = String(value);
          if (str.includes(',') || str.includes('"') || str.includes('\\n')) {
              return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
      }

      function downloadCSV(filename, content) {
          const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
          const link = document.createElement('a');
          const url = URL.createObjectURL(blob);
          link.setAttribute('href', url);
          link.setAttribute('download', filename);
          link.style.visibility = 'hidden';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
      }

      function exportCSV(type) {
          const jsonData = ${JSON.stringify(jsonData)};
          let content = '';
          let filename = '';

          if (type === 'pages') {
              filename = '${domainName}_pages_overview.csv';
              const rows = [['URL', 'Status Code', 'Title', 'Description', 'H1 Count', 'Canonical', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Has Errors']];
              const pages = jsonData.pageData?.pages || {};

              Object.entries(pages).forEach(([url, data]) => {
                  rows.push([
                      url,
                      data.statusCode || '',
                      data.title || '',
                      data.description || '',
                      data.h1?.length || 0,
                      data.canonical || '',
                      data.vitals?.ttfb || '',
                      data.vitals?.lcp || '',
                      data.vitals?.cls || '',
                      data.totalSize ? (data.totalSize / (1024 * 1024)).toFixed(2) : '',
                      data.numberOfRequests || '',
                      (data.statusCode >= 400 || data.errors?.length > 0) ? 'Yes' : 'No'
                  ].map(escapeCSV));
              });
              content = rows.map(row => row.join(',')).join('\\n');
          }
          else if (type === 'issues') {
              filename = '${domainName}_issues_breakdown.csv';
              const rows = [['Issue', 'Severity', 'Affected Pages', 'Example URLs']];
              const details = jsonData.analysis?.details || {};

              Object.entries(details).forEach(([issue, data]) => {
                  const examples = (data.examples || []).slice(0, 5).join('; ');
                  rows.push([
                      issue,
                      data.severity || '',
                      data.examples?.length || 0,
                      examples
                  ].map(escapeCSV));
              });
              content = rows.map(row => row.join(',')).join('\\n');
          }
          else if (type === 'performance') {
              filename = '${domainName}_performance_metrics.csv';
              const rows = [['URL', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Load Time (ms)']];
              const pages = jsonData.pageData?.pages || {};

              Object.entries(pages).forEach(([url, data]) => {
                  if (data.vitals) {
                      rows.push([
                          url,
                          data.vitals.ttfb || '',
                          data.vitals.lcp || '',
                          data.vitals.cls || '',
                          data.totalSize ? (data.totalSize / (1024 * 1024)).toFixed(2) : '',
                          data.numberOfRequests || '',
                          data.vitals.loadTime || ''
                      ].map(escapeCSV));
                  }
              });
              content = rows.map(row => row.join(',')).join('\\n');
          }
          else if (type === 'quickwins') {
              filename = '${domainName}_quick_wins.csv';
              const rows = [['Priority', 'Issue', 'Severity', 'Impact', 'Effort', 'Affected Pages', 'How to Fix', 'Example URLs']];
              const quickWins = jsonData.analysis?.summary?.quickWins || [];

              quickWins.forEach((win, index) => {
                  const examples = (win.examples || []).slice(0, 3).join('; ');
                  rows.push([
                      index + 1,
                      win.issue || '',
                      win.severity || '',
                      win.impact || '',
                      win.effort || '',
                      win.affectedPages || 0,
                      win.fix || '',
                      examples
                  ].map(escapeCSV));
              });
              content = rows.map(row => row.join(',')).join('\\n');
          }
          else if (type === 'summary') {
              filename = '${domainName}_summary.csv';
              const summary = jsonData.analysis?.summary || {};
              const rows = [
                  ['Metric', 'Value'],
                  ['Overall SEO Score', summary.overallScore || 0],
                  ['Total Issues', summary.totalIssues || 0],
                  ['Critical Issues', summary.criticalCount || 0],
                  ['High Issues', summary.highCount || 0],
                  ['Medium Issues', summary.mediumCount || 0],
                  ['Low Issues', summary.lowCount || 0],
                  ['Pass Rate (%)', summary.passRate || 0],
                  ['Total URLs in Sitemap', jsonData.sitemaps?.total || 0],
                  ['Pages Crawled', jsonData.pageData?.totalWithoutError || 0],
                  ['Pages with Errors', jsonData.pageData?.totalWithError || 0],
                  ['Multilanguage', jsonData.isMultiLang ? 'Yes' : 'No']
              ];

              if (summary.categoryScores) {
                  rows.push(['SEO Score', summary.categoryScores.seo || 0]);
                  rows.push(['Performance Score', summary.categoryScores.performance || 0]);
                  rows.push(['Accessibility Score', summary.categoryScores.accessibility || 0]);
                  rows.push(['Security Score', summary.categoryScores.security || 0]);
                  rows.push(['Technical Score', summary.categoryScores.technical || 0]);
              }
              content = rows.map(row => row.map(escapeCSV).join(',')).join('\\n');
          }

          if (content) {
              downloadCSV(filename, content);
          }
      }
      </script>
  </body>
  </html>`;

  fs.writeFileSync(htmlOutputPath, htmlContent);
  console.log(`✅ HTML report generated: ${htmlOutputPath}`);
}

module.exports = { generateHTML };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node generateHTML.js <json-file>');
    console.error('Example: node generateHTML.js audit-results/SEOAnalysis__example.com.json');
    process.exit(1);
  }

  const jsonFile = args[0];
  if (!fs.existsSync(jsonFile)) {
    console.error(`Error: File not found: ${jsonFile}`);
    process.exit(1);
  }

  // Extract domain name from filename (handle both with and without path)
  const basename = path.basename(jsonFile);
  const domainName = basename.replace('SEOAnalysis__', '').replace('.json', '').replace('.gz', '');

  console.log(`Generating HTML report for ${domainName}...`);
  generateHTML(jsonFile, domainName);
}
