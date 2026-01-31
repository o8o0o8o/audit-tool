/**
 * CLI Summary
 * Prints a formatted summary of audit results to the console
 */

const { SEVERITY } = require('../constants');

/**
 * Print audit summary to console
 * @param {Object} results - Audit results object
 * @param {string} domainName - Domain name
 * @param {string} htmlPath - Path to HTML report
 */
function printAuditSummary(results, domainName, htmlPath) {
  const analysis = results.analysis || {};
  const summary = analysis.summary || {};
  const pageData = results.pageData || {};

  // Count issues by severity
  const criticalCount = summary.criticalCount || 0;
  const highCount = summary.highCount || 0;
  const mediumCount = summary.mediumCount || 0;
  const lowCount = summary.lowCount || 0;
  const totalIssues = summary.totalIssues || 0;

  // Page stats
  const totalPages = pageData.total || Object.keys(pageData.pages || {}).length;
  const successPages = pageData.totalWithoutError || 0;
  const failedPages = pageData.totalWithError || 0;
  const successRate = totalPages > 0 ? ((successPages / totalPages) * 100).toFixed(1) : 0;

  // Score
  const overallScore = summary.overallScore || 0;

  // Get top quick wins
  const quickWins = getTopQuickWins(analysis, 3);

  // Print summary
  console.log('\n');
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + centerText('SEO AUDIT SUMMARY', 58) + '║');
  console.log('║' + centerText(domainName, 58) + '║');
  console.log('╠' + '═'.repeat(58) + '╣');

  // Score with color indicator
  const scoreIndicator = getScoreIndicator(overallScore);
  console.log('║' + padRight(`  Overall Score: ${overallScore}/100 ${scoreIndicator}`, 58) + '║');
  console.log('║' + ' '.repeat(58) + '║');

  // Pages stats
  console.log('║' + padRight(`  Pages Crawled: ${totalPages}`, 58) + '║');
  console.log('║' + padRight(`    ✓ Successful: ${successPages} (${successRate}%)`, 58) + '║');
  if (failedPages > 0) {
    console.log('║' + padRight(`    ✗ Failed: ${failedPages}`, 58) + '║');
  }
  console.log('║' + ' '.repeat(58) + '║');

  // Issues breakdown
  console.log('║' + padRight(`  Issues Found: ${totalIssues}`, 58) + '║');
  if (criticalCount > 0) {
    console.log('║' + padRight(`    🔴 Critical: ${criticalCount}`, 58) + '║');
  }
  if (highCount > 0) {
    console.log('║' + padRight(`    🟠 High: ${highCount}`, 58) + '║');
  }
  if (mediumCount > 0) {
    console.log('║' + padRight(`    🟡 Medium: ${mediumCount}`, 58) + '║');
  }
  if (lowCount > 0) {
    console.log('║' + padRight(`    🟢 Low: ${lowCount}`, 58) + '║');
  }

  // Quick wins
  if (quickWins.length > 0) {
    console.log('║' + ' '.repeat(58) + '║');
    console.log('╠' + '═'.repeat(58) + '╣');
    console.log('║' + padRight('  Top Quick Wins:', 58) + '║');
    quickWins.forEach((win, i) => {
      const text = `  ${i + 1}. ${win.title} (${win.count} pages)`;
      console.log('║' + padRight(text.slice(0, 56), 58) + '║');
    });
  }

  // Timing
  if (results.timing && results.timing.elapsedTimeFormatted) {
    console.log('║' + ' '.repeat(58) + '║');
    console.log('║' + padRight(`  Duration: ${results.timing.elapsedTimeFormatted}`, 58) + '║');
  }

  console.log('╠' + '═'.repeat(58) + '╣');
  console.log('║' + padRight(`  Report: ${htmlPath}`, 58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');
  console.log('\n');
}

/**
 * Get top quick wins from analysis
 * @param {Object} analysis - Analysis object
 * @param {number} count - Number of quick wins to return
 * @returns {Array} Top quick wins
 */
function getTopQuickWins(analysis, count) {
  const quickWins = [];
  const details = analysis.details || {};

  // Common high-impact issues to look for
  const issuePatterns = [
    { pattern: /meta description/i, title: 'Missing meta descriptions' },
    { pattern: /title.*missing|missing.*title/i, title: 'Missing page titles' },
    { pattern: /title.*short|short.*title/i, title: 'Title too short' },
    { pattern: /title.*long|long.*title/i, title: 'Title too long' },
    { pattern: /alt.*text|missing.*alt/i, title: 'Missing image alt text' },
    { pattern: /canonical/i, title: 'Canonical URL issues' },
    { pattern: /h1.*missing|missing.*h1/i, title: 'Missing H1 tags' },
    { pattern: /multiple.*h1/i, title: 'Multiple H1 tags' },
    { pattern: /heading.*structure|heading.*hierarchy/i, title: 'Heading structure issues' },
    { pattern: /duplicate.*title/i, title: 'Duplicate titles' },
    { pattern: /duplicate.*description/i, title: 'Duplicate descriptions' },
    { pattern: /broken.*link|404/i, title: 'Broken links' },
    { pattern: /slow.*ttfb|ttfb.*slow/i, title: 'Slow server response' },
    { pattern: /lcp|largest.*contentful/i, title: 'Slow page rendering (LCP)' },
    { pattern: /cls|layout.*shift/i, title: 'Layout shift issues (CLS)' },
  ];

  // Find matching issues and count affected pages
  for (const [issueMessage, pages] of Object.entries(details)) {
    for (const { pattern, title } of issuePatterns) {
      if (pattern.test(issueMessage)) {
        const pageCount = Array.isArray(pages) ? pages.length : 1;
        const existing = quickWins.find(qw => qw.title === title);
        if (existing) {
          existing.count += pageCount;
        } else {
          quickWins.push({ title, count: pageCount });
        }
        break;
      }
    }
  }

  // Sort by count and return top N
  return quickWins
    .sort((a, b) => b.count - a.count)
    .slice(0, count);
}

/**
 * Get score indicator emoji
 * @param {number} score - Score value
 * @returns {string} Indicator string
 */
function getScoreIndicator(score) {
  if (score >= 90) return '🟢 Excellent';
  if (score >= 70) return '🟡 Good';
  if (score >= 50) return '🟠 Needs Work';
  return '🔴 Poor';
}

/**
 * Center text in given width
 * @param {string} text - Text to center
 * @param {number} width - Total width
 * @returns {string} Centered text
 */
function centerText(text, width) {
  const padding = Math.max(0, width - text.length);
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * Pad text to the right
 * @param {string} text - Text to pad
 * @param {number} width - Total width
 * @returns {string} Padded text
 */
function padRight(text, width) {
  if (text.length >= width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

module.exports = { printAuditSummary };
