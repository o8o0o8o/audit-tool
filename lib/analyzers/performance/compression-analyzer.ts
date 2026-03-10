/**
 * Compression Analyzer
 * Checks for gzip/brotli compression on text-based resources
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

// File types that should be compressed
const COMPRESSIBLE_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/plain',
  'image/svg+xml',
  'application/x-javascript',
  'application/xhtml+xml',
];

// File extensions that should be compressed
const COMPRESSIBLE_EXTENSIONS = [
  '.html', '.htm', '.css', '.js', '.json', '.xml', '.svg', '.txt', '.map',
];

// Minimum size worth compressing (bytes)
const MIN_SIZE_FOR_COMPRESSION = 1024; // 1KB

class CompressionAnalyzer {
  /**
   * Analyze compression for a page and its resources
   * @param {object} pageData - Page data with resource information
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: any, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      htmlCompression: null,
      compressedResources: 0,
      uncompressedResources: 0,
      potentialSavings: 0,
      compressionTypes: { gzip: 0, br: 0, deflate: 0, none: 0 },
      resources: [] as any[],
    };

    // Check HTML compression
    const htmlEncoding = pageData.contentEncoding || pageData.headers?.['content-encoding'];
    info.htmlCompression = htmlEncoding || 'none';

    if (htmlEncoding) {
      if (htmlEncoding.includes('br')) {
        info.compressionTypes.br++;
      } else if (htmlEncoding.includes('gzip')) {
        info.compressionTypes.gzip++;
      } else if (htmlEncoding.includes('deflate')) {
        info.compressionTypes.deflate++;
      }
      info.compressedResources++;
    } else {
      info.compressionTypes.none++;
      info.uncompressedResources++;

      // Check if HTML is large enough to benefit
      const htmlSize = pageData.htmlSize || pageData.contentLength || 0;
      if (htmlSize > MIN_SIZE_FOR_COMPRESSION) {
        const estimatedSavings = Math.round(htmlSize * 0.7); // ~70% compression ratio
        info.potentialSavings += estimatedSavings;

        issues.push({
          message: 'HTML not compressed',
          detail: `Page HTML (${this.formatBytes(htmlSize)}) is not using gzip/brotli compression. Potential savings: ~${this.formatBytes(estimatedSavings)}`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    // Check resource compression
    const resources = pageData.resources || [];
    for (const resource of resources) {
      const resourceInfo = this.analyzeResource(resource);
      info.resources.push(resourceInfo);

      if (resourceInfo.shouldCompress && !resourceInfo.isCompressed) {
        info.uncompressedResources++;
        info.compressionTypes.none++;
        info.potentialSavings += resourceInfo.potentialSavings;
      } else if (resourceInfo.isCompressed) {
        info.compressedResources++;
        if (resourceInfo.encoding.includes('br')) {
          info.compressionTypes.br++;
        } else if (resourceInfo.encoding.includes('gzip')) {
          info.compressionTypes.gzip++;
        } else {
          info.compressionTypes.deflate++;
        }
      }
    }

    // Generate warnings for uncompressed resources
    const uncompressedLarge = info.resources.filter((r: any) =>
      r.shouldCompress && !r.isCompressed && r.size > 10000
    );

    if (uncompressedLarge.length > 0) {
      const totalSavings = uncompressedLarge.reduce((sum: number, r: any) => sum + r.potentialSavings, 0);
      const examples = uncompressedLarge.slice(0, 3).map((r: any) =>
        `${this.getFileName(r.url)} (${this.formatBytes(r.size)})`
      ).join(', ');

      issues.push({
        message: 'Large resources not compressed',
        detail: `${uncompressedLarge.length} resources over 10KB lack compression. Examples: ${examples}. Total potential savings: ~${this.formatBytes(totalSavings)}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check if using brotli (better compression)
    if (info.compressionTypes.gzip > 0 && info.compressionTypes.br === 0) {
      warnings.push({
        message: 'Brotli compression not detected',
        detail: `Site uses gzip but not brotli. Brotli offers 15-25% better compression for text resources.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Analyze a single resource for compression
   * @param {object} resource - Resource data
   * @returns {object} Resource analysis
   */
  static analyzeResource(resource: any) {
    const url = resource.url || '';
    const contentType = resource.contentType || resource.mimeType || '';
    const encoding = resource.contentEncoding || '';
    const size = resource.size || resource.transferSize || 0;

    const isCompressible = this.isCompressible(url, contentType);
    const shouldCompress = isCompressible && size > MIN_SIZE_FOR_COMPRESSION;
    const isCompressed = encoding && (
      encoding.includes('gzip') ||
      encoding.includes('br') ||
      encoding.includes('deflate')
    );

    const potentialSavings = shouldCompress && !isCompressed
      ? Math.round(size * 0.7)
      : 0;

    return {
      url,
      contentType,
      encoding: encoding || 'none',
      size,
      isCompressible,
      shouldCompress,
      isCompressed,
      potentialSavings,
    };
  }

  /**
   * Check if a resource type is compressible
   * @param {string} url - Resource URL
   * @param {string} contentType - Content-Type header
   * @returns {boolean}
   */
  static isCompressible(url: string, contentType: string) {
    // Check content type
    if (contentType) {
      const normalizedType = contentType.toLowerCase().split(';')[0].trim();
      if (COMPRESSIBLE_TYPES.some(t => normalizedType.includes(t))) {
        return true;
      }
    }

    // Check file extension
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (COMPRESSIBLE_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
        return true;
      }
    } catch {
      // Invalid URL
    }

    return false;
  }

  /**
   * Analyze compression across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, any>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      pagesWithCompression: 0,
      pagesWithoutCompression: 0,
      totalCompressedResources: 0,
      totalUncompressedResources: 0,
      totalPotentialSavings: 0,
      compressionTypes: { gzip: 0, br: 0, deflate: 0, none: 0 },
    };

    const uncompressedPages: any[] = [];

    for (const [url, pageData] of Object.entries(pages)) {
      const htmlEncoding = pageData.contentEncoding || pageData.headers?.['content-encoding'];

      if (htmlEncoding) {
        stats.pagesWithCompression++;
        if (htmlEncoding.includes('br')) {
          stats.compressionTypes.br++;
        } else if (htmlEncoding.includes('gzip')) {
          stats.compressionTypes.gzip++;
        }
      } else {
        stats.pagesWithoutCompression++;
        stats.compressionTypes.none++;
        const size = pageData.htmlSize || pageData.contentLength || 0;
        if (size > MIN_SIZE_FOR_COMPRESSION) {
          uncompressedPages.push({ url, size });
          stats.totalPotentialSavings += Math.round(size * 0.7);
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    // Report uncompressed pages
    if (uncompressedPages.length > 0) {
      const percentage = ((uncompressedPages.length / totalPages) * 100).toFixed(1);
      issues.push({
        message: 'Pages served without compression',
        detail: `${uncompressedPages.length} pages (${percentage}%) lack gzip/brotli compression. Total potential savings: ~${this.formatBytes(stats.totalPotentialSavings)}`,
        severity: uncompressedPages.length > totalPages * 0.5 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    }

    // Check compression consistency
    if (stats.compressionTypes.gzip > 0 && stats.compressionTypes.none > 0) {
      warnings.push({
        message: 'Inconsistent compression across pages',
        detail: `${stats.pagesWithCompression} pages compressed, ${stats.pagesWithoutCompression} not. Ensure server compression is enabled for all responses.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Recommend brotli
    if (stats.compressionTypes.br === 0 && stats.compressionTypes.gzip > 0) {
      warnings.push({
        message: 'Consider enabling Brotli compression',
        detail: `All ${stats.pagesWithCompression} compressed pages use gzip. Brotli offers 15-25% better compression and is supported by all modern browsers.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }

  /**
   * Format bytes to human readable
   * @param {number} bytes
   * @returns {string}
   */
  static formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Get filename from URL
   * @param {string} url
   * @returns {string}
   */
  static getFileName(url: string) {
    try {
      const pathname = new URL(url).pathname;
      return pathname.split('/').pop() || pathname;
    } catch {
      return url;
    }
  }
}

export { CompressionAnalyzer };