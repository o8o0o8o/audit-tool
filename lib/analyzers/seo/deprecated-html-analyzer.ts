/**
 * Deprecated HTML & API Analyzer
 * Detects deprecated HTML elements and JavaScript APIs
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage } from '../../types';

// Deprecated HTML elements with their replacements
const DEPRECATED_ELEMENTS: Record<string, string> = {
  center: 'CSS text-align: center',
  font: 'CSS font-family, font-size, color',
  marquee: 'CSS animations',
  blink: 'CSS animations',
  big: 'CSS font-size',
  strike: '<del> or <s>',
  tt: '<code> or CSS font-family: monospace',
  acronym: '<abbr>',
  applet: '<object> or <embed>',
  basefont: 'CSS font properties',
  dir: '<ul>',
  isindex: '<form> with <input>',
  menu: '<ul> (in older HTML context)',
  bgsound: '<audio>',
  nobr: 'CSS white-space: nowrap',
  spacer: 'CSS margin/padding',
  xmp: '<pre><code>',
  listing: '<pre><code>',
  plaintext: '<pre>',
};

class DeprecatedHTMLAnalyzer {
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      deprecatedElements: { tag: string; count: number; replacement: string }[];
      deprecatedAPIs: string[];
      totalDeprecated: number;
    } = {
      deprecatedElements: [],
      deprecatedAPIs: [],
      totalDeprecated: 0,
    };

    // 1. Check for deprecated HTML elements
    for (const [tag, replacement] of Object.entries(DEPRECATED_ELEMENTS)) {
      const elements = parsedPage.querySelectorAll(tag);
      if (elements.length > 0) {
        info.deprecatedElements.push({ tag, count: elements.length, replacement });
      }
    }

    // Also check frame/frameset (already partially covered in technical-seo)
    const frames = parsedPage.querySelectorAll('frame, frameset');
    if (frames.length > 0) {
      info.deprecatedElements.push({
        tag: 'frame/frameset',
        count: frames.length,
        replacement: '<iframe> or modern layout',
      });
    }

    // 2. Check for deprecated JavaScript APIs
    try {
      const deprecatedAPIs = await chromePage.evaluate(() => {
        const found: string[] = [];

        // Check for document.write usage in inline scripts
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
          const content = script.textContent || '';
          if (/document\.write\s*\(/.test(content)) {
            found.push('document.write()');
            break;
          }
        }

        // Check for other deprecated patterns
        // Note: These are informational — we're checking if they exist in the DOM or inline scripts
        const allScriptContent = Array.from(scripts)
          .map((s) => s.textContent || '')
          .join('\n');

        if (/document\.domain\s*=/.test(allScriptContent)) {
          found.push('document.domain assignment');
        }
        if (/window\.showModalDialog/.test(allScriptContent)) {
          found.push('window.showModalDialog()');
        }
        if (/window\.captureEvents/.test(allScriptContent)) {
          found.push('window.captureEvents()');
        }

        return found;
      });

      info.deprecatedAPIs = deprecatedAPIs;
    } catch {
      // Script evaluation failed
    }

    info.totalDeprecated = info.deprecatedElements.length + info.deprecatedAPIs.length;

    // Report deprecated HTML elements
    if (info.deprecatedElements.length > 0) {
      const examples = info.deprecatedElements
        .slice(0, 5)
        .map((e) => `<${e.tag}> (${e.count}x → use ${e.replacement})`)
        .join(', ');

      const totalCount = info.deprecatedElements.reduce((sum, e) => sum + e.count, 0);

      issues.push({
        message: `Deprecated HTML elements found (${totalCount} instances)`,
        detail: `${info.deprecatedElements.length} deprecated element type(s): ${examples}. These elements are removed from the HTML standard and may not render correctly in all browsers.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Report deprecated APIs
    if (info.deprecatedAPIs.length > 0) {
      warnings.push({
        message: 'Deprecated JavaScript APIs detected',
        detail: `Found usage of: ${info.deprecatedAPIs.join(', ')}. ${info.deprecatedAPIs.includes('document.write()') ? 'document.write() blocks parsing and can significantly slow page load.' : 'Replace with modern alternatives.'}`,
        severity: info.deprecatedAPIs.includes('document.write()') ? SEVERITY.MEDIUM : SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { DeprecatedHTMLAnalyzer };
