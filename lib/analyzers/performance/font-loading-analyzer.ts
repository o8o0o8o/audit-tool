/**
 * Font Loading Analyzer
 * Analyzes font loading strategies to prevent FOUT/FOIT issues
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage, PageInfo, NetworkRequest } from '../../types';

interface FontFileInfo {
  url: string;
  size: number;
  format: string;
  status: number | undefined;
}

interface FontPreloadInfo {
  href: string | undefined;
  crossorigin: string | undefined;
}

interface FontFaceInfo {
  family: string;
  display: string;
  src: string | undefined;
}

interface NetworkRequestEntry {
  size?: number;
  resourceType?: string;
  status?: number;
  duration?: number;
  [key: string]: unknown;
}

class FontLoadingAnalyzer {
  /**
   * Analyze font loading strategy
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {Object} requests - Network requests
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, requests: NetworkRequest[], url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const fontData: {
      fonts: FontFileInfo[];
      totalFontSize: number;
      hasPreload: boolean;
      hasFontDisplay: boolean;
      fontDisplayValues: string[];
      webFontCount: number;
      systemFonts: boolean;
      issues: Issue[];
      preloadedFonts?: FontPreloadInfo[];
      fontFaces?: FontFaceInfo[];
      externalFontServices?: { services: string[]; hasPreconnect: boolean };
    } = {
      fonts: [],
      totalFontSize: 0,
      hasPreload: false,
      hasFontDisplay: false,
      fontDisplayValues: [],
      webFontCount: 0,
      systemFonts: false,
      issues: [],
    };

    // 1. Analyze font requests from network
    const fontRequests = this.#analyzeFontRequests(requests);
    fontData.fonts = fontRequests.fonts;
    fontData.totalFontSize = fontRequests.totalSize;
    fontData.webFontCount = fontRequests.fonts.length;

    // 2. Check for font preloading
    const preloadedFonts = this.#checkFontPreload(parsedPage);
    fontData.hasPreload = preloadedFonts.length > 0;
    fontData.preloadedFonts = preloadedFonts;

    // 3. Analyze @font-face declarations and font-display
    const fontFaceAnalysis = await this.#analyzeFontFace(chromePage);
    fontData.fontFaces = fontFaceAnalysis.fontFaces;
    fontData.hasFontDisplay = fontFaceAnalysis.hasFontDisplay;
    fontData.fontDisplayValues = fontFaceAnalysis.fontDisplayValues as string[];

    // 4. Check for system font fallbacks
    fontData.systemFonts = await this.#checkSystemFontFallback(chromePage);

    // 5. Check for Google Fonts / external font services
    const externalFonts = this.#checkExternalFontServices(requests, parsedPage);
    fontData.externalFontServices = externalFonts;

    // Generate issues

    // Large total font size
    if (fontData.totalFontSize > 500000) {
      // 500KB
      issues.push({
        message: 'Excessive web font payload',
        detail: `<a href="${url}">${url}</a> loads ${(fontData.totalFontSize / 1024).toFixed(0)}KB of fonts. Consider subsetting fonts or reducing font variants.`,
        severity: SEVERITY.HIGH,
      });
    } else if (fontData.totalFontSize > 250000) {
      // 250KB
      warnings.push({
        message: 'Large web font payload',
        detail: `<a href="${url}">${url}</a> loads ${(fontData.totalFontSize / 1024).toFixed(0)}KB of fonts. Consider optimizing.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Too many font files
    if (fontData.webFontCount > 6) {
      issues.push({
        message: 'Too many font files loaded',
        detail: `<a href="${url}">${url}</a> loads ${fontData.webFontCount} font files. Consider consolidating to reduce requests.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Missing font-display
    if (fontData.webFontCount > 0 && !fontData.hasFontDisplay) {
      issues.push({
        message: 'Missing font-display property',
        detail: `<a href="${url}">${url}</a> uses web fonts without font-display. This can cause FOIT (Flash of Invisible Text). Add font-display: swap or optional.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Using font-display: block (causes FOIT)
    if (fontData.fontDisplayValues.includes('block')) {
      warnings.push({
        message: 'font-display: block can cause FOIT',
        detail: `<a href="${url}">${url}</a> uses font-display: block which hides text until font loads. Consider using 'swap' or 'optional'.`,
        severity: SEVERITY.LOW,
      });
    }

    // Not preloading critical fonts
    if (fontData.webFontCount > 0 && !fontData.hasPreload) {
      warnings.push({
        message: 'Web fonts not preloaded',
        detail: `<a href="${url}">${url}</a> could benefit from preloading critical fonts using <link rel="preload" as="font">`,
        severity: SEVERITY.LOW,
      });
    }

    // External font services without preconnect
    if (externalFonts.services.length > 0 && !externalFonts.hasPreconnect) {
      warnings.push({
        message: 'Missing preconnect for font services',
        detail: `Add <link rel="preconnect" href="https://fonts.googleapis.com"> (or similar) to speed up font loading.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, fontData };
  }

  /**
   * Analyze font requests from network data
   * @private
   */
  static #analyzeFontRequests(requests: NetworkRequest[]) {
    const fonts: FontFileInfo[] = [];
    let totalSize = 0;

    const fontExtensions = ['.woff2', '.woff', '.ttf', '.otf', '.eot'];

    for (const [reqUrl, req] of Object.entries(requests) as unknown as [string, NetworkRequestEntry][]) {
      const isFont = fontExtensions.some((ext) => reqUrl.toLowerCase().includes(ext)) || req.resourceType === 'font';

      if (isFont) {
        const size = req.size ?? 0;
        totalSize += size;

        fonts.push({
          url: reqUrl,
          size,
          format: this.#getFontFormat(reqUrl),
          status: req.status,
        });
      }
    }

    return { fonts, totalSize };
  }

  /**
   * Get font format from URL
   * @private
   */
  static #getFontFormat(url: string) {
    if (url.includes('.woff2')) return 'woff2';
    if (url.includes('.woff')) return 'woff';
    if (url.includes('.ttf')) return 'truetype';
    if (url.includes('.otf')) return 'opentype';
    if (url.includes('.eot')) return 'embedded-opentype';
    return 'unknown';
  }

  /**
   * Check for font preload links
   * @private
   */
  static #checkFontPreload(parsedPage: ParsedPage) {
    const preloaded: FontPreloadInfo[] = [];
    const preloadLinks = parsedPage.querySelectorAll('link[rel="preload"][as="font"]');

    for (const link of preloadLinks) {
      preloaded.push({
        href: link.getAttribute('href'),
        crossorigin: link.getAttribute('crossorigin'),
      });
    }

    return preloaded;
  }

  /**
   * Analyze @font-face declarations
   * @private
   */
  static async #analyzeFontFace(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const fontFaces = [];
        const fontDisplayValues = new Set();
        let hasFontDisplay = false;

        // Check all stylesheets
        for (const sheet of document.styleSheets) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            for (const rule of rules) {
              if (rule instanceof CSSFontFaceRule) {
                const fontDisplay = (rule.style as unknown as Record<string, string>).fontDisplay;
                const fontFamily = rule.style.fontFamily;

                fontFaces.push({
                  family: fontFamily,
                  display: fontDisplay || 'auto',
                  src: (rule.style as unknown as Record<string, string>).src?.substring(0, 100),
                });

                if (fontDisplay) {
                  hasFontDisplay = true;
                  fontDisplayValues.add(fontDisplay);
                }
              }
            }
          } catch {
            // Cross-origin stylesheet, skip
          }
        }

        return {
          fontFaces,
          hasFontDisplay,
          fontDisplayValues: Array.from(fontDisplayValues),
        };
      });
    } catch {
      return { fontFaces: [], hasFontDisplay: false, fontDisplayValues: [] };
    }
  }

  /**
   * Check if page uses system font stack as fallback
   * @private
   */
  static async #checkSystemFontFallback(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const body = document.body;
        if (!body) return false;

        const computed = getComputedStyle(body);
        const fontFamily = computed.fontFamily.toLowerCase();

        // Check for system font stack indicators
        const systemFontIndicators = [
          '-apple-system',
          'blinkmacsystemfont',
          'segoe ui',
          'system-ui',
          'roboto',
          'helvetica neue',
          'arial',
          'sans-serif',
        ];

        return systemFontIndicators.some((font) => fontFamily.includes(font));
      });
    } catch {
      return false;
    }
  }

  /**
   * Check for external font services
   * @private
   */
  static #checkExternalFontServices(requests: NetworkRequest[], parsedPage: ParsedPage) {
    const services: string[] = [];
    let hasPreconnect = false;

    const fontServiceDomains = [
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      'use.typekit.net',
      'fast.fonts.net',
      'cloud.typography.com',
      'fonts.adobe.com',
    ];

    // Check requests
    for (const reqUrl of Object.keys(requests)) {
      for (const domain of fontServiceDomains) {
        if (reqUrl.includes(domain) && !services.includes(domain)) {
          services.push(domain);
        }
      }
    }

    // Check for preconnect
    const preconnects = parsedPage.querySelectorAll('link[rel="preconnect"]');
    for (const link of preconnects) {
      const href = link.getAttribute('href') ?? '';
      if (fontServiceDomains.some((d) => href.includes(d))) {
        hasPreconnect = true;
        break;
      }
    }

    return { services, hasPreconnect };
  }

  /**
   * Site-wide font analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithoutFontDisplay = 0;
    const fontFilesUsed = new Set();

    for (const [_url, page] of Object.entries(pages)) {
      if (page.fontData) {
        const fd = page.fontData as { webFontCount?: number; hasFontDisplay?: boolean; fonts?: FontFileInfo[] };
        if ((fd.webFontCount ?? 0) > 0 && !fd.hasFontDisplay) {
          pagesWithoutFontDisplay++;
        }

        for (const font of fd.fonts ?? []) {
          fontFilesUsed.add(font.url);
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    if (pagesWithoutFontDisplay > totalPages * 0.5) {
      issues.push({
        message: 'Most pages missing font-display property',
        detail: `${pagesWithoutFontDisplay} of ${totalPages} pages don't specify font-display, risking FOIT/FOUT issues.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (fontFilesUsed.size > 15) {
      warnings.push({
        message: 'Many different font files used across site',
        detail: `${fontFilesUsed.size} unique font files detected. Consider consolidating font usage for better caching.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings };
  }
}

export { FontLoadingAnalyzer };
