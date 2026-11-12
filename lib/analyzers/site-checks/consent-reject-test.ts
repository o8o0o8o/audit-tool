/**
 * Consent reject test: opens the homepage in a fresh browser context, clicks
 * the cookie banner's "Reject" button, then visits a second internal page and
 * records network requests and cookies. Trackers that still fire (or tracking
 * cookies that still get set) after an explicit reject are a GDPR/ePrivacy
 * violation.
 *
 * The Browser is injected through minimal structural interfaces so tests can
 * run offline; a Playwright `Browser` satisfies them.
 *
 * No banner / no reject button found ⇒ the check row is 'skipped' with no
 * finding: CookieConsentAnalyzer already reports missing banners.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import type { SiteProbeResult } from './site-checks-types';

// ─── injected browser surface ───────────────────────────────────────────────

export interface ConsentLocator {
  first(): ConsentLocator;
  isVisible(): Promise<boolean>;
  click(opts?: { timeout?: number }): Promise<void>;
}

export interface ConsentFrame {
  locator(selector: string): ConsentLocator;
}

export interface ConsentRequest {
  url(): string;
}

export interface ConsentPage extends ConsentFrame {
  goto(
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(state: 'networkidle', opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: 'request', listener: (req: ConsentRequest) => void): unknown;
  frames(): ConsentFrame[];
  mainFrame(): ConsentFrame;
}

export interface ConsentContext {
  newPage(): Promise<ConsentPage>;
  cookies(): Promise<{ name: string; domain: string }[]>;
  close(): Promise<void>;
}

export interface ConsentBrowser {
  newContext(opts?: { userAgent?: string; locale?: string }): Promise<ConsentContext>;
}

// ─── reject-button detection ────────────────────────────────────────────────

/** Known CMP reject buttons, tried before the text fallback. */
export const CMP_REJECT_SELECTORS: { cmp: string; selector: string }[] = [
  { cmp: 'OneTrust', selector: '#onetrust-reject-all-handler' },
  { cmp: 'Cookiebot', selector: '#CybotCookiebotDialogBodyButtonDecline' },
  { cmp: 'Usercentrics', selector: '[data-testid="uc-deny-all-button"]' },
  { cmp: 'Didomi', selector: '#didomi-notice-disagree-button' },
  { cmp: 'Complianz', selector: '.cmplz-deny' },
  { cmp: 'Quantcast', selector: '.qc-cmp2-summary-buttons button[mode="secondary"]' },
  { cmp: 'Termly', selector: '[data-tid="banner-decline"]' },
  { cmp: 'Iubenda', selector: '.iubenda-cs-reject-btn' },
  { cmp: 'CookieYes', selector: '.cky-btn-reject' },
  { cmp: 'Borlabs', selector: '#BorlabsCookieBox [data-cookie-refuse], a._brlbs-refuse-btn, ._brlbs-refuse' },
];

export const REJECT_TEXTS = [
  'Reject all',
  'Reject',
  'Decline',
  'Decline all',
  'Only necessary',
  'Necessary only',
  'Ablehnen',
  'Alle ablehnen',
  'Refuser',
  'Tout refuser',
  'Rechazar',
  'Rechazar todo',
];

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const REJECT_TEXT_SELECTOR = `:is(button, a, [role="button"]):text-matches("^\\\\s*(?:${REJECT_TEXTS.map(escRe).join('|')})\\\\s*$", "i")`;

async function visible(frame: ConsentFrame, selector: string): Promise<ConsentLocator | null> {
  try {
    const loc = frame.locator(selector).first();
    return (await loc.isVisible()) ? loc : null;
  } catch {
    return null;
  }
}

/** Searches the main frame, then first-level iframes (`frames()` includes them). */
export async function findRejectButton(page: ConsentPage): Promise<{ locator: ConsentLocator; via: string } | null> {
  const main = page.mainFrame();
  const frames = [main, ...page.frames().filter((f) => f !== main)];
  for (const frame of frames) {
    for (const { cmp, selector } of CMP_REJECT_SELECTORS) {
      const loc = await visible(frame, selector);
      if (loc) return { locator: loc, via: cmp };
    }
  }
  for (const frame of frames) {
    const loc = await visible(frame, REJECT_TEXT_SELECTOR);
    if (loc) return { locator: loc, via: 'button text' };
  }
  return null;
}

// ─── tracker classification ─────────────────────────────────────────────────
// CookieConsentAnalyzer does not export its tracker lists, so a compact list
// of the common ad/analytics endpoints lives here.

export const TRACKER_RULES: { vendor: string; test: (u: URL) => boolean }[] = [
  {
    vendor: 'Google Analytics',
    test: (u) =>
      /(^|\.)google-analytics\.com$/.test(u.hostname) ||
      (/(^|\.)(googletagmanager|analytics\.google)\.com$/.test(u.hostname) && /\/(g|j)?\/?collect\b/.test(u.pathname)),
  },
  {
    vendor: 'Google Ads / DoubleClick',
    test: (u) => /(^|\.)(doubleclick\.net|googleadservices\.com)$/.test(u.hostname),
  },
  {
    vendor: 'Meta Pixel',
    test: (u) =>
      u.hostname === 'connect.facebook.net' ||
      (/(^|\.)facebook\.com$/.test(u.hostname) && u.pathname.startsWith('/tr')),
  },
  { vendor: 'TikTok Pixel', test: (u) => /(^|\.)analytics\.tiktok\.com$/.test(u.hostname) },
  { vendor: 'LinkedIn Insight', test: (u) => /(^|\.)(px\.ads\.linkedin\.com|snap\.licdn\.com)$/.test(u.hostname) },
  { vendor: 'Microsoft Ads (UET)', test: (u) => /(^|\.)bat\.bing\.com$/.test(u.hostname) },
  { vendor: 'Hotjar', test: (u) => /(^|\.)hotjar\.(com|io)$/.test(u.hostname) },
  { vendor: 'Microsoft Clarity', test: (u) => /(^|\.)clarity\.ms$/.test(u.hostname) },
  { vendor: 'Segment', test: (u) => /(^|\.)(segment\.io|segment\.com)$/.test(u.hostname) },
  { vendor: 'Mixpanel', test: (u) => /(^|\.)mixpanel\.com$/.test(u.hostname) },
  { vendor: 'Amplitude', test: (u) => /(^|\.)amplitude\.com$/.test(u.hostname) },
  { vendor: 'Criteo', test: (u) => /(^|\.)criteo\.(com|net)$/.test(u.hostname) },
  { vendor: 'Taboola', test: (u) => /(^|\.)taboola\.com$/.test(u.hostname) },
  { vendor: 'Outbrain', test: (u) => /(^|\.)outbrain\.com$/.test(u.hostname) },
  { vendor: 'Pinterest Tag', test: (u) => /(^|\.)ct\.pinterest\.com$/.test(u.hostname) },
];

/**
 * Google Consent Mode "cookieless pings": with consent denied, gtag still sends
 * collect hits but marks them with `gcs=G1x0` (3rd char = analytics_storage, 0 =
 * denied) and sets no cookies. Google documents this as consent-respecting, so
 * these requests are not counted as violations.
 */
export function isConsentModeDeniedPing(u: URL): boolean {
  const gcs = u.searchParams.get('gcs');
  return !!gcs && /^G1[01]0$/.test(gcs);
}

/** Vendor name when the URL is a tracking request that counts as a violation. */
export function trackerVendor(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const rule = TRACKER_RULES.find((r) => r.test(u));
  if (!rule) return null;
  if (isConsentModeDeniedPing(u)) return null;
  return rule.vendor;
}

const TRACKING_COOKIES: { vendor: string; re: RegExp }[] = [
  { vendor: 'Google Analytics', re: /^(_ga|_ga_.+|_gid|_gat.*)$/ },
  { vendor: 'Google Ads / DoubleClick', re: /^(_gcl_au|_gcl_aw|IDE|test_cookie)$/ },
  { vendor: 'Meta Pixel', re: /^(_fbp|_fbc|fr)$/ },
  { vendor: 'Hotjar', re: /^_hj/ },
  { vendor: 'Microsoft Clarity', re: /^(_clck|_clsk|CLID)$/ },
  { vendor: 'Microsoft Ads (UET)', re: /^(_uetsid|_uetvid)$/ },
  { vendor: 'TikTok Pixel', re: /^(_ttp|ttp)$/ },
  { vendor: 'LinkedIn Insight', re: /^(li_.+|bcookie|lidc|UserMatchHistory)$/ },
];

export function trackingCookieVendor(name: string): string | null {
  return TRACKING_COOKIES.find((c) => c.re.test(name))?.vendor ?? null;
}

// ─── verdict ────────────────────────────────────────────────────────────────

export interface RejectObservation {
  requests: string[];
  cookies: { name: string; domain: string }[];
}

export function consentRejectVerdict(obs: RejectObservation, cmp: string): Issue | null {
  const vendors = new Map<string, Set<string>>();
  const add = (vendor: string, evidence: string) => {
    const s = vendors.get(vendor) ?? new Set<string>();
    if (s.size < 3) s.add(evidence);
    vendors.set(vendor, s);
  };
  for (const r of obs.requests) {
    const v = trackerVendor(r);
    if (v) add(v, `request ${r.length > 120 ? `${r.slice(0, 120)}…` : r}`);
  }
  for (const c of obs.cookies) {
    const v = trackingCookieVendor(c.name);
    if (v) add(v, `cookie ${c.name} (${c.domain})`);
  }
  if (!vendors.size) return null;
  const list = [...vendors]
    .map(([v, ev]) => `<strong>${escapeHtml(v)}</strong>: ${escapeHtml([...ev].join(', '))}`)
    .join(' | ');
  return {
    message: 'Trackers still run after consent is rejected',
    detail: `After clicking reject in the cookie banner (${escapeHtml(cmp)}) and opening another page, these trackers still sent requests or set cookies: ${list}. Under GDPR/ePrivacy, non-essential tracking must not run once consent is refused. Make sure tags are gated by the CMP (or Google Consent Mode in advanced mode with denied defaults). Cookieless Consent Mode pings (gcs=G100/G110) are not counted.`,
    severity: SEVERITY.HIGH,
  };
}

// ─── runner ─────────────────────────────────────────────────────────────────

export interface ConsentRejectOptions {
  /** Second internal URL visited after rejecting. Defaults to the homepage again. */
  secondUrl?: string;
  userAgent?: string;
  /** Wait for the CMP to render after load (ms). */
  cmpWaitMs?: number;
}

const skipped = (note: string): SiteProbeResult => ({
  issues: [],
  checks: [{ id: 'consent-reject', label: 'Trackers after consent reject', status: 'skipped', note }],
});

export class ConsentRejectTest {
  static async probe(
    browser: ConsentBrowser,
    homeUrl: string,
    opts: ConsentRejectOptions = {},
  ): Promise<SiteProbeResult> {
    let context: ConsentContext | null = null;
    try {
      context = await browser.newContext({ userAgent: opts.userAgent, locale: 'en-US' });
      const page = await context.newPage();
      const requests: string[] = [];
      let recording = false;
      page.on('request', (req) => {
        if (recording) requests.push(req.url());
      });

      await page.goto(homeUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(opts.cmpWaitMs ?? 2500);
      const button = await findRejectButton(page);
      if (!button) return skipped('no cookie banner reject button found');

      recording = true;
      await button.locator.click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      await page.goto(opts.secondUrl ?? homeUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      const cookies = await context.cookies();

      const issue = consentRejectVerdict({ requests, cookies }, button.via);
      return {
        issues: issue ? [issue] : [],
        checks: [
          {
            id: 'consent-reject',
            label: 'Trackers after consent reject',
            status: issue ? 'fail' : 'pass',
            note: issue ? `trackers active after reject (${button.via})` : `no trackers after reject (${button.via})`,
          },
        ],
      };
    } catch (e) {
      // Navigation / browser failure: never a finding.
      return skipped(`test failed: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
