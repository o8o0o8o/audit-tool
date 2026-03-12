/**
 * Error Aggregator
 * Centralized error tracking and aggregation for SEO audit
 */

import type { SeverityLevel, AnalysisDetail } from '../types';
import { SEVERITY, CRAWL_SETTINGS } from '../constants';

export interface AnalysisState {
  overall: Set<string>;
  details: Record<string, AnalysisDetail>;
  bySeverity: Record<string, string[]>;
  summary: {
    totalIssues: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    [key: string]: number;
  };
}

interface SerializedAnalysis {
  overall?: string[];
  details?: Record<string, AnalysisDetail>;
  bySeverity?: Record<string, string[]>;
  summary?: AnalysisState['summary'];
}

class ErrorAggregator {
  #analysis: AnalysisState;

  /**
   * Create a new ErrorAggregator
   * @param existingAnalysis - Optional existing analysis data (for resume)
   */
  constructor(existingAnalysis: SerializedAnalysis | null = null) {
    if (existingAnalysis) {
      // Resume from existing data
      // Restore details with proper truncation state
      const restoredDetails: Record<string, AnalysisDetail> = {};
      const MAX_EXAMPLES = CRAWL_SETTINGS.MAX_EXAMPLES_PER_ISSUE;

      for (const [key, detail] of Object.entries(existingAnalysis.details || {}) as [string, AnalysisDetail][]) {
        restoredDetails[key] = {
          severity: detail.severity,
          count: detail.count || 0,
          examples: Array.isArray(detail.examples) ? detail.examples.slice(0, MAX_EXAMPLES) : [],
          // Restore truncated flag, or set it if examples are at limit
          truncated: detail.truncated || (Array.isArray(detail.examples) && detail.examples.length >= MAX_EXAMPLES),
        };
      }

      this.#analysis = {
        overall: new Set(existingAnalysis.overall || []),
        details: restoredDetails,
        bySeverity: existingAnalysis.bySeverity || {
          critical: [],
          high: [],
          medium: [],
          low: [],
        },
        summary: existingAnalysis.summary || {
          totalIssues: 0,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
        },
      };
    } else {
      // Fresh start
      this.#analysis = {
        overall: new Set(),
        details: {},
        bySeverity: {
          critical: [],
          high: [],
          medium: [],
          low: [],
        },
        summary: {
          totalIssues: 0,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
        },
      };
    }
  }

  /**
   * Add an error to the aggregator
   * @param {string} generalError - General error message (category)
   * @param {string|null} detailedError - Specific error details
   * @param {string} severity - Error severity (critical, high, medium, low)
   */
  addError(generalError: string, detailedError: string | null, severity: SeverityLevel | string = SEVERITY.MEDIUM) {
    // Skip empty general errors
    if (!generalError || !generalError.trim()) {
      return;
    }

    // Add to overall set
    this.#analysis.overall.add(generalError);

    // Add details with severity
    // Use constants for limits to prevent memory explosion on large sites
    const MAX_EXAMPLES = CRAWL_SETTINGS.MAX_EXAMPLES_PER_ISSUE;
    const MAX_COUNT = CRAWL_SETTINGS.MAX_TOTAL_ISSUE_COUNT;

    if (detailedError) {
      if (!this.#analysis.details[generalError]) {
        this.#analysis.details[generalError] = {
          severity: severity as SeverityLevel,
          count: 0,
          examples: [],
          truncated: false, // Track if examples were truncated
        };
      }

      const details = this.#analysis.details[generalError];

      // Only store up to MAX_EXAMPLES to save memory
      if (details.examples.length < MAX_EXAMPLES) {
        details.examples.push(detailedError);
      } else if (!details.truncated) {
        details.truncated = true; // Mark that we've hit the limit
      }

      // Always increment count to track total occurrences accurately
      // Note: count may exceed examples.length when truncated is true
      // Safety limit on count to prevent unbounded growth (but much higher than examples)
      if (details.count < MAX_COUNT) {
        details.count++;
      } else if (!details.countTruncated) {
        details.countTruncated = true; // Mark that count also hit limit
      }
    }

    // Ensure the specific severity level array exists
    if (!this.#analysis.bySeverity[severity]) {
      this.#analysis.bySeverity[severity] = [];
    }

    // Track by severity (unique issues only)
    const issueKey = `${generalError} [${severity}]`;
    if (!this.#analysis.bySeverity[severity].includes(issueKey)) {
      this.#analysis.bySeverity[severity].push(issueKey);

      // Update summary counts
      this.#analysis.summary.totalIssues++;
      this.#analysis.summary[`${severity}Count`]++;
    }
  }

  /**
   * Get the analysis data for serialization
   * @returns {Object} Analysis data with overall converted to array
   */
  getData() {
    return {
      overall: Array.from(this.#analysis.overall),
      details: this.#analysis.details,
      bySeverity: this.#analysis.bySeverity,
      summary: this.#analysis.summary,
    };
  }

  /**
   * Get raw analysis object (for direct access)
   * @returns {Object} Raw analysis object with Set
   */
  getRawData() {
    return this.#analysis;
  }

  /**
   * Get summary statistics
   * @returns {Object} Summary with issue counts by severity
   */
  getSummary() {
    return { ...this.#analysis.summary };
  }

  /**
   * Get all issues of a specific severity
   * @param {string} severity - Severity level
   * @returns {Array} List of issues
   */
  getIssuesBySeverity(severity: string) {
    return this.#analysis.bySeverity[severity] || [];
  }

  /**
   * Get the total number of unique issues
   * @returns {number} Total unique issues
   */
  getTotalIssues() {
    return this.#analysis.summary.totalIssues;
  }

  /**
   * Check if there are any critical issues
   * @returns {boolean} True if critical issues exist
   */
  hasCriticalIssues() {
    return this.#analysis.summary.criticalCount > 0;
  }
}

export { ErrorAggregator };
