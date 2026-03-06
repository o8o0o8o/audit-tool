/**
 * HTML Report Sections
 * Exports all section generators for HTML reports
 */

const { getStyles } = require('./styles');
const { getScripts } = require('./scripts');
const { getExecutiveSummary } = require('./executive-summary');
const { getQuickWins } = require('./quick-wins');
const { getTopIssues } = require('./top-issues');
const { getPerformanceStats } = require('./performance-stats');
const { getHistoricalProgress } = require('./historical-progress');
const { getChartsSection } = require('./charts-section');
const { getConfigInfo } = require('./config-info');
const { getPagesTable } = require('./pages-table');
const { getTechnologyStack } = require('./technology-stack');
const { getSourceCodeAnalysis } = require('./source-code-analysis');

module.exports = {
  getStyles,
  getScripts,
  getExecutiveSummary,
  getQuickWins,
  getTopIssues,
  getPerformanceStats,
  getHistoricalProgress,
  getChartsSection,
  getConfigInfo,
  getPagesTable,
  getTechnologyStack,
  getSourceCodeAnalysis,
};
