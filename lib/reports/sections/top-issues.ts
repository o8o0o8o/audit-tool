/**
 * Top Issues Section
 * Displays top issues prioritized by severity
 */

import { isCrawlerError } from '../../constants';
import { stripIssueSeverity } from '../../utils';
import { escapeHtml, exampleHtml, renderExpandableList } from '../html-utils';
import { extractDetails, extractBySeverity } from '../data-processor';
import { extractComparisonLabels } from '../comparison-helpers';
import type { ReportSectionData, ComparisonData } from '../../types';

/**
 * Flatten a bySeverity map into an array of issue objects, filtering out crawler errors.
 */
function flattenSeverityIssues(bySeverity: Record<string, string[]>) {
  return (
    [
      ...(bySeverity.critical ?? []).map((issue: string) => ({
        issue,
        severity: 'critical',
        severityLabel: 'Critical',
      })),
      ...(bySeverity.high ?? []).map((issue: string) => ({ issue, severity: 'high', severityLabel: 'High' })),
      ...(bySeverity.medium ?? []).map((issue: string) => ({ issue, severity: 'medium', severityLabel: 'Medium' })),
      ...(bySeverity.low ?? []).map((issue: string) => ({ issue, severity: 'low', severityLabel: 'Low' })),
    ] as { issue: string; severity: string; severityLabel: string }[]
  ).filter((item) => !isCrawlerError(item.issue));
}

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
  lcp: {
    why: 'Largest Contentful Paint over 2.5s means users wait too long to see the main content. It is a Core Web Vital.',
    learnMore: 'https://web.dev/articles/lcp',
  },
  cls: {
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
  noindex: {
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
  'unused javascript': {
    why: 'Unused JavaScript increases page load time and wastes bandwidth. It delays interactivity and hurts Core Web Vitals (INP/LCP).',
    learnMore: 'https://web.dev/articles/remove-unused-code',
  },
  'unused css': {
    why: 'Unused CSS blocks rendering and increases page weight. Removing it improves First Contentful Paint and overall load speed.',
    learnMore: 'https://web.dev/articles/unused-css-rules',
  },
  'language mismatch': {
    why: 'When declared and detected languages differ, search engines may show your page to the wrong audience, reducing relevance.',
    learnMore: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  },
  'broken outbound': {
    why: 'Broken external links frustrate users, reduce trust signals, and may cause search engines to question content quality.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors',
  },
  'near-duplicate': {
    why: 'Near-duplicate pages compete with each other in search results, diluting ranking signals and confusing crawlers.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  },
  'similar content': {
    why: 'Pages with highly similar content waste crawl budget and may be filtered from search results as duplicates.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  },
  pagerank: {
    why: 'Pages with very low internal PageRank receive little link equity, making them harder to rank in search results.',
    learnMore: 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide',
  },
  cta: {
    why: 'Pages without calls-to-action miss conversion opportunities. Every content page should guide users toward a next step.',
    learnMore: null,
  },
  'code coverage': {
    why: 'High unused code ratios indicate bloated bundles that slow down page loads and waste user bandwidth.',
    learnMore: 'https://web.dev/articles/remove-unused-code',
  },
};

/**
 * Find matching educational context for an issue
 * @param {string} issueText - The issue text to match
 * @returns {Object|null} Education data or null
 */
function findEducation(issueText: string) {
  const lower = issueText.toLowerCase();
  for (const [pattern, data] of Object.entries(ISSUE_EDUCATION)) {
    if (lower.includes(pattern)) return data;
  }
  return null;
}

/**
 * Generate the top issues section
 * @param {Object} data - Report data
 * @param {Object} data.jsonData - Full audit JSON data
 * @returns {string} HTML string for the top issues section
 */
function getTopIssues(data: ReportSectionData) {
  if (data.comparison) {
    return getComparisonTopIssues(data.jsonData, data.comparison);
  }

  const { jsonData } = data;
  const bySeverity = extractBySeverity(jsonData);

  const allIssues = flattenSeverityIssues(bySeverity);

  const topIssues = allIssues.slice(0, 10);

  if (topIssues.length === 0) return '';

  return `
    <div class="top-issues-section">
      <div class="wins-issues-title">
        <span>⚠️</span>
        <span>Top ${topIssues.length} Issues to Address</span>
      </div>

      <p class="text-center mb-7 text-base" style="opacity: 0.95;">
        Prioritized by severity - fix these first
      </p>

      ${topIssues.map((item: { issue: string; severity: string; severityLabel: string }, index: number) => getIssueCard(item, index, jsonData)).join('')}
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
function getIssueCard(
  item: { issue: string; severity: string; severityLabel: string },
  index: number,
  jsonData: Record<string, unknown>,
  extraBadge = '',
) {
  // Strip severity suffix from issue key (format: "Error message [severity]")
  const issueKey = stripIssueSeverity(item.issue);
  const detailsMap = extractDetails(jsonData);
  const details = detailsMap[issueKey] ?? ({} as Record<string, unknown>);
  const examples = (details.examples ?? []) as string[];
  const affectedCount = examples.length;

  const totalCount = (details.count as number) || affectedCount;
  const VISIBLE_COUNT = 5;
  const examplesHtml =
    examples.length > 0
      ? `
    <div class="affected-pages">
      <strong>Affected locations (${totalCount}):</strong>
      <div class="issue-examples-list mt-2">
        ${renderExpandableList(
          examples,
          (ex: string) => `<div class="issue-example-item">${exampleHtml(ex)}</div>`,
          `issue-more-${index}`,
          VISIBLE_COUNT,
          totalCount,
        )}
      </div>
    </div>
  `
      : '';

  const education = findEducation(issueKey);
  const educationHtml = education
    ? `
    <div class="issue-education">
      <details>
        <summary class="education-toggle">Why this matters</summary>
        <p class="education-text">${education.why}</p>
        ${education.learnMore ? `<a href="${education.learnMore}" target="_blank" rel="noopener noreferrer" class="education-link">Learn more &rarr;</a>` : ''}
      </details>
    </div>
  `
    : '';

  return `
    <div class="issue-card">
      <div class="issue-header">
        <div class="issue-title">${index + 1}. ${escapeHtml(issueKey)}${extraBadge}</div>
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

function getComparisonTopIssues(jsonData: Record<string, unknown>, comparison: ComparisonData) {
  const extractIssues = (data: Record<string, unknown>) => {
    return flattenSeverityIssues(extractBySeverity(data));
  };

  const originIssues = extractIssues(jsonData);
  const compareIssues = extractIssues(comparison.compareJsonData);

  const originSet = new Set(originIssues.map((i) => stripIssueSeverity(i.issue)));
  const compareSet = new Set(compareIssues.map((i) => stripIssueSeverity(i.issue)));

  // Merge all unique issues
  const allIssueKeys = new Set([...originIssues.map((i) => i.issue), ...compareIssues.map((i) => i.issue)]);
  const mergedIssues: Array<{ issue: string; severity: string; severityLabel: string; status: string }> = [];

  for (const issue of allIssueKeys) {
    const originItem = originIssues.find((i) => i.issue === issue);
    const compareItem = compareIssues.find((i) => i.issue === issue);
    const item = originItem ?? compareItem!;
    const key = stripIssueSeverity(issue);

    let status = 'both';
    if (originSet.has(key) && !compareSet.has(key)) status = 'fixed';
    else if (!originSet.has(key) && compareSet.has(key)) status = 'new';

    mergedIssues.push({ ...item, status });
  }

  const topIssues = mergedIssues.slice(0, 10);
  if (topIssues.length === 0) return '';

  const { originLabel, compareLabel } = extractComparisonLabels(comparison);

  return `
    <div class="top-issues-section">
      <div class="wins-issues-title">
        <span>⚠️</span>
        <span>Top ${topIssues.length} Issues (Comparison)</span>
      </div>

      <p class="text-center mb-7 text-base" style="opacity: 0.95;">
        Prioritized by severity — showing issues across both <strong>${escapeHtml(originLabel)}</strong> and <strong>${escapeHtml(compareLabel)}</strong>
      </p>

      ${topIssues
        .map((item, index) => {
          const statusBadge =
            item.status === 'fixed'
              ? `<span class="ui-badge ui-badge--success" style="margin-left: var(--space-3);">FIXED in ${escapeHtml(compareLabel)}</span>`
              : item.status === 'new'
                ? `<span class="ui-badge ui-badge--error" style="margin-left: var(--space-3);">NEW in ${escapeHtml(compareLabel)}</span>`
                : '';
          return getIssueCard(item, index, jsonData, statusBadge);
        })
        .join('')}
    </div>
  `;
}

export { getTopIssues };
