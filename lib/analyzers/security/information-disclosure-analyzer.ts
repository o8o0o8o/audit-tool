/**
 * Information Disclosure Analyzer
 * Detects server version leaks, sensitive headers, exposed source maps,
 * and sensitive information in HTML comments
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo, ParsedPage } from '../../types';

// Headers that leak server information
const DISCLOSURE_HEADERS = [
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-generator',
  'x-drupal-cache',
  'x-drupal-dynamic-cache',
];

// Patterns indicating sensitive content in HTML comments
const SENSITIVE_COMMENT_PATTERNS = [
  /password/i,
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /credentials/i,
  /private[_-]?key/i,
  /auth/i,
  /database/i,
  /mysql|postgres|mongodb/i,
  /internal[_\s-]?url/i,
  /staging|dev[_\s-]?server/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/, // IP addresses
];

class InformationDisclosureAnalyzer {
  static analyze(pageData: PageInfo, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      serverHeader: string | null;
      poweredBy: string | null;
      disclosedHeaders: { name: string; value: string }[];
      sensitiveComments: number;
      hasSourceMaps: boolean;
      sourceMapUrls: string[];
    } = {
      serverHeader: null,
      poweredBy: null,
      disclosedHeaders: [],
      sensitiveComments: 0,
      hasSourceMaps: false,
      sourceMapUrls: [],
    };

    const headers = pageData.responseHeaders || {};

    // 1. Check for server information disclosure in headers
    for (const headerName of DISCLOSURE_HEADERS) {
      const value =
        headers[headerName] ||
        headers[headerName.toLowerCase()] ||
        headers[this.capitalizeHeader(headerName)] ||
        '';

      if (value) {
        info.disclosedHeaders.push({ name: headerName, value });

        if (headerName === 'server') info.serverHeader = value;
        if (headerName === 'x-powered-by') info.poweredBy = value;
      }
    }

    // Check if server header contains version info
    if (info.serverHeader && /\d+\.\d+/.test(info.serverHeader)) {
      issues.push({
        message: 'Server version disclosed in response headers',
        detail: `Server header reveals "${info.serverHeader}". Version information helps attackers target known vulnerabilities. Configure server to omit version details.`,
        severity: SEVERITY.MEDIUM,
      });
    } else if (info.disclosedHeaders.length > 0) {
      const disclosed = info.disclosedHeaders
        .map((h) => `${h.name}: ${h.value}`)
        .join(', ');
      warnings.push({
        message: 'Server technology disclosed in response headers',
        detail: `Headers reveal server technology: ${disclosed}. Consider removing these headers to reduce the attack surface.`,
        severity: SEVERITY.LOW,
      });
    }

    // 2. Check for source map references in scripts
    const scripts = parsedPage.querySelectorAll('script[src]');
    for (const script of scripts) {
      const src = script.getAttribute('src') || '';
      if (src) {
        // Check inline sourceMappingURL comment
        const content = script.textContent || '';
        const mapMatch = content.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/);
        if (mapMatch) {
          info.sourceMapUrls.push(mapMatch[1]);
        }
      }
    }

    // Check inline scripts for source map references
    const inlineScripts = parsedPage.querySelectorAll('script:not([src])');
    for (const script of inlineScripts) {
      const content = script.textContent || '';
      const mapMatch = content.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/);
      if (mapMatch) {
        info.sourceMapUrls.push(mapMatch[1]);
      }
    }

    // Check CSS for source map references
    const styles = parsedPage.querySelectorAll('style');
    for (const style of styles) {
      const content = style.textContent || '';
      const mapMatch = content.match(/\/\*[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*\*\//);
      if (mapMatch) {
        info.sourceMapUrls.push(mapMatch[1]);
      }
    }

    // Also check SourceMap response header
    const sourceMapHeader =
      headers['sourcemap'] || headers['SourceMap'] || headers['x-sourcemap'] || '';
    if (sourceMapHeader) {
      info.sourceMapUrls.push(sourceMapHeader);
    }

    info.hasSourceMaps = info.sourceMapUrls.length > 0;

    if (info.hasSourceMaps) {
      warnings.push({
        message: 'Source maps exposed in production',
        detail: `${info.sourceMapUrls.length} source map reference(s) found. Source maps expose original source code, internal paths, and API endpoints. Remove sourceMappingURL references in production builds.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // 3. Check HTML comments for sensitive information
    const htmlContent = parsedPage.toString();
    const commentRegex = /<!--([\s\S]*?)-->/g;
    let match;
    const sensitiveFindings: string[] = [];

    while ((match = commentRegex.exec(htmlContent)) !== null) {
      const comment = match[1];
      // Skip short comments (likely normal)
      if (comment.length < 5) continue;

      for (const pattern of SENSITIVE_COMMENT_PATTERNS) {
        if (pattern.test(comment)) {
          sensitiveFindings.push(
            comment.trim().substring(0, 50) + (comment.length > 50 ? '...' : ''),
          );
          break;
        }
      }
    }

    info.sensitiveComments = sensitiveFindings.length;

    if (sensitiveFindings.length > 0) {
      issues.push({
        message: 'Potentially sensitive information in HTML comments',
        detail: `${sensitiveFindings.length} HTML comment(s) contain sensitive patterns (passwords, API keys, internal URLs, IP addresses). Review and remove: "${sensitiveFindings[0]}"${sensitiveFindings.length > 1 ? ` and ${sensitiveFindings.length - 1} more` : ''}.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings, info };
  }

  private static capitalizeHeader(header: string): string {
    return header
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('-');
  }
}

export { InformationDisclosureAnalyzer };
