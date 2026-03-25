/**
 * Client-side JavaScript for HTML Reports
 * Provides interactive functionality: sorting, modals, charts, CSV export
 */

import { extractAnalysis, extractSummary } from '../data-processor';
import type { PageInfo, ReportSectionData, AnalysisDetail } from '../../types';

/**
 * Safely stringify JSON for embedding in script tags
 * Escapes </script> and <!-- to prevent breaking out of script context
 * @param {*} data - Data to stringify
 * @returns {string} Safe JSON string
 */
function safeJsonStringify(data: unknown) {
  return JSON.stringify(data)
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Pre-calculate chart data to avoid embedding full jsonData in HTML
 * @param {Object} jsonData - Full audit data
 * @returns {Object} Minimal data needed for charts
 */
function calculateChartData(jsonData: Record<string, unknown>) {
  const analysisObj = extractAnalysis(jsonData);
  const summary = extractSummary(jsonData);
  const details = (analysisObj.details ?? {}) as Record<string, unknown>;
  const pages = ((jsonData.pageData as Record<string, unknown>)?.pages ?? {}) as Record<string, PageInfo>;

  // Pre-calculate top 10 issues for frequency chart
  const topIssues = Object.entries(details)
    .map(([issue, data]: [string, unknown]) => {
      const d = data as AnalysisDetail;
      return { issue, count: d.count || d.examples?.length || 0, severity: d.severity || 'MEDIUM' };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Pre-calculate performance averages
  const pagesArray = Object.values(pages) as PageInfo[];
  const pagesWithPerf = pagesArray.filter((p: PageInfo) => p.TTFB ?? p.LCP ?? p.CLS);
  const avgTTFB =
    pagesWithPerf.length > 0
      ? Math.round(pagesWithPerf.reduce((sum: number, p: PageInfo) => sum + (p.TTFB ?? 0), 0) / pagesWithPerf.length)
      : 0;
  const avgLCP =
    pagesWithPerf.length > 0
      ? Math.round(pagesWithPerf.reduce((sum: number, p: PageInfo) => sum + (p.LCP ?? 0), 0) / pagesWithPerf.length)
      : 0;
  const avgCLS =
    pagesWithPerf.length > 0
      ? (pagesWithPerf.reduce((sum: number, p: PageInfo) => sum + (p.CLS ?? 0), 0) / pagesWithPerf.length).toFixed(3)
      : 0;

  // Pre-calculate status code distribution
  const statusCodes: Record<string, number> = {};
  pagesArray.forEach((page: PageInfo) => {
    const code = page.status ?? page.statusCode;
    if (!code || isNaN(code)) return;
    const codeGroup = Math.floor(code / 100) * 100;
    const label =
      codeGroup +
      'xx (' +
      (codeGroup === 200
        ? 'Success'
        : codeGroup === 300
          ? 'Redirect'
          : codeGroup === 400
            ? 'Client Error'
            : codeGroup === 500
              ? 'Server Error'
              : 'Other') +
      ')';
    statusCodes[label] = (statusCodes[label] || 0) + 1;
  });

  // Pre-calculate word count buckets
  const wordCountBuckets = {
    'Thin (0-100)': 0,
    'Short (100-300)': 0,
    'Medium (300-600)': 0,
    'Long (600-1000)': 0,
    'Comprehensive (1000+)': 0,
  };
  pagesArray.forEach((page: PageInfo) => {
    const wordCount = page.contentQuality?.wordCount ?? 0;
    if (wordCount < 100) wordCountBuckets['Thin (0-100)']++;
    else if (wordCount < 300) wordCountBuckets['Short (100-300)']++;
    else if (wordCount < 600) wordCountBuckets['Medium (300-600)']++;
    else if (wordCount < 1000) wordCountBuckets['Long (600-1000)']++;
    else wordCountBuckets['Comprehensive (1000+)']++;
  });

  // Pre-calculate indexability breakdown
  const indexability = {
    Indexable: 0,
    Noindex: 0,
    'Redirects (3xx)': 0,
    'Client Errors (4xx)': 0,
    'Server Errors (5xx)': 0,
  };
  pagesArray.forEach((page: PageInfo) => {
    const status = page.status ?? page.statusCode ?? 200;
    if (status >= 500) {
      indexability['Server Errors (5xx)']++;
    } else if (status >= 400) {
      indexability['Client Errors (4xx)']++;
    } else if (status >= 300) {
      indexability['Redirects (3xx)']++;
    } else if (page.indexability?.hasNoindexTag || page.metaMap?.robots?.includes('noindex')) {
      indexability['Noindex']++;
    } else {
      indexability['Indexable']++;
    }
  });

  // Pre-calculate code coverage data
  const coverageData: { labels: string[]; jsUnused: number[]; cssUnused: number[] } = {
    labels: [],
    jsUnused: [],
    cssUnused: [],
  };
  const coveragePages = Object.entries(pages).filter(
    ([, p]: [string, unknown]) => (p as PageInfo).codeCoverage?.js?.ratio != null,
  );
  if (coveragePages.length > 0) {
    // Show top 10 pages by unused JS
    const sorted = coveragePages
      .sort(
        ([, a]: [string, unknown], [, b]: [string, unknown]) =>
          ((b as PageInfo).codeCoverage?.js?.ratio ?? 0) - ((a as PageInfo).codeCoverage?.js?.ratio ?? 0),
      )
      .slice(0, 10);
    sorted.forEach(([url, p]: [string, unknown]) => {
      const pg = p as PageInfo;
      try {
        coverageData.labels.push(new URL(url).pathname);
      } catch {
        coverageData.labels.push(url);
      }
      coverageData.jsUnused.push(pg.codeCoverage?.js?.ratio ?? 0);
      coverageData.cssUnused.push(pg.codeCoverage?.css?.ratio ?? 0);
    });
  }

  // Pre-calculate language distribution
  const languageDist: Record<string, number> = {};
  pagesArray.forEach((page: PageInfo) => {
    const lang = page.languageDetection?.detectedLanguage;
    if (lang) {
      languageDist[lang] = (languageDist[lang] || 0) + 1;
    }
  });

  // Pre-calculate PageRank distribution
  const pageRankBuckets: Record<string, number> = {
    'Very Low (0-10)': 0,
    'Low (10-30)': 0,
    'Medium (30-60)': 0,
    'High (60-80)': 0,
    'Very High (80-100)': 0,
  };
  pagesArray.forEach((page: PageInfo) => {
    const pr = page.internalPageRank;
    if (pr == null) return;
    const pct = pr * 100;
    if (pct < 10) pageRankBuckets['Very Low (0-10)']++;
    else if (pct < 30) pageRankBuckets['Low (10-30)']++;
    else if (pct < 60) pageRankBuckets['Medium (30-60)']++;
    else if (pct < 80) pageRankBuckets['High (60-80)']++;
    else pageRankBuckets['Very High (80-100)']++;
  });
  const hasPageRank = Object.values(pageRankBuckets).some((v) => v > 0);

  // Pre-calculate CTA distribution
  const ctaBuckets: Record<string, number> = { 'No CTAs': 0, '1 CTA': 0, '2-3 CTAs': 0, '4-5 CTAs': 0, '6+ CTAs': 0 };
  pagesArray.forEach((page: PageInfo) => {
    const total = page.ctaData?.summary?.total;
    if (total == null) return;
    if (total === 0) ctaBuckets['No CTAs']++;
    else if (total === 1) ctaBuckets['1 CTA']++;
    else if (total <= 3) ctaBuckets['2-3 CTAs']++;
    else if (total <= 5) ctaBuckets['4-5 CTAs']++;
    else ctaBuckets['6+ CTAs']++;
  });
  const hasCtaData = Object.values(ctaBuckets).some((v) => v > 0);

  return {
    summary: {
      criticalCount: summary.criticalCount ?? 0,
      highCount: summary.highCount ?? 0,
      mediumCount: summary.mediumCount ?? 0,
      lowCount: summary.lowCount ?? 0,
      overallScore: summary.overallScore ?? 0,
      totalIssues: summary.totalIssues ?? 0,
      passRate: summary.passRate ?? 0,
      categoryScores: summary.categoryScores ?? {},
      quickWins: summary.quickWins ?? [],
    },
    topIssues,
    performance: {
      avgTTFB,
      avgLCP,
      avgCLS: parseFloat(avgCLS as string),
      hasData: pagesWithPerf.length > 0,
    },
    statusCodes,
    wordCountBuckets,
    indexability,
    coverageData,
    languageDist,
    pageRankBuckets: hasPageRank ? pageRankBuckets : null,
    ctaBuckets: hasCtaData ? ctaBuckets : null,
  };
}

/**
 * Create minimal pages data for CSV export
 * @param {Object} jsonData - Full audit data
 * @returns {Array} Array of minimal page data
 */
function createPagesExportData(jsonData: Record<string, unknown>) {
  const pages = (jsonData.pageData as Record<string, unknown>)?.pages ?? {};
  return Object.entries(pages).map(([url, data]: [string, unknown]) => {
    const d = data as PageInfo;
    return {
      url,

      status: d.status ?? d.statusCode ?? '',

      title: d.title ?? '',

      description: d.description ?? '',

      h1Count:
        d.headings?.h1?.length ??
        (Array.isArray(d.headings)
          ? (d.headings.find((h: { tag: string; count?: number }) => h.tag === 'h1')?.count ?? 0)
          : 0),

      canonical: d.canonical ?? '',

      TTFB: d.TTFB ?? '',

      LCP: d.LCP ?? '',

      CLS: d.CLS ?? '',

      pageSize: d.totalResponseSize ? (d.totalResponseSize / (1024 * 1024)).toFixed(2) : '',

      requests: d.totalNumberOfRequests ?? '',

      hasErrors: (d.status ?? 0) >= 400 || d.error ? 'Yes' : 'No',

      loadTime: d.loadEvent ?? '',
    };
  });
}

/**
 * Generate the scripts section for the HTML report
 * @param {Object} data - Report data
 * @param {Object} data.pageData - Page data including incomingLinks
 * @param {Object} data.jsonData - Full JSON audit data
 * @param {Object} data.trendData - Historical trend data
 * @param {string} data.domainName - Domain name for file naming
 * @returns {string} HTML script tags with embedded JavaScript
 */
function getScripts(data: ReportSectionData) {
  const { pageData, jsonData, trendData, domainName } = data;
  const isComparison = !!data.comparison;

  // Pre-calculate chart data to avoid embedding full jsonData
  const chartData = calculateChartData(jsonData);

  // Calculate comparison chart data if in comparison mode
  const compareChartData = isComparison
    ? calculateChartData(data.comparison!.compareJsonData as Record<string, unknown>)
    : null;

  // Create minimal data for CSV exports
  const pagesExportData = createPagesExportData(jsonData);
  const comparePagesExportData = isComparison
    ? createPagesExportData(data.comparison!.compareJsonData as Record<string, unknown>)
    : null;

  // Domain labels for comparison mode
  const originLabel = isComparison ? data.comparison!.originDomainName : '';
  const compareLabel = isComparison ? data.comparison!.compareDomainName : '';

  // Extract details with limited examples for modal popups (max 100 per issue)
  const detailsForModals: Record<string, { severity: string; examples: string[] }> = {};
  const details = (jsonData.analysis as Record<string, unknown>)?.details ?? {};
  for (const [issue, data] of Object.entries(details as Record<string, unknown>)) {
    const d = data as AnalysisDetail;
    detailsForModals[issue] = {
      severity: d.severity || 'MEDIUM',
      examples: (d.examples || []).slice(0, 100),
    };
  }

  // Limit incoming links data to first 10 per page
  const limitedIncomingLinks: Record<string, string[]> = {};
  for (const [url, links] of Object.entries(pageData.incomingLinks ?? {}) as [string, string[]][]) {
    limitedIncomingLinks[url] = (links || []).slice(0, 10);
  }

  return `
      <script>
      (function() {
          // Client-side HTML escaping for XSS prevention
          function esc(str) {
              if (!str) return '';
              return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
          }

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

      // Incoming links data (limited to 10 per page)
      const incomingLinksData = ${safeJsonStringify(limitedIncomingLinks)};

      // Issue details for modal popups
      const details = ${safeJsonStringify(detailsForModals)};

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
                  'CRITICAL': 'background: var(--red-600); color: var(--color-text-inverse);',
                  'HIGH': 'background: #ea580c; color: var(--color-text-inverse);',
                  'MEDIUM': 'background: var(--color-warning); color: var(--color-text-inverse);',
                  'LOW': 'background: var(--color-info); color: white;'
              };
              const severityStyle = severityColors[severity] || 'background: var(--color-text-muted); color: var(--color-text-inverse);';

              // Build HTML content
              let html = '<div class="issue-details">';

              // Severity badge
              html += '<div style="margin-bottom: 20px;">';
              html += '<span style="' + severityStyle + ' padding: 6px 12px; border-radius: var(--radius-sm); font-weight: var(--font-weight-semibold); font-size: 14px;">';
              html += severity;
              html += '</span>';
              html += '</div>';

              // Issue description
              html += '<div class="metric-section">';
              html += '<h4>Issue Description</h4>';
              html += '<p style="color: var(--color-text-secondary); line-height: 1.6;">' + issueName + '</p>';
              html += '</div>';

              // Affected pages count
              html += '<div class="metric-section">';
              html += '<h4>Affected Pages</h4>';
              html += '<p style="font-size: var(--font-size-2xl); font-weight: var(--font-weight-semibold); color: var(--gray-800);">' + affectedPages.length + ' page(s)</p>';
              html += '</div>';

              // List of affected URLs
              if (affectedPages.length > 0) {
                  html += '<div class="metric-section">';
                  html += '<h4>Affected URLs</h4>';
                  html += '<div style="max-height: 400px; overflow-y: auto; background: var(--color-bg-page); border-radius: var(--radius-md); padding: 12px;">';

                  const maxDisplay = 100; // Show up to 100 URLs
                  const urlsToShow = affectedPages.slice(0, maxDisplay);

                  html += '<ul style="list-style: none; padding: 0; margin: 0;">';
                  urlsToShow.forEach((url, index) => {
                      html += '<li style="padding: 8px; margin: 4px 0; background: var(--color-bg-surface); border-radius: var(--radius-sm); border-left: 3px solid var(--color-info);">';
                      html += '<span style="color: var(--color-text-disabled); font-size: var(--font-size-xs); margin-right: 8px;">' + (index + 1) + '.</span>';
                      html += '<a href="' + esc(url) + '" target="_blank" style="color: var(--color-link); text-decoration: none; word-break: break-all; font-size: var(--font-size-sm);">' + esc(url) + '</a>';
                      html += '</li>';
                  });
                  html += '</ul>';

                  if (affectedPages.length > maxDisplay) {
                      html += '<p style="color: var(--color-text-muted); font-size: var(--font-size-xs); margin-top: 12px; text-align: center;">... and ' + (affectedPages.length - maxDisplay) + ' more page(s)</p>';
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
                  html += '<div style="font-weight: var(--font-weight-semibold);">Good</div>';
                  html += '<div>' + metricData.good + '</div>';
                  html += '</div>';
                  html += '<div class="threshold-item threshold-warning">';
                  html += '<div style="font-weight: var(--font-weight-semibold);">Warning</div>';
                  html += '<div>' + metricData.warning + '</div>';
                  html += '</div>';
                  html += '<div class="threshold-item threshold-bad">';
                  html += '<div style="font-weight: var(--font-weight-semibold);">Bad</div>';
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

          // Focus trap in modal
          modal.addEventListener('keydown', function(e) {
              if (e.key === 'Tab' && modal.classList.contains('active')) {
                  var focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                  if (focusable.length === 0) return;
                  var first = focusable[0];
                  var last = focusable[focusable.length - 1];
                  if (e.shiftKey && document.activeElement === first) {
                      e.preventDefault();
                      last.focus();
                  } else if (!e.shiftKey && document.activeElement === last) {
                      e.preventDefault();
                      first.focus();
                  }
              }
          });

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

          // Add click handlers to pages table cells with title attribute (not other tables)
          document.querySelectorAll('#pagesTable td[title]:not([title=""])').forEach(cell => {
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
                  .replace(/\\s*\\(.*?\\)\\s*/g, '') // Remove anything in parentheses
                  .replace(/\\s*ms\\s*/gi, '')      // Remove "ms"
                  .replace(/\\s*chars?\\s*/gi, '')  // Remove "char" or "chars"
                  .replace(/\\s*score\\s*/gi, ' Score') // Normalize "score"
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
              const count = parseInt(cell.getAttribute('data-count'), 10) || 0;
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
                      html += '<div style="padding: 8px; margin: 4px 0; background: var(--color-bg-page); border-radius: var(--radius-sm); font-size: var(--font-size-xs); word-break: break-all;">';
                      html += '<span style="color: var(--color-text-disabled); margin-right: 8px;">' + (index + 1) + '.</span>';
                      html += '<a href="' + esc(link) + '" target="_blank" style="color: var(--color-link);">' + esc(link) + '</a>';
                      html += '</div>';
                  });
                  html += '</div>';
                  html += '</div>';

                  showModal('Incoming Links (' + incomingLinks.length + ')', pageUrl, html, true);
              });
          });
      })();

      // Comparison mode data
      const isComparison = ${isComparison};
      const compareChartData = ${safeJsonStringify(compareChartData)};
      const originLabel = ${safeJsonStringify(originLabel)};
      const compareLabel = ${safeJsonStringify(compareLabel)};

      // Comparison pages table filter
      function filterCompareTable(type, btn) {
          if (!btn) return;
          var parent = btn.parentElement;
          if (parent) {
              parent.querySelectorAll('.sev-pill').forEach(function(b) { b.classList.remove('active'); });
          }
          btn.classList.add('active');
          var table = document.getElementById('comparisonPagesTable') || document.getElementById('pagesTable');
          if (!table) return;
          var rows = table.querySelectorAll('tbody tr');
          rows.forEach(function(row) {
              var rowType = row.getAttribute('data-compare-type') || 'matched';
              if (type === 'all') {
                  row.style.display = '';
              } else {
                  row.style.display = rowType === type ? '' : 'none';
              }
          });
      }

      // Initialize Charts
      (function initCharts() {
          // Use pre-calculated chart data instead of full jsonData
          const chartData = ${safeJsonStringify(chartData)};
          const summary = chartData.summary;
          const trendData = ${safeJsonStringify(trendData)};

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

              // Issue Trends Sparkline Charts
              initSparklineCharts(trendData);
          }

          // Initialize sparkline charts for issue trends
          function initSparklineCharts(trendData) {
              const sparklineCanvases = document.querySelectorAll('canvas[id^="sparkline-"]');
              if (!sparklineCanvases.length) return;

              sparklineCanvases.forEach(canvas => {
                  const countsStr = canvas.getAttribute('data-counts');
                  if (!countsStr) return;

                  const counts = countsStr.split(',').map(Number);
                  const labels = trendData.labels || counts.map((_, i) => '');

                  // Determine color based on trend
                  const firstVal = counts.find(c => c > 0) || 0;
                  const lastVal = counts[counts.length - 1] || 0;
                  let lineColor = 'var(--color-text-muted)'; // stable - gray
                  if (lastVal < firstVal * 0.8) {
                      lineColor = 'var(--color-success)'; // improving - green
                  } else if (lastVal > firstVal * 1.2) {
                      lineColor = 'var(--color-error)'; // worsening - red
                  }

                  new Chart(canvas, {
                      type: 'line',
                      data: {
                          labels: labels,
                          datasets: [{
                              data: counts,
                              borderColor: lineColor,
                              backgroundColor: 'transparent',
                              borderWidth: 2,
                              fill: false,
                              tension: 0.3,
                              pointRadius: 0,
                              pointHoverRadius: 3
                          }]
                      },
                      options: {
                          responsive: false,
                          maintainAspectRatio: false,
                          plugins: {
                              legend: { display: false },
                              tooltip: {
                                  enabled: true,
                                  mode: 'index',
                                  intersect: false,
                                  callbacks: {
                                      title: function(context) {
                                          return context[0].label || '';
                                      },
                                      label: function(context) {
                                          return context.parsed.y + ' pages';
                                      }
                                  }
                              }
                          },
                          scales: {
                              x: { display: false },
                              y: { display: false, beginAtZero: true }
                          },
                          interaction: {
                              mode: 'nearest',
                              axis: 'x',
                              intersect: false
                          }
                      }
                  });
              });
          }

          // Chart 1: Issue Distribution by Severity
          const issueCtx = document.getElementById('issueChart');
          if (issueCtx) {
              const issueDatasets = [{
                  label: isComparison ? originLabel : 'Issues',
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
              }];
              if (isComparison && compareChartData) {
                  const cs = compareChartData.summary;
                  issueDatasets.push({
                      label: compareLabel,
                      data: [
                          cs.criticalCount || 0,
                          cs.highCount || 0,
                          cs.mediumCount || 0,
                          cs.lowCount || 0
                      ],
                      backgroundColor: [
                          'rgba(239,68,68,0.5)',
                          'rgba(245,158,11,0.5)',
                          'rgba(59,130,246,0.5)',
                          'rgba(107,114,128,0.5)'
                      ],
                      borderWidth: 2,
                      borderColor: '#fff'
                  });
              }
              new Chart(issueCtx, {
                  type: isComparison ? 'bar' : 'doughnut',
                  data: {
                      labels: ['Critical', 'High', 'Medium', 'Low'],
                      datasets: issueDatasets
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
                                      const dsLabel = context.dataset.label || context.label || '';
                                      const value = typeof context.parsed === 'object' ? context.parsed.y : context.parsed;
                                      const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                      return dsLabel + ': ' + value + ' (' + percentage + '%)';
                                  }
                              }
                          }
                      }
                  }
              });
          }

          // Chart 2: Top 10 Issues by Frequency (pre-calculated)
          const topIssues = chartData.topIssues;

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

          // Chart 3: Performance Metrics Distribution (pre-calculated)
          const performanceCtx = document.getElementById('performanceChart');
          if (performanceCtx && chartData.performance.hasData) {
              const perfDatasets = [{
                  label: isComparison ? originLabel : 'Average Value',
                  data: [chartData.performance.avgTTFB, chartData.performance.avgLCP, (chartData.performance.avgCLS * 100).toFixed(1)],
                  backgroundColor: isComparison ? 'rgba(59, 130, 246, 0.7)' : ['#8b5cf6', '#ec4899', '#14b8a6'],
                  borderColor: isComparison ? '#2563eb' : ['#7c3aed', '#db2777', '#0d9488'],
                  borderWidth: 2
              }];
              if (isComparison && compareChartData && compareChartData.performance.hasData) {
                  perfDatasets.push({
                      label: compareLabel,
                      data: [compareChartData.performance.avgTTFB, compareChartData.performance.avgLCP, (compareChartData.performance.avgCLS * 100).toFixed(1)],
                      backgroundColor: 'rgba(249, 115, 22, 0.7)',
                      borderColor: '#ea580c',
                      borderWidth: 2
                  });
              }
              new Chart(performanceCtx, {
                  type: 'bar',
                  data: {
                      labels: ['TTFB (ms)', 'LCP (ms)', 'CLS (×100)'],
                      datasets: perfDatasets
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { display: isComparison, position: 'bottom' },
                          tooltip: {
                              callbacks: {
                                  label: function(context) {
                                      let label = context.dataset.label || context.label || '';
                                      let value = context.parsed.y;
                                      if (context.label && context.label.includes('CLS')) {
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

          // Chart 4: Pages by Status Code (pre-calculated)
          const statusCodes = chartData.statusCodes;

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

          // Chart 5: Word Count Distribution (pre-calculated)
          const wordCountBuckets = chartData.wordCountBuckets;

          const wordCountCtx = document.getElementById('wordCountChart');
          if (wordCountCtx) {
              const wcDatasets = [{
                  label: isComparison ? originLabel : 'Pages',
                  data: Object.values(wordCountBuckets),
                  backgroundColor: isComparison ? 'rgba(59, 130, 246, 0.7)' : ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'],
                  borderColor: isComparison ? '#2563eb' : ['#dc2626', '#d97706', '#059669', '#2563eb', '#7c3aed'],
                  borderWidth: 2
              }];
              if (isComparison && compareChartData) {
                  wcDatasets.push({
                      label: compareLabel,
                      data: Object.values(compareChartData.wordCountBuckets),
                      backgroundColor: 'rgba(249, 115, 22, 0.7)',
                      borderColor: '#ea580c',
                      borderWidth: 2
                  });
              }
              new Chart(wordCountCtx, {
                  type: 'bar',
                  data: {
                      labels: Object.keys(wordCountBuckets),
                      datasets: wcDatasets
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { display: isComparison, position: 'bottom' },
                          tooltip: {
                              callbacks: {
                                  label: function(context) {
                                      const value = context.parsed.y || 0;
                                      const dsLabel = context.dataset.label || '';
                                      return dsLabel + ': ' + value + ' pages';
                                  }
                              }
                          }
                      },
                      scales: {
                          y: {
                              beginAtZero: true,
                              title: { display: true, text: 'Number of Pages' }
                          }
                      }
                  }
              });
          }

          // Chart 6: Indexability Breakdown (pre-calculated)
          const indexability = chartData.indexability;

          const indexabilityCtx = document.getElementById('indexabilityChart');
          if (indexabilityCtx) {
              new Chart(indexabilityCtx, {
                  type: 'doughnut',
                  data: {
                      labels: Object.keys(indexability),
                      datasets: [{
                          data: Object.values(indexability),
                          backgroundColor: [
                              '#10b981',
                              '#6b7280',
                              '#3b82f6',
                              '#f59e0b',
                              '#ef4444'
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
                              labels: { padding: 15, font: { size: 11 } }
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
          // Chart 7: Code Coverage (JS/CSS Unused %)
          const coverageData = chartData.coverageData;
          const coverageCtx = document.getElementById('coverageChart');
          if (coverageCtx && coverageData.labels.length > 0) {
              new Chart(coverageCtx, {
                  type: 'bar',
                  data: {
                      labels: coverageData.labels,
                      datasets: [
                          {
                              label: 'Unused JS %',
                              data: coverageData.jsUnused,
                              backgroundColor: 'rgba(251, 191, 36, 0.7)',
                              borderColor: 'rgba(251, 191, 36, 1)',
                              borderWidth: 1
                          },
                          {
                              label: 'Unused CSS %',
                              data: coverageData.cssUnused,
                              backgroundColor: 'rgba(147, 51, 234, 0.7)',
                              borderColor: 'rgba(147, 51, 234, 1)',
                              borderWidth: 1
                          }
                      ]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      indexAxis: 'y',
                      scales: {
                          x: {
                              max: 100,
                              title: { display: true, text: 'Unused %' }
                          }
                      },
                      plugins: {
                          legend: { position: 'bottom' }
                      }
                  }
              });
          } else if (coverageCtx) {
              coverageCtx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-disabled);font-size:var(--font-size-sm);">No code coverage data (enable --perf)</div>';
          }

          // Chart 8: Language Distribution
          const languageDist = chartData.languageDist;
          const langCtx = document.getElementById('languageChart');
          if (langCtx && Object.keys(languageDist).length > 0) {
              const langColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
              new Chart(langCtx, {
                  type: 'doughnut',
                  data: {
                      labels: Object.keys(languageDist),
                      datasets: [{
                          data: Object.values(languageDist),
                          backgroundColor: langColors.slice(0, Object.keys(languageDist).length),
                          borderWidth: 2,
                          borderColor: '#fff'
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { position: 'bottom', labels: { padding: 15, font: { size: 11 } } }
                      }
                  }
              });
          } else if (langCtx) {
              langCtx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-disabled);font-size:var(--font-size-sm);">No language detection data</div>';
          }

          // Chart 9: PageRank Distribution
          const pageRankCtx = document.getElementById('pageRankChart');
          if (pageRankCtx && chartData.pageRankBuckets) {
              const prBuckets = chartData.pageRankBuckets;
              new Chart(pageRankCtx, {
                  type: 'bar',
                  data: {
                      labels: Object.keys(prBuckets),
                      datasets: [{
                          label: 'Pages',
                          data: Object.values(prBuckets),
                          backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'],
                          borderWidth: 1,
                          borderColor: '#fff'
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { display: false }
                      },
                      scales: {
                          y: { beginAtZero: true, title: { display: true, text: 'Pages' } }
                      }
                  }
              });
          } else if (pageRankCtx) {
              pageRankCtx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-disabled);font-size:var(--font-size-sm);">No PageRank data</div>';
          }

          // Chart 10: CTA Distribution
          const ctaCtx = document.getElementById('ctaChart');
          if (ctaCtx && chartData.ctaBuckets) {
              const ctaB = chartData.ctaBuckets;
              new Chart(ctaCtx, {
                  type: 'doughnut',
                  data: {
                      labels: Object.keys(ctaB),
                      datasets: [{
                          data: Object.values(ctaB),
                          backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'],
                          borderWidth: 2,
                          borderColor: '#fff'
                      }]
                  },
                  options: {
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                          legend: { position: 'bottom', labels: { padding: 15, font: { size: 11 } } }
                      }
                  }
              });
          } else if (ctaCtx) {
              ctaCtx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-disabled);font-size:var(--font-size-sm);">No CTA data</div>';
          }
      })();

      // Table Sorting Functionality — delegates to tableManager
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

                  // Delegate to tableManager for global sort
                  if (tableManager) {
                      tableManager.sort(columnIndex, currentSort.ascending, dataType);
                  }
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
          // Use pre-calculated minimal data instead of full jsonData
          const pagesExportData = ${safeJsonStringify(pagesExportData)};
          const comparePagesExportData = ${safeJsonStringify(comparePagesExportData)};
          const summaryData = ${safeJsonStringify(chartData.summary)};
          const compareSummaryData = ${safeJsonStringify(compareChartData?.summary ?? null)};
          let content = '';
          let filename = '';

          if (type === 'pages') {
              filename = '${domainName}_pages_overview.csv';
              if (isComparison) {
                  const rows = [['Site', 'URL', 'Status Code', 'Title', 'Description', 'H1 Count', 'Canonical', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Has Errors']];
                  pagesExportData.forEach(data => {
                      rows.push([originLabel, data.url, data.status, data.title, data.description, data.h1Count, data.canonical, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.hasErrors].map(escapeCSV));
                  });
                  if (comparePagesExportData) {
                      comparePagesExportData.forEach(data => {
                          rows.push([compareLabel, data.url, data.status, data.title, data.description, data.h1Count, data.canonical, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.hasErrors].map(escapeCSV));
                      });
                  }
                  content = rows.map(row => row.join(',')).join('\\n');
              } else {
                  const rows = [['URL', 'Status Code', 'Title', 'Description', 'H1 Count', 'Canonical', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Has Errors']];
                  pagesExportData.forEach(data => {
                      rows.push([data.url, data.status, data.title, data.description, data.h1Count, data.canonical, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.hasErrors].map(escapeCSV));
                  });
                  content = rows.map(row => row.join(',')).join('\\n');
              }
          }
          else if (type === 'issues') {
              filename = '${domainName}_issues_breakdown.csv';
              const rows = [['Issue', 'Severity', 'Affected Pages', 'Example URLs']];

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
              if (isComparison) {
                  const rows = [['Site', 'URL', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Load Time (ms)']];
                  pagesExportData.forEach(data => {
                      if (data.TTFB || data.LCP || data.CLS) {
                          rows.push([originLabel, data.url, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.loadTime].map(escapeCSV));
                      }
                  });
                  if (comparePagesExportData) {
                      comparePagesExportData.forEach(data => {
                          if (data.TTFB || data.LCP || data.CLS) {
                              rows.push([compareLabel, data.url, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.loadTime].map(escapeCSV));
                          }
                      });
                  }
                  content = rows.map(row => row.join(',')).join('\\n');
              } else {
                  const rows = [['URL', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Load Time (ms)']];
                  pagesExportData.forEach(data => {
                      if (data.TTFB || data.LCP || data.CLS) {
                          rows.push([data.url, data.TTFB, data.LCP, data.CLS, data.pageSize, data.requests, data.loadTime].map(escapeCSV));
                      }
                  });
                  content = rows.map(row => row.join(',')).join('\\n');
              }
          }
          else if (type === 'quickwins') {
              filename = '${domainName}_quick_wins.csv';
              const rows = [['Priority', 'Issue', 'Severity', 'Impact', 'Effort', 'Affected Pages', 'How to Fix', 'Example URLs']];
              const quickWins = summaryData.quickWins || [];

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
              if (isComparison && compareSummaryData) {
                  const rows = [
                      ['Metric', originLabel, compareLabel, 'Delta'],
                      ['Overall SEO Score', summaryData.overallScore || 0, compareSummaryData.overallScore || 0, (summaryData.overallScore || 0) - (compareSummaryData.overallScore || 0)],
                      ['Total Issues', summaryData.totalIssues || 0, compareSummaryData.totalIssues || 0, (summaryData.totalIssues || 0) - (compareSummaryData.totalIssues || 0)],
                      ['Critical Issues', summaryData.criticalCount || 0, compareSummaryData.criticalCount || 0, (summaryData.criticalCount || 0) - (compareSummaryData.criticalCount || 0)],
                      ['High Issues', summaryData.highCount || 0, compareSummaryData.highCount || 0, (summaryData.highCount || 0) - (compareSummaryData.highCount || 0)],
                      ['Medium Issues', summaryData.mediumCount || 0, compareSummaryData.mediumCount || 0, (summaryData.mediumCount || 0) - (compareSummaryData.mediumCount || 0)],
                      ['Low Issues', summaryData.lowCount || 0, compareSummaryData.lowCount || 0, (summaryData.lowCount || 0) - (compareSummaryData.lowCount || 0)],
                      ['Pass Rate (%)', summaryData.passRate || 0, compareSummaryData.passRate || 0, (summaryData.passRate || 0) - (compareSummaryData.passRate || 0)],
                      ['Total Pages', pagesExportData.length, comparePagesExportData ? comparePagesExportData.length : 0, '']
                  ];
                  if (summaryData.categoryScores) {
                      const cs = compareSummaryData.categoryScores || {};
                      rows.push(['SEO Score', summaryData.categoryScores.seo || 0, cs.seo || 0, (summaryData.categoryScores.seo || 0) - (cs.seo || 0)]);
                      rows.push(['Performance Score', summaryData.categoryScores.performance || 0, cs.performance || 0, (summaryData.categoryScores.performance || 0) - (cs.performance || 0)]);
                      rows.push(['Accessibility Score', summaryData.categoryScores.accessibility || 0, cs.accessibility || 0, (summaryData.categoryScores.accessibility || 0) - (cs.accessibility || 0)]);
                      rows.push(['Security Score', summaryData.categoryScores.security || 0, cs.security || 0, (summaryData.categoryScores.security || 0) - (cs.security || 0)]);
                      rows.push(['Technical Score', summaryData.categoryScores.technical || 0, cs.technical || 0, (summaryData.categoryScores.technical || 0) - (cs.technical || 0)]);
                  }
                  content = rows.map(row => row.map(escapeCSV).join(',')).join('\\n');
              } else {
                  const rows = [
                      ['Metric', 'Value'],
                      ['Overall SEO Score', summaryData.overallScore || 0],
                      ['Total Issues', summaryData.totalIssues || 0],
                      ['Critical Issues', summaryData.criticalCount || 0],
                      ['High Issues', summaryData.highCount || 0],
                      ['Medium Issues', summaryData.mediumCount || 0],
                      ['Low Issues', summaryData.lowCount || 0],
                      ['Pass Rate (%)', summaryData.passRate || 0],
                      ['Total Pages', pagesExportData.length]
                  ];
                  if (summaryData.categoryScores) {
                      rows.push(['SEO Score', summaryData.categoryScores.seo || 0]);
                      rows.push(['Performance Score', summaryData.categoryScores.performance || 0]);
                      rows.push(['Accessibility Score', summaryData.categoryScores.accessibility || 0]);
                      rows.push(['Security Score', summaryData.categoryScores.security || 0]);
                      rows.push(['Technical Score', summaryData.categoryScores.technical || 0]);
                  }
                  content = rows.map(row => row.map(escapeCSV).join(',')).join('\\n');
              }
          }

          if (content) {
              downloadCSV(filename, content);
          }
      }

      // Export all formats at once
      function exportAll() {
          exportCSV('summary');
          setTimeout(function() { exportCSV('pages'); }, 200);
          setTimeout(function() { exportCSV('issues'); }, 400);
          setTimeout(function() { exportCSV('performance'); }, 600);
          setTimeout(function() { exportMarkdown(); }, 800);
      }

      // Copy score summary to clipboard
      function copyScoreSummary() {
          var summary = ${safeJsonStringify(chartData.summary)};
          var text = 'SEO Audit: ${domainName}\\n' +
              'Score: ' + (summary.overallScore || 0) + '/100\\n' +
              'Issues: ' + (summary.totalIssues || 0) + ' (' +
              (summary.criticalCount || 0) + ' critical, ' +
              (summary.highCount || 0) + ' high)\\n' +
              'Date: ' + new Date().toLocaleDateString();

          if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(function() {
                  var toast = document.querySelector('.copy-toast');
                  if (toast) {
                      toast.textContent = 'Summary copied!';
                      toast.classList.add('visible');
                      setTimeout(function() { toast.classList.remove('visible'); }, 2000);
                  }
              });
          }
      }

      // Export as Markdown
      function exportMarkdown() {
          var summary = ${safeJsonStringify(chartData.summary)};
          var lines = [];
          lines.push('# SEO Audit Report - ${domainName}');
          lines.push('');
          lines.push('Generated: ' + new Date().toLocaleString());
          lines.push('');
          lines.push('## Score: ' + (summary.overallScore || 0) + '/100');
          lines.push('');
          if (summary.categoryScores) {
              lines.push('### Category Scores');
              lines.push('| Category | Score |');
              lines.push('|----------|-------|');
              Object.entries(summary.categoryScores).forEach(function(e) {
                  lines.push('| ' + e[0].charAt(0).toUpperCase() + e[0].slice(1) + ' | ' + e[1] + '/100 |');
              });
              lines.push('');
          }
          lines.push('### Issues');
          lines.push('| Severity | Count |');
          lines.push('|----------|-------|');
          lines.push('| Critical | ' + (summary.criticalCount || 0) + ' |');
          lines.push('| High | ' + (summary.highCount || 0) + ' |');
          lines.push('| Medium | ' + (summary.mediumCount || 0) + ' |');
          lines.push('| Low | ' + (summary.lowCount || 0) + ' |');
          lines.push('| **Total** | **' + (summary.totalIssues || 0) + '** |');
          lines.push('');

          if (summary.quickWins && summary.quickWins.length > 0) {
              lines.push('### Quick Wins');
              summary.quickWins.forEach(function(w, i) {
                  lines.push((i + 1) + '. **' + (w.issue || '') + '** (' + (w.affectedPages || 0) + ' pages) - ' + (w.fix || ''));
              });
              lines.push('');
          }

          var blob = new Blob([lines.join('\\n')], { type: 'text/markdown' });
          var link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = '${domainName}_audit.md';
          link.click();
      }

      // Issue Filter Modal Functions
      function showIssueFilterModal() {
          const modal = document.getElementById('issueFilterModal');
          if (modal) {
              modal.style.display = 'flex';
          }
      }

      function hideIssueFilterModal() {
          const modal = document.getElementById('issueFilterModal');
          if (modal) {
              modal.style.display = 'none';
          }
      }

      function exportFilteredIssues() {
          // Use the pre-loaded details object

          // Get filter values
          const includeCritical = document.getElementById('filterCritical')?.checked ?? true;
          const includeHigh = document.getElementById('filterHigh')?.checked ?? true;
          const includeMedium = document.getElementById('filterMedium')?.checked ?? true;
          const includeLow = document.getElementById('filterLow')?.checked ?? true;
          const minPages = parseInt(document.getElementById('filterMinPages')?.value || '1', 10);

          const selectedSeverities = [];
          if (includeCritical) selectedSeverities.push('critical');
          if (includeHigh) selectedSeverities.push('high');
          if (includeMedium) selectedSeverities.push('medium');
          if (includeLow) selectedSeverities.push('low');

          const rows = [['Issue', 'Severity', 'Affected Pages', 'Example URLs']];

          Object.entries(details).forEach(([issue, data]) => {
              const severity = data.severity || 'medium';
              const affectedCount = data.examples?.length || 0;

              // Apply filters
              if (!selectedSeverities.includes(severity)) return;
              if (affectedCount < minPages) return;

              const examples = (data.examples || []).slice(0, 5).join('; ');
              rows.push([
                  issue,
                  severity,
                  affectedCount,
                  examples
              ].map(escapeCSV));
          });

          const content = rows.map(row => row.join(',')).join('\\n');
          downloadCSV('${domainName}_issues_filtered.csv', content);

          // Close modal
          hideIssueFilterModal();
      }

      // Close modal on outside click
      document.getElementById('issueFilterModal')?.addEventListener('click', function(e) {
          if (e.target === this) {
              hideIssueFilterModal();
          }
      });

      // === Centralized Table Manager ===
      // All filtering, sorting, presets, and pagination go through this single manager
      // so they work together globally instead of fighting each other.
      var tableManager = (function() {
          var table = document.getElementById('pagesTable');
          if (!table) return null;
          var tbody = table.querySelector('tbody');
          if (!tbody) return null;

          var allRows = Array.from(tbody.querySelectorAll('tr'));
          var filteredRows = allRows.slice(); // Rows that pass current filters
          var PAGE_SIZE = 100;
          var currentPage = 1;
          var searchFilter = '';
          var segmentFilter = '';
          var presetFilter = null; // function or null
          var pagContainer = null;

          // Cache row data for fast filtering
          var rowData = allRows.map(function(row) {
              return {
                  row: row,
                  keywords: (row.getAttribute('data-keywords') || '').toLowerCase(),
                  title: (row.getAttribute('data-title') || '').toLowerCase(),
                  url: (row.querySelector('a')?.href || '').toLowerCase(),
                  urlText: (row.querySelector('a')?.textContent || '').toLowerCase(),
                  segment: (row.getAttribute('data-segment') || '').toLowerCase(),
              };
          });

          function applyFilters() {
              filteredRows = [];
              for (var i = 0; i < rowData.length; i++) {
                  var d = rowData[i];
                  var show = true;

                  // Search filter
                  if (searchFilter) {
                      show = d.url.includes(searchFilter) ||
                             d.urlText.includes(searchFilter) ||
                             d.title.includes(searchFilter) ||
                             d.keywords.includes(searchFilter);
                  }

                  // Segment filter
                  if (show && segmentFilter) {
                      show = d.segment === segmentFilter;
                  }

                  // Preset filter
                  if (show && presetFilter) {
                      show = presetFilter(d.row);
                  }

                  if (show) filteredRows.push(d.row);
              }

              currentPage = 1;
              render();
          }

          function render() {
              var totalFiltered = filteredRows.length;
              var totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
              if (currentPage > totalPages) currentPage = totalPages;

              var start = (currentPage - 1) * PAGE_SIZE;
              var end = start + PAGE_SIZE;

              // Hide all rows, then show only current page of filtered rows
              for (var i = 0; i < allRows.length; i++) {
                  allRows[i].style.display = 'none';
              }
              for (var i = 0; i < filteredRows.length; i++) {
                  filteredRows[i].style.display = (i >= start && i < end) ? '' : 'none';
              }

              // Update row numbers for visible rows
              for (var i = 0; i < filteredRows.length; i++) {
                  var numCell = filteredRows[i].cells[0];
                  if (numCell) numCell.textContent = i + 1;
              }

              // Update filter count
              var fc = document.getElementById('filterCount');
              if (fc) {
                  if (searchFilter || segmentFilter || presetFilter) {
                      var showEnd = Math.min(end, totalFiltered);
                      fc.textContent = 'Showing ' + (start + 1) + '-' + showEnd + ' of ' + totalFiltered + ' matched (' + allRows.length + ' total)';
                  } else if (totalFiltered > PAGE_SIZE) {
                      var showEnd = Math.min(end, totalFiltered);
                      fc.textContent = 'Showing ' + (start + 1) + '-' + showEnd + ' of ' + totalFiltered + ' pages';
                  } else {
                      fc.textContent = '';
                  }
              }

              // Update pagination
              renderPagination(totalPages);
          }

          function renderPagination(totalPages) {
              if (!pagContainer) {
                  if (allRows.length <= PAGE_SIZE) return;
                  pagContainer = document.createElement('div');
                  pagContainer.className = 'pagination';
                  table.parentNode.insertBefore(pagContainer, table.nextSibling);
                  pagContainer.addEventListener('click', function(e) {
                      var btn = e.target.closest('button');
                      if (!btn || btn.disabled) return;
                      currentPage = parseInt(btn.dataset.page, 10);
                      render();
                      table.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  });
              }

              if (totalPages <= 1) {
                  pagContainer.style.display = 'none';
                  return;
              }
              pagContainer.style.display = '';

              var html = '';
              html += '<button ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">&laquo; Prev</button>';
              var startPage = Math.max(1, currentPage - 2);
              var endPage = Math.min(totalPages, startPage + 4);
              startPage = Math.max(1, endPage - 4);
              for (var p = startPage; p <= endPage; p++) {
                  html += '<button class="' + (p === currentPage ? 'active' : '') + '" data-page="' + p + '">' + p + '</button>';
              }
              html += '<span class="page-info">' + filteredRows.length + ' pages</span>';
              html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">Next &raquo;</button>';
              pagContainer.innerHTML = html;
          }

          function sortRows(columnIndex, ascending, dataType) {
              filteredRows.sort(function(a, b) {
                  var aCell = a.cells[columnIndex];
                  var bCell = b.cells[columnIndex];
                  var aVal = aCell ? aCell.textContent.trim() : '';
                  var bVal = bCell ? bCell.textContent.trim() : '';

                  if (dataType === 'number') {
                      aVal = parseFloat(aVal.replace(/[^0-9.-]/g, '')) || 0;
                      bVal = parseFloat(bVal.replace(/[^0-9.-]/g, '')) || 0;
                      return ascending ? aVal - bVal : bVal - aVal;
                  }
                  var cmp = aVal.localeCompare(bVal);
                  return ascending ? cmp : -cmp;
              });

              // Also sort allRows to keep in-DOM order consistent
              filteredRows.forEach(function(row) { tbody.appendChild(row); });
              currentPage = 1;
              render();
          }

          return {
              setSearch: function(q) { searchFilter = q.toLowerCase().trim(); applyFilters(); },
              setSegment: function(s) { segmentFilter = s.toLowerCase().trim(); applyFilters(); },
              setPreset: function(fn) { presetFilter = fn; applyFilters(); },
              clearAll: function() {
                  searchFilter = '';
                  segmentFilter = '';
                  presetFilter = null;
                  var el = document.getElementById('pageSearch');
                  if (el) el.value = '';
                  el = document.getElementById('segmentFilter');
                  if (el) el.value = '';
                  applyFilters();
              },
              sort: sortRows,
              render: render,
              getFilteredRows: function() { return filteredRows; },
              getAllRows: function() { return allRows; },
              init: function() { render(); },
          };
      })();

      // Public filter functions called from HTML onkeyup/onchange
      function filterTableBySearch(query) {
          if (tableManager) tableManager.setSearch(query);
      }
      function filterTableBySegment(segment) {
          if (tableManager) tableManager.setSegment(segment);
      }
      function clearTableFilters() {
          if (tableManager) tableManager.clearAll();
      }
      // Legacy compat for preset buttons
      function applyTableFilters() {
          if (tableManager) tableManager.render();
      }

      // Save to PDF function — expand all content and convert charts before printing
      let _printState = null;

      function _prepareForPrint() {
          if (_printState) return; // prevent double-preparation
          _printState = { collapsed: [], hiddenExamples: [], tableRows: [], paginationEls: [], canvasImages: [], details: [] };

          // Add PDF mode class for dedicated styling
          document.body.classList.add('pdf-mode');

          // 1. Convert all canvas charts to static images (canvas is blank in PDF)
          document.querySelectorAll('.chart-container canvas, .chart-card canvas').forEach(canvas => {
              try {
                  var img = document.createElement('img');
                  img.src = canvas.toDataURL('image/png', 1.0);
                  img.style.width = '100%';
                  img.style.height = 'auto';
                  img.style.maxHeight = canvas.style.height || '300px';
                  img.className = 'pdf-chart-img';
                  canvas.style.display = 'none';
                  canvas.parentNode.insertBefore(img, canvas.nextSibling);
                  _printState.canvasImages.push({ canvas: canvas, img: img });
              } catch (e) {
                  // Canvas tainted or unavailable — skip silently
              }
          });

          // 2. Expand all collapsed sections
          document.querySelectorAll('.section-content.collapsed').forEach(el => {
              _printState.collapsed.push({ el: el, type: 'content' });
              el.classList.remove('collapsed');
              el.style.maxHeight = 'none';
          });
          document.querySelectorAll('.section-toggle.collapsed').forEach(el => {
              el.classList.remove('collapsed');
              _printState.collapsed.push({ el: el, type: 'toggle' });
          });

          // 3. Show all hidden issue examples
          document.querySelectorAll('[id^="issue-more-"]').forEach(el => {
              if (el.style.display === 'none' || !el.style.display) {
                  _printState.hiddenExamples.push({ el: el, prev: el.style.display });
                  el.style.display = 'block';
              }
          });

          // 4. Show all table rows (remove pagination)
          document.querySelectorAll('tr[style*="display: none"], tr[style*="display:none"]').forEach(el => {
              _printState.tableRows.push({ el: el, prev: el.style.display });
              el.style.display = '';
          });

          // 5. Hide pagination controls, "show more" buttons, and interactive elements
          document.querySelectorAll('.issue-toggle-btn, .pagination-controls, .table-pagination, .show-more-btn').forEach(el => {
              _printState.paginationEls.push({ el: el, prev: el.style.display });
              el.style.display = 'none';
          });

          // 6. Expand all <details> elements
          document.querySelectorAll('details:not([open])').forEach(el => {
              _printState.details.push(el);
              el.setAttribute('open', '');
          });

          // 7. Set print date
          var footer = document.querySelector('footer');
          if (footer) {
              footer.setAttribute('data-print-date', new Date().toLocaleDateString());
          }
      }

      function _restoreAfterPrint() {
          if (!_printState) return;

          // Remove PDF mode class
          document.body.classList.remove('pdf-mode');

          // Restore canvas charts and remove static images
          _printState.canvasImages.forEach(function(item) {
              item.canvas.style.display = '';
              if (item.img.parentNode) {
                  item.img.parentNode.removeChild(item.img);
              }
          });

          // Restore collapsed sections
          _printState.collapsed.forEach(function(item) {
              item.el.classList.add('collapsed');
              if (item.type === 'content') {
                  item.el.style.maxHeight = '';
              }
          });

          // Restore hidden examples
          _printState.hiddenExamples.forEach(function(item) {
              item.el.style.display = item.prev || 'none';
          });

          // Restore hidden table rows
          _printState.tableRows.forEach(function(item) {
              item.el.style.display = item.prev;
          });

          // Restore pagination controls
          _printState.paginationEls.forEach(function(item) {
              item.el.style.display = item.prev || '';
          });

          // Restore closed details
          _printState.details.forEach(function(el) {
              el.removeAttribute('open');
          });

          _printState = null;
      }

      window.addEventListener('beforeprint', _prepareForPrint);
      window.addEventListener('afterprint', _restoreAfterPrint);

      function saveToPDF() {
          _prepareForPrint();
          // Wait for chart images to render before triggering print
          setTimeout(function() {
              window.print();
              // Restore after a delay in case afterprint doesn't fire (some browsers)
              setTimeout(function() {
                  if (_printState) _restoreAfterPrint();
              }, 1000);
          }, 300);
      }

      // === Global Search ===
      (function() {
          var input = document.getElementById('globalSearchInput');
          var countEl = document.getElementById('searchCount');
          if (!input) return;

          var searchable = document.querySelectorAll('.container h2, .container h3, .container td, .container .summary-card-label, .container .info-card h3, .container .win-card, .container .issues-table-row');
          var originals = [];
          searchable.forEach(function(el) { originals.push(el.innerHTML); });

          var debounce;
          input.addEventListener('input', function() {
              clearTimeout(debounce);
              debounce = setTimeout(function() {
                  var q = input.value.trim().toLowerCase();
                  var count = 0;

                  searchable.forEach(function(el, i) {
                      el.innerHTML = originals[i]; // Reset
                      if (!q) return;
                      var text = el.textContent;
                      var idx = text.toLowerCase().indexOf(q);
                      if (idx >= 0) {
                          count++;
                          // Only highlight in small text elements to avoid breaking HTML structure
                          if (el.children.length === 0 || el.tagName === 'TD') {
                              el.innerHTML = text.substring(0, idx) +
                                  '<mark class="search-highlight">' + text.substring(idx, idx + q.length) + '</mark>' +
                                  text.substring(idx + q.length);
                          }
                      }
                  });

                  if (countEl) countEl.textContent = q ? count + ' found' : '';
              }, 200);
          });

          input.addEventListener('keydown', function(e) {
              if (e.key === 'Escape') {
                  input.value = '';
                  input.dispatchEvent(new Event('input'));
                  document.getElementById('globalSearch').classList.remove('visible');
              }
          });
      })();

      // === Score Count-Up Animation ===
      (function() {
          var scoreEl = document.querySelector('.score-number');
          if (!scoreEl) return;
          var circle = document.querySelector('.score-circle');
          if (circle) circle.classList.add('animated');

          var target = parseInt(scoreEl.textContent, 10) || 0;
          var current = 0;
          var duration = 800;
          var start = null;

          function animate(ts) {
              if (!start) start = ts;
              var progress = Math.min((ts - start) / duration, 1);
              current = Math.round(progress * target);
              scoreEl.textContent = current;
              if (progress < 1) requestAnimationFrame(animate);
          }

          requestAnimationFrame(animate);
      })();

      // === Section Tabs ===
      (function() {
          var tabs = document.querySelectorAll('.section-tab');
          if (!tabs.length) return;

          tabs.forEach(function(tab) {
              tab.addEventListener('click', function() {
                  tabs.forEach(function(t) { t.classList.remove('active'); });
                  tab.classList.add('active');
                  var target = document.getElementById(tab.dataset.target);
                  if (target) {
                      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
              });
          });

          // Update active tab on scroll
          var sectionIds = Array.from(tabs).map(function(t) { return t.dataset.target; });
          window.addEventListener('scroll', function() {
              var scrollY = window.scrollY + 150;
              var active = sectionIds[0];
              sectionIds.forEach(function(id) {
                  var el = document.getElementById(id);
                  if (el && el.offsetTop <= scrollY) active = id;
              });
              tabs.forEach(function(t) {
                  t.classList.toggle('active', t.dataset.target === active);
              });
          });
      })();

      // === FAB Menu ===
      (function() {
          var toggle = document.getElementById('fabToggle');
          var menu = document.getElementById('fabMenu');
          if (!toggle || !menu) return;

          toggle.addEventListener('click', function() {
              toggle.classList.toggle('open');
              menu.classList.toggle('visible');
          });

          document.addEventListener('click', function(e) {
              if (!toggle.contains(e.target) && !menu.contains(e.target)) {
                  toggle.classList.remove('open');
                  menu.classList.remove('visible');
              }
          });
      })();

      // === Reading Progress Bar ===
      (function() {
          var bar = document.getElementById('readingProgress');
          if (!bar) return;
          window.addEventListener('scroll', function() {
              var h = document.documentElement.scrollHeight - window.innerHeight;
              var pct = h > 0 ? (window.scrollY / h) * 100 : 0;
              bar.style.width = pct + '%';
          });
      })();

      // === Back to Top ===
      const backToTop = document.getElementById('backToTop');
      window.addEventListener('scroll', function() {
          if (window.scrollY > 500) {
              backToTop.classList.add('visible');
          } else {
              backToTop.classList.remove('visible');
          }
      });

      // === Sidebar Navigation Highlighting ===
      (function() {
          const navLinks = document.querySelectorAll('.report-nav a');
          const sections = [];
          navLinks.forEach(function(link) {
              const id = link.getAttribute('href').slice(1);
              const el = document.getElementById(id);
              if (el) sections.push({ id: id, el: el, link: link });
          });

          function updateActiveNav() {
              let current = '';
              const scrollY = window.scrollY + 200;
              sections.forEach(function(s) {
                  if (s.el.offsetTop <= scrollY) {
                      current = s.id;
                  }
              });
              navLinks.forEach(function(link) { link.classList.remove('active'); });
              if (current) {
                  const activeLink = document.querySelector('.report-nav a[href="#' + current + '"]');
                  if (activeLink) activeLink.classList.add('active');
              }
          }

          window.addEventListener('scroll', updateActiveNav);
          updateActiveNav();
      })();

      // === Keyboard Shortcuts ===
      (function() {
          let helpVisible = false;
          const hint = document.getElementById('keyboardHint');

          // Show hint briefly on load
          setTimeout(function() {
              hint.classList.add('visible');
              setTimeout(function() { hint.classList.remove('visible'); }, 3000);
          }, 1000);

          document.addEventListener('keydown', function(e) {
              // Don't intercept when typing in inputs
              if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

              switch(e.key) {
                  case '?':
                      e.preventDefault();
                      showKeyboardHelp();
                      break;
                  case '/':
                      e.preventDefault();
                      var pageSearch = document.getElementById('pageSearch');
                      if (pageSearch) {
                          pageSearch.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          setTimeout(function() { pageSearch.focus(); }, 300);
                      }
                      break;
                  case 't':
                      if (!e.ctrlKey && !e.metaKey) {
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                      }
                      break;
                  case 's':
                      if (!e.ctrlKey && !e.metaKey) {
                          e.preventDefault();
                          var gs = document.getElementById('globalSearch');
                          var gsi = document.getElementById('globalSearchInput');
                          if (gs) {
                              gs.classList.toggle('visible');
                              if (gs.classList.contains('visible')) gsi.focus();
                          }
                      }
                      break;
                  case 'Escape':
                      // Close any open modal
                      var modal = document.getElementById('infoModal');
                      if (modal && modal.classList.contains('active')) {
                          modal.classList.remove('active');
                      }
                      // Close keyboard help
                      var helpModal = document.getElementById('keyboardHelpModal');
                      if (helpModal) helpModal.remove();
                      // Close column picker
                      var picker = document.querySelector('.column-picker-dropdown.visible');
                      if (picker) picker.classList.remove('visible');
                      break;
                  case 'j':
                      // Navigate to next table row
                      if (!e.ctrlKey && !e.metaKey) {
                          var table = document.querySelector('#pagesTable tbody');
                          if (table) {
                              var current = table.querySelector('tr.keyboard-focus');
                              var next = current ? current.nextElementSibling : table.querySelector('tr');
                              if (next) {
                                  if (current) current.classList.remove('keyboard-focus');
                                  next.classList.add('keyboard-focus');
                                  next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                              }
                          }
                      }
                      break;
                  case 'k':
                      // Navigate to previous table row
                      if (!e.ctrlKey && !e.metaKey) {
                          var table = document.querySelector('#pagesTable tbody');
                          if (table) {
                              var current = table.querySelector('tr.keyboard-focus');
                              if (current && current.previousElementSibling) {
                                  current.classList.remove('keyboard-focus');
                                  current.previousElementSibling.classList.add('keyboard-focus');
                                  current.previousElementSibling.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                              }
                          }
                      }
                      break;
                  case 'e':
                      // Expand/collapse all sections
                      if (!e.ctrlKey && !e.metaKey) {
                          var toggles = document.querySelectorAll('.section-toggle');
                          var allCollapsed = Array.from(toggles).every(function(t) { return t.classList.contains('collapsed'); });
                          toggles.forEach(function(t) { t.click(); });
                      }
                      break;
                  case 'p':
                      // Toggle print view
                      if (!e.ctrlKey && !e.metaKey) {
                          window.print();
                      }
                      break;
                  case '1': case '2': case '3': case '4': case '5': case '6':
                      if (!e.ctrlKey && !e.metaKey) {
                          var navLinks = document.querySelectorAll('.report-nav a');
                          var idx = parseInt(e.key) - 1;
                          if (navLinks[idx]) {
                              navLinks[idx].click();
                          }
                      }
                      break;
              }
          });

          function showKeyboardHelp() {
              var existing = document.getElementById('keyboardHelpModal');
              if (existing) { existing.remove(); return; }

              var modal = document.createElement('div');
              modal.id = 'keyboardHelpModal';
              modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
              modal.innerHTML = '<div style="background:var(--color-bg-surface);padding:24px;border-radius:var(--radius-xl);max-width:400px;width:90%;color:var(--color-text-primary);">' +
                  '<h3 style="margin:0 0 16px;">Keyboard Shortcuts</h3>' +
                  '<table style="width:100%;font-size:14px;min-width:auto;">' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">?</kbd></td><td style="border:none;">Toggle this help</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">/</kbd></td><td style="border:none;">Focus URL search</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">t</kbd></td><td style="border:none;">Back to top</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">s</kbd></td><td style="border:none;">Toggle search</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">j/k</kbd></td><td style="border:none;">Navigate table rows</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">e</kbd></td><td style="border:none;">Expand/collapse all</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">p</kbd></td><td style="border:none;">Print report</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">1-6</kbd></td><td style="border:none;">Jump to section</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:var(--color-bg-surface-alt);padding:2px 8px;border-radius:var(--radius-sm);font-family:monospace;color:var(--color-text-primary);">Esc</kbd></td><td style="border:none;">Close modals</td></tr>' +
                  '</table>' +
                  '<button onclick="this.parentElement.parentElement.remove()" style="margin-top:16px;padding:6px 16px;background:#3b82f6;color:white;border:none;border-radius:var(--radius-md);cursor:pointer;">Close</button>' +
                  '</div>';
              modal.addEventListener('click', function(e) {
                  if (e.target === modal) modal.remove();
              });
              document.body.appendChild(modal);
          }
      })();

      // === Column Picker ===
      (function() {
          var tableFilters = document.querySelector('.table-filters');
          if (!tableFilters) return;

          var pickerContainer = document.createElement('div');
          pickerContainer.style.cssText = 'position:relative;display:inline-block;';

          var btn = document.createElement('button');
          btn.className = 'column-picker-btn';
          btn.innerHTML = '⚙ Columns';
          btn.onclick = function() {
              dropdown.classList.toggle('visible');
          };

          var dropdown = document.createElement('div');
          dropdown.className = 'column-picker-dropdown';

          var table = document.querySelector('#pagesTable');
          if (!table) return;

          var headers = table.querySelectorAll('thead th');
          var groups = {
              'Core': [0, 1, 2, 3],
              'SEO': [9, 10, 11, 12, 13, 14, 15, 16],
              'Performance': [5, 6, 7, 8, 36, 37, 38],
              'Security': [17, 18, 19, 20, 21, 22],
              'Caching': [23, 24, 25, 26, 27],
              'Images': [28, 29, 30, 31],
              'Optimization': [32, 33, 34],
              'Accessibility': [35, 36, 37, 38, 39],
              'Content': [40, 41, 42, 43, 44],
          };

          // Build column picker from actual headers
          var allIndices = new Set();
          headers.forEach(function(_, i) { allIndices.add(i); });

          Object.entries(groups).forEach(function(entry) {
              var groupName = entry[0];
              var indices = entry[1].filter(function(i) { return i < headers.length; });
              if (indices.length === 0) return;

              var groupLabel = document.createElement('div');
              groupLabel.className = 'picker-group';
              groupLabel.textContent = groupName;
              dropdown.appendChild(groupLabel);

              indices.forEach(function(i) {
                  if (!headers[i]) return;
                  var label = document.createElement('label');
                  var cb = document.createElement('input');
                  cb.type = 'checkbox';
                  cb.checked = true;
                  cb.dataset.col = i;
                  cb.onchange = function() { toggleColumn(i, this.checked); };
                  label.appendChild(cb);
                  label.appendChild(document.createTextNode(' ' + headers[i].textContent.trim().split('\\n')[0].substring(0, 25)));
                  dropdown.appendChild(label);
              });
          });

          pickerContainer.appendChild(btn);
          pickerContainer.appendChild(dropdown);
          tableFilters.appendChild(pickerContainer);

          // Close dropdown when clicking outside
          document.addEventListener('click', function(e) {
              if (!pickerContainer.contains(e.target)) {
                  dropdown.classList.remove('visible');
              }
          });

          function toggleColumn(colIdx, show) {
              var rows = table.querySelectorAll('tr');
              rows.forEach(function(row) {
                  var cell = row.cells[colIdx];
                  if (cell) {
                      cell.style.display = show ? '' : 'none';
                  }
              });
          }
      })();

      // === Page Detail Modal ===
      (function() {
          var table = document.querySelector('#pagesTable');
          if (!table) return;

          var tbody = table.querySelector('tbody');
          if (!tbody) return;

          tbody.addEventListener('dblclick', function(e) {
              var row = e.target.closest('tr');
              if (!row) return;

              var cells = row.cells;
              var url = cells[1] ? cells[1].textContent.trim() : '';

              var modal = document.getElementById('infoModal');
              var title = document.getElementById('modalTitle');
              var urlDiv = document.getElementById('modalUrl');
              var body = document.getElementById('modalBody');

              title.textContent = 'Page Details';
              urlDiv.textContent = url;

              // Build detail grid from row data
              var headers = table.querySelectorAll('thead th');
              var html = '<div class="page-detail-grid">';
              for (var i = 2; i < cells.length && i < headers.length; i++) {
                  if (cells[i].style.display === 'none') continue;
                  var headerText = headers[i].textContent.trim().split('\\n')[0];
                  var cellValue = cells[i].textContent.trim();
                  var cellColor = cells[i].style.color || 'var(--color-text-primary)';
                  html += '<div class="page-detail-card">' +
                      '<div class="detail-label">' + headerText + '</div>' +
                      '<div class="detail-value" style="color:' + cellColor + ';">' + cellValue + '</div>' +
                      '</div>';
              }
              html += '</div>';
              html += '<p style="margin-top:16px;font-size:var(--font-size-xs);color:var(--color-text-disabled);">Double-click any row to view details</p>';

              body.innerHTML = html;
              modal.classList.add('active');
          });
      })();

      // === Search Highlight ===
      (function() {
          var pageSearch = document.getElementById('pageSearch');
          if (!pageSearch) return;

          var originalUrlTexts = [];
          var urlCells = document.querySelectorAll('#pagesTable tbody td:nth-child(2)');
          urlCells.forEach(function(cell) {
              originalUrlTexts.push(cell.innerHTML);
          });

          pageSearch.addEventListener('input', function() {
              var query = this.value.toLowerCase();
              urlCells.forEach(function(cell, i) {
                  if (!query) {
                      cell.innerHTML = originalUrlTexts[i];
                      return;
                  }
                  var text = cell.textContent;
                  var idx = text.toLowerCase().indexOf(query);
                  if (idx >= 0) {
                      cell.innerHTML = text.substring(0, idx) +
                          '<mark class="search-highlight">' + text.substring(idx, idx + query.length) + '</mark>' +
                          text.substring(idx + query.length);
                  } else {
                      cell.innerHTML = originalUrlTexts[i];
                  }
              });
          });
      })();

      // === Row Selection ===
      (function() {
          var table = document.querySelector('#pagesTable');
          if (!table) return;
          var tbody = table.querySelector('tbody');
          if (!tbody) return;
          var bar = document.getElementById('selectionBar');
          var countEl = document.getElementById('selectionCount');

          tbody.addEventListener('click', function(e) {
              if (e.target.tagName === 'A') return; // Don't select on link clicks
              var row = e.target.closest('tr');
              if (!row || row.classList.contains('url-group-row')) return;

              if (e.ctrlKey || e.metaKey) {
                  row.classList.toggle('selected');
              } else if (e.shiftKey) {
                  // Range select
                  var rows = Array.from(tbody.querySelectorAll('tr:not(.url-group-row)'));
                  var selectedRows = rows.filter(function(r) { return r.classList.contains('selected'); });
                  if (selectedRows.length > 0) {
                      var lastIdx = rows.indexOf(selectedRows[selectedRows.length - 1]);
                      var curIdx = rows.indexOf(row);
                      var start = Math.min(lastIdx, curIdx);
                      var end = Math.max(lastIdx, curIdx);
                      for (var i = start; i <= end; i++) rows[i].classList.add('selected');
                  }
              }

              updateSelectionBar();
          });

          window.clearSelection = function() {
              tbody.querySelectorAll('tr.selected').forEach(function(r) { r.classList.remove('selected'); });
              updateSelectionBar();
          };

          window.exportSelectedCSV = function() {
              var headers = table.querySelectorAll('thead th');
              var selected = tbody.querySelectorAll('tr.selected');
              if (selected.length === 0) return;

              var rows = [Array.from(headers).map(function(th) { return th.textContent.trim().split('\\n')[0]; })];
              selected.forEach(function(row) {
                  rows.push(Array.from(row.cells).map(function(td) { return escapeCSV(td.textContent.trim()); }));
              });
              downloadCSV('${domainName}_selected.csv', rows.map(function(r) { return r.join(','); }).join('\\n'));
              clearSelection();
          };

          function updateSelectionBar() {
              var count = tbody.querySelectorAll('tr.selected').length;
              if (bar) {
                  bar.classList.toggle('visible', count > 0);
                  if (countEl) countEl.textContent = count + ' row' + (count !== 1 ? 's' : '') + ' selected';
              }
          }
      })();

      // === Table Pagination — handled by tableManager ===
      if (tableManager) tableManager.init();

      // === Filter Presets ===
      (function() {
          var tableFilters = document.querySelector('.table-filters');
          if (!tableFilters) return;

          var presetBar = document.createElement('div');
          presetBar.className = 'filter-presets';
          var presets = [
              { label: 'All', filter: function() { return true; } },
              { label: 'Errors Only', filter: function(row) { return row.getAttribute('data-has-errors') === 'true'; } },
              { label: 'Slow Pages', filter: function(row) { return parseFloat(row.getAttribute('data-ttfb') || '0') > 800; } },
              { label: 'Missing Meta', filter: function(row) { return row.getAttribute('data-missing-meta') === 'true'; } },
              { label: 'No H1', filter: function(row) { return row.getAttribute('data-h1-count') === '0'; } },
              { label: '404s', filter: function(row) { return row.getAttribute('data-status') === '404'; } },
          ];

          var activePreset = null;
          presets.forEach(function(preset, idx) {
              var btn = document.createElement('button');
              btn.className = 'filter-preset-btn' + (idx === 0 ? ' active' : '');
              btn.textContent = preset.label;
              btn.onclick = function() {
                  presetBar.querySelectorAll('.filter-preset-btn').forEach(function(b) { b.classList.remove('active'); });
                  btn.classList.add('active');

                  // "All" preset clears the preset filter
                  if (tableManager) {
                      tableManager.setPreset(idx === 0 ? null : preset.filter);
                  }
              };
              presetBar.appendChild(btn);
          });

          // Group by path toggle
          var groupBtn = document.createElement('button');
          groupBtn.className = 'filter-preset-btn';
          groupBtn.textContent = 'Group by Path';
          groupBtn.onclick = function() {
              var active = groupBtn.classList.toggle('active');
              var table = document.querySelector('#pagesTable');
              if (!table) return;
              var tbody = table.querySelector('tbody');
              if (!tbody) return;

              // Remove existing group rows
              tbody.querySelectorAll('.url-group-row').forEach(function(r) { r.remove(); });

              if (!active) {
                  // Show all rows
                  tbody.querySelectorAll('tr').forEach(function(r) { r.style.display = ''; });
                  return;
              }

              // Group rows by first path segment
              var rows = Array.from(tbody.querySelectorAll('tr:not(.url-group-row)'));
              var groups = {};
              rows.forEach(function(row) {
                  var link = row.querySelector('a');
                  if (!link) return;
                  try {
                      var p = new URL(link.href).pathname.split('/').filter(Boolean);
                      var seg = '/' + (p[0] || '');
                      if (!groups[seg]) groups[seg] = [];
                      groups[seg].push(row);
                  } catch(e) { /* invalid URL in href — skip row */ }
              });

              // Insert group headers and reorder
              var colCount = table.querySelectorAll('thead th').length;
              Object.keys(groups).sort().forEach(function(seg) {
                  var groupRow = document.createElement('tr');
                  groupRow.className = 'url-group-row';
                  groupRow.innerHTML = '<td colspan="' + colCount + '">' + seg + '<span class="group-count">(' + groups[seg].length + ' pages)</span></td>';
                  var collapsed = false;
                  groupRow.onclick = function() {
                      collapsed = !collapsed;
                      groups[seg].forEach(function(r) { r.style.display = collapsed ? 'none' : ''; });
                  };
                  tbody.appendChild(groupRow);
                  groups[seg].forEach(function(r) { tbody.appendChild(r); });
              });
          };
          presetBar.appendChild(groupBtn);

          tableFilters.parentNode.insertBefore(presetBar, tableFilters);
      })();

      // === Row Hover Tooltip ===
      (function() {
          var table = document.querySelector('#pagesTable');
          if (!table) return;
          var tbody = table.querySelector('tbody');
          if (!tbody) return;

          var tip = document.createElement('div');
          tip.className = 'row-tooltip';
          document.body.appendChild(tip);

          var headers = table.querySelectorAll('thead th');
          // Find column indices for key metrics by header text
          var colMap = {};
          headers.forEach(function(th, i) {
              var t = th.textContent.trim().split('\\n')[0].toLowerCase();
              if (t.includes('status')) colMap.status = i;
              else if (t.includes('ttfb')) colMap.ttfb = i;
              else if (t.includes('lcp')) colMap.lcp = i;
              else if (t.includes('cls')) colMap.cls = i;
              else if (t === 'title' || t.includes('title length')) colMap.title = i;
          });

          var hideTimer;
          tbody.addEventListener('mouseover', function(e) {
              var row = e.target.closest('tr');
              if (!row) return;
              clearTimeout(hideTimer);

              var lines = [];
              if (colMap.status !== undefined) lines.push('<span class="tt-label">Status:</span>' + row.cells[colMap.status]?.textContent.trim());
              if (colMap.ttfb !== undefined) {
                  var v = row.cells[colMap.ttfb]?.textContent.trim();
                  if (v && v !== '-') lines.push('<span class="tt-label">TTFB:</span><span class="' + metricClass(parseFloat(v), 800) + '">' + v + '</span>');
              }
              if (colMap.lcp !== undefined) {
                  var v = row.cells[colMap.lcp]?.textContent.trim();
                  if (v && v !== '-') lines.push('<span class="tt-label">LCP:</span><span class="' + metricClass(parseFloat(v), 2500) + '">' + v + '</span>');
              }
              if (colMap.cls !== undefined) {
                  var v = row.cells[colMap.cls]?.textContent.trim();
                  if (v && v !== '-') lines.push('<span class="tt-label">CLS:</span><span class="' + metricClass(parseFloat(v), 0.1) + '">' + v + '</span>');
              }

              if (lines.length === 0) return;
              tip.innerHTML = lines.join('<br>');
              tip.classList.add('visible');
          });

          tbody.addEventListener('mousemove', function(e) {
              tip.style.left = (e.clientX + 12) + 'px';
              tip.style.top = (e.clientY + 12) + 'px';
          });

          tbody.addEventListener('mouseout', function(e) {
              hideTimer = setTimeout(function() { tip.classList.remove('visible'); }, 100);
          });

          function metricClass(val, threshold) {
              if (isNaN(val)) return '';
              if (val <= threshold * 0.5) return 'tt-good';
              if (val <= threshold) return 'tt-warn';
              return 'tt-bad';
          }
      })();

      // === Tech Badge Tooltip ===
      (function() {
          var badges = document.querySelectorAll('.tech-badge[data-tip]');
          if (!badges.length) return;

          var tip = document.createElement('div');
          tip.className = 'row-tooltip';
          document.body.appendChild(tip);

          var hideTimer;
          badges.forEach(function(badge) {
              badge.addEventListener('mouseenter', function(e) {
                  clearTimeout(hideTimer);
                  tip.innerHTML = badge.getAttribute('data-tip');
                  tip.style.left = (e.clientX + 12) + 'px';
                  tip.style.top = (e.clientY + 12) + 'px';
                  tip.classList.add('visible');
              });
              badge.addEventListener('mousemove', function(e) {
                  tip.style.left = (e.clientX + 12) + 'px';
                  tip.style.top = (e.clientY + 12) + 'px';
              });
              badge.addEventListener('mouseleave', function() {
                  hideTimer = setTimeout(function() { tip.classList.remove('visible'); }, 100);
              });
          });
      })();

      // === Horizontal Scroll Indicator ===
      (function() {
          var tableContainer = document.querySelector('.table-container');
          if (!tableContainer) return;

          // Wrap table container for positioning
          var wrapper = document.createElement('div');
          wrapper.className = 'table-scroll-wrapper';
          tableContainer.parentNode.insertBefore(wrapper, tableContainer);
          wrapper.appendChild(tableContainer);

          var leftInd = document.createElement('div');
          leftInd.className = 'scroll-indicator left';
          wrapper.appendChild(leftInd);

          var rightInd = document.createElement('div');
          rightInd.className = 'scroll-indicator right';
          wrapper.appendChild(rightInd);

          function updateIndicators() {
              var sl = tableContainer.scrollLeft;
              var maxScroll = tableContainer.scrollWidth - tableContainer.clientWidth;
              leftInd.classList.toggle('visible', sl > 10);
              rightInd.classList.toggle('visible', sl < maxScroll - 10);
          }

          tableContainer.addEventListener('scroll', updateIndicators);
          window.addEventListener('resize', updateIndicators);
          setTimeout(updateIndicators, 100);
      })();

      // === Copy Cell Value on Click ===
      (function() {
          var toast = document.createElement('div');
          toast.className = 'copy-toast';
          toast.textContent = 'Copied!';
          document.body.appendChild(toast);
          var toastTimer;

          var table = document.querySelector('#pagesTable');
          if (!table) return;

          table.querySelector('tbody')?.addEventListener('click', function(e) {
              var td = e.target.closest('td');
              if (!td) return;
              // Skip URL column (has links) and row number column
              var cellIndex = td.cellIndex;
              if (cellIndex <= 1) return;

              var text = td.textContent.trim();
              if (!text || text === '-') return;

              if (navigator.clipboard) {
                  navigator.clipboard.writeText(text).then(function() {
                      showCopyToast();
                  });
              }
          });

          function showCopyToast() {
              clearTimeout(toastTimer);
              toast.classList.add('visible');
              toastTimer = setTimeout(function() {
                  toast.classList.remove('visible');
              }, 1500);
          }
      })();

      // === Share Report Summary ===
      window.shareReport = function() {
          var score = document.querySelector('.score-number');
          var scoreVal = score ? score.textContent.trim() : '?';
          var domain = document.querySelector('.subtitle');
          var domainText = domain ? domain.textContent.trim() : '';
          var issues = document.querySelectorAll('.summary-card-value');
          var totalIssues = issues[0] ? issues[0].textContent.trim() : '?';
          var critical = issues[1] ? issues[1].textContent.trim() : '0';
          var high = issues[2] ? issues[2].textContent.trim() : '0';

          var text = 'SEO Audit Report: ' + domainText + '\\n' +
              'Score: ' + scoreVal + '/100\\n' +
              'Issues: ' + totalIssues + ' total (' + critical + ' critical, ' + high + ' high)\\n' +
              'Generated: ' + new Date().toLocaleDateString();

          if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(function() {
                  if (window.showNotification) showNotification('Report summary copied to clipboard!');
              });
          }

          // Also try native share API on mobile
          if (navigator.share) {
              navigator.share({ title: 'SEO Audit - ' + domainText, text: text }).catch(function() {});
          }
      };

      // === Report Age Indicator ===
      (function() {
          var ts = document.getElementById('reportTimestamp');
          if (!ts) return;
          var generated = new Date(ts.getAttribute('datetime'));
          if (isNaN(generated)) return;

          function update() {
              var diff = Date.now() - generated.getTime();
              var mins = Math.floor(diff / 60000);
              var hours = Math.floor(mins / 60);
              var days = Math.floor(hours / 24);
              var ago;
              if (days > 0) ago = days + ' day' + (days > 1 ? 's' : '') + ' ago';
              else if (hours > 0) ago = hours + ' hour' + (hours > 1 ? 's' : '') + ' ago';
              else if (mins > 1) ago = mins + ' minutes ago';
              else ago = 'just now';

              ts.title = 'Generated ' + ago;
              var badge = document.getElementById('ageBadge');
              if (!badge) {
                  badge = document.createElement('span');
                  badge.id = 'ageBadge';
                  badge.style.cssText = 'display:inline-block;margin-left:8px;padding:2px 8px;border-radius:var(--radius-xl);font-size:11px;font-weight:600;';
                  ts.parentNode.appendChild(badge);
              }
              if (days > 7) {
                  badge.textContent = ago + ' - consider re-running';
                  badge.style.background = 'var(--amber-100)';
                  badge.style.color = 'var(--color-warning-text)';
              } else if (days > 0) {
                  badge.textContent = ago;
                  badge.style.background = 'var(--blue-100)';
                  badge.style.color = 'var(--blue-800)';
              } else {
                  badge.textContent = ago;
                  badge.style.background = 'var(--color-success-bg)';
                  badge.style.color = 'var(--color-success-text)';
              }
          }
          update();
          setInterval(update, 60000);
      })();

      // === Section Tab Badges (issue counts) ===
      (function() {
          var tabs = document.querySelectorAll('.section-tab');
          tabs.forEach(function(tab) {
              var target = tab.getAttribute('data-target');
              if (target === 'top-issues') {
                  var cards = document.querySelectorAll('.issues-table-row');
                  if (cards.length > 0) {
                      var badge = document.createElement('span');
                      badge.className = 'tab-badge';
                      badge.textContent = cards.length;
                      tab.appendChild(badge);
                  }
              } else if (target === 'quick-wins') {
                  var wins = document.querySelectorAll('.win-card');
                  if (wins.length > 0) {
                      var badge = document.createElement('span');
                      badge.className = 'tab-badge zero';
                      badge.textContent = wins.length;
                      tab.appendChild(badge);
                  }
              }
          });
      })();

      // === Notification Toast System ===
      (function() {
          var toast = document.createElement('div');
          toast.className = 'notification-toast';
          document.body.appendChild(toast);
          var timer;

          window.showNotification = function(message, duration) {
              clearTimeout(timer);
              toast.textContent = message;
              toast.classList.add('visible');
              timer = setTimeout(function() {
                  toast.classList.remove('visible');
              }, duration || 2000);
          };
      })();

      // === Deep Link Handling ===
      (function() {
          if (window.location.hash) {
              var target = document.querySelector(window.location.hash);
              if (target) {
                  setTimeout(function() {
                      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 500);
              }
          }

          // Update URL hash on section nav click
          document.querySelectorAll('.report-nav a').forEach(function(link) {
              link.addEventListener('click', function(e) {
                  var hash = this.getAttribute('href');
                  if (hash && hash.startsWith('#')) {
                      history.replaceState(null, null, hash);
                  }
              });
          });
      })();

      // === Phase Timeline Visualization ===
      (function() {
          var timingSection = document.querySelector('.timing-phases');
          if (!timingSection) return;

          var phases = timingSection.querySelectorAll('[data-phase-ms]');
          if (phases.length === 0) return;

          var totalMs = 0;
          phases.forEach(function(p) { totalMs += parseInt(p.getAttribute('data-phase-ms') || '0', 10); });
          if (totalMs === 0) return;

          var colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
          var timeline = document.createElement('div');
          timeline.className = 'phase-timeline';

          phases.forEach(function(p, i) {
              var ms = parseInt(p.getAttribute('data-phase-ms') || '0', 10);
              var pct = (ms / totalMs * 100).toFixed(1);
              var bar = document.createElement('div');
              bar.className = 'phase-bar';
              bar.style.width = pct + '%';
              bar.style.background = colors[i % colors.length];
              bar.setAttribute('data-label', p.textContent.trim() + ' (' + pct + '%)');
              timeline.appendChild(bar);
          });

          timingSection.prepend(timeline);
      })();

      // === Auto-expand Issue Examples on Click ===
      (function() {
          document.querySelectorAll('.affected-pages').forEach(function(el) {
              var hidden = el.querySelectorAll('[style*="display: none"], .hidden-example');
              if (hidden.length === 0) return;

              var btn = document.createElement('button');
              btn.className = 'show-more-btn';
              btn.textContent = 'Show all ' + (hidden.length + el.querySelectorAll('div[style*="margin"]').length) + ' examples';
              btn.onclick = function() {
                  hidden.forEach(function(h) { h.style.display = ''; h.classList.remove('hidden-example'); });
                  btn.remove();
              };
              el.appendChild(btn);
          });
      })();

      // === Lazy Load Charts (Intersection Observer) ===
      (function() {
          if (!('IntersectionObserver' in window)) return;

          var chartContainers = document.querySelectorAll('.chart-container canvas');
          // Charts are already initialized, but we can lazy-render tables
          var sections = document.querySelectorAll('.charts-section, .info-section');

          var observer = new IntersectionObserver(function(entries) {
              entries.forEach(function(entry) {
                  if (entry.isIntersecting) {
                      entry.target.classList.add('section-visible');
                      observer.unobserve(entry.target);
                  }
              });
          }, { rootMargin: '100px' });

          sections.forEach(function(s) { observer.observe(s); });
      })();

      // === Collapsible Sections ===
      (function() {
          var sectionIds = ['executive-summary', 'quick-wins', 'top-issues', 'performance', 'charts', 'pages-table'];
          sectionIds.forEach(function(id) {
              var section = document.getElementById(id);
              if (!section || !section.firstElementChild) return;

              var firstChild = section.firstElementChild;
              var h2 = firstChild.querySelector('h2') || firstChild.querySelector('.wins-issues-title') || firstChild.querySelector('.chart-title');
              if (!h2) return;

              // Wrap h2 in a clickable header
              var toggle = document.createElement('button');
              toggle.className = 'section-toggle';
              toggle.textContent = '▼';
              toggle.title = 'Collapse section';

              h2.style.cursor = 'pointer';
              h2.style.display = 'flex';
              h2.style.alignItems = 'center';
              h2.style.justifyContent = 'space-between';
              h2.appendChild(toggle);

              // Content to collapse = everything after h2 parent
              var contentElements = [];
              var sibling = h2.parentElement === firstChild ? firstChild.nextElementSibling : h2.nextElementSibling;
              while (sibling) {
                  contentElements.push(sibling);
                  sibling = sibling.nextElementSibling;
              }

              // Saved state
              var saved = localStorage.getItem('seo-collapse-' + id);

              h2.addEventListener('click', function() {
                  var isCollapsed = toggle.classList.toggle('collapsed');
                  toggle.textContent = isCollapsed ? '▶' : '▼';
                  toggle.title = isCollapsed ? 'Expand section' : 'Collapse section';
                  contentElements.forEach(function(el) {
                      el.style.display = isCollapsed ? 'none' : '';
                  });
                  localStorage.setItem('seo-collapse-' + id, isCollapsed ? '1' : '0');
              });

              // Restore saved state
              if (saved === '1') {
                  toggle.classList.add('collapsed');
                  toggle.textContent = '▶';
                  contentElements.forEach(function(el) {
                      el.style.display = 'none';
                  });
              }
          });
      })();
      </script>
  `;
}

export { getScripts };
