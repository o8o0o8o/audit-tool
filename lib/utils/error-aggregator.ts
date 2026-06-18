/**
 * Error Aggregator
 * Centralized error tracking and aggregation for SEO audit
 */

import type { SeverityLevel, AnalysisDetail } from '../types';
import { SEVERITY, CRAWL_SETTINGS } from '../constants';
import { compareExamplesWorstFirst } from '../utils';

/**
 * Findings whose SUBJECT is a page being defective / non-real — a broken
 * pagination tail or a soft 404 (HTTP 200 serving "not found" content). A
 * defective page must be KEPT in these (they are the findings telling you to
 * fix or remove the page) and removed from every on-page-quality finding
 * (canonical, alt, perf, a11y, content, …) where its presence is just
 * count-inflating noise. Hard 4xx/5xx pages are intentionally absent: the
 * crawler skips analysis for non-200 responses, so they never reach on-page
 * findings, and they legitimately belong in HTTP-error / sitemap-reconciliation
 * findings — so they are neither suppressed nor need a keep-rule here.
 */
export function isDefectivePageOwnerFinding(key: string): boolean {
  return (
    key.startsWith('Broken pagination') ||
    key.startsWith('Additional pagination series') ||
    /\bsoft 404\b/i.test(key)
  );
}

/**
 * True when an example string cites any URL in `urls`. Extracts every absolute
 * URL the example embeds (link text and/or `href="…"`) and tests exact set
 * membership, decoding `&amp;` so escaped query strings still match. Exact
 * match (not substring) so `/page/7` does not also catch `/page/70`.
 */
function exampleCitesUrl(example: string, urls: Set<string>): boolean {
  const matches = example.match(/https?:\/\/[^\s"'<>)\]]+/g);
  if (!matches) return false;
  return matches.some((u) => urls.has(u.replace(/&amp;/g, '&')));
}

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

      for (const [key, detail] of Object.entries(existingAnalysis.details ?? {}) as [string, AnalysisDetail][]) {
        restoredDetails[key] = {
          severity: detail.severity,
          count: detail.count || 0,
          examples: Array.isArray(detail.examples) ? detail.examples.slice(0, MAX_EXAMPLES) : [],
          // Restore truncated flag, or set it if examples are at limit
          truncated: detail.truncated ?? (Array.isArray(detail.examples) && detail.examples.length >= MAX_EXAMPLES),
        };
      }

      this.#analysis = {
        overall: new Set(existingAnalysis.overall ?? []),
        details: restoredDetails,
        bySeverity: existingAnalysis.bySeverity ?? {
          critical: [],
          high: [],
          medium: [],
          low: [],
        },
        summary: existingAnalysis.summary ?? {
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
    if (!generalError?.trim()) {
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

      // Only store up to MAX_EXAMPLES to save memory. Once at the cap, keep the
      // WORST examples (highest embedded metric — request count, unused-code
      // size, …) so the report's affected-pages sample leads with the most
      // severe pages instead of an arbitrary alphabetical slice. Ties (and
      // metric-less bare-URL examples) fall back to a lexicographic order, which
      // is stable regardless of the non-deterministic concurrent
      // crawl-completion order pages arrive in — so the retained sample, and
      // thus the report, is identical run to run.
      if (details.examples.length < MAX_EXAMPLES) {
        details.examples.push(detailedError);
      } else {
        details.truncated ??= true; // Mark that we've hit the limit
        // Find the least-severe example currently retained (ranks last
        // worst-first), then evict it in favour of the newcomer when the
        // newcomer is worse.
        let leastIdx = 0;
        for (let i = 1; i < details.examples.length; i++) {
          if (compareExamplesWorstFirst(details.examples[i], details.examples[leastIdx]) > 0) leastIdx = i;
        }
        if (compareExamplesWorstFirst(detailedError, details.examples[leastIdx]) < 0) {
          details.examples[leastIdx] = detailedError;
        }
      }

      // Always increment count to track total occurrences accurately
      // Note: count may exceed examples.length when truncated is true
      // Safety limit on count to prevent unbounded growth (but much higher than examples)
      if (details.count < MAX_COUNT) {
        details.count++;
      } else {
        details.countTruncated ??= true; // Mark that count also hit limit
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
   * Remove example entries citing any URL in `urls` from every finding whose
   * key does NOT satisfy `keepKey`. Used after broken-pagination detection so a
   * phantom infinite-pagination tail (pages we've already flagged for deletion)
   * stops inflating the occurrence counts of unrelated findings — adding a
   * canonical/alt/etc. to a page that should not exist is never the fix.
   *
   * Count is reduced by the number of removed examples, floored at the
   * surviving example count: a non-truncated finding lands on an exact count, a
   * truncated one is corrected by at least what we observed. A finding left with
   * no examples and a zeroed count is dropped entirely (severity tally adjusted),
   * so a finding that was ONLY these phantom pages disappears.
   *
   * @returns the number of example entries removed across all findings.
   */
  suppressExamplesByUrl(urls: Set<string>, keepKey: (key: string) => boolean = () => false): number {
    if (urls.size === 0) return 0;
    let removedTotal = 0;
    for (const [key, detail] of Object.entries(this.#analysis.details)) {
      if (keepKey(key)) continue;
      if (!Array.isArray(detail.examples) || detail.examples.length === 0) continue;
      const kept = detail.examples.filter((ex) => !exampleCitesUrl(ex, urls));
      const removed = detail.examples.length - kept.length;
      if (removed === 0) continue;
      removedTotal += removed;
      detail.examples = kept;
      detail.count = Math.max((detail.count ?? kept.length) - removed, kept.length);
      if (kept.length === 0 && detail.count === 0) this.#dropFinding(key, detail.severity);
    }
    return removedTotal;
  }

  /**
   * Remove a finding entirely and keep the severity bookkeeping consistent.
   */
  #dropFinding(key: string, severity: SeverityLevel) {
    delete this.#analysis.details[key];
    this.#analysis.overall.delete(key);
    const arr = this.#analysis.bySeverity[severity];
    if (!arr) return;
    const idx = arr.indexOf(`${key} [${severity}]`);
    if (idx === -1) return;
    arr.splice(idx, 1);
    this.#analysis.summary.totalIssues = Math.max(0, this.#analysis.summary.totalIssues - 1);
    const countKey = `${severity}Count`;
    this.#analysis.summary[countKey] = Math.max(0, (this.#analysis.summary[countKey] ?? 0) - 1);
  }

  /**
   * Get the analysis data for serialization
   * @returns {Object} Analysis data with overall converted to array
   */
  getData() {
    // Sort each finding's retained examples worst-first (highest embedded
    // metric leads) at the serialization choke point, so every consumer of
    // analysis.details — the curated report, quick-win scoring, and the legacy
    // HTML report's CSV export — emits affected pages most-severe-first instead
    // of in the non-deterministic concurrent crawl-completion order they were
    // collected in. The comparator's lexicographic tiebreak keeps it stable.
    for (const detail of Object.values(this.#analysis.details)) {
      if (Array.isArray(detail.examples)) detail.examples.sort(compareExamplesWorstFirst);
    }
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
