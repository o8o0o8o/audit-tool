/**
 * HTML Report Utilities
 * Helper functions for generating HTML reports
 */

import { METRIC_INFO, SIGNAL_CATEGORIES, getSignalInfo, formatSignalValue, isSignalGood } from './metrics-metadata';
import type { PageInfo, HeadingCount } from '../types';
import { formatBytes, escapeHtml } from '../utils';

/**
 * Get status badge color based on HTTP status code
 * @param {number} status - HTTP status code
 * @returns {string} Color hex code
 */
function getStatusColor(status: number) {
  if (status === 200) return 'var(--color-status-2xx)';
  if (status >= 300 && status < 400) return 'var(--color-status-3xx)';
  if (status >= 400 && status < 500) return 'var(--color-status-4xx)';
  return 'var(--color-status-5xx)';
}

/**
 * Get metric color based on threshold
 * @param {*} value - Metric value
 * @param {number} threshold - Threshold value
 * @param {boolean} isInverse - If true, lower values are better
 * @returns {string} Color hex code
 */
function getMetricColor(value: unknown, threshold: number, isInverse: boolean = false): string {
  if (value === null || value === undefined || value === 'N/A') return 'var(--color-text-disabled)';

  const numValue = parseFloat(String(value));
  if (isNaN(numValue)) return 'var(--color-text-disabled)';

  if (isInverse) {
    // For metrics where lower is better
    if (numValue <= threshold) return 'var(--color-success)'; // Good
    if (numValue <= threshold * 1.5) return 'var(--color-warning)'; // Warning
    return 'var(--color-error)'; // Bad
  } else {
    // For metrics where higher is better
    if (numValue >= threshold) return 'var(--color-success)';
    if (numValue >= threshold * 0.8) return 'var(--color-warning)';
    return 'var(--color-error)';
  }
}

/**
 * Get text length color
 * @param {number} length - Text length
 * @param {number} min - Minimum recommended length
 * @param {number} max - Maximum recommended length
 * @returns {string} Color hex code
 */
function getTextLengthColor(length: number, min: number, max: number) {
  if (!length) return 'var(--color-error)';
  if (length < min) return 'var(--color-warning)';
  if (length > max) return 'var(--color-warning)';
  return 'var(--color-success)';
}

/**
 * Check if page has a specific meta tag
 * @param {Object} page - Page data object
 * @param {string} tagName - Meta tag name to check
 * @returns {boolean} True if tag exists
 */
function hasMetaTag(page: PageInfo, tagName: string): boolean {
  if (!page.meta || !Array.isArray(page.meta)) return false;
  return page.meta.some((metaObj) => metaObj[tagName] !== undefined);
}

/**
 * Get list of missing important meta tags (critical + social required)
 * @param {Object} page - Page data object
 * @returns {string[]} Array of missing tag names
 */
function getMissingMetaTags(page: PageInfo): string[] {
  // Check critical (description) and essential social tags only
  // Viewport is checked separately by MobileFriendlyAnalyzer
  const importantTags = ['description', 'og:title', 'og:image', 'twitter:card'];
  return importantTags.filter((tag) => !hasMetaTag(page, tag));
}

/**
 * Make URL clickable (wrapped in anchor tag)
 * @param {string} url - URL to make clickable
 * @returns {string} HTML anchor tag
 */
function makeUrlClickable(url: string) {
  const escapedUrl = escapeHtml(url);
  return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="ui-link">${escapedUrl}</a>`;
}

/**
 * Check if heading structure has issues (skipped levels)
 * @param {Array} headings - Array of heading objects with count property
 * @returns {boolean} True if there are structural issues
 */
function hasHeadingStructureIssue(headings: HeadingCount[] | null): boolean {
  if (!headings || !Array.isArray(headings)) return false;

  // Check for skipped levels (e.g., h1 -> h3 with no h2)
  for (let i = 0; i < headings.length - 1; i++) {
    const current = headings[i];
    const next = headings[i + 1];

    // If current level has no tags but next level does, that's a skip
    if (current.count === 0 && next.count > 0) {
      // Check if there's any earlier level with tags
      const hasEarlierTags = headings.slice(0, i).some((h) => h.count > 0);
      if (hasEarlierTags) {
        return true; // Found a gap
      }
    }
  }
  return false;
}

/**
 * Generate tooltip text for metrics
 * @param {*} value - Metric value
 * @param {number} threshold - Threshold value
 * @param {string} metricName - Name of the metric
 * @param {string} unit - Unit suffix (e.g., 'ms')
 * @param {boolean} isInverse - If true, lower values are better
 * @returns {string} Tooltip text or empty string
 */
function getMetricTooltip(
  value: unknown,
  threshold: number,
  metricName: string,
  unit: string = '',
  isInverse: boolean = false,
): string {
  if (value === null || value === undefined || value === 'N/A') return '';

  const numValue = parseFloat(String(value));
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

/**
 * Generate tooltip text for text length
 * @param {number} length - Text length
 * @param {number} min - Minimum recommended length
 * @param {number} max - Maximum recommended length
 * @param {string} fieldName - Name of the field
 * @returns {string} Tooltip text or empty string
 */
function getTextLengthTooltip(length: number, min: number, max: number, fieldName: string) {
  if (!length) return `Error: ${fieldName} is missing`;
  if (length < min) return `Warning: ${fieldName} is too short (${length} chars, recommended: ${min}-${max})`;
  if (length > max) return `Warning: ${fieldName} is too long (${length} chars, recommended: ${min}-${max})`;
  return '';
}

/**
 * Get severity badge HTML
 * @param {string} severity - Severity level (CRITICAL, HIGH, MEDIUM, LOW)
 * @returns {string} HTML for severity badge
 */
function getSeverityBadge(severity: string) {
  const classMap: Record<string, string> = {
    CRITICAL: 'ui-badge--critical',
    HIGH: 'ui-badge--high',
    MEDIUM: 'ui-badge--medium',
    LOW: 'ui-badge--low',
  };

  const badgeClass = classMap[severity] || classMap.MEDIUM;
  return `<span class="ui-badge ${badgeClass}">${severity}</span>`;
}

/**
 * Get score color based on value
 * @param {number} score - Score value (0-100)
 * @returns {string} Color hex code
 */
function getScoreColor(score: number) {
  if (score >= 90) return 'var(--color-score-good)';
  if (score >= 70) return 'var(--color-score-warning)';
  if (score >= 50) return 'var(--color-score-orange)';
  return 'var(--color-score-bad)';
}

/**
 * Get trend indicator HTML
 * @param {number} current - Current value
 * @param {number} previous - Previous value
 * @param {boolean} higherIsBetter - If true, positive change is good
 * @returns {string} HTML for trend indicator
 */
function getTrendIndicator(current: number, previous: number, higherIsBetter: boolean = true) {
  if (previous === null || previous === undefined) return '';

  const diff = current - previous;
  if (diff === 0) return '<span class="text-muted">→</span>';

  const isPositive = higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '↑' : '↓';
  const colorClass = isPositive ? 'text-good' : 'text-bad';
  const absValue = Math.abs(diff).toFixed(1);

  return `<span class="${colorClass} text-xs">${arrow}${absValue}</span>`;
}

/**
 * Get rich tooltip HTML for a signal using METRIC_INFO
 * @param {string} signalKey - Signal key from METRIC_INFO
 * @param {*} value - Current value
 * @returns {string} HTML tooltip content
 */
function getSignalTooltipHtml(signalKey: string, value: unknown): string {
  const info = METRIC_INFO[signalKey];
  if (!info) return '';

  let html = `<div class="signal-tooltip">`;
  html += `<div class="signal-name">${info.fullName ?? info.name}</div>`;
  html += `<div class="signal-description">${info.description}</div>`;

  if (info.note) {
    html += `<div class="signal-note">💡 ${info.note}</div>`;
  }

  if (value !== undefined && value !== null) {
    const formattedValue = formatSignalValue(signalKey, value);
    const isGood = isSignalGood(signalKey, value);
    const statusClass = isGood === true ? 'good' : isGood === false ? 'bad' : 'neutral';
    html += `<div class="signal-value ${statusClass}">Current: ${formattedValue}</div>`;
  }

  if (info.goodLabel) {
    html += `<div class="signal-threshold">Target: ${info.goodLabel}</div>`;
  }

  if (info.learnMore) {
    html += `<div class="signal-learn-more"><a href="${info.learnMore}" target="_blank" rel="noopener">Learn more ↗</a></div>`;
  }

  html += '</div>';
  return html;
}

/**
 * Get signal status indicator (icon/badge)
 * @param {string} signalKey - Signal key
 * @param {*} value - Current value
 * @returns {string} HTML status indicator
 */
function getSignalStatusIndicator(signalKey: string, value: unknown): string {
  const isGood = isSignalGood(signalKey, value);

  if (isGood === true) {
    return '<span class="signal-status good" title="Good">✓</span>';
  } else if (isGood === false) {
    return '<span class="signal-status bad" title="Needs improvement">✗</span>';
  }
  return '<span class="signal-status neutral" title="Neutral">−</span>';
}

/**
 * Generate signal card HTML for displaying a metric with description
 * @param {string} signalKey - Signal key from METRIC_INFO
 * @param {*} value - Current value
 * @param {Object} options - Additional options
 * @returns {string} HTML for signal card
 */
function getSignalCard(signalKey: string, value: unknown, _options: Record<string, unknown> = {}): string {
  const info = METRIC_INFO[signalKey];
  if (!info) return '';

  const formattedValue = formatSignalValue(signalKey, value);
  const isGood = isSignalGood(signalKey, value);
  const statusClass = isGood === true ? 'good' : isGood === false ? 'bad' : 'neutral';

  let html = `<div class="signal-card ${statusClass}">`;
  html += `<div class="signal-card-header">`;
  html += `<span class="signal-card-name">${info.name}</span>`;
  html += getSignalStatusIndicator(signalKey, value);
  html += `</div>`;
  html += `<div class="signal-card-value">${escapeHtml(formattedValue)}</div>`;
  html += `<div class="signal-card-description">${info.description}</div>`;

  if (info.learnMore) {
    html += `<a class="signal-card-link" href="${info.learnMore}" target="_blank" rel="noopener">Learn more ↗</a>`;
  }

  html += '</div>';
  return html;
}

/**
 * Generate category section HTML with all signals
 * @param {string} categoryKey - Category key from SIGNAL_CATEGORIES
 * @param {Object} pageData - Page data with signal values
 * @returns {string} HTML for category section
 */
function getSignalCategorySection(categoryKey: string, pageData: PageInfo): string {
  const category = SIGNAL_CATEGORIES[categoryKey];
  if (!category) return '';

  let html = `<div class="signal-category">`;
  html += `<h4 class="signal-category-name">${category.name}</h4>`;
  html += `<p class="signal-category-description">${category.description}</p>`;
  html += `<div class="signal-category-grid">`;

  for (const signalKey of category.signals) {
    const value = getNestedValue(pageData as unknown as Record<string, unknown>, signalKey);
    if (value !== undefined) {
      html += getSignalCard(signalKey, value);
    }
  }

  html += '</div></div>';
  return html;
}

/**
 * Get nested value from object using dot notation or camelCase
 * @param {Object} obj - Object to search
 * @param {string} key - Key (may be nested like 'technical.cms')
 * @returns {*} Value or undefined
 */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  if (!obj) return undefined;

  // Direct match
  if (obj[key] !== undefined) return obj[key];

  // Check common nested paths based on signal type
  const pathMappings: Record<string, string[]> = {
    eeatScore: ['eeat', 'score'],
    authorPresent: ['eeat', 'hasAuthor'],
    trustSignals: ['eeat', 'trustSignals', 'length'],
    ymylPage: ['eeat', 'isYMYL'],
    wordCount: ['contentQuality', 'wordCount'],
    textToHtmlRatio: ['contentQuality', 'textToHtmlRatio'],
    readabilityScore: ['contentQuality', 'readabilityScore'],
    paragraphCount: ['contentQuality', 'paragraphCount'],
    freshnessScore: ['freshness', 'score'],
    lastModified: ['freshness', 'lastModified'],
    hasStructuredData: ['structuredData'],
    jsFramework: ['technical', 'jsFramework'],
    cms: ['technical', 'cms'],
    metaRefresh: ['technical', 'metaRefresh'],
    amp: ['technical', 'amp'],
    pwa: ['technical', 'pwa'],
    hasLazyLoading: ['technical', 'lazyLoading'],
    h1Count: ['headings', 'h1', 'length'],
    isIndexable: ['indexable'],
    hasCanonical: ['canonical'],
    hasHreflang: ['alternates', 'length'],
    hasOpenGraph: ['meta'],
    isHttps: ['url'],
    accessibilityScore: ['accessibility', 'score'],
  };

  const paths = pathMappings[key];
  if (paths) {
    let value: unknown = obj;
    for (const p of paths) {
      if (value && typeof value === 'object' && (value as Record<string, unknown>)[p] !== undefined) {
        value = (value as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return value;
  }

  return undefined;
}

/**
 * Generate CSS styles for signal components
 * @returns {string} CSS styles
 */
function getSignalStyles() {
  return `
    .signal-tooltip {
      max-width: 300px;
      padding: var(--space-4);
      font-size: var(--font-size-sm);
    }
    .signal-tooltip .signal-name {
      font-weight: var(--font-weight-semibold);
      margin-bottom: var(--space-2);
      color: var(--gray-800);
    }
    .signal-tooltip .signal-description {
      color: var(--gray-600);
      margin-bottom: var(--space-3);
      line-height: 1.4;
    }
    .signal-tooltip .signal-note {
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
      margin-bottom: var(--space-3);
      padding: var(--space-2);
      background: var(--color-bg-page);
      border-radius: var(--radius-sm);
    }
    .signal-tooltip .signal-value {
      font-weight: var(--font-weight-medium);
      padding: var(--space-1) var(--space-3);
      border-radius: var(--radius-sm);
      display: inline-block;
      margin-bottom: var(--space-2);
    }
    .signal-tooltip .signal-value.good { background: var(--color-success-bg); color: var(--color-success-text); }
    .signal-tooltip .signal-value.bad { background: var(--color-error-bg); color: var(--color-error-text); }
    .signal-tooltip .signal-value.neutral { background: var(--color-bg-surface-alt); color: var(--color-text-secondary); }
    .signal-tooltip .signal-threshold {
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
    }
    .signal-tooltip .signal-learn-more {
      margin-top: var(--space-3);
    }
    .signal-tooltip .signal-learn-more a {
      color: var(--color-link);
      text-decoration: none;
      font-size: var(--font-size-xs);
    }

    .signal-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: var(--radius-full);
      font-size: var(--font-size-xs);
    }
    .signal-status.good { background: var(--color-success-bg); color: var(--color-success-text); }
    .signal-status.bad { background: var(--color-error-bg); color: var(--color-error-text); }
    .signal-status.neutral { background: var(--color-bg-surface-alt); color: var(--color-text-muted); }

    .signal-card {
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      padding: var(--space-5);
      background: var(--color-bg-surface);
      transition: box-shadow 0.2s;
    }
    .signal-card:hover {
      box-shadow: var(--shadow-md);
    }
    .signal-card.good { border-left: 4px solid var(--color-success); }
    .signal-card.bad { border-left: 4px solid var(--color-error); }
    .signal-card.neutral { border-left: 4px solid var(--color-text-disabled); }
    .signal-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-3);
    }
    .signal-card-name {
      font-weight: var(--font-weight-semibold);
      color: var(--gray-800);
    }
    .signal-card-value {
      font-size: var(--font-size-2xl);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
      margin-bottom: var(--space-3);
    }
    .signal-card-description {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      line-height: var(--line-height-normal);
      margin-bottom: var(--space-3);
    }
    .signal-card-link {
      color: var(--color-link);
      text-decoration: none;
      font-size: var(--font-size-xs);
    }

    .signal-category {
      margin-bottom: var(--space-8);
    }
    .signal-category-name {
      font-size: var(--font-size-lg);
      font-weight: var(--font-weight-semibold);
      color: var(--gray-800);
      margin-bottom: var(--space-1);
    }
    .signal-category-description {
      color: var(--color-text-muted);
      font-size: var(--font-size-base);
      margin-bottom: var(--space-5);
    }
    .signal-category-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: var(--space-5);
    }
  `;
}

/**
 * Get info icon HTML with tooltip for a signal
 * @param {string} signalKey - Signal key
 * @returns {string} HTML for info icon with tooltip
 */
function getSignalInfoIcon(signalKey: string) {
  const info = METRIC_INFO[signalKey];
  if (!info) return '';

  const tooltip = escapeHtml(info.description);
  return `<span class="info-icon" title="${tooltip}" data-signal="${signalKey}">ⓘ</span>`;
}

export {
  escapeHtml,
  formatBytes,
  getStatusColor,
  getMetricColor,
  getTextLengthColor,
  hasMetaTag,
  getMissingMetaTags,
  makeUrlClickable,
  hasHeadingStructureIssue,
  getMetricTooltip,
  getTextLengthTooltip,
  getSeverityBadge,
  getScoreColor,
  getTrendIndicator, // New signal-aware functions
  getSignalTooltipHtml,
  getSignalStatusIndicator,
  getSignalCard,
  getSignalCategorySection,
  getSignalStyles,
  getSignalInfoIcon, // Re-export from metrics-metadata
  METRIC_INFO,
  SIGNAL_CATEGORIES,
  getSignalInfo,
  formatSignalValue,
  isSignalGood,
};
