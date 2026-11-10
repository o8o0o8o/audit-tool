/**
 * Technology Stack Section
 * Displays detected technologies across the entire site
 */

import { escapeHtml } from '../html-utils';
import { extractComparisonLabels } from '../comparison-helpers';
import type { PageInfo, ReportSectionData, AuditSnapshot, ComparisonData } from '../../types';

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
    const tech = page.technologies;
    const technologies = tech?.technologies ?? [];

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
  return icons[category] ?? '📦';
}

/**
 * Get category color
 */
function getCategoryColor(category: string) {
  const colors: Record<string, string> = {
    CMS: '#8b5cf6',
    'JavaScript Frameworks': 'var(--color-info)',
    'CSS Frameworks': '#06b6d4',
    'Analytics & Tracking': 'var(--color-warning)',
    'Marketing & CRM': '#ec4899',
    'CDN & Hosting': 'var(--color-success)',
    'E-commerce & Payments': '#f43f5e',
    Security: '#6366f1',
    'Media & Video': '#f97316',
    Fonts: '#84cc16',
    'SEO Tools': '#14b8a6',
    Other: 'var(--color-text-muted)',
  };
  return colors[category] ?? 'var(--color-text-muted)';
}

/**
 * Compare current technologies with previous audit
 * @param {Object} current - Current aggregated technologies
 * @param {Object} previousAudit - Previous audit snapshot
 * @returns {Object} Comparison data
 */
function compareTechnologies(current: AggregatedTech, previousAudit: AuditSnapshot | null) {
  if (!previousAudit?.technologies) {
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
  if (data.comparison) {
    return getComparisonTechnologyStack(data.pages, data.comparison);
  }

  const { pages, previousAudit } = data;
  const aggregated = aggregateTechnologies(pages);

  // Compare with previous audit if available
  const comparison = compareTechnologies(aggregated, previousAudit ?? null);

  if (aggregated.totalUnique === 0) {
    return `
      <div class="section" id="technology-stack">
        <h2>🔧 Technology Stack</h2>
        <p style="color: var(--color-text-muted); text-align: center; padding: 20px;">
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
          if (tech?.detectedByDetails && tech.detectedByDetails.length > 0) {
            for (const method of tech.detectedByDetails) {
              detectionHtml += `<div>&bull; ${escapeHtml(formatDetectionMethod(method))}</div>`;
            }
          } else if (tech?.detectedBy && (tech.detectedBy as string[]).length > 0) {
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
          const detectionIcons = ((tech?.detectedBy ?? []) as string[])
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
            ? `<span style="font-size: 9px; color: #000; background: var(--color-success); padding: 1px 4px; border-radius: 3px; margin-left: 4px; font-weight: var(--font-weight-semibold);">NEW</span>`
            : '';

          return `
          <div class="tech-badge" data-tip="${escapeHtml(tooltipContent)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: ${isNew ? 'var(--color-success-bg)' : color + '15'}; border: 1px solid ${isNew ? 'var(--color-success)' : color + '40'}; border-radius: var(--radius-md); margin: 4px; cursor: help;">
            <span style="font-weight: var(--font-weight-semibold); color: ${color};">${escapeHtml(name)}</span>${newBadge}
            <span style="font-size: var(--font-size-xs); color: var(--color-text-muted); background: var(--color-bg-surface-alt); padding: 2px 6px; border-radius: var(--radius-sm);">${percentage}%</span>
            ${detectionIcons ? `<span style="font-size: var(--font-size-2xs); opacity: 0.7;">${detectionIcons}</span>` : ''}
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
          <h4 style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--color-text-secondary);">
            <span style="font-size: var(--font-size-lg);">${icon}</span>
            <span>${escapeHtml(category)}</span>
            <span style="font-size: var(--font-size-xs); color: var(--color-text-disabled); font-weight: normal;">(${visibleCount})</span>
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
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #667eea; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${detectedTechs.length}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Technologies</div>
        </div>
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #f093fb; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${totalCategories}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Categories</div>
        </div>
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #4facfe; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${pages.length}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Pages Analyzed</div>
        </div>
      </div>

      <div style="background: var(--color-bg-surface); border-radius: var(--radius-xl); padding: 20px; box-shadow: var(--shadow-sm);">
        ${categoryHtml}
      </div>

      ${
        comparison.removedTechs.length > 0
          ? `
      <div style="margin-top: 20px; padding: 15px; background: var(--color-error-bg); border-radius: var(--radius-lg); border-left: 4px solid var(--color-error);">
        <h4 style="margin: 0 0 10px; color: var(--color-error-text);">🗑️ No Longer Detected (${comparison.removedTechs.length})</h4>
        <p style="margin: 0 0 12px; color: var(--color-error-text); font-size: var(--font-size-base);">
          These technologies were detected in the previous audit but are no longer present:
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${comparison.removedTechs
            .map(
              (name) => `
            <span style="display: inline-block; padding: 4px 10px; background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: var(--radius-sm); color: var(--color-error-text); font-size: var(--font-size-sm); text-decoration: line-through;">${escapeHtml(name)}</span>
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
      <div style="margin-top: 20px; padding: 15px; background: var(--color-success-bg); border-radius: var(--radius-lg); border-left: 4px solid var(--color-success);">
        <h4 style="margin: 0 0 10px; color: var(--color-success-text);">✨ Newly Detected (${comparison.newTechs.length})</h4>
        <p style="margin: 0; color: var(--color-success-text); font-size: var(--font-size-base);">
          ${comparison.newTechs.map((t) => escapeHtml(t)).join(', ')}
        </p>
      </div>
      `
          : ''
      }

      <div style="margin-top: 20px; padding: 15px; background: var(--color-info-bg); border-radius: var(--radius-lg); border-left: 4px solid var(--color-info);">
        <h4 style="margin: 0 0 10px; color: var(--color-info-text);">💡 About Technology Detection</h4>
        <p style="margin: 0 0 12px; color: var(--color-info-text); font-size: var(--font-size-base); line-height: 1.6;">
          Technologies are detected by analyzing multiple signals. <strong>Hover over each technology</strong> to see how it was detected.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: var(--font-size-xs); color: var(--color-info-text);">
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

function getComparisonTechnologyStack(originPages: PageInfo[], comparison: ComparisonData) {
  const originAgg = aggregateTechnologies(originPages);
  const compareAgg = aggregateTechnologies(comparison.comparePages);

  const { originLabel, compareLabel } = extractComparisonLabels(comparison);

  if (originAgg.totalUnique === 0 && compareAgg.totalUnique === 0) {
    return `<div class="section" id="technology-stack"><h2>🔧 Technology Stack</h2><p style="color: var(--color-text-muted); text-align: center; padding: 20px;">No technologies detected.</p></div>`;
  }

  const originNames = new Set(originAgg.technologies.map((t) => t.name));
  const compareNames = new Set(compareAgg.technologies.map((t) => t.name));
  const allNames = new Set([...originNames, ...compareNames]);

  const onlyOrigin = [...allNames].filter((n) => originNames.has(n) && !compareNames.has(n));
  const onlyCompare = [...allNames].filter((n) => !originNames.has(n) && compareNames.has(n));
  const shared = [...allNames].filter((n) => originNames.has(n) && compareNames.has(n));

  const renderBadges = (names: string[], style: string) =>
    names
      .map(
        (name) =>
          `<span style="${style};display:inline-block;padding:4px 10px;border-radius:6px;margin:3px;font-size:var(--font-size-xs);font-weight:500;">${escapeHtml(name)}</span>`,
      )
      .join('');

  return `
    <div class="section" id="technology-stack">
      <h2>🔧 Technology Stack (Comparison)</h2>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 25px;">
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #667eea; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${shared.length}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Shared</div>
        </div>
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #3b82f6; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${onlyOrigin.length}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Only ${escapeHtml(originLabel)}</div>
        </div>
        <div style="background: var(--color-bg-surface-alt); border: 1px solid var(--color-border-default); border-top: 3px solid #a855f7; padding: 20px; border-radius: var(--radius-xl); color: var(--color-text-primary); text-align: center;">
          <div style="font-size: 32px; font-weight: var(--font-weight-bold);">${onlyCompare.length}</div>
          <div style="font-size: var(--font-size-sm); opacity: 0.9;">Only ${escapeHtml(compareLabel)}</div>
        </div>
      </div>

      <div style="background: var(--color-bg-surface); border-radius: var(--radius-xl); padding: 20px; box-shadow: var(--shadow-sm);">
        ${
          shared.length > 0
            ? `
        <div style="margin-bottom: 20px;">
          <h4 style="color: var(--color-text-secondary); margin-bottom: 10px;">Shared Technologies (${shared.length})</h4>
          <div style="display: flex; flex-wrap: wrap;">${renderBadges(shared, 'background:var(--color-bg-surface-alt);color:var(--color-text-secondary);border:1px solid var(--color-border-default)')}</div>
        </div>`
            : ''
        }

        ${
          onlyOrigin.length > 0
            ? `
        <div style="margin-bottom: 20px;">
          <h4 style="color: var(--color-info-text); margin-bottom: 10px;">Only in ${escapeHtml(originLabel)} (${onlyOrigin.length})</h4>
          <div style="display: flex; flex-wrap: wrap;">${renderBadges(onlyOrigin, 'background:var(--blue-100);color:var(--color-info-text);border:1px solid #93c5fd')}</div>
        </div>`
            : ''
        }

        ${
          onlyCompare.length > 0
            ? `
        <div style="margin-bottom: 20px;">
          <h4 style="color: #A47BFF; margin-bottom: 10px;">Only in ${escapeHtml(compareLabel)} (${onlyCompare.length})</h4>
          <div style="display: flex; flex-wrap: wrap;">${renderBadges(onlyCompare, 'background:var(--color-bg-surface-alt);color:#A47BFF;border:1px solid #c4b5fd')}</div>
        </div>`
            : ''
        }
      </div>
    </div>
  `;
}

export { getTechnologyStack, aggregateTechnologies };
