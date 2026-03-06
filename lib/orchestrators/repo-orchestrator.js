/**
 * Repo Analysis Orchestrator
 * Coordinates all repository-level analyzers for source code analysis
 */

const { RepoFrameworkDetector } = require('../analyzers/repo/framework-detector');
const { FrameworkConfigValidator } = require('../analyzers/repo/framework-config-validator');
const { RouteExtractor } = require('../analyzers/repo/route-extractor');
const { RouteSitemapComparator } = require('../analyzers/repo/route-sitemap-comparator');
const { SourceMapper } = require('../analyzers/repo/source-mapper');

class RepoOrchestrator {
  /**
   * Run all repo analysis
   * @param {string} repoPath - Absolute path to the repository
   * @param {object} auditData - The audit results object (seo.data / #results)
   * @returns {object} repoAnalysis result
   */
  static analyze(repoPath, auditData) {
    const result = {
      framework: null,
      version: null,
      router: null,
      configFile: null,
      configIssues: [],
      configWarnings: [],
      routeCoverage: null,
      sourceMapping: {},
      issues: [],
      warnings: [],
    };

    // 1. Detect framework
    let frameworkInfo;
    try {
      frameworkInfo = RepoFrameworkDetector.detect(repoPath);
      result.framework = frameworkInfo.framework;
      result.version = frameworkInfo.version;
      result.router = frameworkInfo.router;
      result.configFile = frameworkInfo.configFile;
    } catch (err) {
      console.error('Repo analysis: framework detection failed:', err.message);
      return result;
    }

    if (!frameworkInfo.framework) {
      result.warnings.push({
        message: 'Could not detect web framework',
        detail: 'No recognized framework found in package.json. Source code analysis is limited.',
        severity: 'low',
      });
      return result;
    }

    console.log(`Detected framework: ${frameworkInfo.framework} ${frameworkInfo.version || ''}`);

    // 2. Validate framework config
    try {
      const configResult = FrameworkConfigValidator.validate(repoPath, frameworkInfo);
      result.configIssues = configResult.issues || [];
      result.configWarnings = configResult.warnings || [];
      result.issues.push(...result.configIssues);
      result.warnings.push(...result.configWarnings);
    } catch (err) {
      console.error('Repo analysis: config validation failed:', err.message);
    }

    // 3. Extract routes
    let routes = [];
    try {
      routes = RouteExtractor.extract(repoPath, frameworkInfo);
      if (routes.length > 0) {
        console.log(`Extracted ${routes.length} route(s) from source code`);
      }
    } catch (err) {
      console.error('Repo analysis: route extraction failed:', err.message);
    }

    // 4. Compare routes to sitemap
    if (routes.length > 0 && auditData) {
      try {
        const sitemapUrls = auditData.sitemaps?.urls || {};
        const origin = auditData.origin || '';
        const comparison = RouteSitemapComparator.compare(routes, sitemapUrls, origin);
        result.routeCoverage = comparison.stats;
        result.issues.push(...comparison.issues);
        result.warnings.push(...comparison.warnings);
        result.routeDetails = comparison.details;
      } catch (err) {
        console.error('Repo analysis: route-sitemap comparison failed:', err.message);
      }
    }

    // 5. Map audit issues to source files
    if (auditData?.analysis?.details) {
      try {
        result.sourceMapping = SourceMapper.map(
          auditData.analysis.details,
          repoPath,
          frameworkInfo
        );
        const mappedCount = Object.keys(result.sourceMapping).length;
        if (mappedCount > 0) {
          console.log(`Mapped ${mappedCount} issue type(s) to source locations`);
        }
      } catch (err) {
        console.error('Repo analysis: source mapping failed:', err.message);
      }
    }

    return result;
  }
}

module.exports = { RepoOrchestrator };
