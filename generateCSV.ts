import * as fs from 'fs';
import * as path from 'path';
import { ReportDataProcessor } from './lib/reports/data-processor';
import type {
  PageInfo,
  AnalysisDetail,
  QuickWin,
  AuditSummary,
  PageData,
  SitemapData,
  AnalysisData,
} from './lib/types';

/**
 * Converts audit data to CSV format for data analysis
 * Generates multiple CSV files:
 * - Pages overview with all metrics
 * - Issues breakdown by severity
 * - Performance metrics summary
 * - Quick wins list
 */

interface AuditJsonData {
  pageData?: PageData;
  analysis?: AnalysisData & { summary?: AuditSummary };
  sitemaps?: SitemapData;
  isMultiLang?: boolean;
}

function escapeCSV(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Prevent CSV formula injection (Excel/Sheets interpret =, +, -, @ as formulas)
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generatePagesCSV(jsonData: AuditJsonData) {
  const pages = jsonData.pageData?.pages ?? {};
  const rows = [
    [
      'URL',
      'Status Code',
      'Source',
      'Segment',
      'Title',
      'Title Length',
      'Description',
      'Desc Length',
      'H1 Count',
      'H2 Count',
      'Canonical',
      'Canonical Match',
      'TTFB (ms)',
      'FCP (ms)',
      'LCP (ms)',
      'CLS',
      'INP (ms)',
      'TBT (ms)',
      'Page Size (bytes)',
      'Requests',
      'Redirect Count',
      'Word Count',
      'Text/HTML %',
      'Readability',
      'Security Score',
      'Cache Score',
      'A11y Score',
      'Content Score',
      'Images Total',
      'Images Lazy',
      'Incoming Links',
      'Missing Meta Count',
      'Render Blocking',
      'Has Errors',
      'Detected Language',
      'Lang Match',
      'Internal PageRank',
      'CTAs Total',
      'CTAs Above Fold',
      'Forms',
      'JS Unused %',
      'CSS Unused %',
      'Broken Outbound Links',
      'Main Content Words',
      'Boilerplate %',
      'E-E-A-T Score',
      'Has Author',
      'Has Citations',
    ],
  ];

  Object.entries(pages).forEach(([url, _data]) => {
    // CSV export reads many dynamic analyzer-added properties on PageInfo
    const data = _data as PageInfo;
    const h1Count = Array.isArray(data.headings)
      ? (data.headings as unknown as Array<{ tag: string; count: number }>).find((h) => h.tag === 'h1')?.count ?? 0
      : data.headings?.h1?.length ?? 0;
    const h2Count = Array.isArray(data.headings)
      ? (data.headings as unknown as Array<{ tag: string; count: number }>).find((h) => h.tag === 'h2')?.count ?? 0
      : data.headings?.h2?.length ?? 0;

    rows.push(
      [
        url,
        data.status ?? data.statusCode ?? '',
        data.foundIn || 'sitemap',
        data.segment || 'other',
        data.title ?? '',
        data.title?.length ?? 0,
        data.description ?? '',
        data.description?.length ?? 0,
        h1Count,
        h2Count,
        data.canonical ?? '',
        data.canonical === url ? 'Yes' : data.canonical ? 'No' : 'Missing',
        data.TTFB ?? data.vitals?.ttfb ?? '',
        data.FCP ?? '',
        data.LCP ?? data.vitals?.lcp ?? '',
        data.CLS !== undefined ? data.CLS : data.vitals?.cls ?? '',
        data.INP ?? '',
        data.TBT ?? '',
        data.totalResponseSize ?? data.totalSize ?? '',
        data.totalNumberOfRequests ?? data.numberOfRequests ?? '',
        data.redirectCount ?? 0,
        data.contentQuality?.wordCount ?? '',
        data.contentQuality?.textToHtmlRatio ?? '',
        data.contentQuality?.readabilityScore ?? '',
        (data.security as unknown as Record<string, unknown> | undefined)?.securityScore ?? '',
        (data.caching as unknown as Record<string, unknown> | undefined)?.cacheScore ?? '',
        (data.accessibility as unknown as Record<string, unknown> | undefined)?.a11yScore ?? '',
        (data.contentQuality as unknown as Record<string, unknown> | undefined)?.contentScore ?? '',
        data.imageOptimization?.totalImages ?? '',
        data.imageOptimization?.withLazyLoading ?? '',
        data.incomingLinksCount ?? 0,
        data.missingMetaTags?.length ?? 0,
        data.resourceOptimization?.renderBlocking?.totalBlocking ?? '',
        (data.status ?? 0) >= 400 || (data.statusCode ?? 0) >= 400 ? 'Yes' : 'No',
        data.languageDetection?.detectedLanguage ?? '',
        data.languageDetection?.match != null ? (data.languageDetection.match ? 'Yes' : 'No') : '',
        data.internalPageRank != null ? data.internalPageRank.toFixed(6) : '',
        data.ctaData?.summary?.total ?? '',
        data.ctaData?.summary?.aboveFoldCount ?? '',
        data.ctaData?.summary?.forms ?? '',
        data.codeCoverage?.js?.ratio ?? '',
        data.codeCoverage?.css?.ratio ?? '',
        data.outboundLinkHealth?.broken?.length ?? '',
        (data.contentQuality as unknown as Record<string, Record<string, unknown>> | undefined)?.wordCountBySection
          ?.main ?? '',
        (data.contentQuality as unknown as Record<string, Record<string, unknown>> | undefined)?.wordCountBySection
          ?.boilerplateRatio ?? '',
        data.eeat?.score ?? '',
        data.eeat?.hasAuthor ? 'Yes' : 'No',
        data.eeat?.hasCitations ? 'Yes' : 'No',
      ].map(escapeCSV),
    );
  });

  return rows.map((row) => row.join(',')).join('\n');
}

function generateIssuesCSV(jsonData: AuditJsonData) {
  const details = jsonData.analysis?.details ?? {};
  const rows = [['Issue', 'Severity', 'Affected Pages', 'Example URLs']];

  Object.entries(details).forEach(([issue, _data]) => {
    const data = _data as AnalysisDetail;
    const examples = (data.examples || []).slice(0, 5).join('; ');
    rows.push([issue, data.severity || '', data.count || data.examples?.length || 0, examples].map(escapeCSV));
  });

  return rows.map((row) => row.join(',')).join('\n');
}

function generatePerformanceCSV(jsonData: AuditJsonData) {
  const pages = jsonData.pageData?.pages ?? {};
  const rows = [
    [
      'URL',
      'TTFB (ms)',
      'FCP (ms)',
      'LCP (ms)',
      'CLS',
      'INP (ms)',
      'TBT (ms)',
      'TTI (ms)',
      'Speed Index',
      'Page Size (MB)',
      'Requests',
      'Redirect Count',
      'LCP Bottleneck',
      'LCP Recommendation',
    ],
  ];

  Object.entries(pages).forEach(([url, _data]) => {
    const data = _data as PageInfo;
    if (data.TTFB || data.LCP || data.CLS !== undefined) {
      rows.push(
        [
          url,
          data.TTFB ?? '',
          data.FCP ?? '',
          data.LCP ?? '',
          data.CLS !== undefined ? data.CLS : '',
          data.INP ?? '',
          data.TBT ?? '',
          data.TTI ?? '',
          data.speedIndex ?? '',
          data.totalResponseSize ? (data.totalResponseSize / (1024 * 1024)).toFixed(2) : '',
          data.totalNumberOfRequests ?? '',
          data.redirectCount ?? 0,
          (data.vitals?.lcpAnalysis as Record<string, unknown> | undefined)?.bottleneck ?? '',
          (data.vitals?.lcpAnalysis as Record<string, unknown> | undefined)?.recommendation ?? '',
        ].map((v) => escapeCSV(v as string | number | boolean | null | undefined)),
      );
    }
  });

  return rows.map((row) => row.join(',')).join('\n');
}

function generateQuickWinsCSV(jsonData: AuditJsonData) {
  const quickWins = jsonData.analysis?.summary?.quickWins ?? [];
  const rows = [['Priority', 'Issue', 'Severity', 'Impact', 'Effort', 'Affected Pages', 'How to Fix', 'Example URLs']];

  quickWins.forEach((win: QuickWin & { examples?: string[]; severity?: string; fix?: string }, index: number) => {
    const examples = (win.examples ?? []).slice(0, 3).join('; ');
    rows.push(
      [
        index + 1,
        win.issue || '',
        win.severity ?? '',
        win.impact || '',
        win.effort || '',
        win.affectedPages || 0,
        win.fix ?? '',
        examples,
      ].map(escapeCSV),
    );
  });

  return rows.map((row) => row.join(',')).join('\n');
}

function generateSummaryCSV(jsonData: AuditJsonData) {
  const summary: Partial<AuditSummary> = jsonData.analysis?.summary ?? {};
  const score = summary.overallScore ?? 0;
  const grade =
    score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  const rows = [
    ['Metric', 'Value'],
    ['Overall SEO Score', score],
    ['Grade', grade],
    ['Total Issues', summary.totalIssues ?? 0],
    ['Critical Issues', summary.criticalCount ?? 0],
    ['High Issues', summary.highCount ?? 0],
    ['Medium Issues', summary.mediumCount ?? 0],
    ['Low Issues', summary.lowCount ?? 0],
    ['Pass Rate (%)', summary.passRate ?? 0],
    ['Total URLs in Sitemap', jsonData.sitemaps?.total ?? 0],
    ['Pages Crawled', jsonData.pageData?.totalWithoutError ?? 0],
    ['Pages with Errors', jsonData.pageData?.totalWithError ?? 0],
    ['Multilanguage', jsonData.isMultiLang ? 'Yes' : 'No'],
  ];

  if (summary.categoryScores) {
    rows.push(['SEO Score', summary.categoryScores.seo || 0]);
    rows.push(['Performance Score', summary.categoryScores.performance || 0]);
    rows.push(['Accessibility Score', summary.categoryScores.accessibility || 0]);
    rows.push(['Security Score', summary.categoryScores.security || 0]);
    rows.push(['Technical Score', summary.categoryScores.technical || 0]);
  }

  return rows.map((row) => row.map(escapeCSV).join(',')).join('\n');
}

function generateAllCSVs(jsonFile: string, domainName: string) {
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
    'summary.csv': generateSummaryCSV(jsonData),
  };

  Object.entries(files).forEach(([filename, content]: [string, string]) => {
    const filepath = `${csvDir}/${filename}`;
    fs.writeFileSync(filepath, content);
    const lines = content.split('\n').length - 1;
    console.log(`  ✅ ${filename.padEnd(25)} (${lines} rows)`);
  });

  console.log(`\n📁 CSV files saved to: ${csvDir}/`);
  console.log(`   You can now open these files in Excel, Google Sheets, or any CSV tool.\n`);
}

export { generateAllCSVs, escapeCSV };
// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node generateCSV.js <manifest-or-json-file>');
    console.error('Example: node generateCSV.js audit-results/example.com/2024-01-15_12-00-00/manifest.json.gz');
    console.error(
      'Example: node generateCSV.js audit-results/example.com/2024-01-15_12-00-00/SEOAnalysis__example.com.json.gz',
    );
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
    domainName = basename.replace('SEOAnalysis__', '').replace('.json.gz', '').replace('.json', '');
  }

  generateAllCSVs(jsonFile, domainName);
}
