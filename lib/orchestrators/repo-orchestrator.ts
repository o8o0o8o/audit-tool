/**
 * Repo Analysis Orchestrator
 * Coordinates all repository-level analyzers for source code analysis
 */

import { RepoFrameworkDetector } from '../analyzers/repo/framework-detector';
import { FrameworkConfigValidator } from '../analyzers/repo/framework-config-validator';
import { RouteExtractor } from '../analyzers/repo/route-extractor';
import { RouteSitemapComparator } from '../analyzers/repo/route-sitemap-comparator';
import { SourceMapper } from '../analyzers/repo/source-mapper';
import { PackageAnalyzer } from '../analyzers/repo/package-analyzer';
import { SourcePatternAnalyzer } from '../analyzers/repo/source-pattern-analyzer';
import type { Issue, SitemapUrl } from '../types';

interface FrameworkInfo {
  framework: string | null;
  version: string | null;
  packageJson: Record<string, unknown>;
  srcDirs: string[];
  configFile: string | null;
  router: string | null;
}

interface AuditDataForRepo {
  sitemaps?: { urls?: Record<string, SitemapUrl> };
  origin?: string;
  analysis?: { details?: Record<string, unknown> };
}

interface RepoAnalysisResult {
  framework: string | null;
  version: string | null;
  router: string | null;
  configFile: string | null;
  configIssues: Issue[];
  configWarnings: Issue[];
  routeCoverage: Record<string, unknown> | null;
  sourceMapping: Record<string, unknown>;
  issues: Issue[];
  warnings: Issue[];
  routeDetails?: unknown;
}

class RepoOrchestrator {
  /**
   * Run all repo analysis
   * @param {string} repoPath - Absolute path to the repository
   * @param {object} auditData - The audit results object (seo.data / #results)
   * @returns {object} repoAnalysis result
   */
  static analyze(repoPath: string, auditData: AuditDataForRepo | null): RepoAnalysisResult {
    const result: RepoAnalysisResult = {
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
    let frameworkInfo: FrameworkInfo;
    try {
      frameworkInfo = RepoFrameworkDetector.detect(repoPath) as FrameworkInfo;
      result.framework = frameworkInfo.framework;
      result.version = frameworkInfo.version;
      result.router = frameworkInfo.router;
      result.configFile = frameworkInfo.configFile;
    } catch (err: unknown) {
      console.error('Repo analysis: framework detection failed:', (err as Error).message);
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

    console.log(`Detected framework: ${frameworkInfo.framework} ${frameworkInfo.version ?? ''}`);

    // 2. Validate framework config
    try {
      const configResult = FrameworkConfigValidator.validate(repoPath, frameworkInfo);
      result.configIssues = (configResult.issues || []) as Issue[];
      result.configWarnings = (configResult.warnings || []) as Issue[];
      result.issues.push(...result.configIssues);
      result.warnings.push(...result.configWarnings);
    } catch (err: unknown) {
      console.error('Repo analysis: config validation failed:', (err as Error).message);
    }

    // 2a. Package.json hygiene checks
    try {
      const pkg = PackageAnalyzer.analyze(frameworkInfo.packageJson);
      result.issues.push(...pkg.issues);
      result.warnings.push(...pkg.warnings);
    } catch (err: unknown) {
      console.error('Repo analysis: package analyzer failed:', (err as Error).message);
    }

    // 2b. Source-code anti-patterns (framework-specific)
    try {
      const src = SourcePatternAnalyzer.analyze(repoPath, {
        framework: frameworkInfo.framework,
        srcDirs: frameworkInfo.srcDirs,
      });
      result.issues.push(...src.issues);
      result.warnings.push(...src.warnings);
    } catch (err: unknown) {
      console.error('Repo analysis: source pattern analyzer failed:', (err as Error).message);
    }

    // 3. Extract routes
    let routes: ReturnType<typeof RouteExtractor.extract> = [];
    try {
      routes = RouteExtractor.extract(repoPath, frameworkInfo);
      if (routes.length > 0) {
        console.log(`Extracted ${routes.length} route(s) from source code`);
      }
    } catch (err: unknown) {
      console.error('Repo analysis: route extraction failed:', (err as Error).message);
    }

    // 4. Compare routes to sitemap
    if (routes.length > 0 && auditData) {
      try {
        const sitemapUrls = auditData.sitemaps?.urls ?? {};
        const origin = auditData.origin ?? '';
        const comparison = RouteSitemapComparator.compare(routes, sitemapUrls as Record<string, unknown>, origin);
        result.routeCoverage = comparison.stats;
        result.issues.push(...comparison.issues);
        result.warnings.push(...comparison.warnings);
        result.routeDetails = comparison.details;
      } catch (err: unknown) {
        console.error('Repo analysis: route-sitemap comparison failed:', (err as Error).message);
      }
    }

    // 5. Map audit issues to source files
    if (auditData?.analysis?.details) {
      try {
        result.sourceMapping = SourceMapper.map(
          auditData.analysis.details as Record<string, unknown>,
          repoPath,
          frameworkInfo,
        );
        const mappedCount = Object.keys(result.sourceMapping).length;
        if (mappedCount > 0) {
          console.log(`Mapped ${mappedCount} issue type(s) to source locations`);
        }
      } catch (err: unknown) {
        console.error('Repo analysis: source mapping failed:', (err as Error).message);
      }
    }

    return result;
  }
}

export { RepoOrchestrator };
