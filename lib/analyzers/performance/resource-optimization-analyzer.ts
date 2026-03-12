import { SEVERITY, THRESHOLDS } from '../../constants';
import type { ChromePage, NetworkRequest } from '../../types';

class ResourceOptimizationAnalyzer {
  static async analyzeResourceOptimization(chromePage: ChromePage, requests: NetworkRequest[], url: string) {
    const resourceAnalysis = {
      compression: {
        gzipCompressed: 0,
        brotliCompressed: 0,
        uncompressed: 0,
        totalSize: 0,
        compressedSize: 0,
        issues: [] as Record<string, any>[],
      },
      minification: {
        minifiedJS: 0,
        unminifiedJS: 0,
        minifiedCSS: 0,
        unminifiedCSS: 0,
        issues: [] as Record<string, any>[],
      },
      renderBlocking: {
        blockingScripts: 0,
        blockingStyles: 0,
        totalBlocking: 0,
        issues: [] as Record<string, any>[],
      },
      protocol: {
        http1: 0,
        http2: 0,
        http3: 0,
      },
    };

    // Analyze all requests
    for (const [resourceUrl, reqData] of Object.entries(requests) as [string, any][]) {
      const headers = reqData.headers || {};
      const size = reqData.size || 0;
      const resourceType = reqData.resourceType;

      // Check compression
      const contentEncoding = headers['content-encoding'] || '';
      if (contentEncoding.includes('br')) {
        resourceAnalysis.compression.brotliCompressed++;
        resourceAnalysis.compression.compressedSize += size;
      } else if (contentEncoding.includes('gzip')) {
        resourceAnalysis.compression.gzipCompressed++;
        resourceAnalysis.compression.compressedSize += size;
      } else if (resourceType === 'script' || resourceType === 'stylesheet' || resourceType === 'document') {
        resourceAnalysis.compression.uncompressed++;
        if (size > 5000) {
          // Only flag significant uncompressed resources
          resourceAnalysis.compression.issues.push({
            severity: SEVERITY.MEDIUM,
            url: resourceUrl,
            size: size,
          });
        }
      }

      resourceAnalysis.compression.totalSize += size;

      // Check minification for JS/CSS
      if (resourceType === 'script' && size > THRESHOLDS.UNMINIFIED_SIZE_THRESHOLD) {
        const urlLower = resourceUrl.toLowerCase();
        if (urlLower.includes('.min.js') || urlLower.includes('-min.js')) {
          resourceAnalysis.minification.minifiedJS++;
        } else if (!urlLower.includes('node_modules')) {
          resourceAnalysis.minification.unminifiedJS++;
          resourceAnalysis.minification.issues.push({
            severity: SEVERITY.LOW,
            url: resourceUrl,
            type: 'JavaScript',
            size: size,
          });
        }
      }

      if (resourceType === 'stylesheet' && size > THRESHOLDS.UNMINIFIED_SIZE_THRESHOLD) {
        const urlLower = resourceUrl.toLowerCase();
        if (urlLower.includes('.min.css') || urlLower.includes('-min.css')) {
          resourceAnalysis.minification.minifiedCSS++;
        } else {
          resourceAnalysis.minification.unminifiedCSS++;
          resourceAnalysis.minification.issues.push({
            severity: SEVERITY.LOW,
            url: resourceUrl,
            type: 'CSS',
            size: size,
          });
        }
      }

      // Detect HTTP protocol version
      const protocol = headers[':protocol'] || headers['protocol'] || '';
      if (protocol.includes('h3') || protocol.includes('http/3')) {
        resourceAnalysis.protocol.http3++;
      } else if (protocol.includes('h2') || protocol.includes('http/2')) {
        resourceAnalysis.protocol.http2++;
      } else {
        resourceAnalysis.protocol.http1++;
      }
    }

    // Check for render-blocking resources
    const renderBlockingInfo = await chromePage.evaluate(() => {
      const blockingScripts = Array.from(
        document.querySelectorAll('script:not([async]):not([defer]):not([type="module"])'),
      ).filter((script: any) => {
        const src = script.src || '';
        return src && !src.includes('data:');
      });

      const blockingStyles = Array.from(
        document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])'),
      ).filter((link) => {
        return !link.hasAttribute('disabled');
      });

      return {
        blockingScripts: blockingScripts.length,
        blockingStyles: blockingStyles.length,
      };
    });

    resourceAnalysis.renderBlocking.blockingScripts = renderBlockingInfo.blockingScripts;
    resourceAnalysis.renderBlocking.blockingStyles = renderBlockingInfo.blockingStyles;
    resourceAnalysis.renderBlocking.totalBlocking =
      renderBlockingInfo.blockingScripts + renderBlockingInfo.blockingStyles;

    if (resourceAnalysis.renderBlocking.totalBlocking > THRESHOLDS.RENDER_BLOCKING_MAX) {
      resourceAnalysis.renderBlocking.issues.push({
        severity: SEVERITY.HIGH,
        message: `Some pages have too many render-blocking resources`,
        detail: `<a href="${url}">${url}</a> has ${resourceAnalysis.renderBlocking.totalBlocking} render-blocking resources (${renderBlockingInfo.blockingScripts} scripts, ${renderBlockingInfo.blockingStyles} styles)`,
      });
    }

    // Collect all issues at the top level for reportIssues()
    (resourceAnalysis as Record<string, any>).issues = [...resourceAnalysis.renderBlocking.issues];

    return resourceAnalysis;
  }
}

export { ResourceOptimizationAnalyzer };
