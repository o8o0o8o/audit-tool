/**
 * Chrome UX Report (CrUX) API Integration
 * Fetches real-user field data for comparison with lab metrics
 */

const https = require('https');

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
  static async fetchCrUXData(urlOrOrigin, apiKey = null, formFactor = 'ALL_FORM_FACTORS') {
    // Both CrUX and PSI APIs require an API key
    const key = apiKey || process.env.CRUX_API_KEY || null;

    if (key) {
      // Try CrUX API first (more detailed)
      let data = await this.#queryCrUX(urlOrOrigin, 'url', key, formFactor);
      if (!data) {
        try {
          const origin = new URL(urlOrOrigin).origin;
          data = await this.#queryCrUX(origin, 'origin', key, formFactor);
        } catch (e) {
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
   * Query CrUX API
   * @private
   */
  static async #queryCrUX(target, targetType, apiKey, formFactor) {
    return new Promise((resolve) => {
      const requestBody = JSON.stringify({
        [targetType]: target,
        formFactor: formFactor,
        metrics: [
          'largest_contentful_paint',
          'cumulative_layout_shift',
          'interaction_to_next_paint',
          'first_contentful_paint',
          'time_to_first_byte',
        ],
      });

      const url = apiKey
        ? `${this.#API_ENDPOINT}?key=${apiKey}`
        : this.#API_ENDPOINT;

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: 10000,
      };

      const req = https.request(url, options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(data);
              resolve(this.#parseCrUXResponse(parsed, target, targetType));
            } else {
              // No data available or API error
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', () => {
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
  static #parseCrUXResponse(response, target, targetType) {
    if (!response.record || !response.record.metrics) {
      return null;
    }

    const metrics = response.record.metrics;
    const result = {
      target,
      targetType,
      collectionPeriod: response.record.collectionPeriod,
      metrics: {},
    };

    // Parse each metric
    const metricMappings = {
      largest_contentful_paint: 'LCP',
      cumulative_layout_shift: 'CLS',
      interaction_to_next_paint: 'INP',
      first_contentful_paint: 'FCP',
      time_to_first_byte: 'TTFB',
    };

    for (const [apiName, shortName] of Object.entries(metricMappings)) {
      const metric = metrics[apiName];
      if (metric) {
        result.metrics[shortName] = this.#parseMetricData(metric, shortName);
      }
    }

    return result;
  }

  /**
   * Parse individual metric data
   * @private
   */
  static #parseMetricData(metric, metricName) {
    const data = {
      percentiles: {},
      histogram: [],
    };

    // Parse percentiles
    if (metric.percentiles) {
      data.percentiles = {
        p75: metric.percentiles.p75,
      };
    }

    // Parse histogram (good/needs-improvement/poor distribution)
    if (metric.histogram) {
      data.histogram = metric.histogram.map(bucket => ({
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
  static async #fetchViaPSI(urlOrOrigin, apiKey = null) {
    return new Promise((resolve) => {
      let origin;
      try {
        origin = new URL(urlOrOrigin).origin;
      } catch {
        resolve(null);
        return;
      }

      let psiUrl = `${this.#PSI_ENDPOINT}?url=${encodeURIComponent(origin)}&category=performance&strategy=mobile`;
      if (apiKey) psiUrl += `&key=${apiKey}`;

      https.get(psiUrl, { timeout: 15000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            const parsed = JSON.parse(data);
            const cruxData = this.#parsePSIResponse(parsed, origin);
            resolve(cruxData);
          } catch {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null))
        .on('timeout', function() { this.destroy(); resolve(null); });
    });
  }

  /**
   * Parse CrUX data from PSI response
   * @private
   */
  static #parsePSIResponse(psiData, origin) {
    // PSI provides origin-level CrUX data in originLoadingExperience
    const experience = psiData.originLoadingExperience || psiData.loadingExperience;
    if (!experience || !experience.metrics) return null;

    const metrics = experience.metrics;
    const result = {
      target: origin,
      targetType: experience === psiData.originLoadingExperience ? 'origin' : 'url',
      collectionPeriod: null,
      metrics: {},
    };

    const metricMappings = {
      LARGEST_CONTENTFUL_PAINT_MS: 'LCP',
      CUMULATIVE_LAYOUT_SHIFT_SCORE: 'CLS',
      INTERACTION_TO_NEXT_PAINT: 'INP',
      FIRST_CONTENTFUL_PAINT_MS: 'FCP',
      EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'TTFB',
    };

    for (const [psiName, shortName] of Object.entries(metricMappings)) {
      const metric = metrics[psiName];
      if (metric) {
        const data = {
          percentiles: { p75: metric.percentile },
          histogram: [],
          distribution: {},
        };

        if (metric.distributions) {
          data.distribution = {
            good: Math.round((metric.distributions[0]?.proportion || 0) * 100),
            needsImprovement: Math.round((metric.distributions[1]?.proportion || 0) * 100),
            poor: Math.round((metric.distributions[2]?.proportion || 0) * 100),
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
  static compareLabVsField(labMetrics, fieldData) {
    if (!fieldData || !fieldData.metrics) {
      return { available: false };
    }

    const comparison = {
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

        comparison.metrics[metric] = {
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
  static formatFieldDataSummary(fieldData) {
    if (!fieldData || !fieldData.metrics) {
      return null;
    }

    const summary = {
      target: fieldData.target,
      targetType: fieldData.targetType,
      collectionPeriod: fieldData.collectionPeriod,
      coreWebVitals: {},
      passingCWV: true,
    };

    // Core Web Vitals thresholds
    const thresholds = {
      LCP: 2500,
      CLS: 0.1,
      INP: 200,
    };

    for (const [metric, threshold] of Object.entries(thresholds)) {
      const data = fieldData.metrics[metric];
      if (data?.percentiles?.p75 !== undefined) {
        const p75 = data.percentiles.p75;
        const passing = metric === 'CLS' ? p75 <= threshold : p75 <= threshold;

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
  static async fetchAndCompare(url, labMetrics, apiKey = null) {
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
  static #generateInsights(comparison) {
    const insights = [];

    if (!comparison.available) {
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
      if (data.distribution?.poor > 25) {
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
  static #formatValue(metric, value) {
    if (metric === 'CLS') {
      return value.toFixed(2);
    }
    return `${Math.round(value)}ms`;
  }
}

module.exports = { CrUXAPI };
