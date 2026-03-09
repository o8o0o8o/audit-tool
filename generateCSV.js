const fs = require('fs');
const path = require('path');
const { ReportDataProcessor } = require('./lib/reports/data-processor');

/**
 * Converts audit data to CSV format for data analysis
 * Generates multiple CSV files:
 * - Pages overview with all metrics
 * - Issues breakdown by severity
 * - Performance metrics summary
 * - Quick wins list
 */

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generatePagesCSV(jsonData) {
  const pages = jsonData.pageData?.pages || {};
  const rows = [
    ['URL', 'Status Code', 'Source', 'Segment', 'Title', 'Title Length', 'Description', 'Desc Length',
     'H1 Count', 'H2 Count', 'Canonical', 'Canonical Match',
     'TTFB (ms)', 'FCP (ms)', 'LCP (ms)', 'CLS', 'Page Size (bytes)', 'Requests',
     'Word Count', 'Text/HTML %', 'Readability',
     'Security Score', 'Cache Score', 'A11y Score', 'Content Score',
     'Images Total', 'Images Lazy', 'Incoming Links',
     'Missing Meta Count', 'Render Blocking', 'Has Errors',
     'Detected Language', 'Lang Match', 'Internal PageRank',
     'CTAs Total', 'CTAs Above Fold', 'Forms',
     'JS Unused %', 'CSS Unused %',
     'Broken Outbound Links', 'Main Content Words', 'Boilerplate %']
  ];

  Object.entries(pages).forEach(([url, data]) => {
    const h1Count = Array.isArray(data.headings)
      ? (data.headings.find(h => h.tag === 'h1')?.count || 0)
      : (data.headings?.h1?.length || 0);
    const h2Count = Array.isArray(data.headings)
      ? (data.headings.find(h => h.tag === 'h2')?.count || 0)
      : (data.headings?.h2?.length || 0);

    rows.push([
      url,
      data.status || data.statusCode || '',
      data.foundIn || 'sitemap',
      data.segment || 'other',
      data.title || '',
      data.title?.length || 0,
      data.description || '',
      data.description?.length || 0,
      h1Count,
      h2Count,
      data.canonical || '',
      data.canonical === url ? 'Yes' : (data.canonical ? 'No' : 'Missing'),
      data.TTFB || data.vitals?.ttfb || '',
      data.FCP || '',
      data.LCP || data.vitals?.lcp || '',
      data.CLS !== undefined ? data.CLS : (data.vitals?.cls || ''),
      data.totalResponseSize || data.totalSize || '',
      data.totalNumberOfRequests || data.numberOfRequests || '',
      data.contentQuality?.wordCount || '',
      data.contentQuality?.textToHtmlRatio || '',
      data.contentQuality?.readabilityScore || '',
      data.security?.securityScore ?? '',
      data.caching?.cacheScore ?? '',
      data.accessibility?.a11yScore ?? '',
      data.contentQuality?.contentScore ?? '',
      data.imageOptimization?.totalImages || '',
      data.imageOptimization?.withLazyLoading || '',
      data.incomingLinksCount || 0,
      data.missingMetaTags?.length || 0,
      data.resourceOptimization?.renderBlocking?.totalBlocking || '',
      (data.status >= 400 || data.statusCode >= 400) ? 'Yes' : 'No',
      data.languageDetection?.detectedLanguage || '',
      data.languageDetection?.match != null ? (data.languageDetection.match ? 'Yes' : 'No') : '',
      data.internalPageRank != null ? data.internalPageRank.toFixed(6) : '',
      data.ctaData?.summary?.total ?? '',
      data.ctaData?.summary?.aboveFoldCount ?? '',
      data.ctaData?.summary?.forms ?? '',
      data.codeCoverage?.js?.ratio ?? '',
      data.codeCoverage?.css?.ratio ?? '',
      data.outboundLinkHealth?.broken?.length ?? '',
      data.contentQuality?.wordCountBySection?.main ?? '',
      data.contentQuality?.wordCountBySection?.boilerplateRatio ?? ''
    ].map(escapeCSV));
  });

  return rows.map(row => row.join(',')).join('\n');
}

function generateIssuesCSV(jsonData) {
  const details = jsonData.analysis?.details || {};
  const rows = [
    ['Issue', 'Severity', 'Affected Pages', 'Example URLs']
  ];

  Object.entries(details).forEach(([issue, data]) => {
    const examples = (data.examples || []).slice(0, 5).join('; ');
    rows.push([
      issue,
      data.severity || '',
      data.examples?.length || 0,
      examples
    ].map(escapeCSV));
  });

  return rows.map(row => row.join(',')).join('\n');
}

function generatePerformanceCSV(jsonData) {
  const pages = jsonData.pageData?.pages || {};
  const rows = [
    ['URL', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Load Time (ms)']
  ];

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

  return rows.map(row => row.join(',')).join('\n');
}

function generateQuickWinsCSV(jsonData) {
  const quickWins = jsonData.analysis?.summary?.quickWins || [];
  const rows = [
    ['Priority', 'Issue', 'Severity', 'Impact', 'Effort', 'Affected Pages', 'How to Fix', 'Example URLs']
  ];

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

  return rows.map(row => row.join(',')).join('\n');
}

function generateSummaryCSV(jsonData) {
  const summary = jsonData.analysis?.summary || {};
  const score = summary.overallScore || 0;
  const grade = score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  const rows = [
    ['Metric', 'Value'],
    ['Overall SEO Score', score],
    ['Grade', grade],
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

  return rows.map(row => row.map(escapeCSV).join(',')).join('\n');
}

function generateAllCSVs(jsonFile, domainName) {
  console.log(`\n📊 Generating CSV exports for ${domainName}...\n`);

  // Use ReportDataProcessor to handle both multi-file and legacy formats
  const jsonData = ReportDataProcessor.loadAuditData(jsonFile, domainName);

  // Create CSV directory
  const csvDir = `${domainName}_csv_exports`;
  if (!fs.existsSync(csvDir)) {
    fs.mkdirSync(csvDir);
  }

  // Generate each CSV file
  const files = {
    'pages_overview.csv': generatePagesCSV(jsonData),
    'issues_breakdown.csv': generateIssuesCSV(jsonData),
    'performance_metrics.csv': generatePerformanceCSV(jsonData),
    'quick_wins.csv': generateQuickWinsCSV(jsonData),
    'summary.csv': generateSummaryCSV(jsonData)
  };

  Object.entries(files).forEach(([filename, content]) => {
    const filepath = `${csvDir}/${filename}`;
    fs.writeFileSync(filepath, content);
    const lines = content.split('\n').length - 1;
    console.log(`  ✅ ${filename.padEnd(25)} (${lines} rows)`);
  });

  console.log(`\n📁 CSV files saved to: ${csvDir}/`);
  console.log(`   You can now open these files in Excel, Google Sheets, or any CSV tool.\n`);
}

module.exports = { generateAllCSVs, escapeCSV };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node generateCSV.js <manifest-or-json-file>');
    console.error('Example: node generateCSV.js audit-results/example.com/2024-01-15_12-00-00/manifest.json.gz');
    console.error('Example: node generateCSV.js audit-results/example.com/2024-01-15_12-00-00/SEOAnalysis__example.com.json.gz');
    process.exit(1);
  }

  const jsonFile = args[0];
  if (!fs.existsSync(jsonFile)) {
    console.error(`Error: File not found: ${jsonFile}`);
    process.exit(1);
  }

  // Extract domain name from path or filename
  const basename = path.basename(jsonFile);
  let domainName;

  if (basename.startsWith('manifest')) {
    // Multi-file format: extract domain from parent directory structure
    // Path: audit-results/domain.com/timestamp/manifest.json.gz
    const parts = jsonFile.split(path.sep);
    const auditResultsIndex = parts.indexOf('audit-results');
    if (auditResultsIndex >= 0 && parts.length > auditResultsIndex + 1) {
      domainName = parts[auditResultsIndex + 1];
    } else {
      domainName = 'unknown';
    }
  } else {
    // Legacy format: extract from filename
    domainName = basename
      .replace('SEOAnalysis__', '')
      .replace('.json.gz', '')
      .replace('.json', '');
  }

  generateAllCSVs(jsonFile, domainName);
}
