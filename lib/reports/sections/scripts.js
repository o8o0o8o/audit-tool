/**
 * Client-side JavaScript for HTML Reports
 * Provides interactive functionality: sorting, modals, charts, CSV export
 */

/**
 * Safely stringify JSON for embedding in script tags
 * Escapes </script> and <!-- to prevent breaking out of script context
 * @param {*} data - Data to stringify
 * @returns {string} Safe JSON string
 */
function safeJsonStringify(data) {
  return JSON.stringify(data)
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Pre-calculate chart data to avoid embedding full jsonData in HTML
 * @param {Object} jsonData - Full audit data
 * @returns {Object} Minimal data needed for charts
 */
function calculateChartData(jsonData) {
  const summary = jsonData.analysis?.summary || {};
  const details = jsonData.analysis?.details || {};
  const pages = jsonData.pageData?.pages || {};

  // Pre-calculate top 10 issues for frequency chart
  const topIssues = Object.entries(details)
    .map(([issue, data]) => ({ issue, count: data.examples?.length || 0, severity: data.severity || 'MEDIUM' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Pre-calculate performance averages
  const pagesWithPerf = Object.values(pages).filter(p => p.TTFB || p.LCP || p.CLS);
  const avgTTFB = pagesWithPerf.length > 0
    ? Math.round(pagesWithPerf.reduce((sum, p) => sum + (p.TTFB || 0), 0) / pagesWithPerf.length)
    : 0;
  const avgLCP = pagesWithPerf.length > 0
    ? Math.round(pagesWithPerf.reduce((sum, p) => sum + (p.LCP || 0), 0) / pagesWithPerf.length)
    : 0;
  const avgCLS = pagesWithPerf.length > 0
    ? (pagesWithPerf.reduce((sum, p) => sum + (p.CLS || 0), 0) / pagesWithPerf.length).toFixed(3)
    : 0;

  // Pre-calculate status code distribution
  const statusCodes = {};
  Object.values(pages).forEach(page => {
    const code = page.status || page.statusCode;
    if (!code || isNaN(code)) return;
    const codeGroup = Math.floor(code / 100) * 100;
    const label = codeGroup + 'xx (' + (codeGroup === 200 ? 'Success' : codeGroup === 300 ? 'Redirect' : codeGroup === 400 ? 'Client Error' : codeGroup === 500 ? 'Server Error' : 'Other') + ')';
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
  Object.values(pages).forEach(page => {
    const wordCount = page.contentQuality?.wordCount || 0;
    if (wordCount < 100) wordCountBuckets['Thin (0-100)']++;
    else if (wordCount < 300) wordCountBuckets['Short (100-300)']++;
    else if (wordCount < 600) wordCountBuckets['Medium (300-600)']++;
    else if (wordCount < 1000) wordCountBuckets['Long (600-1000)']++;
    else wordCountBuckets['Comprehensive (1000+)']++;
  });

  // Pre-calculate indexability breakdown
  const indexability = {
    'Indexable': 0,
    'Noindex': 0,
    'Redirects (3xx)': 0,
    'Client Errors (4xx)': 0,
    'Server Errors (5xx)': 0,
  };
  Object.values(pages).forEach(page => {
    const status = page.status || page.statusCode || 200;
    if (status >= 500) {
      indexability['Server Errors (5xx)']++;
    } else if (status >= 400) {
      indexability['Client Errors (4xx)']++;
    } else if (status >= 300) {
      indexability['Redirects (3xx)']++;
    } else if (page.indexability?.noindex || page.metaMap?.robots?.includes('noindex')) {
      indexability['Noindex']++;
    } else {
      indexability['Indexable']++;
    }
  });

  return {
    summary: {
      criticalCount: summary.criticalCount || 0,
      highCount: summary.highCount || 0,
      mediumCount: summary.mediumCount || 0,
      lowCount: summary.lowCount || 0,
      overallScore: summary.overallScore || 0,
      totalIssues: summary.totalIssues || 0,
      passRate: summary.passRate || 0,
      categoryScores: summary.categoryScores || {},
      quickWins: summary.quickWins || [],
    },
    topIssues,
    performance: {
      avgTTFB,
      avgLCP,
      avgCLS: parseFloat(avgCLS),
      hasData: pagesWithPerf.length > 0,
    },
    statusCodes,
    wordCountBuckets,
    indexability,
  };
}

/**
 * Create minimal pages data for CSV export
 * @param {Object} jsonData - Full audit data
 * @returns {Array} Array of minimal page data
 */
function createPagesExportData(jsonData) {
  const pages = jsonData.pageData?.pages || {};
  return Object.entries(pages).map(([url, data]) => ({
    url,
    status: data.status || data.statusCode || '',
    title: data.title || '',
    description: data.description || '',
    h1Count: data.headings?.h1?.length || (Array.isArray(data.headings) ? (data.headings.find(h => h.tag === 'h1')?.count || 0) : 0),
    canonical: data.canonical || '',
    TTFB: data.TTFB || '',
    LCP: data.LCP || '',
    CLS: data.CLS || '',
    pageSize: data.totalResponseSize ? (data.totalResponseSize / (1024 * 1024)).toFixed(2) : '',
    requests: data.totalNumberOfRequests || data.numberOfRequests || '',
    hasErrors: (data.status >= 400 || data.errors?.length > 0) ? 'Yes' : 'No',
    loadTime: data.loadEvent || '',
  }));
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
function getScripts(data) {
  const { pageData, jsonData, trendData, domainName } = data;

  // Pre-calculate chart data to avoid embedding full jsonData
  const chartData = calculateChartData(jsonData);

  // Create minimal data for CSV exports
  const pagesExportData = createPagesExportData(jsonData);

  // Extract details with limited examples for modal popups (max 100 per issue)
  const detailsForModals = {};
  const details = jsonData.analysis?.details || {};
  for (const [issue, data] of Object.entries(details)) {
    detailsForModals[issue] = {
      severity: data.severity || 'MEDIUM',
      examples: (data.examples || []).slice(0, 100),
    };
  }

  // Limit incoming links data to first 10 per page
  const limitedIncomingLinks = {};
  for (const [url, links] of Object.entries(pageData.incomingLinks || {})) {
    limitedIncomingLinks[url] = (links || []).slice(0, 10);
  }

  return `
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
                  let lineColor = '#6b7280'; // stable - gray
                  if (lastVal < firstVal * 0.8) {
                      lineColor = '#10b981'; // improving - green
                  } else if (lastVal > firstVal * 1.2) {
                      lineColor = '#ef4444'; // worsening - red
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
              new Chart(performanceCtx, {
                  type: 'bar',
                  data: {
                      labels: ['TTFB (ms)', 'LCP (ms)', 'CLS (×100)'],
                      datasets: [{
                          label: 'Average Value',
                          data: [chartData.performance.avgTTFB, chartData.performance.avgLCP, (chartData.performance.avgCLS * 100).toFixed(1)],
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
              new Chart(wordCountCtx, {
                  type: 'bar',
                  data: {
                      labels: Object.keys(wordCountBuckets),
                      datasets: [{
                          label: 'Pages',
                          data: Object.values(wordCountBuckets),
                          backgroundColor: [
                              '#ef4444',
                              '#f59e0b',
                              '#10b981',
                              '#3b82f6',
                              '#8b5cf6'
                          ],
                          borderColor: [
                              '#dc2626',
                              '#d97706',
                              '#059669',
                              '#2563eb',
                              '#7c3aed'
                          ],
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
                                      const value = context.parsed.y || 0;
                                      const total = Object.values(wordCountBuckets).reduce((a, b) => a + b, 0);
                                      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                      return value + ' pages (' + percentage + '%)';
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
          // Use pre-calculated minimal data instead of full jsonData
          const pagesExportData = ${safeJsonStringify(pagesExportData)};
          const summaryData = ${safeJsonStringify(chartData.summary)};
          let content = '';
          let filename = '';

          if (type === 'pages') {
              filename = '${domainName}_pages_overview.csv';
              const rows = [['URL', 'Status Code', 'Title', 'Description', 'H1 Count', 'Canonical', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Has Errors']];

              pagesExportData.forEach(data => {
                  rows.push([
                      data.url,
                      data.status,
                      data.title,
                      data.description,
                      data.h1Count,
                      data.canonical,
                      data.TTFB,
                      data.LCP,
                      data.CLS,
                      data.pageSize,
                      data.requests,
                      data.hasErrors
                  ].map(escapeCSV));
              });
              content = rows.map(row => row.join(',')).join('\\n');
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
              const rows = [['URL', 'TTFB (ms)', 'LCP (ms)', 'CLS', 'Page Size (MB)', 'Requests', 'Load Time (ms)']];

              pagesExportData.forEach(data => {
                  if (data.TTFB || data.LCP || data.CLS) {
                      rows.push([
                          data.url,
                          data.TTFB,
                          data.LCP,
                          data.CLS,
                          data.pageSize,
                          data.requests,
                          data.loadTime
                      ].map(escapeCSV));
                  }
              });
              content = rows.map(row => row.join(',')).join('\\n');
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

      // Table Filtering Functions
      let currentKeywordFilter = '';
      let currentUrlFilter = '';
      let currentSegmentFilter = '';

      function filterTableByKeyword(keyword) {
          currentKeywordFilter = keyword.toLowerCase().trim();
          applyTableFilters();
      }

      function filterTableByUrl(urlPattern) {
          currentUrlFilter = urlPattern.toLowerCase().trim();
          applyTableFilters();
      }

      function filterTableBySegment(segment) {
          currentSegmentFilter = segment.toLowerCase().trim();
          applyTableFilters();
      }

      function clearTableFilters() {
          currentKeywordFilter = '';
          currentUrlFilter = '';
          currentSegmentFilter = '';
          document.getElementById('keywordFilter').value = '';
          document.getElementById('urlFilter').value = '';
          document.getElementById('segmentFilter').value = '';
          applyTableFilters();
      }

      function applyTableFilters() {
          const table = document.getElementById('pagesTable');
          if (!table) return;

          const rows = table.querySelectorAll('tbody tr');
          let visibleCount = 0;
          const totalCount = rows.length;

          rows.forEach(row => {
              const keywords = (row.getAttribute('data-keywords') || '').toLowerCase();
              const title = (row.getAttribute('data-title') || '').toLowerCase();
              const url = row.querySelector('a')?.href?.toLowerCase() || '';
              const segment = (row.getAttribute('data-segment') || '').toLowerCase();

              let showRow = true;

              // Keyword filter - check in keywords and title
              if (currentKeywordFilter) {
                  const keywordMatch = keywords.includes(currentKeywordFilter) ||
                                       title.includes(currentKeywordFilter);
                  if (!keywordMatch) showRow = false;
              }

              // URL filter
              if (currentUrlFilter && showRow) {
                  const urlMatch = url.includes(currentUrlFilter);
                  if (!urlMatch) showRow = false;
              }

              // Segment filter
              if (currentSegmentFilter && showRow) {
                  const segmentMatch = segment === currentSegmentFilter;
                  if (!segmentMatch) showRow = false;
              }

              row.style.display = showRow ? '' : 'none';
              if (showRow) visibleCount++;
          });

          // Update filter count
          const filterCount = document.getElementById('filterCount');
          if (filterCount) {
              if (currentKeywordFilter || currentUrlFilter || currentSegmentFilter) {
                  filterCount.textContent = 'Showing ' + visibleCount + ' of ' + totalCount + ' pages';
              } else {
                  filterCount.textContent = '';
              }
          }
      }

      // Save to PDF function
      function saveToPDF() {
          // Set the print date on footer for the print stylesheet
          const footer = document.querySelector('footer');
          if (footer) {
              footer.setAttribute('data-print-date', new Date().toLocaleDateString());
          }

          // Brief delay to ensure styles are applied
          setTimeout(() => {
              window.print();
          }, 100);
      }

      // === Global Search ===
      (function() {
          var input = document.getElementById('globalSearchInput');
          var countEl = document.getElementById('searchCount');
          if (!input) return;

          var searchable = document.querySelectorAll('.container h2, .container h3, .container td, .container .summary-card-label, .container .info-card h3, .container .win-card, .container .issue-card');
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

      // === Dark Mode ===
      function toggleDarkMode() {
          document.body.classList.toggle('dark-mode');
          const isDark = document.body.classList.contains('dark-mode');
          localStorage.setItem('seo-audit-dark-mode', isDark ? '1' : '0');
          document.querySelector('.theme-toggle').textContent = isDark ? '☀️' : '🌙';
          // Re-render charts with appropriate colors if needed
          if (typeof Chart !== 'undefined') {
              Chart.helpers.each(Chart.instances, function(instance) {
                  instance.options.plugins.legend.labels.color = isDark ? '#d1d5db' : '#374151';
                  instance.update();
              });
          }
      }

      // Restore dark mode preference
      if (localStorage.getItem('seo-audit-dark-mode') === '1') {
          document.body.classList.add('dark-mode');
          document.querySelector('.theme-toggle').textContent = '☀️';
      }

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

      // === Theme Switcher ===
      var themes = ['', 'theme-ocean', 'theme-forest', 'theme-sunset'];
      var currentThemeIdx = 0;
      function cycleTheme() {
          document.body.classList.remove(themes[currentThemeIdx]);
          currentThemeIdx = (currentThemeIdx + 1) % themes.length;
          if (themes[currentThemeIdx]) document.body.classList.add(themes[currentThemeIdx]);
          localStorage.setItem('seo-audit-theme', themes[currentThemeIdx]);
      }
      var savedTheme = localStorage.getItem('seo-audit-theme');
      if (savedTheme) {
          currentThemeIdx = themes.indexOf(savedTheme);
          if (currentThemeIdx > 0) document.body.classList.add(savedTheme);
      }

      // === High Contrast Mode ===
      function toggleHighContrast() {
          document.body.classList.toggle('high-contrast');
          localStorage.setItem('seo-audit-high-contrast', document.body.classList.contains('high-contrast') ? '1' : '0');
      }
      if (localStorage.getItem('seo-audit-high-contrast') === '1') {
          document.body.classList.add('high-contrast');
      }

      // === Color-blind Mode ===
      function toggleColorblind() {
          document.body.classList.toggle('colorblind-mode');
          var on = document.body.classList.contains('colorblind-mode');
          localStorage.setItem('seo-audit-colorblind', on ? '1' : '0');
      }
      if (localStorage.getItem('seo-audit-colorblind') === '1') {
          document.body.classList.add('colorblind-mode');
      }

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
                      var urlFilter = document.getElementById('urlFilter');
                      if (urlFilter) {
                          urlFilter.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          setTimeout(function() { urlFilter.focus(); }, 300);
                      }
                      break;
                  case 'd':
                      if (!e.ctrlKey && !e.metaKey) {
                          toggleDarkMode();
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
              modal.innerHTML = '<div style="background:' + (document.body.classList.contains('dark-mode') ? '#1f2937' : 'white') + ';padding:24px;border-radius:12px;max-width:400px;width:90%;color:' + (document.body.classList.contains('dark-mode') ? '#e5e7eb' : '#111827') + ';">' +
                  '<h3 style="margin:0 0 16px;">Keyboard Shortcuts</h3>' +
                  '<table style="width:100%;font-size:14px;min-width:auto;">' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">?</kbd></td><td style="border:none;">Toggle this help</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">/</kbd></td><td style="border:none;">Focus URL search</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">d</kbd></td><td style="border:none;">Toggle dark mode</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">t</kbd></td><td style="border:none;">Back to top</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">s</kbd></td><td style="border:none;">Toggle search</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">j/k</kbd></td><td style="border:none;">Navigate table rows</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">e</kbd></td><td style="border:none;">Expand/collapse all</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">p</kbd></td><td style="border:none;">Print report</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">1-6</kbd></td><td style="border:none;">Jump to section</td></tr>' +
                  '<tr><td style="padding:4px 12px 4px 0;border:none;"><kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-family:monospace;color:#111827;">Esc</kbd></td><td style="border:none;">Close modals</td></tr>' +
                  '</table>' +
                  '<button onclick="this.parentElement.parentElement.remove()" style="margin-top:16px;padding:6px 16px;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;">Close</button>' +
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
                  var cellColor = cells[i].style.color || '#111827';
                  html += '<div class="page-detail-card">' +
                      '<div class="detail-label">' + headerText + '</div>' +
                      '<div class="detail-value" style="color:' + cellColor + ';">' + cellValue + '</div>' +
                      '</div>';
              }
              html += '</div>';
              html += '<p style="margin-top:16px;font-size:12px;color:#9ca3af;">Double-click any row to view details</p>';

              body.innerHTML = html;
              modal.classList.add('active');
          });
      })();

      // === URL Search Highlight ===
      (function() {
          var urlFilter = document.getElementById('urlFilter');
          if (!urlFilter) return;

          var originalUrlTexts = [];
          var urlCells = document.querySelectorAll('#pagesTable tbody td:nth-child(2)');
          urlCells.forEach(function(cell) {
              originalUrlTexts.push(cell.innerHTML);
          });

          urlFilter.addEventListener('input', function() {
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

      // === Table Pagination ===
      (function() {
          var table = document.querySelector('#pagesTable');
          if (!table) return;
          var tbody = table.querySelector('tbody');
          if (!tbody) return;
          var allRows = Array.from(tbody.querySelectorAll('tr'));
          if (allRows.length <= 100) return; // Only paginate for 100+ rows

          var pageSize = 100;
          var currentPage = 1;
          var totalPages = Math.ceil(allRows.length / pageSize);

          // Create pagination container
          var pag = document.createElement('div');
          pag.className = 'pagination';
          table.parentNode.insertBefore(pag, table.nextSibling);

          function render() {
              allRows.forEach(function(row, i) {
                  var start = (currentPage - 1) * pageSize;
                  var end = start + pageSize;
                  row.style.display = (i >= start && i < end) ? '' : 'none';
              });

              // Build pagination buttons
              var html = '';
              html += '<button ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">&laquo; Prev</button>';

              var startPage = Math.max(1, currentPage - 2);
              var endPage = Math.min(totalPages, startPage + 4);
              startPage = Math.max(1, endPage - 4);

              for (var p = startPage; p <= endPage; p++) {
                  html += '<button class="' + (p === currentPage ? 'active' : '') + '" data-page="' + p + '">' + p + '</button>';
              }

              html += '<span class="page-info">' + allRows.length + ' pages</span>';
              html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">Next &raquo;</button>';

              pag.innerHTML = html;
          }

          pag.addEventListener('click', function(e) {
              var btn = e.target.closest('button');
              if (!btn || btn.disabled) return;
              currentPage = parseInt(btn.dataset.page, 10);
              render();
              table.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });

          render();
      })();

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

                  var table = document.querySelector('#pagesTable');
                  if (!table) return;
                  var rows = table.querySelectorAll('tbody tr');
                  var visible = 0;
                  rows.forEach(function(row) {
                      var show = preset.filter(row);
                      row.style.display = show ? '' : 'none';
                      if (show) visible++;
                  });
                  var fc = document.getElementById('filterCount');
                  if (fc) {
                      fc.textContent = idx > 0 ? 'Showing ' + visible + ' of ' + rows.length + ' pages' : '';
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
                  } catch(e) {}
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
                  badge.style.cssText = 'display:inline-block;margin-left:8px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;';
                  ts.parentNode.appendChild(badge);
              }
              if (days > 7) {
                  badge.textContent = ago + ' - consider re-running';
                  badge.style.background = '#fef3c7';
                  badge.style.color = '#92400e';
              } else if (days > 0) {
                  badge.textContent = ago;
                  badge.style.background = '#dbeafe';
                  badge.style.color = '#1e40af';
              } else {
                  badge.textContent = ago;
                  badge.style.background = '#d1fae5';
                  badge.style.color = '#065f46';
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
                  var cards = document.querySelectorAll('.issue-card');
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

module.exports = { getScripts };
