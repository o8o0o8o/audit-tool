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
import { blockReason, type PageFetcher, type PageSnapshot } from './fingerprint';
import { eolStatus } from './eol';
import { PRODUCTS } from './versions';
import { okPages, type RunData } from './run-data';
import {
  POOR_THRESHOLD,
  buildCandidates,
  findingsNotOnAllowlist,
  type BrokenImageCandidate,
  type DeadLinkCandidate,
  type EolCandidate,
  type FindingType,
  type NoindexCandidate,
  type VitalsCandidate,
} from './sales-signals';
import type { SignalKind, StackProfile } from './types';

export interface GateOptions {
  /** Distinct root causes needed before a teaser is built. */
  minCauses?: number;
  /** How far inside the "poor" band a real-user metric must be: 0.1 = 10% beyond the threshold. */
  vitalsMargin?: number;
  today?: string;
  /** Finding types taken off the allowlist after a factual rejection (see `review-log.ts`). */
  suspendedTypes?: string[];
}

export const GATE_DEFAULTS = { minCauses: 3, vitalsMargin: 0.1 } as const;

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
}

export interface GateIo {
  get: PageFetcher;
  browser?: GateBrowser | null;
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
  options: Required<Pick<GateOptions, 'minCauses' | 'vitalsMargin'>> & { today: string };
  dropped: DroppedCandidate[];
  requests: { n: number };
  runtime: Record<string, string> | null;
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
  if (n === 1) return 'on the page scanned';
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

/** Teaser order: stack-related first, then what a visitor sees, then what only tools see. */
const CAUSE_ORDER = [
  'end-of-life',
  'language-switch',
  'dead-navigation-links',
  'broken-images',
  'real-user-performance',
  'noindex',
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
    if (h.type === 'dead-nav-link') h.fact += `; ${more} more navigation link${more === 1 ? '' : 's'} do the same`;
    if (h.type === 'broken-image')
      h.fact += `; ${more} more image${more === 1 ? '' : 's'} on the scanned pages do the same`;
    if (h.type === 'noindex') h.fact += `; ${more} more key page${more === 1 ? '' : 's'} carry the same instruction`;
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
