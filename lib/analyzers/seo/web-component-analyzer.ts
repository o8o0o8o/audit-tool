/**
 * Web Component Analyzer
 * Analyzes Shadow DOM and custom elements for SEO implications
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, ParsedPage, Issue, PageInfo } from '../../types';

class WebComponentAnalyzer {
  /**
   * Analyze web components usage
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const webComponentData = {
      customElements: [] as Record<string, any>[],
      shadowRoots: [] as Record<string, any>[],
      totalCustomElements: 0,
      totalShadowRoots: 0,
      contentInShadowDom: {
        text: false,
        links: false,
        headings: false,
        images: false,
      },
      shadowDomTextLength: 0,
      lightDomTextLength: 0,
      framework: null as string | null,
    };

    // 1. Detect custom elements
    const customElements = await this.#detectCustomElements(chromePage);
    webComponentData.customElements = customElements;
    webComponentData.totalCustomElements = customElements.length;

    // 2. Analyze shadow DOM
    const shadowAnalysis = await this.#analyzeShadowDom(chromePage);
    webComponentData.shadowRoots = shadowAnalysis.shadowRoots;
    webComponentData.totalShadowRoots = shadowAnalysis.count;
    webComponentData.contentInShadowDom = shadowAnalysis.contentInShadow;
    webComponentData.shadowDomTextLength = shadowAnalysis.shadowTextLength;
    webComponentData.lightDomTextLength = shadowAnalysis.lightDomTextLength;

    // 3. Detect web component framework
    webComponentData.framework = await this.#detectFramework(chromePage, parsedPage);

    // 4. Check for declarative shadow DOM
    (webComponentData as Record<string, any>).hasDeclarativeShadowDom = this.#checkDeclarativeShadowDom(parsedPage);

    // Generate issues

    // Important content hidden in shadow DOM
    if (shadowAnalysis.contentInShadow.headings) {
      issues.push({
        message: 'Heading content in Shadow DOM',
        detail: `<a href="${url}">${url}</a> has heading tags (h1-h6) inside Shadow DOM. Search engines may not see this content. Use Light DOM for important headings.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Links in shadow DOM
    if (shadowAnalysis.contentInShadow.links) {
      issues.push({
        message: 'Links inside Shadow DOM',
        detail: `<a href="${url}">${url}</a> has links inside Shadow DOM. These links may not be crawlable. Ensure important navigation is in Light DOM.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Significant text in shadow DOM
    const totalText = shadowAnalysis.shadowTextLength + shadowAnalysis.lightDomTextLength;
    const shadowTextRatio = totalText > 0 ? shadowAnalysis.shadowTextLength / totalText : 0;

    if (shadowTextRatio > 0.5) {
      issues.push({
        message: 'Most content in Shadow DOM',
        detail: `<a href="${url}">${url}</a> has ${Math.round(shadowTextRatio * 100)}% of text content in Shadow DOM. Search engines may not index this content properly.`,
        severity: SEVERITY.HIGH,
      });
    } else if (shadowTextRatio > 0.2) {
      warnings.push({
        message: 'Significant content in Shadow DOM',
        detail: `<a href="${url}">${url}</a> has ${Math.round(shadowTextRatio * 100)}% of text in Shadow DOM. Verify important content is in Light DOM for crawlers.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Images in shadow DOM
    if (shadowAnalysis.contentInShadow.images) {
      warnings.push({
        message: 'Images inside Shadow DOM',
        detail: `<a href="${url}">${url}</a> has images in Shadow DOM. Image alt text may not be accessible to search engines.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Custom elements without declarative shadow DOM
    if (webComponentData.totalShadowRoots > 0 && !(webComponentData as Record<string, any>).hasDeclarativeShadowDom) {
      warnings.push({
        message: 'No declarative Shadow DOM fallback',
        detail: `<a href="${url}">${url}</a> uses Shadow DOM but lacks declarative shadow DOM (template with shadowrootmode). Content may not be visible without JavaScript.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Many custom elements (potential performance concern)
    if (webComponentData.totalCustomElements > 50) {
      warnings.push({
        message: 'Heavy use of custom elements',
        detail: `<a href="${url}">${url}</a> uses ${webComponentData.totalCustomElements} custom elements. This may impact performance and requires JavaScript for hydration.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, webComponentData };
  }

  /**
   * Detect custom elements
   * @private
   */
  static async #detectCustomElements(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const customElements: Record<string, any>[] = [];
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
          const tagName = el.tagName.toLowerCase();
          // Custom elements must contain a hyphen
          if (tagName.includes('-')) {
            const existing = customElements.find((c) => c.tagName === tagName);
            if (existing) {
              existing.count++;
            } else {
              customElements.push({
                tagName,
                count: 1,
                hasShadowRoot: !!el.shadowRoot,
                isConnected: el.isConnected,
              });
            }
          }
        }

        return customElements;
      });
    } catch {
      return [];
    }
  }

  /**
   * Analyze shadow DOM content
   * @private
   */
  static async #analyzeShadowDom(chromePage: ChromePage) {
    try {
      return await chromePage.evaluate(() => {
        const result = {
          shadowRoots: [],
          count: 0,
          contentInShadow: {
            text: false,
            links: false,
            headings: false,
            images: false,
          },
          shadowTextLength: 0,
          lightDomTextLength: 0,
        };

        // Get light DOM text length
        result.lightDomTextLength = document.body?.innerText?.length || 0;

        // Find all shadow roots
        const findShadowRoots = (root: Element | ShadowRoot | Document, depth = 0): void => {
          if (depth > 10) return; // Prevent infinite recursion

          const elements = root.querySelectorAll('*');

          for (const el of elements) {
            if (el.shadowRoot) {
              result.count++;

              const shadowRoot = el.shadowRoot;
              const shadowText = shadowRoot.textContent || '';
              result.shadowTextLength += shadowText.length;

              // Check for important content in shadow
              if (shadowText.trim().length > 50) {
                result.contentInShadow.text = true;
              }

              if (shadowRoot.querySelectorAll('a[href]').length > 0) {
                result.contentInShadow.links = true;
              }

              if (shadowRoot.querySelectorAll('h1, h2, h3, h4, h5, h6').length > 0) {
                result.contentInShadow.headings = true;
              }

              if (shadowRoot.querySelectorAll('img').length > 0) {
                result.contentInShadow.images = true;
              }

              (result.shadowRoots as Record<string, any>[]).push({
                hostTag: el.tagName.toLowerCase(),
                mode: shadowRoot.mode,
                childCount: shadowRoot.childElementCount,
                textLength: shadowText.length,
              });

              // Recursively check nested shadow roots
              findShadowRoots(shadowRoot, depth + 1);
            }
          }
        };

        findShadowRoots(document);

        // Adjust light DOM text to exclude shadow DOM text
        // (innerText includes shadow DOM content in some browsers)
        result.lightDomTextLength = Math.max(0, result.lightDomTextLength - result.shadowTextLength);

        return result;
      });
    } catch {
      return {
        shadowRoots: [],
        count: 0,
        contentInShadow: { text: false, links: false, headings: false, images: false },
        shadowTextLength: 0,
        lightDomTextLength: 0,
      };
    }
  }

  /**
   * Detect web component framework
   * @private
   */
  static async #detectFramework(chromePage: ChromePage, parsedPage: ParsedPage) {
    const html = parsedPage.toString();

    // Check for common web component frameworks
    if (html.includes('lit-html') || html.includes('lit-element')) {
      return 'Lit';
    }
    if (html.includes('stencil') || html.includes('stenciljs')) {
      return 'Stencil';
    }
    if (html.includes('polymer')) {
      return 'Polymer';
    }
    if (html.includes('shoelace') || html.includes('sl-')) {
      return 'Shoelace';
    }
    if (html.includes('fast-element') || html.includes('fluent-')) {
      return 'FAST';
    }

    try {
      return await chromePage.evaluate(() => {
        // Check for framework-specific globals
        if ((window as Record<string, any>).Lit) return 'Lit';
        if ((window as Record<string, any>).Stencil) return 'Stencil';
        if ((window as Record<string, any>).Polymer) return 'Polymer';
        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Check for declarative shadow DOM
   * @private
   */
  static #checkDeclarativeShadowDom(parsedPage: ParsedPage) {
    // Check for template with shadowrootmode attribute
    const templates = parsedPage.querySelectorAll('template[shadowrootmode], template[shadowroot]');
    return templates.length > 0;
  }

  /**
   * Site-wide web component analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithShadowDom = 0;
    let pagesWithContentInShadow = 0;
    const frameworksUsed = new Set();

    for (const [_url, page] of Object.entries(pages)) {
      if (page.webComponentData) {
        if ((page.webComponentData.totalShadowRoots ?? 0) > 0) {
          pagesWithShadowDom++;
        }

        const content = page.webComponentData.contentInShadowDom;
        if (content?.headings || content?.links) {
          pagesWithContentInShadow++;
        }

        if (page.webComponentData.framework) {
          frameworksUsed.add(page.webComponentData.framework);
        }
      }
    }

    const totalPages = Object.keys(pages).length;

    if (pagesWithContentInShadow > 0) {
      issues.push({
        message: `${pagesWithContentInShadow} pages have important content in Shadow DOM`,
        detail:
          'Links and headings in Shadow DOM may not be crawlable by search engines. Move critical content to Light DOM.',
        severity: SEVERITY.HIGH,
      });
    }

    if (pagesWithShadowDom > totalPages * 0.5) {
      warnings.push({
        message: 'Heavy Shadow DOM usage across site',
        detail: `${pagesWithShadowDom} of ${totalPages} pages use Shadow DOM. Ensure server-side rendering or declarative shadow DOM is implemented for SEO.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { WebComponentAnalyzer };
