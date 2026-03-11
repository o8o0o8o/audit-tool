/**
 * Detailed Issues Report Section
 * Replaces Quick Wins and Top Issues with a comprehensive per-issue breakdown
 * grouped by category, showing severity, fix recommendations, affected pages, and education.
 */

import { escapeHtml } from '../html-utils';
import { ScoreCalculator } from '../../scoring/score-calculator';
import type { ReportSectionData, AnalysisDetail, FixRecommendation } from '../../types';

// ── Educational context for common issue patterns ─────────────────────────────

const ISSUE_EDUCATION: Record<string, { why: string; learnMore: string | null }> = {
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
  'redirect': {
    why: 'Redirect chains slow page loading and waste crawl budget. Redirect loops make pages inaccessible.',
    learnMore: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects',
  },
  'thin content': {
    why: 'Pages with very little content provide poor user experience and are unlikely to rank well in search results.',
    learnMore: 'https://developers.google.com/search/docs/essentials/spam-policies',
  },
  'oversiz': {
    why: 'Oversized images waste bandwidth and slow page loading, especially on mobile devices with limited connections.',
    learnMore: 'https://web.dev/articles/fast#optimize_your_images',
  },
  'third-party': {
    why: 'Excessive third-party scripts compete for bandwidth and CPU, delaying interactive time and hurting Core Web Vitals.',
    learnMore: 'https://web.dev/articles/optimizing-third-party-javascript',
  },
  'font': {
    why: 'Unoptimized font loading causes invisible text (FOIT) or layout shifts (FOUT), hurting CLS and user experience.',
    learnMore: 'https://web.dev/articles/font-best-practices',
  },
};

// ── Category classification ──────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<string, { label: string; icon: string; patterns: string[] }> = {
  seo: {
    label: 'SEO',
    icon: '🔍',
    patterns: [
      'title', 'description', 'canonical', 'h1', 'h2', 'heading', 'sitemap',
      'robots', 'schema', 'structured data', 'alt', 'hreflang', 'alternate',
      'meta', 'og:', 'twitter', 'social', 'link', 'noindex', 'nofollow',
      'keyword', 'content', 'word count', 'readability', 'thin',
      'eeat', 'e-e-a-t', 'author', 'orphan', 'not in sitemap', 'not listed',
      'aeo', 'llms.txt', 'ai ', 'freshness', 'duplicate', 'pagination',
      'language', 'near-duplicate', 'similar content', 'pagerank', 'link equity',
      'conversion', 'cta', 'outbound', 'broken outbound',
    ],
  },
  performance: {
    label: 'Performance',
    icon: '⚡',
    patterns: [
      'ttfb', 'lcp', 'cls', 'fcp', 'inp', 'tbt', 'tti', 'speed',
      'size', 'request', 'cache', 'caching', 'cdn',
      'render-blocking', 'render blocking', 'compression', 'minif',
      'image', 'lazy', 'webp', 'avif', 'font', 'third-party', 'third party',
      'oversiz', 'format', 'resource', 'critical path', 'preload', 'prefetch',
      'service worker', 'pwa', 'unused javascript', 'unused css', 'code coverage',
    ],
  },
  technical: {
    label: 'Technical',
    icon: '🔧',
    patterns: [
      'redirect', '404', '500', 'error', 'http', 'https', 'ssl', 'mixed content',
      'url', 'trailing slash', 'crawl', 'block', 'user-agent',
      'javascript', 'css/js', 'status', 'timeout', 'doctype',
      'iframe', 'refresh', 'cms', 'framework',
      'x-robots-tag', 'response header', 'vary',
    ],
  },
  security: {
    label: 'Security',
    icon: '🔒',
    patterns: [
      'security', 'csrf', 'cookie', 'insecure', 'inline script', 'csp',
      'x-frame', 'hsts', 'xss',
    ],
  },
  accessibility: {
    label: 'Accessibility',
    icon: '♿',
    patterns: [
      'accessibility', 'a11y', 'aria', 'label', 'landmark', 'skip link',
      'focus', 'screen reader', 'contrast', 'wcag',
    ],
  },
};

// ── Crawler error filtering ──────────────────────────────────────────────────

const CRAWLER_ERROR_PATTERNS = [
  'TimeoutError', 'Target page, context or browser has been closed',
  'page.goto:', 'net::ERR_', 'NS_ERROR_', 'Navigation failed',
  'Protocol error', 'Session closed', 'Connection refused',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
];

function isCrawlerError(issue: string) {
  return CRAWLER_ERROR_PATTERNS.some(p => issue.includes(p));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findEducation(issueText: string) {
  const lower = issueText.toLowerCase();
  for (const [pattern, data] of Object.entries(ISSUE_EDUCATION)) {
    if (lower.includes(pattern)) return data;
  }
  return null;
}

function classifyIssue(issue: string): string {
  const lower = issue.toLowerCase();
  for (const [cat, cfg] of Object.entries(CATEGORY_CONFIG)) {
    if (cfg.patterns.some(p => lower.includes(p))) return cat;
  }
  return 'other';
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLORS: Record<string, { bg: string; text: string }> = {
  critical: { bg: '#fef2f2', text: '#991b1b' },
  high: { bg: '#fff7ed', text: '#9a3412' },
  medium: { bg: '#fffbeb', text: '#92400e' },
  low: { bg: '#f0fdf4', text: '#166534' },
};

// ── Main export ──────────────────────────────────────────────────────────────

interface IssueEntry {
  key: string;
  detail: AnalysisDetail;
  category: string;
  fix: FixRecommendation | null;
  impactScore: number;
}

function getIssuesDetail(data: ReportSectionData) {
  const { jsonData } = data;
  const analysisObj = (jsonData.analysis || {}) as Record<string, unknown>;
  const details = (analysisObj.details || {}) as Record<string, AnalysisDetail>;
  const fixes = ScoreCalculator.getFixRecommendations();

  // Build sorted issue list
  const issues: IssueEntry[] = [];
  for (const [key, detail] of Object.entries(details)) {
    if (isCrawlerError(key)) continue;
    const count = detail.count || detail.examples?.length || 0;
    if (count === 0) continue;

    issues.push({
      key,
      detail,
      category: classifyIssue(key),
      fix: fixes[key] || null,
      impactScore: ScoreCalculator.calculateImpactScore(detail.severity, count),
    });
  }

  if (issues.length === 0) return '';

  // Group by category
  const grouped: Record<string, IssueEntry[]> = {};
  for (const issue of issues) {
    if (!grouped[issue.category]) grouped[issue.category] = [];
    grouped[issue.category].push(issue);
  }

  // Sort within each category: severity first, then impact score
  for (const cat of Object.keys(grouped)) {
    grouped[cat].sort((a, b) => {
      const sevDiff = (SEVERITY_ORDER[a.detail.severity] ?? 3) - (SEVERITY_ORDER[b.detail.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      return b.impactScore - a.impactScore;
    });
  }

  // Order categories: show categories with critical/high issues first
  const categoryOrder = Object.keys(grouped).sort((a, b) => {
    const aMin = Math.min(...grouped[a].map(i => SEVERITY_ORDER[i.detail.severity] ?? 3));
    const bMin = Math.min(...grouped[b].map(i => SEVERITY_ORDER[i.detail.severity] ?? 3));
    if (aMin !== bMin) return aMin - bMin;
    return grouped[b].length - grouped[a].length;
  });

  // Count by severity
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    const sev = issue.detail.severity as keyof typeof severityCounts;
    if (sev in severityCounts) severityCounts[sev]++;
  }

  return `
    <div class="top-issues-section">
      <div class="wins-issues-title">
        <span>📋</span>
        <span>All Issues (${issues.length})</span>
      </div>

      <div style="display:flex;gap:10px;justify-content:center;margin-bottom:20px;flex-wrap:wrap;">
        ${severityCounts.critical > 0 ? `<span style="background:#fef2f2;color:#991b1b;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;">${severityCounts.critical} Critical</span>` : ''}
        ${severityCounts.high > 0 ? `<span style="background:#fff7ed;color:#9a3412;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;">${severityCounts.high} High</span>` : ''}
        ${severityCounts.medium > 0 ? `<span style="background:#fffbeb;color:#92400e;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;">${severityCounts.medium} Medium</span>` : ''}
        ${severityCounts.low > 0 ? `<span style="background:#f0fdf4;color:#166534;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600;">${severityCounts.low} Low</span>` : ''}
      </div>

      <!-- Category filter buttons -->
      <div style="display:flex;gap:8px;justify-content:center;margin-bottom:25px;flex-wrap:wrap;">
        <button class="issue-cat-filter active" data-cat="all" onclick="filterIssueCategory('all',this)" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:6px;background:#1f2937;color:white;cursor:pointer;font-size:13px;">All (${issues.length})</button>
        ${categoryOrder.map(cat => {
          const cfg = CATEGORY_CONFIG[cat] || { label: cat, icon: '📌' };
          return `<button class="issue-cat-filter" data-cat="${cat}" onclick="filterIssueCategory('${cat}',this)" style="padding:6px 14px;border:1px solid #d1d5db;border-radius:6px;background:white;cursor:pointer;font-size:13px;">${cfg.icon} ${cfg.label} (${grouped[cat].length})</button>`;
        }).join('')}
      </div>

      ${categoryOrder.map(cat => renderCategoryGroup(cat, grouped[cat])).join('')}
    </div>

    <script>
    function filterIssueCategory(cat, btn) {
      document.querySelectorAll('.issue-cat-filter').forEach(b => {
        b.style.background = 'white'; b.style.color = '#374151';
      });
      btn.style.background = '#1f2937'; btn.style.color = 'white';
      document.querySelectorAll('.issue-category-group').forEach(g => {
        g.style.display = cat === 'all' || g.dataset.cat === cat ? 'block' : 'none';
      });
    }
    </script>
  `;
}

// ── Category group ───────────────────────────────────────────────────────────

function renderCategoryGroup(category: string, issues: IssueEntry[]) {
  const cfg = CATEGORY_CONFIG[category] || { label: category, icon: '📌' };

  return `
    <div class="issue-category-group" data-cat="${category}" style="margin-bottom:30px;">
      <h3 style="color:#1f2937;margin-bottom:15px;padding-bottom:8px;border-bottom:2px solid #e5e7eb;font-size:16px;">
        ${cfg.icon} ${cfg.label}
        <span style="font-weight:400;font-size:13px;color:#6b7280;margin-left:8px;">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>
      </h3>
      ${issues.map((issue, idx) => renderIssueCard(issue, `${category}-${idx}`)).join('')}
    </div>
  `;
}

// ── Single issue card ────────────────────────────────────────────────────────

function renderIssueCard(issue: IssueEntry, uid: string) {
  const { key, detail, fix, impactScore } = issue;
  const sev = detail.severity;
  const colors = SEVERITY_COLORS[sev] || SEVERITY_COLORS.medium;
  const count = detail.count || detail.examples?.length || 0;
  const examples = detail.examples || [];
  const education = findEducation(key);

  // Quick win badge
  const effortMinutes = fix?.effort ? ScoreCalculator.parseEffort(fix.effort) : 999;
  const isQuickWin = impactScore >= 40 && effortMinutes <= 30;

  const VISIBLE_EXAMPLES = 5;

  return `
    <div class="issue-card" style="border-left:4px solid ${colors.text};margin-bottom:12px;">
      <div class="issue-header" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div class="issue-title" style="flex:1;min-width:200px;">${escapeHtml(key)}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span class="issue-badge-item" style="background:${colors.bg};color:${colors.text};text-transform:capitalize;">${sev}</span>
          <span class="issue-badge-item">${count} affected</span>
          ${fix?.effort ? `<span class="issue-badge-item" style="background:#eff6ff;color:#1d4ed8;">⏱️ ${escapeHtml(fix.effort)}</span>` : ''}
          ${isQuickWin ? `<span class="issue-badge-item" style="background:#fef3c7;color:#92400e;">🎯 Quick Win</span>` : ''}
        </div>
      </div>

      ${education ? `
      <div style="margin:10px 0;padding:8px 12px;background:#f8fafc;border-radius:6px;font-size:13px;color:#475569;">
        <strong>Why it matters:</strong> ${education.why}
        ${education.learnMore ? ` <a href="${education.learnMore}" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;font-size:12px;">Learn more &rarr;</a>` : ''}
      </div>
      ` : ''}

      ${fix ? `
      <div class="fix-content" style="margin:10px 0;">
        <strong style="display:block;margin-bottom:6px;">✅ How to fix:</strong>
        ${escapeHtml(fix.fix)}
        ${fix.example ? `
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:12px;color:#3b82f6;font-weight:600;">Show code example</summary>
          <div class="code-example" style="margin-top:6px;">${escapeHtml(fix.example)}</div>
        </details>` : ''}
        ${fix.resources && fix.resources.length > 0 ? `
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          ${fix.resources.map(r => `<a href="${r.url}" target="_blank" rel="noopener noreferrer" class="resource-link">${escapeHtml(r.text)}</a>`).join('')}
        </div>` : ''}
      </div>
      ` : ''}

      ${examples.length > 0 ? `
      <div class="affected-pages" style="margin-top:10px;">
        <strong>Affected pages (${count}):</strong>
        <div class="issue-examples-list" style="margin-top:5px;">
          ${examples.slice(0, VISIBLE_EXAMPLES).map(ex => `<div class="issue-example-item">${escapeHtml(ex)}</div>`).join('')}
          ${examples.length > VISIBLE_EXAMPLES ? `
            <div class="issue-examples-hidden" id="issue-ex-${uid}" style="display:none;">
              ${examples.slice(VISIBLE_EXAMPLES).map(ex => `<div class="issue-example-item">${escapeHtml(ex)}</div>`).join('')}
            </div>
            <button class="issue-toggle-btn" onclick="var el=document.getElementById('issue-ex-${uid}');var showing=el.style.display!=='none';el.style.display=showing?'none':'block';this.textContent=showing?'Show all ${examples.length} pages...':'Show less';">Show all ${examples.length} pages...</button>
          ` : ''}
          ${count > examples.length ? `<div style="opacity:0.6;font-size:12px;margin-top:2px;">(${count} total occurrences, showing ${examples.length} examples)</div>` : ''}
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

export { getIssuesDetail };
