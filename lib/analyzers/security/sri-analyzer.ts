/**
 * Subresource Integrity (SRI) Analyzer
 * Checks that external scripts and stylesheets include integrity attributes
 */

import { SEVERITY } from '../../constants';
import type { Issue, ParsedPage } from '../../types';

class SRIAnalyzer {
  static analyze(parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      externalScripts: number;
      externalStyles: number;
      scriptsWithSRI: number;
      stylesWithSRI: number;
      missingIntegrity: { tag: string; src: string }[];
    } = {
      externalScripts: 0,
      externalStyles: 0,
      scriptsWithSRI: 0,
      stylesWithSRI: 0,
      missingIntegrity: [],
    };

    let pageOrigin: string;
    try {
      pageOrigin = new URL(url).origin;
    } catch {
      return { issues, warnings, info };
    }

    // Check external scripts
    const scripts = parsedPage.querySelectorAll('script[src]');
    for (const script of scripts) {
      const src = script.getAttribute('src') ?? '';
      if (!src || !this.isExternalOrigin(src, pageOrigin)) continue;

      info.externalScripts++;
      if (script.getAttribute('integrity')) {
        info.scriptsWithSRI++;
      } else {
        info.missingIntegrity.push({ tag: 'script', src: this.truncateUrl(src) });
      }
    }

    // Check external stylesheets
    const styles = parsedPage.querySelectorAll('link[rel="stylesheet"][href]');
    for (const style of styles) {
      const href = style.getAttribute('href') ?? '';
      if (!href || !this.isExternalOrigin(href, pageOrigin)) continue;

      info.externalStyles++;
      if (style.getAttribute('integrity')) {
        info.stylesWithSRI++;
      } else {
        info.missingIntegrity.push({ tag: 'stylesheet', src: this.truncateUrl(href) });
      }
    }

    const totalExternal = info.externalScripts + info.externalStyles;
    const totalWithSRI = info.scriptsWithSRI + info.stylesWithSRI;
    const totalMissing = info.missingIntegrity.length;

    if (totalMissing > 0 && info.externalScripts > info.scriptsWithSRI) {
      const examples = info.missingIntegrity
        .filter((m) => m.tag === 'script')
        .slice(0, 3)
        .map((m) => m.src)
        .join(', ');

      issues.push({
        message: 'External scripts missing Subresource Integrity (SRI)',
        detail: `${info.externalScripts - info.scriptsWithSRI} of ${info.externalScripts} external scripts lack integrity attribute. Compromised CDNs could inject malicious code. Examples: ${examples}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (totalMissing > 0 && info.externalStyles > info.stylesWithSRI) {
      const examples = info.missingIntegrity
        .filter((m) => m.tag === 'stylesheet')
        .slice(0, 3)
        .map((m) => m.src)
        .join(', ');

      warnings.push({
        message: 'External stylesheets missing Subresource Integrity (SRI)',
        detail: `${info.externalStyles - info.stylesWithSRI} of ${info.externalStyles} external stylesheets lack integrity attribute. Examples: ${examples}`,
        severity: SEVERITY.LOW,
      });
    }

    if (totalExternal > 0 && totalWithSRI === totalExternal) {
      // All external resources have SRI — no issue
    }

    return { issues, warnings, info };
  }

  private static isExternalOrigin(src: string, pageOrigin: string): boolean {
    try {
      // Protocol-relative or absolute URL
      if (src.startsWith('//')) {
        return !src.startsWith('//' + new URL(pageOrigin).hostname);
      }
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return new URL(src).origin !== pageOrigin;
      }
      // Relative URL — same origin
      return false;
    } catch {
      return false;
    }
  }

  private static truncateUrl(url: string): string {
    try {
      const parsed = new URL(url, 'https://example.com');
      const fileName = parsed.pathname.split('/').pop() ?? parsed.hostname;
      return `${parsed.hostname}/${fileName}`;
    } catch {
      return url.substring(0, 60);
    }
  }
}

export { SRIAnalyzer };
