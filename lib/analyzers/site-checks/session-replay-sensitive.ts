/**
 * Session replay on sensitive pages: session-recording scripts (Hotjar,
 * FullStory, Clarity, …) running on pages with password or payment fields can
 * capture what users type unless input masking is configured.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import type { SiteProbeResult } from './site-checks-types';

export const REPLAY_VENDORS: { vendor: string; re: RegExp }[] = [
  { vendor: 'Hotjar', re: /(^|\.)hotjar\.(com|io)$/ },
  { vendor: 'FullStory', re: /(^|\.)(fullstory\.com|fullstory\.net)$/ },
  { vendor: 'Microsoft Clarity', re: /(^|\.)clarity\.ms$/ },
  { vendor: 'LogRocket', re: /(^|\.)(logrocket\.(com|io)|lr-ingest\.(com|io)|lr-in\.com|lr-in-prod\.com)$/ },
  { vendor: 'Smartlook', re: /(^|\.)smartlook\.(com|cloud)$/ },
  { vendor: 'Mouseflow', re: /(^|\.)mouseflow\.com$/ },
  { vendor: 'Quantum Metric', re: /(^|\.)quantummetric\.com$/ },
  { vendor: 'Contentsquare', re: /(^|\.)(contentsquare\.(net|com)|contentsquare\.io)$/ },
  { vendor: 'Inspectlet', re: /(^|\.)inspectlet\.com$/ },
];

/** Replay vendors detected from a page's request URLs or hostnames. */
export function detectReplayVendors(requestUrlsOrHosts: string[]): string[] {
  const found = new Set<string>();
  for (const r of requestUrlsOrHosts) {
    let host = r;
    try {
      host = new URL(r).hostname;
    } catch {
      /* already a host */
    }
    host = host.toLowerCase();
    for (const v of REPLAY_VENDORS) if (v.re.test(host)) found.add(v.vendor);
  }
  return [...found];
}

export interface SensitiveFields {
  hasPasswordField: boolean;
  hasPaymentField: boolean;
}

export interface ReplayPageInput extends SensitiveFields {
  url: string;
  replayVendors: string[];
}

/** Minimal page surface (Playwright `Page` satisfies it). */
export interface EvaluatablePage {
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
}

/**
 * Browser-side extractor. Payment field = autocomplete cc-*, an input whose
 * name/id mentions card number / cvc, or an iframe from Stripe / Adyen /
 * Braintree (hosted fields).
 */
export async function extractSensitiveFields(page: EvaluatablePage): Promise<SensitiveFields> {
  try {
    return await page.evaluate(() => {
      const hasPasswordField = !!document.querySelector('input[type="password"]');
      const ccInput = document.querySelector(
        'input[autocomplete^="cc-"], input[name*="card" i], input[id*="cardnumber" i], input[name*="cvc" i], input[name*="cvv" i]',
      );
      const payFrame = Array.from(document.querySelectorAll('iframe')).some((f) =>
        /(^|\.)(stripe\.com|adyen\.com|braintreegateway\.com|braintree-api\.com)$/i.test(
          (() => {
            try {
              return new URL(f.src, location.href).hostname;
            } catch {
              return '';
            }
          })(),
        ),
      );
      return { hasPasswordField, hasPaymentField: !!ccInput || payFrame };
    });
  } catch {
    return { hasPasswordField: false, hasPaymentField: false };
  }
}

export function sessionReplaySensitiveIssues(pages: ReplayPageInput[]): Issue[] {
  const hits = pages.filter((p) => p.replayVendors.length && (p.hasPasswordField || p.hasPaymentField));
  if (!hits.length) return [];
  const vendors = [...new Set(hits.flatMap((p) => p.replayVendors))];
  const examples = hits
    .slice(0, 5)
    .map(
      (p) =>
        `<a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a> (${escapeHtml(
          [p.hasPasswordField && 'password', p.hasPaymentField && 'payment'].filter(Boolean).join(' + '),
        )} field; ${escapeHtml(p.replayVendors.join(', '))})`,
    )
    .join(', ');
  return [
    {
      message: 'Session replay runs on pages with password or payment fields',
      detail: `${escapeHtml(vendors.join(', '))} session recording runs on ${hits.length} page(s) with password or payment inputs, e.g. ${examples}. Confirm that input masking is enabled for these fields (or exclude these pages from recording) so credentials and card data are never captured.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

export class SessionReplaySensitive {
  static analyze(pages: ReplayPageInput[]): SiteProbeResult {
    const issues = sessionReplaySensitiveIssues(pages);
    const sensitive = pages.filter((p) => p.hasPasswordField || p.hasPaymentField).length;
    return {
      issues,
      checks: [
        {
          id: 'session-replay-sensitive',
          label: 'Session replay on sensitive pages',
          status: sensitive === 0 ? 'skipped' : issues.length ? 'warn' : 'pass',
          note:
            sensitive === 0
              ? 'no pages with password or payment fields'
              : issues.length
                ? 'session replay runs on sensitive pages'
                : `${sensitive} sensitive page(s), no session replay`,
        },
      ],
    };
  }
}
