/**
 * CSP Quality Analyzer
 * Evaluates Content-Security-Policy quality beyond just header presence.
 * Flags dangerous directives like unsafe-inline, unsafe-eval, and wildcard sources.
 */

import { SEVERITY } from '../../constants';
import { clampScore, getHeader } from '../../utils';
import type { Issue, PageInfo } from '../../types';

// Dangerous directive values
const _DANGEROUS_SOURCES = ["'unsafe-inline'", "'unsafe-eval'", '*', 'data:', 'blob:'];
const SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem', 'script-src-attr'];

class CSPQualityAnalyzer {
  static analyze(pageData: PageInfo, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      hasCSP: boolean;
      hasReportOnly: boolean;
      directives: Record<string, string[]>;
      dangerousDirectives: { directive: string; value: string; reason: string }[];
      missingDirectives: string[];
      score: number;
    } = {
      hasCSP: false,
      hasReportOnly: false,
      directives: {},
      dangerousDirectives: [],
      missingDirectives: [],
      score: 0,
    };

    const headers = pageData.responseHeaders ?? {};

    const cspHeader = getHeader(headers, 'content-security-policy') ?? '';
    const cspReportOnly = getHeader(headers, 'content-security-policy-report-only') ?? '';

    info.hasCSP = cspHeader.length > 0;
    info.hasReportOnly = cspReportOnly.length > 0;

    if (!info.hasCSP) {
      // The basic security-analyzer already flags missing CSP header
      return { issues, warnings, info };
    }

    // Parse CSP directives
    info.directives = this.parseCSP(cspHeader);

    // Score starts at 100
    let score = 100;

    // Check for default-src
    if (!info.directives['default-src']) {
      info.missingDirectives.push('default-src');
      score -= 20;
    }

    // Check for frame-ancestors (clickjacking protection)
    if (!info.directives['frame-ancestors']) {
      info.missingDirectives.push('frame-ancestors');
      score -= 10;
    }

    // Check for base-uri (prevents base tag injection)
    if (!info.directives['base-uri']) {
      info.missingDirectives.push('base-uri');
      score -= 5;
    }

    // Check for form-action
    if (!info.directives['form-action']) {
      info.missingDirectives.push('form-action');
      score -= 5;
    }

    // Check for dangerous values in script-related directives
    for (const directive of SCRIPT_DIRECTIVES) {
      const values = info.directives[directive] || info.directives['default-src'] || [];
      for (const value of values) {
        if (value === "'unsafe-inline'") {
          info.dangerousDirectives.push({
            directive,
            value,
            reason: 'Allows inline script execution, defeating XSS protection',
          });
          score -= 25;
        }
        if (value === "'unsafe-eval'") {
          info.dangerousDirectives.push({
            directive,
            value,
            reason: 'Allows eval() and similar dynamic code execution',
          });
          score -= 20;
        }
        if (value === '*') {
          info.dangerousDirectives.push({
            directive,
            value,
            reason: 'Allows scripts from any origin',
          });
          score -= 30;
        }
      }
    }

    // Check for wildcard in default-src
    const defaultSrc = info.directives['default-src'] || [];
    if (defaultSrc.includes('*')) {
      info.dangerousDirectives.push({
        directive: 'default-src',
        value: '*',
        reason: 'Wildcard default-src allows loading resources from any origin',
      });
      score -= 30;
    }

    // Check for data: in script-src
    for (const directive of SCRIPT_DIRECTIVES) {
      const values = info.directives[directive] || [];
      if (values.includes('data:')) {
        info.dangerousDirectives.push({
          directive,
          value: 'data:',
          reason: 'data: URIs in script-src allow injecting arbitrary scripts',
        });
        score -= 15;
      }
    }

    info.score = clampScore(score);

    // Report issues
    if (info.dangerousDirectives.length > 0) {
      const examples = info.dangerousDirectives
        .slice(0, 3)
        .map((d) => `${d.directive}: ${d.value}`)
        .join(', ');

      issues.push({
        message: 'Weak Content-Security-Policy directives',
        detail: `CSP contains ${info.dangerousDirectives.length} dangerous directive(s): ${examples}. ${info.dangerousDirectives[0].reason}.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (info.missingDirectives.length > 0) {
      warnings.push({
        message: 'Content-Security-Policy missing recommended directives',
        detail: `Missing: ${info.missingDirectives.join(', ')}. These directives provide additional protection against XSS, clickjacking, and code injection.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  private static parseCSP(header: string): Record<string, string[]> {
    const directives: Record<string, string[]> = {};
    const parts = header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);

    for (const part of parts) {
      const tokens = part.split(/\s+/);
      const name = tokens[0];
      const values = tokens.slice(1);
      directives[name] = values;
    }

    return directives;
  }
}

export { CSPQualityAnalyzer };
