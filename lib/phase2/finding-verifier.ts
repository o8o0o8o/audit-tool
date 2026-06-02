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
import type { IssueDetail } from './types';
import { compareExamplesWorstFirst } from '../utils';
import { THRESHOLDS } from '../constants';

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

/** All distinct http(s) URLs in an example string, in order. */
function extractUrls(s: string): string[] {
  return [...new Set(s.match(/https?:\/\/[^\s<>"']+/g) ?? [])];
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

interface VerifierCtx {
  /** First example string the report would show (worst-first). */
  example: string;
  urls: string[];
  quoted?: string;
  pages: PageIndex;
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
  if (ctx.urls.length < 2) return unchecked(kind, `example lists <2 ${label} pages`);
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
      /\btitles?\b/.test(m) && /\bduplicate\b/.test(m) && !/near-duplicate/.test(m) && !/keyword/.test(m) && !/description/.test(m),
    verify: (ctx) => verifyShared('duplicate-title', 'title', titleOf, ctx),
  },
  {
    // "Duplicate meta descriptions found".
    kind: 'duplicate-description',
    match: (m) => /descriptions?\b/.test(m) && /\bduplicate\b/.test(m) && !/near-duplicate/.test(m),
    verify: (ctx) => verifyShared('duplicate-description', 'description', descOf, ctx),
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
    kind: 'multiple-h1',
    match: (m) => /\bh1\b/.test(m) && /(more than one|multiple|several)/.test(m),
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
    verify: (ctx) =>
      verifySingle(
        'not-in-sitemap',
        ctx,
        (p) => (p.foundIn === 'discovered' ? true : p.foundIn === 'sitemap' ? false : null),
        'page was discovered via crawl, not the sitemap',
        'page is recorded as found in the sitemap',
        true,
      ),
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
    (p) => { const h = p.headings as { h2?: unknown[] } | undefined; return Array.isArray(h?.h2) ? h!.h2!.length : undefined; },
    THRESHOLDS.H2_COUNT, 'over', 'H2 count'),
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
];

/** Pick the example the report would show first (worst-first, then stable). */
function firstExample(detail: IssueDetail): string | undefined {
  const examples = detail.examples ?? [];
  if (examples.length === 0) return undefined;
  return [...examples].sort(compareExamplesWorstFirst)[0];
}

/**
 * Verify a single finding's first example. AI-discovered findings are never
 * machine-verifiable here (they describe emergent issues) → always unchecked.
 */
export function verifyFinding(message: string, detail: IssueDetail, pages: PageIndex): VerificationResult {
  if (detail.aiDiscovered) return unchecked('ai-discovered', 'AI-discovered finding — not deterministically verifiable');
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
export function verifyDetails(details: Record<string, IssueDetail>, pages: PageIndex): VerificationSummary {
  const results = new Map<string, VerificationResult>();
  const confirmedSet = new Set<string>();
  const refutedSet = new Set<string>();
  let uncheckedCount = 0;

  for (const [message, detail] of Object.entries(details)) {
    const result = verifyFinding(message, detail, pages);
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
  const h2 = (page.headings as { h2?: unknown[] } | undefined)?.h2;

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
    h2Count: Array.isArray(h2) ? h2.length : undefined,
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
            ? cd.cookies.slice(0, 6).map((c) => ({ name: c.name, thirdParty: c.isThirdParty, expires: c.expires }))
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
