/**
 * Technology Stack Section
 * Displays detected technologies across the entire site
 */

import { escapeHtml } from '../html-utils';
import type { PageInfo, ReportSectionData, AuditSnapshot } from '../../types';

/**
 * Format detection method for display
 * @param {Object} method - Detection method object
 * @returns {string} Formatted detection method
 */
function formatDetectionMethod(method: Record<string, string>) {
  switch (method.type) {
    case 'html':
      return `HTML pattern: ${method.pattern}`;
    case 'script':
      return `Script: ${method.matched || method.pattern}`;
    case 'meta':
      return `Meta tag <${method.tag}>: "${method.value}"`;
    case 'header':
      return `HTTP header ${method.header}: "${method.value}"`;
    case 'cookie':
      return `Cookie pattern: ${method.pattern}`;
    case 'global':
      return `JavaScript global: window.${method.variable}`;
    default:
      return JSON.stringify(method);
  }
}

/**
 * Aggregate technologies across all pages
 * @param {Array} pages - Array of page data
 * @returns {Object} Aggregated technology data
 */
interface TechEntry {
  name: string;
  category: string;
  count: number;
  pages: string[];
  detectedBy: Set<string> | string[];
  detectedByDetails: Array<Record<string, string>>;
}

interface AggregatedTech {
  technologies: TechEntry[];
  byCategory: Record<string, string[]>;
  totalUnique: number;
}

function aggregateTechnologies(pages: PageInfo[]): AggregatedTech {
  const allTechs = new Map<string, TechEntry>();
  const byCategory: Record<string, Set<string>> = {};

  for (const page of pages) {
    const tech = page.technologies || {};
    const technologies = tech.technologies || [];

    for (const t of technologies) {
      if (!allTechs.has(t.name)) {
        allTechs.set(t.name, {
          name: t.name,
          category: t.category,
          count: 0,
          pages: [],
          detectedBy: new Set(), // Track unique detection methods
          detectedByDetails: [], // Store detailed method info
        });
      }
      const entry = allTechs.get(t.name)!;
      entry.count++;
      if (entry.pages.length < 3) {
        entry.pages.push(page.url);
      }

      // Track detection methods
      if (t.detectedBy && Array.isArray(t.detectedBy)) {
        for (const method of t.detectedBy) {
          const methodKey = method.type;
          if (!(entry.detectedBy as Set<string>).has(methodKey)) {
            (entry.detectedBy as Set<string>).add(methodKey);
            entry.detectedByDetails.push(method);
          }
        }
      }

      // Track by category
      if (!byCategory[t.category]) {
        byCategory[t.category] = new Set();
      }
      byCategory[t.category].add(t.name);
    }
  }

  // Sort by count and convert Sets to arrays
  const sorted = Array.from(allTechs.values())
    .map((t) => ({
      ...t,
      detectedBy: Array.from(t.detectedBy),
    }))
    .sort((a, b) => b.count - a.count);

  // Convert sets to arrays
  const categories: Record<string, string[]> = {};
  for (const [cat, techs] of Object.entries(byCategory)) {
    categories[cat] = Array.from(techs);
  }

  return {
    technologies: sorted,
    byCategory: categories,
    totalUnique: sorted.length,
  };
}

/**
 * Get category icon
 */
function getCategoryIcon(category: string) {
  const icons: Record<string, string> = {
    CMS: '📝',
    'JavaScript Frameworks': '⚛️',
    'CSS Frameworks': '🎨',
    'Analytics & Tracking': '📊',
    'Marketing & CRM': '📣',
    'CDN & Hosting': '☁️',
    'E-commerce & Payments': '💳',
    Security: '🔒',
    'Media & Video': '🎬',
    Fonts: '🔤',
    'SEO Tools': '🔍',
    Other: '🔧',
  };
  return icons[category] || '📦';
}

/**
 * Get category color
 */
function getCategoryColor(category: string) {
  const colors: Record<string, string> = {
    CMS: '#8b5cf6',
    'JavaScript Frameworks': '#3b82f6',
    'CSS Frameworks': '#06b6d4',
    'Analytics & Tracking': '#f59e0b',
    'Marketing & CRM': '#ec4899',
    'CDN & Hosting': '#10b981',
    'E-commerce & Payments': '#f43f5e',
    Security: '#6366f1',
    'Media & Video': '#f97316',
    Fonts: '#84cc16',
    'SEO Tools': '#14b8a6',
    Other: '#6b7280',
  };
  return colors[category] || '#6b7280';
}

/**
 * Compare current technologies with previous audit
 * @param {Object} current - Current aggregated technologies
 * @param {Object} previousAudit - Previous audit snapshot
 * @returns {Object} Comparison data
 */
function compareTechnologies(current: AggregatedTech, previousAudit: AuditSnapshot | null) {
  if (!previousAudit || !previousAudit.technologies) {
    return {
      newTechs: [] as string[],
      removedTechs: [] as string[],
      unchanged: current.technologies.map((t) => t.name),
    };
  }

  const currentNames = new Set<string>(current.technologies.map((t) => t.name));
  const previousNames = new Set<string>(previousAudit.technologies.map((t: string) => t));

  const newTechs = [...currentNames].filter((t) => !previousNames.has(t));
  const removedTechs = [...previousNames].filter((t) => !currentNames.has(t));
  const unchanged = [...currentNames].filter((t) => previousNames.has(t));

  return { newTechs, removedTechs, unchanged };
}

/**
 * Generate the technology stack section
 * @param {Object} data - Report data
 * @param {Array} data.pages - Array of page data
 * @param {Object} data.previousAudit - Previous audit for comparison (optional)
 * @returns {string} HTML string for the technology stack section
 */
function getTechnologyStack(data: ReportSectionData) {
  const { pages, previousAudit } = data;
  const aggregated = aggregateTechnologies(pages);

  // Compare with previous audit if available
  const comparison = compareTechnologies(aggregated, previousAudit ?? null);

  if (aggregated.totalUnique === 0) {
    return `
      <div class="section" id="technology-stack">
        <h2>🔧 Technology Stack</h2>
        <p style="color: #6b7280; text-align: center; padding: 20px;">
          No technologies detected. Technology detection requires crawling with performance metrics enabled.
        </p>
      </div>
    `;
  }

  // Helper: check if a technology has meaningful presence (>0% of pages)
  const hasPresence = (name: string) => {
    const tech = aggregated.technologies.find((t) => t.name === name);
    return tech && pages.length > 0 && Math.round((tech.count / pages.length) * 100) > 0;
  };

  // Group technologies by category
  const categoryHtml = Object.entries(aggregated.byCategory)
    .sort((a: [string, string[]], b: [string, string[]]) => b[1].length - a[1].length)
    .map(([category, techs]: [string, string[]]) => {
      const color = getCategoryColor(category);
      const icon = getCategoryIcon(category);

      const techBadges = techs
        .map((name: string) => {
          const tech = aggregated.technologies.find((t) => t.name === name);
          const count = tech ? tech.count : 0;
          const percentage = pages.length > 0 ? Math.round((count / pages.length) * 100) : 0;
          // Hide technologies that round to 0% — likely false positives or negligible
          if (percentage === 0) return '';

          // Build detection method tooltip HTML
          let detectionHtml = '';
          if (tech && tech.detectedByDetails && tech.detectedByDetails.length > 0) {
            for (const method of tech.detectedByDetails) {
              detectionHtml += `<div>&bull; ${escapeHtml(formatDetectionMethod(method))}</div>`;
            }
          } else if (tech && tech.detectedBy && (tech.detectedBy as string[]).length > 0) {
            const methodLabels: Record<string, string> = {
              html: 'HTML content pattern',
              script: 'Script source URL',
              meta: 'Meta tag',
              header: 'HTTP response header',
              cookie: 'Cookie',
              global: 'JavaScript global variable',
            };
            for (const methodType of tech.detectedBy) {
              detectionHtml += `<div>&bull; ${escapeHtml(methodLabels[methodType] || methodType)}</div>`;
            }
          } else {
            detectionHtml = '<div>&bull; Pattern matching</div>';
          }

          // Encode tooltip content as data attribute
          const tooltipContent = `<strong>${escapeHtml(name)}</strong><br><span class="tt-label">${count} pages (${percentage}%)</span><br><br><span class="tt-label">Detected by:</span>${detectionHtml}`;

          // Get detection type icons
          const detectionIcons = ((tech?.detectedBy || []) as string[])
            .map((type: string) => {
              const icons: Record<string, string> = {
                html: '📄',
                script: '📜',
                meta: '🏷️',
                header: '📨',
                cookie: '🍪',
                global: '🌐',
              };
              return icons[type] || '🔍';
            })
            .join('');

          // Check if this is a new technology compared to previous audit
          const isNew = (comparison.newTechs as string[]).includes(name);
          const newBadge = isNew
            ? `<span style="font-size: 9px; color: white; background: #10b981; padding: 1px 4px; border-radius: 3px; margin-left: 4px; font-weight: 600;">NEW</span>`
            : '';

          return `
          <div class="tech-badge" data-tip="${escapeHtml(tooltipContent)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: ${isNew ? '#d1fae5' : color + '15'}; border: 1px solid ${isNew ? '#10b981' : color + '40'}; border-radius: 6px; margin: 4px; cursor: help;">
            <span style="font-weight: 600; color: ${color};">${escapeHtml(name)}</span>${newBadge}
            <span style="font-size: 11px; color: #6b7280; background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${percentage}%</span>
            ${detectionIcons ? `<span style="font-size: 10px; opacity: 0.7;">${detectionIcons}</span>` : ''}
          </div>
        `;
        })
        .join('');

      // Skip category if all techs were filtered out (0 count)
      const filteredBadges = techBadges.trim();
      if (!filteredBadges) return '';

      const visibleCount = techs.filter((name: string) => hasPresence(name)).length;

      return `
        <div class="tech-category" style="margin-bottom: 20px;">
          <h4 style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: #374151;">
            <span style="font-size: 20px;">${icon}</span>
            <span>${escapeHtml(category)}</span>
            <span style="font-size: 12px; color: #9ca3af; font-weight: normal;">(${visibleCount})</span>
          </h4>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${techBadges}
          </div>
        </div>
      `;
    })
    .join('');

  // Summary stats — only count techs/categories with meaningful presence (>0% of pages)
  const detectedTechs = aggregated.technologies.filter((t) => hasPresence(t.name));
  const detectedCategories = Object.entries(aggregated.byCategory).filter(([, techs]: [string, string[]]) =>
    techs.some((name: string) => hasPresence(name)),
  );
  const totalCategories = detectedCategories.length;

  return `
    <div class="section" id="technology-stack">
      <h2>🔧 Technology Stack</h2>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 25px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
          <div style="font-size: 32px; font-weight: 700;">${detectedTechs.length}</div>
          <div style="font-size: 13px; opacity: 0.9;">Technologies</div>
        </div>
        <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
          <div style="font-size: 32px; font-weight: 700;">${totalCategories}</div>
          <div style="font-size: 13px; opacity: 0.9;">Categories</div>
        </div>
        <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 20px; border-radius: 12px; color: white; text-align: center;">
          <div style="font-size: 32px; font-weight: 700;">${pages.length}</div>
          <div style="font-size: 13px; opacity: 0.9;">Pages Analyzed</div>
        </div>
      </div>

      <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        ${categoryHtml}
      </div>

      ${
        comparison.removedTechs.length > 0
          ? `
      <div style="margin-top: 20px; padding: 15px; background: #fef2f2; border-radius: 8px; border-left: 4px solid #ef4444;">
        <h4 style="margin: 0 0 10px; color: #991b1b;">🗑️ No Longer Detected (${comparison.removedTechs.length})</h4>
        <p style="margin: 0 0 12px; color: #991b1b; font-size: 14px;">
          These technologies were detected in the previous audit but are no longer present:
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${comparison.removedTechs
            .map(
              (name) => `
            <span style="display: inline-block; padding: 4px 10px; background: #fee2e2; border: 1px solid #fecaca; border-radius: 4px; color: #991b1b; font-size: 13px; text-decoration: line-through;">${escapeHtml(name)}</span>
          `,
            )
            .join('')}
        </div>
      </div>
      `
          : ''
      }

      ${
        comparison.newTechs.length > 0
          ? `
      <div style="margin-top: 20px; padding: 15px; background: #f0fdf4; border-radius: 8px; border-left: 4px solid #10b981;">
        <h4 style="margin: 0 0 10px; color: #065f46;">✨ Newly Detected (${comparison.newTechs.length})</h4>
        <p style="margin: 0; color: #065f46; font-size: 14px;">
          ${comparison.newTechs.map((t) => escapeHtml(t)).join(', ')}
        </p>
      </div>
      `
          : ''
      }

      <div style="margin-top: 20px; padding: 15px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
        <h4 style="margin: 0 0 10px; color: #1e40af;">💡 About Technology Detection</h4>
        <p style="margin: 0 0 12px; color: #1e40af; font-size: 14px; line-height: 1.6;">
          Technologies are detected by analyzing multiple signals. <strong>Hover over each technology</strong> to see how it was detected.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: #1e40af;">
          <span title="Detected via HTML content patterns">📄 HTML patterns</span>
          <span title="Detected via script source URLs">📜 Script URLs</span>
          <span title="Detected via meta tags (e.g., generator)">🏷️ Meta tags</span>
          <span title="Detected via HTTP response headers">📨 HTTP headers</span>
          <span title="Detected via cookies">🍪 Cookies</span>
          <span title="Detected via JavaScript global variables">🌐 JS globals</span>
        </div>
      </div>
    </div>
  `;
}

export { getTechnologyStack, aggregateTechnologies };
