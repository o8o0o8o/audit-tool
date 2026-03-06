/**
 * Pages Table Section
 * Displays the detailed pages data table with all metrics
 */

const { THRESHOLDS, METRIC_INFO } = require('../metrics-metadata');
const {
  escapeHtml,
  formatBytes,
  getStatusColor,
  getMetricColor,
  getTextLengthColor,
  getMissingMetaTags,
  hasHeadingStructureIssue,
  getMetricTooltip,
  getTextLengthTooltip,
} = require('../html-utils');

/**
 * Get column header with description tooltip from METRIC_INFO
 * @param {string} signalKey - Key from METRIC_INFO
 * @param {string} displayName - Optional override for display name
 * @param {string} thresholdText - Text to show as threshold
 * @returns {string} HTML for header cell
 */
function getColumnHeader(signalKey, displayName = null, thresholdText = null) {
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
 * Generate the pages table section
 * @param {Object} data - Report data
 * @param {Array} data.pages - Array of page data
 * @param {boolean} data.hasPerformanceMetrics - Whether performance metrics are available
 * @returns {string} HTML string for the pages table
 */
function getPagesTable(data) {
  const { pages, hasPerformanceMetrics } = data;

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
                ${getTableHeader(hasPerformanceMetrics)}
            </thead>
            <tbody>
                ${pages.map((page, index) => getTableRow(page, index, hasPerformanceMetrics)).join('')}
            </tbody>
        </table>
    </div>
  `;
}

/**
 * Generate the table header row with descriptions from METRIC_INFO
 */
function getTableHeader(hasPerformanceMetrics) {
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
        <th class="sortable" data-type="number" data-column="2" title="${escapeHtml(METRIC_INFO.hasIncomingLinks?.description || 'Number of internal links pointing to this page. Pages without incoming links (orphans) may not be discovered by crawlers.')}"
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
        ${hasPerformanceMetrics ? `
        ${getColumnHeader('ttfb', 'TTFB', `≤ ${THRESHOLDS.TTFB}ms`)}
        ${getColumnHeader('fcp', 'FCP', `≤ ${THRESHOLDS.FCP}ms`)}
        ${getColumnHeader('lcp', 'LCP', `≤ ${THRESHOLDS.LCP}ms`)}
        ${getColumnHeader('cls', 'CLS', `≤ ${THRESHOLDS.CLS}`)}
        ` : ''}
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
    </tr>
  `;
}

/**
 * Generate a single table row for a page
 */
function getTableRow(page, index, hasPerformanceMetrics) {
  const titleLength = page.title?.length || 0;
  const descLength = page.description?.length || 0;
  const titleColor = getTextLengthColor(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX);
  const descColor = getTextLengthColor(descLength, THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX);
  const titleTooltip = getTextLengthTooltip(titleLength, THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX, 'Title');
  const descTooltip = getTextLengthTooltip(descLength, THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX, 'Description');

  // Handle both old array format and new object format
  const h1Count = Array.isArray(page.headings)
    ? (page.headings.filter(h => h.tag === 'h1')[0]?.count || 0)
    : (page.headings?.h1?.length || 0);
  const h2Count = Array.isArray(page.headings)
    ? (page.headings.filter(h => h.tag === 'h2')[0]?.count || 0)
    : (page.headings?.h2?.length || 0);

  // Convert object format to array format for structure check
  const headingsArray = Array.isArray(page.headings)
    ? page.headings
    : page.headings ? [
        { tag: 'h1', count: page.headings.h1?.length || 0 },
        { tag: 'h2', count: page.headings.h2?.length || 0 },
        { tag: 'h3', count: page.headings.h3?.length || 0 },
        { tag: 'h4', count: page.headings.h4?.length || 0 },
        { tag: 'h5', count: page.headings.h5?.length || 0 },
        { tag: 'h6', count: page.headings.h6?.length || 0 },
      ] : null;
  const hasHStructureIssue = hasHeadingStructureIssue(headingsArray);
  const missingMeta = getMissingMetaTags(page);
  const alternatesCount = page.alternates?.length || 0;
  const linksWithoutText = page.links?.filter(link => !link.text || link.text.trim() === '').length || 0;

  // Security metrics
  const securityScore = page.security?.securityScore ?? null;
  const missingSecHeaders = page.security?.missingHeaders?.length || 0;
  const mixedContent = page.security?.mixedContent || 0;
  const insecureCookies = page.security?.insecureCookies || 0;
  const formsWithoutCSRF = page.security?.formsWithoutCSRF || 0;
  const inlineScripts = page.security?.inlineScripts || 0;
  const securityTooltip = buildSecurityTooltip(page, securityScore, missingSecHeaders, mixedContent, insecureCookies, formsWithoutCSRF, inlineScripts);

  // Caching metrics
  const cacheScore = page.caching?.cacheScore ?? null;
  const hasCDN = page.caching?.hasCDN || false;
  const cdnProvider = page.caching?.cdnProvider || null;
  const uncachedStatic = page.caching?.staticUncached || 0;
  const cachedStatic = page.caching?.staticCached || 0;
  const hasServiceWorker = page.caching?.hasServiceWorker || false;
  const cachingTooltip = buildCachingTooltip(page, cacheScore, hasCDN, cdnProvider, cachedStatic, uncachedStatic, hasServiceWorker);

  // Keywords for filtering
  const keywords = (page.contentQuality?.topKeywords || []).map(k => k.word.toLowerCase()).join(',');
  const titleWords = (page.title || '').toLowerCase();

  return `
    <tr data-keywords="${escapeHtml(keywords)}" data-title="${escapeHtml(titleWords)}" data-segment="${page.segment || 'other'}" data-has-errors="${page.status >= 400 || missingMeta.length > 3 ? 'true' : 'false'}" data-ttfb="${page.TTFB || 0}" data-status="${page.status || ''}" data-missing-meta="${missingMeta.length > 0 ? 'true' : 'false'}" data-h1-count="${h1Count}">
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
            <span class="segment-badge segment-${page.segment || 'other'}" style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: ${getSegmentColor(page.segment)}; color: white;" title="Page segment: ${page.segment || 'other'}">${getSegmentLabel(page.segment)}</span>
        </td>
        <td class="incoming-links-cell"
            style="color: ${page.incomingLinksCount > 0 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center; cursor: ${page.incomingLinksCount > 0 ? 'pointer' : 'default'}; position: relative;"
            data-url="${escapeHtml(page.url)}"
            data-count="${page.incomingLinksCount || 0}"
            title="${page.incomingLinksCount > 0 ? 'Click to see ' + page.incomingLinksCount + ' incoming link(s)' : 'No incoming links - page is orphaned (only accessible via sitemap)'}">
            ${page.incomingLinksCount || 0}${page.incomingLinksCount > 0 ? ' <span style="font-size: 10px; opacity: 0.7;">ℹ</span>' : ''}
        </td>
        <td style="color: ${getMetricColor(page.urlAnalysis?.length || 0, THRESHOLDS.URL_LENGTH_RECOMMENDED, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.length > THRESHOLDS.URL_LENGTH_MAX ? 'Error: URL too long (' + page.urlAnalysis.length + ' chars)' : (page.urlAnalysis?.length > THRESHOLDS.URL_LENGTH_RECOMMENDED ? 'Warning: URL longer than recommended (' + page.urlAnalysis.length + ' chars)' : 'Good: URL length is optimal')}">
            ${page.urlAnalysis?.length || 0}
        </td>
        <td style="color: ${getMetricColor(page.urlAnalysis?.depth || 0, THRESHOLDS.URL_DEPTH_MAX, true)}; font-weight: 600; text-align: center;" title="${page.urlAnalysis?.depth > THRESHOLDS.URL_DEPTH_MAX ? 'Warning: URL is too deep (' + page.urlAnalysis.depth + ' levels)' : 'Good: URL depth is optimal'}">
            ${page.urlAnalysis?.depth || 0}
        </td>
        <td style="color: ${page.redirectCount > 2 ? '#ef4444' : (page.redirectCount > 0 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="${page.redirectCount > 0 ? 'Warning: ' + page.redirectCount + ' redirect(s) detected' + (page.redirectChain ? ': ' + page.redirectChain.map(r => r.url).join(' → ') : '') : 'Good: No redirects'}">
            ${page.redirectCount || 0}
        </td>
        <td style="color: ${page.httpLinksCount > 0 ? '#ef4444' : '#10b981'}; font-weight: 600; text-align: center;" title="${page.httpLinksCount > 0 ? 'Error: ' + page.httpLinksCount + ' HTTP link(s) on HTTPS site' : 'Good: No HTTP links'}">
            ${page.httpLinksCount || 0}
        </td>
        <td><span class="status-badge" style="background: ${getStatusColor(page.status)};">${page.status || 'N/A'}</span></td>
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
        ${hasPerformanceMetrics ? `
        <td class="metric-cell" style="color: ${getMetricColor(page.TTFB, THRESHOLDS.TTFB, true)};" title="${getMetricTooltip(page.TTFB, THRESHOLDS.TTFB, 'TTFB', 'ms', true)}">
            ${page.TTFB || 'N/A'}${page.TTFB ? 'ms' : ''}
        </td>
        <td class="metric-cell" style="color: ${getMetricColor(page.FCP, THRESHOLDS.FCP, true)};" title="${getMetricTooltip(page.FCP, THRESHOLDS.FCP, 'FCP', 'ms', true)}">
            ${page.FCP || 'N/A'}${page.FCP ? 'ms' : ''}
        </td>
        <td class="metric-cell" style="color: ${getMetricColor(page.LCP, THRESHOLDS.LCP, true)};" title="${getMetricTooltip(page.LCP, THRESHOLDS.LCP, 'LCP', 'ms', true)}">
            ${page.LCP || 'N/A'}${page.LCP ? 'ms' : ''}
        </td>
        <td class="metric-cell" style="color: ${getMetricColor(page.CLS, THRESHOLDS.CLS, true)};" title="${getMetricTooltip(page.CLS, THRESHOLDS.CLS, 'CLS', '', true)}">
            ${page.CLS !== undefined ? page.CLS : 'N/A'}
        </td>
        ` : ''}
        <td class="metric-cell" style="color: ${getMetricColor(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, true)};" title="${getMetricTooltip(page.totalResponseSize, THRESHOLDS.PAGE_SIZE, 'Page Size', ' bytes', true)}">
            ${formatBytes(page.totalResponseSize || 0)}
        </td>
        <td class="metric-cell" style="color: ${getMetricColor(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, true)};" title="${getMetricTooltip(page.totalNumberOfRequests, THRESHOLDS.REQUEST_COUNT, 'Requests', '', true)}">
            ${page.totalNumberOfRequests || 0}
        </td>
        <td style="text-align: center;">
            ${page.canonical ?
                (page.canonical === page.url ? '<span style="color: #10b981;" title="Canonical URL matches page URL">✓</span>' : '<span style="color: #f59e0b;" title="Canonical URL differs: ' + escapeHtml(page.canonical) + '">⚠</span>')
                : '<span style="color: #ef4444;" title="Canonical URL is missing">✗</span>'}
        </td>
        <td style="color: ${h1Count === 1 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h1Count === 1 ? 'Perfect: Page has exactly 1 H1 tag' : (h1Count === 0 ? 'Error: Page is missing H1 tag' : 'Error: Page has ' + h1Count + ' H1 tags (should be exactly 1)')}">
            ${h1Count}
        </td>
        <td style="color: ${h2Count <= THRESHOLDS.H2_COUNT ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="${h2Count <= THRESHOLDS.H2_COUNT ? 'Good: H2 count is within threshold' : 'Warning: Too many H2 tags (' + h2Count + ', recommended: ≤' + THRESHOLDS.H2_COUNT + ')'}">
            ${h2Count}
        </td>
        <td style="text-align: center;">
            ${hasHStructureIssue ?
                '<span style="color: #ef4444;" title="Error: Heading hierarchy has gaps (e.g., h1 to h3 without h2)">✗</span>' :
                '<span style="color: #10b981;" title="Good: Heading hierarchy is correct">✓</span>'}
        </td>
        <td style="color: ${missingMeta.length === 0 ? '#10b981' : (missingMeta.length <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${missingMeta.length === 0 ? 'Good: All important meta tags are present' : 'Missing meta tags: ' + missingMeta.join(', ')}">
            ${missingMeta.length}
        </td>
        <td style="color: ${alternatesCount > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${alternatesCount > 0 ? alternatesCount + ' alternate language link(s)' : 'No alternate language links'}">
            ${alternatesCount}
        </td>
        <td style="color: ${linksWithoutText === 0 ? '#10b981' : (linksWithoutText <= 3 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${linksWithoutText === 0 ? 'Good: All links have text' : 'Warning: ' + linksWithoutText + ' link(s) without text'}">
            ${linksWithoutText}
        </td>
        <td style="color: ${securityScore === null ? '#9ca3af' : (securityScore >= 70 ? '#10b981' : (securityScore >= 50 ? '#f59e0b' : '#ef4444'))}; font-weight: 600; text-align: center; white-space: pre-line;" title="${securityTooltip}">
            ${securityScore !== null ? securityScore : 'N/A'}
        </td>
        <td style="color: ${missingSecHeaders === 0 ? '#10b981' : (missingSecHeaders <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${missingSecHeaders === 0 ? 'Good: All security headers present' : 'Missing headers: ' + (page.security?.missingHeaders?.join(', ') || '')}">
            ${missingSecHeaders}
        </td>
        <td style="color: ${insecureCookies === 0 ? '#10b981' : (insecureCookies <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${insecureCookies === 0 ? 'Good: All cookies are secure' : 'Warning: ' + insecureCookies + ' cookie(s) without Secure/HttpOnly flags'}">
            ${insecureCookies}
        </td>
        <td style="color: ${mixedContent === 0 ? '#10b981' : (mixedContent <= 3 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${mixedContent === 0 ? 'Good: No mixed content' : 'Warning: ' + mixedContent + ' HTTP resources on HTTPS page'}">
            ${mixedContent}
        </td>
        <td style="color: ${formsWithoutCSRF === 0 ? '#10b981' : (formsWithoutCSRF <= 2 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${formsWithoutCSRF === 0 ? 'Good: All forms have CSRF protection' : 'Warning: ' + formsWithoutCSRF + ' form(s) without CSRF tokens'}">
            ${formsWithoutCSRF}
        </td>
        <td style="color: ${inlineScripts <= 5 ? '#10b981' : (inlineScripts <= 10 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${inlineScripts <= 5 ? 'Good: Minimal inline scripts' : 'Warning: ' + inlineScripts + ' inline scripts (potential XSS risk)'}">
            ${inlineScripts}
        </td>
        <td style="color: ${cacheScore === null ? '#9ca3af' : (cacheScore >= 70 ? '#10b981' : (cacheScore >= 50 ? '#f59e0b' : '#ef4444'))}; font-weight: 600; text-align: center; white-space: pre-line;" title="${cachingTooltip}">
            ${cacheScore !== null ? cacheScore : 'N/A'}
        </td>
        <td style="text-align: center;">
            ${hasCDN ?
                '<span style="color: #10b981;" title="CDN detected' + (cdnProvider ? ': ' + cdnProvider : '') + '">✓</span>' :
                '<span style="color: #f59e0b;" title="No CDN detected">✗</span>'}
        </td>
        <td style="color: ${cachedStatic > 0 ? '#10b981' : '#9ca3af'}; font-weight: 600; text-align: center;" title="${cachedStatic > 0 ? cachedStatic + ' static resources cached' : 'No cached static resources'}">
            ${cachedStatic}
        </td>
        <td style="color: ${uncachedStatic === 0 ? '#10b981' : (uncachedStatic <= 5 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${uncachedStatic === 0 ? 'Good: All static resources are cached' : 'Warning: ' + uncachedStatic + ' static resources without caching'}">
            ${uncachedStatic}
        </td>
        <td style="text-align: center;">
            ${hasServiceWorker ?
                '<span style="color: #10b981;" title="Service Worker is active">✓</span>' :
                '<span style="color: #f59e0b;" title="No Service Worker detected">✗</span>'}
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
function buildSecurityTooltip(page, securityScore, missingSecHeaders, mixedContent, insecureCookies, formsWithoutCSRF, inlineScripts) {
  if (securityScore === null) {
    return 'Security analysis not available';
  }

  const scoreBreakdown = [];
  scoreBreakdown.push('Security Score Breakdown:');
  scoreBreakdown.push('');

  if (missingSecHeaders === 0) {
    scoreBreakdown.push('✓ All security headers present');
  } else {
    scoreBreakdown.push('✗ Missing ' + missingSecHeaders + ' security header(s): ' + (page.security?.missingHeaders?.join(', ') || ''));
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
function buildCachingTooltip(page, cacheScore, hasCDN, cdnProvider, cachedStatic, uncachedStatic, hasServiceWorker) {
  if (cacheScore === null) {
    return 'Caching analysis not available';
  }

  const cacheBreakdown = [];
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
      cacheBreakdown.push('✓ All static resources cached: ' + cachedStatic + '/' + totalStatic + ' (+' + points + ' points)');
    } else {
      cacheBreakdown.push('⚠ Static resources: ' + cachedStatic + ' cached, ' + uncachedStatic + ' uncached (+' + points + '/40 points)');
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
      cacheBreakdown.push('✓ Dynamic content: ' + dynamicCached + '/' + totalDynamic + ' cached (+' + points + ' points)');
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
function getImageOptimizationCells(page) {
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
    <td style="color: ${totalImages > 0 && lazyImages === 0 ? '#ef4444' : (lazyImages > 0 ? '#10b981' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${lazyImages} images with lazy loading (${totalImages} total)">
        ${lazyImages}/${totalImages}
    </td>
    <td style="color: ${totalImageSize > 1000000 ? '#ef4444' : (totalImageSize > 500000 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="Total image size: ${Math.round(totalImageSize / 1000)}KB">
        ${Math.round(totalImageSize / 1000)}
    </td>
    <td style="color: ${legacyFormats > 0 && modernFormats === 0 ? '#f59e0b' : (modernFormats > 0 ? '#10b981' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${modernFormats} modern format images (WebP/AVIF), ${legacyFormats} legacy format images (JPG/PNG)">
        ${modernFormats}/${totalImages}
    </td>
    <td style="color: ${renderBlocking > 5 ? '#ef4444' : (renderBlocking > 0 ? '#f59e0b' : '#10b981')}; font-weight: 600; text-align: center;" title="${renderBlocking} render-blocking resources">
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
function getAccessibilityCells(page) {
  const a11y = page.accessibility || {};

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
    <td style="color: ${a11yScore >= 70 ? '#10b981' : (a11yScore >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Accessibility Score: ${a11yScore}/100">
        ${a11yScore}
    </td>
    <td style="text-align: center;">
        ${ariaInvalid > 0 ?
            '<span style="color: #ef4444;" title="' + ariaInvalid + ' invalid ARIA roles">✗</span>' :
            (ariaValid > 0 ? '<span style="color: #10b981;" title="' + ariaValid + ' valid ARIA roles">✓</span>' : '<span style="color: #9ca3af;">—</span>')}
    </td>
    <td style="color: ${totalInputs > 0 && inputsWithoutLabels === 0 ? '#10b981' : (inputsWithoutLabels > 0 ? '#ef4444' : '#9ca3af')}; font-weight: 600; text-align: center;" title="${inputsWithLabels} inputs with labels, ${inputsWithoutLabels} without">
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
function getSegmentColor(segment) {
  const colors = {
    blog: '#3b82f6',       // blue
    product: '#10b981',    // green
    category: '#8b5cf6',   // purple
    tag: '#6366f1',        // indigo
    search: '#f59e0b',     // amber
    account: '#64748b',    // slate
    checkout: '#ec4899',   // pink
    legal: '#6b7280',      // gray
    contact: '#06b6d4',    // cyan
    media: '#f97316',      // orange
    landing: '#14b8a6',    // teal
    api: '#ef4444',        // red
    other: '#9ca3af',      // gray
  };
  return colors[segment] || colors.other;
}

/**
 * Get segment label based on segment type
 */
function getSegmentLabel(segment) {
  const labels = {
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
function getContentQualityCells(page) {
  const content = page.contentQuality || {};

  const contentScore = content.contentScore ?? 'N/A';
  const wordCount = content.wordCount || 0;
  const textToHtmlRatio = content.textToHtmlRatio || 0;
  const readability = content.readabilityScore || 0;
  const topKeywords = content.topKeywords || [];
  const topKeywordsStr = topKeywords.slice(0, 3).map(k => `${k.word}(${k.density}%)`).join(', ');

  return `
    <td style="color: ${contentScore >= 70 ? '#10b981' : (contentScore >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Content Quality Score: ${contentScore}/100">
        ${contentScore}
    </td>
    <td style="color: ${wordCount >= 600 ? '#10b981' : (wordCount >= 300 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="${wordCount} words (min: 300, recommended: 600)">
        ${wordCount}
    </td>
    <td style="color: ${textToHtmlRatio >= 25 ? '#10b981' : '#ef4444'}; font-weight: 600; text-align: center;" title="Text-to-HTML ratio: ${textToHtmlRatio}% (min: 25%)">
        ${textToHtmlRatio}%
    </td>
    <td style="color: ${readability >= 60 ? '#10b981' : (readability >= 50 ? '#f59e0b' : '#ef4444')}; font-weight: 600; text-align: center;" title="Flesch Reading Ease: ${readability}/100 (60-70 is standard)">
        ${readability}
    </td>
    <td style="font-size: 11px; text-align: left;" title="Top keywords: ${topKeywords.map(k => `${k.word}: ${k.count} times (${k.density}%)`).join(', ')}">
        ${topKeywordsStr || '—'}
    </td>
  `;
}

module.exports = { getPagesTable };
