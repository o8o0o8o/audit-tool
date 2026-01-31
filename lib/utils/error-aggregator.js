/**
 * Error Aggregator
 * Centralized error tracking and aggregation for SEO audit
 */

const { SEVERITY } = require('../constants');

class ErrorAggregator {
  #analysis;

  /**
   * Create a new ErrorAggregator
   * @param {Object} existingAnalysis - Optional existing analysis data (for resume)
   */
  constructor(existingAnalysis = null) {
    if (existingAnalysis) {
      // Resume from existing data
      this.#analysis = {
        overall: new Set(existingAnalysis.overall || []),
        details: existingAnalysis.details || {},
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
  addError(generalError, detailedError, severity = SEVERITY.MEDIUM) {
    // Add to overall set
    this.#analysis.overall.add(generalError);

    // Add details with severity
    // Limit examples to 100 per issue to prevent memory explosion on large sites
    const MAX_EXAMPLES_PER_ISSUE = 100;

    if (detailedError) {
      if (!this.#analysis.details[generalError]) {
        this.#analysis.details[generalError] = {
          severity: severity,
          count: 0,
          examples: [],
        };
      }

      // Only store up to MAX_EXAMPLES to save memory
      if (this.#analysis.details[generalError].examples.length < MAX_EXAMPLES_PER_ISSUE) {
        this.#analysis.details[generalError].examples.push(detailedError);
      }
      this.#analysis.details[generalError].count++;
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
  getIssuesBySeverity(severity) {
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

module.exports = { ErrorAggregator };
