/**
 * Cross-Origin Policy Analyzer
 * Checks COOP (Cross-Origin-Opener-Policy), COEP (Cross-Origin-Embedder-Policy),
 * and CORP (Cross-Origin-Resource-Policy) headers
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

const VALID_COOP = ['same-origin', 'same-origin-allow-popups', 'unsafe-none'];
const VALID_COEP = ['require-corp', 'credentialless', 'unsafe-none'];
const VALID_CORP = ['same-origin', 'same-site', 'cross-origin'];

class CrossOriginPolicyAnalyzer {
  static analyze(pageData: PageInfo, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      coop: string | null;
      coep: string | null;
      corp: string | null;
      isCrossOriginIsolated: boolean;
      validCoop: boolean;
      validCoep: boolean;
      validCorp: boolean;
    } = {
      coop: null,
      coep: null,
      corp: null,
      isCrossOriginIsolated: false,
      validCoop: true,
      validCoep: true,
      validCorp: true,
    };

    const headers = pageData.responseHeaders ?? {};

    // Extract headers (case-insensitive)
    info.coop = headers['cross-origin-opener-policy'] || headers['Cross-Origin-Opener-Policy'] || null;
    info.coep = headers['cross-origin-embedder-policy'] || headers['Cross-Origin-Embedder-Policy'] || null;
    info.corp = headers['cross-origin-resource-policy'] || headers['Cross-Origin-Resource-Policy'] || null;

    // Clean values (remove reporting directives)
    if (info.coop) info.coop = info.coop.split(';')[0].trim();
    if (info.coep) info.coep = info.coep.split(';')[0].trim();
    if (info.corp) info.corp = info.corp.split(';')[0].trim();

    // Validate values
    if (info.coop && !VALID_COOP.includes(info.coop)) {
      info.validCoop = false;
      warnings.push({
        message: 'Invalid Cross-Origin-Opener-Policy value',
        detail: `COOP value "${info.coop}" is not valid. Expected: ${VALID_COOP.join(', ')}.`,
        severity: SEVERITY.LOW,
      });
    }

    if (info.coep && !VALID_COEP.includes(info.coep)) {
      info.validCoep = false;
      warnings.push({
        message: 'Invalid Cross-Origin-Embedder-Policy value',
        detail: `COEP value "${info.coep}" is not valid. Expected: ${VALID_COEP.join(', ')}.`,
        severity: SEVERITY.LOW,
      });
    }

    if (info.corp && !VALID_CORP.includes(info.corp)) {
      info.validCorp = false;
      warnings.push({
        message: 'Invalid Cross-Origin-Resource-Policy value',
        detail: `CORP value "${info.corp}" is not valid. Expected: ${VALID_CORP.join(', ')}.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check cross-origin isolation (requires both COOP: same-origin and COEP: require-corp/credentialless)
    info.isCrossOriginIsolated =
      info.coop === 'same-origin' && (info.coep === 'require-corp' || info.coep === 'credentialless');

    // Report missing headers
    const missing: string[] = [];
    if (!info.coop) missing.push('Cross-Origin-Opener-Policy');
    if (!info.coep) missing.push('Cross-Origin-Embedder-Policy');

    if (missing.length > 0) {
      warnings.push({
        message: 'Missing cross-origin isolation headers',
        detail: `Missing: ${missing.join(', ')}. These headers protect against Spectre-like attacks and enable high-resolution timers, SharedArrayBuffer.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { CrossOriginPolicyAnalyzer };
