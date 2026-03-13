/**
 * Pages Table Section
 * Displays the detailed pages data table with all metrics
 */

import { THRESHOLDS, METRIC_INFO } from '../metrics-metadata';
import {
  escapeHtml,
  formatBytes,
  getStatusColor,
  getMetricColor,
  getTextLengthColor,
  getMissingMetaTags,
  hasHeadingStructureIssue,
  getMetricTooltip,
  getTextLengthTooltip,
} from '../html-utils';
import { shortDomain } from '../comparison-helpers';
import type {
  PageInfo,
  ReportSectionData,
  HeadingCount,
  AccessibilityAnalysis,
  ContentQualityAnalysis,
  ComparisonData,
} from '../../types';

interface CrUXMetric {
  percentiles?: { p75?: number };
  distribution?: { good?: number; needsImprovement?: number; poor?: number };
}

interface CrUXData {
  metrics?: Record<string, CrUXMetric>;
  target?: string;
  targetType?: string;
}

/**
 * Get column header with description tooltip from METRIC_INFO
 * @param {string} signalKey - Key from METRIC_INFO
 * @param {string} displayName - Optional override for display name
 * @param {string} thresholdText - Text to show as threshold
 * @returns {string} HTML for header cell
 */
function getColumnHeader(signalKey: string, displayName: string | null = null, thresholdText: string | null = null) {
  const info = METRIC_INFO[signalKey];
  const name = displayName || (info ? info.name : signalKey);
  const description = info ? info.description : '';
  const threshold = thresholdText || (info ? info.goodLabel : '');

  return `
    <th class="sortable" data-type="number" title="${escapeHtml(description)}">
      ${escapeHtml(name)}
      ${info?.learnMore ? `<a href="${info.learnMore}" target="_blank" class="learn-more-link" title="Learn more">ⓘ</a>` : ''}
      ${threshold ? `<span class="threshold">${escapeHtml(threshold)}</span>` : ''}
    </th>
  `;
}

/**
 * Performance column header with optional "Lab" label when CrUX data is present
 */
function getPerfColumnHeader(signalKey: string, displayName: string, thresholdText: string, hasCrux: boolean) {
  const info = METRIC_INFO[signalKey];
  const description = info ? info.description : '';

  return `
    <th class="sortable" data-type="number" title="${escapeHtml(description)}">
      ${escapeHtml(displayName)} ${hasCrux ? '<span style="display:block;font-size:9px;font-weight:400;color:#6b7280;">🔬 Lab</span>' : ''}
      ${info?.learnMore ? `<a href="${info.learnMore}" target="_blank" class="learn-more-link" title="Learn more">ⓘ</a>` : ''}
      <span class="threshold">${escapeHtml(thresholdText)}</span>
    </th>
  `;
}

/**
 * Generate a CrUX baseline row showing field data p75 values from real users.
 * Displayed as the first row in the table for easy comparison against per-page lab data.
 */
function getCrUXBaselineRow(cruxData: CrUXData) {
  const metrics = cruxData.metrics || {};
  const targetLabel = cruxData.targetType === 'url' ? 'URL-level' : 'Origin-level';

  function formatCrUXValue(metric: string): string {
    const data = metrics[metric];
    const p75 = data?.percentiles?.p75;
    if (p75 == null || isNaN(Number(p75))) return '<span style="color:#9ca3af;">N/A</span>';
    const threshold: Record<string, number> = { TTFB: 800, FCP: 1800, LCP: 2500, CLS: 0.1, INP: 200 };
    const val = Number(p75);
    const limit = threshold[metric] || 0;
    const passing = metric === 'CLS' ? val <= limit : val <= limit;
    const color = passing ? '#10b981' : '#ef4444';
    const display = metric === 'CLS' ? val.toFixed(2) : `${Math.round(val)}ms`;
    return `<span style="color:${color};font-weight:600;">${display}</span>`;
  }

  // Count columns after perf columns by reading the rest of the header (Page Size onwards)
  // Page Size, Requests, Canonical, H1, H2, H Structure, Missing Meta, Alternates, Links w/o Text,
  // Security Score, Missing Headers, Insecure Cookies, Mixed Content, Forms w/o CSRF, Inline Scripts,
  // Cache Score, CDN, Cached Static, Uncached Static, Service Worker,
  // Images (4 cells from getImageOptimizationCells), Render Blocking, Uncompressed, Unminified,
  // A11y Score, ARIA, Form Labels, Landmarks, Focus Issues,
  // Content Score, Word Count, Text/HTML, Readability, Top Keywords, Language, PageRank, CTAs, JS Unused, Broken Links, Main Words
  // This is complex - just use colspan for the rest
  const postColumns = 43; // Page Size through Main Words

  return `
    <tr style="background: linear-gradient(90deg, #eff6ff 0%, #f0fdf4 100%); border-bottom: 2px solid #3b82f6;">
        <td style="text-align:center;font-size:11px;color:#3b82f6;font-weight:700;">🌐</td>
        <td colspan="11" style="font-size:12px;font-weight:600;color:#1d4ed8;padding:8px;">
            CrUX Field Data (${escapeHtml(targetLabel)}) — Real user p75 values
            <span style="font-weight:400;color:#6b7280;font-size:11px;margin-left:8px;">${escapeHtml(cruxData.target || '')}</span>
        </td>
        <td class="metric-cell" style="text-align:center;font-size:12px;" title="CrUX TTFB p75 from real users">${formatCrUXValue('TTFB')}</td>
        <td class="metric-cell" style="text-align:center;font-size:12px;" title="CrUX FCP p75 from real users">${formatCrUXValue('FCP')}</td>
        <td class="metric-cell" style="text-align:center;font-size:12px;" title="CrUX LCP p75 from real users">${formatCrUXValue('LCP')}</td>
        <td class="metric-cell" style="text-align:center;font-size:12px;" title="CrUX CLS p75 from real users">${formatCrUXValue('CLS')}</td>
        <td class="metric-cell" style="text-align:center;font-size:12px;" title="CrUX INP p75 from real users">${formatCrUXValue('INP')}</td>
        <td colspan="${postColumns}" style="font-size:11px;color:#6b7280;text-align:left;padding-left:10px;">
            <span style="background:#dbeafe;color:#1d4ed8;padding:2px 6px;border-radius:3px;font-size:10px;">FIELD DATA</span>
        </td>
    </tr>`;
}

/**
 * Generate the pages table section
 * @param {Object} data - Report data
 * @param {Array} data.pages - Array of page data
 * @param {boolean} data.hasPerformanceMetrics - Whether performance metrics are available
 * @returns {string} HTML string for the pages table
 */
function getPagesTable(data: ReportSectionData) {
  if (data.comparison) {
    return getComparisonPagesTable(data, data.comparison);
  }

  const { pages, hasPerformanceMetrics = false } = data;
  const cruxData = (data.jsonData?.cruxData || null) as CrUXData | null;
  const hasCrux = !!cruxData?.metrics;

  return `
    <div class="table-filters" style="margin-bottom: 15px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 8px;">
            <label for="pageSearch" style="font-weight: 600; color: #374151;">Search:</label>
            <input type="text" id="pageSearch" placeholder="Filter by URL, title, or keyword..."
                   style="padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; width: 350px; font-size: 14px;"
                   onkeyup="filterTableBySearch(this.value)">
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
            <label for="segmentFilter" style="font-weight: 600; color: #374151;">Segment:</label>
            <select id="segmentFilter" onchange="filterTableBySegment(this.value)"
                    style="padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: white;">
                <option value="">All Segments</option>
                <option value="blog">Blog/News</option>
                <option value="product">Products</option>
                <option value="category">Categories</option>
                <option value="tag">Tags</option>
                <option value="search">Search Pages</option>
                <option value="account">Account</option>
                <option value="checkout">Checkout</option>
                <option value="legal">Legal</option>
                <option value="contact">Info Pages</option>
                <option value="media">Media</option>
                <option value="landing">Landing Pages</option>
                <option value="api">API/Technical</option>
                <option value="other">Other</option>
            </select>
        </div>
        <button onclick="clearTableFilters()" style="padding: 8px 12px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer; font-size: 14px;">
            Clear Filters
        </button>
        <span id="filterCount" style="color: #6b7280; font-size: 14px;"></span>
    </div>
    <div class="table-container">
        <table id="pagesTable">
            <thead>
                ${getTableHeader(hasPerformanceMetrics, hasCrux)}
                ${hasCrux && hasPerformanceMetrics ? getCrUXBaselineRow(cruxData!) : ''}
            </thead>
            <tbody>
                ${pages.map((page: PageInfo, index: number) => getTableRow(page, index, hasPerformanceMetrics)).join('')}
            </tbody>
        </table>
    </div>
  `;
}

/**
 * Generate the table header row with descriptions from METRIC_INFO
 */
function getTableHeader(hasPerformanceMetrics: boolean, hasCrux = false) {
  return `
    <tr>
        <th style="width: 50px; text-align: center;">#</th>
        <th class="url-col sortable" data-type="text" data-column="1">URL</th>
        <th class="sortable" data-type="text" data-column="1" title="Where this page was discovered - from sitemap or through internal links during crawl">
            Source
            <span class="threshold">Sitemap/Link</span>
        </th>
        <th class="sortable" data-type="text" title="Page segment/category based on URL pattern (blog, product, category, etc.)">
            Segment
            <span class="threshold">URL pattern</span>
        </th>
        <th class="sortable" data-type="number" data-column="2" title="${escapeHtml(METRIC_INFO.hasIncomingLinks?.description || 'Number of internal links pointing to this page. Pages without incoming links (orphans) may not be discovered by crawlers.')}">
            Incoming Links
            <span class="threshold">From other pages</span>
        </th>
        ${getColumnHeader('urlLength', 'URL Length', `≤ ${THRESHOLDS.URL_LENGTH_RECOMMENDED} chars`)}
        ${getColumnHeader('urlDepth', 'URL Depth', `≤ ${THRESHOLDS.URL_DEPTH_MAX} levels`)}
        <th class="sortable" data-type="number" title="Number of HTTP redirects before reaching final URL. Multiple redirects waste crawl budget and slow page loading.">
            Redirects
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="${escapeHtml(METRIC_INFO.hasMixedContent?.description || 'HTTP links on HTTPS pages cause mixed content warnings and may be blocked by browsers.')}">
            HTTP Links
            <span class="threshold">0 on HTTPS</span>
        </th>
        <th class="sortable" data-type="number" data-column="3" title="HTTP response status code. 200=OK, 301/302=redirect, 404=not found, 500+=server error.">Status</th>
        ${getColumnHeader('titleLength', 'Title', `${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX} chars`)}
        ${getColumnHeader('descriptionLength', 'Description', `${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX} chars`)}
        ${
          hasPerformanceMetrics
            ? `
        ${getPerfColumnHeader('ttfb', 'TTFB', `≤ ${THRESHOLDS.TTFB}ms`, hasCrux)}
        ${getPerfColumnHeader('fcp', 'FCP', `≤ ${THRESHOLDS.FCP}ms`, hasCrux)}
        ${getPerfColumnHeader('lcp', 'LCP', `≤ ${THRESHOLDS.LCP}ms`, hasCrux)}
        ${getPerfColumnHeader('cls', 'CLS', `≤ ${THRESHOLDS.CLS}`, hasCrux)}
        <th class="sortable" data-type="number" title="Interaction to Next Paint - measures responsiveness to user input. Core Web Vital since March 2024.">
            INP ${hasCrux ? '<span style="display:block;font-size:9px;font-weight:400;color:#6b7280;">🔬 Lab</span>' : ''}
            <span class="threshold">≤ ${THRESHOLDS.INP || 200}ms</span>
        </th>
        `
            : ''
        }
        ${getColumnHeader('pageSize', 'Page Size', `≤ ${formatBytes(THRESHOLDS.PAGE_SIZE)}`)}
        ${getColumnHeader('requestCount', 'Requests', `≤ ${THRESHOLDS.REQUEST_COUNT}`)}
        ${getColumnHeader('hasCanonical', 'Canonical', 'Self-referencing')}
        ${getColumnHeader('h1Count', 'H1 Tags', '= 1')}
        <th class="sortable" data-type="number" title="Number of H2 subheadings. Should be used to structure content logically. Too many may indicate content organization issues.">
            H2 Tags
            <span class="threshold">≤ ${THRESHOLDS.H2_COUNT}</span>
        </th>
        ${getColumnHeader('headingStructure', 'H Structure', 'No gaps')}
        <th class="sortable" data-type="number" title="Important meta tags that are missing (robots, og:title, og:image, twitter:card). These affect SEO and social sharing.">
            Missing Meta
            <span class="threshold">All present</span>
        </th>
        ${getColumnHeader('hreflangCount', 'Alternates', 'Count')}
        <th class="sortable" data-type="number" title="Links without anchor text. Screen readers and search engines rely on link text to understand the destination.">
            Links w/o Text
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="${escapeHtml(METRIC_INFO.hasSecurityHeaders?.description || 'Security score based on HTTPS, security headers, cookies, and potential vulnerabilities.')}">
            Security Score
            <span class="threshold">≥ 70</span>
        </th>
        <th class="sortable" data-type="number" title="Missing HTTP security headers (Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, HSTS).">
            Missing Headers
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="Cookies without Secure or HttpOnly flags, which can be stolen through network interception or XSS attacks.">
            Insecure Cookies
            <span class="threshold">0</span>
        </th>
        ${getColumnHeader('hasMixedContent', 'Mixed Content', '0')}
        <th class="sortable" data-type="number" title="Forms that submit data without CSRF protection tokens, making them vulnerable to cross-site request forgery attacks.">
            Forms w/o CSRF
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="Inline JavaScript blocks. Many inline scripts can indicate XSS vulnerability and prevent Content-Security-Policy implementation.">
            Inline Scripts
            <span class="threshold">≤ 5</span>
        </th>
        <th class="sortable" data-type="number" title="Overall caching effectiveness score based on CDN usage, cache headers, and Service Worker presence.">
            Cache Score
            <span class="threshold">≥ 70</span>
        </th>
        <th class="sortable" data-type="text" title="Whether a Content Delivery Network is detected. CDNs improve global load times and reduce server load.">
            CDN
            <span class="threshold">Yes</span>
        </th>
        <th class="sortable" data-type="number" title="Static resources (CSS, JS, images) with proper cache headers set.">
            Cached Static
            <span class="threshold">All</span>
        </th>
        <th class="sortable" data-type="number" title="Static resources without cache headers. These are re-downloaded on every visit, slowing page loads.">
            Uncached Static
            <span class="threshold">0</span>
        </th>
        ${getColumnHeader('pwa', 'Service Worker', 'Yes')}
        ${getColumnHeader('imagesTotal', 'Images', 'Total count')}
        ${getColumnHeader('hasLazyLoading', 'Lazy Loading', 'Images with lazy')}
        <th class="sortable" data-type="number" title="Total size of all images on the page. Large images slow page loading and hurt Core Web Vitals.">
            Image Size
            <span class="threshold">Total KB</span>
        </th>
        ${getColumnHeader('imagesOptimized', 'Modern Formats', 'WebP/AVIF count')}
        <th class="sortable" data-type="number" title="CSS and JavaScript files that block page rendering. Move critical CSS inline and defer non-critical scripts.">
            Render Blocking
            <span class="threshold">≤ 5</span>
        </th>
        <th class="sortable" data-type="number" title="Text resources (HTML, CSS, JS) not using gzip/brotli compression. Uncompressed files are 70-90% larger.">
            Uncompressed
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="CSS and JavaScript files that aren't minified. Minification removes whitespace and comments to reduce file size.">
            Unminified
            <span class="threshold">0</span>
        </th>
        ${getColumnHeader('accessibilityScore', 'A11y Score', '≥ 70')}
        <th class="sortable" data-type="text" title="ARIA roles for assistive technology. Invalid roles confuse screen readers and hurt accessibility.">
            ARIA
            <span class="threshold">Valid roles</span>
        </th>
        <th class="sortable" data-type="number" title="Form inputs with associated labels. Labels help screen reader users and improve form usability.">
            Form Labels
            <span class="threshold">All inputs</span>
        </th>
        <th class="sortable" data-type="text" title="HTML5 landmark elements (main, nav, header). These help screen reader users navigate the page structure.">
            Landmarks
            <span class="threshold">Main/Nav/Header</span>
        </th>
        ${getColumnHeader('hasSkipLink', 'Focus Issues', '0')}
        ${getColumnHeader('contentScore', 'Content Score', '≥ 70')}
        ${getColumnHeader('wordCount', 'Word Count', '≥ 300')}
        ${getColumnHeader('textToHtmlRatio', 'Text/HTML Ratio', '≥ 25%')}
        ${getColumnHeader('readabilityScore', 'Readability', '50-70')}
        <th class="sortable" data-type="text" title="Most frequently used words in the content. Shows the page's main topics and keyword targeting.">
            Top Keywords
            <span class="threshold">Most frequent</span>
        </th>
        <th class="sortable" data-type="text" title="Detected content language using trigram analysis. Compared against declared html lang attribute.">
            Language
            <span class="threshold">Detected</span>
        </th>
        <th class="sortable" data-type="number" title="Internal PageRank score. Higher values indicate more internal link equity flowing to this page.">
            PageRank
            <span class="threshold">Link equity</span>
        </th>
        <th class="sortable" data-type="number" title="Number of conversion elements (forms, CTA buttons, phone/email links) on the page.">
            CTAs
            <span class="threshold">Count</span>
        </th>
        <th class="sortable" data-type="number" title="Percentage of loaded JavaScript that is unused. Lower is better.">
            JS Unused %
            <span class="threshold">≤ 50%</span>
        </th>
        <th class="sortable" data-type="number" title="Number of broken external links found on this page.">
            Broken Links
            <span class="threshold">0</span>
        </th>
        <th class="sortable" data-type="number" title="Word count of main content area only, excluding navigation, header, footer, and sidebar.">
            Main Words
            <span class="threshold">≥ 300</span>
        </th>
    </tr>
  `;
}

/**
 * Generate a performance metric cell with lab value and optional CrUX field data
 */
function getPerfCell(page: PageInfo, metric: string, labValue: number | undefined, threshold: number, unit: string) {
  const crux = page.cruxFieldData?.metrics?.[metric];
  const isCls = metric === 'CLS';

  // Lab display
  const hasLab = isCls ? labValue !== undefined : !!labValue;
  const labDisplay = hasLab ? (isCls ? String(labValue) : `${labValue}${unit}`) : 'N/A';
  const labColor = hasLab ? getMetricColor(labValue!, threshold, true) : '#9ca3af';

  // CrUX field display
  if (crux) {
    const fieldP75 = crux.p75;
    const fieldDisplay = isCls ? fieldP75.toFixed(2) : `${Math.round(fieldP75)}${unit}`;
    const fieldPassing = isCls ? fieldP75 <= threshold : fieldP75 <= threshold;
    const fieldColor = fieldPassing ? '#10b981' : '#ef4444';
    const goodPct = crux.distribution?.good ?? 0;

    return `
      <td class="metric-cell" style="text-align:center;line-height:1.3;" title="Lab: ${labDisplay} | Field p75: ${fieldDisplay} (${goodPct}% good)">
          <span style="color:${labColor};font-weight:600;font-size:12px;">🔬 ${labDisplay}</span><br>
          <span style="color:${fieldColor};font-weight:600;font-size:11px;">🌐 ${fieldDisplay}</span>
      </td>`;
  }

  // No CrUX — lab only
  const tooltip = getMetricTooltip(labValue, threshold, metric, unit === 'ms' ? 'ms' : '', true);
  return `
    <td class="metric-cell" style="color:${labColor};" title="${tooltip}">
        ${labDisplay}
    </td>`;
}

/**
 * Generate a single table row for a page
 */
function getTableRow(page: PageInfo, index: number, hasPerformanceMetrics: boolean) {
  const titleLength = page.title?.length || 0;
  const descLength = page.description?.length || 0;
  const titleColor = getTextLengthColor(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX);
  const descColor = getTextLengthColor(descLength, THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX);
  const titleTooltip = getTextLengthTooltip(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX, 'Title');
  const descTooltip = getTextLengthTooltip(
    descLength,
    THRESHOLDS.DESCRIPTION_MIN,
    THRESHOLDS.DESCRIPTION_MAX,
    'Description',
  );

  // Handle both old array format and new object format
  const h1Count = Array.isArray(page.headings)
    ? page.headings.filter((h: HeadingCount) => h.tag === 'h1')[0]?.count || 0
    : page.headings?.h1?.length || 0;
  const h2Count = Array.isArray(page.headings)
    ? page.headings.filter((h: HeadingCount) => h.tag === 'h2')[0]?.count || 0
    : page.headings?.h2?.length || 0;

  // Convert object format to array format for structure check
  const headingsArray: HeadingCount[] | null = Array.isArray(page.headings)
    ? page.headings
    : page.headings
      ? [
          { tag: 'h1', count: page.headings.h1?.length || page.headings.h1Count || 0 },
          { tag: 'h2', count: page.headings.h2?.length || page.headings.h2Count || 0 },
          { tag: 'h3', count: page.headings.h3?.length || page.headings.h3Count || 0 },
          { tag: 'h4', count: page.headings.h4?.length || page.headings.h4Count || 0 },
          { tag: 'h5', count: page.headings.h5?.length || page.headings.h5Count || 0 },
          { tag: 'h6', count: page.headings.h6?.length || page.headings.h6Count || 0 },
        ]
      : null;
  const hasHStructureIssue = hasHeadingStructureIssue(headingsArray!);
  const missingMeta = getMissingMetaTags(page);
  const alternatesCount = page.alternates?.length || 0;
  const linksWithoutText =
    (Array.isArray(page.links) ? page.links : []).filter(
      (link: { text?: string }) => !link.text || link.text.trim() === '',
    ).length || 0;

  // Security metrics
  const securityScore = page.security?.securityScore ?? null;
  const missingSecHeaders = page.security?.missingHeaders?.length || 0;
  const mixedContent = page.security?.mixedContent || 0;
  const insecureCookies = page.security?.insecureCookies || 0;
  const formsWithoutCSRF = page.security?.formsWithoutCSRF || 0;
  const inlineScripts = page.security?.inlineScripts || 0;
  const securityTooltip = buildSecurityTooltip(
    page,
    securityScore,
    missingSecHeaders,
    mixedContent,
    insecureCookies,
    formsWithoutCSRF,
    inlineScripts,
  );

  // Caching metrics
  const cacheScore = page.caching?.cacheScore ?? null;
  const hasCDN = page.caching?.hasCDN || false;
  const cdnProvider = page.caching?.cdnProvider || null;
  const uncachedStatic = page.caching?.staticUncached || 0;
  const cachedStatic = page.caching?.staticCached || 0;
  const hasServiceWorker = page.caching?.hasServiceWorker || false;
  const cachingTooltip = buildCachingTooltip(
    page,
    cacheScore,
    hasCDN,
    cdnProvider,
    cachedStatic,
    uncachedStatic,
    hasServiceWorker,
  );

  // Keywords for filtering
  const keywords = (page.contentQuality?.topKeywords || [])
    .map((k: { word: string }) => k.word.toLowerCase())
    .join(',');
  const titleWords = (page.title || '').toLowerCase();

  return `
    <tr data-keywords="${escapeHtml(keywords)}" data-title="${escapeHtml(titleWords)}" data-segment="${page.segment || 'other'}" data-has-errors="${(page.status ?? 0) >= 400 || missingMeta.length > 3 ? 'true' : 'false'}" data-ttfb="${page.TTFB || 0}" data-status="${page.status || ''}" data-missing-meta="${missingMeta.length > 0 ? 'true' : 'false'}" data-h1-count="${h1Count}">
        <td style="text-align: center; color: #9ca3af; font-weight: 500; font-size: 12px;">
            ${index + 1}
        </td>
        <td>
            <a href="${escapeHtml(page.url)}" class="url-link" target="_blank">${escapeHtml(page.url)}</a>
        </td>
        <td style="text-align: center;">
            <span class="source-badge source-${page.foundIn || 'sitemap'}" title="${page.foundIn === 'discovered' ? (page.discoveredOn ? 'Found on page: ' + escapeHtml(page.discoveredOn) : 'Found through internal links during crawl') : 'Listed in sitemap'}">${page.foundIn === 'discovered' ? 'Link' : 'Sitemap'}</span>
        </td>
        <td style="text-align: center;">
            <span class="segment-badge segment-${page.segment || 'other'}" style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${getSegmentColor(page.segment ?? 'other')}; color: white;" title="Page segment: ${page.segment || 'other'}">${getSegmentLabel(page.segment ?? 'other')}</span>
        </td>
        <td class="incoming-links-cell"
            style="color: ${(page.incomingLinksCount ?? 0) > 0 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center; cursor: ${(page.incomingLinksCount ?? 0) > 0 ? 'pointer' : 'default'}; position: relative;"
            data-url="${escapeHtml(page.url)}"
            data-count="${page.incomingLinksCount || 0}"
            title="${(page.incomingLinksCount ?? 0) > 0 ? 'Click to see ' + page.incomingLinksCount + ' incoming link(s)' : 'No incoming links - page is orphaned (only accessible via sitemap)'}">
            ${page.incomingLinksCount || 0}${(page.incomingLinksCount ?? 0) > 0 ? ' <span style="font-size: 10px; opacity: 0.7;">ℹ</span>' : ''}
        </td>
        <td style="color: ${getMetricColor(page.urlAnalysis?.length || 0, THRESHOLDS.URL_LENGTH_RECOMMENDED, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.length && page.urlAnalysis.length > THRESHOLDS.URL_LENGTH_MAX ? 'Error: URL too long (' + page.urlAnalysis.length + ' chars)' : page.urlAnalysis?.length && page.urlAnalysis.length > THRESHOLDS.URL_LENGTH_RECOMMENDED ? 'Warning: URL longer than recommended (' + page.urlAnalysis.length + ' chars)' : 'Good: URL length is optimal'}">
            ${page.urlAnalysis?.length || 0}
        </td>
        <td style="color: ${getMetricColor(page.urlAnalysis?.depth || 0, THRESHOLDS.URL_DEPTH_MAX, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.depth && page.urlAnalysis.depth > THRESHOLDS.URL_DEPTH_MAX ? 'Warning: URL is too deep (' + page.urlAnalysis.depth + ' levels)' : 'Good: URL depth is optimal'}">
            ${page.urlAnalysis?.depth || 0}
        </td>
        <td style="color: ${(page.redirectCount ?? 0) > 2 ? '#ef4444' : (page.redirectCount ?? 0) > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${(page.redirectCount ?? 0) > 0 ? 'Warning: ' + page.redirectCount + ' redirect(s) detected' + (page.redirectChain ? ': ' + (page.redirectChain as unknown as Array<{ url: string }>).map((r) => r.url).join(' → ') : '') : 'Good: No redirects'}">
            ${page.redirectCount || 0}
        </td>
        <td style="color: ${(page.httpLinksCount ?? 0) > 0 ? '#ef4444' : '#10b981'}; font-weight: 600; text-align: center;" title="${(page.httpLinksCount ?? 0) > 0 ? 'Error: ' + page.httpLinksCount + ' HTTP link(s) on HTTPS site' : 'Good: No HTTP links'}">
            ${page.httpLinksCount || 0}
        </td>
        <td><span class="status-badge" style="background: ${getStatusColor(page.status ?? 0)};">${page.status || 'N/A'}</span></td>
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
        ${
          hasPerformanceMetrics
            ? `
        ${getPerfCell(page, 'TTFB', page.TTFB, THRESHOLDS.TTFB, 'ms')}
        ${getPerfCell(page, 'FCP', page.FCP, THRESHOLDS.FCP, 'ms')}
        ${getPerfCell(page, 'LCP', page.LCP, THRESHOLDS.LCP, 'ms')}
        ${getPerfCell(page, 'CLS', page.CLS, THRESHOLDS.CLS, '')}
        ${getPerfCell(page, 'INP', page.INP, THRESHOLDS.INP || 200, 'ms')}
        `
            : ''
        }
        <td class="metric-cell" style="color: ${getMetricColor(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, true)};" title="${getMetricTooltip(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, 'Page Size', ' bytes', true)}">
            ${formatBytes(page.totalResponseSize || 0)}
        </td>
        <td class="metric-cell" style="color: ${getMetricColor(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, true)};" title="${getMetricTooltip(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, 'Requests', '', true)}">
            ${page.totalNumberOfRequests || 0}
        </td>
        <td style="text-align: center;">
            ${
              page.canonical
                ? page.canonical === page.url
                  ? '<span style="color: #10b981;" title="Canonical URL matches page URL">✓</span>'
                  : '<span style="color: #f59e0b;" title="Canonical URL differs: ' +
                    escapeHtml(page.canonical) +
                    '">⚠</span>'
                : '<span style="color: #ef4444;" title="Canonical URL is missing">✗</span>'
            }
        </td>
        <td style="color: ${h1Count === 1 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h1Count === 1 ? 'Perfect: Page has exactly 1 H1 tag' : h1Count === 0 ? 'Error: Page is missing H1 tag' : 'Error: Page has ' + h1Count + ' H1 tags (should be exactly 1)'}">
            ${h1Count}
        </td>
        <td style="color: ${h2Count <= THRESHOLDS.H2_COUNT ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h2Count <= THRESHOLDS.H2_COUNT ? 'Good: H2 count is within threshold' : 'Warning: Too many H2 tags (' + h2Count + ', recommended: ≤' + THRESHOLDS.H2_COUNT + ')'}">
            ${h2Count}
        </td>
        <td style="text-align: center;">
            ${
              hasHStructureIssue
                ? '<span style="color: #ef4444;" title="Error: Heading hierarchy has gaps (e.g., h1 to h3 without h2)">✗</span>'
                : '<span style="color: #10b981;" title="Good: Heading hierarchy is correct">✓</span>'
            }
        </td>
        <td style="color: ${missingMeta.length === 0 ? '#10b981' : missingMeta.length <= 2 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${missingMeta.length === 0 ? 'Good: All important meta tags are present' : 'Missing meta tags: ' + missingMeta.join(', ')}">
            ${missingMeta.length}
        </td>
        <td style="color: ${alternatesCount > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${alternatesCount > 0 ? alternatesCount + ' alternate language link(s)' : 'No alternate language links'}">
            ${alternatesCount}
        </td>
        <td style="color: ${linksWithoutText === 0 ? '#10b981' : linksWithoutText <= 3 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${linksWithoutText === 0 ? 'Good: All links have text' : 'Warning: ' + linksWithoutText + ' link(s) without text'}">
            ${linksWithoutText}
        </td>
        <td style="color: ${securityScore === null ? '#9ca3af' : securityScore >= 70 ? '#10b981' : securityScore >= 50 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center; white-space: pre-line;" title="${securityTooltip}">
            ${securityScore !== null ? securityScore : 'N/A'}
        </td>
        <td style="color: ${missingSecHeaders === 0 ? '#10b981' : missingSecHeaders <= 2 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${missingSecHeaders === 0 ? 'Good: All security headers present' : 'Missing headers: ' + (page.security?.missingHeaders?.join(', ') || '')}">
            ${missingSecHeaders}
        </td>
        <td style="color: ${insecureCookies === 0 ? '#10b981' : insecureCookies <= 2 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${insecureCookies === 0 ? 'Good: All cookies are secure' : 'Warning: ' + insecureCookies + ' cookie(s) without Secure/HttpOnly flags'}">
            ${insecureCookies}
        </td>
        <td style="color: ${mixedContent === 0 ? '#10b981' : mixedContent <= 3 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${mixedContent === 0 ? 'Good: No mixed content' : 'Warning: ' + mixedContent + ' HTTP resources on HTTPS page'}">
            ${mixedContent}
        </td>
        <td style="color: ${formsWithoutCSRF === 0 ? '#10b981' : formsWithoutCSRF <= 2 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${formsWithoutCSRF === 0 ? 'Good: All forms have CSRF protection' : 'Warning: ' + formsWithoutCSRF + ' form(s) without CSRF tokens'}">
            ${formsWithoutCSRF}
        </td>
        <td style="color: ${inlineScripts <= 5 ? '#10b981' : inlineScripts <= 10 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${inlineScripts <= 5 ? 'Good: Minimal inline scripts' : 'Warning: ' + inlineScripts + ' inline scripts (potential XSS risk)'}">
            ${inlineScripts}
        </td>
        <td style="color: ${cacheScore === null ? '#9ca3af' : cacheScore >= 70 ? '#10b981' : cacheScore >= 50 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center; white-space: pre-line;" title="${cachingTooltip}">
            ${cacheScore !== null ? cacheScore : 'N/A'}
        </td>
        <td style="text-align: center;">
            ${
              hasCDN
                ? '<span style="color: #10b981;" title="CDN detected' +
                  (cdnProvider ? ': ' + cdnProvider : '') +
                  '">✓</span>'
                : '<span style="color: #f59e0b;" title="No CDN detected">✗</span>'
            }
        </td>
        <td style="color: ${cachedStatic > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${cachedStatic > 0 ? cachedStatic + ' static resources cached' : 'No cached static resources'}">
            ${cachedStatic}
        </td>
        <td style="color: ${uncachedStatic === 0 ? '#10b981' : uncachedStatic <= 5 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${uncachedStatic === 0 ? 'Good: All static resources are cached' : 'Warning: ' + uncachedStatic + ' static resources without caching'}">
            ${uncachedStatic}
        </td>
        <td style="text-align: center;">
            ${
              hasServiceWorker
                ? '<span style="color: #10b981;" title="Service Worker is active">✓</span>'
                : '<span style="color: #f59e0b;" title="No Service Worker detected">✗</span>'
            }
        </td>
        ${getImageOptimizationCells(page)}
        ${getAccessibilityCells(page)}
        ${getContentQualityCells(page)}
    </tr>
  `;
}

/**
 * Build the security tooltip
 */
function buildSecurityTooltip(
  page: PageInfo,
  securityScore: number | null,
  missingSecHeaders: number,
  mixedContent: number,
  insecureCookies: number,
  formsWithoutCSRF: number,
  inlineScripts: number,
) {
  if (securityScore === null) {
    return 'Security analysis not available';
  }

  const scoreBreakdown: string[] = [];
  scoreBreakdown.push('Security Score Breakdown:');
  scoreBreakdown.push('');

  if (missingSecHeaders === 0) {
    scoreBreakdown.push('✓ All security headers present');
  } else {
    scoreBreakdown.push(
      '✗ Missing ' + missingSecHeaders + ' security header(s): ' + (page.security?.missingHeaders?.join(', ') || ''),
    );
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

  return scoreBreakdown.join('\\n');
}

/**
 * Build the caching tooltip
 */
function buildCachingTooltip(
  page: PageInfo,
  cacheScore: number | null,
  hasCDN: boolean,
  cdnProvider: string | null,
  cachedStatic: number,
  uncachedStatic: number,
  hasServiceWorker: boolean,
) {
  if (cacheScore === null) {
    return 'Caching analysis not available';
  }

  const cacheBreakdown: string[] = [];
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
      cacheBreakdown.push(
        '✓ All static resources cached: ' + cachedStatic + '/' + totalStatic + ' (+' + points + ' points)',
      );
    } else {
      cacheBreakdown.push(
        '⚠ Static resources: ' + cachedStatic + ' cached, ' + uncachedStatic + ' uncached (+' + points + '/40 points)',
      );
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
      cacheBreakdown.push(
        '✓ Dynamic content: ' + dynamicCached + '/' + totalDynamic + ' cached (+' + points + ' points)',
      );
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

  return cacheBreakdown.join('\\n');
}

/**
 * Generate image optimization cells
 */
function getImageOptimizationCells(page: PageInfo) {
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
    <td style="color: ${totalImages > 0 && lazyImages === 0 ? '#ef4444' : lazyImages > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${lazyImages} images with lazy loading (${totalImages} total)">
        ${lazyImages}/${totalImages}
    </td>
    <td style="color: ${totalImageSize > 1000000 ? '#ef4444' : totalImageSize > 500000 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="Total image size: ${Math.round(totalImageSize / 1000)}KB">
        ${Math.round(totalImageSize / 1000)}
    </td>
    <td style="color: ${legacyFormats > 0 && modernFormats === 0 ? '#f59e0b' : modernFormats > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${modernFormats} modern format images (WebP/AVIF), ${legacyFormats} legacy format images (JPG/PNG)">
        ${modernFormats}/${totalImages}
    </td>
    <td style="color: ${renderBlocking > 5 ? '#ef4444' : renderBlocking > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${renderBlocking} render-blocking resources">
        ${renderBlocking}
    </td>
    <td style="color: ${uncompressed > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${uncompressed} uncompressed text resources">
        ${uncompressed}
    </td>
    <td style="color: ${unminified > 0 ? '#f59e0b' : '#10b981'}; font-weight: 600; text-align: center;" title="${unminified} unminified resources">
        ${unminified}
    </td>
  `;
}

/**
 * Generate accessibility cells
 */
function getAccessibilityCells(page: PageInfo) {
  const a11y = page.accessibility ?? ({} as AccessibilityAnalysis);

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
    <td style="color: ${a11yScore >= 70 ? '#10b981' : a11yScore >= 50 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="Accessibility Score: ${a11yScore}/100">
        ${a11yScore}
    </td>
    <td style="text-align: center;">
        ${
          ariaInvalid > 0
            ? '<span style="color: #ef4444;" title="' + ariaInvalid + ' invalid ARIA roles">✗</span>'
            : ariaValid > 0
              ? '<span style="color: #10b981;" title="' + ariaValid + ' valid ARIA roles">✓</span>'
              : '<span style="color: #9ca3af;">—</span>'
        }
    </td>
    <td style="color: ${totalInputs > 0 && inputsWithoutLabels === 0 ? '#10b981' : inputsWithoutLabels > 0 ? '#ef4444' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${inputsWithLabels} inputs with labels, ${inputsWithoutLabels} without">
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
}

/**
 * Get segment color based on segment type
 */
function getSegmentColor(segment: string) {
  const colors = {
    blog: '#3b82f6', // blue
    product: '#10b981', // green
    category: '#8b5cf6', // purple
    tag: '#6366f1', // indigo
    search: '#f59e0b', // amber
    account: '#64748b', // slate
    checkout: '#ec4899', // pink
    legal: '#6b7280', // gray
    contact: '#06b6d4', // cyan
    media: '#f97316', // orange
    landing: '#14b8a6', // teal
    api: '#ef4444', // red
    other: '#9ca3af', // gray
  };
  return (colors as Record<string, string>)[segment] || colors.other;
}

/**
 * Get segment label based on segment type
 */
function getSegmentLabel(segment: string) {
  const labels: Record<string, string> = {
    blog: 'Blog',
    product: 'Product',
    category: 'Category',
    tag: 'Tag',
    search: 'Search',
    account: 'Account',
    checkout: 'Checkout',
    legal: 'Legal',
    contact: 'Info',
    media: 'Media',
    landing: 'Landing',
    api: 'API',
    other: 'Other',
  };
  return labels[segment] || labels.other;
}

/**
 * Generate content quality cells
 */
function getContentQualityCells(page: PageInfo) {
  const content = page.contentQuality ?? ({} as ContentQualityAnalysis);

  const contentScore = content.contentScore ?? 'N/A';
  const wordCount = content.wordCount || 0;
  const textToHtmlRatio = content.textToHtmlRatio || 0;
  const readability = content.readabilityScore || 0;
  const topKeywords = content.topKeywords || [];
  const topKeywordsStr = topKeywords
    .slice(0, 3)
    .map((k: { word: string; density: number }) => `${k.word}(${k.density}%)`)
    .join(', ');

  return `
    <td style="color: ${contentScore >= 70 ? '#10b981' : contentScore >= 50 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="Content Quality Score: ${contentScore}/100">
        ${contentScore}
    </td>
    <td style="color: ${wordCount >= 600 ? '#10b981' : wordCount >= 300 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="${wordCount} words (min: 300, recommended: 600)">
        ${wordCount}
    </td>
    <td style="color: ${textToHtmlRatio >= 25 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="Text-to-HTML ratio: ${textToHtmlRatio}% (min: 25%)">
        ${textToHtmlRatio}%
    </td>
    <td style="color: ${readability >= 60 ? '#10b981' : readability >= 50 ? '#f59e0b' : '#ef4444'}; font-weight: 600; text-align: center;" title="Flesch Reading Ease: ${readability}/100 (60-70 is standard)">
        ${readability}
    </td>
    <td style="font-size: 11px; text-align: left;" title="Top keywords: ${topKeywords.map((k: { word: string; count: number; density: number }) => `${k.word}: ${k.count} times (${k.density}%)`).join(', ')}">
        ${topKeywordsStr || '—'}
    </td>
    ${getNewInsightCells(page)}
  `;
}

/**
 * Generate table cells for new insight data (Phase 1-3 features)
 */
function getNewInsightCells(page: PageInfo) {
  // Language
  const lang = page.languageDetection;
  const langDisplay = lang?.detectedLanguage?.toUpperCase() || '—';
  const langMatch = lang?.match;
  const langColor = langMatch === false ? '#ef4444' : langMatch === true ? '#10b981' : '#6b7280';
  const langTitle = lang
    ? `Detected: ${lang.detectedLanguage || 'unknown'} (${Math.round((lang.detectedConfidence || 0) * 100)}% confidence), Declared: ${lang.declaredLanguage || 'none'}`
    : '';

  // PageRank
  const pr = page.internalPageRank;
  const prDisplay = pr != null ? (pr * 100).toFixed(1) : '—';

  // CTAs
  const ctaCount = page.ctaData?.summary?.total ?? null;
  const ctaDisplay = ctaCount != null ? ctaCount : '—';

  // Code coverage
  const jsUnused = page.codeCoverage?.js?.ratio;
  const jsDisplay = jsUnused != null ? `${jsUnused}%` : '—';
  const jsColor = (jsUnused ?? 0) > 70 ? '#ef4444' : (jsUnused ?? 0) > 50 ? '#f59e0b' : '#10b981';

  // Broken outbound links
  const brokenCount = page.outboundLinkHealth?.broken?.length ?? null;
  const brokenDisplay = brokenCount != null ? brokenCount : '—';
  const brokenColor = (brokenCount ?? 0) > 0 ? '#ef4444' : '#10b981';

  // Main content words
  const mainWords = page.contentQuality?.wordCountBySection?.main ?? null;
  const mainDisplay = mainWords != null ? mainWords : '—';
  const mainColor =
    mainWords != null ? (mainWords >= 300 ? '#10b981' : mainWords >= 100 ? '#f59e0b' : '#ef4444') : '#6b7280';

  return `
    <td style="text-align: center; font-size: 12px; color: ${langColor};" title="${escapeHtml(langTitle)}">${langDisplay}</td>
    <td style="text-align: center; font-size: 12px;">${prDisplay}</td>
    <td style="text-align: center; font-size: 12px;">${ctaDisplay}</td>
    <td style="text-align: center; font-size: 12px; color: ${jsUnused != null ? jsColor : '#6b7280'};">${jsDisplay}</td>
    <td style="text-align: center; font-size: 12px; color: ${brokenCount != null ? brokenColor : '#6b7280'}; font-weight: ${(brokenCount ?? 0) > 0 ? '600' : 'normal'};">${brokenDisplay}</td>
    <td style="text-align: center; font-size: 12px; color: ${mainColor};">${mainDisplay}</td>
  `;
}

// ── Comparison pages table ───────────────────────────────────────────────────

/**
 * Extract all numeric/display values from a PageInfo for comparison table.
 * Returns simple string/number values suitable for dual() rendering.
 */
function extractPageValues(p: PageInfo | undefined, incomingLinks: Record<string, string[]>) {
  if (!p) return null;

  const h1Count = Array.isArray(p.headings)
    ? p.headings.filter((h: HeadingCount) => h.tag === 'h1')[0]?.count || 0
    : p.headings?.h1?.length || 0;
  const h2Count = Array.isArray(p.headings)
    ? p.headings.filter((h: HeadingCount) => h.tag === 'h2')[0]?.count || 0
    : p.headings?.h2?.length || 0;

  const headingsArray: HeadingCount[] | null = Array.isArray(p.headings)
    ? p.headings
    : p.headings
      ? [
          { tag: 'h1', count: p.headings.h1?.length || p.headings.h1Count || 0 },
          { tag: 'h2', count: p.headings.h2?.length || p.headings.h2Count || 0 },
          { tag: 'h3', count: p.headings.h3?.length || p.headings.h3Count || 0 },
          { tag: 'h4', count: p.headings.h4?.length || p.headings.h4Count || 0 },
          { tag: 'h5', count: p.headings.h5?.length || p.headings.h5Count || 0 },
          { tag: 'h6', count: p.headings.h6?.length || p.headings.h6Count || 0 },
        ]
      : null;
  const hasHStructureIssue = hasHeadingStructureIssue(headingsArray!);
  const missingMeta = getMissingMetaTags(p);
  const alternatesCount = p.alternates?.length || 0;
  const linksWithoutText = (Array.isArray(p.links) ? p.links : []).filter(
    (link: { text?: string }) => !link.text || link.text.trim() === '',
  ).length || 0;

  // Security
  const securityScore = p.security?.securityScore ?? null;
  const missingSecHeaders = p.security?.missingHeaders?.length || 0;
  const mixedContent = p.security?.mixedContent || 0;
  const insecureCookies = p.security?.insecureCookies || 0;
  const formsWithoutCSRF = p.security?.formsWithoutCSRF || 0;
  const inlineScripts = p.security?.inlineScripts || 0;

  // Caching
  const cacheScore = p.caching?.cacheScore ?? null;
  const hasCDN = p.caching?.hasCDN || false;
  const uncachedStatic = p.caching?.staticUncached || 0;
  const cachedStatic = p.caching?.staticCached || 0;
  const hasServiceWorker = p.caching?.hasServiceWorker || false;

  // Image optimization
  const imgOpt = p.imageOptimization || {};
  const resOpt = p.resourceOptimization || {};
  const totalImages = imgOpt.totalImages || 0;
  const lazyImages = imgOpt.withLazyLoading || 0;
  const totalImageSize = imgOpt.totalImageSize || 0;
  const modernFormats = imgOpt.modernFormats || 0;
  const renderBlocking = resOpt.renderBlocking?.totalBlocking || 0;
  const uncompressed = resOpt.compression?.uncompressed || 0;
  const unminified = (resOpt.minification?.unminifiedJS || 0) + (resOpt.minification?.unminifiedCSS || 0);

  // Accessibility
  const a11y = p.accessibility ?? ({} as AccessibilityAnalysis);
  const a11yScore = a11y.a11yScore ?? null;
  const ariaValid = a11y.aria?.valid || 0;
  const ariaInvalid = a11y.aria?.invalid || 0;
  const inputsWithLabels = a11y.forms?.inputsWithLabels || 0;
  const inputsWithoutLabels = a11y.forms?.inputsWithoutLabels || 0;
  const totalInputs = inputsWithLabels + inputsWithoutLabels;
  const hasMain = a11y.semantic?.hasMain || false;
  const hasNav = a11y.semantic?.hasNav || false;
  const hasHeader = a11y.semantic?.hasHeader || false;
  const focusIssues = (a11y.keyboard?.elementsWithoutFocus || 0) + (a11y.keyboard?.positiveTabindex || 0);

  // Content quality
  const content = p.contentQuality ?? ({} as ContentQualityAnalysis);
  const contentScore = content.contentScore ?? null;
  const wordCount = content.wordCount || 0;
  const textToHtmlRatio = content.textToHtmlRatio || 0;
  const readability = content.readabilityScore || 0;
  const topKeywords = (content.topKeywords || [])
    .slice(0, 3)
    .map((k: { word: string; density: number }) => `${k.word}(${k.density}%)`)
    .join(', ');

  // New insights
  const lang = p.languageDetection;
  const langDisplay = lang?.detectedLanguage?.toUpperCase() || '—';
  const pr = p.internalPageRank;
  const prDisplay = pr != null ? (pr * 100).toFixed(1) : '—';
  const ctaCount = p.ctaData?.summary?.total ?? null;
  const jsUnused = p.codeCoverage?.js?.ratio;
  const brokenCount = p.outboundLinkHealth?.broken?.length ?? null;
  const mainWords = p.contentQuality?.wordCountBySection?.main ?? null;

  const status = (p.status as number) || (p.statusCode as number) || 0;
  const incomingCount = incomingLinks[p.url]?.length || p.incomingLinksCount || 0;

  // Canonical symbol
  const canonicalSymbol = p.canonical ? (p.canonical === p.url ? '=' : '~') : 'x';

  return {
    status, source: p.foundIn === 'discovered' ? 'Link' : 'Sitemap',
    segment: p.segment || 'other', incomingCount,
    urlLength: p.urlAnalysis?.length || 0, urlDepth: p.urlAnalysis?.depth || 0,
    redirects: p.redirectCount || 0, httpLinks: p.httpLinksCount || 0,
    titleLength: p.title?.length || 0, descLength: p.description?.length || 0,
    TTFB: p.TTFB, FCP: p.FCP, LCP: p.LCP, CLS: p.CLS, INP: p.INP,
    pageSize: p.totalResponseSize || 0, requests: p.totalNumberOfRequests || 0,
    canonicalSymbol, h1Count, h2Count, hStructure: hasHStructureIssue ? 'x' : '=',
    missingMeta: missingMeta.length, alternatesCount, linksWithoutText,
    securityScore, missingSecHeaders, insecureCookies, mixedContent, formsWithoutCSRF, inlineScripts,
    cacheScore, cdn: hasCDN ? '=' : 'x', cachedStatic, uncachedStatic,
    serviceWorker: hasServiceWorker ? '=' : 'x',
    totalImages, lazyImages, totalImageSizeKB: Math.round(totalImageSize / 1000),
    modernFormats, renderBlocking, uncompressed, unminified,
    a11yScore, aria: ariaInvalid > 0 ? 'x' : ariaValid > 0 ? '=' : '—',
    formLabels: `${inputsWithLabels}/${totalInputs}`,
    landmarks: `${hasMain ? 'M' : ''}${hasNav ? 'N' : ''}${hasHeader ? 'H' : ''}` || '—',
    focusIssues,
    contentScore, wordCount, textToHtmlRatio, readability, topKeywords: topKeywords || '—',
    langDisplay, prDisplay, ctaCount: ctaCount != null ? String(ctaCount) : '—',
    jsUnused: jsUnused != null ? `${jsUnused}%` : '—',
    brokenLinks: brokenCount != null ? String(brokenCount) : '—',
    mainWords: mainWords != null ? String(mainWords) : '—',
  };
}

function getComparisonPagesTable(data: ReportSectionData, comparison: ComparisonData) {
  const originLabel = shortDomain(comparison.originDomainName);
  const compareLabel = shortDomain(comparison.compareDomainName);
  const hasPerf = data.hasPerformanceMetrics;

  // Build lookup maps
  const originPagesMap = (data.pageData?.pages || {}) as Record<string, PageInfo>;
  const comparePagesMap = (comparison.comparePageData?.pages || {}) as Record<string, PageInfo>;

  const originByUrl: Record<string, PageInfo> = {};
  for (const [url, page] of Object.entries(originPagesMap)) {
    originByUrl[url] = page;
  }
  const compareByUrl: Record<string, PageInfo> = {};
  for (const [url, page] of Object.entries(comparePagesMap)) {
    compareByUrl[url] = page;
  }

  const originIncoming = (data.pageData?.incomingLinks || {}) as Record<string, string[]>;
  const compareIncoming = (comparison.comparePageData?.incomingLinks || {}) as Record<string, string[]>;

  // Helper: format o/c dual value, underline when different
  const dual = (oVal: string | number, cVal: string | number) => {
    const o = oVal === '' || oVal === undefined || oVal === null ? '—' : String(oVal);
    const c = cVal === '' || cVal === undefined || cVal === null ? '—' : String(cVal);
    const changed = o !== c && o !== '—' && c !== '—';
    const style = changed ? 'border-bottom:2px solid #f97316;padding-bottom:1px;' : '';
    return `<span style="${style}"><span style="color:#3b82f6;">${o}</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#a855f7;">${c}</span></span>`;
  };

  // Helper: single-side value (for unmatched rows)
  const singleVal = (v: string | number, isOrigin: boolean) => {
    const s = v === '' || v === undefined || v === null ? '—' : String(v);
    return isOrigin
      ? `<span style="color:#3b82f6;">${s}</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#d1d5db;">—</span>`
      : `<span style="color:#d1d5db;">—</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#a855f7;">${s}</span>`;
  };

  const fmtMs = (v: number | undefined) => v ? String(Math.round(v)) : '';
  const fmtCls = (v: number | undefined) => v !== undefined ? v.toFixed(3) : '';
  const fmtSize = (v: number | undefined) => v && v > 0 ? formatBytes(v) : '';

  const td = 'padding:4px 5px;font-size:11px;text-align:center;white-space:nowrap;';

  // Build a comparison row from two extracted value sets
  const buildRow = (
    idx: number,
    path: string,
    url: string,
    matchType: string,
    ov: ReturnType<typeof extractPageValues>,
    cv: ReturnType<typeof extractPageValues>,
    isUnmatched: boolean,
    isOrigin: boolean,
  ) => {
    const shortPath = path.length > 50 ? '...' + path.slice(-47) : path;
    const bg = !isUnmatched ? '' : isOrigin ? 'background:rgba(59,130,246,0.03);' : 'background:rgba(168,85,247,0.03);';
    const badge = isUnmatched
      ? ` <span class="site-badge ${isOrigin ? 'site-badge-origin' : 'site-badge-compare'}" style="font-size:9px;padding:1px 4px;">${isOrigin ? 'O' : 'C'}</span>`
      : '';

    // d = dual or single-side render
    const d = (oVal: string | number | null | undefined, cVal: string | number | null | undefined) => {
      if (isUnmatched) return singleVal(isOrigin ? (oVal ?? '') : (cVal ?? ''), isOrigin);
      return dual(oVal ?? '', cVal ?? '');
    };

    // Check symbol render
    const sym = (v: string | undefined) => {
      if (!v || v === '—') return '—';
      if (v === '=') return '<span style="color:#10b981;">&#10003;</span>';
      if (v === '~') return '<span style="color:#f59e0b;">&#9888;</span>';
      if (v === 'x') return '<span style="color:#ef4444;">&#10007;</span>';
      return v;
    };
    const dSym = (oSym: string | undefined, cSym: string | undefined) => {
      if (isUnmatched) {
        const s = isOrigin ? sym(oSym) : sym(cSym);
        return isOrigin
          ? `<span style="color:#3b82f6;">${s}</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#d1d5db;">—</span>`
          : `<span style="color:#d1d5db;">—</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#a855f7;">${s}</span>`;
      }
      return `<span style="color:#3b82f6;">${sym(oSym)}</span><span style="color:#9ca3af;margin:0 2px;">/</span><span style="color:#a855f7;">${sym(cSym)}</span>`;
    };

    return `<tr data-match-type="${matchType}" data-path="${escapeHtml(path)}" style="border-bottom:1px solid #f3f4f6;${bg}">
      <td style="${td}color:#9ca3af;">${idx + 1}</td>
      <td style="padding:4px 5px;font-size:11px;"><a href="${escapeHtml(url)}" target="_blank" style="color:#2563eb;text-decoration:none;" title="${escapeHtml(path)}">${escapeHtml(shortPath)}</a>${badge}</td>
      <td style="${td}">${d(ov?.source, cv?.source)}</td>
      <td style="${td}">${d(ov?.segment, cv?.segment)}</td>
      <td style="${td}">${d(ov?.incomingCount, cv?.incomingCount)}</td>
      <td style="${td}">${d(ov?.urlLength, cv?.urlLength)}</td>
      <td style="${td}">${d(ov?.urlDepth, cv?.urlDepth)}</td>
      <td style="${td}">${d(ov?.redirects, cv?.redirects)}</td>
      <td style="${td}">${d(ov?.httpLinks, cv?.httpLinks)}</td>
      <td style="${td}font-weight:600;">${d(ov?.status, cv?.status)}</td>
      <td style="${td}">${d(ov?.titleLength, cv?.titleLength)}</td>
      <td style="${td}">${d(ov?.descLength, cv?.descLength)}</td>
      ${hasPerf ? `
      <td style="${td}">${d(fmtMs(ov?.TTFB), fmtMs(cv?.TTFB))}</td>
      <td style="${td}">${d(fmtMs(ov?.FCP), fmtMs(cv?.FCP))}</td>
      <td style="${td}">${d(fmtMs(ov?.LCP), fmtMs(cv?.LCP))}</td>
      <td style="${td}">${d(fmtCls(ov?.CLS), fmtCls(cv?.CLS))}</td>
      <td style="${td}">${d(fmtMs(ov?.INP), fmtMs(cv?.INP))}</td>
      ` : ''}
      <td style="${td}">${d(fmtSize(ov?.pageSize), fmtSize(cv?.pageSize))}</td>
      <td style="${td}">${d(ov?.requests, cv?.requests)}</td>
      <td style="${td}">${dSym(ov?.canonicalSymbol, cv?.canonicalSymbol)}</td>
      <td style="${td}">${d(ov?.h1Count, cv?.h1Count)}</td>
      <td style="${td}">${d(ov?.h2Count, cv?.h2Count)}</td>
      <td style="${td}">${dSym(ov?.hStructure, cv?.hStructure)}</td>
      <td style="${td}">${d(ov?.missingMeta, cv?.missingMeta)}</td>
      <td style="${td}">${d(ov?.alternatesCount, cv?.alternatesCount)}</td>
      <td style="${td}">${d(ov?.linksWithoutText, cv?.linksWithoutText)}</td>
      <td style="${td}">${d(ov?.securityScore, cv?.securityScore)}</td>
      <td style="${td}">${d(ov?.missingSecHeaders, cv?.missingSecHeaders)}</td>
      <td style="${td}">${d(ov?.insecureCookies, cv?.insecureCookies)}</td>
      <td style="${td}">${d(ov?.mixedContent, cv?.mixedContent)}</td>
      <td style="${td}">${d(ov?.formsWithoutCSRF, cv?.formsWithoutCSRF)}</td>
      <td style="${td}">${d(ov?.inlineScripts, cv?.inlineScripts)}</td>
      <td style="${td}">${d(ov?.cacheScore, cv?.cacheScore)}</td>
      <td style="${td}">${dSym(ov?.cdn, cv?.cdn)}</td>
      <td style="${td}">${d(ov?.cachedStatic, cv?.cachedStatic)}</td>
      <td style="${td}">${d(ov?.uncachedStatic, cv?.uncachedStatic)}</td>
      <td style="${td}">${dSym(ov?.serviceWorker, cv?.serviceWorker)}</td>
      <td style="${td}">${d(ov?.totalImages, cv?.totalImages)}</td>
      <td style="${td}">${d(ov?.lazyImages, cv?.lazyImages)}</td>
      <td style="${td}">${d(ov?.totalImageSizeKB, cv?.totalImageSizeKB)}</td>
      <td style="${td}">${d(ov?.modernFormats, cv?.modernFormats)}</td>
      <td style="${td}">${d(ov?.renderBlocking, cv?.renderBlocking)}</td>
      <td style="${td}">${d(ov?.uncompressed, cv?.uncompressed)}</td>
      <td style="${td}">${d(ov?.unminified, cv?.unminified)}</td>
      <td style="${td}">${d(ov?.a11yScore, cv?.a11yScore)}</td>
      <td style="${td}">${dSym(ov?.aria, cv?.aria)}</td>
      <td style="${td}">${d(ov?.formLabels, cv?.formLabels)}</td>
      <td style="${td}">${d(ov?.landmarks, cv?.landmarks)}</td>
      <td style="${td}">${d(ov?.focusIssues, cv?.focusIssues)}</td>
      <td style="${td}">${d(ov?.contentScore, cv?.contentScore)}</td>
      <td style="${td}">${d(ov?.wordCount, cv?.wordCount)}</td>
      <td style="${td}">${d(ov?.textToHtmlRatio != null ? ov.textToHtmlRatio + '%' : '', cv?.textToHtmlRatio != null ? cv.textToHtmlRatio + '%' : '')}</td>
      <td style="${td}">${d(ov?.readability, cv?.readability)}</td>
      <td style="${td}text-align:left;font-size:10px;white-space:normal;max-width:120px;overflow:hidden;">${d(ov?.topKeywords, cv?.topKeywords)}</td>
      <td style="${td}">${d(ov?.langDisplay, cv?.langDisplay)}</td>
      <td style="${td}">${d(ov?.prDisplay, cv?.prDisplay)}</td>
      <td style="${td}">${d(ov?.ctaCount, cv?.ctaCount)}</td>
      <td style="${td}">${d(ov?.jsUnused, cv?.jsUnused)}</td>
      <td style="${td}">${d(ov?.brokenLinks, cv?.brokenLinks)}</td>
      <td style="${td}">${d(ov?.mainWords, cv?.mainWords)}</td>
    </tr>`;
  };

  // Build matched rows
  const matchedRows = comparison.matchedPaths.map((match, idx) => {
    const o = originByUrl[match.originUrl];
    const c = compareByUrl[match.compareUrl];
    if (!o && !c) return '';
    const ov = extractPageValues(o, originIncoming);
    const cv = extractPageValues(c, compareIncoming);
    return buildRow(idx, match.path, o?.url || c?.url || '', 'matched', ov, cv, false, false);
  }).join('');

  // Unmatched rows
  const findPageByPath = (pages: Record<string, PageInfo>, path: string) => {
    return Object.values(pages).find(p => {
      try {
        const pathname = new URL(p.url).pathname.toLowerCase();
        return pathname.replace(/\/$/, '') === path || pathname === path;
      } catch { return false; }
    });
  };

  const originOnlyRows = comparison.originOnlyPaths.map((path, idx) => {
    const page = findPageByPath(originByUrl, path);
    if (!page) return '';
    const ov = extractPageValues(page, originIncoming);
    return buildRow(comparison.matchedPaths.length + idx, path, page.url, 'origin-only', ov, null, true, true);
  }).join('');

  const compareOnlyRows = comparison.compareOnlyPaths.map((path, idx) => {
    const page = findPageByPath(compareByUrl, path);
    if (!page) return '';
    const cv = extractPageValues(page, compareIncoming);
    return buildRow(comparison.matchedPaths.length + comparison.originOnlyPaths.length + idx, path, page.url, 'compare-only', null, cv, true, false);
  }).join('');

  const totalRows = comparison.matchedPaths.length + comparison.originOnlyPaths.length + comparison.compareOnlyPaths.length;

  const thStyle = 'padding:5px 6px;text-align:center;font-size:10px;color:#6b7280;font-weight:600;white-space:nowrap;border-bottom:2px solid #e5e7eb;';

  return `
    <div style="margin-bottom: 10px; font-size: 11px; color: #6b7280;">
      Values shown as <span style="color:#3b82f6;font-weight:600;">${escapeHtml(originLabel)}</span><span style="color:#9ca3af;"> / </span><span style="color:#a855f7;font-weight:600;">${escapeHtml(compareLabel)}</span>
    </div>
    <div style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
      <button class="sev-pill active" onclick="filterCompareTable('all', this)">All (${totalRows})</button>
      <button class="sev-pill" onclick="filterCompareTable('matched', this)">Matched (${comparison.matchedPaths.length})</button>
      ${comparison.originOnlyPaths.length > 0 ? `<button class="sev-pill" onclick="filterCompareTable('origin-only', this)">Only ${escapeHtml(originLabel)} (${comparison.originOnlyPaths.length})</button>` : ''}
      ${comparison.compareOnlyPaths.length > 0 ? `<button class="sev-pill" onclick="filterCompareTable('compare-only', this)">Only ${escapeHtml(compareLabel)} (${comparison.compareOnlyPaths.length})</button>` : ''}
      <input type="text" id="compareSearch" placeholder="Filter by path..." style="padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; width: 250px;" onkeyup="filterCompareSearch(this.value)">
    </div>

    <div class="table-container">
      <table id="pagesTable" style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="background: #f9fafb;">
            <th style="${thStyle}">#</th>
            <th style="${thStyle}text-align:left;">Path</th>
            <th style="${thStyle}">Source</th>
            <th style="${thStyle}">Segment</th>
            <th style="${thStyle}">Incoming</th>
            <th style="${thStyle}">URL Len</th>
            <th style="${thStyle}">Depth</th>
            <th style="${thStyle}">Redirects</th>
            <th style="${thStyle}">HTTP Links</th>
            <th style="${thStyle}">Status</th>
            <th style="${thStyle}">Title</th>
            <th style="${thStyle}">Desc</th>
            ${hasPerf ? `
            <th style="${thStyle}">TTFB</th>
            <th style="${thStyle}">FCP</th>
            <th style="${thStyle}">LCP</th>
            <th style="${thStyle}">CLS</th>
            <th style="${thStyle}">INP</th>
            ` : ''}
            <th style="${thStyle}">Size</th>
            <th style="${thStyle}">Requests</th>
            <th style="${thStyle}">Canonical</th>
            <th style="${thStyle}">H1</th>
            <th style="${thStyle}">H2</th>
            <th style="${thStyle}">H Struct</th>
            <th style="${thStyle}">Miss Meta</th>
            <th style="${thStyle}">Alternates</th>
            <th style="${thStyle}">No Text</th>
            <th style="${thStyle}">Sec Score</th>
            <th style="${thStyle}">Miss Hdrs</th>
            <th style="${thStyle}">Cookies</th>
            <th style="${thStyle}">Mixed</th>
            <th style="${thStyle}">No CSRF</th>
            <th style="${thStyle}">Inline JS</th>
            <th style="${thStyle}">Cache</th>
            <th style="${thStyle}">CDN</th>
            <th style="${thStyle}">Cached</th>
            <th style="${thStyle}">Uncached</th>
            <th style="${thStyle}">SW</th>
            <th style="${thStyle}">Images</th>
            <th style="${thStyle}">Lazy</th>
            <th style="${thStyle}">Img KB</th>
            <th style="${thStyle}">Modern</th>
            <th style="${thStyle}">Blocking</th>
            <th style="${thStyle}">Uncompr</th>
            <th style="${thStyle}">Unmin</th>
            <th style="${thStyle}">A11y</th>
            <th style="${thStyle}">ARIA</th>
            <th style="${thStyle}">Labels</th>
            <th style="${thStyle}">Landmarks</th>
            <th style="${thStyle}">Focus</th>
            <th style="${thStyle}">Content</th>
            <th style="${thStyle}">Words</th>
            <th style="${thStyle}">Text/HTML</th>
            <th style="${thStyle}">Read</th>
            <th style="${thStyle}text-align:left;">Keywords</th>
            <th style="${thStyle}">Lang</th>
            <th style="${thStyle}">PR</th>
            <th style="${thStyle}">CTAs</th>
            <th style="${thStyle}">JS Unused</th>
            <th style="${thStyle}">Broken</th>
            <th style="${thStyle}">Main Wds</th>
          </tr>
        </thead>
        <tbody>
          ${matchedRows}
          ${originOnlyRows}
          ${compareOnlyRows}
        </tbody>
      </table>
    </div>

    <script>
    function filterCompareTable(type, btn) {
      document.querySelectorAll('.sev-pill').forEach(function(b) { b.classList.remove('active'); });
      if (btn) btn.classList.add('active');
      document.querySelectorAll('#pagesTable tbody tr').forEach(function(r) {
        if (type === 'all') { r.style.display = ''; return; }
        var match = r.dataset.matchType;
        r.style.display = match === type ? '' : 'none';
      });
    }
    function filterCompareSearch(query) {
      var q = query.toLowerCase();
      document.querySelectorAll('#pagesTable tbody tr').forEach(function(r) {
        var path = (r.dataset.path || '').toLowerCase();
        r.style.display = !q || path.includes(q) ? '' : 'none';
      });
    }
    </script>
  `;
}

export { getPagesTable };
