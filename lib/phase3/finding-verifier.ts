/**
 * Deterministic finding verification pass for Phase 2 (`--verify`).
 *
 * For each deterministic finding, we pick its FIRST concrete example and
 * re-check the claim against the crawl data already on disk
 * (`pages/*.json.gz`). The point is to make every claim falsifiable: "these
 * pages share the same title" is true only if their captured titles actually
 * match; "missing canonical" is true only if the page really has none.
 *
 * Three verdicts:
 *   • confirmed  — the example re-checks out against the captured data.
 *   • refuted    — the captured data contradicts the claim (a false positive).
 *   • unchecked  — no verifier owns this finding kind, or the example page /
 *                  needed signal isn't on disk. We never drop these.
 *
 * No network, no LLM: the parsed `title`, `description`, `canonical`,
 * `redirectChain`, status code, `h1`, alt-image counts and `noindex` flag are
 * recorded for EVERY crawled page (not just the representative sample), so the
 * common site-wide findings re-check straight from disk. Findings whose first
 * example points at a non-crawled URL (e.g. a broken external link) or whose
 * signal isn't captured fall through to `unchecked` rather than a false drop.
 *
 * The caller (phase2-runner) auto-drops refuted findings — logging each with
 * its reason — and badges confirmed ones in a separate verified report, while
 * the original report stays untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { PageInfo } from '../types';
import type { IssueDetail } from '../phase2/types';
import { compareExamplesWorstFirst } from '../utils';
import { THRESHOLDS } from '../constants';
import { isVisualFinding } from '../phase2/categorize';
import { isPageCheckFinding, isSiteCheckFinding } from '../analyzers/site-checks/site-checks-types';

export type Verdict = 'confirmed' | 'refuted' | 'unchecked';

export interface VerificationResult {
  status: Verdict;
  /** Short human-readable justification, surfaced in logs and the report. */
  reason: string;
  /** The verifier kind that matched, or 'none' when unchecked. */
  kind: string;
}

/** Strip HTML tags and collapse whitespace — examples carry anchor markup. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimal HTML-entity unescape so a captured title compares to an example. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** Normalise a string value for equality (trim + collapse whitespace). */
function normValue(s: string): string {
  return unescapeHtml(s).replace(/\s+/g, ' ').trim();
}

/** Normalise a URL for lookup: drop the fragment and any trailing slash. */
function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    const href = url.href;
    return href.endsWith('/') ? href.slice(0, -1) : href;
  } catch {
    return u.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

/**
 * All distinct real http(s) URLs in an example string, in order. Templated
 * series keys (`…/page/{N}`) identify a series, not a crawled page, so they're
 * dropped — the verifier can't re-check a placeholder against on-disk pages.
 */
function extractUrls(s: string): string[] {
  return [...new Set((s.match(/https?:\/\/[^\s<>"']+/g) ?? []).filter((u) => !/[{}]/.test(u)))];
}

/** The first double- or smart-quoted value in a string, if any. */
function extractQuoted(s: string): string | undefined {
  const m = s.match(/"([^"]+)"/) ?? s.match(/[“”]([^“”]+)[“”]/);
  return m ? m[1] : undefined;
}

/** Read + gunzip a JSON file (handles both .json and .json.gz). */
function readMaybeGz<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * A url→PageInfo view over every crawled page, with normalized-URL fallback so
 * an example's trailing-slash/fragment variant still resolves to its page.
 */
export class PageIndex {
  private readonly exact = new Map<string, PageInfo>();
  private readonly norm = new Map<string, PageInfo>();

  add(url: string, page: PageInfo): void {
    this.exact.set(url, page);
    // First write wins for the normalized key so it's deterministic.
    const key = normUrl(url);
    if (!this.norm.has(key)) this.norm.set(key, page);
  }

  get(url: string): PageInfo | undefined {
    return this.exact.get(url) ?? this.norm.get(normUrl(url));
  }

  get size(): number {
    return this.exact.size;
  }

  /** All distinct crawled pages (by exact URL key). */
  all(): PageInfo[] {
    return [...this.exact.values()];
  }
}

/** Load every crawled page from `pages/*.json.gz` into a {@link PageIndex}. */
export function loadAllPages(runDir: string): PageIndex {
  const index = new PageIndex();
  const pagesDir = path.join(runDir, 'pages');
  if (!fs.existsSync(pagesDir)) return index;
  for (const file of fs.readdirSync(pagesDir).sort()) {
    const batch = readMaybeGz<{ pages?: Record<string, PageInfo> }>(path.join(pagesDir, file));
    if (!batch?.pages) continue;
    for (const [url, page] of Object.entries(batch.pages)) index.add(url, page);
  }
  return index;
}

/**
 * Load the site-level artifacts (`metadata.json.gz` + `incoming-links.json.gz`)
 * and derive the click-depth map by BFS from the homepage over the forward
 * graph. Returns `null` when neither artifact is present (older runs).
 */
export function loadSiteData(runDir: string, pages: PageIndex): SiteData | null {
  const incomingRaw =
    readMaybeGz<Record<string, string[]>>(path.join(runDir, 'incoming-links.json.gz')) ??
    readMaybeGz<Record<string, string[]>>(path.join(runDir, 'incoming-links.json'));
  const metadata =
    readMaybeGz<{
      robots?: { ['user-agent']?: Record<string, { disallow?: string[]; allow?: string[] }> };
      sitemaps?: { urls?: Record<string, unknown> };
    }>(path.join(runDir, 'metadata.json.gz')) ??
    readMaybeGz<{ robots?: unknown; sitemaps?: unknown }>(path.join(runDir, 'metadata.json'));

  if (!incomingRaw && !metadata) return null;

  // Inbound graph, normalized. Also build the forward graph for BFS.
  const incoming = new Map<string, string[]>();
  const forward = new Map<string, Set<string>>();
  for (const [dst, srcs] of Object.entries(incomingRaw ?? {})) {
    const nd = normUrl(dst);
    const nsrcs = (Array.isArray(srcs) ? srcs : []).map(normUrl);
    incoming.set(nd, nsrcs);
    for (const s of nsrcs) {
      if (!forward.has(s)) forward.set(s, new Set());
      forward.get(s)!.add(nd);
    }
  }

  // Homepage = the crawled page whose path is "/" (or the shortest origin URL).
  let homepage: string | undefined;
  for (const p of pages.all()) {
    try {
      const u = new URL(p.url);
      if (u.pathname === '/' || u.pathname === '') {
        homepage = normUrl(p.url);
        break;
      }
    } catch {
      /* ignore */
    }
  }

  // BFS click-depth from the homepage.
  const depthFromHome = new Map<string, number>();
  if (homepage) {
    depthFromHome.set(homepage, 0);
    let frontier = [homepage];
    let depth = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const u of frontier) {
        for (const v of forward.get(u) ?? []) {
          if (!depthFromHome.has(v)) {
            depthFromHome.set(v, depth + 1);
            next.push(v);
          }
        }
      }
      frontier = next;
      depth++;
    }
  }

  const ua = (metadata?.robots as { ['user-agent']?: Record<string, { disallow?: string[]; allow?: string[] }> } | undefined)?.[
    'user-agent'
  ];
  const robotsDisallow: string[] = [];
  for (const rules of Object.values(ua ?? {})) {
    if (Array.isArray(rules?.disallow)) robotsDisallow.push(...rules.disallow);
  }
  const robotsUserAgents = Object.keys(ua ?? {}).map((s) => s.toLowerCase());

  const sitemapUrls = new Set<string>();
  const urlsObj = (metadata?.sitemaps as { urls?: Record<string, unknown> } | undefined)?.urls;
  if (urlsObj && typeof urlsObj === 'object') for (const u of Object.keys(urlsObj)) sitemapUrls.add(normUrl(u));
  // The parser caps each sitemap at SITEMAP_LIMIT; at/over the cap the persisted
  // set may be missing URLs from a truncated/unread child sitemap.
  const sitemapCapped = sitemapUrls.size >= THRESHOLDS.SITEMAP_LIMIT;

  return { incoming, depthFromHome, robotsDisallow, robotsUserAgents, sitemapUrls, sitemapCapped };
}

// IMPORTANT: storage persists only a subset of `PageInfo`. These readers
// return `null` when the underlying signal was NOT captured for a page, so the
// verifiers can distinguish "the data contradicts the claim" (→ refute) from
// "we didn't record this" (→ unchecked). Never treat an absent field as proof
// the claim is false. Verified against on-disk batches: `headings.h1Count`,
// `foundIn` and `status` are reliable; `h1`, `noindex` and `redirectChain` are
// frequently absent; `title`/`description`/`canonical` are present only on
// HTML pages that had them.

/** The page title, trimmed; `null` when the field wasn't captured. */
const titleOf = (p: PageInfo): string | null => (typeof p.title === 'string' ? normValue(p.title) : null);
/** The meta description, trimmed; `null` when the field wasn't captured. */
const descOf = (p: PageInfo): string | null => (typeof p.description === 'string' ? normValue(p.description) : null);
/** Captured HTTP status (status / statusCode); undefined when absent. */
const statusOf = (p: PageInfo): number | undefined =>
  typeof p.status === 'number' ? p.status : typeof p.statusCode === 'number' ? p.statusCode : undefined;

/**
 * H1 count from the persisted heading analysis (`headings.h1` / `h1Count`) —
 * the same count the analyzer flagged on. The top-level `h1` array is a
 * fallback only; it is usually stripped during storage. `null` when no heading
 * data was captured.
 */
function h1CountOf(p: PageInfo): number | null {
  const h = p.headings as { h1?: unknown[]; h1Count?: number } | undefined;
  if (h) {
    if (Array.isArray(h.h1)) return h.h1.filter((x) => normValue(String(x)).length > 0).length;
    if (typeof h.h1Count === 'number') return h.h1Count;
  }
  if (Array.isArray(p.h1)) return p.h1.filter((x) => normValue(String(x)).length > 0).length;
  return null;
}

/** Loose view of the persisted indexability analysis (see disk inspection). */
type IndexabilitySignals = { isIndexable?: boolean; hasNoindexTag?: boolean } | undefined;
const indexabilityOf = (p: PageInfo): IndexabilitySignals => p.indexability as IndexabilitySignals;

/**
 * Was this page fully HTML-analyzed? Used as the gate for "missing X" checks:
 * for an analyzed page, an absent `title`/`description`/`canonical` genuinely
 * means the tag was missing (those fields are only set when present); for a
 * non-analyzed page (redirect, error, non-HTML) absence is meaningless. The
 * `indexability` block is the reliable "this page got the SEO pass" marker.
 */
const wasHtmlAnalyzed = (p: PageInfo): boolean => indexabilityOf(p) !== undefined;

/**
 * Tri-state presence of a tag-backed string field. present (non-empty) /
 * missing (empty, OR absent on an analyzed page) / null (absent, page not
 * analyzed → can't tell).
 */
function fieldPresence(value: string | undefined, analyzed: boolean): 'present' | 'missing' | null {
  if (typeof value === 'string') return value.trim().length > 0 ? 'present' : 'missing';
  return analyzed ? 'missing' : null;
}

const canonicalState = (p: PageInfo): 'present' | 'missing' | null => fieldPresence(p.canonical, wasHtmlAnalyzed(p));
const descriptionState = (p: PageInfo): 'present' | 'missing' | null => fieldPresence(p.description, wasHtmlAnalyzed(p));

/**
 * Tri-state noindex from the persisted `indexability.hasNoindexTag` (the field
 * that survives storage; top-level `noindex` is usually stripped). true /
 * false (analyzed, no noindex signal) / null (page not analyzed).
 */
function noindexState(p: PageInfo): boolean | null {
  const ix = indexabilityOf(p);
  if (ix?.hasNoindexTag === true) return true;
  if (p.noindex === true) return true;
  if (/(^|[\s,])noindex([\s,]|$)/i.test(p.metaRobots ?? '')) return true;
  if (ix !== undefined || p.noindex === false) return false;
  return null;
}

/**
 * Tri-state redirect from `hasRedirects` / `redirectCount` (both survive
 * storage; `redirectChain` is stripped). true / false (known not to redirect) /
 * null (no redirect signal captured).
 */
function redirectState(p: PageInfo): boolean | null {
  if (p.hasRedirects === true || (typeof p.redirectCount === 'number' && p.redirectCount > 0)) return true;
  const status = statusOf(p);
  if (typeof status === 'number' && status >= 300 && status < 400) return true;
  if (p.hasRedirects === false || typeof p.redirectCount === 'number' || typeof status === 'number') return false;
  return null;
}

/** Tri-state soft-404 from the persisted `soft404` block. */
function soft404State(p: PageInfo): boolean | null {
  const s = p.soft404 as { isSoft404?: boolean } | null | undefined;
  if (!s || typeof s.isSoft404 !== 'boolean') return null;
  return s.isSoft404;
}

/**
 * Site-level artifacts (robots.txt, sitemap, internal-link graph) that live in
 * `metadata.json.gz` / `incoming-links.json.gz` — NOT in the per-page JSONs.
 * Loaded once and threaded into every verifier so site-wide and link-graph
 * findings (orphan, unreachable, robots rules, sitemap membership) become
 * checkable. Absent → those verifiers stay `unchecked`.
 */
export interface SiteData {
  /** Inbound link graph: normalized url → normalized source urls. */
  incoming: Map<string, string[]>;
  /** Click depth from the homepage over the forward graph. Unreachable pages are
   *  ABSENT from the map (not stored as Infinity) — callers test `.has(url)`. */
  depthFromHome: Map<string, number>;
  /** robots.txt disallow patterns (across all user-agents). */
  robotsDisallow: string[];
  /** robots.txt user-agent tokens, lowercased. */
  robotsUserAgents: string[];
  /** Normalized URLs declared in the sitemap(s). */
  sitemapUrls: Set<string>;
  /** True when the persisted sitemap set may be incomplete (hit SITEMAP_LIMIT) —
   *  pages in an unread/capped child sitemap could be wrongly counted as
   *  "not listed", so count-only sitemap checks must stay `unchecked`. */
  sitemapCapped: boolean;
}

interface VerifierCtx {
  /** First example string the report would show (worst-first). */
  example: string;
  urls: string[];
  quoted?: string;
  pages: PageIndex;
  /** Site-level artifacts, when loaded (see {@link SiteData}). */
  site?: SiteData;
}

interface Verifier {
  kind: string;
  /** Match against the html-stripped, lowercased finding message. */
  match: (msg: string) => boolean;
  verify: (ctx: VerifierCtx) => VerificationResult;
}

const confirmed = (kind: string, reason: string): VerificationResult => ({ status: 'confirmed', reason, kind });
const refuted = (kind: string, reason: string): VerificationResult => ({ status: 'refuted', reason, kind });
const unchecked = (kind: string, reason: string): VerificationResult => ({ status: 'unchecked', reason, kind });

/**
 * Confirm a shared-value claim (duplicate titles / descriptions): the first
 * example clusters ≥2 URLs that should all carry the same `value`. Refuted only
 * when we can read every cited page AND their values genuinely differ.
 */
function verifyShared(
  kind: string,
  label: string,
  valueOf: (p: PageInfo) => string | null,
  ctx: VerifierCtx,
): VerificationResult {
  if (ctx.urls.length < 2) {
    // Single-cited "identical X" finding ("…is duplicated for this page <url>"):
    // confirm by scanning the FULL index for ≥2 crawled pages sharing the quoted
    // value. The quote may be truncated ("…to an…"), so match exact OR by prefix.
    // Confirm-only — a duplicate partner that wasn't crawled must not refute.
    if (ctx.quoted) {
      const raw = normValue(ctx.quoted);
      const prefix = raw.replace(/[.…]+$/, '').trim();
      if (prefix.length > 10) {
        const shareCount = ctx.pages
          .all()
          .filter((p) => {
            const v = valueOf(p);
            return v !== null && (v === raw || v.startsWith(prefix));
          }).length;
        if (shareCount >= 2) return confirmed(kind, `${shareCount} crawled pages share ${label} "${truncate(prefix)}"`);
      }
    }
    return unchecked(kind, `example lists <2 ${label} pages`);
  }
  const pages = ctx.urls.map((u) => ctx.pages.get(u));
  if (pages.some((p) => !p)) return unchecked(kind, 'one or more cited pages not found on disk');
  const values = (pages as PageInfo[]).map(valueOf);
  // If the value wasn't captured for every cited page we can't compare → don't
  // risk a false drop.
  if (values.some((v) => v === null)) return unchecked(kind, `${label} not captured for all cited pages`);
  const vals = values as string[];
  // Compare against the example's quoted value when present, else to each other.
  const target = ctx.quoted ? normValue(ctx.quoted) : vals[0];
  const allMatch = vals.every((v) => v === target && v.length > 0);
  if (allMatch) return confirmed(kind, `${ctx.urls.length} pages share ${label} "${truncate(target)}"`);
  const distinct = new Set(vals).size;
  return refuted(kind, `cited pages have ${distinct} distinct ${label}s, not one shared value`);
}

/**
 * Verify a single-page claim against the first example's URL.
 *
 * `refuteOk` gates the dangerous direction: when the predicate is false we only
 * REFUTE (auto-drop) if the page signal is an exact, unambiguous mirror of the
 * claim. For proxy signals (alt-image counts, HTTP-header noindex, redirect
 * reconstruction) a false predicate yields `unchecked` instead, so we never
 * drop a real finding our proxy merely failed to corroborate.
 */
function verifySingle(
  kind: string,
  ctx: VerifierCtx,
  predicate: (p: PageInfo) => boolean | null,
  okMsg: string,
  failMsg: string,
  refuteOk: boolean,
): VerificationResult {
  const url = ctx.urls[0];
  if (!url) return unchecked(kind, 'no URL in example');
  const page = ctx.pages.get(url);
  if (!page) return unchecked(kind, 'cited page not found on disk');
  const verdict = predicate(page);
  // null = the signal wasn't captured for this page → can't decide, don't drop.
  if (verdict === null) return unchecked(kind, 'required signal not captured for this page');
  if (verdict) return confirmed(kind, okMsg);
  return refuteOk ? refuted(kind, failMsg) : unchecked(kind, `could not corroborate (${failMsg})`);
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const wordCountOf = (p: PageInfo): number | undefined => {
  const cq = p.contentQuality as { wordCount?: number } | undefined;
  if (typeof cq?.wordCount === 'number') return cq.wordCount;
  return typeof p.wordCount === 'number' ? p.wordCount : undefined;
};

// ── Readers for the persisted analyzer sub-objects the new verifiers cross-check.
// Each returns the measured number/flag, or `undefined`/`null` when the signal
// wasn't captured (so the verifier stays `unchecked`, never a false drop).

/** Empty-anchor count from `anchorTextData.emptyAnchors` (array or number). */
function emptyAnchorCountOf(p: PageInfo): number | undefined {
  const a = p.anchorTextData as { emptyAnchors?: unknown } | undefined;
  if (!a) return undefined;
  if (Array.isArray(a.emptyAnchors)) return a.emptyAnchors.length;
  return typeof a.emptyAnchors === 'number' ? a.emptyAnchors : undefined;
}

type ImageOpt = { oversizedImages?: unknown; legacyFormats?: number; totalImageSize?: number } | undefined;
const imageOptOf = (p: PageInfo): ImageOpt => p.imageOptimization as ImageOpt;

/** Count of images displayed far smaller than their intrinsic size. */
function oversizedImageCountOf(p: PageInfo): number | undefined {
  const io = imageOptOf(p);
  if (!io) return undefined;
  return Array.isArray(io.oversizedImages) ? io.oversizedImages.length : undefined;
}

/** Total bytes of unused JS + CSS from `codeCoverage`. */
function unusedCodeBytesOf(p: PageInfo): number | undefined {
  const cc = p.codeCoverage as { js?: { unused?: number }; css?: { unused?: number } } | undefined;
  if (!cc) return undefined;
  const js = typeof cc.js?.unused === 'number' ? cc.js.unused : 0;
  const css = typeof cc.css?.unused === 'number' ? cc.css.unused : 0;
  return cc.js || cc.css ? js + css : undefined;
}

/** Percentage of CSS bytes that went unused (`codeCoverage.css.ratio`). */
function unusedCssRatioOf(p: PageInfo): number | undefined {
  const cc = p.codeCoverage as { css?: { ratio?: number } } | undefined;
  return typeof cc?.css?.ratio === 'number' ? cc.css.ratio : undefined;
}

/** Render-blocking resource count from `resourceOptimization.renderBlocking`. */
function renderBlockingCountOf(p: PageInfo): number | undefined {
  const ro = p.resourceOptimization as { renderBlocking?: { totalBlocking?: number } } | undefined;
  return typeof ro?.renderBlocking?.totalBlocking === 'number' ? ro.renderBlocking.totalBlocking : undefined;
}

type DomComplexity = { totalNodes?: number; maxChildren?: number } | undefined;
const domComplexityOf = (p: PageInfo): DomComplexity => p.domComplexityData as DomComplexity;

/** Total third-party transfer bytes from `thirdPartyData.totalSize`. */
function thirdPartySizeOf(p: PageInfo): number | undefined {
  const tp = p.thirdPartyData as { totalSize?: number } | undefined;
  return typeof tp?.totalSize === 'number' ? tp.totalSize : undefined;
}

/** True when tracking fired before consent (`consentData.trackingBeforeConsent`/`cookiesBeforeConsent`). */
function trackingBeforeConsentOf(p: PageInfo): boolean | null {
  const cd = p.consentData as { trackingBeforeConsent?: unknown; cookiesBeforeConsent?: unknown } | undefined;
  if (!cd) return null;
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);
  if (cd.trackingBeforeConsent === undefined && cd.cookiesBeforeConsent === undefined) return null;
  return len(cd.trackingBeforeConsent) > 0 || len(cd.cookiesBeforeConsent) > 0;
}

/** Local bar for "high % unused CSS" — the analyzer has no single constant; a
 *  conservative floor so confirm-only never over-confirms. */
const UNUSED_CSS_PCT_BAR = 40;
/** Click depth beyond which "more than N clicks from homepage" is confirmed. */
const CLICK_DEPTH_BAR = 4;
/** Inbound-link count at or below which "very low link equity" is confirmed. */
const LOW_EQUITY_BAR = 3;
/** AI-crawler user-agent tokens (lowercased) the robots-no-ai check looks for. */
const AI_CRAWLER_UAS = ['gptbot', 'claudebot', 'claude-web', 'perplexitybot', 'google-extended', 'ccbot', 'anthropic-ai', 'oai-searchbot', 'bytespider', 'amazonbot'];

/** AA / AAA contrast-failure counts from `colorContrastData`. */
function contrastFailuresOf(p: PageInfo, level: 'aa' | 'aaa'): number | undefined {
  const cc = p.colorContrastData as { aaFailures?: number; aaaFailures?: number } | undefined;
  if (!cc) return undefined;
  const v = level === 'aa' ? cc.aaFailures : cc.aaaFailures;
  return typeof v === 'number' ? v : undefined;
}

/** Count of external scripts missing SRI (`sriData.missingIntegrity`). */
function missingSriCountOf(p: PageInfo): number | undefined {
  const s = p.sriData as { missingIntegrity?: unknown } | undefined;
  if (!s) return undefined;
  return Array.isArray(s.missingIntegrity) ? s.missingIntegrity.length : undefined;
}

/** Tri-state "no Permissions-Policy header" from `permissionsPolicyData`. */
function noPermissionsPolicyOf(p: PageInfo): boolean | null {
  const pp = p.permissionsPolicyData as { hasPermissionsPolicy?: boolean } | undefined;
  if (!pp || typeof pp.hasPermissionsPolicy !== 'boolean') return null;
  return pp.hasPermissionsPolicy === false;
}

/** Tri-state "not cross-origin isolated" from `crossOriginPolicyData`. */
function notCrossOriginIsolatedOf(p: PageInfo): boolean | null {
  const co = p.crossOriginPolicyData as { isCrossOriginIsolated?: boolean } | undefined;
  if (!co || typeof co.isCrossOriginIsolated !== 'boolean') return null;
  return co.isCrossOriginIsolated === false;
}

/** Tri-state "no prefers-reduced-motion support" from `reducedMotionData`. */
function noReducedMotionOf(p: PageInfo): boolean | null {
  const rm = p.reducedMotionData as { hasReducedMotionQuery?: boolean } | undefined;
  if (!rm || typeof rm.hasReducedMotionQuery !== 'boolean') return null;
  return rm.hasReducedMotionQuery === false;
}

/** Count of form inputs missing the autocomplete attribute (`formData`). */
function inputsWithoutAutocompleteOf(p: PageInfo): number | undefined {
  const f = p.formData as { inputsWithoutAutocomplete?: number } | undefined;
  return typeof f?.inputsWithoutAutocomplete === 'number' ? f.inputsWithoutAutocomplete : undefined;
}

/** Total web-font files loaded (`fontData.totalFonts`). */
function totalFontsOf(p: PageInfo): number | undefined {
  const f = p.fontData as { totalFonts?: number } | undefined;
  return typeof f?.totalFonts === 'number' ? f.totalFonts : undefined;
}

/** Local bar for "too many font files" — the analyzer tracks byte sizes, not a
 *  file-count constant; 4 is a conservative confirm-only floor. */
const TOO_MANY_FONTS_BAR = 4;

type NumGet = (p: PageInfo) => number | undefined;

/**
 * Factory: verify a threshold finding by cross-checking the cited page's
 * PERSISTED metric against the same bar the analyzer used (`THRESHOLDS`). The
 * value comes from the stored field — not the example's self-reported number —
 * so a page that doesn't actually breach the threshold is a genuine false
 * positive. `dir='under'` only fires for a positive value below the bar (a
 * 0/absent value is "missing", a different finding). `refuteOk=false` for
 * proxy metrics whose exact bar we don't want to refute on.
 */
function numericVerifier(
  kind: string,
  match: (m: string) => boolean,
  get: NumGet,
  threshold: number,
  dir: 'over' | 'under',
  label: string,
  refuteOk = true,
): Verifier {
  return {
    kind,
    match,
    verify: (ctx) => {
      const url = ctx.urls[0];
      if (!url) return unchecked(kind, 'no URL in example');
      const p = ctx.pages.get(url);
      if (!p) return unchecked(kind, 'cited page not found on disk');
      const v = get(p);
      if (typeof v !== 'number' || Number.isNaN(v)) return unchecked(kind, `${label} not captured for this page`);
      const violates = dir === 'over' ? v > threshold : v > 0 && v < threshold;
      if (violates) return confirmed(kind, `${label} ${v} ${dir === 'over' ? '>' : '<'} ${threshold} threshold`);
      return refuteOk
        ? refuted(kind, `${label} ${v} does not breach the ${threshold} threshold`)
        : unchecked(kind, `${label} ${v} within bounds, but the finding's own bar may differ`);
    },
  };
}

/** Factory: verify a boolean per-page claim (tri-state predicate). */
function booleanVerifier(
  kind: string,
  match: (m: string) => boolean,
  predicate: (p: PageInfo) => boolean | null,
  okMsg: string,
  failMsg: string,
  refuteOk = true,
): Verifier {
  return { kind, match, verify: (ctx) => verifySingle(kind, ctx, predicate, okMsg, failMsg, refuteOk) };
}

/** Match a metric-threshold finding: the metric name AND a "more than N" phrase. */
const overMatch = (name: RegExp) => (m: string): boolean =>
  name.test(m) && /(more than|greater than|exceeds?|over)\b/.test(m);

/**
 * Ordered verifier registry — first match wins.
 *
 * Matchers are deliberately ANCHORED to the wording the analyzers actually emit
 * (see the message catalogue), with explicit exclusions, because a wrong match
 * can auto-drop a real finding. Two hard-won examples this guards against:
 *   • "Videos without accessible title" — NOT a page-`<title>` finding.
 *   • "Some pages have LCP more than 2500ms" — the "500" is not an HTTP 500.
 * Loose keyword soup matched both; the patterns below do not.
 *
 * `refuteOk: false` verifiers are confirm-only — their page signal is a proxy
 * (alt counts, header-based noindex, redirect reconstruction, sitemap origin),
 * so a non-match yields `unchecked`, never a drop. Refutation is reserved for
 * kinds whose claim mirrors an exact, captured field (titles, descriptions,
 * canonical presence, H1 count).
 */
const VERIFIERS: Verifier[] = [
  {
    // "Duplicate page titles found", "Duplicate titles detected". Excludes
    // near-duplicate (titles aren't identical) and keyword-cannibalisation.
    kind: 'duplicate-title',
    match: (m) =>
      /\btitles?\b/.test(m) && /(\bduplicate\b|\bidentical\b)/.test(m) && !/near-duplicate/.test(m) && !/keyword/.test(m) && !/description/.test(m),
    verify: (ctx) => verifyShared('duplicate-title', 'title', titleOf, ctx),
  },
  {
    // "Duplicate meta descriptions found".
    kind: 'duplicate-description',
    match: (m) => /descriptions?\b/.test(m) && /(\bduplicate\b|\bidentical\b)/.test(m) && !/near-duplicate/.test(m),
    verify: (ctx) => verifyShared('duplicate-description', 'description', descOf, ctx),
  },
  {
    // "Parameterized URLs share a title" — same-page faceted variants that
    // share a title. The claim is still "these cited pages share one title",
    // so the identical-value comparison applies unchanged.
    kind: 'duplicate-title-param',
    match: (m) => /parameterized/.test(m) && /\btitles?\b/.test(m) && !/description/.test(m),
    verify: (ctx) => verifyShared('duplicate-title-param', 'title', titleOf, ctx),
  },
  {
    // "Parameterized URLs share a description".
    kind: 'duplicate-description-param',
    match: (m) => /parameterized/.test(m) && /descriptions?\b/.test(m),
    verify: (ctx) => verifyShared('duplicate-description-param', 'description', descOf, ctx),
  },
  {
    // Page genuinely lacks a canonical. EXCLUDES the "wrong canonical" family
    // (canonicalised elsewhere, non-self-referencing, mismatch, tracking
    // params) where a canonical IS present — refuting those would be a false drop.
    kind: 'missing-canonical',
    match: (m) =>
      /canonical/.test(m) &&
      /(not set|missing|absent)/.test(m) &&
      !/(other url|self-referenc|incorrect|mismatch|tracking|param|paginated|different|hostname|protocol)/.test(m),
    verify: (ctx) =>
      verifySingle(
        'missing-canonical',
        ctx,
        // present (non-empty) → refute the "missing" claim; empty → confirm;
        // not captured → unchecked (can't prove absence from a stripped field).
        (p) => {
          const s = canonicalState(p);
          return s === null ? null : s === 'missing';
        },
        'page has no canonical URL',
        'page has a canonical URL',
        true,
      ),
  },
  {
    // "Some pages have more than one h1 tag". Reads the persisted heading count.
    // EXCLUDES keyword-cannibalisation ("Multiple pages target the same keyword
    // in their H1") — that is about distinct pages sharing a keyword, NOT one
    // page with several H1s, so refuting it on a single page's H1 count is a
    // false drop. Same guard the duplicate-title matcher uses against /keyword/.
    kind: 'multiple-h1',
    match: (m) =>
      /\bh1\b/.test(m) && /(more than one|multiple|several)/.test(m) && !/(keyword|target|cannibal|same keyword)/.test(m),
    verify: (ctx) =>
      verifySingle(
        'multiple-h1',
        ctx,
        (p) => {
          const c = h1CountOf(p);
          return c === null ? null : c > 1;
        },
        'page has multiple H1s',
        'page has 0 or 1 H1',
        true,
      ),
  },
  {
    // "Description meta tag is missing" / "meta description is missing".
    // Excludes duplicate + JS-rendered variants.
    kind: 'missing-description',
    match: (m) =>
      /description/.test(m) && /(missing|not set)/.test(m) && !/(duplicate|render|javascript|too|length|short|long)/.test(m),
    verify: (ctx) =>
      verifySingle(
        'missing-description',
        ctx,
        (p) => {
          const s = descriptionState(p);
          return s === null ? null : s === 'missing';
        },
        'page has no meta description',
        'page has a meta description',
        true,
      ),
  },
  {
    // "Soft 404 detected …", "Soft 404 page". Backed by the persisted `soft404`
    // block, so refute is safe: a page the detector marked not-soft-404
    // contradicts the claim.
    kind: 'soft-404',
    match: (m) => /soft[\s-]?404/.test(m),
    verify: (ctx) =>
      verifySingle(
        'soft-404',
        ctx,
        soft404State,
        'page is flagged as a soft 404',
        'page is not flagged as a soft 404',
        true,
      ),
  },
  {
    // "Image links without alt text" and per-page alt findings. Confirm-only:
    // imagesWithoutAltCount is a broader proxy than the specific finding subset.
    kind: 'missing-alt',
    match: (m) => /\balt (text|attribute)\b/.test(m) && /(without|missing|no\b|empty)/.test(m),
    verify: (ctx) =>
      verifySingle(
        'missing-alt',
        ctx,
        (p) => (typeof p.imagesWithoutAltCount === 'number' ? p.imagesWithoutAltCount > 0 : null),
        'page has images without alt text',
        'no images-without-alt recorded for this page',
        false,
      ),
  },
  {
    // "Pages in sitemap are marked noindex", "Paginated page is noindexed",
    // "X-Robots-Tag: noindex". Reads the persisted `indexability.hasNoindexTag`
    // (covers meta-robots AND X-Robots-Tag), so refute is safe for analyzed pages.
    kind: 'noindex',
    match: (m) => /noindex/.test(m),
    verify: (ctx) => verifySingle('noindex', ctx, noindexState, 'page is noindex', 'page is not marked noindex', true),
  },
  {
    // "3xx redirects in sitemap" / redirect-chain findings. Reads the persisted
    // `hasRedirects` / `redirectCount` (both survive storage). Refute is safe
    // when the cited URL resolves to a crawled page that did not redirect; if
    // the crawler keyed the page at its final URL the lookup misses → unchecked.
    kind: 'redirect',
    match: (m) => /\bredirects?\b/.test(m) && /(sitemap|chain|internal|link)/.test(m),
    verify: (ctx) =>
      verifySingle('redirect', ctx, redirectState, 'page redirects', 'page does not redirect', true),
  },
  {
    // "Indexable pages missing from sitemap". `foundIn` is reliably persisted,
    // so refute is safe: a page recorded as found IN the sitemap contradicts a
    // "missing from sitemap" claim. Excludes the many unrelated sitemap findings
    // (robots.txt, nested, invalid, framework integration, origin/changefreq/…).
    kind: 'not-in-sitemap',
    match: (m) =>
      /sitemap/.test(m) &&
      /(missing from|not (in|listed|included|found)|no sitemap entries|absent)/.test(m) &&
      !/(robots\.txt|nested|invalid|integration|plugin|declared|limit|origin|changefreq|trailing|duplicat|http instead)/.test(m),
    verify: (ctx) => {
      // Count-only finding ("45 indexable pages are not listed in the sitemap")
      // has no example URL — fall back to a site-level count from the index.
      const url = ctx.urls[0];
      if ((!url || !ctx.pages.get(url)) && ctx.site && ctx.site.sitemapUrls.size > 0) {
        // The sitemap set may be partial (capped child sitemaps); a page absent
        // from it could simply live in an unread sitemap — don't count it.
        if (ctx.site.sitemapCapped) {
          return unchecked('not-in-sitemap', 'sitemap set may be incomplete (hit URL cap)');
        }
        const n = ctx.pages.all().filter((p) => {
          const ix = p.indexability as { isIndexable?: boolean } | undefined;
          return ix?.isIndexable === true && !ctx.site!.sitemapUrls.has(normUrl(p.url));
        }).length;
        return n > 0
          ? confirmed('not-in-sitemap', `${n} indexable page(s) are not listed in the sitemap`)
          : unchecked('not-in-sitemap', 'all indexable pages appear in the sitemap');
      }
      return verifySingle(
        'not-in-sitemap',
        ctx,
        (p) => (p.foundIn === 'discovered' ? true : p.foundIn === 'sitemap' ? false : null),
        'page was discovered via crawl, not the sitemap',
        'page is recorded as found in the sitemap',
        true,
      );
    },
  },

  // ── Core Web Vitals & threshold findings ──────────────────────────────────
  // "Some pages have <METRIC> more than <N>". Cross-checks the persisted per-
  // page metric against the same THRESHOLD the analyzer used. The "more than"
  // gate keeps these off non-threshold mentions ("LCP image not preloaded").
  numericVerifier('lcp', overMatch(/\b(lcp|largest contentful paint)\b/), (p) => p.LCP ?? p.lcp, THRESHOLDS.LCP, 'over', 'LCP'),
  numericVerifier('fcp', overMatch(/\b(fcp|first contentful paint)\b/), (p) => p.FCP ?? p.fcp, THRESHOLDS.FCP, 'over', 'FCP'),
  numericVerifier('ttfb', overMatch(/\b(ttfb|time to first byte)\b/), (p) => p.TTFB ?? p.ttfb, THRESHOLDS.TTFB, 'over', 'TTFB'),
  numericVerifier('tbt', overMatch(/\b(tbt|total blocking time)\b/), (p) => p.TBT ?? p.tbt, THRESHOLDS.TBT, 'over', 'TBT'),
  numericVerifier('tti', overMatch(/\b(tti|time to interactive)\b/), (p) => p.TTI, THRESHOLDS.TTI, 'over', 'TTI'),
  numericVerifier('cls', overMatch(/\b(cls|cumulative layout shift)\b/), (p) => p.CLS ?? p.cls, THRESHOLDS.CLS, 'over', 'CLS'),
  numericVerifier('inp', overMatch(/\binp\b/), (p) => p.INP ?? p.inp, THRESHOLDS.INP, 'over', 'INP'),

  // ── Size / count / length thresholds ──────────────────────────────────────
  numericVerifier('too-many-h2', (m) => /\bh2\b/.test(m) && /more than/.test(m),
    // `headings.h2Count` is the field that survives storage; the `h2` array is
    // usually stripped. Confirm-only: the analyzer's bar can differ per finding.
    (p) => { const h = p.headings as { h2?: unknown[]; h2Count?: number } | undefined;
      if (Array.isArray(h?.h2)) return h!.h2!.length;
      return typeof h?.h2Count === 'number' ? h.h2Count : undefined; },
    THRESHOLDS.H2_COUNT, 'over', 'H2 count', false),
  numericVerifier('too-many-requests', (m) => /requests?\b/.test(m) && /(too many|more than)/.test(m),
    (p) => p.totalNumberOfRequests ?? p.requestCount, THRESHOLDS.REQUEST_COUNT, 'over', 'request count'),
  numericVerifier('page-too-big', (m) => /size is too big|(page|document)\b.*too (big|large)/.test(m),
    (p) => p.totalResponseSize ?? p.pageSize ?? p.totalSize, THRESHOLDS.PAGE_SIZE, 'over', 'page size'),
  numericVerifier('title-too-long', (m) => /title/.test(m) && /too long/.test(m), (p) => p.titleLength, THRESHOLDS.TITLE_MAX, 'over', 'title length'),
  numericVerifier('title-too-short', (m) => /title/.test(m) && /too short/.test(m), (p) => p.titleLength, THRESHOLDS.TITLE_MIN, 'under', 'title length'),
  numericVerifier('desc-too-long', (m) => /description/.test(m) && /too long/.test(m), (p) => p.descriptionLength, THRESHOLDS.DESCRIPTION_MAX, 'over', 'description length'),
  numericVerifier('desc-too-short', (m) => /description/.test(m) && /too short/.test(m), (p) => p.descriptionLength, THRESHOLDS.DESCRIPTION_MIN, 'under', 'description length'),

  // ── Content volume (confirm-only: the analyzer's "thin" bar varies) ───────
  numericVerifier('thin-content', (m) => /(very thin content|thin content|low content|has low content|page has low content)/.test(m),
    wordCountOf, THRESHOLDS.CONTENT_RECOMMENDED, 'under', 'word count', false),
  numericVerifier('expand-content', (m) => /content could be expanded|could be expanded/.test(m),
    wordCountOf, THRESHOLDS.CONTENT_RECOMMENDED, 'under', 'word count', false),

  // ── Boolean per-page checks ───────────────────────────────────────────────
  booleanVerifier('console-errors', (m) => /console error/.test(m),
    (p) => { const c = p.consoleAnalysis as { errorCount?: number; errors?: unknown[] } | undefined; if (!c) return null;
      const n = typeof c.errorCount === 'number' ? c.errorCount : Array.isArray(c.errors) ? c.errors.length : undefined;
      return typeof n === 'number' ? n > 0 : null; },
    'page has console errors', 'page has no console errors recorded', true),
  booleanVerifier('broken-outbound-page', (m) => /page has \d+ broken outbound link|broken outbound link\(s\)/.test(m),
    (p) => { const o = p.outboundLinkHealth as { broken?: unknown } | undefined; if (!o) return null;
      const b = Array.isArray(o.broken) ? o.broken.length : typeof o.broken === 'number' ? o.broken : undefined;
      return typeof b === 'number' ? b > 0 : null; },
    'page has broken outbound links', 'no broken outbound links recorded for this page', true),
  booleanVerifier('author-missing', (m) => /(no author information|lacks? author attribution|without author attribution|missing author)/.test(m),
    (p) => { const e = p.eeat as { author?: unknown } | undefined; if (!e) return null;
      return !(typeof e.author === 'string' && e.author.trim().length > 0); },
    'page has no author attribution', 'page has author attribution', true),

  // ── Confirm-only checks against rich analyzer sub-objects ─────────────────
  // These proxy a broader analyzer subset than the exact finding, so they only
  // CONFIRM from disk (refuteOk=false) — a non-match stays `unchecked`, never a
  // false drop. Matchers are anchored to the analyzer's emitted wording.

  // "Empty anchor text", "Links with empty anchor text", "Many links with empty
  // anchor text", "Some pages have links without any text". EXCLUDES the other
  // anchor findings (over-optimization, diversity, duplicate, same-anchor).
  booleanVerifier('empty-anchor', (m) => /empty anchor/.test(m) || /links? without any text/.test(m),
    (p) => { const n = emptyAnchorCountOf(p); return typeof n === 'number' ? n > 0 : null; },
    'page has empty-anchor links', 'no empty anchors recorded for this page', false),

  // "Pages have image files larger than recommended" — backed by the BYTE-size
  // `oversizedImages` list. The display-scaling finding ("…larger than their
  // display size") is a DIFFERENT message backed by different data and is owned
  // by the live verifier; matching it here would badge it from byte-size data.
  booleanVerifier('oversized-images', (m) => /image files? larger than recommended/.test(m),
    (p) => { const n = oversizedImageCountOf(p); return typeof n === 'number' ? n > 0 : null; },
    'page has image files larger than recommended', 'no oversized image files recorded for this page', false),

  // "Pages serve images only as JPG/PNG instead of WebP/AVIF".
  booleanVerifier('legacy-image-format', (m) => /(webp|avif)/.test(m) && /(jpg|jpeg|png|legacy|instead)/.test(m),
    (p) => { const io = imageOptOf(p); return typeof io?.legacyFormats === 'number' ? io.legacyFormats > 0 : null; },
    'page serves legacy-format images', 'no legacy-format images recorded for this page', false),

  // "Some pages have excessive total image size".
  numericVerifier('excessive-image-size', (m) => /image/.test(m) && /(excessive|too (big|large)).*(size|image)|excessive total image/.test(m),
    (p) => imageOptOf(p)?.totalImageSize, THRESHOLDS.TOTAL_IMAGE_SIZE_MAX, 'over', 'total image size', false),

  // "Large amount of unused code" — unused JS+CSS bytes.
  numericVerifier('unused-code', (m) => /unused (code|javascript|js)/.test(m) && !/css/.test(m),
    unusedCodeBytesOf, THRESHOLDS.UNUSED_CODE_BYTES_WARNING, 'over', 'unused code bytes', false),

  // "High percentage of unused CSS".
  numericVerifier('unused-css', (m) => /unused css/.test(m),
    unusedCssRatioOf, UNUSED_CSS_PCT_BAR, 'over', 'unused CSS %', false),

  // "Some pages have too many render-blocking resources".
  numericVerifier('render-blocking', (m) => /render-?blocking/.test(m) && !/third-party/.test(m),
    renderBlockingCountOf, THRESHOLDS.RENDER_BLOCKING_MAX, 'over', 'render-blocking resources', false),

  // "Element with too many children".
  numericVerifier('dom-children', (m) => /(element|node)/.test(m) && /too many children/.test(m),
    (p) => domComplexityOf(p)?.maxChildren, THRESHOLDS.DOM_CHILDREN_WARNING, 'over', 'max element children', false),

  // "Excessive DOM size" (large node count). Note: "Large HTML document" is a
  // byte-size finding (both size bands collapsed into it, report-rules.md §5),
  // not node-count — it intentionally falls through to the LLM/CLI pass.
  numericVerifier('excessive-dom', (m) => /(excessive dom|dom size|too many (dom )?nodes)/.test(m),
    (p) => domComplexityOf(p)?.totalNodes, THRESHOLDS.DOM_NODES_WARNING, 'over', 'DOM node count', false),

  // "Large third-party payload" (both size bands collapsed into it, §5).
  numericVerifier('third-party-payload', (m) => /third-?party/.test(m) && /(payload|size|bytes|weight)/.test(m),
    thirdPartySizeOf, THRESHOLDS.THIRD_PARTY_SIZE_WARNING, 'over', 'third-party payload', false),

  // "Multiple tracking cookies set before consent". Anchored to a cookie/tracking
  // subject so it can't match unrelated "before consent" wording.
  booleanVerifier('tracking-before-consent', (m) => /(tracking|cookies?|trackers?).{0,40}before consent/.test(m),
    trackingBeforeConsentOf, 'page fired tracking/cookies before consent', 'no pre-consent tracking recorded for this page', false),

  // "Color contrast passes AA but fails AAA (N elements)" → aaaFailures. Listed
  // BEFORE the AA matcher since this wording contains "AA" too.
  numericVerifier('contrast-aaa', (m) => /color contrast/.test(m) && /aaa/.test(m),
    (p) => contrastFailuresOf(p, 'aaa'), 0, 'over', 'AAA contrast failures', false),
  // "Color contrast fails WCAG AA (N elements)" → aaFailures (excludes the AAA wording).
  numericVerifier('contrast-aa', (m) => /color contrast/.test(m) && /\baa\b/.test(m) && !/aaa/.test(m),
    (p) => contrastFailuresOf(p, 'aa'), 0, 'over', 'AA contrast failures', false),

  // "External scripts missing Subresource Integrity (SRI)".
  numericVerifier('sri-missing', (m) => /subresource integrity|\bsri\b/.test(m),
    missingSriCountOf, 0, 'over', 'scripts missing SRI', false),

  // "Form inputs missing autocomplete attribute".
  numericVerifier('autocomplete-missing', (m) => /autocomplete/.test(m),
    inputsWithoutAutocompleteOf, 0, 'over', 'inputs missing autocomplete', false),

  // "Missing Permissions-Policy header".
  booleanVerifier('permissions-policy', (m) => /permissions-policy/.test(m) && /(missing|no\b|absent|without)/.test(m),
    noPermissionsPolicyOf, 'page sends no Permissions-Policy header', 'page sends a Permissions-Policy header', false),

  // "Missing cross-origin isolation headers".
  booleanVerifier('cross-origin-isolation', (m) => /cross-origin isolation/.test(m),
    notCrossOriginIsolatedOf, 'page is not cross-origin isolated', 'page is cross-origin isolated', false),

  // "No prefers-reduced-motion CSS support".
  booleanVerifier('reduced-motion', (m) => /prefers-reduced-motion/.test(m),
    noReducedMotionOf, 'page has no prefers-reduced-motion support', 'page supports prefers-reduced-motion', false),

  // "Too many font files loaded".
  numericVerifier('too-many-fonts', (m) => /font files|fonts loaded|too many fonts/.test(m),
    totalFontsOf, TOO_MANY_FONTS_BAR, 'over', 'font files', false),

  // ── Site-level checks against the link graph + robots + sitemap ────────────
  // These read ctx.site (loaded from incoming-links.json.gz / metadata.json.gz),
  // not a per-page JSON. All confirm-only: the graph/sitemap can be incomplete,
  // so a non-match stays `unchecked`, never a drop.

  // "Orphan page (no internal links point to it)".
  {
    kind: 'orphan-page',
    match: (m) => /orphan/.test(m) && /(internal link|no .*link|point to it)/.test(m),
    verify: (ctx) => {
      if (!ctx.site) return unchecked('orphan-page', 'no link-graph data loaded');
      const url = ctx.urls[0];
      if (!url) return unchecked('orphan-page', 'no URL in example');
      const inc = ctx.site.incoming.get(normUrl(url));
      if (inc && inc.length > 0) return unchecked('orphan-page', `${inc.length} internal link(s) point to this page`);
      // The graph lists every linked-to page, so a CRAWLED page absent from it
      // (or present with an empty list) genuinely has no inbound internal links.
      if (inc === undefined && !ctx.pages.get(url))
        return unchecked('orphan-page', 'cited page neither crawled nor in the link graph');
      return confirmed('orphan-page', 'no internal links point to this page');
    },
  },
  // "Page unreachable from homepage via internal links".
  {
    kind: 'unreachable',
    match: (m) => /unreachable from (the )?homepage/.test(m),
    verify: (ctx) => {
      if (!ctx.site) return unchecked('unreachable', 'no link-graph data loaded');
      const url = ctx.urls[0];
      if (!url) return unchecked('unreachable', 'no URL in example');
      if (ctx.site.depthFromHome.size === 0) return unchecked('unreachable', 'homepage/graph not resolved');
      return ctx.site.depthFromHome.has(normUrl(url))
        ? unchecked('unreachable', 'page IS reachable from the homepage')
        : confirmed('unreachable', 'page is not reachable from the homepage via internal links');
    },
  },
  // "Page is more than N clicks from homepage".
  {
    kind: 'click-depth',
    match: (m) => /\bclicks?\b/.test(m) && /(from (the )?homepage|deep)/.test(m),
    verify: (ctx) => {
      if (!ctx.site) return unchecked('click-depth', 'no link-graph data loaded');
      const url = ctx.urls[0];
      if (!url) return unchecked('click-depth', 'no URL in example');
      const d = ctx.site.depthFromHome.get(normUrl(url));
      if (d === undefined) return unchecked('click-depth', 'cited page not reached in BFS');
      return d > CLICK_DEPTH_BAR
        ? confirmed('click-depth', `page is ${d} clicks from the homepage`)
        : unchecked('click-depth', `page is only ${d} clicks from the homepage`);
    },
  },
  // "Page has very low internal link equity".
  {
    kind: 'low-link-equity',
    match: (m) => /(low|few).*(internal link|link equity)/.test(m),
    verify: (ctx) => {
      if (!ctx.site) return unchecked('low-link-equity', 'no link-graph data loaded');
      const url = ctx.urls[0];
      if (!url) return unchecked('low-link-equity', 'no URL in example');
      const inc = ctx.site.incoming.get(normUrl(url));
      if (inc === undefined) return unchecked('low-link-equity', 'cited page not in the link graph');
      return inc.length <= LOW_EQUITY_BAR
        ? confirmed('low-link-equity', `only ${inc.length} internal link(s) point to this page`)
        : unchecked('low-link-equity', `${inc.length} internal links point to this page`);
    },
  },
  // "Sensitive paths exposed in robots.txt".
  {
    kind: 'robots-sensitive',
    match: (m) => /robots\.txt/.test(m) && /(sensitive|exposed|reveal)/.test(m),
    verify: (ctx) =>
      !ctx.site
        ? unchecked('robots-sensitive', 'no robots data loaded')
        : ctx.site.robotsDisallow.length > 0
          ? confirmed('robots-sensitive', `robots.txt discloses ${ctx.site.robotsDisallow.length} disallowed path(s)`)
          : unchecked('robots-sensitive', 'no disallow rules recorded'),
  },
  // "Pattern matching characters used in robots.txt".
  {
    kind: 'robots-wildcards',
    match: (m) => /robots\.txt/.test(m) && /(pattern matching|wildcard|\*|\$)/.test(m),
    verify: (ctx) =>
      !ctx.site
        ? unchecked('robots-wildcards', 'no robots data loaded')
        : ctx.site.robotsDisallow.some((d) => /[*$]/.test(d))
          ? confirmed('robots-wildcards', 'robots.txt uses * or $ wildcards')
          : unchecked('robots-wildcards', 'no wildcard patterns recorded'),
  },
  // "No explicit AI crawler rules in robots.txt".
  {
    kind: 'robots-no-ai',
    match: (m) => /robots\.txt/.test(m) && /(ai crawler|gptbot|claudebot|ai bot)/.test(m),
    verify: (ctx) => {
      if (!ctx.site) return unchecked('robots-no-ai', 'no robots data loaded');
      const hasAi = ctx.site.robotsUserAgents.some((ua) => AI_CRAWLER_UAS.some((b) => ua.includes(b)));
      return hasAi
        ? unchecked('robots-no-ai', 'robots.txt DOES name an AI crawler')
        : confirmed('robots-no-ai', 'robots.txt names no AI crawler user-agents');
    },
  },
  // "Sitemap URLs were not successfully crawled".
  {
    kind: 'sitemap-not-crawled',
    match: (m) => /sitemap/.test(m) && /(not (successfully )?crawled|failed to crawl|uncrawled)/.test(m),
    verify: (ctx) => {
      // Prefer the URLs the example itself cites as uncrawled — most direct.
      if (ctx.urls.length > 0) {
        const missing = ctx.urls.filter((u) => !ctx.pages.get(u));
        return missing.length > 0
          ? confirmed('sitemap-not-crawled', `${missing.length} cited sitemap URL(s) are absent from the crawl`)
          : unchecked('sitemap-not-crawled', 'all cited sitemap URLs were crawled');
      }
      if (!ctx.site || ctx.site.sitemapUrls.size === 0) return unchecked('sitemap-not-crawled', 'no sitemap data loaded');
      const missing = [...ctx.site.sitemapUrls].filter((u) => !ctx.pages.get(u));
      return missing.length > 0
        ? confirmed('sitemap-not-crawled', `${missing.length} sitemap URL(s) were not crawled`)
        : unchecked('sitemap-not-crawled', 'all sitemap URLs were crawled');
    },
  },
];

/** Pick the example the report would show first (worst-first, then stable). */
export function firstExample(detail: IssueDetail): string | undefined {
  const examples = detail.examples ?? [];
  if (examples.length === 0) return undefined;
  return [...examples].sort(compareExamplesWorstFirst)[0];
}

/**
 * Verify a single finding's first example. AI-discovered findings are never
 * machine-verifiable here (they describe emergent issues) → always unchecked.
 */
export function verifyFinding(message: string, detail: IssueDetail, pages: PageIndex, site?: SiteData): VerificationResult {
  if (detail.aiDiscovered) return unchecked('ai-discovered', 'AI-discovered finding — not deterministically verifiable');
  if (isVisualFinding(message)) return unchecked('visual', 'rendered-page defect — not re-checkable from crawl data');
  if (isSiteCheckFinding(message) || isPageCheckFinding(message))
    return unchecked('domain-exposure', 'domain & exposure check — not re-checkable from crawl data');
  const example = firstExample(detail);
  if (!example) return unchecked('none', 'finding has no example to verify');

  const msg = stripTags(message).toLowerCase();
  const verifier = VERIFIERS.find((v) => v.match(msg));
  if (!verifier) return unchecked('none', 'no deterministic verifier for this finding kind');

  return verifier.verify({
    example,
    urls: extractUrls(example),
    quoted: extractQuoted(example),
    pages,
    site,
  });
}

export interface VerificationSummary {
  results: Map<string, VerificationResult>;
  confirmed: Set<string>;
  refuted: Set<string>;
  confirmedCount: number;
  refutedCount: number;
  uncheckedCount: number;
}

/**
 * Verify every finding in a prepared details map. Returns the per-message
 * verdicts plus the confirmed/refuted message sets the report renderer needs.
 */
export function verifyDetails(details: Record<string, IssueDetail>, pages: PageIndex, site?: SiteData): VerificationSummary {
  const results = new Map<string, VerificationResult>();
  const confirmedSet = new Set<string>();
  const refutedSet = new Set<string>();
  let uncheckedCount = 0;

  for (const [message, detail] of Object.entries(details)) {
    const result = verifyFinding(message, detail, pages, site);
    results.set(message, result);
    if (result.status === 'confirmed') confirmedSet.add(message);
    else if (result.status === 'refuted') refutedSet.add(message);
    else uncheckedCount++;
  }

  return {
    results,
    confirmed: confirmedSet,
    refuted: refutedSet,
    confirmedCount: confirmedSet.size,
    refutedCount: refutedSet.size,
    uncheckedCount,
  };
}

/** Drop undefined/null entries so the LLM payload stays compact. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Curated, compact snapshot of a page's measured signals for the LLM fallback.
 * Broad on purpose — the LLM decides which fields bear on a given finding.
 * Returns {} when the page wasn't crawled (off-site / site-level findings).
 */
export function buildPageSignals(page: PageInfo | undefined): Record<string, unknown> {
  if (!page) return {};
  const ix = indexabilityOf(page);
  const cq = page.contentQuality as { wordCount?: number; textToHtmlRatio?: number; contentScore?: number } | undefined;
  const cons = page.consoleAnalysis as { errorCount?: number; warningCount?: number } | undefined;
  const oh = page.outboundLinkHealth as { broken?: unknown; totalChecked?: number } | undefined;
  const sf = page.soft404 as { isSoft404?: boolean; confidence?: number } | undefined;
  const md = page.mediaData as { videoCount?: number; audioCount?: number } | undefined;
  const ee = page.eeat as Record<string, unknown> | undefined;
  const la = page.linkAnalysis as { internalLinks?: number; externalLinks?: number; brokenLinks?: number } | undefined;
  const headingsObj = page.headings as { h2?: unknown[]; h2Count?: number } | undefined;
  const h2 = headingsObj?.h2;
  const h2Count = Array.isArray(h2) ? h2.length : typeof headingsObj?.h2Count === 'number' ? headingsObj.h2Count : undefined;
  const font = page.fontData as { totalFonts?: number } | undefined;
  const form = page.formData as { totalInputs?: number; inputsWithoutAutocomplete?: number; inputsWithoutLabels?: number } | undefined;
  const af = page.aboveFoldData as { lcpInViewport?: boolean; renderBlockingResources?: number } | undefined;
  const dep = page.deprecatedHtmlData as { totalDeprecated?: number } | undefined;

  // Rich analyzer sub-objects — the measured numbers the findings are about.
  const dom = page.domComplexityData as { totalNodes?: number; maxChildren?: number; bodyChildren?: number; maxDepth?: number } | undefined;
  const ro = page.resourceOptimization as { renderBlocking?: { totalBlocking?: number }; minification?: { unminifiedJS?: number; unminifiedCSS?: number } } | undefined;
  const at = page.anchorTextData as Record<string, number> | undefined;
  const tp = page.thirdPartyData as { totalScripts?: number; totalSize?: number } | undefined;
  const cd = page.consentData as { hasConsentBanner?: boolean; totalCookies?: number; thirdPartyCookies?: number; cookiesBeforeConsent?: number; trackingBeforeConsent?: number; cookies?: Array<{ name?: string; isThirdParty?: boolean; expires?: number }> } | undefined;
  const sd = page.structuredData as { hasStructuredData?: boolean; total?: number; jsonLdSchemas?: unknown[] } | undefined;
  const fr = page.freshnessData as { lastModified?: unknown; datePublished?: unknown; dateModified?: unknown; freshnessScore?: number; ageInDays?: number } | undefined;
  const pwa = page.pwaData as Record<string, unknown> | undefined;
  const ccov = page.codeCoverage as { unusedRatio?: number; totalUnusedBytes?: number; css?: { ratio?: number }; js?: { ratio?: number } } | undefined;
  const io = page.imageOptimization as Record<string, number> | undefined;
  const a11y = page.accessibility as { violationCount?: number; a11yScore?: number } | undefined;
  const sm = page.socialMedia as { hasOpenGraph?: boolean; hasTwitterCard?: boolean } | undefined;
  const aeo = page.aeo as Record<string, unknown> | undefined;
  const tech = page.technical as { metaRefresh?: unknown; preload?: unknown; prefetch?: unknown; dns_prefetch?: unknown } | undefined;
  const sec = page.security as { securityScore?: number; missingHeaders?: unknown[]; mixedContent?: unknown } | undefined;
  const el = page.externalLinksData as { totalExternalLinks?: number; brokenLinks?: number; linksByDomain?: Record<string, unknown> } | undefined;
  const ua = page.urlAnalysis as { depth?: number; length?: number; hasTrackingParams?: boolean } | undefined;

  return compact({
    status: statusOf(page),
    foundIn: page.foundIn,
    lang: page.lang,
    title: typeof page.title === 'string' ? truncate(page.title, 120) : undefined,
    titleLength: page.titleLength,
    hasCanonical: canonicalState(page) === 'present' ? true : canonicalState(page) === 'missing' ? false : undefined,
    descriptionLength: page.descriptionLength,
    wordCount: wordCountOf(page),
    textToHtmlRatio: cq?.textToHtmlRatio,
    contentScore: cq?.contentScore,
    h1Count: h1CountOf(page) ?? undefined,
    h2Count,
    totalFonts: font?.totalFonts,
    formInputs: form?.totalInputs,
    inputsWithoutAutocomplete: form?.inputsWithoutAutocomplete,
    inputsWithoutLabels: form?.inputsWithoutLabels,
    lcpInViewport: af?.lcpInViewport,
    aboveFoldRenderBlocking: af?.renderBlockingResources,
    deprecatedHtmlElements: dep?.totalDeprecated,
    LCP: page.LCP ?? page.lcp,
    FCP: page.FCP ?? page.fcp,
    TTFB: page.TTFB ?? page.ttfb,
    TBT: page.TBT ?? page.tbt,
    TTI: page.TTI,
    CLS: page.CLS ?? page.cls,
    INP: page.INP ?? page.inp,
    totalResponseSize: page.totalResponseSize ?? page.pageSize,
    requestCount: page.totalNumberOfRequests ?? page.requestCount,
    imagesWithoutAltCount: page.imagesWithoutAltCount,
    consoleErrors: cons?.errorCount,
    consoleWarnings: cons?.warningCount,
    brokenOutboundLinks: Array.isArray(oh?.broken) ? oh!.broken!.length : typeof oh?.broken === 'number' ? oh.broken : undefined,
    soft404: sf ? { isSoft404: sf.isSoft404, confidence: sf.confidence } : undefined,
    isIndexable: ix?.isIndexable,
    noindex: noindexState(page) ?? undefined,
    hasRedirects: page.hasRedirects,
    redirectCount: page.redirectCount,
    videoCount: md?.videoCount,
    audioCount: md?.audioCount,
    internalLinks: la?.internalLinks,
    externalLinks: la?.externalLinks,
    author: typeof ee?.author === 'string' && (ee.author as string).trim() ? true : ee ? false : undefined,
    publishDate: ee?.publishDate ? true : undefined,
    isYMYL: ee?.isYMYL,

    // ── Rich sub-objects (the measured numbers the findings cite) ───────────
    dom: dom ? compact({ totalNodes: dom.totalNodes, maxChildren: dom.maxChildren, bodyChildren: dom.bodyChildren, maxDepth: dom.maxDepth }) : undefined,
    renderBlocking: ro?.renderBlocking?.totalBlocking,
    unminifiedJS: ro?.minification?.unminifiedJS,
    unminifiedCSS: ro?.minification?.unminifiedCSS,
    anchors: at
      ? compact({
          totalLinks: at.totalLinks,
          emptyAnchors: at.emptyAnchors,
          genericAnchors: at.genericAnchors,
          duplicateAnchors: at.duplicateAnchors,
          imageOnlyLinks: at.imageOnlyLinks,
          avgAnchorLength: at.avgAnchorLength,
        })
      : undefined,
    thirdParty: tp ? compact({ totalScripts: tp.totalScripts, totalSizeBytes: tp.totalSize }) : undefined,
    cookies: cd
      ? compact({
          hasConsentBanner: cd.hasConsentBanner,
          totalCookies: cd.totalCookies,
          thirdPartyCookies: cd.thirdPartyCookies,
          cookiesBeforeConsent: cd.cookiesBeforeConsent,
          trackingBeforeConsent: cd.trackingBeforeConsent,
          // Far-future `expires` (epoch seconds) backs the "excessive lifespan" finding.
          sample: Array.isArray(cd.cookies)
            ? cd.cookies.slice(0, 20).map((c) => ({ name: c.name, thirdParty: c.isThirdParty, expires: c.expires }))
            : undefined,
        })
      : undefined,
    structuredData: sd
      ? compact({ hasStructuredData: sd.hasStructuredData, count: sd.total, types: Array.isArray(sd.jsonLdSchemas) ? sd.jsonLdSchemas.length : undefined })
      : undefined,
    freshness: fr
      ? compact({ lastModified: fr.lastModified ? true : false, datePublished: fr.datePublished ? true : false, dateModified: fr.dateModified ? true : false, freshnessScore: fr.freshnessScore, ageInDays: fr.ageInDays })
      : undefined,
    pwa: pwa
      ? compact({ hasManifest: pwa.hasManifest, hasServiceWorker: pwa.hasServiceWorker, hasThemeColor: pwa.hasThemeColor, hasAppleTouchIcon: pwa.hasAppleTouchIcon, isInstallable: pwa.isInstallable })
      : undefined,
    codeCoverage: ccov ? compact({ unusedRatioPct: ccov.unusedRatio, totalUnusedBytes: ccov.totalUnusedBytes, cssUnusedRatioPct: ccov.css?.ratio, jsUnusedRatioPct: ccov.js?.ratio }) : undefined,
    images: io
      ? compact({ totalImages: io.totalImages, oversizedImages: io.oversizedImages, withoutAlt: io.withoutAlt, legacyFormats: io.legacyFormats, withoutLazyLoading: io.withoutLazyLoading })
      : undefined,
    a11yViolations: a11y?.violationCount,
    a11yScore: a11y?.a11yScore,
    social: sm ? compact({ hasOpenGraph: sm.hasOpenGraph, hasTwitterCard: sm.hasTwitterCard }) : undefined,
    aeo: aeo
      ? compact({
          semanticHTMLRatioPct: aeo.semanticHTMLRatio,
          semanticElements: aeo.semanticElements,
          genericElements: aeo.genericElements,
          hasAuthorInfo: aeo.hasAuthorInfo,
          hasDatetimeMarkup: aeo.hasDatetimeMarkup,
          contentStructureScore: aeo.contentStructureScore,
        })
      : undefined,
    resourceHints: tech ? compact({ preload: !!tech.preload, prefetch: !!tech.prefetch, dnsPrefetch: !!tech.dns_prefetch, metaRefresh: tech.metaRefresh ? true : undefined }) : undefined,
    security: sec ? compact({ securityScore: sec.securityScore, missingHeaders: sec.missingHeaders, mixedContent: sec.mixedContent }) : undefined,
    externalLinksDetail: el ? compact({ total: el.totalExternalLinks, broken: el.brokenLinks, distinctDomains: el.linksByDomain ? Object.keys(el.linksByDomain).length : undefined }) : undefined,
    url: ua ? compact({ depth: ua.depth, length: ua.length, hasTrackingParams: ua.hasTrackingParams }) : undefined,
  });
}

/**
 * Site-wide rollup across ALL crawled pages — the context a single page can't
 * provide, for verifying "most/all pages lack X" and crawl-budget aggregates.
 * Counts are over the pages where the relevant signal was captured.
 */
export function buildSiteAggregate(pages: PageIndex): Record<string, unknown> {
  const all = pages.all();
  const total = all.length;
  let analyzed = 0;
  const c = {
    status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0,
    redirects: 0, nonIndexable: 0,
    withManifest: 0, withServiceWorker: 0, withThemeColor: 0, withAppleTouchIcon: 0,
    withAuthor: 0, withDateMarkup: 0, withStructuredData: 0,
    withGA4: 0, withGTM: 0, withAnyAnalytics: 0,
    withConsentBanner: 0, withResourceHints: 0,
    thinPages: 0, trailingSlash: 0, noTrailingSlash: 0,
    semRatioSum: 0, semRatioN: 0, emptyAnchorsTotal: 0,
    pwaPages: 0, analyticsPages: 0, aeoPages: 0,
  };
  for (const p of all) {
    const s = statusOf(p);
    if (typeof s === 'number') {
      if (s >= 500) c.status5xx++;
      else if (s >= 400) c.status4xx++;
      else if (s >= 300) c.status3xx++;
      else if (s >= 200) c.status2xx++;
    }
    if (p.hasRedirects === true) c.redirects++;
    const ix = indexabilityOf(p);
    if (ix !== undefined) analyzed++;
    if (ix?.isIndexable === false) c.nonIndexable++;
    const pwa = p.pwaData as Record<string, unknown> | undefined;
    if (pwa) {
      c.pwaPages++;
      if (pwa.hasManifest) c.withManifest++;
      if (pwa.hasServiceWorker) c.withServiceWorker++;
      if (pwa.hasThemeColor) c.withThemeColor++;
      if (pwa.hasAppleTouchIcon) c.withAppleTouchIcon++;
    }
    const aeo = p.aeo as Record<string, unknown> | undefined;
    const ee = p.eeat as Record<string, unknown> | undefined;
    if (aeo) {
      c.aeoPages++;
      if (aeo.hasAuthorInfo || (typeof ee?.author === 'string' && (ee.author as string).trim())) c.withAuthor++;
      if (aeo.hasDatetimeMarkup || ee?.publishDate) c.withDateMarkup++;
      if (typeof aeo.semanticHTMLRatio === 'number') { c.semRatioSum += aeo.semanticHTMLRatio as number; c.semRatioN++; }
    }
    const sd = p.structuredData as { hasStructuredData?: boolean } | undefined;
    if (sd?.hasStructuredData) c.withStructuredData++;
    const an = p.analytics as Record<string, unknown> | undefined;
    if (an) {
      c.analyticsPages++;
      if (an.hasGA4) c.withGA4++;
      if (an.hasGTM) c.withGTM++;
      if (an.hasGA4 || an.hasGTM || an.hasUniversalAnalytics) c.withAnyAnalytics++;
    }
    const cd = p.consentData as { hasConsentBanner?: boolean } | undefined;
    if (cd?.hasConsentBanner) c.withConsentBanner++;
    const tech = p.technical as { preload?: unknown; prefetch?: unknown; dns_prefetch?: unknown } | undefined;
    if (tech && (tech.preload || tech.prefetch || tech.dns_prefetch)) c.withResourceHints++;
    const wc = wordCountOf(p);
    if (typeof wc === 'number' && wc > 0 && wc < THRESHOLDS.CONTENT_MIN) c.thinPages++;
    if (/\/$/.test(p.url)) c.trailingSlash++; else c.noTrailingSlash++;
    const at = p.anchorTextData as { emptyAnchors?: unknown } | undefined;
    if (Array.isArray(at?.emptyAnchors)) c.emptyAnchorsTotal += at!.emptyAnchors!.length;
    else if (typeof at?.emptyAnchors === 'number') c.emptyAnchorsTotal += at.emptyAnchors as number;
  }
  return compact({
    pagesTotal: total,
    pagesAnalyzed: analyzed,
    statusCounts: { '2xx': c.status2xx, '3xx': c.status3xx, '4xx': c.status4xx, '5xx': c.status5xx },
    redirectingPages: c.redirects,
    nonIndexablePages: c.nonIndexable,
    pwa: c.pwaPages ? { measuredOn: c.pwaPages, withManifest: c.withManifest, withServiceWorker: c.withServiceWorker, withThemeColor: c.withThemeColor, withAppleTouchIcon: c.withAppleTouchIcon } : undefined,
    aeo: c.aeoPages ? { measuredOn: c.aeoPages, withAuthor: c.withAuthor, withDateMarkup: c.withDateMarkup, avgSemanticHTMLRatioPct: c.semRatioN ? Math.round(c.semRatioSum / c.semRatioN) : undefined } : undefined,
    withStructuredData: c.withStructuredData,
    analytics: c.analyticsPages ? { measuredOn: c.analyticsPages, withGA4: c.withGA4, withGTM: c.withGTM, withAnyAnalytics: c.withAnyAnalytics } : undefined,
    withConsentBanner: c.withConsentBanner,
    withResourceHints: c.withResourceHints,
    thinContentPages: c.thinPages,
    trailingSlash: { withSlash: c.trailingSlash, withoutSlash: c.noTrailingSlash },
    totalEmptyAnchors: c.emptyAnchorsTotal,
  });
}

/** A still-`unchecked` finding packaged with evidence for the LLM fallback. */
export interface UncheckedContext {
  /** Original details-map key, for mapping the verdict back. */
  key: string;
  message: string;
  severity: string;
  count: number;
  example: string;
  pageUrl?: string;
  signals: Record<string, unknown>;
}

/**
 * Collect the findings the deterministic pass left `unchecked` (excluding
 * AI-discovered ones), each packaged with its first example and the cited
 * page's signal snapshot, ready for {@link llmVerifyFindings}.
 */
export function collectUncheckedContexts(
  details: Record<string, IssueDetail>,
  results: Map<string, VerificationResult>,
  pages: PageIndex,
): UncheckedContext[] {
  const out: UncheckedContext[] = [];
  for (const [key, detail] of Object.entries(details)) {
    if (results.get(key)?.status !== 'unchecked') continue;
    if (detail.aiDiscovered) continue;
    const example = firstExample(detail);
    if (!example) continue;
    const url = extractUrls(example)[0];
    const page = url ? pages.get(url) : undefined;
    out.push({
      key,
      message: stripTags(key),
      severity: detail.severity ?? 'medium',
      count: detail.count ?? 0,
      example: truncate(stripTags(example), 240),
      pageUrl: url,
      signals: buildPageSignals(page),
    });
  }
  return out;
}
