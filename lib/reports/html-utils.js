/**
 * HTML Report Utilities
 * Helper functions for generating HTML reports
 */

const {
  METRIC_INFO,
  SIGNAL_CATEGORIES,
  getSignalInfo,
  getSignalTooltip,
  formatSignalValue,
  isSignalGood,
} = require('./metrics-metadata');

/**
 * Escape HTML to prevent XSS
 * @param {*} unsafe - Value to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted size string
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get status badge color based on HTTP status code
 * @param {number} status - HTTP status code
 * @returns {string} Color hex code
 */
function getStatusColor(status) {
  if (status === 200) return '#10b981';
  if (status >= 300 && status < 400) return '#3b82f6';
  if (status >= 400 && status < 500) return '#f59e0b';
  return '#ef4444';
}

/**
 * Get metric color based on threshold
 * @param {*} value - Metric value
 * @param {number} threshold - Threshold value
 * @param {boolean} isInverse - If true, lower values are better
 * @returns {string} Color hex code
 */
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

/**
 * Get text length color
 * @param {number} length - Text length
 * @param {number} min - Minimum recommended length
 * @param {number} max - Maximum recommended length
 * @returns {string} Color hex code
 */
function getTextLengthColor(length, min, max) {
  if (!length) return '#ef4444';
  if (length < min) return '#f59e0b';
  if (length > max) return '#f59e0b';
  return '#10b981';
}

/**
 * Check if page has a specific meta tag
 * @param {Object} page - Page data object
 * @param {string} tagName - Meta tag name to check
 * @returns {boolean} True if tag exists
 */
function hasMetaTag(page, tagName) {
  if (!page.meta || !Array.isArray(page.meta)) return false;
  return page.meta.some(metaObj => metaObj[tagName] !== undefined);
}

/**
 * Get list of missing important meta tags (critical + social required)
 * @param {Object} page - Page data object
 * @returns {string[]} Array of missing tag names
 */
function getMissingMetaTags(page) {
  // Check critical (description) and essential social tags only
  // Viewport is checked separately by MobileFriendlyAnalyzer
  const importantTags = ['description', 'og:title', 'og:image', 'twitter:card'];
  return importantTags.filter(tag => !hasMetaTag(page, tag));
}

/**
 * Make URL clickable (wrapped in anchor tag)
 * @param {string} url - URL to make clickable
 * @returns {string} HTML anchor tag
 */
function makeUrlClickable(url) {
  const escapedUrl = escapeHtml(url);
  return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; text-decoration: none;">${escapedUrl}</a>`;
}

/**
 * Check if heading structure has issues (skipped levels)
 * @param {Array} headings - Array of heading objects with count property
 * @returns {boolean} True if there are structural issues
 */
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

/**
 * Generate tooltip text for metrics
 * @param {*} value - Metric value
 * @param {number} threshold - Threshold value
 * @param {string} metricName - Name of the metric
 * @param {string} unit - Unit suffix (e.g., 'ms')
 * @param {boolean} isInverse - If true, lower values are better
 * @returns {string} Tooltip text or empty string
 */
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

/**
 * Generate tooltip text for text length
 * @param {number} length - Text length
 * @param {number} min - Minimum recommended length
 * @param {number} max - Maximum recommended length
 * @param {string} fieldName - Name of the field
 * @returns {string} Tooltip text or empty string
 */
function getTextLengthTooltip(length, min, max, fieldName) {
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
function getSeverityBadge(severity) {
  const colors = {
    CRITICAL: { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' },
    HIGH: { bg: '#fff7ed', text: '#c2410c', border: '#fed7aa' },
    MEDIUM: { bg: '#fffbeb', text: '#b45309', border: '#fde68a' },
    LOW: { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0' },
  };

  const color = colors[severity] || colors.MEDIUM;
  return `<span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${color.bg}; color: ${color.text}; border: 1px solid ${color.border};">${severity}</span>`;
}

/**
 * Get score color based on value
 * @param {number} score - Score value (0-100)
 * @returns {string} Color hex code
 */
function getScoreColor(score) {
  if (score >= 90) return '#10b981';
  if (score >= 70) return '#f59e0b';
  if (score >= 50) return '#f97316';
  return '#ef4444';
}

/**
 * Get trend indicator HTML
 * @param {number} current - Current value
 * @param {number} previous - Previous value
 * @param {boolean} higherIsBetter - If true, positive change is good
 * @returns {string} HTML for trend indicator
 */
function getTrendIndicator(current, previous, higherIsBetter = true) {
  if (previous === null || previous === undefined) return '';

  const diff = current - previous;
  if (diff === 0) return '<span style="color: #6b7280;">→</span>';

  const isPositive = higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '↑' : '↓';
  const color = isPositive ? '#10b981' : '#ef4444';
  const absValue = Math.abs(diff).toFixed(1);

  return `<span style="color: ${color}; font-size: 12px;">${arrow}${absValue}</span>`;
}

/**
 * Get rich tooltip HTML for a signal using METRIC_INFO
 * @param {string} signalKey - Signal key from METRIC_INFO
 * @param {*} value - Current value
 * @returns {string} HTML tooltip content
 */
function getSignalTooltipHtml(signalKey, value) {
  const info = METRIC_INFO[signalKey];
  if (!info) return '';

  let html = `<div class="signal-tooltip">`;
  html += `<div class="signal-name">${info.fullName || info.name}</div>`;
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
function getSignalStatusIndicator(signalKey, value) {
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
function getSignalCard(signalKey, value, options = {}) {
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
function getSignalCategorySection(categoryKey, pageData) {
  const category = SIGNAL_CATEGORIES[categoryKey];
  if (!category) return '';

  let html = `<div class="signal-category">`;
  html += `<h4 class="signal-category-name">${category.name}</h4>`;
  html += `<p class="signal-category-description">${category.description}</p>`;
  html += `<div class="signal-category-grid">`;

  for (const signalKey of category.signals) {
    const value = getNestedValue(pageData, signalKey);
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
function getNestedValue(obj, key) {
  if (!obj) return undefined;

  // Direct match
  if (obj[key] !== undefined) return obj[key];

  // Check common nested paths based on signal type
  const pathMappings = {
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
    let value = obj;
    for (const p of paths) {
      if (value && value[p] !== undefined) {
        value = value[p];
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
      padding: 12px;
      font-size: 13px;
    }
    .signal-tooltip .signal-name {
      font-weight: 600;
      margin-bottom: 6px;
      color: #1f2937;
    }
    .signal-tooltip .signal-description {
      color: #4b5563;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .signal-tooltip .signal-note {
      color: #6b7280;
      font-size: 12px;
      margin-bottom: 8px;
      padding: 6px;
      background: #f9fafb;
      border-radius: 4px;
    }
    .signal-tooltip .signal-value {
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
      margin-bottom: 6px;
    }
    .signal-tooltip .signal-value.good { background: #d1fae5; color: #065f46; }
    .signal-tooltip .signal-value.bad { background: #fee2e2; color: #991b1b; }
    .signal-tooltip .signal-value.neutral { background: #f3f4f6; color: #374151; }
    .signal-tooltip .signal-threshold {
      color: #6b7280;
      font-size: 12px;
    }
    .signal-tooltip .signal-learn-more {
      margin-top: 8px;
    }
    .signal-tooltip .signal-learn-more a {
      color: #2563eb;
      text-decoration: none;
      font-size: 12px;
    }

    .signal-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      font-size: 12px;
    }
    .signal-status.good { background: #d1fae5; color: #065f46; }
    .signal-status.bad { background: #fee2e2; color: #991b1b; }
    .signal-status.neutral { background: #f3f4f6; color: #6b7280; }

    .signal-card {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      background: white;
      transition: box-shadow 0.2s;
    }
    .signal-card:hover {
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .signal-card.good { border-left: 4px solid #10b981; }
    .signal-card.bad { border-left: 4px solid #ef4444; }
    .signal-card.neutral { border-left: 4px solid #9ca3af; }
    .signal-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .signal-card-name {
      font-weight: 600;
      color: #1f2937;
    }
    .signal-card-value {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 8px;
    }
    .signal-card-description {
      color: #6b7280;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .signal-card-link {
      color: #2563eb;
      text-decoration: none;
      font-size: 12px;
    }

    .signal-category {
      margin-bottom: 32px;
    }
    .signal-category-name {
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 4px;
    }
    .signal-category-description {
      color: #6b7280;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .signal-category-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 16px;
    }
  `;
}

/**
 * Get info icon HTML with tooltip for a signal
 * @param {string} signalKey - Signal key
 * @returns {string} HTML for info icon with tooltip
 */
function getSignalInfoIcon(signalKey) {
  const info = METRIC_INFO[signalKey];
  if (!info) return '';

  const tooltip = escapeHtml(info.description);
  return `<span class="info-icon" title="${tooltip}" data-signal="${signalKey}">ⓘ</span>`;
}

module.exports = {
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
  getTrendIndicator,
  // New signal-aware functions
  getSignalTooltipHtml,
  getSignalStatusIndicator,
  getSignalCard,
  getSignalCategorySection,
  getSignalStyles,
  getSignalInfoIcon,
  // Re-export from metrics-metadata
  METRIC_INFO,
  SIGNAL_CATEGORIES,
  getSignalInfo,
  formatSignalValue,
  isSignalGood,
};
