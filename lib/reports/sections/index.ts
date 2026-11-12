/**
 * HTML Report Sections
 * Exports all section generators for HTML reports
 */

import { getDesignTokens } from './design-tokens';
import { getUIComponents } from './ui-components';
import { getStyles } from './styles';
import { getScripts } from './scripts';
import { getExecutiveSummary } from './executive-summary';
import { getIssuesDetail } from './issues-detail';
import { getPerformanceStats } from './performance-stats';
import { getHistoricalProgress } from './historical-progress';
import { getChartsSection } from './charts-section';
import { getConfigInfo } from './config-info';
import { getPagesTable } from './pages-table';
import { getTechnologyStack } from './technology-stack';
import { getSourceCodeAnalysis } from './source-code-analysis';
import { getContentInsights } from './content-insights';
import { getUiIssues } from './ui-issues';

export {
  getDesignTokens,
  getUIComponents,
  getStyles,
  getScripts,
  getExecutiveSummary,
  getIssuesDetail,
  getUiIssues,
  getPerformanceStats,
  getHistoricalProgress,
  getChartsSection,
  getConfigInfo,
  getPagesTable,
  getTechnologyStack,
  getSourceCodeAnalysis,
  getContentInsights,
};
