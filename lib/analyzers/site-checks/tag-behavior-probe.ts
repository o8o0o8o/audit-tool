/**
 * Browser-driven tag checks, run once post-crawl in a fresh headless context:
 *
 * - Single-page apps: after a client-side navigation (link click without a
 *   full reload) GA4 must send a new page_view; otherwise every SPA route
 *   after the landing page is invisible in analytics.
 * - Cross-domain tracking: links to the brand's other domains (shop,
 *   checkout, booking) should get the GA4 `_gl` linker parameter on click;
 *   without it sessions break and conversions show up as referrals.
 *
 * Both only run when GA4 hits are seen on the page, and the linker check
 * only when analytics consent is not denied (the linker stays off then).
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';
import { decodeGa4Events, type TagRequest } from '../analytics/tag-runtime-analyzer';
import { orgDomain, type SiteCheckResult, type SiteProbeResult } from './site-checks-types';

interface ProbeRequest {
  url(): string;
  postData(): string | null;
}

export interface ProbePage {
  goto(url: string, opts?: { waitUntil?: 'load'; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  url(): string;
  on(event: 'request', fn: (r: ProbeRequest) => void): unknown;
}

export interface ProbeBrowser {
  newContext(opts?: { userAgent?: string }): Promise<{ newPage(): Promise<ProbePage>; close(): Promise<void> }>;
}

/** Hosts that look like the same brand on another registrable domain (e.g. example.com → shop-example.de). */
export function brandSiblingHosts(siteHost: string, hosts: Iterable<string>): string[] {
  const org = orgDomain(siteHost);
  const label = org.split('.')[0];
  if (label.length < 4) return [];
  const out = new Set<string>();
  for (const h of hosts) {
    const lower = h.toLowerCase();
    if (orgDomain(lower) === org) continue;
    if (orgDomain(lower).split('.')[0].includes(label)) out.add(lower);
  }
  return [...out];
}

/** Analytics consent state from a GA4 hit's gcs param: G1x1 / G111 granted, G1x0 denied. */
export function analyticsConsentDenied(gcs: string | undefined): boolean {
  return !!gcs && /^G1.0$/.test(gcs);
}

export function linkerVerdict(results: Array<{ href: string; decorated: string }>): Issue[] {
  const missing = results.filter((r) => !/[?&#]_gl=/.test(r.decorated));
  if (!missing.length) return [];
  return [
    {
      message: 'Cross-domain links lack GA4 linker parameter',
      detail: `Links to the brand's other domains get no <code>_gl</code> parameter on click: ${missing
        .slice(0, 3)
        .map((r) => escapeHtml(r.href))
        .join(
          ', ',
        )}. Visitors start a new session there and conversions are credited to "referral". Add these domains to the GA4 cross-domain configuration (Admin → Data streams → Configure tag settings → Configure your domains).`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

export function spaVerdict(navigatedTo: string, newPageViews: number): Issue[] {
  if (newPageViews > 0) return [];
  return [
    {
      message: 'Client-side navigation sends no page_view',
      detail: `After navigating to ${escapeHtml(navigatedTo)} without a page reload, no GA4 page_view was sent. Every route after the landing page is missing from analytics. Enable "Page changes based on browser history events" in GA4 enhanced measurement or send page_view on route change.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

export class TagBehaviorProbe {
  static async probe(
    browser: ProbeBrowser,
    homeUrl: string,
    opts: { userAgent?: string } = {},
  ): Promise<SiteProbeResult> {
    const issues: Issue[] = [];
    const checks: SiteCheckResult[] = [];
    const ctx = await browser.newContext({ userAgent: opts.userAgent });
    try {
      const page = await ctx.newPage();
      const hits: Record<string, TagRequest> = {};
      page.on('request', (r) => {
        if (/\/g\/collect\b/.test(r.url()))
          hits[`${r.url()}#${Object.keys(hits).length}`] = { postData: r.postData() ?? undefined };
      });
      await page.goto(homeUrl, { waitUntil: 'load', timeout: 30000 });
      // gtag batches repeat hits to the same property for ~5 s, so a duplicate
      // page_view from a second config call only shows up this late.
      await page.waitForTimeout(6000);
      const initial = decodeGa4Events(hits);
      if (!initial.length) {
        const note = 'no GA4 hits on the homepage';
        checks.push({ id: 'ga4-linker', label: 'Cross-domain linker', status: 'skipped', note });
        checks.push({ id: 'spa-pageview', label: 'SPA page views', status: 'skipped', note });
        return { issues, checks };
      }

      const views: Record<string, number> = {};
      initial.filter((e) => e.en === 'page_view').forEach((e) => (views[e.tid] = (views[e.tid] ?? 0) + 1));
      const dupes = Object.entries(views).filter(([, n]) => n > 1);
      if (dupes.length) {
        issues.push({
          message: 'Duplicate GA4 page_view on page load',
          detail: `On ${escapeHtml(homeUrl)}, ${dupes.map(([t, n]) => `${escapeHtml(t)} received ${n} page_view hits`).join('; ')} within 6 s of one load (often a second gtag config call, or gtag.js plus a GA4 tag in GTM). Page views and sessions are inflated.`,
          severity: SEVERITY.HIGH,
        });
      }

      // Cross-domain linker
      const siteHost = new URL(homeUrl).hostname;
      const anchors = await page.evaluate(
        () => Array.from(document.querySelectorAll('a[href^="http"]')).map((a) => (a as HTMLAnchorElement).href),
        undefined,
      );
      const siblings = brandSiblingHosts(
        siteHost,
        anchors.map((a) => new URL(a).hostname),
      );
      if (analyticsConsentDenied(initial[0].params.gcs)) {
        checks.push({
          id: 'ga4-linker',
          label: 'Cross-domain linker',
          status: 'skipped',
          note: 'analytics consent denied by default',
        });
      } else if (!siblings.length) {
        checks.push({
          id: 'ga4-linker',
          label: 'Cross-domain linker',
          status: 'pass',
          note: 'no links to sibling brand domains',
        });
      } else {
        const results = await page.evaluate((hosts: string[]) => {
          const out: Array<{ href: string; decorated: string }> = [];
          for (const a of Array.from(document.querySelectorAll('a[href^="http"]')) as HTMLAnchorElement[]) {
            if (out.length >= 3) break;
            if (!hosts.includes(a.hostname.toLowerCase())) continue;
            const before = a.href;
            // The GA4 linker decorates on mousedown / keyup; dispatch without navigating.
            a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            out.push({ href: before, decorated: a.href });
          }
          return out;
        }, siblings);
        const found = linkerVerdict(results);
        issues.push(...found);
        checks.push({
          id: 'ga4-linker',
          label: 'Cross-domain linker',
          status: found.length ? 'fail' : 'pass',
          note: `${results.length} sibling-domain link${results.length === 1 ? '' : 's'} tested`,
        });
      }

      // SPA virtual page views
      const target = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const spa = !!(
          w.__NEXT_DATA__ ||
          w.next ||
          w.__NUXT__ ||
          w.___gatsby ||
          document.querySelector('[data-reactroot], #__next, #___gatsby, [ng-version], #app[data-v-app]')
        );
        if (!spa) return null;
        w.__seoAuditMarker = 1;
        const here = location.href.split('#')[0];
        const a = Array.from(document.querySelectorAll('a[href]')).find((el) => {
          const link = el as HTMLAnchorElement;
          return (
            link.origin === location.origin &&
            link.href.split('#')[0] !== here &&
            !link.target &&
            !link.hasAttribute('download')
          );
        }) as HTMLAnchorElement | undefined;
        if (!a) return null;
        a.click();
        return a.href;
      }, undefined);
      if (!target) {
        checks.push({ id: 'spa-pageview', label: 'SPA page views', status: 'skipped', note: 'not a single-page app' });
      } else {
        const before = Object.keys(hits).length;
        await page.waitForTimeout(3000);
        const softNav = await page
          .evaluate(() => (window as unknown as Record<string, unknown>).__seoAuditMarker === 1, undefined)
          .catch(() => false);
        if (!softNav || page.url() === homeUrl) {
          checks.push({
            id: 'spa-pageview',
            label: 'SPA page views',
            status: 'skipped',
            note: 'link caused a full page load',
          });
        } else {
          const after = Object.fromEntries(Object.entries(hits).slice(before));
          const views = decodeGa4Events(after).filter((e) => e.en === 'page_view').length;
          const found = spaVerdict(page.url(), views);
          issues.push(...found);
          checks.push({
            id: 'spa-pageview',
            label: 'SPA page views',
            status: found.length ? 'fail' : 'pass',
            note: `${views} page_view after client-side navigation`,
          });
        }
      }
      return { issues, checks };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
}
