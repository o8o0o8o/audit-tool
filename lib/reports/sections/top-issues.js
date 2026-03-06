/**
 * Top Issues Section
 * Displays top issues prioritized by severity
 */

const { escapeHtml } = require('../html-utils');

/**
 * Educational context for common SEO issues
 * Provides "Why this matters" explanations and fix guidance
 */
const ISSUE_EDUCATION = {
  'missing meta description': {
    why: 'Meta descriptions appear in search results and directly affect click-through rates. Pages without them may show random page text.',
    learnMore: 'https://developers.google.com/search/docs/appearance/snippet',
  },
  'missing title': {
    why: 'Page titles are the strongest on-page ranking signal and the clickable headline in search results.',
    learnMore: 'https://developers.google.com/search/docs/appearance/title-link',
  },
  'title too short': {
    why: 'Short titles miss keyword opportunities and may not be descriptive enough for users in SERPs.',
    learnMore: 'https://developers.google.com/search/docs/appearance/title-link',
  },
  'title too long': {
    why: 'Titles over ~60 characters get truncated in search results, hiding important information.',
    learnMore: 'https://developers.google.com/search/docs/appearance/title-link',
  },
  'missing canonical': {
    why: 'Without a canonical URL, search engines may index duplicate versions of your page, diluting ranking signals.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  },
  'missing h1': {
    why: 'The H1 tag signals the main topic of a page to search engines and screen readers.',
    learnMore: 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide',
  },
  'multiple h1': {
    why: 'Multiple H1 tags can confuse search engines about the primary topic. Use one H1 per page.',
    learnMore: 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide',
  },
  'missing alt text': {
    why: 'Alt text is essential for accessibility (screen readers) and helps search engines understand image content.',
    learnMore: 'https://developers.google.com/search/docs/appearance/google-images',
  },
  'duplicate title': {
    why: 'Duplicate titles compete with each other in search results and signal thin content to search engines.',
    learnMore: 'https://developers.google.com/search/docs/appearance/title-link',
  },
  'duplicate description': {
    why: 'Duplicate descriptions reduce uniqueness signals. Each page should have a unique, compelling description.',
    learnMore: 'https://developers.google.com/search/docs/appearance/snippet',
  },
  'slow ttfb': {
    why: 'Time to First Byte over 800ms signals slow server response, harming Core Web Vitals and user experience.',
    learnMore: 'https://web.dev/articles/ttfb',
  },
  'lcp': {
    why: 'Largest Contentful Paint over 2.5s means users wait too long to see the main content. It is a Core Web Vital.',
    learnMore: 'https://web.dev/articles/lcp',
  },
  'cls': {
    why: 'Cumulative Layout Shift over 0.1 means elements move unexpectedly, frustrating users. It is a Core Web Vital.',
    learnMore: 'https://web.dev/articles/cls',
  },
  'heading structure': {
    why: 'Skipped heading levels (e.g., H1 to H3) break document outline for screen readers and confuse search engines.',
    learnMore: 'https://www.w3.org/WAI/tutorials/page-structure/headings/',
  },
  'not in sitemap': {
    why: 'Pages not in your sitemap may be discovered slower or missed entirely by search engine crawlers.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview',
  },
  'broken link': {
    why: 'Broken links (404s) waste crawl budget, harm user experience, and lose any link equity passed to the page.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors',
  },
  'noindex': {
    why: 'Pages with noindex are excluded from search results. Ensure this is intentional for each page.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/block-indexing',
  },
  'mixed content': {
    why: 'HTTP resources on HTTPS pages trigger browser warnings and may be blocked, breaking page functionality.',
    learnMore: 'https://web.dev/articles/what-is-mixed-content',
  },
  'missing hreflang': {
    why: 'Without hreflang tags, search engines may show the wrong language version to users in different countries.',
    learnMore: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  },
  'render-blocking': {
    why: 'Render-blocking CSS and JS delay first paint. Defer or inline critical resources for faster loading.',
    learnMore: 'https://web.dev/articles/render-blocking-resources',
  },
  'missing structured data': {
    why: 'Schema.org markup helps search engines understand your content and can enable rich results (stars, FAQs, etc.).',
    learnMore: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
  },
};

/**
 * Find matching educational context for an issue
 * @param {string} issueText - The issue text to match
 * @returns {Object|null} Education data or null
 */
function findEducation(issueText) {
  const lower = issueText.toLowerCase();
  for (const [pattern, data] of Object.entries(ISSUE_EDUCATION)) {
    if (lower.includes(pattern)) return data;
  }
  return null;
}

// Patterns that indicate crawler/infrastructure errors, not website issues
const CRAWLER_ERROR_PATTERNS = [
  'TimeoutError',
  'Target page, context or browser has been closed',
  'page.goto:',
  'net::ERR_',
  'NS_ERROR_',
  'Navigation failed',
  'Protocol error',
  'Session closed',
  'Connection refused',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
];

/**
 * Check if an issue is a crawler error (not a website issue)
 * @param {string} issue - Issue text
 * @returns {boolean}
 */
function isCrawlerError(issue) {
  return CRAWLER_ERROR_PATTERNS.some(pattern => issue.includes(pattern));
}

/**
 * Generate the top issues section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the top issues section
 */
function getTopIssues(data) {
  const { jsonData } = data;
  const bySeverity = jsonData.analysis?.bySeverity || {};

  const allIssues = [
    ...(bySeverity.critical || []).map(issue => ({ issue, severity: 'critical', severityLabel: 'Critical' })),
    ...(bySeverity.high || []).map(issue => ({ issue, severity: 'high', severityLabel: 'High' })),
    ...(bySeverity.medium || []).map(issue => ({ issue, severity: 'medium', severityLabel: 'Medium' })),
    ...(bySeverity.low || []).map(issue => ({ issue, severity: 'low', severityLabel: 'Low' }))
  ].filter(item => !isCrawlerError(item.issue)); // Filter out crawler errors

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

      ${topIssues.map((item, index) => getIssueCard(item, index, jsonData)).join('')}
    </div>
  `;
}

/**
 * Generate a single issue card
 * @param {Object} item - Issue item
 * @param {number} index - Card index
 * @param {Object} jsonData - Full JSON data for accessing details
 * @returns {string} HTML string for the issue card
 */
function getIssueCard(item, index, jsonData) {
  // Strip severity suffix from issue key (format: "Error message [severity]")
  const issueKey = item.issue.replace(/ \[(critical|high|medium|low)\]$/i, '');
  const details = jsonData.analysis?.details?.[issueKey] || {};
  const affectedCount = details.examples?.length || 0;

  const totalCount = details.count || affectedCount;
  const VISIBLE_COUNT = 5;
  const examplesHtml = details.examples && details.examples.length > 0 ? `
    <div class="affected-pages">
      <strong>Affected locations (${totalCount}):</strong>
      <div class="issue-examples-list" style="margin-top: 5px;">
        ${details.examples.slice(0, VISIBLE_COUNT).map(ex => `<div class="issue-example-item">${ex}</div>`).join('')}
        ${details.examples.length > VISIBLE_COUNT ? `
          <div class="issue-examples-hidden" id="issue-more-${index}" style="display:none;">
            ${details.examples.slice(VISIBLE_COUNT).map(ex => `<div class="issue-example-item">${ex}</div>`).join('')}
          </div>
          <button class="issue-toggle-btn" onclick="var el=document.getElementById('issue-more-${index}');var showing=el.style.display!=='none';el.style.display=showing?'none':'block';this.textContent=showing?'Show all ${details.examples.length} examples...':'Show less';">Show all ${details.examples.length} examples...</button>
          ${totalCount > details.examples.length ? `<div style="opacity: 0.6; font-size: 12px; margin-top: 2px;">(${totalCount} total occurrences, showing ${details.examples.length} examples)</div>` : ''}
        ` : totalCount > details.examples.length ? `<div style="opacity: 0.6; font-size: 12px; margin-top: 2px;">(${totalCount} total occurrences, showing ${details.examples.length} examples)</div>` : ''}
      </div>
    </div>
  ` : '';

  const education = findEducation(issueKey);
  const educationHtml = education ? `
    <div class="issue-education">
      <details>
        <summary class="education-toggle">Why this matters</summary>
        <p class="education-text">${education.why}</p>
        ${education.learnMore ? `<a href="${education.learnMore}" target="_blank" rel="noopener noreferrer" class="education-link">Learn more &rarr;</a>` : ''}
      </details>
    </div>
  ` : '';

  return `
    <div class="issue-card">
      <div class="issue-header">
        <div class="issue-title">${index + 1}. ${escapeHtml(issueKey)}</div>
        <div class="issue-badges">
          <span class="issue-badge-item">${item.severityLabel}</span>
          ${totalCount > 0 ? `<span class="issue-badge-item">${totalCount} affected</span>` : ''}
        </div>
      </div>

      ${educationHtml}
      ${examplesHtml}
    </div>
  `;
}

module.exports = { getTopIssues };
