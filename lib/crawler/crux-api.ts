/**
 * Chrome UX Report (CrUX) API Integration
 * Fetches real-user field data for comparison with lab metrics
 */

import * as https from 'https';
import type { IncomingMessage } from 'http';

// ─── CrUX-specific interfaces ───────────────────────────────────────────────

interface CrUXHistogramBucket {
  start: number;
  end?: number;
  density: number;
}

interface CrUXDistribution {
  good: number;
  needsImprovement: number;
  poor: number;
}

interface CrUXMetricData {
  percentiles: { p75?: number };
  histogram: CrUXHistogramBucket[];
  distribution?: CrUXDistribution;
}

interface CrUXFieldData {
  target: string;
  targetType: string;
  collectionPeriod: unknown;
  metrics: Record<string, CrUXMetricData>;
}

interface CrUXComparisonMetric {
  lab: number;
  fieldP75: number;
  difference: number;
  percentDiff: number;
  labVsField: 'worse' | 'better' | 'same';
  distribution?: CrUXDistribution;
}

interface CrUXComparison {
  available: boolean;
  metrics?: Record<string, CrUXComparisonMetric>;
}

interface CrUXInsight {
  metric: string;
  type: 'warning' | 'info' | 'critical';
  message: string;
}

interface CrUXCoreWebVitalEntry {
  p75: string;
  passing: boolean;
  distribution?: CrUXDistribution;
}

interface CrUXFieldSummary {
  target: string;
  targetType: string;
  collectionPeriod: unknown;
  coreWebVitals: Record<string, CrUXCoreWebVitalEntry>;
  passingCWV: boolean;
}

interface LabMetrics {
  TTFB?: number;
  FCP?: number;
  LCP?: number;
  CLS?: number;
  INP?: number;
  [key: string]: number | undefined;
}

// Raw CrUX API response shapes (loosely typed since they come from external API)
interface CrUXRawMetric {
  percentiles?: { p75?: number | string };
  histogram?: CrUXHistogramBucket[];
}

interface CrUXRawResponse {
  record?: {
    metrics?: Record<string, CrUXRawMetric>;
    collectionPeriod?: unknown;
  };
}

interface PSIRawMetric {
  percentile?: number;
  distributions?: Array<{ proportion?: number }>;
}

interface PSIRawResponse {
  originLoadingExperience?: {
    metrics?: Record<string, PSIRawMetric>;
  };
  loadingExperience?: {
    metrics?: Record<string, PSIRawMetric>;
  };
}

class CrUXAPI {
  static #API_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
  static #PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

  /**
   * Fetch CrUX data for a URL or origin
   * @param {string} urlOrOrigin - URL or origin to query
   * @param {string} apiKey - Google API key (optional, falls back to PSI API)
   * @param {string} formFactor - 'PHONE', 'DESKTOP', or 'ALL_FORM_FACTORS'
   * @returns {Promise<object|null>} CrUX data or null if not available
   */
  static async fetchCrUXData(
    urlOrOrigin: string,
    apiKey: string | null = null,
    formFactor: string = 'ALL_FORM_FACTORS',
  ): Promise<CrUXFieldData | null> {
    // Both CrUX and PSI APIs require an API key
    const key = apiKey ?? process.env.CRUX_API_KEY ?? null;

    if (key) {
      // Try CrUX API first (more detailed)
      let data = await this.#queryCrUX(urlOrOrigin, 'url', key, formFactor);
      if (!data) {
        try {
          const origin = new URL(urlOrOrigin).origin;
          data = await this.#queryCrUX(origin, 'origin', key, formFactor);
        } catch {
          // Invalid URL
        }
      }
      if (data) return data;

      // Fallback: try PSI API (includes CrUX data)
      return this.#fetchViaPSI(urlOrOrigin, key);
    }

    return null;
  }

  /**
   * Fetch CrUX data for a specific URL only (no origin fallback).
   * Used for per-page field data in perf mode.
   * Returns null quickly if no URL-level data exists.
   */
  static async fetchCrUXForUrl(
    url: string,
    apiKey: string | null = null,
    formFactor: string = 'ALL_FORM_FACTORS',
  ): Promise<CrUXFieldData | null> {
    const key = apiKey ?? process.env.CRUX_API_KEY ?? null;
    if (!key) return null;
    return this.#queryCrUX(url, 'url', key, formFactor);
  }

  /**
   * Query CrUX API
   * @private
   */
  static async #queryCrUX(
    target: string,
    targetType: string,
    apiKey: string,
    formFactor: string,
  ): Promise<CrUXFieldData | null> {
    return new Promise((resolve) => {
      const requestBody = JSON.stringify({
        [targetType]: target,
        formFactor: formFactor,
        metrics: [
          'largest_contentful_paint',
          'cumulative_layout_shift',
          'interaction_to_next_paint',
          'first_contentful_paint',
        ],
      });

      const url = apiKey ? `${this.#API_ENDPOINT}?key=${apiKey}` : this.#API_ENDPOINT;

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: 10000,
      };

      const req = https.request(url, options, (res: IncomingMessage) => {
        let data = '';

        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(data) as CrUXRawResponse;
              resolve(this.#parseCrUXResponse(parsed, target, targetType));
            } else {
              // Log the actual error for debugging
              let errorMsg = `HTTP ${res.statusCode}`;
              try {
                const errBody = JSON.parse(data) as { error?: { message?: string }; message?: string };
                errorMsg += `: ${errBody.error?.message ?? errBody.message ?? data.slice(0, 200)}`;
              } catch {
                errorMsg += `: ${data.slice(0, 200)}`;
              }
              console.error(`   CrUX API error (${targetType}=${target}): ${errorMsg}`);
              resolve(null);
            }
          } catch (e: unknown) {
            console.error(`   CrUX API parse error: ${(e as Error).message}`);
            resolve(null);
          }
        });
      });

      req.on('error', (e: Error) => {
        console.error(`   CrUX API request error: ${e.message}`);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Parse CrUX API response
   * @private
   */
  static #parseCrUXResponse(response: CrUXRawResponse, target: string, targetType: string): CrUXFieldData | null {
    if (!response.record?.metrics) {
      return null;
    }

    const metrics = response.record.metrics;
    const result: CrUXFieldData = {
      target,
      targetType,
      collectionPeriod: response.record.collectionPeriod,
      metrics: {},
    };

    // Parse each metric
    const metricMappings: Record<string, string> = {
      largest_contentful_paint: 'LCP',
      cumulative_layout_shift: 'CLS',
      interaction_to_next_paint: 'INP',
      first_contentful_paint: 'FCP',
      time_to_first_byte: 'TTFB',
    };

    for (const [apiName, shortName] of Object.entries(metricMappings)) {
      const metric = metrics[apiName];
      if (metric) {
        result.metrics[shortName] = this.#parseMetricData(metric);
      }
    }

    return result;
  }

  /**
   * Parse individual metric data
   * @private
   */
  static #parseMetricData(metric: CrUXRawMetric): CrUXMetricData {
    const data: CrUXMetricData = {
      percentiles: {},
      histogram: [],
    };

    // Parse percentiles
    if (metric.percentiles) {
      data.percentiles = {
        p75: Number(metric.percentiles.p75),
      };
    }

    // Parse histogram (good/needs-improvement/poor distribution)
    if (metric.histogram) {
      data.histogram = metric.histogram.map((bucket: CrUXHistogramBucket) => ({
        start: bucket.start,
        end: bucket.end,
        density: bucket.density,
      }));

      // Calculate percentages
      const [good, needsImprovement, poor] = metric.histogram;
      data.distribution = {
        good: good ? Math.round(good.density * 100) : 0,
        needsImprovement: needsImprovement ? Math.round(needsImprovement.density * 100) : 0,
        poor: poor ? Math.round(poor.density * 100) : 0,
      };
    }

    return data;
  }

  /**
   * Fetch CrUX data via PageSpeed Insights API (no API key required)
   * @private
   */
  static async #fetchViaPSI(urlOrOrigin: string, apiKey: string | null = null): Promise<CrUXFieldData | null> {
    return new Promise((resolve) => {
      let origin: string;
      try {
        origin = new URL(urlOrOrigin).origin;
      } catch {
        resolve(null);
        return;
      }

      let psiUrl = `${this.#PSI_ENDPOINT}?url=${encodeURIComponent(origin)}&category=performance&strategy=mobile`;
      if (apiKey) psiUrl += `&key=${apiKey}`;

      const request = https.get(psiUrl, { timeout: 15000 }, (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            const parsed = JSON.parse(data) as PSIRawResponse;
            const cruxData = this.#parsePSIResponse(parsed, origin);
            resolve(cruxData);
          } catch {
            resolve(null);
          }
        });
      });
      request.on('error', () => resolve(null));
      request.on('timeout', () => {
        request.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Parse CrUX data from PSI response
   * @private
   */
  static #parsePSIResponse(psiData: PSIRawResponse, origin: string): CrUXFieldData | null {
    // PSI provides origin-level CrUX data in originLoadingExperience
    const experience = psiData.originLoadingExperience ?? psiData.loadingExperience;
    if (!experience?.metrics) return null;

    const metrics = experience.metrics;
    const result: CrUXFieldData = {
      target: origin,
      targetType: experience === psiData.originLoadingExperience ? 'origin' : 'url',
      collectionPeriod: null,
      metrics: {},
    };

    const metricMappings: Record<string, string> = {
      LARGEST_CONTENTFUL_PAINT_MS: 'LCP',
      CUMULATIVE_LAYOUT_SHIFT_SCORE: 'CLS',
      INTERACTION_TO_NEXT_PAINT: 'INP',
      FIRST_CONTENTFUL_PAINT_MS: 'FCP',
      EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'TTFB',
    };

    for (const [psiName, shortName] of Object.entries(metricMappings)) {
      const metric = metrics[psiName];
      if (metric) {
        const data: CrUXMetricData = {
          percentiles: { p75: metric.percentile },
          histogram: [],
          distribution: undefined,
        };

        if (metric.distributions) {
          data.distribution = {
            good: Math.round((metric.distributions[0]?.proportion ?? 0) * 100),
            needsImprovement: Math.round((metric.distributions[1]?.proportion ?? 0) * 100),
            poor: Math.round((metric.distributions[2]?.proportion ?? 0) * 100),
          };
        }

        result.metrics[shortName] = data;
      }
    }

    return Object.keys(result.metrics).length > 0 ? result : null;
  }

  /**
   * Compare lab metrics with field data
   * @param {object} labMetrics - Lab-collected metrics
   * @param {object} fieldData - CrUX field data
   * @returns {object} Comparison results
   */
  static compareLabVsField(labMetrics: LabMetrics, fieldData: CrUXFieldData | null): CrUXComparison {
    if (!fieldData?.metrics) {
      return { available: false };
    }

    const comparison: CrUXComparison = {
      available: true,
      metrics: {},
    };

    const metricsToCompare = ['TTFB', 'FCP', 'LCP', 'CLS', 'INP'];

    for (const metric of metricsToCompare) {
      const labValue = labMetrics[metric];
      const fieldMetric = fieldData.metrics[metric];

      if (labValue !== undefined && fieldMetric?.percentiles?.p75 !== undefined) {
        const fieldP75 = fieldMetric.percentiles.p75;
        const difference = labValue - fieldP75;
        const percentDiff = fieldP75 > 0 ? Math.round((difference / fieldP75) * 100) : 0;

        comparison.metrics![metric] = {
          lab: labValue,
          fieldP75: fieldP75,
          difference,
          percentDiff,
          labVsField: difference > 0 ? 'worse' : difference < 0 ? 'better' : 'same',
          distribution: fieldMetric.distribution,
        };
      }
    }

    return comparison;
  }

  /**
   * Get field data summary for display
   * @param {object} fieldData - CrUX field data
   * @returns {object} Formatted summary
   */
  static formatFieldDataSummary(fieldData: CrUXFieldData | null): CrUXFieldSummary | null {
    if (!fieldData?.metrics) {
      return null;
    }

    const summary: CrUXFieldSummary = {
      target: fieldData.target,
      targetType: fieldData.targetType,
      collectionPeriod: fieldData.collectionPeriod,
      coreWebVitals: {},
      passingCWV: true,
    };

    // Core Web Vitals thresholds
    const thresholds: Record<string, number> = {
      LCP: 2500,
      CLS: 0.1,
      INP: 200,
    };

    for (const [metric, threshold] of Object.entries(thresholds)) {
      const data = fieldData.metrics[metric];
      if (data?.percentiles?.p75 !== undefined) {
        const p75 = Number(data.percentiles.p75);
        const passing = p75 <= threshold;

        summary.coreWebVitals[metric] = {
          p75: metric === 'CLS' ? p75.toFixed(2) : `${Math.round(p75)}ms`,
          passing,
          distribution: data.distribution,
        };

        if (!passing) {
          summary.passingCWV = false;
        }
      }
    }

    return summary;
  }

  /**
   * Fetch and compare for a page
   * @param {string} url - Page URL
   * @param {object} labMetrics - Lab metrics
   * @param {string} apiKey - Optional API key
   * @returns {Promise<object>} Comparison data
   */
  static async fetchAndCompare(url: string, labMetrics: LabMetrics, apiKey: string | null = null) {
    const fieldData = await this.fetchCrUXData(url, apiKey);

    if (!fieldData) {
      return {
        hasFieldData: false,
        message: 'No CrUX field data available for this URL or origin',
      };
    }

    const comparison = this.compareLabVsField(labMetrics, fieldData);
    const summary = this.formatFieldDataSummary(fieldData);

    return {
      hasFieldData: true,
      fieldData,
      comparison,
      summary,
      insights: this.#generateInsights(comparison),
    };
  }

  /**
   * Generate insights from lab vs field comparison
   * @private
   */
  static #generateInsights(comparison: CrUXComparison): CrUXInsight[] {
    const insights: CrUXInsight[] = [];

    if (!comparison.available || !comparison.metrics) {
      return insights;
    }

    for (const [metric, data] of Object.entries(comparison.metrics)) {
      if (data.labVsField === 'worse' && Math.abs(data.percentDiff) > 20) {
        insights.push({
          metric,
          type: 'warning',
          message: `Lab ${metric} (${this.#formatValue(metric, data.lab)}) is ${Math.abs(data.percentDiff)}% worse than field p75 (${this.#formatValue(metric, data.fieldP75)}). Real users may have better experience.`,
        });
      } else if (data.labVsField === 'better' && Math.abs(data.percentDiff) > 50) {
        insights.push({
          metric,
          type: 'info',
          message: `Lab ${metric} (${this.#formatValue(metric, data.lab)}) is ${Math.abs(data.percentDiff)}% better than field p75 (${this.#formatValue(metric, data.fieldP75)}). Real users may have worse experience due to network/device variance.`,
        });
      }

      // Check field distribution
      if (data.distribution?.poor && data.distribution.poor > 25) {
        insights.push({
          metric,
          type: 'critical',
          message: `${data.distribution.poor}% of real users experience poor ${metric}. This needs immediate attention.`,
        });
      }
    }

    return insights;
  }

  /**
   * Format metric value for display
   * @private
   */
  static #formatValue(metric: string, value: number): string {
    if (metric === 'CLS') {
      return value.toFixed(2);
    }
    return `${Math.round(value)}ms`;
  }
}

export { CrUXAPI };
export type { CrUXFieldData, CrUXMetricData, CrUXComparison, CrUXInsight, CrUXFieldSummary, LabMetrics };
