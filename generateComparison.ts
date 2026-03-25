import * as fs from 'fs';
import { HistoryManager } from './historyManager';
import { escapeHtml } from './lib/reports/html-utils';
import { getDesignTokens } from './lib/reports/sections/design-tokens';
import { getUIComponents } from './lib/reports/sections/ui-components';
import type { InsightsSummary } from './lib/types';

/**
 * Generate HTML comparison report between two audits
 */

function generateComparisonHTML(domainName: string, oldIndex: number, newIndex: number) {
  const manager = new HistoryManager(domainName);
  const oldAudit = manager.getAuditByIndex(oldIndex);
  const newAudit = manager.getAuditByIndex(newIndex);

  if (!oldAudit || !newAudit) {
    console.error('Error: Invalid audit indices');
    process.exit(1);
  }

  const comparison = manager.compareAudits(oldAudit, newAudit);

  const deltaClass = (value: number) => {
    if (value > 0) return 'positive';
    if (value < 0) return 'negative';
    return 'neutral';
  };

  const deltaSymbol = (value: number) => (value > 0 ? '+' : '');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Audit Comparison - ${escapeHtml(domainName)}</title>
    <style>
        ${getDesignTokens()}
        ${getUIComponents()}
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: var(--gradient-executive);
            padding: 40px 20px;
            min-height: 100vh;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        .header {
            background: white;
            padding: 30px;
            border-radius: var(--radius-xl);
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .header h1 {
            color: var(--gray-800);
            margin-bottom: 10px;
        }

        .date-range {
            color: var(--color-text-muted);
            font-size: 18px;
        }

        .section {
            background: white;
            padding: 30px;
            border-radius: var(--radius-xl);
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .section h2 {
            color: var(--gray-800);
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid var(--color-border-default);
        }

        .comparison-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .metric-card {
            background: var(--color-bg-page);
            padding: 20px;
            border-radius: var(--radius-lg);
            border-left: 4px solid var(--color-info);
        }

        .metric-label {
            font-size: var(--font-size-base);
            color: var(--color-text-muted);
            margin-bottom: 8px;
        }

        .metric-comparison {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 24px;
            font-weight: 600;
        }

        .old-value {
            color: var(--color-text-disabled);
        }

        .arrow {
            font-size: 20px;
            color: var(--color-text-muted);
        }

        .new-value {
            color: var(--gray-800);
        }

        .delta {
            font-size: 16px;
            padding: 4px 8px;
            border-radius: var(--radius-sm);
            font-weight: 500;
        }

        .delta.positive {
            background: var(--color-success-bg);
            color: var(--color-success-text);
        }

        .delta.negative {
            background: var(--color-error-bg);
            color: var(--color-error-text);
        }

        .delta.neutral {
            background: var(--color-border-default);
            color: var(--gray-600);
        }

        .score-visual {
            display: flex;
            gap: 20px;
            align-items: center;
            margin: 20px 0;
        }

        .score-circle {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: 700;
            color: white;
        }

        .score-circle.old {
            background: linear-gradient(135deg, var(--gray-400) 0%, var(--gray-500) 100%);
        }

        .score-circle.new {
            background: linear-gradient(135deg, var(--blue-500) 0%, var(--blue-600) 100%);
        }

        .score-label {
            font-size: var(--font-size-xs);
            margin-top: 5px;
            opacity: 0.9;
        }

        .changes-list {
            list-style: none;
            margin-top: 15px;
        }

        .changes-list li {
            padding: 12px;
            margin: 8px 0;
            border-radius: var(--radius-md);
            font-size: var(--font-size-base);
        }

        .changes-list li.improvement {
            background: var(--color-success-bg);
            color: var(--color-success-text);
            border-left: 4px solid var(--color-success);
        }

        .changes-list li.regression {
            background: var(--color-error-bg);
            color: var(--color-error-text);
            border-left: 4px solid var(--color-error);
        }

        .category-comparison {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }

        .category-card {
            background: var(--color-bg-page);
            padding: 15px;
            border-radius: var(--radius-md);
            text-align: center;
        }

        .category-name {
            font-size: var(--font-size-xs);
            color: var(--color-text-muted);
            margin-bottom: 8px;
            text-transform: uppercase;
            font-weight: 600;
        }

        .summary-banner {
            padding: 20px;
            border-radius: var(--radius-lg);
            margin-bottom: 20px;
            text-align: center;
            font-size: 18px;
            font-weight: 600;
        }

        .summary-banner.improved {
            background: var(--gradient-success);
            color: white;
        }

        .summary-banner.declined {
            background: var(--gradient-danger);
            color: white;
        }

        .summary-banner.unchanged {
            background: linear-gradient(135deg, var(--gray-500) 0%, var(--gray-600) 100%);
            color: white;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Audit Comparison Report</h1>
            <div class="date-range">${escapeHtml(domainName)}</div>
            <div class="date-range">${comparison.oldDate} → ${comparison.newDate}</div>
        </div>

        ${(() => {
          const scoreDelta = comparison.scoreChange;
          let bannerClass = 'unchanged';
          let bannerText = 'No significant change in overall score';

          if (scoreDelta > 5) {
            bannerClass = 'improved';
            bannerText = `🎉 Overall score improved by ${scoreDelta} points!`;
          } else if (scoreDelta < -5) {
            bannerClass = 'declined';
            bannerText = `⚠️ Overall score declined by ${Math.abs(scoreDelta)} points`;
          }

          return `<div class="summary-banner ${bannerClass}">${bannerText}</div>`;
        })()}

        <div class="section">
            <h2>Overall Score Comparison</h2>
            <div class="score-visual">
                <div class="score-circle old">
                    ${oldAudit.summary.overallScore}
                    <div class="score-label">Before</div>
                </div>
                <div class="arrow">→</div>
                <div class="score-circle new">
                    ${newAudit.summary.overallScore}
                    <div class="score-label">After</div>
                </div>
                <div class="delta ${deltaClass(comparison.scoreChange)}" style="font-size: 28px; padding: 12px 20px;">
                    ${deltaSymbol(comparison.scoreChange)}${comparison.scoreChange}
                </div>
            </div>
        </div>

        <div class="section">
            <h2>Key Metrics</h2>
            <div class="comparison-grid">
                <div class="metric-card">
                    <div class="metric-label">Total Issues</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.summary.totalIssues}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.summary.totalIssues}</span>
                        <span class="delta ${deltaClass(-comparison.deltaMetrics.totalIssues)}">
                            ${deltaSymbol(comparison.deltaMetrics.totalIssues)}${comparison.deltaMetrics.totalIssues}
                        </span>
                    </div>
                </div>

                <div class="metric-card">
                    <div class="metric-label">Critical Issues</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.summary.criticalCount}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.summary.criticalCount}</span>
                        <span class="delta ${deltaClass(-comparison.deltaMetrics.critical)}">
                            ${deltaSymbol(comparison.deltaMetrics.critical)}${comparison.deltaMetrics.critical}
                        </span>
                    </div>
                </div>

                <div class="metric-card">
                    <div class="metric-label">High Priority Issues</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.summary.highCount}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.summary.highCount}</span>
                        <span class="delta ${deltaClass(-comparison.deltaMetrics.high)}">
                            ${deltaSymbol(comparison.deltaMetrics.high)}${comparison.deltaMetrics.high}
                        </span>
                    </div>
                </div>

                <div class="metric-card">
                    <div class="metric-label">Pass Rate</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.summary.passRate}%</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.summary.passRate}%</span>
                        <span class="delta ${deltaClass(comparison.deltaMetrics.passRate)}">
                            ${deltaSymbol(comparison.deltaMetrics.passRate)}${comparison.deltaMetrics.passRate}%
                        </span>
                    </div>
                </div>
            </div>
        </div>

        ${
          comparison.categoryDeltas
            ? `
        <div class="section">
            <h2>Category Scores</h2>
            <div class="category-comparison">
                ${Object.entries(comparison.categoryDeltas)
                  .map(([cat, delta]: [string, number]) => {
                    const oldScore = (oldAudit.summary.categoryScores as Record<string, number>)[cat] || 0;
                    const newScore = (newAudit.summary.categoryScores as Record<string, number>)[cat] || 0;
                    return `
                        <div class="category-card">
                            <div class="category-name">${cat}</div>
                            <div class="metric-comparison" style="font-size: 18px;">
                                <span class="old-value">${oldScore}</span>
                                <span class="arrow">→</span>
                                <span class="new-value">${newScore}</span>
                            </div>
                            <div class="delta ${deltaClass(delta)}" style="margin-top: 8px;">
                                ${deltaSymbol(delta)}${delta}
                            </div>
                        </div>
                    `;
                  })
                  .join('')}
            </div>
        </div>
        `
            : ''
        }

        ${
          comparison.improvements.length > 0
            ? `
        <div class="section">
            <h2>✅ Improvements (${comparison.improvements.length})</h2>
            <ul class="changes-list">
                ${comparison.improvements.map((imp: string) => `<li class="improvement">${escapeHtml(imp)}</li>`).join('')}
            </ul>
        </div>
        `
            : ''
        }

        ${
          comparison.regressions.length > 0
            ? `
        <div class="section">
            <h2>⚠️ Regressions (${comparison.regressions.length})</h2>
            <ul class="changes-list">
                ${comparison.regressions.map((reg: string) => `<li class="regression">${escapeHtml(reg)}</li>`).join('')}
            </ul>
        </div>
        `
            : ''
        }

        ${(() => {
          const oldIns = oldAudit.insights;
          const newIns = newAudit.insights;
          if (!oldIns && !newIns) return '';
          const oi: Partial<InsightsSummary> = oldIns ?? {};
          const ni: Partial<InsightsSummary> = newIns ?? {};
          const insightMetrics = [
            {
              label: 'Language Mismatches',
              old: oi.languageMismatches ?? '-',
              new: ni.languageMismatches ?? '-',
              inverse: true,
            },
            {
              label: 'Broken Outbound Links',
              old: oi.brokenOutboundLinks ?? '-',
              new: ni.brokenOutboundLinks ?? '-',
              inverse: true,
            },
            {
              label: 'Near-Duplicate Pages',
              old: oi.nearDuplicatePages ?? '-',
              new: ni.nearDuplicatePages ?? '-',
              inverse: true,
            },
            {
              label: 'Pages Without CTAs',
              old: oi.pagesWithoutCTAs ?? '-',
              new: ni.pagesWithoutCTAs ?? '-',
              inverse: true,
            },
            { label: 'Avg Unused JS %', old: oi.avgJsUnused ?? '-', new: ni.avgJsUnused ?? '-', inverse: true },
            { label: 'Avg Unused CSS %', old: oi.avgCssUnused ?? '-', new: ni.avgCssUnused ?? '-', inverse: true },
          ].filter((m) => m.old !== '-' || m.new !== '-');
          if (insightMetrics.length === 0) return '';
          return `
        <div class="section">
            <h2>Content & Code Insights</h2>
            <div class="comparison-grid">
                ${insightMetrics
                  .map((m) => {
                    const oldVal = typeof m.old === 'number' ? m.old : 0;
                    const newVal = typeof m.new === 'number' ? m.new : 0;
                    const diff = newVal - oldVal;
                    const cls = m.inverse ? deltaClass(-diff) : deltaClass(diff);
                    return `
                <div class="metric-card">
                    <div class="metric-label">${m.label}</div>
                    <div class="metric-comparison">
                        <span class="old-value">${m.old}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${m.new}</span>
                        <span class="delta ${cls}">${deltaSymbol(diff)}${diff}</span>
                    </div>
                </div>`;
                  })
                  .join('')}
            </div>
        </div>`;
        })()}

        ${
          comparison.performanceDeltas && oldAudit.performance && newAudit.performance
            ? `
        <div class="section">
            <h2>Performance Metrics Change</h2>
            <div class="comparison-grid">
                <div class="metric-card">
                    <div class="metric-label">Average TTFB</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.avgTTFB}ms</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.avgTTFB}ms</span>
                        <span class="delta ${deltaClass(-comparison.performanceDeltas.ttfb)}">
                            ${deltaSymbol(comparison.performanceDeltas.ttfb)}${comparison.performanceDeltas.ttfb.toFixed(0)}ms
                        </span>
                    </div>
                </div>

                <div class="metric-card">
                    <div class="metric-label">Average LCP</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.avgLCP}ms</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.avgLCP}ms</span>
                        <span class="delta ${deltaClass(-comparison.performanceDeltas.lcp)}">
                            ${deltaSymbol(comparison.performanceDeltas.lcp)}${comparison.performanceDeltas.lcp.toFixed(0)}ms
                        </span>
                    </div>
                </div>

                <div class="metric-card">
                    <div class="metric-label">Average CLS</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.avgCLS}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.avgCLS}</span>
                        <span class="delta ${deltaClass(-comparison.performanceDeltas.cls)}">
                            ${deltaSymbol(comparison.performanceDeltas.cls)}${comparison.performanceDeltas.cls.toFixed(3)}
                        </span>
                    </div>
                </div>
            </div>

            ${
              oldAudit.performance.p75TTFB && newAudit.performance.p75TTFB
                ? `
            <h3 style="margin-top: 25px; color: var(--color-text-secondary);">P75 Percentiles (Core Web Vitals standard)</h3>
            <div class="comparison-grid">
                <div class="metric-card" style="border-left-color: var(--purple-500);">
                    <div class="metric-label">P75 TTFB</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.p75TTFB}ms</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.p75TTFB}ms</span>
                        <span class="delta ${deltaClass(-(parseFloat(newAudit.performance.p75TTFB) - parseFloat(oldAudit.performance.p75TTFB)))}">
                            ${deltaSymbol(parseFloat(newAudit.performance.p75TTFB) - parseFloat(oldAudit.performance.p75TTFB))}${(parseFloat(newAudit.performance.p75TTFB) - parseFloat(oldAudit.performance.p75TTFB)).toFixed(0)}ms
                        </span>
                    </div>
                </div>
                <div class="metric-card" style="border-left-color: var(--pink-500);">
                    <div class="metric-label">P75 LCP</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.p75LCP}ms</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.p75LCP}ms</span>
                        <span class="delta ${deltaClass(-(parseFloat(newAudit.performance.p75LCP) - parseFloat(oldAudit.performance.p75LCP)))}">
                            ${deltaSymbol(parseFloat(newAudit.performance.p75LCP) - parseFloat(oldAudit.performance.p75LCP))}${(parseFloat(newAudit.performance.p75LCP) - parseFloat(oldAudit.performance.p75LCP)).toFixed(0)}ms
                        </span>
                    </div>
                </div>
                <div class="metric-card" style="border-left-color: #14b8a6;">
                    <div class="metric-label">P75 CLS</div>
                    <div class="metric-comparison">
                        <span class="old-value">${oldAudit.performance.p75CLS}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">${newAudit.performance.p75CLS}</span>
                        <span class="delta ${deltaClass(-(parseFloat(newAudit.performance.p75CLS) - parseFloat(oldAudit.performance.p75CLS)))}">
                            ${deltaSymbol(parseFloat(newAudit.performance.p75CLS) - parseFloat(oldAudit.performance.p75CLS))}${(parseFloat(newAudit.performance.p75CLS) - parseFloat(oldAudit.performance.p75CLS)).toFixed(3)}
                        </span>
                    </div>
                </div>
            </div>
            `
                : ''
            }
        </div>
        `
            : ''
        }

        ${
          comparison.fixed && comparison.fixed.length > 0
            ? `
        <div class="section">
            <h2>🔧 Fixed Issues (${comparison.fixed.length})</h2>
            <p style="color: var(--color-text-muted); margin-bottom: 15px;">Issues present in the old audit but resolved in the new one.</p>
            <ul class="changes-list">
                ${comparison.fixed.map((issue: string) => `<li class="improvement">✓ ${escapeHtml(issue)}</li>`).join('')}
            </ul>
        </div>
        `
            : ''
        }

        ${
          comparison.newIssues && comparison.newIssues.length > 0
            ? `
        <div class="section">
            <h2>🆕 New Issues (${comparison.newIssues.length})</h2>
            <p style="color: var(--color-text-muted); margin-bottom: 15px;">Issues not present in the old audit that appeared in the new one.</p>
            <ul class="changes-list">
                ${comparison.newIssues.map((issue: string) => `<li class="regression">✗ ${escapeHtml(issue)}</li>`).join('')}
            </ul>
        </div>
        `
            : ''
        }
    </div>
</body>
</html>
  `;

  const outputFile = `${domainName}_comparison_${oldIndex + 1}_vs_${newIndex + 1}.html`;
  fs.writeFileSync(outputFile, htmlContent);

  console.log(`\n✅ Comparison report generated: ${outputFile}`);
  return outputFile;
}

export { generateComparisonHTML };
// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.log(`
Usage: node generateComparison.js <domain> <old-index> <new-index>

Example: node generateComparison.js example.com 1 2
    `);
    process.exit(1);
  }

  const [domainName, oldIndex, newIndex] = args;
  generateComparisonHTML(domainName, parseInt(oldIndex, 10) - 1, parseInt(newIndex, 10) - 1);
}
