/**
 * Google Consent Mode v2. When Google tags (gtag.js, GTM, Google Ads,
 * DoubleClick) load on a page, Google requires Consent Mode for EEA/UK traffic,
 * and v2 adds the ad_user_data and ad_personalization signals. Consent state
 * is read from dataLayer `consent` commands and from Google's internal consent
 * store (google_tag_data.ics), which CMP integrations through GTM also write.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';

export const GOOGLE_TAG_HOSTS =
  /(?:^|\.)(?:googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net|googlesyndication\.com)$/i;

export interface ConsentState {
  hasGoogleTagGlobal: boolean;
  /** Consent types seen in a `consent default` or `consent update` command or in google_tag_data.ics. */
  consentTypes: string[];
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Runs in the browser. */
function readConsentState(): ConsentState {
  const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const types = new Set<string>();
  try {
    const dl: unknown[] = Array.isArray(w.dataLayer) ? w.dataLayer : [];
    for (const entry of dl) {
      if (typeof entry !== 'object' || entry === null) continue;
      const args = Array.isArray(entry)
        ? entry
        : 'length' in (entry as object)
          ? Array.from(entry as ArrayLike<unknown>)
          : null;
      if (
        args &&
        args[0] === 'consent' &&
        (args[1] === 'default' || args[1] === 'update') &&
        args[2] &&
        typeof args[2] === 'object'
      ) {
        Object.keys(args[2] as object).forEach((k) => types.add(k));
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const entries = w.google_tag_data?.ics?.entries;
    if (entries && typeof entries === 'object') Object.keys(entries).forEach((k) => types.add(k));
  } catch {
    /* ignore */
  }
  return {
    hasGoogleTagGlobal: typeof w.gtag === 'function' || typeof w.google_tag_manager === 'object',
    consentTypes: [...types],
  };
}

export function consentModeIssues(googleTagRequests: number, state: ConsentState): Issue[] {
  if (googleTagRequests === 0 && !state.hasGoogleTagGlobal) return [];
  if (state.consentTypes.length === 0) {
    return [
      {
        message: 'Google tags run without Consent Mode',
        detail:
          'Google Analytics / Ads / GTM tags load, but no Consent Mode default was set. Since March 2024 Google requires Consent Mode v2 for EEA and UK users; without it, conversion and remarketing data from those users is dropped. Set gtag("consent", "default", {...}) before the tags load, or enable your CMP\'s Consent Mode integration.',
        severity: SEVERITY.MEDIUM,
      },
    ];
  }
  const missing = ['ad_user_data', 'ad_personalization'].filter((t) => !state.consentTypes.includes(t));
  if (missing.length) {
    return [
      {
        message: 'Google Consent Mode v2 signals missing',
        detail: `Consent Mode is set (${state.consentTypes.join(', ')}) but without ${missing.join(' and ')}. These v2 signals are required for EEA/UK ad personalisation and audience features. Update the consent default and your CMP integration.`,
        severity: SEVERITY.MEDIUM,
      },
    ];
  }
  return [];
}

export class ConsentModeAnalyzer {
  static async analyze(page: PageLike, requestUrls: Iterable<string>) {
    let googleTagRequests = 0;
    for (const u of requestUrls) {
      try {
        if (GOOGLE_TAG_HOSTS.test(new URL(u).hostname)) googleTagRequests++;
      } catch {
        /* skip */
      }
    }
    let state: ConsentState;
    try {
      state = await page.evaluate(readConsentState);
    } catch {
      return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    }
    return {
      issues: consentModeIssues(googleTagRequests, state),
      warnings: [] as Issue[],
      info: { googleTagRequests, consentTypes: state.consentTypes },
    };
  }
}
