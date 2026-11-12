/**
 * Form health: forms that post over plain HTTP from an HTTPS page, forms that
 * send credentials / email addresses to an unrelated third-party domain, and
 * CAPTCHA widgets whose script failed to load (the form then cannot be sent).
 * Reads the rendered DOM and the request log only; never submits a form.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';
import { orgDomain } from '../site-checks/site-checks-types';

export const INSECURE_FORM_MESSAGE = 'Form submits over insecure HTTP';
export const THIRD_PARTY_FORM_MESSAGE = 'Form submits data to a third-party domain';
export const CAPTCHA_FAILED_MESSAGE = 'CAPTCHA failed to load; form cannot be submitted';

/** Minimal request-log entry (RequestInfo-compatible). `failed` = requestfailed / no response. */
export interface FormRequestInfo {
  status?: number;
  failed?: boolean;
}

export interface FormInfo {
  action: string; // absolute, '' when unresolvable
  method: string;
  sensitive: boolean; // has password or email input
}

export interface CaptchaWidget {
  kind: 'recaptcha' | 'hcaptcha' | 'turnstile';
}

/** Known hosted form / auth providers (org domains). */
export const FORM_PROVIDER_DOMAINS = new Set([
  'hubspot.com',
  'hsforms.com',
  'hsforms.net',
  'hs-sites.com',
  'typeform.com',
  'list-manage.com',
  'mailchimp.com',
  'salesforce.com',
  'force.com',
  'pardot.com',
  'marketo.com',
  'mktoweb.com',
  'marketo.net',
  'google.com',
  'formspree.io',
  'netlify.com',
  'netlify.app',
  'auth0.com',
  'okta.com',
  'oktapreview.com',
  'amazoncognito.com',
  'amazonaws.com',
  'jotform.com',
  'wufoo.com',
  'formstack.com',
  'zoho.com',
  'paypal.com',
  'stripe.com',
]);

const CAPTCHA_SCRIPT: Record<CaptchaWidget['kind'], RegExp> = {
  recaptcha: /(?:google\.com|gstatic\.com|recaptcha\.net)\/recaptcha\//i,
  hcaptcha: /(?:^|\/\/|\.)hcaptcha\.com\//i,
  turnstile: /challenges\.cloudflare\.com\/turnstile\//i,
};

export function extractForms(html: string, pageUrl: string): { forms: FormInfo[]; captchas: CaptchaWidget[] } {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const forms: FormInfo[] = [];
  for (const f of root.querySelectorAll('form')) {
    const raw = (f.getAttribute('action') ?? '').trim();
    let action: string;
    try {
      action = raw && !/^(javascript|mailto|data):/i.test(raw) ? new URL(raw, pageUrl).href : raw ? '' : pageUrl;
    } catch {
      action = '';
    }
    forms.push({
      action,
      method: (f.getAttribute('method') ?? 'get').toLowerCase(),
      sensitive: f
        .querySelectorAll('input')
        .some((i: HTMLElement) => /^(password|email)$/i.test(i.getAttribute('type') ?? '')),
    });
  }
  const captchas: CaptchaWidget[] = [];
  if (root.querySelector('.g-recaptcha, [data-sitekey].g-recaptcha, iframe[src*="recaptcha"]'))
    captchas.push({ kind: 'recaptcha' });
  if (root.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')) captchas.push({ kind: 'hcaptcha' });
  if (root.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'))
    captchas.push({ kind: 'turnstile' });
  return { forms, captchas };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/** Pure decision on extracted forms + request log. */
export function formHealthIssues(
  pageUrl: string,
  forms: FormInfo[],
  captchas: CaptchaWidget[],
  requests: Record<string, FormRequestInfo>,
): Issue[] {
  const issues: Issue[] = [];
  const pageHttps = pageUrl.startsWith('https:');
  const pageOrg = orgDomain(hostOf(pageUrl));

  const insecure = [...new Set(forms.filter((f) => pageHttps && f.action.startsWith('http:')).map((f) => f.action))];
  if (insecure.length > 0) {
    issues.push({
      message: INSECURE_FORM_MESSAGE,
      detail: `This HTTPS page has ${insecure.length} form(s) posting to plain HTTP: ${insecure.slice(0, 3).map(escapeHtml).join(', ')}. Browsers warn before sending, and the submitted data travels unencrypted. Change the form action to https://.`,
      severity: SEVERITY.HIGH,
    });
  }

  const thirdParty = [
    ...new Set(
      forms
        .filter((f) => f.sensitive && f.action)
        .map((f) => hostOf(f.action))
        .filter((h) => h && orgDomain(h) !== pageOrg && !FORM_PROVIDER_DOMAINS.has(orgDomain(h))),
    ),
  ];
  if (thirdParty.length > 0) {
    issues.push({
      message: THIRD_PARTY_FORM_MESSAGE,
      detail: `A form with a password or email field submits to ${thirdParty.slice(0, 3).map(escapeHtml).join(', ')}, a different domain that is not a known form or login provider. Confirm this endpoint is yours or a trusted processor (and covered by the privacy policy); an unexpected action can also indicate injected markup.`,
      severity: SEVERITY.MEDIUM,
    });
  }

  const broken: string[] = [];
  for (const { kind } of captchas) {
    const scripts = Object.entries(requests).filter(([u]) => CAPTCHA_SCRIPT[kind].test(u));
    // Never requested = often lazy-loaded on form focus; not evidence of failure.
    if (scripts.length === 0) continue;
    const ok = scripts.some(([, r]) => !r.failed && r.status !== undefined && r.status > 0 && r.status < 400);
    if (!ok) {
      const st = scripts.map(([, r]) => (r.failed || !r.status ? 'failed' : String(r.status))).join(', ');
      broken.push(`${kind} (script ${st})`);
    }
  }
  if (broken.length > 0) {
    issues.push({
      message: CAPTCHA_FAILED_MESSAGE,
      detail: `A CAPTCHA widget is on the page but its script did not load: ${broken.map(escapeHtml).join('; ')}. Without it the CAPTCHA never renders a token and the form cannot be submitted. Check Content-Security-Policy, ad/consent blocking of the CAPTCHA domain and the site key.`,
      severity: SEVERITY.HIGH,
    });
  }
  return issues;
}

export class FormHealthAnalyzer {
  static analyze(renderedHtml: string | undefined, pageUrl: string, requests: Record<string, FormRequestInfo>) {
    if (!renderedHtml) return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    try {
      const { forms, captchas } = extractForms(renderedHtml, pageUrl);
      return {
        issues: formHealthIssues(pageUrl, forms, captchas, requests),
        warnings: [] as Issue[],
        info: { forms: forms.length, captchas: captchas.map((c) => c.kind) },
      };
    } catch {
      return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    }
  }
}
