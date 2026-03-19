/**
 * Web Vitals Collector
 * Collects Core Web Vitals and advanced performance metrics
 * Based on Google's web-vitals library methodology
 */

import { THRESHOLDS } from '../constants';
import type { ChromePage } from '../types';

// ─── Vitals-specific interfaces ─────────────────────────────────────────────

interface LCPSubParts {
  ttfb: number;
  resourceLoad: number;
  resourceDelay: number;
  renderDelay: number;
}

interface CLSEntrySource {
  node: string | null;
  currentRect: { x: number; y: number; width: number; height: number } | null;
}

interface CLSEntry {
  value: number;
  startTime: number;
  sources: CLSEntrySource[];
}

interface LongTaskEntry {
  startTime: number;
  duration: number;
  blockingTime: number;
  name: string;
  attribution: Array<{ name: string; containerType: string; containerSrc: string }>;
}

interface CollectedVitals {
  TTFB: number;
  FCP: number;
  LCP: number;
  CLS: number;
  INP: number;

  // LCP sub-parts
  lcpSubParts: LCPSubParts;

  // Attribution
  lcpElement: string | null;
  lcpUrl: string | null;
  lcpSize: { width: number; height: number } | null;
  clsEntries: CLSEntry[];
  clsLargestShift: number | null;
  clsShiftCount: number;
  inpEvent: string | null;

  // Advanced metrics
  TBT: number;
  TTI: number;
  speedIndex: number;
  longTasks: LongTaskEntry[];

  // Navigation timing
  domContentLoaded: number;
  domComplete: number;
  loadEvent: number;
}

interface VitalsThresholdResult {
  ttfbPass: boolean;
  fcpPass: boolean;
  lcpPass: boolean;
  clsPass: boolean;
  inpPass: boolean;
  allPass: boolean;
}

interface MetricThreshold {
  good: number;
  poor: number;
}

interface FormattedMetric {
  value: number;
  formatted: string;
  rating: string;
  element?: string | null;
  url?: string | null;
  subParts?: LCPSubParts;
  shiftCount?: number;
  largestShift?: number | null;
  entries?: CLSEntry[];
  event?: string | null;
  longTaskCount?: number;
}

interface LCPAnalysis {
  bottleneck: string;
  bottleneckValue?: number;
  percentages?: {
    ttfb: number;
    resourceDelay: number;
    resourceLoad: number;
    renderDelay: number;
  };
  recommendations: string[];
}

interface CLSSourceElement {
  node: string;
  count: number;
}

interface CLSAnalysis {
  elements: CLSSourceElement[];
  recommendations: string[];
}

interface LongTaskScript {
  script: string;
  blockingTime: number;
}

interface LongTaskAnalysis {
  tasks: LongTaskEntry[];
  scripts?: LongTaskScript[];
  totalBlockingTime: number;
  recommendations: string[];
}

class VitalsCollector {
  /**
   * Collect all performance metrics from a page
   * @param {object} page - Playwright page object
   * @returns {Promise<object>} Collected vitals and advanced metrics
   */
  static async collectVitals(page: ChromePage): Promise<CollectedVitals> {
    const vitals = await page.evaluate((clsWaitTime) => {
      return new Promise((resolve) => {
        const metrics = {
          // Core Web Vitals
          TTFB: 0,
          FCP: 0,
          LCP: 0,
          CLS: 0,
          INP: 0,

          // LCP Sub-parts
          lcpTTFB: 0,
          lcpResourceLoad: 0,
          lcpResourceDelay: 0,
          lcpRenderDelay: 0,

          // Attribution data
          lcpElement: null as string | null,
          lcpUrl: null as string | null,
          lcpSize: null as { width: number; height: number } | null,
          clsEntries: [] as Array<{
            value: number;
            startTime: number;
            sources: Array<{
              node: string | null;
              currentRect: { x: number; y: number; width: number; height: number } | null;
            }>;
          }>,
          clsLargestShift: null as number | null,
          clsShiftCount: 0,
          inpEvent: null as string | null,

          // Advanced metrics
          TBT: 0, // Total Blocking Time
          TTI: 0, // Time to Interactive
          longTasks: [] as Array<{
            startTime: number;
            duration: number;
            blockingTime: number;
            name: string;
            attribution: Array<{ name: string; containerType: string; containerSrc: string }>;
          }>,
          speedIndex: 0, // Speed Index (estimated)

          // Additional timing
          domContentLoaded: 0,
          domComplete: 0,
          loadEvent: 0,
        };

        let lcpFired = false;
        let clsObserver: PerformanceObserver | undefined = undefined,
          lcpObserver: PerformanceObserver | undefined = undefined,
          inpObserver: PerformanceObserver | undefined,
          longTaskObserver: PerformanceObserver | undefined;

        // CLS Session Window tracking
        let clsSessionValue = 0;
        let clsSessionEntries: PerformanceEntry[] = [];
        let clsMaxSessionValue = 0;
        let clsMaxSessionEntries: PerformanceEntry[] = [];

        // INP tracking
        const inpEntries: Array<{ name: string; duration: number; interactionId: number; startTime: number }> = [];

        // Long tasks for TBT calculation
        const longTasks: Array<{
          startTime: number;
          duration: number;
          blockingTime: number;
          name: string;
          attribution: Array<{ name: string; containerType: string; containerSrc: string }>;
        }> = [];
        let tbtTotal = 0;

        // Helper to finalize
        const finalize = () => {
          if (clsObserver) clsObserver.disconnect();
          if (lcpObserver) lcpObserver.disconnect();
          if (inpObserver) inpObserver.disconnect();
          if (longTaskObserver) longTaskObserver.disconnect();

          // Calculate INP (p98 or worst)
          if (inpEntries.length > 0) {
            inpEntries.sort((a, b) => b.duration - a.duration); // descending
            const inpIndex =
              inpEntries.length >= 50
                ? Math.floor(inpEntries.length * 0.02) // p98 = top 2% index in descending array
                : 0;
            metrics.INP = inpEntries[inpIndex]?.duration || 0;
            metrics.inpEvent = inpEntries[inpIndex]?.name || null;
          }

          // Use max session window for CLS
          metrics.CLS = clsMaxSessionValue;
          metrics.clsEntries = clsMaxSessionEntries.map((e) => {
            const entry = e as PerformanceEntry & {
              value: number;
              sources?: Array<{ node?: { nodeName?: string }; currentRect?: DOMRectReadOnly }>;
            };
            return {
              value: entry.value,
              startTime: entry.startTime,
              sources: (entry.sources ?? []).map((s) => ({
                node: s.node?.nodeName ?? null,
                currentRect: s.currentRect
                  ? {
                      x: Math.round(s.currentRect.x),
                      y: Math.round(s.currentRect.y),
                      width: Math.round(s.currentRect.width),
                      height: Math.round(s.currentRect.height),
                    }
                  : null,
              })),
            };
          });

          if (clsMaxSessionEntries.length > 0) {
            const largest = clsMaxSessionEntries.reduce((max, e) => {
              const maxEntry = max as PerformanceEntry & { value: number };
              const curEntry = e as PerformanceEntry & { value: number };
              return curEntry.value > maxEntry.value ? e : max;
            }, clsMaxSessionEntries[0]);
            metrics.clsLargestShift = (largest as PerformanceEntry & { value: number }).value;
          }
          metrics.clsShiftCount = clsMaxSessionEntries.length;

          // Calculate TBT (sum of blocking time > 50ms)
          metrics.TBT = tbtTotal;
          metrics.longTasks = longTasks.slice(0, 10); // Top 10 long tasks

          // Calculate TTI estimate
          metrics.TTI = calculateTTI(longTasks, metrics.FCP);

          // Calculate Speed Index estimate
          metrics.speedIndex = calculateSpeedIndex(metrics.FCP, metrics.LCP);

          resolve({
            TTFB: Number(metrics.TTFB.toFixed(2)),
            FCP: Number(metrics.FCP.toFixed(2)),
            LCP: Number(metrics.LCP.toFixed(2)),
            CLS: Number(metrics.CLS.toFixed(4)),
            INP: Number(metrics.INP.toFixed(2)),

            // LCP sub-parts
            lcpSubParts: {
              ttfb: Number(metrics.lcpTTFB.toFixed(2)),
              resourceLoad: Number(metrics.lcpResourceLoad.toFixed(2)),
              resourceDelay: Number(metrics.lcpResourceDelay.toFixed(2)),
              renderDelay: Number(metrics.lcpRenderDelay.toFixed(2)),
            },

            // Attribution
            lcpElement: metrics.lcpElement,
            lcpUrl: metrics.lcpUrl,
            lcpSize: metrics.lcpSize,
            clsEntries: metrics.clsEntries,
            clsLargestShift: metrics.clsLargestShift ? Number(metrics.clsLargestShift.toFixed(4)) : null,
            clsShiftCount: metrics.clsShiftCount,
            inpEvent: metrics.inpEvent,

            // Advanced metrics
            TBT: Number(metrics.TBT.toFixed(2)),
            TTI: Number(metrics.TTI.toFixed(2)),
            speedIndex: Number(metrics.speedIndex.toFixed(2)),
            longTasks: metrics.longTasks,

            // Navigation timing
            domContentLoaded: Number(metrics.domContentLoaded.toFixed(2)),
            domComplete: Number(metrics.domComplete.toFixed(2)),
            loadEvent: Number(metrics.loadEvent.toFixed(2)),
          });
        };

        // Calculate TTI (Time to Interactive)
        // Simplified: FCP + time until 5s window with no long tasks
        const calculateTTI = (tasks: Array<{ startTime: number; duration: number }>, fcp: number): number => {
          if (tasks.length === 0) return fcp;

          // Sort tasks by start time
          const sortedTasks = [...tasks].sort((a, b) => a.startTime - b.startTime);

          // Find quiet window (5s with no long tasks after FCP)
          let quietWindowStart = fcp;
          for (const task of sortedTasks) {
            if (task.startTime < quietWindowStart) continue;

            // If task is within 5s of quiet window start, reset
            if (task.startTime < quietWindowStart + 5000) {
              quietWindowStart = task.startTime + task.duration;
            }
          }

          return quietWindowStart;
        };

        // Calculate Speed Index estimate
        // Simplified: weighted average of FCP and LCP
        const calculateSpeedIndex = (fcp: number, lcp: number): number => {
          if (!fcp || !lcp) return 0;
          // Rough approximation: SI is typically between FCP and LCP
          // Real SI requires video capture, this is an estimate
          return fcp * 0.4 + lcp * 0.6;
        };

        // 1. Navigation Timing & TTFB
        const navObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            const nav = entries[0] as PerformanceNavigationTiming;
            const activationStart =
              (nav as PerformanceNavigationTiming & { activationStart?: number }).activationStart ?? 0;
            metrics.TTFB = Math.max(nav.responseStart - activationStart, 0);
            metrics.domContentLoaded = nav.domContentLoadedEventEnd - activationStart;
            metrics.domComplete = nav.domComplete - activationStart;
            metrics.loadEvent = nav.loadEventEnd - activationStart;

            // Store TTFB for LCP sub-parts
            metrics.lcpTTFB = metrics.TTFB;
            navObserver.disconnect();
          }
        });
        navObserver.observe({ type: 'navigation', buffered: true });

        // 2. FCP
        const fcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const fcpEntry = entries.find((e) => e.name === 'first-contentful-paint');
          if (fcpEntry) {
            metrics.FCP = fcpEntry.startTime;
            fcpObserver.disconnect();
          }
        });
        fcpObserver.observe({ type: 'paint', buffered: true });

        // 3. LCP with sub-parts
        lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastLCP = entries.at(-1) as
            | (PerformanceEntry & {
                element?: HTMLElement;
                url?: string;
                loadTime?: number;
                startTime: number;
              })
            | undefined;
          if (lastLCP) {
            metrics.LCP = lastLCP.startTime;

            // LCP element attribution
            if (lastLCP.element) {
              metrics.lcpElement = lastLCP.element.tagName?.toLowerCase() || null;
              if (lastLCP.element.tagName === 'IMG') {
                metrics.lcpUrl = (lastLCP.element as HTMLImageElement).src?.substring(0, 150) || null;
                metrics.lcpSize = {
                  width: (lastLCP.element as HTMLImageElement).naturalWidth,
                  height: (lastLCP.element as HTMLImageElement).naturalHeight,
                };
              }
            }
            if (lastLCP.url) {
              metrics.lcpUrl = lastLCP.url.substring(0, 150);
            }

            // LCP Sub-parts calculation
            // LCP = TTFB + Resource Load Delay + Resource Load Time + Element Render Delay

            if (lastLCP.url) {
              // For resource-based LCP (images, videos)
              const resourceEntries = performance.getEntriesByType('resource');
              const lcpResource = resourceEntries.find((r) => r.name === lastLCP.url);

              if (lcpResource) {
                metrics.lcpResourceDelay = Math.max(lcpResource.startTime - metrics.TTFB, 0);
                metrics.lcpResourceLoad =
                  (lcpResource as PerformanceResourceTiming).responseEnd - lcpResource.startTime;
                metrics.lcpRenderDelay = lastLCP.startTime - (lcpResource as PerformanceResourceTiming).responseEnd;
              }
            } else {
              // For text-based LCP
              metrics.lcpResourceDelay = 0;
              metrics.lcpResourceLoad = 0;
              metrics.lcpRenderDelay = lastLCP.startTime - metrics.TTFB;
            }

            if (!lcpFired) {
              lcpFired = true;
              setTimeout(finalize, clsWaitTime);
            }
          }
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

        // 4. CLS with element attribution
        clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const clsEntry = entry as PerformanceEntry & { hadRecentInput?: boolean; value: number };
            if (clsEntry.hadRecentInput) continue;

            // Session window logic
            const firstEntry = clsSessionEntries[0];
            const lastEntry = clsSessionEntries[clsSessionEntries.length - 1];

            if (
              clsSessionEntries.length > 0 &&
              clsEntry.startTime - lastEntry.startTime < 1000 &&
              clsEntry.startTime - firstEntry.startTime < 5000
            ) {
              clsSessionValue += clsEntry.value;
              clsSessionEntries.push(entry);
            } else {
              clsSessionValue = clsEntry.value;
              clsSessionEntries = [entry];
            }

            if (clsSessionValue > clsMaxSessionValue) {
              clsMaxSessionValue = clsSessionValue;
              clsMaxSessionEntries = [...clsSessionEntries];
            }
          }
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });

        // 5. INP
        try {
          inpObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const eventEntry = entry as PerformanceEntry & { interactionId?: number };
              if (eventEntry.interactionId && eventEntry.interactionId > 0) {
                inpEntries.push({
                  name: eventEntry.name,
                  duration: eventEntry.duration,
                  interactionId: eventEntry.interactionId,
                  startTime: eventEntry.startTime,
                });
              }
            }
          });
          inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
        } catch {
          // INP not supported
        }

        // 6. Long Tasks / Long Animation Frames for TBT
        try {
          // Try Long Animation Frames first (newer, more accurate)
          longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const taskEntry = entry as PerformanceEntry & {
                attribution?: Array<{ name: string; containerType: string; containerSrc?: string }>;
              };
              const blockingTime = Math.max(taskEntry.duration - 50, 0);
              tbtTotal += blockingTime;

              longTasks.push({
                startTime: taskEntry.startTime,
                duration: taskEntry.duration,
                blockingTime,
                name: taskEntry.name || 'long-task',
                // Attribution if available
                attribution:
                  taskEntry.attribution?.map((a) => ({
                    name: a.name,
                    containerType: a.containerType,
                    containerSrc: a.containerSrc?.substring(0, 100) ?? '',
                  })) ?? [],
              });
            }
          });

          // Try 'long-animation-frame' first, fall back to 'longtask'
          try {
            longTaskObserver.observe({ type: 'long-animation-frame', buffered: true });
          } catch {
            longTaskObserver.observe({ type: 'longtask', buffered: true });
          }
        } catch {
          // Long task observation not supported
        }

        // Fallback timeout
        setTimeout(() => {
          if (!lcpFired) {
            finalize();
          }
        }, clsWaitTime + 1000);
      });
    }, THRESHOLDS.CLS_COLLECTION_TIME);

    return vitals as CollectedVitals;
  }

  /**
   * Check if vitals meet thresholds
   * @param {object} vitals - Collected vitals
   * @returns {object} Passing status for each metric
   */
  static checkThresholds(vitals: CollectedVitals): VitalsThresholdResult {
    return {
      ttfbPass: vitals.TTFB <= THRESHOLDS.TTFB,
      fcpPass: vitals.FCP <= THRESHOLDS.FCP,
      lcpPass: vitals.LCP <= THRESHOLDS.LCP,
      clsPass: vitals.CLS <= THRESHOLDS.CLS,
      inpPass: vitals.INP <= THRESHOLDS.INP,
      allPass:
        vitals.TTFB <= THRESHOLDS.TTFB &&
        vitals.FCP <= THRESHOLDS.FCP &&
        vitals.LCP <= THRESHOLDS.LCP &&
        vitals.CLS <= THRESHOLDS.CLS &&
        (vitals.INP === 0 || vitals.INP <= THRESHOLDS.INP),
    };
  }

  /**
   * Get rating for a metric value
   * @param {string} metric - Metric name
   * @param {number} value - Metric value
   * @returns {string} Rating: 'good', 'needs-improvement', or 'poor'
   */
  static getRating(metric: string, value: number): string {
    const thresholds: Record<string, MetricThreshold> = {
      TTFB: { good: 800, poor: 1800 },
      FCP: { good: 1800, poor: 3000 },
      LCP: { good: 2500, poor: 4000 },
      CLS: { good: 0.1, poor: 0.25 },
      INP: { good: 200, poor: 500 },
      TBT: { good: 200, poor: 600 },
      TTI: { good: 3800, poor: 7300 },
      speedIndex: { good: 3400, poor: 5800 },
    };

    const t = thresholds[metric];
    if (!t) return 'unknown';

    if (value <= t.good) return 'good';
    if (value <= t.poor) return 'needs-improvement';
    return 'poor';
  }

  /**
   * Format vitals for display
   * @param {object} vitals - Collected vitals
   * @returns {object} Formatted vitals with ratings
   */
  static formatVitals(vitals: CollectedVitals): Record<string, FormattedMetric> {
    return {
      TTFB: {
        value: vitals.TTFB,
        formatted: `${Math.round(vitals.TTFB)}ms`,
        rating: this.getRating('TTFB', vitals.TTFB),
      },
      FCP: {
        value: vitals.FCP,
        formatted: `${(vitals.FCP / 1000).toFixed(2)}s`,
        rating: this.getRating('FCP', vitals.FCP),
      },
      LCP: {
        value: vitals.LCP,
        formatted: `${(vitals.LCP / 1000).toFixed(2)}s`,
        rating: this.getRating('LCP', vitals.LCP),
        element: vitals.lcpElement,
        url: vitals.lcpUrl,
        subParts: vitals.lcpSubParts,
      },
      CLS: {
        value: vitals.CLS,
        formatted: vitals.CLS.toFixed(3),
        rating: this.getRating('CLS', vitals.CLS),
        shiftCount: vitals.clsShiftCount,
        largestShift: vitals.clsLargestShift,
        entries: vitals.clsEntries,
      },
      INP: {
        value: vitals.INP,
        formatted: vitals.INP > 0 ? `${Math.round(vitals.INP)}ms` : 'N/A',
        rating: vitals.INP > 0 ? this.getRating('INP', vitals.INP) : 'unknown',
        event: vitals.inpEvent,
      },
      TBT: {
        value: vitals.TBT,
        formatted: `${Math.round(vitals.TBT)}ms`,
        rating: this.getRating('TBT', vitals.TBT),
        longTaskCount: vitals.longTasks?.length || 0,
      },
      TTI: {
        value: vitals.TTI,
        formatted: `${(vitals.TTI / 1000).toFixed(2)}s`,
        rating: this.getRating('TTI', vitals.TTI),
      },
      speedIndex: {
        value: vitals.speedIndex,
        formatted: `${Math.round(vitals.speedIndex)}`,
        rating: this.getRating('speedIndex', vitals.speedIndex),
      },
    };
  }

  /**
   * Analyze LCP sub-parts and provide recommendations
   * @param {object} lcpSubParts - LCP sub-parts data
   * @param {number} lcp - Total LCP value
   * @returns {object} Analysis with bottleneck identification
   */
  static analyzeLCPSubParts(lcpSubParts: LCPSubParts | null | undefined, lcp: number): LCPAnalysis {
    if (!lcpSubParts || lcp === 0) {
      return { bottleneck: 'unknown', recommendations: [] };
    }

    const { ttfb, resourceLoad, resourceDelay, renderDelay } = lcpSubParts;
    const recommendations: string[] = [];
    let bottleneck = 'none';
    let bottleneckValue = 0;

    // Identify the largest contributor
    if (ttfb > bottleneckValue) {
      bottleneck = 'ttfb';
      bottleneckValue = ttfb;
    }
    if (resourceDelay > bottleneckValue) {
      bottleneck = 'resourceDelay';
      bottleneckValue = resourceDelay;
    }
    if (resourceLoad > bottleneckValue) {
      bottleneck = 'resourceLoad';
      bottleneckValue = resourceLoad;
    }
    if (renderDelay > bottleneckValue) {
      bottleneck = 'renderDelay';
      bottleneckValue = renderDelay;
    }

    // Generate recommendations based on bottleneck
    if (ttfb > 600) {
      recommendations.push('Improve server response time (TTFB) with caching, CDN, or server optimization');
    }
    if (resourceDelay > 200) {
      recommendations.push('Reduce resource delay by preloading the LCP image/resource');
    }
    if (resourceLoad > 500) {
      recommendations.push('Optimize LCP resource size - compress images, use modern formats (WebP/AVIF)');
    }
    if (renderDelay > 200) {
      recommendations.push('Reduce render delay by eliminating render-blocking resources');
    }

    return {
      bottleneck,
      bottleneckValue,
      percentages: {
        ttfb: lcp > 0 ? Math.round((ttfb / lcp) * 100) : 0,
        resourceDelay: lcp > 0 ? Math.round((resourceDelay / lcp) * 100) : 0,
        resourceLoad: lcp > 0 ? Math.round((resourceLoad / lcp) * 100) : 0,
        renderDelay: lcp > 0 ? Math.round((renderDelay / lcp) * 100) : 0,
      },
      recommendations,
    };
  }

  /**
   * Analyze CLS entries and identify problematic elements
   * @param {Array} clsEntries - CLS entry data
   * @returns {object} Analysis with element identification
   */
  static analyzeCLSSources(clsEntries: CLSEntry[]): CLSAnalysis {
    if (!clsEntries || clsEntries.length === 0) {
      return { elements: [], recommendations: [] };
    }

    const elementCounts = new Map<string, number>();
    const recommendations: string[] = [];

    for (const entry of clsEntries) {
      for (const source of entry.sources || []) {
        if (source.node) {
          const key = source.node;
          elementCounts.set(key, (elementCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const elements = Array.from(elementCounts.entries())
      .map(([node, count]) => ({ node, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Generate recommendations
    if (elements.some((e) => e.node === 'IMG')) {
      recommendations.push('Set explicit width/height attributes on images');
    }
    if (elements.some((e) => e.node === 'IFRAME')) {
      recommendations.push('Reserve space for iframes/embeds with CSS aspect-ratio');
    }
    if (elements.length > 0) {
      recommendations.push('Use CSS contain property on dynamic content areas');
    }

    return { elements, recommendations };
  }

  /**
   * Analyze long tasks and identify blocking scripts
   * @param {Array} longTasks - Long task entries
   * @returns {object} Analysis with script identification
   */
  static analyzeLongTasks(longTasks: LongTaskEntry[]): LongTaskAnalysis {
    if (!longTasks || longTasks.length === 0) {
      return { tasks: [], recommendations: [], totalBlockingTime: 0 };
    }

    const totalBlockingTime = longTasks.reduce((sum, t) => sum + t.blockingTime, 0);

    // Group by attribution
    const scriptCounts = new Map<string, number>();
    for (const task of longTasks) {
      for (const attr of task.attribution || []) {
        if (attr.containerSrc) {
          scriptCounts.set(attr.containerSrc, (scriptCounts.get(attr.containerSrc) ?? 0) + task.blockingTime);
        }
      }
    }

    const scripts = Array.from(scriptCounts.entries())
      .map(([script, blockingTime]) => ({ script, blockingTime }))
      .sort((a, b) => b.blockingTime - a.blockingTime)
      .slice(0, 5);

    const recommendations: string[] = [];
    if (totalBlockingTime > 300) {
      recommendations.push('Break up long JavaScript tasks using requestIdleCallback or setTimeout');
    }
    if (scripts.some((s) => s.script.includes('third-party') || s.script.includes('analytics'))) {
      recommendations.push('Defer or lazy-load third-party scripts');
    }
    if (longTasks.length > 10) {
      recommendations.push('Consider code splitting to reduce main thread blocking');
    }

    return {
      tasks: longTasks.slice(0, 5),
      scripts,
      totalBlockingTime,
      recommendations,
    };
  }
}

export { VitalsCollector };
export type {
  CollectedVitals,
  LCPSubParts,
  CLSEntry,
  LongTaskEntry,
  VitalsThresholdResult,
  FormattedMetric,
  LCPAnalysis,
  CLSAnalysis,
  LongTaskAnalysis,
};
