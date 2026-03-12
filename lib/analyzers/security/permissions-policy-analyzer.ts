/**
 * Permissions-Policy Analyzer
 * Checks for Permissions-Policy (and legacy Feature-Policy) header
 * and evaluates policy quality
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

// Sensitive features that should be restricted
const SENSITIVE_FEATURES = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'bluetooth',
  'serial',
  'hid',
  'midi',
  'magnetometer',
  'gyroscope',
  'accelerometer',
];

class PermissionsPolicyAnalyzer {
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      hasPermissionsPolicy: boolean;
      hasFeaturePolicy: boolean;
      directives: Record<string, string>;
      overpermissive: string[];
      restricted: string[];
    } = {
      hasPermissionsPolicy: false,
      hasFeaturePolicy: false,
      directives: {},
      overpermissive: [],
      restricted: [],
    };

    const headers = pageData.responseHeaders || {};

    // Check both Permissions-Policy and legacy Feature-Policy
    const ppHeader =
      headers['permissions-policy'] || headers['Permissions-Policy'] || '';
    const fpHeader =
      headers['feature-policy'] || headers['Feature-Policy'] || '';

    info.hasPermissionsPolicy = ppHeader.length > 0;
    info.hasFeaturePolicy = fpHeader.length > 0;

    if (!info.hasPermissionsPolicy && !info.hasFeaturePolicy) {
      issues.push({
        message: 'Missing Permissions-Policy header',
        detail:
          'No Permissions-Policy header found. This header controls which browser features (camera, microphone, geolocation, payment) the page can use. Add it to restrict unnecessary API access.',
        severity: SEVERITY.MEDIUM,
      });
      return { issues, warnings, info };
    }

    // Parse Permissions-Policy (format: feature=(allowlist), feature=())
    const policyString = ppHeader || fpHeader;
    const directives = this.parsePolicy(policyString, info.hasPermissionsPolicy);
    info.directives = directives;

    // Check for overpermissive directives
    for (const feature of SENSITIVE_FEATURES) {
      const value = directives[feature];
      if (value === '*' || value === undefined) {
        // Feature either explicitly allows all or isn't restricted
        if (value === '*') {
          info.overpermissive.push(feature);
        }
      } else if (value === '()' || value === "'none'" || value === 'none') {
        info.restricted.push(feature);
      }
    }

    if (info.overpermissive.length > 0) {
      warnings.push({
        message: 'Overpermissive Permissions-Policy directives',
        detail: `${info.overpermissive.length} sensitive features allow all origins: ${info.overpermissive.join(', ')}. Consider restricting to self or specific origins.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  private static parsePolicy(
    header: string,
    isPermissionsPolicy: boolean,
  ): Record<string, string> {
    const directives: Record<string, string> = {};

    if (isPermissionsPolicy) {
      // Permissions-Policy format: camera=(), geolocation=(self), payment=*
      const parts = header.split(',').map((p) => p.trim());
      for (const part of parts) {
        const eqIndex = part.indexOf('=');
        if (eqIndex > -1) {
          const feature = part.substring(0, eqIndex).trim();
          const value = part.substring(eqIndex + 1).trim();
          directives[feature] = value;
        }
      }
    } else {
      // Feature-Policy format: camera 'none'; geolocation 'self'
      const parts = header.split(';').map((p) => p.trim());
      for (const part of parts) {
        const [feature, ...valueParts] = part.split(/\s+/);
        if (feature) {
          directives[feature] = valueParts.join(' ') || '*';
        }
      }
    }

    return directives;
  }
}

export { PermissionsPolicyAnalyzer };
