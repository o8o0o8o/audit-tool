/**
 * Stage 5 of the lead pipeline: the truth gate.
 *
 * A candidate becomes a highlight only when a SECOND METHOD — different code looking at different
 * evidence than the scan — observes the same fact, and a CONTROL with the same client shows that we
 * can see the site clearly (the homepage loads, a random missing URL really returns "not found").
 * Running the scan's check twice would reproduce a logic bug twice, so that is never the re-check.
 *
 * Rules that hold for every type:
 *  - A blocked or failed request is never evidence. 403, 429 and challenge pages drop the candidate.
 *  - Only 404 and 410 mean "gone". A 5xx is an outage, not a finding.
 *  - Security exposures never enter here; they go to the disclosure flow.
 *  - No LLM verdict opens the gate.
 *
 * Design: docs/gtm/sales-audit-system.md, "Stage 5: truth gate".
 */

import { isChallengeResponse } from '../utils/blocked-fetch';
import {
  countSpfLookups,
  isAbsentError,
  parseTagList,
  type DnsLookup,
} from '../analyzers/site-checks/email-dns-analyzer';
import { orgDomain } from '../analyzers/site-checks/site-checks-types';
import { advisoryFor, compareVersions } from '../analyzers/security/js-library-analyzer';
import { blockReason, type PageFetcher, type PageSnapshot } from './fingerprint';
import { eolStatus } from './eol';
import { PRODUCTS } from './versions';
import { okPages, type RunData } from './run-data';
import { describeTrackingCookies, trackingCookies } from './tracking-cookies';
import {
  POOR_THRESHOLD,
  TEMPLATE_CODE,
  buildCandidates,
  findingsNotOnAllowlist,
  type AnalyticsGapCandidate,
  type BrokenImageCandidate,
  type EmailAuthCandidate,
  type DeadLinkCandidate,
  type EolCandidate,
  type FindingType,
  type MissingHreflangCandidate,
  type NoindexCandidate,
  type SitemapDeadCandidate,
  type TemplateTextCandidate,
  type TrackingBeforeConsentCandidate,
  type UnnamedControlsCandidate,
  type VitalsCandidate,
  type VulnerableLibraryCandidate,
} from './sales-signals';
import type { SignalKind, StackProfile } from './types';

export interface GateOptions {
  /** Distinct root causes needed before a teaser is built. */
  minCauses?: number;
  /** How far inside the "poor" band a real-user metric must be: 0.1 = 10% beyond the threshold. */
  vitalsMargin?: number;
  /** Dead sitemap URLs (404/410, confirmed in a browser) needed before the sitemap is a highlight. */
  minDeadSitemapUrls?: number;
  today?: string;
  /** Finding types taken off the allowlist after a factual rejection (see `review-log.ts`). */
  suspendedTypes?: string[];
}

export const GATE_DEFAULTS = { minCauses: 3, vitalsMargin: 0.1, minDeadSitemapUrls: 2 } as const;

/** What the gate's own browser session can do. Injected, so tests need no browser. */
export interface GateBrowser {
  /** Loads `url` in a fresh session and reads library/framework versions from runtime globals. */
  readRuntime(url: string): Promise<{ status: number | null; runtime: Record<string, string> } | null>;
  /**
   * Opens `sourceUrl` in a fresh session, clicks the link to `targetUrl` (or, when the link cannot
   * be clicked, navigates to it) and reports the status of the page that answers.
   */
  followLink(
    sourceUrl: string,
    targetUrl: string,
    evidenceName: string,
  ): Promise<{ status: number | null; via: 'browser-click' | 'browser-navigation'; screenshot: string | null } | null>;
  /** Opens `url` in a fresh session and reports the status of the page that answers. */
  openPage(url: string): Promise<{ status: number | null } | null>;
  /**
   * A first visit in a fresh session: loads `url`, waits for tags to settle and clicks nothing. Reports
   * the cookies the browser then holds and the cookie banner on screen, if any (with a screenshot).
   */
  firstVisit?(url: string, evidenceName: string): Promise<FirstVisit | null>;
  /**
   * Opens `url` in a fresh session and lists the visible links and buttons whose name in the browser's
   * accessibility tree is empty. Controls in `expected` are outlined on the screenshot. Desktop first;
   * a phone-sized screen when the desktop shows none of `expected`.
   */
  unnamedControls?(url: string, expected: string[], evidenceName: string): Promise<UnnamedControlsResult | null>;
  /**
   * Loads `url` in a fresh session, clicks nothing that leaves the site, and reports what its tags
   * send: the Tag Manager containers in `gtmIds` as Google answered them, GA4 page views on arrival,
   * links to the brand's other domains (with the GA4 property each linked page reports to) and a
   * change of page without a reload in a single-page app.
   */
  tagSession?(url: string, gtmIds: string[]): Promise<TagSession | null>;
}

export interface TagSession {
  status: number | null;
  /** Each container in `gtmIds`: whether the page asked for it and what Google sent back. */
  gtm: Array<{ id: string; requested: boolean; status: number | null; empty: boolean }>;
  /** GA4 properties that received a page_view when the page loaded. */
  pageViews: string[];
  /** The GA4 hits carry "analytics storage denied" (Consent Mode): the linker stays off then. */
  consentDenied: boolean;
  /** Links to the brand's other domains: whether a click adds `_gl`, and the GA4 properties the linked page reports to. */
  linker: Array<{ href: string; host: string; decorated: boolean; tids: string[] }>;
  /** A click on a same-site link: `soft` when the page changed without a reload. */
  spa: { to: string; soft: boolean; pageViewsAfter: number } | null;
}

export interface FirstVisit {
  status: number | null;
  cookies: Array<{ name: string; domain: string }>;
  /** The consent prompt on screen: the consent tool when it is known, and the start of its text. */
  banner: { vendor: string | null; text: string; canRefuse: boolean } | null;
  screenshot: string | null;
}

export interface UnnamedControl {
  /** Role in the accessibility tree: `link`, `button`, … */
  role: string;
  /** `<tag#id>` / `<tag.class>`, the same form the scan reports. */
  label: string;
  region: 'header' | 'nav' | 'footer' | 'main';
  href: string | null;
  /** Words that say what the control is for: id, class, aria-controls, icon name, image file. */
  hint: string;
}

export interface UnnamedControlsResult {
  status: number | null;
  viewport: 'desktop' | 'phone';
  controls: UnnamedControl[];
  screenshot: string | null;
}

export interface GateIo {
  get: PageFetcher;
  browser?: GateBrowser | null;
  /** Two public DNS resolvers (DNS over HTTPS) for the email re-check; none, no email highlight. */
  dns?: Array<DnsLookup & { name: string }> | null;
  /** A random path that cannot exist on the site; injectable for tests. */
  randomPath?: () => string;
}

export interface ControlResult {
  homepage: number | null;
  randomMissing: number | null;
  /** We could not read the site at all: every re-check that needs a request is dropped. */
  blocked: boolean;
  /** Missing pages do not answer 404/410: status-based re-checks cannot be trusted here. */
  statusUnreliable: boolean;
  note: string | null;
}

export interface Highlight {
  type: FindingType;
  rootCause: string;
  angle: string;
  /** One sentence, facts only: what a visitor or a crawler gets, with the measured values. */
  fact: string;
  /** The page the prospect opens to see it. */
  url: string;
  evidence: {
    target?: string;
    status?: number | null;
    value?: number | string;
    /** The methods that observed the fact. */
    methods: string[];
    control: { homepage: number | null; randomMissing: number | null };
    checkedAt: string;
    screenshot?: string | null;
    /** Other instances of the same fact (more dead links, more broken images). */
    also?: string[];
    source?: string;
  };
  gate: 'pass';
}

export interface DroppedCandidate {
  type: string;
  reason:
    | 'not-on-allowlist'
    | 'control-failed'
    | 'blocked'
    | 'second-method-disagrees'
    | 'no-second-method-available'
    | 'not-well-inside-poor-band'
    | 'version-not-confirmed-by-two-kinds'
    | 'upstream-version-only'
    | 'type-suspended'
    | 'below-threshold'
    | 'no-consent-prompt'
    | 'same-root-cause';
  rootCause?: string;
  detail?: string;
}

export interface DisclosureItem {
  check: string;
  note: string;
}

export interface GateResult {
  checkedAt: string;
  control: ControlResult;
  highlights: Highlight[];
  /** Root causes of the highlights, in teaser order. */
  causes: string[];
  teaserReady: boolean;
  candidatesDropped: DroppedCandidate[];
  /** Security exposures the scan came across. They never enter a teaser; they must be disclosed. */
  disclosure: DisclosureItem[];
  /** Requests the gate sent to the site's own hosts (the browser session's page loads count as one each). */
  requestsSent: number;
}

const GONE = (status: number | null | undefined) => status === 404 || status === 410;

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
};

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Security findings of the scan: a leaked key pattern or a dangling CNAME. */
export function disclosureItems(run: RunData): DisclosureItem[] {
  const out: DisclosureItem[] = [];
  for (const check of run.metadata.siteChecks?.checks ?? []) {
    if ((check.id === 'js-secrets' || check.id === 'subdomain-takeover') && check.status === 'fail') {
      out.push({ check: check.id, note: check.note ?? '' });
    }
  }
  return out;
}

/** The homepage must load and a random missing URL must really be "not found", with our own client. */
export async function runControl(origin: string, io: GateIo): Promise<{ control: ControlResult; requests: number }> {
  const home = await io.get(`${origin}/`);
  const homeReason = home ? blockReason(home.status, home.headers, home.body) : 'network';
  if (homeReason) {
    return {
      control: {
        homepage: home?.status ?? null,
        randomMissing: null,
        blocked: true,
        statusUnreliable: true,
        note: `homepage could not be read (${homeReason})`,
      },
      requests: 1,
    };
  }
  const random = io.randomPath?.() ?? `/lead-check-${Math.random().toString(36).slice(2, 12)}`;
  const missing = await io.get(`${origin}${random}`);
  const status = missing?.status ?? null;
  const refused =
    status === 401 || status === 403 || status === 429 || isChallengeResponse(status, missing?.headers ?? null);
  const statusUnreliable = !GONE(status);
  return {
    control: {
      homepage: home?.status ?? null,
      randomMissing: status,
      blocked: refused,
      statusUnreliable,
      note: refused
        ? `a request for a missing URL was refused (${status})`
        : statusUnreliable
          ? `a random missing URL returned ${status ?? 'no answer'} instead of 404, so status codes cannot be trusted on this site`
          : null,
    },
    requests: 2,
  };
}

interface CheckContext {
  io: GateIo;
  control: ControlResult;
  checkedAt: string;
  options: Required<Pick<GateOptions, 'minCauses' | 'vitalsMargin' | 'minDeadSitemapUrls'>> & { today: string };
  dropped: DroppedCandidate[];
  requests: { n: number };
  runtime: Record<string, string> | null;
  /** One tag session per gate run, shared by the analytics candidates. */
  tagSession?: Promise<TagSession | null>;
}

const evidenceBase = (ctx: CheckContext) => ({
  control: { homepage: ctx.control.homepage, randomMissing: ctx.control.randomMissing },
  checkedAt: ctx.checkedAt,
});

async function get(ctx: CheckContext, url: string): Promise<PageSnapshot | null> {
  ctx.requests.n++;
  return ctx.io.get(url);
}

/** Most per-page addresses of one link that are requested. */
const MAX_LINK_VARIANTS = 25;

function positionWords(position: DeadLinkCandidate['position']): string {
  if (position === 'header') return 'in the header';
  if (position === 'nav') return 'in the navigation';
  if (position === 'footer') return 'in the footer';
  if (position === 'cta') return 'on a call-to-action button';
  return 'on the page';
}

function pagesWords(n: number, total: number): string {
  if (n >= total && total > 1) return `on all ${total} pages scanned`;
  if (n === 1 && total <= 1) return 'on the page scanned';
  return `on ${n} of ${total} pages scanned`;
}

/**
 * Dead link in the navigation or on a call to action.
 * Second method: a plain HTTP GET of the target AND a real click on the link in a fresh browser
 * session. Both must end on 404 or 410.
 */
async function checkDeadLink(c: DeadLinkCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked || ctx.control.statusUnreliable) {
    // Only log targets the crawl itself saw as gone; the rest were never candidates in earnest.
    if (GONE(c.crawledStatus))
      ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: c.target });
    return null;
  }
  const plain = await get(ctx, c.target);
  if (!plain || !GONE(plain.status)) {
    if (GONE(c.crawledStatus)) {
      ctx.dropped.push({
        type: c.type,
        reason: plain && [401, 403, 429].includes(plain.status) ? 'blocked' : 'second-method-disagrees',
        rootCause: c.rootCause,
        detail: `${c.target}: crawl saw ${c.crawledStatus}, plain GET saw ${plain?.status ?? 'no answer'}`,
      });
    }
    return null;
  }
  // A link with one address per page: every page's address is requested, and only the pages whose
  // address is gone are counted. The click is made once, on the first page.
  let pagesGone = c.pages.length;
  if (c.variants.length) {
    pagesGone = 1;
    for (const variant of c.variants.slice(1, MAX_LINK_VARIANTS)) {
      if (GONE((await get(ctx, variant.target))?.status)) pagesGone++;
    }
  }
  if (!ctx.io.browser) {
    ctx.dropped.push({
      type: c.type,
      reason: 'no-second-method-available',
      rootCause: c.rootCause,
      detail: `${c.target}: no browser session for the click`,
    });
    return null;
  }
  ctx.requests.n += 2;
  const clicked = await ctx.io.browser.followLink(c.pages[0], c.target, `dead-nav-link-${ctx.requests.n}`);
  if (!clicked || !GONE(clicked.status)) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.target}: plain GET saw ${plain.status}, the browser saw ${clicked?.status ?? 'no answer'}`,
    });
    return null;
  }
  const label = c.text ? `The "${c.text}" link` : 'A link';
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `${label} ${positionWords(c.position)} returns ${plain.status} ${pagesWords(pagesGone, c.pagesScanned)}`,
    url: c.pages[0],
    evidence: {
      target: c.target,
      status: plain.status,
      methods: ['http-get', clicked.via],
      screenshot: clicked.screenshot,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/** `<meta name="robots|googlebot" content="…noindex…">` in served HTML. */
export function servedNoindex(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?(?:robots|googlebot)["']?/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3] ?? '';
    if (/\bnoindex\b/i.test(value)) return value;
  }
  return null;
}

/**
 * Key page set to noindex. The scan read the rendered page in a browser; the second method is a
 * plain GET that looks at the served HTML and the `X-Robots-Tag` header. A noindex that only
 * JavaScript adds is not eligible: the served page does not carry it.
 */
async function checkNoindex(c: NoindexCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: c.url });
    return null;
  }
  const res = await get(ctx, c.url);
  if (!res || blockReason(res.status, res.headers, res.body)) {
    ctx.dropped.push({
      type: c.type,
      reason: 'blocked',
      rootCause: c.rootCause,
      detail: `${c.url}: ${res?.status ?? 'no answer'}`,
    });
    return null;
  }
  const header = /\bnoindex\b/i.test(res.headers['x-robots-tag'] ?? '') ? res.headers['x-robots-tag'] : null;
  const meta = servedNoindex(res.body);
  if (!header && !meta) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.url}: the served HTML and headers carry no noindex`,
    });
    return null;
  }
  const where =
    c.keyReason === 'homepage'
      ? 'The homepage'
      : c.keyReason === 'main navigation'
        ? `${pathOf(c.url)}, linked from the main navigation,`
        : `${pathOf(c.url)}, listed in the sitemap,`;
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `${where} tells search engines not to index it (${header ? `X-Robots-Tag: ${header}` : `meta robots: ${meta}`})`,
    url: c.url,
    evidence: {
      value: header ?? meta ?? '',
      status: res.status,
      methods: ['browser-crawl', header ? 'http-get-header' : 'http-get-served-html'],
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/**
 * Poor Core Web Vitals for real users. No second method exists: this is Google's own measurement,
 * and the prospect can open the same numbers in PageSpeed Insights. The value must sit well inside
 * the "poor" band, and only origin-level phone data counts.
 */
function checkVitals(c: VitalsCandidate, ctx: CheckContext): Highlight | null {
  const threshold = POOR_THRESHOLD[c.metric];
  if (c.formFactor !== 'PHONE' || c.p75 < threshold * (1 + ctx.options.vitalsMargin)) {
    ctx.dropped.push({
      type: c.type,
      reason: 'not-well-inside-poor-band',
      rootCause: c.rootCause,
      detail: `${c.metric} p75 ${c.p75} (${c.formFactor}); needs ${threshold * (1 + ctx.options.vitalsMargin)} or more on phones`,
    });
    return null;
  }
  const fact =
    c.metric === 'LCP'
      ? `For real visitors on phones the main content takes ${(c.p75 / 1000).toFixed(1)} s to appear at the 75th percentile (Google rates anything above 4.0 s as poor)`
      : c.metric === 'INP'
        ? `For real visitors on phones the site takes ${Math.round(c.p75)} ms to respond to a tap at the 75th percentile (Google rates anything above 500 ms as poor)`
        : `For real visitors on phones the layout shift score is ${c.p75.toFixed(2)} at the 75th percentile (Google rates anything above 0.25 as poor)`;
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact,
    url: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(c.origin)}&form_factor=mobile`,
    evidence: {
      value: c.p75,
      methods: ['chrome-ux-report'],
      source: `Chrome UX Report, origin level, phones${c.periodEnd ? `, 28 days to ${c.periodEnd}` : ''}`,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/**
 * End-of-life CMS or framework. The version must be seen by two different kinds of signal. The
 * fingerprint gives the first; the gate's browser session can add a runtime global as the second.
 */
function checkEol(c: EolCandidate, ctx: CheckContext): Highlight | null {
  const { hit } = c;
  if (hit.upstreamOnly) {
    ctx.dropped.push({
      type: c.type,
      reason: 'upstream-version-only',
      rootCause: c.rootCause,
      detail: `${hit.label} ${hit.version}: a header version that distributions keep while backporting fixes`,
    });
    return null;
  }
  const kinds = new Set<SignalKind>(hit.kinds);
  const runtimeVersion = ctx.runtime?.[hit.product];
  const sameCycle = runtimeVersion
    ? eolStatus(hit.product, runtimeVersion, ctx.options.today)?.cycle === hit.cycle
    : false;
  if (runtimeVersion && sameCycle) kinds.add('global');
  // Nuxt 2 runs on Vue 2: a Vue 2 runtime is a second, independent sign of Nuxt 2.
  if (hit.product === 'nuxt' && hit.cycle === '2' && ctx.runtime?.vue?.startsWith('2.')) kinds.add('global');
  if (kinds.size < 2) {
    ctx.dropped.push({
      type: c.type,
      reason: 'version-not-confirmed-by-two-kinds',
      rootCause: c.rootCause,
      detail: `${hit.label} ${hit.version}: seen by ${[...kinds].join(', ') || 'nothing'} only`,
    });
    return null;
  }
  const role = PRODUCTS[hit.product]?.role === 'cms' ? 'runs on' : 'is built with';
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `The site ${role} ${hit.label} ${hit.version}, which stopped receiving fixes${hit.eolDate ? ` on ${hit.eolDate}` : ''}`,
    url: `https://endoflife.date/${hit.product}`,
    evidence: {
      value: `${hit.label} ${hit.version}`,
      methods: [...kinds].map((k) => `signal:${k}`),
      source: 'endoflife.date',
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/**
 * Broken image on a scanned page. The scan saw it fail to render in the browser; the second method
 * is a plain GET of the image file. An image that fails in the browser but answers 200 is not
 * eligible (it may be a format, CORS or lazy-loading matter).
 */
async function checkBrokenImage(c: BrokenImageCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked || ctx.control.statusUnreliable) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: c.image });
    return null;
  }
  const res = await get(ctx, c.image);
  if (!res || !GONE(res.status)) {
    ctx.dropped.push({
      type: c.type,
      reason: res && [401, 403, 429].includes(res.status) ? 'blocked' : 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.image}: did not render in the browser, plain GET saw ${res?.status ?? 'no answer'}`,
    });
    return null;
  }
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `An image on ${pathOf(c.pages[0]) === '/' ? 'the homepage' : pathOf(c.pages[0])} does not load: its file returns ${res.status}`,
    url: c.pages[0],
    evidence: {
      target: c.image,
      status: res.status,
      methods: ['browser-render', 'http-get'],
      screenshot: c.shot,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/** Served HTML reduced to the text a visitor reads: no scripts, styles, templates, comments or tags. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|textarea)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const LOREM = /\blorem ipsum\b/i;

/**
 * Unfilled template code or lorem ipsum. The scan saw it in the rendered page; the second method is
 * a plain GET whose served HTML must show the same text outside scripts and templates. Text that
 * only JavaScript writes is not eligible in this version.
 */
async function checkTemplateText(c: TemplateTextCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: c.url });
    return null;
  }
  const res = await get(ctx, c.url);
  if (!res || blockReason(res.status, res.headers, res.body)) {
    ctx.dropped.push({
      type: c.type,
      reason: 'blocked',
      rootCause: c.rootCause,
      detail: `${c.url}: ${res?.status ?? 'no answer'}`,
    });
    return null;
  }
  const text = visibleText(res.body);
  const tokens = c.tokens.filter((t) => TEMPLATE_CODE.test(t) && text.includes(t));
  const lorem = c.placeholder && LOREM.test(text);
  if (!tokens.length && !lorem) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.url}: the served HTML does not show ${[...c.tokens, ...(c.placeholder ? ['lorem ipsum'] : [])].join(', ')}`,
    });
    return null;
  }
  const where = pathOf(c.url) === '/' ? 'The homepage' : pathOf(c.url);
  const shown = tokens.length
    ? `raw template code (${tokens
        .slice(0, 3)
        .map((t) => `"${t.length > 40 ? `${t.slice(0, 40)}…` : t}"`)
        .join(', ')}) where content should be`
    : 'placeholder text ("Lorem ipsum")';
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `${where} shows ${shown}${tokens.length && lorem ? ', and placeholder text ("Lorem ipsum")' : ''}`,
    url: c.url,
    evidence: {
      value: [...tokens, ...(lorem ? ['lorem ipsum'] : [])].join(' | '),
      status: res.status,
      methods: ['browser-render', 'http-get-served-html'],
      screenshot: c.shot,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/** Does this served page or response carry any hreflang annotation? */
function hasHreflang(res: PageSnapshot): boolean {
  if (/hreflang/i.test(res.headers['link'] ?? '')) return true;
  return /<link\b[^>]*\bhreflang\s*=/i.test(res.body);
}

const servedLanguage = (html: string) => {
  const tag = /<html\b[^>]*>/i.exec(html)?.[0] ?? '';
  const m = /\blang\s*=\s*["']?([a-z]{2,3})(?:[-_][a-z0-9]+)?["'\s>]/i.exec(tag);
  return m ? m[1].toLowerCase() : null;
};

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Child sitemaps of a sitemap index that are read when looking for hreflang. */
const MAX_CHILD_SITEMAPS = 5;

/**
 * Pages in several languages and no hreflang anywhere. The scan read the rendered pages; the second
 * method is a plain GET of one page per language (served `<html lang>` must differ, and neither the
 * HTML nor the `Link` header may carry hreflang), plus the sitemap files, which must not carry it
 * either. A sitemap that cannot be read drops the candidate: absence is only claimed where we looked.
 */
async function checkMissingHreflang(c: MissingHreflangCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause });
    return null;
  }
  const served = new Set<string>();
  for (const { url } of c.pages.slice(0, 2)) {
    const res = await get(ctx, url);
    if (!res || blockReason(res.status, res.headers, res.body)) {
      ctx.dropped.push({
        type: c.type,
        reason: 'blocked',
        rootCause: c.rootCause,
        detail: `${url}: ${res?.status ?? 'no answer'}`,
      });
      return null;
    }
    if (hasHreflang(res)) {
      ctx.dropped.push({
        type: c.type,
        reason: 'second-method-disagrees',
        rootCause: c.rootCause,
        detail: `${url}: the served page carries hreflang`,
      });
      return null;
    }
    const lang = servedLanguage(res.body);
    if (lang) served.add(lang);
  }
  if (served.size < 2) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `the served pages declare ${[...served].join(', ') || 'no language'}, not two different ones`,
    });
    return null;
  }
  const files = [...c.sitemaps];
  for (let i = 0; i < files.length && i < c.sitemaps.length + MAX_CHILD_SITEMAPS; i++) {
    const res = await get(ctx, files[i]);
    // A sitemap is XML, so the HTML page test does not apply: it must be a 200 sitemap document.
    const readable =
      res?.status === 200 &&
      !isChallengeResponse(res.status, res.headers) &&
      /<(?:urlset|sitemapindex)\b/i.test(res.body);
    if (!res || !readable) {
      ctx.dropped.push({
        type: c.type,
        reason: 'blocked',
        rootCause: c.rootCause,
        detail: `${files[i]}: ${res?.status ?? 'no answer'}; the sitemap could not be checked for hreflang`,
      });
      return null;
    }
    if (/hreflang/i.test(res.body)) {
      ctx.dropped.push({
        type: c.type,
        reason: 'second-method-disagrees',
        rootCause: c.rootCause,
        detail: `${files[i]} carries hreflang`,
      });
      return null;
    }
    if (/<sitemapindex\b/i.test(res.body)) {
      const children = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
      for (const child of children.slice(0, MAX_CHILD_SITEMAPS)) if (!files.includes(child)) files.push(child);
    }
  }
  const names = c.languages.map(languageName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    // Scoped to what was scanned: a site can carry hreflang on pages outside the sample.
    fact: `The site has pages in ${list}, but none of the ${c.pagesScanned} pages we scanned tells search engines about its other language versions: no hreflang in those pages${files.length ? ', their HTTP headers or the sitemap' : ' or their HTTP headers'}`,
    url: c.pages[0].url,
    evidence: {
      target: c.pages[1].url,
      value: c.languages.join(', '),
      methods: ['browser-crawl', 'http-get-served-html', ...(files.length ? ['sitemap-read'] : [])],
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/**
 * Dead URLs in the sitemap. A plain GET of an even sample of sitemap URLs the scan did not load;
 * each 404/410 is then opened in a fresh browser session, and only URLs both methods see as gone
 * count. The teaser says "x of n sampled", never "the sitemap is full of".
 */
async function checkSitemapDead(c: SitemapDeadCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked || ctx.control.statusUnreliable) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause });
    return null;
  }
  const gone: Array<{ url: string; status: number }> = [];
  let answered = 0;
  let refused = 0;
  for (const url of c.sample) {
    const res = await get(ctx, url);
    if (!res) continue;
    if ([401, 403, 429].includes(res.status) || isChallengeResponse(res.status, res.headers)) {
      refused++;
      continue;
    }
    answered++;
    if (GONE(res.status)) gone.push({ url, status: res.status });
  }
  if (refused > c.sample.length / 4) {
    ctx.dropped.push({
      type: c.type,
      reason: 'blocked',
      rootCause: c.rootCause,
      detail: `${refused} of ${c.sample.length} sitemap URLs refused`,
    });
    return null;
  }
  if (gone.length < ctx.options.minDeadSitemapUrls) {
    if (gone.length)
      ctx.dropped.push({
        type: c.type,
        reason: 'below-threshold',
        rootCause: c.rootCause,
        detail: `${gone.length} of ${answered} sampled sitemap URLs gone; ${ctx.options.minDeadSitemapUrls} needed`,
      });
    return null;
  }
  if (!ctx.io.browser) {
    ctx.dropped.push({
      type: c.type,
      reason: 'no-second-method-available',
      rootCause: c.rootCause,
      detail: 'no browser session',
    });
    return null;
  }
  const confirmed: Array<{ url: string; status: number }> = [];
  for (const g of gone) {
    ctx.requests.n++;
    const opened = await ctx.io.browser.openPage(g.url);
    if (GONE(opened?.status)) confirmed.push(g);
  }
  if (confirmed.length < ctx.options.minDeadSitemapUrls) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${gone.length} sitemap URLs returned 404/410 to a plain GET, ${confirmed.length} in the browser`,
    });
    return null;
  }
  const statuses = [...new Set(confirmed.map((g) => g.status))].sort().join(' or ');
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `${confirmed.length} of ${answered} sitemap addresses we sampled return ${statuses} (the sitemap lists ${c.sitemapTotal.toLocaleString('en-US')} addresses)`,
    url: confirmed[0].url,
    evidence: {
      status: confirmed[0].status,
      value: `${confirmed.length}/${answered}`,
      methods: ['http-get', 'browser-navigation'],
      also: confirmed.slice(1).map((g) => g.url),
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

/** Version banners at the top of each library's published files. */
const BANNERS: Record<string, RegExp[]> = {
  jquery: [/jQuery(?: JavaScript Library)? v(\d+\.\d+\.\d+)/, /jquery:\s*["'](\d+\.\d+\.\d+)["']/],
  'jquery-ui': [/jQuery UI(?: - v| v|\s+)(\d+\.\d+\.\d+)/, /version:\s*["'](\d+\.\d+\.\d+)["']/],
  bootstrap: [/Bootstrap v(\d+\.\d+\.\d+)/],
  angularjs: [/AngularJS v(\d+\.\d+\.\d+)/],
  lodash: [/lodash[^\n]{0,60}?(\d+\.\d+\.\d+)/i, /VERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/],
  underscore: [/Underscore\.js (\d+\.\d+\.\d+)/],
  moment: [/version\s*:\s*(\d+\.\d+\.\d+)/],
  handlebars: [/handlebars v(\d+\.\d+\.\d+)/i],
  dompurify: [/DOMPurify (\d+\.\d+\.\d+)/],
  vue: [/Vue\.js v(\d+\.\d+\.\d+)/],
};

/** The library version a file's banner states, from its first 4 KB. */
export function bannerVersion(lib: string, body: string): string | null {
  const head = body.slice(0, 4096);
  for (const re of BANNERS[lib] ?? []) {
    const m = re.exec(head);
    if (m) return m[1];
  }
  return null;
}

/**
 * A library version with a published advisory. The scan read the version from a runtime global or
 * the file name; the second method downloads the script file and reads the version from its banner.
 * The two must agree, and the advisory must apply to that version.
 */
async function checkVulnerableLibrary(c: VulnerableLibraryCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (!c.scripts.length) {
    ctx.dropped.push({
      type: c.type,
      reason: 'no-second-method-available',
      rootCause: c.rootCause,
      detail: `${c.label} ${c.version}: no script file of its own on ${c.page} (bundled), so no banner to read`,
    });
    return null;
  }
  const seen: string[] = [];
  for (const script of c.scripts) {
    const res = await get(ctx, script);
    if (res?.status !== 200) continue;
    const version = bannerVersion(c.lib, res.body);
    if (!version) continue;
    seen.push(`${version} in ${script}`);
    if (compareVersions(version, c.version) !== 0 || !advisoryFor(c.lib, version)) continue;
    return {
      type: c.type,
      rootCause: c.rootCause,
      angle: c.angle,
      fact: `The site loads ${c.label} ${version}, a version with a published security advisory (${c.advisory}); it is fixed from version ${c.fixedIn}`,
      url: c.page,
      evidence: {
        target: script,
        value: `${c.label} ${version}`,
        status: res.status,
        methods: [`scan:${c.version}`, 'http-get-file-banner'],
        ...evidenceBase(ctx),
      },
      gate: 'pass',
    };
  }
  ctx.dropped.push({
    type: c.type,
    reason: seen.length ? 'second-method-disagrees' : 'no-second-method-available',
    rootCause: c.rootCause,
    detail: seen.length
      ? `${c.label}: the scan saw ${c.version}, the file banner says ${seen.join('; ')}`
      : `${c.label} ${c.version}: no readable version banner in ${c.scripts.join(', ')}`,
  });
  return null;
}

/**
 * Analytics or advertising cookies set before the visitor answers the cookie banner.
 * Second method: a first visit in a fresh browser session that clicks nothing. It must show a
 * cookie banner with a way to refuse on it AND hold tracking cookies already. No such banner, no
 * claim: a site without one, or with a notice only, is not asking, and whether it has to depends on
 * where it operates.
 */
async function checkTrackingBeforeConsent(
  c: TrackingBeforeConsentCandidate,
  ctx: CheckContext,
): Promise<Highlight | null> {
  const names = c.cookies.map((k) => k.name).join(', ');
  if (ctx.control.blocked) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: names });
    return null;
  }
  if (!ctx.io.browser?.firstVisit) {
    ctx.dropped.push({ type: c.type, reason: 'no-second-method-available', rootCause: c.rootCause, detail: names });
    return null;
  }
  ctx.requests.n++;
  const visit = await ctx.io.browser.firstVisit(c.url, 'tracking-before-consent');
  if (!visit || visit.status === null || visit.status < 200 || visit.status >= 300) {
    ctx.dropped.push({
      type: c.type,
      reason: visit && [401, 403, 429].includes(visit.status ?? 0) ? 'blocked' : 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.url}: the first visit answered ${visit?.status ?? 'nothing'}`,
    });
    return null;
  }
  if (!visit.banner?.canRefuse) {
    ctx.dropped.push({
      type: c.type,
      reason: 'no-consent-prompt',
      rootCause: c.rootCause,
      detail: visit.banner
        ? `${names} set on arrival; the banner is a notice with no way to refuse on it ("${visit.banner.text.slice(0, 80)}…")`
        : `${names} set on arrival, but no cookie banner was on screen, so the site does not ask`,
    });
    return null;
  }
  const found = trackingCookies(visit.cookies.map((k) => k.name));
  if (!found.length) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `the scan saw ${names}; a first visit set none of them before the banner was answered`,
    });
    return null;
  }
  const n = found.length;
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact: `The cookie banner${visit.banner.vendor ? ` (${visit.banner.vendor})` : ''} lets visitors refuse tracking, but before anyone answers, ${c.isHome ? 'the homepage' : pathOf(c.url)} has already set ${n === 1 ? 'an analytics or advertising cookie' : `${n} analytics and advertising cookies`}: ${describeTrackingCookies(found)}`,
    url: c.url,
    evidence: {
      value: found.map((k) => k.name).join(', '),
      status: visit.status,
      methods: ['scan-cookie-jar', 'fresh-browser-first-visit'],
      screenshot: visit.screenshot,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

const SOCIAL: Array<[RegExp, string]> = [
  [/(?:^|\.)facebook\.com$|(?:^|\.)fb\.com$/, 'Facebook'],
  [/(?:^|\.)instagram\.com$/, 'Instagram'],
  [/(?:^|\.)(?:twitter|x)\.com$/, 'X'],
  [/(?:^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/, 'YouTube'],
  [/(?:^|\.)tiktok\.com$/, 'TikTok'],
  [/(?:^|\.)pinterest\.[a-z.]+$/, 'Pinterest'],
  [/(?:^|\.)threads\.net$/, 'Threads'],
  [/(?:^|\.)vimeo\.com$/, 'Vimeo'],
  [/(?:^|\.)wa\.me$|(?:^|\.)whatsapp\.com$/, 'WhatsApp'],
];
const PURPOSE: Array<[RegExp, string]> = [
  [/search|zoek|suche|recherche/i, 'search'],
  [/cart|basket|bag|minicart|warenkorb|panier/i, 'cart'],
  [/hamburger|burger|menu|nav-?toggle|navbar-toggler|drawer/i, 'menu'],
  [/close|dismiss/i, 'close'],
  [/account|login|log-in|sign-?in|profile|user/i, 'account'],
  [/wishlist|favou?rite/i, 'wishlist'],
  [/prev|next|arrow|slick|swiper|carousel|slider/i, 'slider arrow'],
  [/play|video/i, 'video play'],
  [/lang|locale|country|region/i, 'language'],
];

/** What a group of unnamed controls is: the social sites they link to, or what their markup says they do. */
function controlSubject(group: UnnamedControl[]): string | null {
  const social = new Set<string>();
  for (const ctl of group) {
    try {
      const host = new URL(ctl.href ?? '').hostname.toLowerCase();
      const hit = SOCIAL.find(([re]) => re.test(host));
      if (hit) social.add(hit[1]);
    } catch {
      /* not a link */
    }
  }
  const role = group[0].role;
  if (social.size) {
    const names = [...social];
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    return `The ${list} ${role}${group.length > 1 ? 's' : ''}`;
  }
  const purposes = [...new Set(group.map((ctl) => PURPOSE.find(([re]) => re.test(ctl.hint))?.[1]).filter(Boolean))];
  if (purposes.length && purposes.length <= 3) {
    const list =
      purposes.length > 1 ? `${purposes.slice(0, -1).join(', ')} and ${purposes[purposes.length - 1]}` : purposes[0];
    return `The ${list} ${role}${group.length > 1 ? 's' : ''}`;
  }
  return null;
}

const REGION_WORDS: Record<UnnamedControl['region'], string> = {
  header: 'in the header',
  nav: 'in the navigation',
  footer: 'in the footer',
  main: '',
};

/**
 * Links and buttons without an accessible name.
 * Second method: the browser's own accessibility tree in a fresh session (the scan read static HTML).
 * A control passes when the browser shows it, gives it no name, and the scan reported it on that page.
 */
async function checkUnnamedControls(c: UnnamedControlsCandidate, ctx: CheckContext): Promise<Highlight | null> {
  if (ctx.control.blocked) {
    ctx.dropped.push({ type: c.type, reason: 'control-failed', rootCause: c.rootCause, detail: c.url });
    return null;
  }
  if (!ctx.io.browser?.unnamedControls) {
    ctx.dropped.push({ type: c.type, reason: 'no-second-method-available', rootCause: c.rootCause, detail: c.url });
    return null;
  }
  ctx.requests.n++;
  const seen = await ctx.io.browser.unnamedControls(c.url, c.offenders, 'unnamed-controls');
  if (!seen || seen.status === null || seen.status < 200 || seen.status >= 300) {
    ctx.dropped.push({
      type: c.type,
      reason: seen && [401, 403, 429].includes(seen.status ?? 0) ? 'blocked' : 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${c.url}: the page answered ${seen?.status ?? 'nothing'}`,
    });
    return null;
  }
  const expected = new Set(c.offenders);
  const confirmed = seen.controls.filter((ctl) => expected.has(ctl.label));
  if (!confirmed.length) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `the browser names every control the scan reported on ${c.url} (${c.offenders.slice(0, 4).join(', ')}), or does not show them`,
    });
    return null;
  }
  // The group to state: the most widespread control's role and region, with its siblings.
  const spread = (ctl: UnnamedControl) => c.pagesWith[ctl.label] ?? 0;
  const lead = [...confirmed].sort((a, b) => spread(b) - spread(a))[0];
  const group = confirmed.filter((ctl) => ctl.role === lead.role && ctl.region === lead.region);
  const subject = controlSubject(group) ?? (group.length > 1 ? `${group.length} ${lead.role}s` : `A ${lead.role}`);
  const pages = Math.max(...group.map(spread), 1);
  // Site-wide controls are counted over the scanned pages; a control on one page names that page.
  const where =
    pages > 1 ? pagesWords(pages, c.pagesScanned) : `on ${pathOf(c.url) === '/' ? 'the homepage' : pathOf(c.url)}`;
  const region = lead.region === 'main' ? '' : ` ${REGION_WORDS[lead.region]}`;
  const opener =
    seen.viewport === 'phone'
      ? `On a phone-sized screen, ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`
      : subject;
  const others = confirmed.length - group.length;
  const fact =
    `${opener}${region} ${group.length > 1 ? 'have' : 'has'} no accessible name ${where}: a screen reader announces ${group.length > 1 ? 'each one' : 'it'} only as "${lead.role}"` +
    (others > 0
      ? `; ${others} more control${others === 1 ? '' : 's'} on the page ${others === 1 ? 'has' : 'have'} no name either`
      : '');
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact,
    url: c.url,
    evidence: {
      value: group.map((ctl) => ctl.label).join(', '),
      status: seen.status,
      methods: ['scan-static-html', `browser-accessibility-tree:${seen.viewport}`],
      screenshot: seen.screenshot,
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

// ─── Email authentication ───────────────────────────────────────────────────

/** What one resolver says about a domain's mail records. `null`: the resolver could not answer. */
export interface MailView {
  domain: string;
  spf: string[];
  lookups: number;
  /** The DMARC `p=` value, `invalid` for a record without one, `null` for no record. */
  dmarc: string | null;
}

async function txtRecords(dns: DnsLookup, name: string): Promise<string[] | null> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (e) {
    return isAbsentError(e) ? [] : null;
  }
}

/**
 * The mail records of `host` as one resolver sees them. A host without SPF and MX records (a shop or
 * country subdomain) is read on its organisational domain, the company's mail domain.
 */
export async function readMailRecords(dns: DnsLookup, host: string): Promise<MailView | null> {
  const isSpf = (r: string) => /^v=spf1(\s|$)/i.test(r.trim());
  let domain = host.toLowerCase().replace(/^www\./, '');
  let txt = await txtRecords(dns, domain);
  if (txt === null) return null;
  const org = orgDomain(domain);
  if (!txt.some(isSpf) && org !== domain) {
    let mx: boolean | null;
    try {
      mx = (await dns.resolveMx(domain)).length > 0;
    } catch (e) {
      mx = isAbsentError(e) ? false : null;
    }
    if (mx === null) return null;
    if (!mx) {
      const orgTxt = await txtRecords(dns, org);
      if (orgTxt === null) return null;
      domain = org;
      txt = orgTxt;
    }
  }
  const spf = txt.filter(isSpf).map((r) => r.trim());
  const lookups = spf.length === 1 ? await countSpfLookups(dns, spf[0]) : 0;
  let dmarcTxt = await txtRecords(dns, `_dmarc.${domain}`);
  if (dmarcTxt && !dmarcTxt.some((r) => /^v=DMARC1/i.test(r.trim())) && orgDomain(domain) !== domain) {
    dmarcTxt = await txtRecords(dns, `_dmarc.${orgDomain(domain)}`);
  }
  if (dmarcTxt === null) return null;
  const record = dmarcTxt.find((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  const p = record ? parseTagList(record).p?.toLowerCase() : undefined;
  const dmarc = record ? (p && /^(none|quarantine|reject)$/.test(p) ? p : 'invalid') : null;
  return { domain, spf, lookups, dmarc };
}

/** The fact a mail view supports, or null when nothing in it is worth stating. */
export function emailFact(v: MailView): string | null {
  const d = v.domain;
  const noDmarc = v.dmarc === null || v.dmarc === 'invalid';
  const dmarcWords =
    v.dmarc === null ? 'no DMARC policy' : v.dmarc === 'invalid' ? 'a DMARC record without a valid policy' : '';
  const spfError =
    v.spf.length > 1
      ? `publishes ${v.spf.length} SPF records where the email standard (RFC 7208) allows one, and receiving mail servers then treat its SPF check as failed`
      : v.lookups > 10
        ? `has an SPF record that needs ${v.lookups} DNS lookups where the email standard (RFC 7208) allows 10, and receiving mail servers then treat its SPF check as failed`
        : null;
  if (!v.spf.length && (noDmarc || v.dmarc === 'none')) {
    return `${d} publishes no SPF record and ${noDmarc ? dmarcWords : 'only a report-only DMARC policy (p=none)'}, so mail servers have no published rule for rejecting email that someone else sends from an @${d} address`;
  }
  if (noDmarc) {
    return `${d} publishes ${dmarcWords}, so mail servers have no published rule for rejecting email that someone else sends from an @${d} address${spfError ? `; it also ${spfError}` : ''}`;
  }
  if (spfError) return `${d} ${spfError}`;
  return null;
}

/**
 * SPF and DMARC gaps. Second method: two public resolvers over HTTPS (not the system resolver the
 * scan used) must return the same records. Control: both must read a known DMARC record. DNS asks
 * nothing of the site itself, so the site's own control does not apply.
 */
async function checkEmailAuth(c: EmailAuthCandidate, ctx: CheckContext): Promise<Highlight | null> {
  const scanSaw = `scan: SPF ${c.scan.spf ?? '?'}; DMARC ${c.scan.dmarc ?? '?'}`;
  const resolvers = ctx.io.dns ?? [];
  if (resolvers.length < 2) {
    ctx.dropped.push({ type: c.type, reason: 'no-second-method-available', rootCause: c.rootCause, detail: scanSaw });
    return null;
  }
  for (const r of resolvers) {
    const known = await txtRecords(r, '_dmarc.google.com');
    if (!known?.some((t) => /^v=DMARC1/i.test(t))) {
      ctx.dropped.push({
        type: c.type,
        reason: 'control-failed',
        rootCause: c.rootCause,
        detail: `${r.name} could not read a known DMARC record`,
      });
      return null;
    }
  }
  const views = await Promise.all(resolvers.map((r) => readMailRecords(r, c.domain).catch(() => null)));
  if (views.some((v) => v === null)) {
    ctx.dropped.push({
      type: c.type,
      reason: 'no-second-method-available',
      rootCause: c.rootCause,
      detail: `a resolver did not answer for ${c.domain}`,
    });
    return null;
  }
  const comparable = (v: MailView) => JSON.stringify({ ...v, lookups: v.lookups > 10 ? v.lookups : 'ok' });
  if (new Set(views.map((v) => comparable(v!))).size > 1) {
    ctx.dropped.push({
      type: c.type,
      reason: 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `the resolvers disagree: ${views.map((v) => comparable(v!)).join(' | ')}`,
    });
    return null;
  }
  const view = views[0]!;
  const fact = emailFact(view);
  if (!fact) {
    ctx.dropped.push({
      type: c.type,
      reason: view.spf.length && view.dmarc === 'none' ? 'below-threshold' : 'second-method-disagrees',
      rootCause: c.rootCause,
      detail: `${view.domain}: SPF ${view.spf[0] ?? 'none'} (${view.lookups} lookups); DMARC p=${view.dmarc ?? 'no record'} — ${scanSaw}`,
    });
    return null;
  }
  return {
    type: c.type,
    rootCause: c.rootCause,
    angle: c.angle,
    fact,
    url: c.url,
    evidence: {
      target: view.domain,
      value: `SPF: ${view.spf.join(' | ') || 'none'}; DMARC: ${view.dmarc ?? 'no record'}`,
      methods: ['scan-system-resolver', ...resolvers.map((r) => `dns-over-https:${r.name}`)],
      ...evidenceBase(ctx),
    },
    gate: 'pass',
  };
}

// ─── Analytics data loss ────────────────────────────────────────────────────

/**
 * Analytics data the site never sends. Second method: the gate's own browser session, reading the
 * network log (the scan read Google's answer with a plain HTTP request, or ran its own tag probe).
 *  - gtm-missing: the page must ask for the container AND Google must answer empty or with an error.
 *  - spa-pageview: a page view on arrival (so analytics works and is not waiting for consent), then
 *    a change of page without a reload and no page view.
 *  - cross-domain: the linked page reports to the same GA4 property, and a click adds no `_gl`.
 */
async function checkAnalyticsGap(c: AnalyticsGapCandidate, ctx: CheckContext): Promise<Highlight | null> {
  const drop = (reason: DroppedCandidate['reason'], detail: string) => {
    ctx.dropped.push({ type: c.type, reason, rootCause: c.rootCause, detail: `${c.kind}: ${detail}` });
    return null;
  };
  if (ctx.control.blocked) return drop('control-failed', c.note);
  const browser = ctx.io.browser;
  if (!browser?.tagSession) return drop('no-second-method-available', c.note);
  if (!ctx.tagSession) {
    ctx.requests.n++;
    ctx.tagSession = browser.tagSession(c.url, c.containerIds).catch(() => null);
  }
  const s = await ctx.tagSession;
  if (!s || s.status === null || s.status < 200 || s.status >= 300) {
    return drop(
      s && [401, 403, 429].includes(s.status ?? 0) ? 'blocked' : 'second-method-disagrees',
      `the page answered ${s?.status ?? 'nothing'}`,
    );
  }
  const base = { type: c.type, rootCause: c.rootCause, angle: c.angle, url: c.url, gate: 'pass' as const };

  if (c.kind === 'gtm-missing') {
    const bad = s.gtm.filter((g) => c.containerIds.includes(g.id) && g.requested && g.empty);
    if (!bad.length) {
      return drop(
        'second-method-disagrees',
        s.gtm.map((g) => `${g.id} requested=${g.requested} status=${g.status} empty=${g.empty}`).join('; ') ||
          'container not requested',
      );
    }
    const g = bad[0];
    const answer =
      g.status !== null && g.status >= 400
        ? `Google answers with an error (HTTP ${g.status})`
        : 'Google sends back an empty container, with no tags in it (what it serves for an ID that does not exist or was never published)';
    return {
      ...base,
      fact: `The homepage loads the Google Tag Manager container ${g.id}, but ${answer}, so no tag set up in that container runs on the page`,
      evidence: {
        target: `https://www.googletagmanager.com/gtm.js?id=${g.id}`,
        status: g.status,
        value: g.id,
        methods: ['scan-http-fetch', 'browser-network-response'],
        ...evidenceBase(ctx),
      },
    };
  }

  if (c.kind === 'spa-pageview') {
    if (!s.pageViews.length)
      return drop('second-method-disagrees', 'no GA4 page view on arrival (consent pending or no GA4)');
    if (!s.spa?.soft)
      return drop(
        'second-method-disagrees',
        s.spa ? `the link to ${s.spa.to} reloaded the page` : 'no same-site link changed the page',
      );
    if (s.spa.pageViewsAfter > 0)
      return drop('second-method-disagrees', `${s.spa.pageViewsAfter} page view(s) after the change of page`);
    return {
      ...base,
      fact: `Google Analytics records a page view when the homepage loads, but following the site's own link to ${pathOf(s.spa.to)} changes the page without a reload and sends no page view, so pages a visitor reaches this way are missing from the analytics reports`,
      evidence: {
        target: s.spa.to,
        value: s.pageViews.join(', '),
        methods: ['scan-tag-probe', 'browser-network-log'],
        ...evidenceBase(ctx),
      },
    };
  }

  if (s.consentDenied)
    return drop('second-method-disagrees', 'analytics consent is denied by default, so the linker stays off');
  const broken = s.linker.find((l) => !l.decorated && l.tids.some((t) => s.pageViews.includes(t)));
  if (!broken) {
    return drop(
      'second-method-disagrees',
      s.linker.map((l) => `${l.host} decorated=${l.decorated} tids=${l.tids.join('/') || 'none'}`).join('; ') ||
        'no sibling-domain link',
    );
  }
  const tid = broken.tids.find((t) => s.pageViews.includes(t))!;
  return {
    ...base,
    fact: `The homepage links to ${broken.host}, which reports to the same Google Analytics property (${tid}), but the link does not get Google's cross-domain parameter (_gl) when clicked, so a visitor who follows it arrives there as a new session and the source of the original visit is lost`,
    evidence: {
      target: broken.href,
      value: tid,
      methods: ['scan-tag-probe', 'browser-network-log'],
      ...evidenceBase(ctx),
    },
  };
}

/**
 * Teaser order: data the company is losing (analytics) and email anyone can forge in its name first,
 * then what a visitor runs into, then language and search problems, then real-user
 * speed, then outdated software. The platform is never the lead (design revision 3).
 */
const CAUSE_ORDER = [
  'analytics-data-loss',
  'email-authentication',
  'language-switch',
  'dead-navigation-links',
  'broken-images',
  'template-text',
  'missing-hreflang',
  'noindex',
  'sitemap-dead-urls',
  'real-user-performance',
  'tracking-before-consent',
  'unnamed-controls',
  'vulnerable-libraries',
  'end-of-life',
];
const causeRank = (cause: string) => {
  const i = CAUSE_ORDER.findIndex((c) => cause === c || cause.startsWith(`${c}:`));
  return i < 0 ? CAUSE_ORDER.length : i;
};

/**
 * One highlight per root cause, so a teaser shows three different problems and not one problem
 * three ways. The first highlight of a cause is kept; the rest are folded into its `also` list.
 */
export function groupByRootCause(passed: Highlight[], dropped: DroppedCandidate[]): Highlight[] {
  const byCause = new Map<string, Highlight>();
  for (const h of passed) {
    const kept = byCause.get(h.rootCause);
    if (!kept) {
      byCause.set(h.rootCause, { ...h, evidence: { ...h.evidence } });
      continue;
    }
    const other = h.evidence.target ?? h.url;
    kept.evidence.also = [...(kept.evidence.also ?? []), other];
    dropped.push({ type: h.type, reason: 'same-root-cause', rootCause: h.rootCause, detail: other });
  }
  const grouped = [...byCause.values()].sort((a, b) => causeRank(a.rootCause) - causeRank(b.rootCause));
  for (const h of grouped) {
    const more = h.evidence.also?.length ?? 0;
    if (!more) continue;
    if (h.type === 'dead-nav-link') h.fact += `; ${more} more navigation link${more === 1 ? ' does' : 's do'} the same`;
    if (h.type === 'broken-image')
      h.fact += `; ${more} more image${more === 1 ? '' : 's'} on the scanned pages ${more === 1 ? 'does' : 'do'} the same`;
    if (h.type === 'noindex')
      h.fact += `; ${more} more key page${more === 1 ? ' carries' : 's carry'} the same instruction`;
    if (h.type === 'template-text') h.fact += `; ${more} more page${more === 1 ? ' shows' : 's show'} the same`;
    if (h.type === 'analytics-gap')
      h.fact += `; the homepage loses analytics data in ${more} more way${more === 1 ? '' : 's'} too`;
    if (h.type === 'vulnerable-library')
      h.fact += `; ${more} more librar${more === 1 ? 'y' : 'ies'} on the site ${more === 1 ? 'has' : 'have'} a published advisory too`;
  }
  return grouped;
}

export async function runGate(
  run: RunData,
  stack: StackProfile | null,
  io: GateIo,
  options: GateOptions = {},
): Promise<GateResult> {
  const checkedAt = new Date().toISOString();
  const opts = {
    minCauses: options.minCauses ?? GATE_DEFAULTS.minCauses,
    vitalsMargin: options.vitalsMargin ?? GATE_DEFAULTS.vitalsMargin,
    minDeadSitemapUrls: options.minDeadSitemapUrls ?? GATE_DEFAULTS.minDeadSitemapUrls,
    today: options.today ?? checkedAt.slice(0, 10),
  };
  const dropped: DroppedCandidate[] = findingsNotOnAllowlist(run).map((f) => ({
    type: f.finding,
    reason: 'not-on-allowlist' as const,
    detail: f.reason,
  }));
  const disclosure = disclosureItems(run);

  const scanned = okPages(run);
  const home = run.metadata.leadScan?.home ?? scanned[0]?.url ?? null;
  const suspended = new Set(options.suspendedTypes ?? []);
  const candidates = buildCandidates(run, stack).filter((c) => !suspended.has(c.type));
  for (const type of suspended) {
    dropped.push({
      type,
      reason: 'type-suspended',
      detail: 'taken off the allowlist after a factual rejection; resume it once the cause is fixed',
    });
  }
  const requests = { n: 0 };

  let control: ControlResult = {
    homepage: null,
    randomMissing: null,
    blocked: true,
    statusUnreliable: true,
    note: 'no scanned page to check against',
  };
  let runtime: Record<string, string> | null = null;
  if (home) {
    const result = await runControl(originOf(home), io);
    control = result.control;
    requests.n += result.requests;
    // One page load in the gate's own browser: runtime versions, as a second kind of evidence.
    if (!control.blocked && io.browser && candidates.some((c) => c.type === 'end-of-life')) {
      requests.n++;
      runtime = (await io.browser.readRuntime(home))?.runtime ?? null;
    }
  }

  const ctx: CheckContext = { io, control, checkedAt, options: opts, dropped, requests, runtime };
  const passed: Highlight[] = [];
  for (const candidate of candidates) {
    let highlight: Highlight | null;
    switch (candidate.type) {
      case 'end-of-life':
        highlight = checkEol(candidate, ctx);
        break;
      case 'dead-nav-link':
        highlight = await checkDeadLink(candidate, ctx);
        break;
      case 'broken-image':
        highlight = await checkBrokenImage(candidate, ctx);
        break;
      case 'poor-vitals':
        highlight = checkVitals(candidate, ctx);
        break;
      case 'noindex':
        highlight = await checkNoindex(candidate, ctx);
        break;
      case 'template-text':
        highlight = await checkTemplateText(candidate, ctx);
        break;
      case 'missing-hreflang':
        highlight = await checkMissingHreflang(candidate, ctx);
        break;
      case 'sitemap-dead-urls':
        highlight = await checkSitemapDead(candidate, ctx);
        break;
      case 'vulnerable-library':
        highlight = await checkVulnerableLibrary(candidate, ctx);
        break;
      case 'tracking-before-consent':
        highlight = await checkTrackingBeforeConsent(candidate, ctx);
        break;
      case 'unnamed-controls':
        highlight = await checkUnnamedControls(candidate, ctx);
        break;
      case 'email-auth':
        highlight = await checkEmailAuth(candidate, ctx);
        break;
      case 'analytics-gap':
        highlight = await checkAnalyticsGap(candidate, ctx);
        break;
    }
    if (highlight) passed.push(highlight);
  }

  const highlights = groupByRootCause(passed, dropped);
  const causes = highlights.map((h) => h.rootCause);
  return {
    checkedAt,
    control,
    highlights,
    causes,
    teaserReady: causes.length >= opts.minCauses,
    candidatesDropped: dropped,
    disclosure,
    requestsSent: requests.n,
  };
}
