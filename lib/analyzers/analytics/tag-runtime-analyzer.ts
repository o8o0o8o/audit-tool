/**
 * Runtime tag checks: what Google Analytics / GTM / Meta Pixel actually send
 * during the page load, decoded from the crawler's network log (GA4
 * `/g/collect` hits incl. batched POST bodies, Meta `facebook.com/tr`), plus
 * served-HTML and dataLayer checks:
 *
 * - GTM / gtag.js script failed to load; GA4 hits failing (incl. server-side tagging endpoints)
 * - GA4 installed but no hit sent; hits to a property not referenced on the page;
 *   page views to several properties; duplicate page_view on load
 * - GA4 debug mode in production; personal data (emails, credentials) in hits
 * - duplicate Meta Pixel PageView
 * - dataLayer overwritten after GTM loads; consent default set after tags start
 * - internal links carrying utm_ parameters
 * - product pages without a view_item event
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';
import { orgDomain } from '../site-checks/site-checks-types';

export interface TagRequest {
  status?: number;
  failed?: boolean;
  postData?: string;
  resourceType?: string;
}

export interface Ga4Event {
  tid: string;
  en: string;
  dl?: string;
  host: string;
  params: Record<string, string>;
}

/** Per-page summary persisted on pageData.tagRuntime for the site-level report table. */
export interface TagRuntimeInfo {
  ga4Ids: string[];
  pageViews: number;
  hits: number;
  metaPixelIds: string[];
  gtmIds: string[];
}

const GA4_PATH = /\/g\/collect\b/;
const GOOGLE_HOSTS =
  /(?:^|\.)(?:google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net)$/i;

function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Decodes every GA4 event in the request log (URL params merged with each POST body line). */
export function decodeGa4Events(requests: Record<string, TagRequest>): Ga4Event[] {
  const events: Ga4Event[] = [];
  for (const [url, r] of Object.entries(requests)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (!GA4_PATH.test(u.pathname)) continue;
    const base = parseQuery(u.search.slice(1));
    if (!/^G-[A-Z0-9]+$/i.test(base.tid ?? '')) continue;
    const lines = (r.postData ?? '').split(/\r?\n/).filter((l) => l.trim());
    const bodies = lines.length ? lines.map(parseQuery) : [{}];
    for (const body of bodies) {
      const params = { ...base, ...body };
      if (!params.en) continue;
      events.push({ tid: params.tid, en: params.en, dl: params.dl, host: u.hostname, params });
    }
  }
  return events;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SECRET_KEYS =
  /(?:^|[?&#;])(?:e-?mail|password|passwd|pwd|token|access_token|auth|session|ssn|phone|tel)=([^&#]+)/i;

function maskEmail(s: string): string {
  return s.replace(new RegExp(EMAIL.source, 'gi'), (m) => `${m.slice(0, 2)}***@${m.split('@')[1]}`);
}

/** Returns the first personal-data hit in an event, or null. */
export function findPii(e: Ga4Event): { field: string; sample: string } | null {
  for (const [k, v] of Object.entries(e.params)) {
    if (!v || k === 'tid' || k === 'cid' || k === 'sid') continue;
    if (EMAIL.test(v)) return { field: k, sample: maskEmail(v).slice(0, 120) };
    if ((k === 'dl' || k === 'dr' || k === 'dp' || k.startsWith('ep.page')) && SECRET_KEYS.test(v)) {
      const key =
        SECRET_KEYS.exec(v)?.[0]
          .replace(/^[?&#;]/, '')
          .split('=')[0] ?? '';
      return { field: k, sample: `${key}=…` };
    }
  }
  return null;
}

export interface TagPageInput {
  url: string;
  requests: Record<string, TagRequest>;
  /** GA4 / GTM IDs found in the page HTML (analytics-tracking-analyzer). */
  htmlGa4Ids: string[];
  htmlGtmIds: string[];
  servedHtml?: string;
  /** Internal anchors on the page (absolute URLs). */
  anchors: string[];
  hasProductSchema: boolean;
  consentToolDetected: boolean;
  /** dataLayer snapshot facts read in the browser. */
  dataLayer?: DataLayerFacts;
}

export interface DataLayerFacts {
  consentDefaultIndex: number;
  firstTagIndex: number;
  hasViewItem: boolean;
}

/** Runs in the browser: positions of consent default vs first config / gtm.js event, and ecommerce events. */
export function readDataLayerFacts(): DataLayerFacts {
  const w = window as unknown as { dataLayer?: unknown[] };
  const dl = Array.isArray(w.dataLayer) ? w.dataLayer : [];
  let consentDefaultIndex = -1;
  let firstTagIndex = -1;
  let hasViewItem = false;
  dl.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const args = Array.isArray(entry)
      ? entry
      : 'length' in (entry as object) && typeof (entry as { length: unknown }).length === 'number'
        ? Array.from(entry as ArrayLike<unknown>)
        : null;
    if (args) {
      if (args[0] === 'consent' && args[1] === 'default' && consentDefaultIndex < 0) consentDefaultIndex = i;
      if ((args[0] === 'config' || args[0] === 'event') && firstTagIndex < 0) firstTagIndex = i;
      if (args[0] === 'event' && args[1] === 'view_item') hasViewItem = true;
      return;
    }
    const ev = (entry as { event?: unknown }).event;
    if (ev === 'gtm.js' && firstTagIndex < 0) firstTagIndex = i;
    if (
      ev === 'view_item' ||
      ev === 'productDetail' ||
      (entry as { ecommerce?: { detail?: unknown } }).ecommerce?.detail
    )
      hasViewItem = true;
  });
  return { consentDefaultIndex, firstTagIndex, hasViewItem };
}

const link = (u: string) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`;

/** `dataLayer = [...]` (not `|| []`) written after the GTM snippet in the served HTML. */
export function dataLayerOverwrittenAfterGtm(html: string): boolean {
  const gtm = html.search(/googletagmanager\.com\/gtm\.js|gtm\.start/);
  if (gtm < 0) return false;
  const after = html.slice(gtm);
  return /(?:^|[\s;{(,>])(?:window\.)?dataLayer\s*=\s*\[/m.test(after);
}

export function tagRuntimeIssues(input: TagPageInput): { issues: Issue[]; info: TagRuntimeInfo } {
  const issues: Issue[] = [];
  const events = decodeGa4Events(input.requests);
  const ga4Ids = [...new Set(events.map((e) => e.tid.toUpperCase()))];
  const pageViews = events.filter((e) => e.en === 'page_view');
  const pageHost = (() => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return '';
    }
  })();

  // Script / hit delivery
  const failedScripts: string[] = [];
  const failedHits: string[] = [];
  const metaHits: Record<string, number> = {};
  for (const [url, r] of Object.entries(input.requests)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    // Beacon/keepalive hits often report ERR_ABORTED after a 2xx response: only
    // count a failure when no response status arrived.
    const bad = (r.failed === true && !r.status) || (r.status ?? 0) >= 400;
    if (/googletagmanager\.com$/i.test(u.hostname) && /\/(?:gtm\.js|gtag\/js)$/.test(u.pathname) && bad)
      failedScripts.push(url);
    if (GA4_PATH.test(u.pathname) && bad) failedHits.push(u.origin + u.pathname);
    if (
      /(?:^|\.)facebook\.com$/i.test(u.hostname) &&
      /^\/tr\/?$/.test(u.pathname) &&
      /(?:^|&)ev=PageView(?:&|$)/.test(u.search.slice(1))
    ) {
      const id = u.searchParams.get('id') ?? '?';
      metaHits[id] = (metaHits[id] ?? 0) + 1;
    }
  }
  if (failedScripts.length) {
    issues.push({
      message: 'Google tag script failed to load',
      detail: `${failedScripts.map(link).join(', ')} failed or returned an error, so no tags in it run on this page. Check that the container/tag ID is published and not blocked by the Content-Security-Policy.`,
      severity: SEVERITY.HIGH,
    });
  }
  if (failedHits.length) {
    const firstParty = failedHits.filter((h) => {
      try {
        return !GOOGLE_HOSTS.test(new URL(h).hostname);
      } catch {
        return false;
      }
    });
    issues.push({
      message: firstParty.length ? 'Server-side tagging endpoint returns errors' : 'Google Analytics hits fail to send',
      detail: `${[...new Set(failedHits)].slice(0, 3).map(escapeHtml).join(', ')} failed or returned an error; these events never reach Google Analytics.`,
      severity: SEVERITY.HIGH,
    });
  }

  // Installed but silent
  const installed = input.htmlGa4Ids.length > 0 || input.htmlGtmIds.length > 0;
  if (installed && events.length === 0 && failedScripts.length === 0 && failedHits.length === 0) {
    issues.push({
      message: 'Analytics installed but no GA4 hits sent',
      detail: `The page references ${[...input.htmlGa4Ids, ...input.htmlGtmIds].map(escapeHtml).join(', ')} but sent no GA4 hit during load.${input.consentToolDetected ? ' A consent tool is present: if tags wait for consent (basic Consent Mode), this is expected; with advanced Consent Mode cookieless pings should still be sent.' : ' Check that a GA4 tag fires on page view.'}`,
      severity: input.consentToolDetected ? SEVERITY.LOW : SEVERITY.MEDIUM,
    });
  }

  // Property mismatches
  const htmlIds = new Set(input.htmlGa4Ids.map((i) => i.toUpperCase()));
  if (htmlIds.size) {
    const unknown = ga4Ids.filter((id) => !htmlIds.has(id));
    if (unknown.length) {
      issues.push({
        message: 'GA4 hits sent to a property not referenced on the page',
        detail: `Hits go to ${unknown.map(escapeHtml).join(', ')}, but the page HTML references ${[...htmlIds].map(escapeHtml).join(', ')}. Often a GTM tag left over from another site or environment; verify the property.`,
        severity: SEVERITY.LOW,
      });
    }
  }
  const pvByTid: Record<string, number> = {};
  pageViews.forEach((e) => (pvByTid[e.tid.toUpperCase()] = (pvByTid[e.tid.toUpperCase()] ?? 0) + 1));
  const pvTids = Object.keys(pvByTid);
  if (pvTids.length > 1) {
    issues.push({
      message: 'Page views sent to multiple GA4 properties',
      detail: `This page sends page_view to ${pvTids.map(escapeHtml).join(', ')}. Fine for a deliberate roll-up property; otherwise one of them is a stray tag.`,
      severity: SEVERITY.LOW,
    });
  }
  const dupes = Object.entries(pvByTid).filter(([, n]) => n > 1);
  if (dupes.length) {
    issues.push({
      message: 'Duplicate GA4 page_view on page load',
      detail: `${dupes.map(([t, n]) => `${escapeHtml(t)} received ${n} page_view hits`).join('; ')} for one page load, usually a hard-coded gtag.js plus a GA4 tag in GTM. Sessions and page views are inflated and engagement metrics skewed.`,
      severity: SEVERITY.HIGH,
    });
  }

  // Debug + PII
  const debug = events.find(
    (e) => e.params._dbg === '1' || e.params['ep.debug_mode'] === 'true' || e.params['epn.debug_mode'] === '1',
  );
  if (debug) {
    issues.push({
      message: 'GA4 debug mode enabled in production',
      detail: `Hits to ${escapeHtml(debug.tid)} carry debug_mode. Debug traffic is excluded from standard reports in GA4, so these visits may be missing from reports.`,
      severity: SEVERITY.MEDIUM,
    });
  }
  for (const e of events) {
    const pii = findPii(e);
    if (pii) {
      issues.push({
        message: 'Personal data sent to Google Analytics',
        detail: `A ${escapeHtml(e.en)} hit to ${escapeHtml(e.tid)} contains personal data in <code>${escapeHtml(pii.field)}</code> (${escapeHtml(pii.sample)}). Google Analytics terms forbid sending PII; strip it from URLs, titles and event parameters.`,
        severity: SEVERITY.HIGH,
      });
      break;
    }
  }

  // Meta Pixel
  const metaDupes = Object.entries(metaHits).filter(([, n]) => n > 1);
  if (metaDupes.length) {
    issues.push({
      message: 'Meta Pixel fires duplicate PageView',
      detail: `${metaDupes.map(([id, n]) => `Pixel ${escapeHtml(id)} sent PageView ${n} times`).join('; ')} on one load, usually the pixel installed both directly and through GTM.`,
      severity: SEVERITY.MEDIUM,
    });
  }

  // dataLayer
  if (input.servedHtml && dataLayerOverwrittenAfterGtm(input.servedHtml)) {
    issues.push({
      message: 'dataLayer is overwritten after GTM loads',
      detail:
        'The served HTML assigns <code>dataLayer = [...]</code> after the GTM snippet. This replaces the array GTM listens to, so earlier pushes (consent defaults, events) are lost. Use <code>window.dataLayer = window.dataLayer || []</code> and push.',
      severity: SEVERITY.MEDIUM,
    });
  }
  const dl = input.dataLayer;
  if (dl && dl.consentDefaultIndex >= 0 && dl.firstTagIndex >= 0 && dl.consentDefaultIndex > dl.firstTagIndex) {
    issues.push({
      message: 'Consent Mode default set after tags start',
      detail:
        'The dataLayer has the consent default command after a config command or the gtm.js event, so the first hits are sent without consent state. Set the consent default before loading GTM / gtag config.',
      severity: SEVERITY.MEDIUM,
    });
  }

  // Internal UTM links
  const utmLinks = input.anchors.filter((a) => {
    try {
      const u = new URL(a);
      return orgDomain(u.hostname) === orgDomain(pageHost) && [...u.searchParams.keys()].some((k) => /^utm_/i.test(k));
    } catch {
      return false;
    }
  });
  if (utmLinks.length) {
    issues.push({
      message: 'Internal links with UTM parameters',
      detail: `${utmLinks.length} internal link(s) carry utm_ parameters (e.g. ${link(utmLinks[0])}). Clicking them starts a new campaign attribution and overwrites the visitor's real source. Use event tracking instead.`,
      severity: SEVERITY.MEDIUM,
    });
  }

  // E-commerce
  if (input.hasProductSchema && events.length > 0 && !events.some((e) => e.en === 'view_item') && !dl?.hasViewItem) {
    issues.push({
      message: 'Product page sends no view_item event',
      detail:
        'This page has Product structured data and GA4 is active, but no view_item event was sent or pushed to the dataLayer. GA4 e-commerce reports (product views, funnels) stay empty without it.',
      severity: SEVERITY.LOW,
    });
  }

  return {
    issues,
    info: {
      ga4Ids,
      pageViews: pageViews.length,
      hits: events.length,
      metaPixelIds: Object.keys(metaHits),
      gtmIds: input.htmlGtmIds,
    },
  };
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

export class TagRuntimeAnalyzer {
  static async analyze(page: PageLike | null, input: Omit<TagPageInput, 'dataLayer'>) {
    let dataLayer: DataLayerFacts | undefined;
    if (page) {
      try {
        dataLayer = await page.evaluate(readDataLayerFacts);
      } catch {
        dataLayer = undefined;
      }
    }
    const { issues, info } = tagRuntimeIssues({ ...input, dataLayer });
    return { issues, warnings: [] as Issue[], info };
  }
}
