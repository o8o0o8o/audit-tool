/**
 * Web Vitals Collector
 * Collects Core Web Vitals (TTFB, FCP, LCP, CLS) from pages
 */

const { THRESHOLDS } = require('../constants');

class VitalsCollector {
  /**
   * Collect Core Web Vitals from a page
   * @param {object} page - Playwright page object
   * @returns {Promise<object>} Collected vitals
   */
  static async collectVitals(page) {
    // Optimized Core Web Vitals collection
    const vitals = await page.evaluate((clsWaitTime) => {
      return new Promise((resolve) => {
        const metrics = {
          TTFB: 0,
          FCP: 0,
          LCP: 0,
          CLS: 0,
        };

        let lcpFired = false;
        let clsObserver, lcpObserver;

        // Helper to finalize and resolve
        const finalize = () => {
          if (clsObserver) clsObserver.disconnect();
          if (lcpObserver) lcpObserver.disconnect();

          resolve({
            TTFB: Number(metrics.TTFB.toFixed(2)),
            FCP: Number(metrics.FCP.toFixed(2)),
            LCP: Number(metrics.LCP.toFixed(2)),
            CLS: Number(metrics.CLS.toFixed(4)),
          });
        };

        // 1. TTFB - Time to First Byte (immediate)
        const ttfbObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            const navigationEntry = entries[0];
            metrics.TTFB = navigationEntry.responseStart - navigationEntry.fetchStart;
            ttfbObserver.disconnect();
          }
        });
        ttfbObserver.observe({ type: "navigation", buffered: true });

        // 2. FCP - First Contentful Paint (immediate)
        const fcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const fcpEntry = entries.find(e => e.name === 'first-contentful-paint');
          if (fcpEntry) {
            metrics.FCP = fcpEntry.startTime;
            fcpObserver.disconnect();
          }
        });
        fcpObserver.observe({ type: "paint", buffered: true });

        // 3. LCP - Largest Contentful Paint (triggers CLS collection)
        lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastLCP = entries.at(-1);
          if (lastLCP) {
            metrics.LCP = lastLCP.startTime;

            // Once LCP fires, wait a bit more for CLS to stabilize
            if (!lcpFired) {
              lcpFired = true;
              setTimeout(finalize, clsWaitTime);
            }
          }
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });

        // 4. CLS - Cumulative Layout Shift (continuous until finalize)
        clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              metrics.CLS += entry.value;
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });

        // Fallback: if LCP never fires (e.g., fast page), finalize after timeout
        setTimeout(() => {
          if (!lcpFired) {
            finalize();
          }
        }, clsWaitTime + 1000); // Extra 1s fallback
      });
    }, THRESHOLDS.CLS_COLLECTION_TIME);

    return vitals;
  }

  /**
   * Check if vitals meet thresholds
   * @param {object} vitals - Collected vitals
   * @returns {object} Passing status for each metric
   */
  static checkThresholds(vitals) {
    return {
      ttfbPass: vitals.TTFB <= THRESHOLDS.TTFB,
      fcpPass: vitals.FCP <= THRESHOLDS.FCP,
      lcpPass: vitals.LCP <= THRESHOLDS.LCP,
      clsPass: vitals.CLS <= THRESHOLDS.CLS,
      allPass: vitals.TTFB <= THRESHOLDS.TTFB &&
               vitals.FCP <= THRESHOLDS.FCP &&
               vitals.LCP <= THRESHOLDS.LCP &&
               vitals.CLS <= THRESHOLDS.CLS,
    };
  }
}

module.exports = { VitalsCollector };
