/**
 * Live finding-verification pass for Phase 2 (`--verify`).
 *
 * Unlike the disk-based verifier (`finding-verifier.ts`), this pass does NOT
 * read the persisted crawl snapshot. It PARSES the produced report
 * (`audit-report.md`), takes each finding's FIRST concrete example URL,
 * RE-FETCHES that page live (Playwright), and re-asserts the claim against the
 * fresh page. This sidesteps the persistence gaps that left findings
 * `unverified` on disk — the live page carries every signal (third-party
 * origins, iframes, HTML-doc size, …) that storage strips.
 *
 * Tradeoffs (accepted by design):
 *   • Non-deterministic — reflects the site's CURRENT state, not the crawl-time
 *     state. The verified report banner is timestamped to make that explicit.
 *   • Network-bound — one fetch per DISTINCT first-example URL (deduped), not
 *     per occurrence.
 *
 * Scope: all severities are verified (CRITICAL / HIGH / MEDIUM / LOW). When the
 * global fetch budget is tight, high-severity sample URLs are fetched first.
 *
 * Three verdicts, mirroring the disk pass:
 *   • confirmed  — the live page exhibits the claimed defect.
 *   • refuted    — the live page contradicts the claim (likely fixed / false
 *                  positive).
 *   • unverified — no live checker owns the kind, the example URL is missing /
 *                  unreachable, or the claim is site-level (link graph, sitemap)
 *                  or needs instrumentation a single light load can't provide
 *                  (CLS/TBT, code coverage, axe contrast). Never a defect marker.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { THRESHOLDS, DEFAULT_USER_AGENT, VIEWPORT, CRAWL_SETTINGS } from '../constants';
import { PaginationAnalyzer } from '../analyzers/seo/pagination-analyzer';
import { withTimeout } from '../crawler/resilience';
import { isFetchAllowed } from '../../validators';
import { PhaseProgress } from '../utils/phase-progress';
import { isVisualFinding } from '../phase2/categorize';

// SSRF guard for the standalone --verify re-fetch: the report's example URLs are
// re-fetched live, so a private/internal host parsed out of an old report must
// not be navigated. Set once per verifyReportLive run to the audited site's host
// (same-host targets are allowed; a public site's stray private URL is blocked).
let verifyOriginHost: string | undefined;
/** True when `url` is safe to fetch in the live pass; a blocked URL degrades the
 *  finding to `unverified` (callers return null / skip). */
function liveFetchAllowed(url: string): boolean {
  const gate = isFetchAllowed(url, { originHost: verifyOriginHost });
  if (!gate.allowed) console.log(`  ⚠️  live-verify skipping blocked URL: ${url} — ${gate.reason}`);
  return gate.allowed;
}

export type LiveStatus = 'confirmed' | 'refuted' | 'unverified';

/**
 * Why a verdict landed where it did — a categorization of the formerly-opaque
 * `unverified` bucket so the verified report can show an honest breakdown
 * ("of N unverified: X site-level, Y under-observable, …") instead of one
 * undifferentiated label. `confirmed` / `refuted` are self-explanatory; the rest
 * are all flavours of `unverified`, each a DELIBERATE non-decision, never a defect:
 *   • no-checker          — no live checker owns this finding kind
 *   • no-example          — the finding cites no concrete per-page URL
 *   • unreachable         — the example URL could not be loaded live
 *   • under-observable    — a DOM signal a single light load can under-observe
 *                           (lazy/below-the-fold content, hydration, axe scans)
 *   • load-dependent      — a network aggregate a light load under-triggers
 *                           (third-party bytes/requests, ad bytes, transfer size)
 *   • volatile            — varies between loads (TTFB, TLS handshake, iframe presence)
 *   • site-level          — a cross-page aggregate not derivable from a per-page fetch
 *   • plural-undersampled — a plural finding whose sample didn't cover all occurrences
 *   • llm-unsure          — the LLM stage reviewed it but couldn't decide
 *   • inconclusive        — checked, but the live reading didn't settle the claim
 */
export type VerdictReason =
  | 'confirmed'
  | 'refuted'
  | 'no-checker'
  | 'no-example'
  | 'unreachable'
  | 'under-observable'
  | 'load-dependent'
  | 'volatile'
  | 'site-level'
  | 'plural-undersampled'
  | 'llm-unsure'
  | 'inconclusive';

/** Confidence in a verdict, surfaced alongside the status. `high` = a complete,
 *  stable observation; `medium` = partial sample or a single volatile reading;
 *  `low` = an LLM/heuristic judgment over partial evidence. */
export type Confidence = 'high' | 'medium' | 'low';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ReportFinding {
  /** The `### <title>` heading text, verbatim (markdown, may carry inline code). */
  title: string;
  severity: Severity;
  /** "affects N occurrences" — how many pages the finding spans. */
  count: number;
  /** First real http(s) example URL under "Affected pages" (templated `{N}` skipped). */
  exampleUrl?: string;
  /** All real http(s) example URLs under "Affected pages", deduped, in order
   *  (templated `{N}` skipped). Cross-page checks (duplicate) need ≥2. */
  exampleUrls: string[];
}

/** What {@link verifyReportLive} returns: the per-finding verdicts plus the live
 *  signals it captured per fetched URL, so the caller can hand still-unverified
 *  findings (with their cited page's fresh signals) to the LLM stage (Slice 3). */
export interface LiveVerifyResult {
  verdicts: LiveVerdict[];
  /** Captured per-URL signals (null when that URL couldn't be loaded). */
  signalsByUrl: Map<string, LiveSignals | null>;
}

export interface LiveVerdict {
  title: string;
  severity: Severity;
  status: LiveStatus;
  reason: string;
  /** Categorized reason — drives the verified report's verdict breakdown. */
  reasonCode: VerdictReason;
  /** How much to trust this verdict (complete observation vs partial / heuristic). */
  confidence: Confidence;
  exampleUrl?: string;
  /** The checker kind that matched, or 'none'. */
  kind: string;
}

/* ------------------------------------------------------------------ parser */

/**
 * Parse `audit-report.md` into per-finding records. A `### <title>` is treated
 * as a finding ONLY when its first non-empty line is a severity span — that
 * filters out the summary sections ("Top Priority Issues", "Quick Wins",
 * "Long-term Recommendations") whose headings carry no severity line.
 * All severities are kept, including LOW (AI-discovered findings are still
 * excluded — they have no live checker; see below).
 */
export function parseReportFindings(md: string): ReportFinding[] {
  const lines = md.split('\n');
  const findings: ReportFinding[] = [];
  // A finding's header line STARTS with the severity span and is immediately
  // followed by " · affects N occurrence(s)". This excludes the summary
  // sections (Top Priority Issues / Quick Wins / Long-term Recommendations),
  // whose list items embed a sev-span mid-line in a different shape.
  // Capture the severity from the span TEXT, not the class: sevSpan renders
  // CRITICAL inside class="sev-high", so a class-based capture would mislabel
  // every critical finding as HIGH.
  const sevRe = /^\s*<span class="sev-[^"]*">(CRITICAL|HIGH|MEDIUM|LOW)<\/span>\s*·\s*affects\b/;

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(.*\S)\s*$/);
    if (!h) continue;
    const title = h[1].trim();

    // The severity line must be the first non-empty content after the heading.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const headerLine = j < lines.length ? lines[j] : '';
    const sevM = headerLine.match(sevRe);
    if (!sevM) continue;
    const severity = sevM[1];
    // LOW findings are live-checked too (all severities). They share the same
    // checker registry; the only severity-dependent behaviour is the fetch-budget
    // ordering in verifyReportLive, which fills high-severity sample URLs first.
    const countM = headerLine.match(/affects\s+(\d+)\s+occurrence/);
    const count = countM ? parseInt(countM[1], 10) : 1;
    // Skip AI-discovered findings: they have no live checker, their example is
    // free-text evidence (no markdown link) so the URL scan would fall through
    // to a Resources/Fix link and re-check the wrong page, and their verdicts
    // can't map back to a deterministic finding message — which would make the
    // banner's drop count diverge from what's actually dropped.
    if (/AI-discovered/i.test(headerLine)) continue;

    // Collect example URLs — ONLY from the "Affected pages" block. Scanning to
    // the next heading would otherwise walk into Fix / Resources and grab an
    // external doc link, then re-check the wrong page. Collect several (deduped,
    // capped) so cross-page checks (duplicate) have a 2nd page to compare.
    const exampleUrls: string[] = [];
    let inAffected = false;
    for (let k = j + 1; k < lines.length && !/^#{2,3}\s/.test(lines[k]) && exampleUrls.length < 6; k++) {
      const line = lines[k];
      if (/^\*\*Affected pages\*\*/.test(line)) {
        inAffected = true;
        continue;
      }
      if (!inAffected) continue;
      if (/^\*\*/.test(line)) break; // next bold label (Fix / Resources / …) ends the block
      // Match any http(s) URL token — covers both the markdown-link target
      // `[text](url)` and a bare `- url` bullet (inlineExample emits the latter
      // when an example is nothing but a URL). The char class stops at the
      // closing paren/bracket and whitespace so it works in either form.
      const urls = line.match(/https?:\/\/[^\s)\]<>"']+/g);
      if (!urls) continue;
      for (const url of urls) {
        if (/[{}]/.test(url)) continue; // templated series key — not a real page
        if (!exampleUrls.includes(url)) exampleUrls.push(url);
      }
    }

    findings.push({ title, severity: severity as Severity, count, exampleUrl: exampleUrls[0], exampleUrls });
  }

  return findings;
}

/* ------------------------------------------------------- live signal capture */

const AD_HOST_RE =
  /(doubleclick|googlesyndication|google-analytics|googletagservices|adservice|adsystem|adnxs|amazon-adsystem|criteo|taboola|outbrain|pubmatic|rubiconproject|openx|scorecardresearch|moatads|adroll|quantserve)\b/i;

/** Common tracking-cookie name prefixes (GA, FB, GTM, Hotjar, …). */
const TRACKER_COOKIE_RE =
  /^(_ga|_gid|_gat|_fbp|_fbc|_gcl|_hj|_uet|__hs|hubspotutk|mp_|amplitude|_pk_|optimizely|_clck|_clsk|IDE|test_cookie|fr|MUID)/i;

/** Unused fraction (0–1) from Playwright CSS coverage; -1 when no CSS. */
function cssUnusedRatio(entries: { text?: string; ranges: { start: number; end: number }[] }[]): number {
  let total = 0;
  let used = 0;
  for (const e of entries) {
    const len = e.text?.length ?? 0;
    if (!len) continue;
    total += len;
    for (const r of e.ranges) used += r.end - r.start;
  }
  return total > 0 ? (total - used) / total : -1;
}

/**
 * Unused fraction (0–1) from Playwright (V8) JS coverage; -1 when no JS.
 * Summing count>0 ranges over-counts used bytes for nested ranges, which biases
 * the result toward LOWER unused% — safe for a confirm-only "high unused" check
 * (it can only under-confirm, never false-confirm).
 */
function jsUnusedRatio(
  entries: { source?: string; functions: { ranges: { count: number; startOffset: number; endOffset: number }[] }[] }[],
): number {
  let total = 0;
  let used = 0;
  for (const e of entries) {
    const len = e.source?.length ?? 0;
    if (!len) continue;
    total += len;
    let entryUsed = 0;
    for (const fn of e.functions) for (const r of fn.ranges) if (r.count > 0) entryUsed += r.endOffset - r.startOffset;
    used += Math.min(len, entryUsed);
  }
  return total > 0 ? (total - used) / total : -1;
}

/** Scroll to the bottom in viewport steps to trigger lazy content, then back to top. */
async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const tick = () => {
          window.scrollBy(0, window.innerHeight);
          y += window.innerHeight;
          // Cap the travel so an infinite-scroll page can't loop forever.
          if (y < document.body.scrollHeight && y < 60000) setTimeout(tick, 100);
          else resolve();
        };
        tick();
      });
    })
    .catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
}

export interface LiveSignals {
  url: string;
  finalUrl: string;
  status: number;
  ttfbMs: number | null;
  htmlBytes: number;
  totalBytes: number;
  totalRequests: number;
  title: string;
  description: string | null;
  canonical: string | null;
  h1Count: number;
  iframeCount: number;
  wordCount: number;
  semanticRatio: number;
  emptyAnchorCount: number;
  inputsWithoutAutocomplete: number;
  /** Count of forms that self-post via GET with a sensitive field (fields would
   *  leak to the URL). Under-observable (forms can hydrate) → confirm-only. */
  selfPostGetForms: number;
  scriptsNoSri: number;
  maxChildren: number;
  jpgPngImages: number;
  modernImages: number;
  renderBlockingTotal: number;
  renderBlockingThirdParty: number;
  thirdPartyOrigins: number;
  thirdPartyRequests: number;
  thirdPartyBytes: number;
  adScriptBytes: number;
  largestImageBytes: number;
  oversizedImages: number;
  /** Cumulative Layout Shift accumulated over load + scroll (PerformanceObserver). */
  clsValue: number;
  /** Total Blocking Time proxy: sum of long-task time over 50ms, in ms. */
  tbtMs: number;
  /** Fraction (0–1) of downloaded CSS bytes never used; -1 when no CSS / unmeasured. */
  unusedCssRatio: number;
  /** Fraction (0–1) of downloaded JS bytes never used; -1 when no JS / unmeasured. */
  unusedJsRatio: number;
  /** Third-party / known-tracker cookies present at load, before any consent interaction. */
  preConsentTrackingCookies: number;
  /** axe-core color-contrast violation nodes; -1 when the scan didn't run. */
  contrastViolations: number;
  /** `<main>` / `[role="main"]` landmark elements on the page. */
  mainCount: number;
  /** Resource-hint links in the document: preconnect / preload / dns-prefetch / prefetch / modulepreload. */
  resourceHintCount: number;
  /** Anchors whose href or text references a privacy policy. */
  privacyLinkCount: number;
  /** TLS handshake time (ms) from navigation timing (connectEnd − secureConnectionStart); null when the connection was reused / no secure handshake. */
  tlsMs: number | null;
  /** Count (0–4) of E-E-A-T signals present: author byline, about link, contact link, Person/Organization JSON-LD. */
  eeatSignals: number;
  /** Main-document response headers, lowercased keys (Slice 2). Server-rendered
   *  and stable, so header checkers confirm AND refute. Empty when unavailable. */
  headers: Record<string, string>;
  /** `<html lang="…">` attribute value (for the Content-Language mismatch check); '' when unset. */
  htmlLang: string;
  /** Total bytes of inline `<style>` content in the document (Large inline CSS). */
  inlineCssBytes: number;
  /** Form controls (text-like inputs / textarea / select) with no associated label,
   *  aria-label/-labelledby, or title. Under-observable (forms can hydrate) → confirm-only. */
  inputsWithoutLabel: number;
  /** Duplicate hreflang values among `<link rel="alternate" hreflang>` in the head
   *  (same hreflang declared more than once). Server-rendered + stable. */
  duplicateHreflang: number;
  /** `<script type="application/ld+json">` blocks on the page (structured-data coverage). */
  jsonLdBlocks: number;
  /** True when the page has Open Graph (`og:*`) or Twitter Card social meta tags. */
  hasSocialTags: boolean;
  /** Total `<img>` elements on the page. */
  imageCount: number;
  /** `<img>` elements using `loading="lazy"`. */
  lazyImageCount: number;
  /** `<video>` elements on the page. */
  videoCount: number;
  /** True when a VideoObject is declared in JSON-LD structured data. */
  hasVideoObjectSchema: boolean;
  /** `<video>` elements with no `<track kind="captions"|"subtitles">`. */
  videosWithoutCaptions: number;
  /** `<video>` elements with no `poster` attribute. Confirm-only (videos can lazy-mount). */
  videosWithoutPoster: number;
  /** `<video>` elements with no accessible name (aria-label/title/labelledby/track[label]). Confirm-only. */
  videosWithoutTitle: number;
  /** `<video autoplay>` elements without `controls`. Confirm-only. */
  autoplayVideosNoControls: number;
  /** `<link rel="manifest">` present. Server-rendered <head> → stable confirm/refute. */
  hasManifestLink: boolean;
  /** `<meta name="theme-color">` present. Stable confirm/refute. */
  hasThemeColor: boolean;
  /** `<link rel*="apple-touch-icon">` present. Stable confirm/refute. */
  hasAppleTouchIcon: boolean;
  /** `<noscript>` present anywhere in the document. Stable confirm/refute. */
  hasNoscript: boolean;
  /** Count of `<h2>` elements. Server-rendered → stable confirm/refute. */
  h2Count: number;
  /** Sum of inline (no-src) JS `<script>` text bytes. Stable confirm/refute. */
  inlineJsBytes: number;
  /** Same-host anchors whose href uses `http://` (mixed-protocol internal links). Confirm-only. */
  httpInternalLinks: number;
  /** Same-origin (internal) anchors with an href — for the dead-end-page check. */
  internalLinkCount: number;
  /** Largest Contentful Paint (ms) from a PerformanceObserver; 0 when unmeasured. Volatile → confirm-only. */
  lcpMs: number;
  /** First Contentful Paint (ms) from the paint timeline; 0 when unmeasured. Volatile → confirm-only. */
  fcpMs: number;
  /** Number of web-font files downloaded (resourceType 'font'). Load-dependent → confirm-only. */
  fontRequests: number;
  /** Total bytes of downloaded web fonts. Load-dependent → confirm-only. */
  fontBytes: number;
  /** Console errors + uncaught page exceptions observed during load. Confirm-only. */
  consoleErrors: number;
  /** True when an author byline / author markup is present (E-E-A-T author signal). */
  hasAuthorByline: boolean;
  /** HTTP redirect hops the navigation followed to reach `finalUrl` (0 = direct).
   *  Server-issued but can vary by geo/cookie/Accept-Language → confirm-only. */
  redirectCount: number;
  /** Status code of each redirect hop (301/302/307/308…). Confirm-only (varies). */
  redirectStatuses: number[];
  /** A heading level was skipped (e.g. h1→h3). Server-rendered → confirm/refute. */
  hasHeadingSkip: boolean;
  /** Visible-text length / serialized-HTML length. Under-observable (content hydrates) → confirm-only. */
  textHtmlRatio: number;
  /** A freshness signal is present (time[datetime] / article meta / JSON-LD date). Confirm/refute. */
  hasFreshnessSignal: boolean;
  /** True when the document head declares `<link rel="preload" as="image">`
   *  (an LCP-image preload). Server-rendered + stable. */
  hasImagePreload: boolean;
  /** Total `<a href>` anchors on the page (for the "too many on-page links"
   *  check). Under-observable upward — links can hydrate → confirm-only. */
  totalLinkCount: number;
  /** Affiliate-looking outbound links missing BOTH rel="sponsored" and
   *  rel="nofollow" (mirrors ExternalLinksAnalyzer.isAffiliateLink). Confirm-only:
   *  links can hydrate, so absence at load isn't proof. */
  affiliateLinksNoRel: number;
  /** True when the page declares a `noindex` directive — `<meta name="robots">`
   *  (or `googlebot`) with `noindex`. The X-Robots-Tag header form is checked
   *  separately from `headers`. Server-rendered + stable → confirm AND refute. */
  hasNoindexMeta: boolean;
  /** Total bytes of all downloaded images (sum of image responseBodySize).
   *  Load-dependent (lazy/below-fold images), so confirm-only via overOrUnsure. */
  totalImageBytes: number;
}

/**
 * Registrable-ish key: last two labels of a hostname (siro.ai, vector.co).
 * Naive — it collapses multi-label public suffixes (`a.b.co.uk` → `co.uk`), so
 * distinct third parties under such a TLD read as first-party and the
 * third-party origin/request/byte counts UNDER-count. Safe by construction:
 * every consumer is `overOrUnsure` (confirm-only), so under-counting yields
 * `unverified`, never a false refute. A full PSL lookup would be exact but is
 * not worth the dependency for confirm-only signals.
 */
function registrable(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/**
 * Load one URL and capture a rich, single-pass signal bundle. Returns null when
 * the page can't be loaded (network error / non-HTML), which routes the finding
 * to `unverified` rather than a false refutation.
 */
async function captureOne(
  browser: Browser,
  url: string,
  timeoutMs: number,
  throttle?: Throttle,
): Promise<LiveSignals | null> {
  if (!liveFetchAllowed(url)) return null;
  // Match the crawl's device profile so perf signals are comparable: the
  // crawler always uses the fixed mobile viewport (VIEWPORT) + UA.
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
    deviceScaleFactor: VIEWPORT.DEVICE_SCALE_FACTOR,
    isMobile: true,
    hasTouch: true,
    userAgent: DEFAULT_USER_AGENT,
  });
  await injectNamePolyfill(context);
  // Accurate per-request transfer sizes come from `request.sizes()` on
  // 'requestfinished' (real responseBodySize, incl. chunked) rather than the
  // unreliable content-length header.
  const requests: { host: string; type: string; bytes: number }[] = [];
  const sizings: Promise<void>[] = [];
  // Console errors + uncaught page exceptions observed during load (the
  // "Critical JavaScript errors" finding). Confirm-only — errors can be
  // interaction-triggered, so absence at load isn't proof.
  let consoleErrors = 0;
  try {
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors++;
    });
    page.on('pageerror', () => {
      consoleErrors++;
    });
    page.on('requestfinished', (req) => {
      sizings.push(
        (async () => {
          try {
            const s = await req.sizes();
            requests.push({
              host: new URL(req.url()).hostname,
              type: req.resourceType(),
              bytes: s.responseBodySize > 0 ? s.responseBodySize : 0,
            });
          } catch {
            /* request may have no recordable size */
          }
        })(),
      );
    });

    // CLS + long-task (TBT proxy) observers must be installed before any script
    // runs on the page.
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number; __tbt: number; __lcp: number };
      w.__cls = 0;
      w.__tbt = 0;
      w.__lcp = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const ls = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
            if (!ls.hadRecentInput) w.__cls += ls.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const over = e.duration - 50;
            if (over > 0) w.__tbt += over;
          }
        }).observe({ type: 'longtask', buffered: true });
        // Largest Contentful Paint — keep the latest reported value.
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length) w.__lcp = entries[entries.length - 1].startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        /* observers unsupported — leaves 0, routes to unverified, never refute */
      }
    });

    // CDP coverage for unused-CSS/JS — started before navigation.
    let coverageOn = false;
    try {
      await page.coverage.startCSSCoverage();
      await page.coverage.startJSCoverage();
      coverageOn = true;
    } catch {
      /* non-Chromium / unsupported — coverage stays unmeasured (-1) */
    }

    // Match the crawl's network/CPU throttle (when it ran with --perf) so
    // TTFB/CLS/TBT are comparable. Applied via CDP before navigation.
    if (throttle && ((throttle.downloadBps ?? 0) > 0 || (throttle.cpuRate ?? 1) > 1)) {
      try {
        const session = await context.newCDPSession(page);
        if ((throttle.downloadBps ?? 0) > 0) {
          await session.send('Network.enable');
          await session.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: throttle.downloadBps ?? -1,
            uploadThroughput: throttle.uploadBps ?? -1,
            latency: throttle.latencyMs ?? 0,
          });
        }
        if ((throttle.cpuRate ?? 1) > 1) {
          await session.send('Emulation.setCPUThrottlingRate', { rate: throttle.cpuRate ?? 1 });
        }
      } catch {
        /* throttle unsupported — proceed unthrottled (perf signals stay confirm-only) */
      }
    }

    // Wait for the DOM to be parsed, NOT the full `load` event. Under the
    // re-applied crawl throttle (e.g. slow4g, 300kbit/s) `load` waits for every
    // image/font/third-party byte and routinely exceeds `timeoutMs` on real
    // pages — the page would then be wrongly recorded `unreachable`, killing
    // EVERY (including stable DOM/header) checker on it. The capped `networkidle`
    // settles + autoScroll below still let hydration and deferred content mount.
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) return null;
    // Give client-side hydration / deferred content a chance to mount before we
    // read DOM signals. networkidle can never settle on sites with persistent
    // connections (analytics, websockets), so cap it and ignore the timeout.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    // Scroll the page to trigger lazy / below-the-fold images, iframes and
    // scroll-loaded third parties so the DOM and network match a real visit.
    await autoScroll(page);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    const status = response.status();
    const finalUrl = response.url();
    const pageHost = new URL(finalUrl).hostname;

    // Count the HTTP redirect hops that led to this response (3xx chain) and
    // record each hop's status code (301/302/307/308…). Walk the request's
    // redirect ancestry; 0 means a direct (non-redirected) load.
    let redirectCount = 0;
    const redirectStatuses: number[] = [];
    try {
      let prev = response.request().redirectedFrom();
      while (prev) {
        redirectCount++;
        const resp = await prev.response();
        const st = resp?.status();
        if (typeof st === 'number') redirectStatuses.push(st);
        prev = prev.redirectedFrom();
      }
    } catch {
      /* leave 0 → redirect checkers stay unverified, never a false drop */
    }

    // Main-document response headers (lowercased keys), for the Slice 2 header
    // checkers. Stable + server-rendered, so they confirm AND refute.
    let headers: Record<string, string> = {};
    try {
      headers = await response.allHeaders();
    } catch {
      /* leave empty → header checkers stay unverified, never refute on absence */
    }

    // Cookies present now — before any consent interaction (we never click) — so
    // third-party / known-tracker cookies here were set without consent.
    let preConsentTrackingCookies = 0;
    try {
      const pageReg0 = registrable(pageHost);
      const cookies = await context.cookies();
      preConsentTrackingCookies = cookies.filter((c) => {
        const host = c.domain.replace(/^\./, '');
        return registrable(host) !== pageReg0 || TRACKER_COOKIE_RE.test(c.name);
      }).length;
    } catch {
      /* leave 0 → unverified */
    }

    // CLS / TBT / LCP / FCP readout. LCP comes from the init-script observer;
    // FCP from the buffered paint timeline. 0 means "not measured" → unverified.
    const vitals = await page
      .evaluate(() => {
        const w = window as unknown as { __cls?: number; __tbt?: number; __lcp?: number };
        const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
        return {
          cls: w.__cls ?? 0,
          tbt: Math.round(w.__tbt ?? 0),
          lcp: Math.round(w.__lcp ?? 0),
          fcp: fcpEntry ? Math.round(fcpEntry.startTime) : 0,
        };
      })
      .catch(() => ({ cls: 0, tbt: 0, lcp: 0, fcp: 0 }));

    // Coverage readout → unused ratios.
    let unusedCssRatio = -1;
    let unusedJsRatio = -1;
    if (coverageOn) {
      try {
        const [css, js] = await Promise.all([page.coverage.stopCSSCoverage(), page.coverage.stopJSCoverage()]);
        unusedCssRatio = cssUnusedRatio(css);
        unusedJsRatio = jsUnusedRatio(js);
      } catch {
        /* leave -1 */
      }
    }

    // Raw served-document bytes — the faithful equivalent of the analyzer's
    // `htmlSize`. Reliable (the document response always loads), unlike network
    // aggregates that a single light load under-triggers.
    let htmlBytes = 0;
    try {
      htmlBytes = Buffer.byteLength(await response.text());
    } catch {
      /* body may be unavailable on some responses */
    }

    const dom = await page.evaluate(() => {
      const origin = location.origin;
      const text = (document.body?.innerText ?? '').trim();
      const wordCount = text ? text.split(/\s+/).length : 0;

      const SEMANTIC = [
        'header',
        'nav',
        'main',
        'article',
        'section',
        'aside',
        'footer',
        'figure',
        'figcaption',
        'details',
        'summary',
        'time',
        'mark',
      ];
      const allEls = document.body ? document.body.getElementsByTagName('*').length : 0;
      let semanticEls = 0;
      for (const tag of SEMANTIC) semanticEls += document.getElementsByTagName(tag).length;
      const semanticRatio = allEls > 0 ? semanticEls / allEls : 0;

      let emptyAnchorCount = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const hasText = (a.textContent ?? '').trim().length > 0;
        const hasAria = !!a.getAttribute('aria-label') || !!a.getAttribute('title');
        const hasImgAlt = !!a.querySelector('img[alt]:not([alt=""])');
        if (!hasText && !hasAria && !hasImgAlt) emptyAnchorCount++;
      }

      const AUTOCOMPLETE_TYPES = ['text', 'email', 'tel', 'password', 'url', 'search', ''];
      let inputsWithoutAutocomplete = 0;
      for (const inp of Array.from(document.querySelectorAll('input'))) {
        const type = (inp.getAttribute('type') ?? '').toLowerCase();
        if (!AUTOCOMPLETE_TYPES.includes(type)) continue;
        if (!inp.getAttribute('autocomplete')) inputsWithoutAutocomplete++;
      }

      // Self-post-via-GET data forms — mirrors FormAccessibilityAnalyzer's
      // detection (GET/defaulted method + non-navigating action + a sensitive
      // field: email/password/tel input, a textarea, or a PII-pattern name), so
      // the "Form submits to itself via GET" finding has a live owner.
      let selfPostGetForms = 0;
      const SENSITIVE_TYPES = ['email', 'password', 'tel'];
      const SENSITIVE_NAME =
        /(e-?mail|passw|message|comment|enquir|inquir|first-?name|last-?name|full-?name|\bfname\b|\blname\b|cvv|\bcc-|\bssn\b)/i;
      for (const form of Array.from(document.querySelectorAll('form'))) {
        const method = (form.getAttribute('method') ?? 'get').trim().toLowerCase();
        if (method === 'post') continue;
        const action = (form.getAttribute('action') ?? '').trim();
        const nonNav =
          action === '' || action === '#' || action.startsWith('#') || action.toLowerCase().startsWith('javascript:');
        if (!nonNav) continue;
        let sensitive = false;
        for (const el of Array.from(form.querySelectorAll('input, textarea, select'))) {
          const tag = el.tagName.toLowerCase();
          const t = (el.getAttribute('type') ?? (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
          const nm = el.getAttribute('name') ?? '';
          if (t === 'textarea' || SENSITIVE_TYPES.includes(t) || (nm && SENSITIVE_NAME.test(nm))) {
            sensitive = true;
            break;
          }
        }
        if (sensitive) selfPostGetForms++;
      }

      let scriptsNoSri = 0;
      for (const s of Array.from(document.querySelectorAll('script[src]'))) {
        const src = s.getAttribute('src') ?? '';
        let crossOrigin: boolean;
        try {
          crossOrigin = new URL(src, location.href).origin !== origin;
        } catch {
          crossOrigin = false;
        }
        if (crossOrigin && !s.getAttribute('integrity')) scriptsNoSri++;
      }

      // Render-blocking head scripts (src, no async/defer) + classify third-party.
      let renderBlockingTotal = 0;
      let renderBlockingThirdParty = 0;
      const head = document.head;
      if (head) {
        for (const s of Array.from(head.querySelectorAll('script[src]'))) {
          if (s.hasAttribute('async') || s.hasAttribute('defer') || s.getAttribute('type') === 'module') continue;
          renderBlockingTotal++;
          try {
            if (new URL(s.getAttribute('src') ?? '', location.href).origin !== origin) renderBlockingThirdParty++;
          } catch {
            /* ignore */
          }
        }
        renderBlockingTotal += head.querySelectorAll('link[rel="stylesheet"]:not([media="print"])').length;
      }

      let maxChildren = 0;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.children.length > maxChildren) maxChildren = el.children.length;
      }

      let jpgPngImages = 0;
      let modernImages = 0;
      let oversizedImages = 0;
      for (const img of Array.from(document.images)) {
        const src = (img.currentSrc || img.src || '').toLowerCase();
        if (/\.(jpg|jpeg|png)(\?|$)/.test(src)) jpgPngImages++;
        else if (/\.(webp|avif)(\?|$)/.test(src)) modernImages++;
        const dispW = img.clientWidth;
        const dispH = img.clientHeight;
        if (dispW > 0 && dispH > 0 && img.naturalWidth > dispW * 2 && img.naturalHeight > dispH * 2) oversizedImages++;
      }

      const canonicalEl = document.querySelector('link[rel="canonical"]');
      const descEl = document.querySelector('meta[name="description"]');

      // noindex via a robots / googlebot meta directive (the X-Robots-Tag header
      // form is checked from the response headers in the checker).
      const hasNoindexMeta = Array.from(
        document.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]'),
      ).some((m) => /\bnoindex\b/i.test(m.getAttribute('content') ?? ''));

      // `<main>` landmark (the "Missing <main> element" finding). role="main"
      // counts as an equivalent landmark.
      const mainCount = document.querySelectorAll('main, [role="main"]').length;

      // Resource hints in the document head/body. rel is case-insensitive in
      // HTML, so use the `i` attribute flag.
      const resourceHintCount = document.querySelectorAll(
        'link[rel~="preconnect" i], link[rel~="preload" i], link[rel~="dns-prefetch" i], link[rel~="prefetch" i], link[rel~="modulepreload" i]',
      ).length;

      // LCP-image preload: a `<link rel="preload" as="image">` (covers both
      // href and imagesrcset responsive preloads). The "LCP images not preloaded"
      // finding asks whether this exists.
      const hasImagePreload = !!document.querySelector('link[rel~="preload" i][as="image" i]');

      // Privacy-policy links: href OR visible text mentions "privacy".
      let privacyLinkCount = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a.getAttribute('href') ?? '').toLowerCase();
        const text = (a.textContent ?? '').toLowerCase();
        if (/privacy/.test(href) || /privacy/.test(text)) privacyLinkCount++;
      }

      // E-E-A-T proxy signals on the page (0–4).
      let eeatSignals = 0;
      const hasAuthorByline = !!document.querySelector(
        '[rel="author"], [itemprop="author"], [class*="author" i], [class*="byline" i]',
      );
      if (hasAuthorByline) eeatSignals++;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      if (
        anchors.some((a) => /about/.test(((a.getAttribute('href') ?? '') + ' ' + (a.textContent ?? '')).toLowerCase()))
      )
        eeatSignals++;
      if (
        anchors.some((a) =>
          /contact/.test(((a.getAttribute('href') ?? '') + ' ' + (a.textContent ?? '')).toLowerCase()),
        )
      )
        eeatSignals++;
      if (
        Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) =>
          /"@type"\s*:\s*"(Person|Organization)"/.test(s.textContent ?? ''),
        )
      )
        eeatSignals++;

      // Inline CSS: sum of every <style> element's text length.
      let inlineCssBytes = 0;
      for (const st of Array.from(document.querySelectorAll('style'))) inlineCssBytes += (st.textContent ?? '').length;

      // Form controls lacking an accessible label. A control is labelled when it
      // has aria-label/-labelledby/title, is wrapped in a <label>, or a
      // <label for> points at its id. Skip hidden/button-like and unlabellable types.
      const SKIP_INPUT = ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'];
      let inputsWithoutLabel = 0;
      const controls = Array.from(document.querySelectorAll('input, textarea, select'));
      for (const el of controls) {
        if (el.tagName === 'INPUT' && SKIP_INPUT.includes((el.getAttribute('type') ?? 'text').toLowerCase())) continue;
        const id = el.getAttribute('id');
        const labelled =
          !!el.getAttribute('aria-label') ||
          !!el.getAttribute('aria-labelledby') ||
          !!el.getAttribute('title') ||
          !!el.closest('label') ||
          (!!id && !!document.querySelector(`label[for="${CSS.escape(id)}"]`));
        if (!labelled) inputsWithoutLabel++;
      }

      // Duplicate hreflang declarations in the head.
      const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]')).map((l) =>
        (l.getAttribute('hreflang') ?? '').trim().toLowerCase(),
      );
      const seenHreflang = new Set<string>();
      let duplicateHreflang = 0;
      for (const h of hreflangs) {
        if (!h) continue;
        if (seenHreflang.has(h)) duplicateHreflang++;
        else seenHreflang.add(h);
      }

      // Structured data: JSON-LD blocks + whether any declares a VideoObject.
      const ldBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const jsonLdBlocks = ldBlocks.length;
      const hasVideoObjectSchema = ldBlocks.some((s) => /"@type"\s*:\s*"VideoObject"/.test(s.textContent ?? ''));

      // Social meta: Open Graph or Twitter Card.
      const hasSocialTags = !!document.querySelector(
        'meta[property^="og:" i], meta[name^="twitter:" i], meta[name^="og:" i]',
      );

      // Images + lazy-loading adoption.
      const imageCount = document.images.length;
      let lazyImageCount = 0;
      for (const img of Array.from(document.images))
        if ((img.getAttribute('loading') ?? '') === 'lazy') lazyImageCount++;

      // Videos + caption tracks, poster image, accessible title, autoplay-no-controls.
      const videoEls = Array.from(document.querySelectorAll('video'));
      const videoCount = videoEls.length;
      let videosWithoutCaptions = 0;
      let videosWithoutPoster = 0;
      let videosWithoutTitle = 0;
      let autoplayVideosNoControls = 0;
      for (const v of videoEls) {
        if (!v.querySelector('track[kind="captions"], track[kind="subtitles"]')) videosWithoutCaptions++;
        if (!v.getAttribute('poster')) videosWithoutPoster++;
        const titled =
          !!v.getAttribute('aria-label') ||
          !!v.getAttribute('title') ||
          !!v.getAttribute('aria-labelledby') ||
          !!v.querySelector('track[label]');
        if (!titled) videosWithoutTitle++;
        if (v.hasAttribute('autoplay') && !v.hasAttribute('controls')) autoplayVideosNoControls++;
      }

      // PWA / head presence signals — server-rendered in <head>, so stable
      // confirm/refute (not CORS- or hydration-limited).
      const hasManifestLink = !!document.querySelector('link[rel="manifest" i]');
      const hasThemeColor = !!document.querySelector('meta[name="theme-color" i]');
      const hasAppleTouchIcon = !!document.querySelector('link[rel*="apple-touch-icon" i]');
      // A <noscript> counts only when it has MEANINGFUL fallback content — exactly
      // mirroring TechnicalSeoAnalyzer.checkNoscriptContent (>50 chars, no
      // iframe/img). Matching ANY <noscript> would wrongly refute (drop) the
      // finding on the near-universal GTM tracking-pixel `<noscript><iframe>`.
      let hasNoscript = false;
      for (const ns of Array.from(document.querySelectorAll('noscript'))) {
        const c = (ns.textContent ?? '').trim();
        if (c.length > 50 && !c.includes('iframe') && !c.includes('img')) {
          hasNoscript = true;
          break;
        }
      }

      // h2 count (heading structure).
      const h2Count = document.querySelectorAll('h2').length;

      // Inline JS: sum of every <script> with no src and a JS (or default/module)
      // type — skips JSON-LD and other non-JS data blocks.
      let inlineJsBytes = 0;
      for (const sc of Array.from(document.querySelectorAll('script'))) {
        if (sc.getAttribute('src')) continue;
        const stype = (sc.getAttribute('type') ?? '').toLowerCase();
        if (stype && !/javascript|module/.test(stype)) continue;
        inlineJsBytes += (sc.textContent ?? '').length;
      }

      // Internal links served over http:// (mixed-protocol internal linking).
      let httpInternalLinks = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        try {
          const u = new URL(a.getAttribute('href') ?? '', location.href);
          if (u.protocol === 'http:' && u.hostname === location.hostname) httpInternalLinks++;
        } catch {
          /* malformed href — ignore */
        }
      }

      // Skipped heading level — computed with the SAME definition as
      // HeadingAnalyzer (count-based, order-independent): a level h{i} has zero
      // occurrences while the next-deeper level h{i+1} is present (e.g. no h2 but
      // an h3 exists). Must NOT use a DOM-order ascending-jump heuristic — that
      // misses non-ascending layouts (a widget h3 before the main h1) the analyzer
      // flags, which would wrongly REFUTE (drop) a real finding.
      const headingCounts = [1, 2, 3, 4, 5, 6].map((n) => document.querySelectorAll(`h${n}`).length);
      let hasHeadingSkip = false;
      for (let i = 0; i < 5; i++) {
        if (headingCounts[i] === 0 && headingCounts[i + 1] > 0) hasHeadingSkip = true;
      }

      // Text-to-HTML ratio: visible text length / serialized HTML length.
      const htmlLen = document.documentElement.outerHTML.length || 1;
      const visibleText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const textHtmlRatio = visibleText.length / htmlLen;

      // Content freshness: a <time datetime>, article published/modified meta, or
      // JSON-LD datePublished/dateModified.
      const hasFreshnessSignal =
        !!document.querySelector('time[datetime]') ||
        !!document.querySelector(
          'meta[property="article:published_time"], meta[property="article:modified_time"]',
        ) ||
        ldBlocks.some((s) => /"date(Published|Modified)"\s*:/.test(s.textContent ?? ''));

      // Same-origin (internal) anchors — for the dead-end-page check. Also count
      // ALL anchors (totalLinkCount → "too many on-page links") and affiliate
      // links missing rel=sponsored/nofollow (→ "Affiliate link without
      // sponsored/nofollow"). isAffiliate mirrors ExternalLinksAnalyzer.
      const isAffiliate = (href: string): boolean => {
        if (/shareasale|cj\.com|rakuten|awin|impact\.com|clickbank|partnerize/i.test(href)) return true;
        let parsed: URL;
        try {
          parsed = new URL(href, location.href);
        } catch {
          return false;
        }
        if (/(?:^|\.)amazon\./i.test(parsed.hostname) && parsed.searchParams.has('tag')) return true;
        for (const [key, value] of parsed.searchParams) {
          const k = key.toLowerCase();
          if (k === 'affiliate' || k === 'aff' || k === 'affid' || k === 'aff_id') return true;
          if (k === 'utm_source' && /affiliate/i.test(value)) return true;
        }
        return /\/(?:affiliate|aff|partner)\//i.test(parsed.pathname);
      };
      let internalLinkCount = 0;
      let totalLinkCount = 0;
      let affiliateLinksNoRel = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        totalLinkCount++;
        const href = a.getAttribute('href') ?? '';
        try {
          if (new URL(href, location.href).origin === origin) internalLinkCount++;
        } catch {
          /* malformed href — ignore */
        }
        const rel = (a.getAttribute('rel') ?? '').toLowerCase();
        if (isAffiliate(href) && !/\bsponsored\b/.test(rel) && !/\bnofollow\b/.test(rel)) affiliateLinksNoRel++;
      }

      return {
        title: (document.title ?? '').trim(),
        description: descEl ? (descEl.getAttribute('content') ?? '').trim() : null,
        canonical: canonicalEl ? (canonicalEl.getAttribute('href') ?? '').trim() : null,
        htmlLang: (document.documentElement.getAttribute('lang') ?? '').trim(),
        h1Count: document.querySelectorAll('h1').length,
        iframeCount: document.querySelectorAll('iframe').length,
        wordCount,
        semanticRatio,
        emptyAnchorCount,
        inputsWithoutAutocomplete,
        selfPostGetForms,
        scriptsNoSri,
        maxChildren,
        jpgPngImages,
        modernImages,
        renderBlockingTotal,
        renderBlockingThirdParty,
        oversizedImages,
        mainCount,
        resourceHintCount,
        hasImagePreload,
        privacyLinkCount,
        eeatSignals,
        hasAuthorByline,
        inlineCssBytes,
        inputsWithoutLabel,
        duplicateHreflang,
        jsonLdBlocks,
        hasVideoObjectSchema,
        hasSocialTags,
        imageCount,
        lazyImageCount,
        videoCount,
        videosWithoutCaptions,
        videosWithoutPoster,
        videosWithoutTitle,
        autoplayVideosNoControls,
        hasManifestLink,
        hasThemeColor,
        hasAppleTouchIcon,
        hasNoscript,
        h2Count,
        inlineJsBytes,
        httpInternalLinks,
        hasHeadingSkip,
        textHtmlRatio,
        hasFreshnessSignal,
        internalLinkCount,
        totalLinkCount,
        affiliateLinksNoRel,
        hasNoindexMeta,
      };
    });

    // Navigation-timing TTFB (responseStart) + TLS handshake, in ms. TLS is the
    // secure-handshake span (connectEnd − secureConnectionStart); 0/absent
    // secureConnectionStart means the connection was reused (no fresh handshake),
    // reported as null so the checker stays confirm-only.
    const navTiming = await page
      .evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (!nav) return { ttfb: null as number | null, tls: null as number | null };
        return {
          ttfb: Math.round(nav.responseStart),
          tls: nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : null,
        };
      })
      .catch(() => ({ ttfb: null as number | null, tls: null as number | null }));
    const ttfbMs = navTiming.ttfb;

    // axe-core color-contrast scan (bounded). -1 if it doesn't run.
    let contrastViolations = -1;
    try {
      const axe = await Promise.race([
        new AxeBuilder({ page: page as unknown as Page }).withRules(['color-contrast']).analyze(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      if (axe) contrastViolations = axe.violations.reduce((n, v) => n + v.nodes.length, 0);
    } catch {
      /* axe unavailable / timed out → stays -1 (unverified, never refute) */
    }

    // Wait for the in-flight size lookups (request.sizes()) to resolve so the
    // transfer totals are complete before we compute aggregates.
    await Promise.all(sizings).catch(() => undefined);
    const pageReg = registrable(pageHost);
    const thirdParty = requests.filter((r) => r.host && registrable(r.host) !== pageReg);
    const totalBytes = requests.reduce((n, r) => n + r.bytes, 0);
    const imageBytes = requests.filter((r) => r.type === 'image').map((r) => r.bytes);
    const fontReqs = requests.filter((r) => r.type === 'font');

    return {
      url,
      finalUrl,
      status,
      ttfbMs,
      htmlBytes,
      totalBytes,
      totalRequests: requests.length,
      title: dom.title,
      description: dom.description,
      canonical: dom.canonical,
      h1Count: dom.h1Count,
      iframeCount: dom.iframeCount,
      wordCount: dom.wordCount,
      semanticRatio: dom.semanticRatio,
      emptyAnchorCount: dom.emptyAnchorCount,
      inputsWithoutAutocomplete: dom.inputsWithoutAutocomplete,
      selfPostGetForms: dom.selfPostGetForms,
      scriptsNoSri: dom.scriptsNoSri,
      maxChildren: dom.maxChildren,
      jpgPngImages: dom.jpgPngImages,
      modernImages: dom.modernImages,
      renderBlockingTotal: dom.renderBlockingTotal,
      renderBlockingThirdParty: dom.renderBlockingThirdParty,
      thirdPartyOrigins: new Set(thirdParty.map((r) => r.host)).size,
      thirdPartyRequests: thirdParty.length,
      thirdPartyBytes: thirdParty.reduce((n, r) => n + r.bytes, 0),
      adScriptBytes: thirdParty
        .filter((r) => r.type === 'script' && AD_HOST_RE.test(r.host))
        .reduce((n, r) => n + r.bytes, 0),
      largestImageBytes: imageBytes.length ? Math.max(...imageBytes) : 0,
      totalImageBytes: imageBytes.reduce((n, b) => n + b, 0),
      oversizedImages: dom.oversizedImages,
      clsValue: vitals.cls,
      tbtMs: vitals.tbt,
      unusedCssRatio,
      unusedJsRatio,
      preConsentTrackingCookies,
      contrastViolations,
      mainCount: dom.mainCount,
      resourceHintCount: dom.resourceHintCount,
      privacyLinkCount: dom.privacyLinkCount,
      tlsMs: navTiming.tls,
      eeatSignals: dom.eeatSignals,
      headers,
      htmlLang: dom.htmlLang,
      inlineCssBytes: dom.inlineCssBytes,
      inputsWithoutLabel: dom.inputsWithoutLabel,
      duplicateHreflang: dom.duplicateHreflang,
      jsonLdBlocks: dom.jsonLdBlocks,
      hasSocialTags: dom.hasSocialTags,
      imageCount: dom.imageCount,
      lazyImageCount: dom.lazyImageCount,
      videoCount: dom.videoCount,
      hasVideoObjectSchema: dom.hasVideoObjectSchema,
      videosWithoutCaptions: dom.videosWithoutCaptions,
      videosWithoutPoster: dom.videosWithoutPoster,
      videosWithoutTitle: dom.videosWithoutTitle,
      autoplayVideosNoControls: dom.autoplayVideosNoControls,
      hasManifestLink: dom.hasManifestLink,
      hasThemeColor: dom.hasThemeColor,
      hasAppleTouchIcon: dom.hasAppleTouchIcon,
      hasNoscript: dom.hasNoscript,
      h2Count: dom.h2Count,
      inlineJsBytes: dom.inlineJsBytes,
      httpInternalLinks: dom.httpInternalLinks,
      internalLinkCount: dom.internalLinkCount,
      lcpMs: vitals.lcp,
      fcpMs: vitals.fcp,
      fontRequests: fontReqs.length,
      fontBytes: fontReqs.reduce((n, r) => n + r.bytes, 0),
      consoleErrors,
      hasAuthorByline: dom.hasAuthorByline,
      redirectCount,
      redirectStatuses,
      hasHeadingSkip: dom.hasHeadingSkip,
      textHtmlRatio: dom.textHtmlRatio,
      hasFreshnessSignal: dom.hasFreshnessSignal,
      hasImagePreload: dom.hasImagePreload,
      totalLinkCount: dom.totalLinkCount,
      affiliateLinksNoRel: dom.affiliateLinksNoRel,
      hasNoindexMeta: dom.hasNoindexMeta,
    };
  } catch (e) {
    liveFetchErrors.set(url, classifyFetchError(e));
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Total live-navigation attempts (initial + retries), mirroring the crawler's
 * retry budget (THRESHOLDS.RETRY_ATTEMPTS). The single-shot verify pass recorded
 * the first transient miss as a permanent `unreachable` — the dominant cause of
 * low live-confirmation rates, since the crawl itself reaches these same pages
 * only by retrying.
 */
const LIVE_NAV_ATTEMPTS = 3;
const LIVE_NAV_BACKOFF_MS = 800;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Last live-fetch failure reason per URL, recorded by captureOne/fetchLightOnce
 *  so the orchestrator can report WHY a page was unreachable (timeout / network /
 *  nav-error) instead of the opaque catch-all. Reset per verifyReportLive run. */
const liveFetchErrors = new Map<string, string>();

function classifyFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/net::ERR_|\bERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|socket hang up|ENOTFOUND/i.test(msg)) return 'network';
  return 'nav-error';
}

/**
 * tsx/esbuild compiles with keepNames, injecting `__name(fn, "fn")` wrappers
 * around named functions nested inside `page.evaluate(() => …)` callbacks. That
 * helper does NOT exist in the browser, so the WHOLE evaluate throws
 * `ReferenceError: __name is not defined` — and captureOne's single catch then
 * recorded the page as `unreachable`, even though it loaded fine (status 200).
 * This silently neutered the live pass on any site whose DOM-signal evaluate
 * tripped the helper. Inject a no-op shim as the first init script (string
 * content, so it is itself immune to instrumentation). Mirrors the identical fix
 * already in crawler-engine.ts and phase4/competitor-crawl.ts — which is exactly
 * why the crawl reached these pages while the verify pass did not.
 */
async function injectNamePolyfill(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
}

/** Short ` (reason)` suffix for an `unreachable` message, or '' when unknown. */
function unreachableReason(url: string): string {
  const why = liveFetchErrors.get(url);
  return why ? ` (${why})` : '';
}

/**
 * captureOne with retry: re-attempt a fetch that returned null (transient
 * failure) up to {@link LIVE_NAV_ATTEMPTS} times with linear backoff. Clears the
 * recorded error on success so a recovered page reports no failure reason.
 */
async function captureWithRetry(
  browser: Browser,
  url: string,
  timeoutMs: number,
  throttle: Throttle | undefined,
  verbose: boolean,
): Promise<LiveSignals | null> {
  for (let n = 1; n <= LIVE_NAV_ATTEMPTS; n++) {
    const signals = await captureOne(browser, url, timeoutMs, throttle);
    if (signals) {
      liveFetchErrors.delete(url);
      return signals;
    }
    if (n < LIVE_NAV_ATTEMPTS) {
      if (verbose)
        console.log(
          `  … retry ${n}/${LIVE_NAV_ATTEMPTS - 1} for ${url} (${liveFetchErrors.get(url) ?? 'unknown'})`,
        );
      await sleep(LIVE_NAV_BACKOFF_MS * n);
    }
  }
  return null;
}

/* ----------------------------------------------------------- live checkers */

export interface CheckResult {
  status: LiveStatus;
  reason: string;
  /** Categorized reason. Optional on construction; the orchestrator fills a
   *  structural default (no-checker / no-example / unreachable / site-level) when
   *  a checker leaves it unset. `confirmed`/`refuted` are implied by status. */
  code?: VerdictReason;
}
interface LiveChecker {
  kind: string;
  match: (title: string) => boolean;
  check: (s: LiveSignals, f: ReportFinding) => CheckResult;
  /** Site-level / cross-page / instrumentation-only kinds read no live signals,
   *  so the orchestrator skips the fetch for them. */
  noFetch?: boolean;
  /** Site-wide page-level claims that cite no per-page URL (e.g. "most pages
   *  lack resource hints", "low E-E-A-T across site"): the orchestrator fetches
   *  the resolved site homepage once and runs the checker against it. Confirm-only
   *  by nature — one page can't refute a "most/all pages" claim. */
  siteWidePage?: boolean;
}

const confirmed = (reason: string): CheckResult => ({ status: 'confirmed', reason, code: 'confirmed' });
const refuted = (reason: string): CheckResult => ({ status: 'refuted', reason, code: 'refuted' });
/** An `unverified` verdict. `code` categorizes WHY (defaults to `under-observable`,
 *  the most common single-load limitation); pass `volatile` / `site-level` /
 *  `inconclusive` etc. where that fits better. */
const unverifiable = (reason: string, code: VerdictReason = 'under-observable'): CheckResult => ({
  status: 'unverified',
  reason,
  code,
});

/**
 * For RELIABLE signals (DOM structure, timing): confirmed when value > limit,
 * refuted otherwise.
 */
function overLimit(value: number, limit: number, label: string, unit = ''): CheckResult {
  return value > limit
    ? confirmed(`${label} is ${value}${unit} (> ${limit}${unit})`)
    : refuted(`${label} is ${value}${unit} (≤ ${limit}${unit})`);
}

/**
 * For LOAD-DEPENDENT signals (network byte/count aggregates): confirmed when
 * value > limit, but NEVER refuted — a single light load under-triggers
 * consent-gated / lazy / scroll-loaded resources and content-length sums miss
 * chunked responses, so an under-threshold reading isn't trustworthy enough to
 * drop a finding. Below threshold ⇒ unverified, not refuted.
 */
function overOrUnsure(value: number, limit: number, label: string, unit = ''): CheckResult {
  return value > limit
    ? confirmed(`${label} is ${value}${unit} (> ${limit}${unit})`)
    : unverifiable(
        `live load measured ${label} = ${value}${unit} (≤ ${limit}${unit}); a single light load can under-count this — not dropping`,
        'load-dependent',
      );
}

/**
 * Confirm-only for DOM signals a single load can UNDER-observe — lazy /
 * below-the-fold images, JS-injected anchors, content that hydrates after load.
 * Confirmed when the defect is present at load; otherwise `unverified` (the
 * page may exhibit it once fully exercised). NEVER refuted, so a not-yet-loaded
 * page can't drop a real finding.
 */
function presentOrUnsure(
  present: boolean,
  whenPresent: string,
  whenAbsent: string,
  absentCode: VerdictReason = 'under-observable',
): CheckResult {
  return present ? confirmed(whenPresent) : unverifiable(whenAbsent, absentCode);
}

/**
 * Verdict for a title/description length finding. The value is server-rendered
 * and stable at load, so this confirms/refutes on the live measurement (a
 * multi-occurrence refute is later downgraded by guardPluralRefute). A missing
 * value routes to `unverified` — "too long/short" can't be judged on absent
 * text, and a missing title/description is a separate finding. Pure → unit-tested.
 */
export function titleDescriptionVerdict(
  field: 'title' | 'description',
  value: string | null,
  tooLong: boolean,
  min: number,
  max: number,
): CheckResult {
  const text = (value ?? '').trim();
  if (!text)
    return unverifiable(
      `no ${field} on the page now — a missing ${field} is a separate finding, not "too ${tooLong ? 'long' : 'short'}"`,
    );
  const len = text.length;
  if (tooLong) {
    return len > max
      ? confirmed(`${field} is ${len} chars (> ${max})`)
      : refuted(`${field} is ${len} chars (≤ ${max})`);
  }
  return len < min ? confirmed(`${field} is ${len} chars (< ${min})`) : refuted(`${field} is ${len} chars (≥ ${min})`);
}

/**
 * Normalize a URL for equality: drop the fragment and a single trailing slash.
 * The `URL` API already lowercases scheme + host; the PATH is left case-sensitive
 * on purpose — `/Foo` and `/foo` are distinct resources, and the site-graph
 * verifiers make DROP decisions on this equality, so lowercasing the path would
 * collide them and false-refute a real finding.
 */
function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    const href = url.href; // scheme + host already lowercased by URL; path case preserved
    return href.endsWith('/') ? href.slice(0, -1) : href;
  } catch {
    // Mirror the try branch: drop the fragment and a SINGLE trailing slash.
    return u.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

/** Web-font file-count bar for the "too many font files" check (mirrors the
 *  offline verifier's TOO_MANY_FONTS_BAR). */
const TOO_MANY_FONTS_BAR = 4;

// Ordered: more specific kinds first (the first match wins).
const CHECKERS: LiveChecker[] = [
  {
    // A rendered-page defect (broken image, clipped text…) can't be re-observed
    // from a plain fetch, so it must never be refuted.
    kind: 'visual',
    match: isVisualFinding,
    noFetch: true,
    check: () => unverifiable('rendered-page defect — not re-checkable live'),
  },
  {
    kind: 'paginated-canonical',
    match: (t) => /paginat/.test(t) && /canonical/.test(t),
    check: (s) =>
      !s.canonical
        ? confirmed('paginated page has no canonical')
        : normUrl(s.canonical) !== normUrl(s.finalUrl)
          ? confirmed(`canonical (${s.canonical}) is not self-referential`)
          : refuted('canonical is self-referential'),
  },
  {
    kind: 'missing-canonical',
    match: (t) => /canonical/.test(t) && /(not set|missing|without)/.test(t),
    check: (s) => (s.canonical ? refuted(`canonical present: ${s.canonical}`) : confirmed('no canonical link on page')),
  },
  {
    // "Some loc and canonical don't match" — the cited URL IS the sitemap loc;
    // compare it against the page's live canonical. Server-rendered + stable, so
    // confirm AND refute (multi-occurrence refutes are downgraded by the sampling
    // aggregator). A page with NO canonical is the separate "missing canonical"
    // finding (handled above + matched first), so here an absent canonical is
    // inconclusive, never a refute. normUrl equalizes trailing-slash/fragment so
    // a cosmetic-only difference isn't reported as a mismatch.
    kind: 'canonical-mismatch',
    match: (t) => /canonical/.test(t) && /(match|differ)/.test(t),
    check: (s) => {
      if (!s.canonical)
        return unverifiable(
          'no canonical on the page now — a missing canonical is a separate finding, not a loc/canonical mismatch',
          'inconclusive',
        );
      const loc = s.url ?? s.finalUrl;
      return normUrl(s.canonical) !== normUrl(loc)
        ? confirmed(`canonical (${s.canonical}) does not match the page URL (${loc})`)
        : refuted(`canonical matches the page URL (${s.canonical})`);
    },
  },
  {
    // "Multiple redirects detected" / "Pages sit behind a long redirect chain":
    // the cited URL is the chain head; count the live redirect hops. Confirm-only
    // — a 3xx chain can be geo / cookie / Accept-Language dependent (i18n sites),
    // and the report's chain representation is fuzzy, so a short chain on this
    // fetch is not enough to drop the finding. ≥2 hops confirms.
    kind: 'redirect-chain',
    match: (t) => /multiple redirects|redirect chain|long redirect/.test(t),
    check: (s) =>
      s.redirectCount >= 2
        ? confirmed(`navigation followed ${s.redirectCount} redirect hops`)
        : unverifiable(
            `navigation followed ${s.redirectCount} redirect hop(s) on this fetch; redirect chains vary with geo/cookies/Accept-Language — not dropping`,
            'volatile',
          ),
  },
  {
    kind: 'render-blocking-third-party',
    match: (t) => /render-?blocking/.test(t) && /third-?party/.test(t),
    check: (s) =>
      s.renderBlockingThirdParty > 0
        ? confirmed(`${s.renderBlockingThirdParty} render-blocking third-party script(s)`)
        : refuted('no render-blocking third-party scripts'),
  },
  {
    kind: 'render-blocking',
    match: (t) => /render-?blocking/.test(t),
    check: (s) => overLimit(s.renderBlockingTotal, THRESHOLDS.RENDER_BLOCKING_MAX, 'render-blocking resources'),
  },
  {
    kind: 'iframe',
    match: (t) => /iframe/.test(t),
    // Confirm-only: consent-gated / loading="lazy" / facade-pattern iframes
    // (YouTube, maps) mount only after interaction, so 0 iframes at load does
    // NOT prove their absence — never refute on it.
    check: (s) =>
      presentOrUnsure(
        s.iframeCount > 0,
        `${s.iframeCount} iframe(s) present`,
        'no iframes at load — consent-gated/lazy/facade iframes may mount post-interaction; not dropping',
        'volatile',
      ),
  },
  {
    // Single HTML-size checker. The former 'html-exceeds-3mb' band-twin was
    // removed when the analyzer collapsed both bands into one 'Large HTML
    // document' message (report-rules.md §5) — nothing emits an "exceeds 3MB"
    // title anymore. Confirm against the entry (1MB) band; the finding's own
    // detail records which band the crawl-time page crossed.
    kind: 'large-html',
    match: (t) => /(large|big).*html|html.*(large|document)/.test(t),
    check: (s) => overOrUnsure(s.htmlBytes, 1_000_000, 'served HTML', ' bytes'),
  },
  {
    kind: 'heavy-ads',
    match: (t) => /advertis/.test(t),
    check: (s) => overOrUnsure(s.adScriptBytes, 100_000, 'advertising scripts', ' bytes'),
  },
  {
    kind: 'third-party-origins',
    match: (t) => /third-?party/.test(t) && /origin/.test(t),
    check: (s) => overOrUnsure(s.thirdPartyOrigins, 30, 'third-party origins'),
  },
  {
    kind: 'third-party-requests',
    match: (t) => /third-?party/.test(t) && /request/.test(t),
    check: (s) => overOrUnsure(s.thirdPartyRequests, 50, 'third-party requests'),
  },
  {
    kind: 'third-party-payload',
    match: (t) => /third-?party/.test(t) && /(payload|size|weight)/.test(t),
    check: (s) => overOrUnsure(s.thirdPartyBytes, THRESHOLDS.THIRD_PARTY_SIZE_WARNING, 'third-party payload', ' bytes'),
  },
  {
    kind: 'ttfb',
    match: (t) => /ttfb|server response/.test(t),
    // Confirm-only: TTFB swings with CDN POP, cold-vs-warm cache and transient
    // load, so one fast sample isn't enough to drop a slow-server finding.
    check: (s) =>
      s.ttfbMs == null
        ? unverifiable('TTFB not reported by navigation timing', 'volatile')
        : s.ttfbMs > THRESHOLDS.TTFB
          ? confirmed(`TTFB is ${s.ttfbMs}ms (> ${THRESHOLDS.TTFB}ms)`)
          : unverifiable(
              `TTFB is ${s.ttfbMs}ms on this fetch (≤ ${THRESHOLDS.TTFB}ms); TTFB varies with CDN POP / cache warmth — not dropping`,
              'volatile',
            ),
  },
  {
    kind: 'too-many-requests',
    match: (t) => /too many requests/.test(t),
    check: (s) => overOrUnsure(s.totalRequests, THRESHOLDS.REQUEST_COUNT, 'requests'),
  },
  {
    kind: 'page-too-big',
    match: (t) => /size is too big|page.*too (big|large)/.test(t),
    check: (s) => overOrUnsure(s.totalBytes, THRESHOLDS.PAGE_SIZE, 'total transfer', ' bytes'),
  },
  {
    kind: 'oversized-images',
    match: (t) => /image/.test(t) && /larger than (their|the).*display|significantly larger/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.oversizedImages > 0,
        `${s.oversizedImages} image(s) >2× display size`,
        'no oversized images at load — lazy/below-fold images may be unmeasured; not dropping',
      ),
  },
  {
    kind: 'large-image-files',
    match: (t) => /image files larger|image.*(too (big|large)|larger than recommended)/.test(t),
    check: (s) => overOrUnsure(s.largestImageBytes, THRESHOLDS.IMAGE_SIZE_MAX, 'largest image', ' bytes'),
  },
  {
    // "Some pages have excessive total image size" — sum of all image bytes vs
    // TOTAL_IMAGE_SIZE_MAX. Load-dependent (lazy/below-fold images), so confirm-only
    // via overOrUnsure. Placed after large-image-files (per-image) so the
    // total-size wording is owned distinctly.
    kind: 'total-image-size',
    match: (t) => /total image size|excessive total image/.test(t),
    check: (s) => overOrUnsure(s.totalImageBytes, THRESHOLDS.TOTAL_IMAGE_SIZE_MAX, 'total image size', ' bytes'),
  },
  {
    kind: 'legacy-image-format',
    match: (t) => /(jpg|png).*(webp|avif)|webp\/avif|images only as/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.jpgPngImages > 0,
        `${s.jpgPngImages} JPG/PNG image(s) served (${s.modernImages} modern)`,
        'no JPG/PNG images at load — lazy images may be unmeasured; not dropping',
      ),
  },
  {
    // "Affiliate link without sponsored/nofollow" — the cited page is scanned for
    // affiliate-looking outbound links (mirrors ExternalLinksAnalyzer) missing
    // BOTH rel=sponsored and rel=nofollow. Confirm-only: links can hydrate, so
    // absence at load isn't proof; never refuted. MUST precede `empty-anchor`,
    // whose `/links? without/` matcher would otherwise claim "…link without…".
    kind: 'affiliate-link',
    match: (t) => /affiliate link/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.affiliateLinksNoRel > 0,
        `${s.affiliateLinksNoRel} affiliate link(s) without rel=sponsored/nofollow`,
        'no unmarked affiliate links at load — links may hydrate; not dropping',
      ),
  },
  {
    kind: 'empty-anchor',
    match: (t) => /empty anchor|links? without|without any text/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.emptyAnchorCount > 0,
        `${s.emptyAnchorCount} empty-anchor link(s)`,
        'no empty-anchor links at load — JS-injected links may be unmeasured; not dropping',
      ),
  },
  {
    kind: 'autocomplete',
    match: (t) => /autocomplete/.test(t),
    // Confirm-only: unlike the <head>-based checkers, form inputs commonly mount
    // behind interaction (modals, multi-step wizards, route-gated/tabbed forms),
    // so 0 eligible inputs at load doesn't prove the defect is gone — never
    // refute on it.
    check: (s) =>
      presentOrUnsure(
        s.inputsWithoutAutocomplete > 0,
        `${s.inputsWithoutAutocomplete} input(s) without autocomplete`,
        'no inputs without autocomplete at load — forms may mount behind interaction; not dropping',
      ),
  },
  {
    // "Form submits to itself via GET" (FormAccessibilityAnalyzer) — a GET/
    // defaulted form with a non-navigating action + a sensitive field, so its
    // fields leak to the URL. Confirm-only, like the sibling form checkers above:
    // a self-posting GET form is a stable server-rendered signal when present,
    // but forms can hydrate behind interaction, so 0 at load isn't proof the
    // defect is gone — never refute.
    kind: 'form-empty-action',
    match: (t) => /form/.test(t) && /(submits to itself|self-post|posts to itself|empty action|missing action)/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.selfPostGetForms > 0,
        `${s.selfPostGetForms} form(s) self-post via GET with a sensitive field`,
        'no self-post-GET data form at load — forms may mount behind interaction; not dropping',
      ),
  },
  {
    kind: 'sri-missing',
    match: (t) => /subresource integrity|sri/.test(t),
    check: (s) =>
      s.scriptsNoSri > 0
        ? confirmed(`${s.scriptsNoSri} cross-origin script(s) without integrity`)
        : refuted('all cross-origin scripts have SRI'),
  },
  {
    kind: 'excessive-dom-children',
    match: (t) => /too many children|excessive dom|dom size/.test(t),
    check: (s) => overLimit(s.maxChildren, THRESHOLDS.DOM_CHILDREN_WARNING, 'max element children'),
  },
  {
    kind: 'semantic-html',
    match: (t) => /semantic html/.test(t),
    check: (s) =>
      s.semanticRatio < 0.3
        ? confirmed(`semantic-HTML ratio ${(s.semanticRatio * 100).toFixed(0)}% (site-wide claim; this page is low)`)
        : unverifiable(
            `this page's semantic ratio is ${(s.semanticRatio * 100).toFixed(0)}% — site-wide claim not provable from one page`,
          ),
  },
  {
    kind: 'thin-content',
    match: (t) => /thin content|low content|very thin/.test(t),
    check: (s) =>
      s.wordCount < THRESHOLDS.THIN_CONTENT_LOW
        ? confirmed(`${s.wordCount} words (< ${THRESHOLDS.THIN_CONTENT_LOW})`)
        : unverifiable(
            `${s.wordCount} words at load (≥ ${THRESHOLDS.THIN_CONTENT_LOW}); content may hydrate/lazy-load — not dropping`,
          ),
  },
  {
    // Title length — a stable, server-rendered signal, so confirm/refute both
    // apply (multi-occurrence refutes are downgraded by guardPluralRefute).
    kind: 'title-length',
    match: (t) => /title/.test(t) && /(too short|too long)/.test(t),
    check: (s, f) =>
      titleDescriptionVerdict(
        'title',
        s.title,
        /too long/.test(f.title.toLowerCase()),
        THRESHOLDS.TITLE_MIN,
        THRESHOLDS.TITLE_MAX,
      ),
  },
  {
    kind: 'description-length',
    match: (t) => /description/.test(t) && /(too short|too long)/.test(t),
    check: (s, f) =>
      titleDescriptionVerdict(
        'description',
        s.description,
        /too long/.test(f.title.toLowerCase()),
        THRESHOLDS.DESCRIPTION_MIN,
        THRESHOLDS.DESCRIPTION_MAX,
      ),
  },
  {
    // "Description meta tag is missing" — the `<meta name="description">` is
    // server-rendered, so this confirms AND refutes (plural-guarded). Placed AFTER
    // description-length, whose "too short/long" matcher is disjoint from "missing".
    kind: 'missing-description',
    match: (t) => /description/.test(t) && /(missing|not set|without|absent|no meta description)/.test(t),
    check: (s) =>
      s.description
        ? refuted(`meta description present (${s.description.length} chars)`)
        : confirmed('no meta description on the page'),
  },
  {
    // "Pages in sitemap are marked noindex" / "Page is noindexed": a noindex
    // directive via `<meta name="robots">` OR the X-Robots-Tag header. Both are
    // server-rendered + stable → confirm AND refute (plural-guarded). Distinct
    // from `x-robots-noindex` (registered below): that one matches only the
    // header-specific wording (`/x-robots-tag/ && /noindex/`), which this matcher
    // does not catch, so the two don't shadow each other regardless of order;
    // this owns the meta-robots / sitemap-noindex findings.
    kind: 'noindex',
    match: (t) => /marked noindex|in sitemap.*noindex|noindex directive|page is noindex|noindexed/.test(t),
    check: (s) => {
      const headerNoindex = /noindex/i.test(s.headers['x-robots-tag'] ?? '');
      return s.hasNoindexMeta || headerNoindex
        ? confirmed(`page declares noindex (${s.hasNoindexMeta ? 'meta robots' : 'X-Robots-Tag header'})`)
        : refuted('no noindex directive (meta robots or X-Robots-Tag) on the page now');
    },
  },
  {
    // "Missing <main> element" / "has no landmark". `<main>` (or role="main") is
    // server-rendered structure → confirm/refute both apply.
    kind: 'missing-main',
    // Scoped to the <main> landmark only, with `main` word-boundaried. This
    // checker can REFUTE (drop) when a <main> is present (true on most pages), so
    // a loose match would silently drop unrelated findings: a bare /landmark/ arm
    // would catch "Missing <nav>/<header> landmark", and an unbounded `main`
    // would catch "FAQPage missing mainEntity array" (HIGH structured-data) via
    // the "main" substring of "mainEntity". \bmain\b matches <main> / role="main"
    // but not mainEntity.
    match: (t) => /missing.*\bmain\b|<main>|role="main"/.test(t),
    check: (s) =>
      s.mainCount === 0
        ? confirmed('no <main> / role="main" landmark on the page')
        : refuted(`${s.mainCount} <main>/role="main" landmark(s) present`),
  },
  {
    // "No privacy policy link found". Footer privacy links are server-rendered →
    // confirm/refute both apply (plural-guarded for multi-page findings).
    kind: 'privacy-link',
    match: (t) => /privacy policy link|privacy.*link|no.*privacy/.test(t),
    check: (s) =>
      s.privacyLinkCount === 0
        ? confirmed('no visible privacy-policy link on the page')
        : refuted(`${s.privacyLinkCount} privacy-policy link(s) present`),
  },
  // ---- Slice 2: response-header checkers. The main-document headers are
  // server-rendered and stable at load, so these confirm AND refute (plural
  // findings still gated by the sampling aggregator). All read `s.headers`
  // (lowercased keys); an empty header map → unverified, never a false refute.
  {
    kind: 'x-robots-noindex',
    match: (t) => /x-robots-tag/.test(t) && /noindex/.test(t),
    check: (s) =>
      Object.keys(s.headers).length === 0
        ? unverifiable('response headers unavailable on this fetch', 'unreachable')
        : /noindex/i.test(s.headers['x-robots-tag'] ?? '')
          ? confirmed('X-Robots-Tag response header still includes noindex')
          : refuted('no noindex in the X-Robots-Tag header now (header absent or changed)'),
  },
  {
    kind: 'permissions-policy',
    match: (t) => /missing permissions-policy/.test(t),
    check: (s) =>
      Object.keys(s.headers).length === 0
        ? unverifiable('response headers unavailable on this fetch', 'unreachable')
        : s.headers['permissions-policy']
          ? refuted(`Permissions-Policy header present: ${(s.headers['permissions-policy'] ?? '').slice(0, 60)}`)
          : confirmed('no Permissions-Policy response header'),
  },
  {
    kind: 'cross-origin-isolation',
    match: (t) => /cross-origin isolation/.test(t),
    check: (s) => {
      if (Object.keys(s.headers).length === 0)
        return unverifiable('response headers unavailable on this fetch', 'unreachable');
      const coop = !!s.headers['cross-origin-opener-policy'];
      const coep = !!s.headers['cross-origin-embedder-policy'];
      return coop && coep
        ? refuted('both COOP and COEP headers are present')
        : confirmed(
            `cross-origin isolation headers missing (COOP: ${coop ? 'yes' : 'no'}, COEP: ${coep ? 'yes' : 'no'})`,
          );
    },
  },
  {
    kind: 'server-disclosure',
    match: (t) => /server (technology|version) disclosed/.test(t),
    check: (s) => {
      if (Object.keys(s.headers).length === 0)
        return unverifiable('response headers unavailable on this fetch', 'unreachable');
      const disclosed = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'].filter((h) => s.headers[h]);
      return disclosed.length > 0
        ? confirmed(
            `tech-disclosing header(s) still present: ${disclosed
              .map((h) => `${h}: ${s.headers[h]}`)
              .join(', ')
              .slice(0, 80)}`,
          )
        : refuted('no server-technology-disclosing headers now');
    },
  },
  {
    kind: 'vary-user-agent',
    match: (t) => /vary.*user-agent|user-agent.*vary|dynamic serving/.test(t),
    check: (s) =>
      Object.keys(s.headers).length === 0
        ? unverifiable('response headers unavailable on this fetch', 'unreachable')
        : /user-agent/i.test(s.headers['vary'] ?? '')
          ? confirmed(`Vary header still includes User-Agent: ${s.headers['vary']}`)
          : refuted('Vary header no longer includes User-Agent'),
  },
  {
    kind: 'content-language-mismatch',
    match: (t) => /content-language.*mismatch|content-language header mismatch/.test(t),
    check: (s) => {
      const header = (s.headers['content-language'] ?? '').trim().toLowerCase();
      const lang = s.htmlLang.toLowerCase();
      if (!header || !lang)
        return unverifiable(
          'Content-Language header or html lang attribute absent now — a mismatch needs both',
          'inconclusive',
        );
      // Compare the primary subtag (en-US vs en) to avoid a spurious mismatch.
      const prim = (v: string): string => v.split(/[,;]/)[0].trim().split('-')[0];
      return prim(header) !== prim(lang)
        ? confirmed(`Content-Language "${header}" still mismatches html lang "${lang}"`)
        : refuted(`Content-Language "${header}" now matches html lang "${lang}"`);
    },
  },
  {
    kind: 'compression',
    match: (t) => /not compressed|without compression|compression not detected|enabling brotli/.test(t),
    check: (s, f) => {
      if (Object.keys(s.headers).length === 0)
        return unverifiable('response headers unavailable on this fetch', 'unreachable');
      const enc = (s.headers['content-encoding'] ?? '').toLowerCase();
      // Brotli-specific finding ("Brotli compression not detected" / "Consider
      // enabling Brotli"): confirmed unless the response is actually br-encoded.
      if (/brotli/i.test(f.title)) {
        return /\bbr\b/.test(enc)
          ? refuted(`response is now Brotli-compressed (content-encoding: ${enc})`)
          : confirmed(`response not Brotli-compressed (content-encoding: ${enc || 'none'})`);
      }
      // Generic "served without compression": confirmed only when NO compression
      // header is present at all; any gzip/br/deflate/zstd refutes.
      return /\b(gzip|br|deflate|zstd)\b/.test(enc)
        ? refuted(`response is compressed (content-encoding: ${enc})`)
        : confirmed('response served without content-encoding (uncompressed)');
    },
  },
  {
    kind: 'tls',
    // Scoped to the handshake-TIME finding only. A bare /\btls\b/ would also
    // match "Outdated TLS version" / "upgrade to TLS 1.3" (version claims), and
    // this check keys on handshake duration (tlsMs) — unrelated to a version —
    // so it could stamp a version finding ✓ Verified on irrelevant evidence.
    match: (t) => /tls negotiation|slow tls/.test(t),
    // Confirm-only: the TLS handshake span varies with session resumption, CDN
    // POP and connection reuse, so a fast (or reused → null) sample isn't enough
    // to drop a slow-handshake finding.
    check: (s) =>
      s.tlsMs == null
        ? unverifiable(
            'TLS handshake time not reported (connection reused / no fresh secure handshake on this navigation)',
            'volatile',
          )
        : s.tlsMs > THRESHOLDS.TLS_HANDSHAKE
          ? confirmed(`TLS handshake ${s.tlsMs}ms (> ${THRESHOLDS.TLS_HANDSHAKE}ms)`)
          : unverifiable(
              `TLS handshake ${s.tlsMs}ms on this fetch (≤ ${THRESHOLDS.TLS_HANDSHAKE}ms); handshake time varies with session resumption / CDN POP — not dropping`,
              'volatile',
            ),
  },
  {
    // "Most pages lack resource hints" — cites no per-page URL, so it runs
    // against the resolved homepage (siteWidePage). Confirm-only: one page with
    // hints can't disprove a site-wide "most pages lack them" claim.
    kind: 'resource-hints',
    siteWidePage: true,
    // Scoped to the site-wide "Most pages lack resource hints" finding only.
    // A bare /preconnect|dns-prefetch/ would also capture per-page preconnect
    // findings that cite their OWN example URL — force-routing them through the
    // homepage hint-count check instead of their specific claim.
    match: (t) => /resource hints/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.resourceHintCount === 0,
        'homepage has no preconnect/preload/dns-prefetch/prefetch hints',
        `homepage has ${s.resourceHintCount} resource hint(s); a site-wide "most pages lack hints" claim can't be settled from one page — not dropping`,
        'site-level',
      ),
  },
  {
    // "Low E-E-A-T signals across site" — a site-wide average; cites no per-page
    // URL, so it runs against the homepage (siteWidePage). Confirm-only.
    kind: 'eeat',
    siteWidePage: true,
    match: (t) => /e-e-a-t|eeat|experience.*expertise|authoritativeness/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.eeatSignals === 0,
        'homepage shows no author / about / contact / Person-or-Organization-schema E-E-A-T signals',
        `homepage shows ${s.eeatSignals} E-E-A-T signal(s); a site-wide average can't be settled from one page — not dropping`,
        'site-level',
      ),
  },
  {
    // "LCP images not preloaded across site" — a site-wide claim that cites no
    // per-page URL, so it runs against the resolved homepage (siteWidePage).
    // Must precede the `vitals` checker, whose /\blcp\b/ matcher would otherwise
    // claim it. Confirm-only: a homepage that DOES preload its LCP image can't
    // refute a "most pages don't" claim. The preload `<link>` is server-rendered
    // and stable, so its absence on the homepage is a solid confirmation.
    kind: 'lcp-preload',
    siteWidePage: true,
    match: (t) => /lcp/.test(t) && /preload/.test(t),
    check: (s) =>
      presentOrUnsure(
        !s.hasImagePreload,
        'homepage declares no <link rel="preload" as="image"> for the LCP image',
        'homepage has an LCP-image preload; a site-wide "not preloaded across site" claim can\'t be refuted from one page — not dropping',
        'site-level',
      ),
  },
  // Site-level / cross-page / instrumentation-only kinds: a single live page
  // load cannot adjudicate these. Marked noFetch (the orchestrator skips the
  // fetch) and reported as `unverified` with the reason.
  {
    // Exact-duplicate title/description AND same-page parameterized variants
    // that share a title/description ("Parameterized URLs share a title"). Both
    // are adjudicated by the `verifyDuplicate` special handler, which fetches the
    // first 2 cited pages and compares the field — the comparison is identical.
    kind: 'duplicate',
    noFetch: true,
    match: (t) =>
      /duplicate (page )?(title|meta description)/.test(t) ||
      /identical (page )?(titles?|descriptions?|meta descriptions?)/.test(t) ||
      /parameterized urls share a (title|description)/.test(t),
    check: () =>
      unverifiable('duplication needs ≥2 pages compared — single-page live fetch cannot confirm', 'site-level'),
  },
  {
    kind: 'site-graph',
    noFetch: true,
    match: (t) =>
      /orphan|unreachable|missing from sitemap|not (listed )?in sitemap|link equity|click depth|clicks? from (the )?home|more than \d+ clicks/.test(
        t,
      ),
    check: () => unverifiable('site-level (link graph / sitemap) — not derivable from one live page', 'site-level'),
  },
  {
    // Keyword cannibalisation: "Multiple pages target the same keyword in their
    // titles". Cross-page — the special verifier fetches the first 2 cited pages
    // and checks their titles for a shared keyword. Confirm-only.
    kind: 'cannibalisation',
    noFetch: true,
    match: (t) => /same keyword|cannibal|keyword.*(in (their )?titles?|conflict)/.test(t),
    check: () => unverifiable('keyword cannibalisation handled by the special multi-page verifier', 'site-level'),
  },
  {
    // Cross-page topic aggregates ("Many topics with thin coverage",
    // "High-opportunity content gaps") are computed over the WHOLE crawl's topic
    // clusters — a single live page can't reproduce them. Owned (so it isn't a
    // "no live checker" gap) and routed to the offline / LLM pass.
    kind: 'topic-coverage',
    noFetch: true,
    match: (t) => /topic|content gap|topical/.test(t),
    check: () =>
      unverifiable(
        'cross-page topic / coverage aggregate (computed over the whole crawl) — not derivable from a single live page; use the offline or LLM verification pass',
        'site-level',
      ),
  },
  {
    // "A notable share of pages have near-duplicate content" / "Pages have very
    // similar content" — a cross-page shingle-similarity aggregate
    // (ContentSimilarityAnalyzer) over the whole crawl. Owned (not a "no live
    // checker" gap) and routed to the offline/LLM pass.
    kind: 'near-duplicate-content',
    noFetch: true,
    match: (t) =>
      /near-duplicate content|near duplicate content|notable share.*near-duplicate|(very |highly )?similar content|pages have .*similar content/.test(
        t,
      ),
    check: () =>
      unverifiable(
        'cross-page near-duplicate-content aggregate (shingle similarity over the whole crawl) — not derivable from a single live page',
        'site-level',
      ),
  },
  {
    // "Low AI content structure score" — a per-page AEO composite (headings,
    // lists, Q&A, semantic ratio, …) aggregated site-wide. A single live load
    // can't reproduce the score; owned and routed to the offline/LLM pass rather
    // than the "no live checker" gap.
    kind: 'ai-content-structure',
    noFetch: true,
    match: (t) => /ai content structure|content structure score/.test(t),
    check: () =>
      unverifiable(
        'AEO content-structure score is a composite per-page/site-wide aggregate — not settled by a single live load; use the offline or LLM pass',
        'site-level',
      ),
  },
  {
    kind: 'broken-pagination',
    noFetch: true,
    match: (t) => /broken pagination|pagination wastes/.test(t),
    check: () => unverifiable('series-level claim — needs the full paginated series, not one page', 'site-level'),
  },
  {
    // Per-page "Page has N broken outbound link(s)": the example's first URL is
    // the ON-SITE container page, not the dead link — fetching it gets HTTP 200
    // and would FALSELY refute. Routed to a special verifier that fetches the
    // cited external link instead. Listed before the site-wide kind below.
    kind: 'broken-outbound-page',
    noFetch: true,
    match: (t) => /page has \d+ broken outbound|broken outbound link\(s\)/.test(t),
    check: () => unverifiable('per-page broken-outbound handled by the special verifier', 'site-level'),
  },
  {
    // Site-wide "Broken outbound link": the example URL IS the dead link.
    // Handled by the verifyBrokenOutbound special verifier (lightweight fetch,
    // no axe/coverage/scroll), confirm-only — external-link liveness is volatile
    // (transient outage recovered, anti-bot/rate-limit answering our UA), so a
    // sub-400 status now never drops the finding. (Excludes the per-page kind.)
    kind: 'broken-outbound',
    noFetch: true,
    match: (t) => /broken outbound|broken (external )?link/.test(t) && !/page has/.test(t),
    check: () => unverifiable('site-wide broken-outbound handled by the special verifier', 'site-level'),
  },
  {
    // robots.txt AI-crawler rules ("No explicit AI crawler rules in robots.txt",
    // "AI crawlers blocked in robots.txt"). Site-wide and stable: handled by the
    // special verifier, which fetches robots.txt once and checks the rules.
    kind: 'robots-ai',
    noFetch: true,
    match: (t) => /robots\.txt/.test(t) && /(ai crawler|gptbot|claudebot|perplexity|ai bot)/.test(t),
    check: () => unverifiable('robots.txt AI-crawler rules handled by the special verifier', 'site-level'),
  },
  {
    // Per-page "URL is too long" (both size bands collapsed into one message,
    // report-rules.md §5). The analyzer's basis is PATH+QUERY length >
    // URL_LENGTH_RECOMMENDED (lib/utils.ts analyzeUrlStructure), so confirm/refute
    // against path+query vs RECOMMENDED — NOT full-URL vs MAX, or a legitimate
    // recommended-band (76–100-char) finding is falsely refuted. Ordered BEFORE
    // the site-wide checker; note this matcher (`url is too long`) does NOT match
    // the site-wide "some urls are too long" wording ("urls are" ≠ "url is").
    kind: 'url-length',
    match: (t) => /url is too long/.test(t),
    check: (s, f) => {
      const u = s.url ?? s.finalUrl ?? f.exampleUrl ?? '';
      let plen: number;
      try {
        const parsed = new URL(u);
        plen = (parsed.pathname + parsed.search).length;
      } catch {
        plen = u.length; // not a parseable absolute URL — fall back to raw length
      }
      return plen > THRESHOLDS.URL_LENGTH_RECOMMENDED
        ? confirmed(`URL is ${plen} chars (path+query, > ${THRESHOLDS.URL_LENGTH_RECOMMENDED})`)
        : refuted(`URL is ${plen} chars (path+query, ≤ ${THRESHOLDS.URL_LENGTH_RECOMMENDED})`);
    },
  },
  {
    // Site-wide "Some URLs are too long" — a DIFFERENT analyzer
    // (url-architecture-analyzer) whose basis is FULL-URL length > URL_LENGTH_MAX
    // (100), not path+query. Judge on full-URL vs MAX so a long-origin/short-path
    // URL (path+query ≤ 75 but full > 100 — the shape this finding actually cites)
    // confirms instead of being falsely refuted.
    kind: 'urls-too-long-sitewide',
    match: (t) => /some urls are too long/.test(t),
    check: (s, f) => {
      const u = s.url ?? s.finalUrl ?? f.exampleUrl ?? '';
      const len = u.length;
      return len > THRESHOLDS.URL_LENGTH_MAX
        ? confirmed(`URL is ${len} chars (> ${THRESHOLDS.URL_LENGTH_MAX})`)
        : refuted(`URL is ${len} chars (≤ ${THRESHOLDS.URL_LENGTH_MAX})`);
    },
  },
  {
    // URL depth — path-segment count of the sampled page. Deterministic → confirm/refute.
    kind: 'url-depth',
    match: (t) => /url is too deep|urls? are too deep/.test(t),
    check: (s, f) => {
      // Per-sample URL (see url-length) — evaluate each example, not the first one N times.
      const u = s.url ?? s.finalUrl ?? f.exampleUrl ?? '';
      let depth: number;
      try {
        depth = new URL(u).pathname.split('/').filter(Boolean).length;
      } catch {
        return unverifiable('cited URL is unparseable', 'inconclusive');
      }
      return depth > THRESHOLDS.URL_DEPTH_MAX
        ? confirmed(`URL is ${depth} levels deep (> ${THRESHOLDS.URL_DEPTH_MAX})`)
        : refuted(`URL is ${depth} levels deep (≤ ${THRESHOLDS.URL_DEPTH_MAX})`);
    },
  },
  {
    // "URL contains uppercase letters" — uppercase in the path/query is
    // deterministic on the cited/sampled URL (the host is case-insensitive, so
    // only path+query count). Mirrors UrlArchitectureAnalyzer's check, so it
    // confirms AND refutes. Per-sample URL like url-length/url-depth.
    kind: 'url-case',
    match: (t) => /uppercase letters? in (the )?url|url.*contains? uppercase|uppercase.*in (the )?url/.test(t),
    check: (s, f) => {
      const u = s.url ?? s.finalUrl ?? f.exampleUrl ?? '';
      let pathQuery: string;
      try {
        const parsed = new URL(u);
        pathQuery = parsed.pathname + parsed.search;
      } catch {
        return unverifiable('cited URL is unparseable', 'inconclusive');
      }
      return /[A-Z]/.test(pathQuery)
        ? confirmed(`URL path contains uppercase letters: ${pathQuery.slice(0, 60)}`)
        : refuted(`URL path has no uppercase letters: ${pathQuery.slice(0, 60)}`);
    },
  },
  {
    // "Session ID detected in URL" — the cited URL is deterministic, so this
    // confirms AND refutes against the flagged URL. Mirrors the analyzer's exact
    // detection (UrlArchitectureAnalyzer): a session-keyword QUERY PARAM key, or a
    // path-embedded `…sid=` assignment — NOT a bare substring, so ordinary words
    // like "resident"/"residential" (which contain "sid") correctly refute,
    // catching that stale false positive. Plural-guarded by the sampler.
    kind: 'session-id',
    match: (t) => /session\s?id/.test(t),
    check: (s, f) => {
      const u = s.url ?? s.finalUrl ?? f.exampleUrl ?? '';
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return unverifiable('cited URL is unparseable', 'inconclusive');
      }
      const params = ['sessionid', 'session_id', 'sid', 'phpsessid', 'jsessionid', 'aspsessionid'];
      const set = new Set(params);
      const hasQueryParam = [...parsed.searchParams.keys()].some((k) => set.has(k.toLowerCase()));
      const pathPattern = new RegExp(`(?:^|[/;,&?])(?:${params.join('|')})=`, 'i');
      return hasQueryParam || pathPattern.test(parsed.pathname)
        ? confirmed('URL carries a session-id parameter')
        : refuted(`URL has no session-id parameter (${parsed.pathname}${parsed.search})`);
    },
  },
  {
    // "Too many on-page links" — total anchor count vs LINKS_PER_PAGE_WARNING.
    // Confirm-only via overOrUnsure: the count can only GROW as JS-injected links
    // hydrate, so under-threshold at load isn't enough to drop the finding.
    kind: 'too-many-links',
    match: (t) => /too many on-page links/.test(t),
    check: (s) => overOrUnsure(s.totalLinkCount, THRESHOLDS.LINKS_PER_PAGE_WARNING, 'on-page links'),
  },
  {
    // Form controls without an accessible label / placeholder-as-label. Confirm-only:
    // forms can hydrate after load, so absence at load isn't proof.
    kind: 'form-labels',
    match: (t) =>
      /inputs?.*missing label|missing label|placeholder used instead of label|placeholder as [^.]*label|labels? are missing|(field|input|control)s?[^.]*lack[^.]*label/.test(
        t,
      ),
    check: (s) =>
      presentOrUnsure(
        s.inputsWithoutLabel > 0,
        `${s.inputsWithoutLabel} form control(s) with no associated label`,
        'no unlabelled form controls at load — forms may hydrate; not dropping',
      ),
  },
  {
    // Inline CSS bytes vs the analyzer's warning threshold. Confirm-only: more
    // <style> can be injected during hydration, so under-threshold isn't a refute.
    kind: 'inline-css',
    match: (t) => /inline css/.test(t),
    check: (s) => overOrUnsure(s.inlineCssBytes, THRESHOLDS.INLINE_CSS_SIZE_WARNING, 'inline CSS', ' bytes'),
  },
  // ---- Tier-B: kinds surfaced once LOW is live-checked, backed by new signals ----
  {
    // "Some pages have more than 10 h2 tags" — h2 count is server-rendered, so
    // confirm AND refute against the threshold (mirrors multiple-h1).
    kind: 'h2-count',
    match: (t) => /more than \d+ h2|excessive h2|too many h2|h2 tags?/.test(t),
    check: (s) => overLimit(s.h2Count, THRESHOLDS.H2_COUNT, 'h2 count'),
  },
  {
    // "Large amount of inline JavaScript" — inline (no-src) <script> bytes vs the
    // warning threshold. Confirm-only via overOrUnsure (frameworks can inject more
    // inline JS while hydrating, so under-threshold at load isn't a refute).
    kind: 'inline-js',
    match: (t) => /inline javascript|inline js/.test(t),
    check: (s) => overOrUnsure(s.inlineJsBytes, THRESHOLDS.INLINE_JS_SIZE_WARNING, 'inline JS', ' bytes'),
  },
  {
    // "No web app manifest" — <link rel="manifest"> is server-rendered in <head>,
    // so confirm (absent) AND refute (present).
    kind: 'pwa-manifest',
    match: (t) => /web app manifest|manifest\.json|no (web )?manifest|app not installable/.test(t),
    check: (s) =>
      s.hasManifestLink
        ? refuted('a <link rel="manifest"> is present')
        : confirmed('no <link rel="manifest"> in the document head'),
  },
  {
    // "No theme-color meta tag" — server-rendered; confirm/refute.
    kind: 'theme-color',
    match: (t) => /theme-color/.test(t),
    check: (s) =>
      s.hasThemeColor
        ? refuted('a <meta name="theme-color"> is present')
        : confirmed('no <meta name="theme-color"> in the document head'),
  },
  {
    // "No Apple touch icon" — server-rendered; confirm/refute.
    kind: 'apple-touch-icon',
    match: (t) => /apple[ -]touch[ -]icon/.test(t),
    check: (s) =>
      s.hasAppleTouchIcon
        ? refuted('an apple-touch-icon link is present')
        : confirmed('no apple-touch-icon link in the document head'),
  },
  {
    // "No noscript fallback content" — <noscript> presence is server-rendered.
    kind: 'noscript',
    match: (t) => /noscript fallback|no noscript/.test(t),
    check: (s) =>
      s.hasNoscript
        ? refuted('a <noscript> element is present')
        : confirmed('no <noscript> fallback in the document'),
  },
  {
    // "Videos without poster image" — confirm-only (videos can lazy-mount, so
    // none-at-load isn't a refute).
    kind: 'video-poster',
    match: (t) => /videos? without (a )?poster|poster image/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.videosWithoutPoster > 0,
        `${s.videosWithoutPoster} video(s) without a poster image`,
        'no posterless video at load — videos may lazy-mount; not dropping',
      ),
  },
  {
    // "Videos without accessible title" — confirm-only.
    kind: 'video-title',
    match: (t) => /videos? without (an )?accessible title|videos? without (a )?title/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.videosWithoutTitle > 0,
        `${s.videosWithoutTitle} video(s) with no accessible name`,
        'no unlabelled video at load — videos may lazy-mount; not dropping',
      ),
  },
  {
    // "Autoplay video without pause controls" — confirm-only.
    kind: 'autoplay-video',
    match: (t) => /autoplay video|video.*autoplay|without pause controls/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.autoplayVideosNoControls > 0,
        `${s.autoplayVideosNoControls} autoplaying video(s) without controls`,
        'no autoplay-without-controls video at load — videos may lazy-mount; not dropping',
      ),
  },
  {
    // "Internal links use HTTP instead of HTTPS" — confirm-only (links hydrate).
    kind: 'http-internal-links',
    match: (t) => /internal links? use http|http instead of https/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.httpInternalLinks > 0,
        `${s.httpInternalLinks} internal link(s) use http://`,
        'no http:// internal link at load — links may hydrate; not dropping',
      ),
  },
  // ---- Tier-C: deferred kinds now backed by signals (confirm-only / confirm-refute) ----
  {
    // "Requested URLs redirect before serving the page" — confirm-only on the live
    // redirect count (redirects vary by geo/cookie, so absence isn't a refute).
    kind: 'redirect-served',
    match: (t) => /redirect before serving|requested urls? redirect/.test(t),
    check: (s) =>
      s.redirectCount > 0
        ? confirmed(`the URL redirects ${s.redirectCount} time(s) before serving`)
        : unverifiable('no redirect on this live load — redirects vary by geo/cookie; not dropping', 'volatile'),
  },
  {
    // "Temporary redirect used instead of permanent" — confirm-only when a live
    // hop is 302/303/307 (a temporary status). Never refutes (chain varies).
    kind: 'redirect-temporary',
    match: (t) => /temporary redirect|redirect used instead of permanent|302 redirect/.test(t),
    check: (s) =>
      s.redirectStatuses.some((c) => c === 302 || c === 303 || c === 307)
        ? confirmed(`a temporary redirect (${s.redirectStatuses.join('→')}) was served`)
        : unverifiable('no temporary-redirect hop on this live load; not dropping', 'volatile'),
  },
  {
    // "Skipped heading level" / "incorrect h tags structure" — heading sequence is
    // server-rendered, so confirm AND refute.
    kind: 'skipped-heading',
    match: (t) => /skipped heading|incorrect h tags? structure|heading.*level.*(skip|missing)|preceding tag h\d/.test(t),
    check: (s) =>
      s.hasHeadingSkip
        ? confirmed('a heading level is skipped (e.g. h1→h3)')
        : refuted('no heading level is skipped in the rendered document'),
  },
  {
    // "Low text-to-HTML ratio" — confirm-only via presentOrUnsure: the ratio only
    // RISES as content hydrates, so a not-low ratio at load isn't a refute.
    kind: 'text-html-ratio',
    match: (t) => /text-to-html ratio|text to html ratio/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.textHtmlRatio < 0.25,
        `text-to-HTML ratio is low (${Math.round(s.textHtmlRatio * 100)}%)`,
        'text-to-HTML ratio not low at load — content may hydrate; not dropping',
      ),
  },
  {
    // "No content freshness signals" (per-page). CONFIRM-ONLY: FreshnessAnalyzer
    // counts only the Last-Modified header + VALID JSON-LD/`article:` dates
    // (freshness-analyzer.ts:212) — NOT a bare `<time datetime>`, which
    // `hasFreshnessSignal` also detects. Refuting on the broader DOM signal would
    // drop the real finding on a page that renders a `<time>` date without any
    // structured signal, so we never refute: confirm only when NO signal (DOM or
    // Last-Modified header) is present. The site-wide "most pages lack" variant is
    // a cross-page aggregate (handled site-level below).
    kind: 'freshness',
    match: (t) => /(content freshness|freshness signal)/.test(t) && !/most pages/.test(t),
    check: (s) =>
      presentOrUnsure(
        !s.hasFreshnessSignal && !s.headers['last-modified'],
        'no freshness signal (no date markup or Last-Modified header) on the page',
        'a freshness signal is present at load; not dropping',
      ),
  },
  {
    // Duplicate hreflang declarations in the head — server-rendered + stable.
    kind: 'hreflang-duplicate',
    match: (t) => /alternates?.*duplicat|duplicated in head|hreflang.*duplicat/.test(t),
    check: (s) =>
      s.duplicateHreflang > 0
        ? confirmed(`${s.duplicateHreflang} duplicate hreflang declaration(s) in head`)
        : refuted('no duplicate hreflang declarations in the head now'),
  },
  {
    // More than one <h1>. h1Count is server-rendered + stable → confirm/refute.
    kind: 'multiple-h1',
    match: (t) => /more than one h1|multiple h1|multiple <h1>/.test(t),
    check: (s) => overLimit(s.h1Count, 1, 'h1 count'),
  },
  {
    // Open Graph / Twitter Card social meta. Server-rendered → confirm/refute.
    // Matcher is deliberately narrow: a per-tag finding ("missing og:image") must
    // NOT route here — `hasSocialTags` is an OR over all social meta, so a page
    // with any og/twitter tag would falsely refute a specific-tag finding.
    kind: 'social-tags',
    match: (t) => /missing social media|social media tags/.test(t),
    check: (s) =>
      s.hasSocialTags
        ? refuted('page has Open Graph / Twitter Card social tags now')
        : confirmed('no Open Graph or Twitter Card social tags on the page'),
  },
  {
    // Low structured-data coverage — a site-wide claim. Run against the homepage
    // (siteWidePage), confirm-only: the homepage having JSON-LD can't refute a
    // site-wide "low coverage" claim.
    kind: 'structured-data-coverage',
    match: (t) => /low structured data|structured data coverage/.test(t),
    siteWidePage: true,
    check: (s) =>
      presentOrUnsure(
        s.jsonLdBlocks === 0,
        'no JSON-LD structured data on the homepage',
        `homepage has ${s.jsonLdBlocks} JSON-LD block(s) — can't refute a site-wide coverage claim from one page`,
        'site-level',
      ),
  },
  {
    // Video without VideoObject schema — per cited page. videoCount + JSON-LD are
    // observable at load; confirm when a video lacks schema, refute when present,
    // unverified when no video mounted (may be lazy / behind a facade).
    // Matches the "missing VideoObject" findings (per-page + site-wide "lack")
    // but NOT "Invalid VideoObject schema" — there the schema EXISTS, so refuting
    // on its presence would be a false drop.
    kind: 'video-schema',
    match: (t) =>
      (/videoobject|video content without/.test(t) || /video.*without.*schema/.test(t)) && !/invalid/.test(t),
    check: (s) => {
      if (s.videoCount === 0)
        return unverifiable('no <video> mounted at load — may be lazy / behind a click-to-play facade');
      return s.hasVideoObjectSchema
        ? refuted('page declares VideoObject structured data now')
        : confirmed(`${s.videoCount} video(s) and no VideoObject schema`);
    },
  },
  {
    // Videos missing caption/subtitle tracks. Confirm-only (videos can mount late).
    kind: 'video-captions',
    match: (t) => /without captions|captions or transcript/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.videosWithoutCaptions > 0,
        `${s.videosWithoutCaptions} video(s) without a caption/subtitle track`,
        'no uncaptioned <video> at load — videos may mount late; not dropping',
      ),
  },
  {
    // Many images but none lazy-loaded. Confirm-only: images can mount after load,
    // and lazy attrs are only meaningful once the real image set is present.
    kind: 'lazy-loading',
    match: (t) => /none use lazy loading|many images but none/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.imageCount >= 5 && s.lazyImageCount === 0,
        `${s.imageCount} images and none use loading="lazy"`,
        'lazy-loading adoption not confirmable at load (images may mount late); not dropping',
      ),
  },
  {
    // Dead-end page (no outgoing internal links). Confirm-only on EXACTLY zero
    // internal anchors — a strong, rare signal. We never refute on presence of
    // links: a naive same-origin count is broader than the analyzer's crawl-graph
    // notion (global nav counts here), so >0 stays unverified, never a false drop.
    kind: 'dead-end',
    match: (t) => /dead-end page|no outgoing internal/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.internalLinkCount === 0,
        'page has no outgoing internal links',
        `${s.internalLinkCount} internal link(s) present — broader than the crawl-graph notion; not dropping`,
      ),
  },
  {
    // Crawl-budget waste — a site-wide aggregate a single page can't adjudicate.
    kind: 'crawl-budget',
    match: (t) => /crawl budget waste|significant crawl budget|crawl budget is being wasted/.test(t),
    noFetch: true,
    check: () => unverifiable('site-wide crawl-budget aggregate — not derivable from a single live page', 'site-level'),
  },
  {
    // Error-rate-by-bucket — a site-wide aggregate over the crawl, not a page property.
    kind: 'error-rate',
    match: (t) => /high error rate/.test(t),
    noFetch: true,
    check: () => unverifiable('site-wide error-rate aggregate — not a single-page property', 'site-level'),
  },
  {
    // No Sitemap declared in robots.txt — fetched once for the site (SPECIAL_KINDS).
    kind: 'robots-sitemap',
    match: (t) => /no sitemap declared in robots|sitemap.*not.*declared.*robots/.test(t),
    noFetch: true,
    check: () => unverifiable('handled by the robots.txt special verifier'),
  },
  {
    // "CSS/JS files may be blocked" — a robots.txt wildcard Disallow (/*.js$,
    // /*.css) that stops crawlers fetching render-critical assets. Site-wide and
    // stable: handled by the robots.txt special verifier (fetched once), which
    // confirms AND refutes. Exempt from the plural guard (single representative file).
    kind: 'css-js-blocked',
    match: (t) => /css\/js.*blocked|blocks css\/js|css and js.*blocked/.test(t),
    noFetch: true,
    check: () => unverifiable('handled by the robots.txt CSS/JS-block special verifier'),
  },
  {
    kind: 'vitals',
    match: (t) =>
      /\bcls\b|\btbt\b|\binp\b|\blcp\b|\bfcp\b|\btti\b|layout shift|blocking time|largest contentful paint|first contentful paint|time to interactive/.test(
        t,
      ),
    // CLS/TBT/LCP/FCP measured live via PerformanceObserver under the crawl's
    // network/CPU/device profile. Confirm-only (they vary load to load). INP and
    // TTI are lab/interaction metrics with no PerformanceObserver → owned, but
    // unverified (a deliberate non-decision, not a "no live checker" gap).
    check: (s, f) => {
      const t = f.title.toLowerCase();
      if (/\bcls\b|layout shift/.test(t)) return overOrUnsure(Number(s.clsValue.toFixed(3)), THRESHOLDS.CLS, 'CLS');
      if (/\btbt\b|blocking time/.test(t)) return overOrUnsure(s.tbtMs, THRESHOLDS.TBT, 'TBT', 'ms');
      if (/\blcp\b|largest contentful paint/.test(t))
        return s.lcpMs > 0
          ? overOrUnsure(s.lcpMs, THRESHOLDS.LCP, 'LCP', 'ms')
          : unverifiable('LCP not measured at load', 'under-observable');
      if (/\bfcp\b|first contentful paint/.test(t))
        return s.fcpMs > 0
          ? overOrUnsure(s.fcpMs, THRESHOLDS.FCP, 'FCP', 'ms')
          : unverifiable('FCP not measured at load', 'under-observable');
      if (/\btti\b|time to interactive/.test(t))
        return unverifiable('TTI is a lab metric — not measurable from an automated load', 'volatile');
      return unverifiable('INP needs real user interaction — not measurable from an automated load', 'volatile');
    },
  },
  {
    // Web-font payload / count. Load-dependent (fonts can be deferred / lazily
    // requested), so confirm-only via overOrUnsure — never refuted.
    kind: 'fonts',
    match: (t) => /web font payload|font files loaded|too many font|many.*font files/.test(t),
    check: (s, f) =>
      /payload|excessive|large/.test(f.title.toLowerCase())
        ? overOrUnsure(s.fontBytes, THRESHOLDS.FONT_SIZE_WARNING, 'web-font payload', ' bytes')
        : overOrUnsure(s.fontRequests, TOO_MANY_FONTS_BAR, 'web-font files'),
  },
  {
    // Console errors / uncaught exceptions captured during load. Confirm-only:
    // errors can be interaction-triggered, so none-at-load isn't a refute.
    kind: 'console-errors',
    match: (t) => /javascript (console )?errors?|console errors?|js errors?/.test(t),
    check: (s) =>
      presentOrUnsure(
        s.consoleErrors > 0,
        `${s.consoleErrors} console error(s) / page exception(s) at load`,
        'no console errors at load — errors may be interaction-triggered; not dropping',
      ),
  },
  {
    // Author attribution (E-E-A-T). Confirm-only on ABSENCE: byline detection is
    // heuristic, so a positive match could be a false positive — never refute.
    kind: 'author-attribution',
    match: (t) => /author attribution|lacks? author|without author|missing author|no author/.test(t),
    check: (s) =>
      presentOrUnsure(
        !s.hasAuthorByline,
        'no author byline / author markup detected on the page',
        'an author byline / author markup is present — heuristic match, not dropping',
      ),
  },
  {
    kind: 'coverage',
    match: (t) => /unused (css|code|javascript|js)\b/.test(t),
    // Unused-bytes ratio from Playwright CSS/JS coverage. Confirm-only: deferred
    // / interaction-loaded code can only raise real usage, never the reverse.
    check: (s, f) => {
      // "unused CSS" → CSS coverage; "unused code" means unused JavaScript → JS coverage.
      const ratio = /css/.test(f.title.toLowerCase()) ? s.unusedCssRatio : s.unusedJsRatio;
      if (ratio < 0) return unverifiable('coverage not measurable on this page');
      const pct = Math.round(ratio * 100);
      return pct > 50
        ? confirmed(`${pct}% of downloaded bytes unused`)
        : unverifiable(`${pct}% unused at load (≤ 50%); deferred code may raise this — not dropping`);
    },
  },
  {
    kind: 'consent',
    match: (t) => /consent|tracking cookie/.test(t),
    // Cookies present at load — before any consent interaction — that are
    // third-party or known trackers. Confirm-only (banners may set them only
    // after interaction, so absence at load isn't proof).
    check: (s) =>
      presentOrUnsure(
        s.preConsentTrackingCookies > 0,
        `${s.preConsentTrackingCookies} tracking cookie(s) set before consent`,
        'no pre-consent tracking cookies at load — may be set after interaction; not dropping',
      ),
  },
  {
    kind: 'contrast',
    match: (t) => /contrast/.test(t),
    // axe-core color-contrast node count. Confirm-only: axe sees only rendered/
    // visible nodes, so 0 at load doesn't prove none exist elsewhere.
    check: (s) =>
      s.contrastViolations < 0
        ? unverifiable('contrast scan did not run on this page')
        : s.contrastViolations > 0
          ? confirmed(`${s.contrastViolations} color-contrast violation(s) (axe-core)`)
          : unverifiable(
              'no contrast violations on the rendered page at load — interaction-gated views unscanned; not dropping',
            ),
  },
  {
    // Cross-page / site-wide aggregates that NO single live page can adjudicate:
    // anchor-text distribution, internal-link-graph opportunities, site-wide thin
    // content / freshness / author coverage, cross-page URL patterns, sitemap
    // crawl coverage. Owned as a `noFetch` site-level non-decision so they report
    // "site-level" rather than the misleading "no live checker". MUST stay LAST in
    // CHECKERS so every specific per-page checker matches first.
    kind: 'cross-page-aggregate',
    noFetch: true,
    match: (t) =>
      /anchor text|linking opportunit|hub pages|pages with few links|top external link destinations|share of pages have insufficient|most pages lack|most content pages lack|unstructured url pattern|sitemap urls were not successfully crawled/.test(
        t,
      ),
    check: () =>
      unverifiable(
        'cross-page / site-wide aggregate — needs the whole crawl, not a single live page',
        'site-level',
      ),
  },
];

/* ------------------------- site-level + multi-page + series verifiers ------- */

/** Kinds the orchestrator handles with dedicated async verifiers (site context,
 *  multi-page comparison, or series walk) instead of the per-page registry. */
const SPECIAL_KINDS = new Set([
  'duplicate',
  'site-graph',
  'broken-pagination',
  'broken-outbound-page',
  'broken-outbound',
  'cannibalisation',
  'robots-ai',
  'robots-sitemap',
  'css-js-blocked',
]);

/** Known AI/LLM crawler user-agent tokens, for the robots.txt AI-crawler checks. */
const AI_BOT_RE =
  /(gptbot|oai-searchbot|chatgpt-user|claudebot|claude-web|anthropic-ai|perplexitybot|ccbot|google-extended|bytespider|cohere-ai|amazonbot|applebot-extended|diffbot|imagesiftbot|youbot|meta-externalagent)/i;

/**
 * Verify a robots.txt AI-crawler finding. Pure over the fetched robots.txt body
 * so the rule logic is unit-testable. Two finding forms (disjoint, decided by
 * the finding title):
 *   • "No explicit AI crawler rules" → confirmed when robots.txt names NO AI bot
 *     user-agent; refuted when at least one is present.
 *   • "AI crawlers blocked"          → confirmed when an AI-bot user-agent group
 *     carries a blanket `Disallow: /`; refuted otherwise.
 * A null body (unfetchable) → unverified.
 */
export function robotsAiVerdict(title: string, body: string | null): CheckResult {
  if (body == null) return unverifiable('could not fetch robots.txt', 'unreachable');
  const wantsBlocked = /blocked/i.test(title);
  // Group the file into user-agent blocks: each `User-agent:` line starts a group
  // that owns the directives until the next `User-agent:` (consecutive UA lines
  // share the following directives).
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  let currentAgents: string[] = [];
  let pendingAgents = true; // consecutive UA lines accumulate before directives
  const blockedAiAgents: string[] = [];
  let namesAiBot = false;
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      if (!pendingAgents) currentAgents = [];
      currentAgents.push(ua[1].trim());
      pendingAgents = true;
      if (AI_BOT_RE.test(ua[1])) namesAiBot = true;
      continue;
    }
    pendingAgents = false;
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis?.[1].trim() === '/') {
      for (const a of currentAgents) if (AI_BOT_RE.test(a)) blockedAiAgents.push(a);
    }
  }
  if (wantsBlocked) {
    return blockedAiAgents.length > 0
      ? confirmed(`AI crawler(s) still blocked in robots.txt: ${[...new Set(blockedAiAgents)].join(', ')}`)
      : refuted('no AI-crawler user-agent is blocked (Disallow: /) in robots.txt now');
  }
  return namesAiBot
    ? refuted('robots.txt now names explicit AI-crawler rules')
    : confirmed('robots.txt still has no explicit AI-crawler (GPTBot/ClaudeBot/…) rules');
}

/** Fetch robots.txt for the finding's origin and apply {@link robotsAiVerdict}. */
async function verifyRobotsAi(f: ReportFinding, timeoutMs: number, originHint: string | null): Promise<CheckResult> {
  let origin = originHint;
  if (f.exampleUrl) {
    try {
      origin = new URL(f.exampleUrl).origin;
    } catch {
      /* keep originHint */
    }
  }
  if (!origin) return unverifiable('no site origin to fetch robots.txt', 'no-example');
  const body = await fetchText(`${origin}/robots.txt`, timeoutMs);
  return robotsAiVerdict(f.title, body);
}

/** Pure verdict for the "No Sitemap declared in robots.txt" finding: confirmed
 *  when robots.txt has no `Sitemap:` directive, refuted when one is present.
 *  Comments are stripped first. A null body (unfetchable) → unverified. */
export function robotsSitemapVerdict(body: string | null): CheckResult {
  if (body == null) return unverifiable('could not fetch robots.txt', 'unreachable');
  const hasSitemap = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .some((l) => /^sitemap:\s*\S+/i.test(l));
  return hasSitemap
    ? refuted('robots.txt now declares a Sitemap: directive')
    : confirmed('robots.txt declares no Sitemap: directive');
}

/** Fetch robots.txt for the finding's origin and apply {@link robotsSitemapVerdict}. */
async function verifyRobotsSitemap(
  f: ReportFinding,
  timeoutMs: number,
  originHint: string | null,
): Promise<CheckResult> {
  let origin = originHint;
  if (f.exampleUrl) {
    try {
      origin = new URL(f.exampleUrl).origin;
    } catch {
      /* keep originHint */
    }
  }
  if (!origin) return unverifiable('no site origin to fetch robots.txt', 'no-example');
  const body = await fetchText(`${origin}/robots.txt`, timeoutMs);
  return robotsSitemapVerdict(body);
}

/**
 * Pure verdict for "CSS/JS files may be blocked": confirmed when robots.txt has a
 * wildcard `Disallow: /*.js` / `/*.css` (± `$`) under `*` or a major search bot,
 * with NO overriding `Allow:` exposing `.css`/`.js` — mirrors
 * RobotsParser.#checkCriticalPathBlocking. Refuted when no such blocking rule
 * survives. A null body (unfetchable) → unverified. Unit-tested.
 */
export function robotsCssJsBlockedVerdict(body: string | null): CheckResult {
  if (body == null) return unverifiable('could not fetch robots.txt', 'unreachable');
  const isWildcardJsCss = (p: string): boolean => p === '/*.css' || p === '/*.js' || p === '/*.css$' || p === '/*.js$';
  const isMajor = (ua: string): boolean =>
    ua === '*' || /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandex/i.test(ua);
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  let blocked = false;
  let groupDisallow: string[] = [];
  let groupAllow: string[] = [];
  let groupMajor = false;
  let pendingAgents = true; // consecutive UA lines share the following directives
  const flush = (): void => {
    if (groupMajor) {
      for (const d of groupDisallow) {
        if (!isWildcardJsCss(d)) continue;
        const override = groupAllow.some((a) => a.includes('.css') || a.includes('.js'));
        if (!override) blocked = true;
      }
    }
    groupDisallow = [];
    groupAllow = [];
    groupMajor = false;
  };
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      if (!pendingAgents) flush(); // a UA line after directives starts a new group
      if (isMajor(ua[1].trim())) groupMajor = true;
      pendingAgents = true;
      continue;
    }
    pendingAgents = false;
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis) {
      groupDisallow.push(dis[1].trim());
      continue;
    }
    const alw = line.match(/^allow:\s*(.*)$/i);
    if (alw) groupAllow.push(alw[1].trim());
  }
  flush();
  return blocked
    ? confirmed('robots.txt still blocks CSS/JS via a wildcard Disallow (/*.js or /*.css) with no Allow override')
    : refuted('robots.txt has no wildcard CSS/JS Disallow blocking rendering now');
}

/** Fetch robots.txt for the finding's origin and apply {@link robotsCssJsBlockedVerdict}. */
async function verifyCssJsBlocked(
  f: ReportFinding,
  timeoutMs: number,
  originHint: string | null,
): Promise<CheckResult> {
  let origin = originHint;
  if (f.exampleUrl) {
    try {
      origin = new URL(f.exampleUrl).origin;
    } catch {
      /* keep originHint */
    }
  }
  if (!origin) return unverifiable('no site origin to fetch robots.txt', 'no-example');
  const body = await fetchText(`${origin}/robots.txt`, timeoutMs);
  return robotsCssJsBlockedVerdict(body);
}

/** Page cap for the homepage reachability BFS (orphan/unreachable checks). */
const REACHABILITY_MAX_PAGES = 120;
/** Click-depth bar (mirrors finding-verifier.CLICK_DEPTH_BAR): more than this
 *  many clicks from the homepage confirms a "buried page" finding. */
const CLICK_DEPTH_BAR = 4;
/** Inbound-link bar (mirrors finding-verifier.LOW_EQUITY_BAR): at-or-below this
 *  many inbound internal links confirms a "low link equity" finding. */
const LOW_EQUITY_BAR = 3;

export interface LiveSite {
  /** Normalized URLs declared in the sitemap(s); empty if none fetched. */
  sitemapUrls: Set<string>;
  /** True when the sitemap fetch was truncated (budget / fan-out / URL cap) —
   *  the set is INCOMPLETE, so a missing URL can't be asserted absent. */
  sitemapCapped: boolean;
  /** Normalized URLs reachable from the homepage via internal links (bounded BFS,
   *  or the FULL persisted crawl graph when {@link LiveVerifyOptions.siteData} is supplied). */
  reachable: Set<string>;
  /** True when reachability is INCOMPLETE (the bounded BFS hit its page cap), so a
   *  missing URL can't be asserted as an orphan (→ unverified, never refute).
   *  Always false when built from the persisted full-crawl graph. */
  reachabilityCapped: boolean;
  /** Inbound link graph (normalized dst → source urls), from the persisted crawl.
   *  Present only when built from {@link LiveVerifyOptions.siteData}; enables the
   *  orphan / low-link-equity checks that a bounded live BFS can't settle. */
  incoming?: Map<string, string[]>;
  /** Click depth from the homepage (normalized url → depth) over the full crawl
   *  forward graph. Present only when built from persisted crawl data. */
  depthFromHome?: Map<string, number>;
}

/** Persisted full-crawl link/sitemap graph (a structural subset of the offline
 *  pass's `SiteData`, so that value is assignable here without importing it —
 *  avoiding a finding-verifier ↔ live-verifier cycle). When supplied via
 *  {@link LiveVerifyOptions.siteData}, the live pass derives its {@link LiveSite}
 *  from this (uncapped) instead of the bounded 120-page live BFS + sitemap fetch. */
export interface PersistedSiteGraph {
  incoming: Map<string, string[]>;
  depthFromHome: Map<string, number>;
  sitemapUrls: Set<string>;
  sitemapCapped: boolean;
}

/** GET text with a timeout; null on any failure / non-2xx. */
async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  if (!liveFetchAllowed(url)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Collect declared sitemap URLs (robots.txt → Sitemap:, else /sitemap.xml;
 * follows indexes). Returns `capped: true` when the fetch budget or URL cap was
 * hit with child sitemaps still unread — the set is then INCOMPLETE, so a
 * missing URL can't be asserted as "absent from sitemap" (→ unverified).
 */
async function fetchSitemapUrls(origin: string, timeoutMs: number): Promise<{ urls: Set<string>; capped: boolean }> {
  const urls = new Set<string>();
  const queue: string[] = [];
  const robots = await fetchText(`${origin}/robots.txt`, timeoutMs);
  if (robots) for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) queue.push(m[1].trim());
  if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);
  const seen = new Set<string>();
  let budget = 25;
  let droppedChild = false; // a child sitemap we couldn't enqueue (index fan-out cap)
  // Unknown total (an index fans out into children as we read it), so count-only.
  const progress = new PhaseProgress('Reading sitemaps', 0);
  while (queue.length && budget-- > 0) {
    const sm = queue.shift() as string;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm, timeoutMs);
    progress.tick();
    if (!xml) continue;
    const isIndex = /<sitemapindex/i.test(xml);
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const loc = m[1].trim();
      if (isIndex) {
        if (queue.length < 50) queue.push(loc);
        else droppedChild = true;
      } else {
        urls.add(normUrl(loc));
        if (urls.size >= 50000) {
          progress.done(`Read ${seen.size} sitemap(s), ${urls.size} URL(s)`);
          return { urls, capped: true };
        }
      }
    }
  }
  progress.done(`Read ${seen.size} sitemap(s), ${urls.size} URL(s)`);
  // Incomplete if the fetch budget ran out with sitemaps still queued, or the
  // index fan-out cap dropped a child we never read.
  return { urls, capped: queue.length > 0 || droppedChild };
}

/** Bounded BFS from the homepage over internal links → reachable URL set. */
async function buildReachable(
  browser: Browser,
  origin: string,
  timeoutMs: number,
): Promise<{ set: Set<string>; capped: boolean }> {
  const MAX_PAGES = REACHABILITY_MAX_PAGES;
  const start = `${origin}/`;
  const reachable = new Set<string>([normUrl(start)]);
  const queue: string[] = [start];
  const originReg = registrable(new URL(origin).hostname);
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
    userAgent: DEFAULT_USER_AGENT,
  });
  await injectNamePolyfill(context);
  let visited = 0;
  // True once we DISCOVER a reachable URL but stop enqueuing it for crawling
  // (cap reached). The graph is then only partially explored, so a URL absent
  // from `reachable` can't be asserted as an orphan — coverage is incomplete
  // even if the queue happens to drain to empty.
  let suppressed = false;
  // Unknown total (the frontier grows as we crawl, soft-capped at MAX_PAGES), so
  // a count-only line — extrapolating an ETA toward a moving target would lie.
  const progress = new PhaseProgress('Mapping site graph (BFS)', 0);
  try {
    const page = await context.newPage();
    while (queue.length && visited < MAX_PAGES) {
      const url = queue.shift() as string;
      visited++;
      progress.tick();
      if (!liveFetchAllowed(url)) continue;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href),
        );
        for (const l of links) {
          try {
            const u = new URL(l);
            u.hash = '';
            if (registrable(u.hostname) !== originReg) continue;
            const key = normUrl(u.href);
            if (!reachable.has(key)) {
              reachable.add(key);
              if (visited + queue.length < MAX_PAGES) queue.push(u.href);
              else suppressed = true;
            }
          } catch {
            /* skip unparsable href */
          }
        }
      } catch {
        /* skip unreachable page */
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  progress.done(`Mapped site graph: ${visited} crawled, ${reachable.size} reachable`);
  // Capped if the loop stopped with work left OR we ever suppressed an enqueue.
  return { set: reachable, capped: queue.length > 0 || suppressed };
}

type LightFetch = { status: number; title: string; description: string | null; h1: string; wordCount: number };

/**
 * Light fetch with retry: status + title + description + word count (no heavy
 * instrumentation). Backs the duplicate / cannibalisation / broken-outbound /
 * pagination verifiers. Retries transient failures like {@link captureWithRetry}
 * so a single miss doesn't wrongly leave those findings unverified.
 */
async function fetchLight(browser: Browser, url: string, timeoutMs: number): Promise<LightFetch | null> {
  for (let n = 1; n <= LIVE_NAV_ATTEMPTS; n++) {
    const r = await fetchLightOnce(browser, url, timeoutMs);
    if (r) return r;
    if (n < LIVE_NAV_ATTEMPTS) await sleep(LIVE_NAV_BACKOFF_MS * n);
  }
  return null;
}

async function fetchLightOnce(browser: Browser, url: string, timeoutMs: number): Promise<LightFetch | null> {
  if (!liveFetchAllowed(url)) return null;
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
    userAgent: DEFAULT_USER_AGENT,
  });
  await injectNamePolyfill(context);
  try {
    const page = await context.newPage();
    // domcontentloaded (not `load`) — see captureOne: full `load` over a throttled
    // link routinely times out, which here would wrongly leave the finding unverified.
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!resp) return null;
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    const dom = await page.evaluate(() => {
      const text = (document.body?.innerText ?? '').trim();
      return {
        title: (document.title ?? '').trim(),
        description: (document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').trim() || null,
        h1: (document.querySelector('h1')?.textContent ?? '').trim(),
        wordCount: text ? text.split(/\s+/).length : 0,
      };
    });
    return { status: resp.status(), ...dom };
  } catch {
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Verdict for a duplicate finding from the two cited pages' field values.
 * Pure (no IO), so the count-coverage logic is unit-tested directly.
 *
 * The two cited pages are only PART of a finding that spans `count` pages, so a
 * mismatch can only DROP the finding when those two ARE the whole finding
 * (`count <= 2`). For `count > 2` a mismatch is partial evidence — the other
 * pages may still share the value — so it stays `unverified`, never refuted.
 * (This is why duplicate is exempt from the orchestrator's blunt
 * guardPluralRefute, which would otherwise also block the valid count==2 drop.)
 */
export function duplicateVerdict(
  field: 'title' | 'description',
  a: string | null,
  b: string | null,
  count: number,
): CheckResult {
  if (!a || !b) return unverifiable(`a cited page is missing its ${field}`);
  if (a.trim() === b.trim()) return confirmed(`2 pages share the same ${field}: "${a.slice(0, 60)}"`);
  return count <= 2
    ? refuted(`the ${field}s of the only ${count} cited pages now differ`)
    : unverifiable(
        `the first 2 of ${count} cited pages now differ, but the other ${count - 2} weren't compared — not dropping`,
      );
}

/** Duplicate title/description: fetch the first two example pages and compare. */
async function verifyDuplicate(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  const isDesc = /description/i.test(f.title);
  const field: 'title' | 'description' = isDesc ? 'description' : 'title';
  if (f.exampleUrls.length < 2) return unverifiable(`only one example page cited — need ≥2 to compare ${field}s`);
  const [a, b] = await Promise.all([
    fetchLight(browser, f.exampleUrls[0], timeoutMs),
    fetchLight(browser, f.exampleUrls[1], timeoutMs),
  ]);
  if (!a || !b) return unverifiable('could not load both example pages');
  return duplicateVerdict(field, isDesc ? a.description : a.title, isDesc ? b.description : b.title, f.count);
}

/** Generic title tokens that don't prove keyword cannibalisation on their own. */
const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'from',
  'this',
  'that',
  'home',
  'page',
  'site',
  'official',
  'welcome',
]);

/**
 * First non-trivial word (≥4 chars, not a stopword) shared by two titles, or
 * null when they share none. Pure → unit-tested. The match is the live evidence
 * that two pages still compete for the same keyword in their titles.
 */
export function sharedTitleKeyword(a: string, b: string): string | null {
  const toks = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !TITLE_STOPWORDS.has(w)));
  const tb = toks(b);
  for (const w of toks(a)) if (tb.has(w)) return w;
  return null;
}

/**
 * Keyword cannibalisation: fetch the first two cited pages and check whether the
 * element the finding NAMES still shares a keyword. The analyzer emits two
 * variants — "…in their titles" and "…in their H1" — so we compare the matching
 * element (a title-only check would falsely confirm an H1 finding off title
 * overlap). Confirm-only — the finding spans more groups/pages than the two
 * sampled, so a non-match is partial evidence (`unverified`), never a drop.
 */
/** Which element a keyword-cannibalisation finding is about — the analyzer emits
 *  a "…in their titles" and a "…in their H1" variant, verified on different
 *  elements. Pure → unit-tested so the H1 variant can't be checked on titles. */
export function cannibalisationElement(title: string): 'title' | 'h1' {
  return /\bh1\b|heading/i.test(title) ? 'h1' : 'title';
}

async function verifyKeywordCannibalisation(
  f: ReportFinding,
  browser: Browser,
  timeoutMs: number,
): Promise<CheckResult> {
  const onH1 = cannibalisationElement(f.title) === 'h1';
  const label = onH1 ? 'H1' : 'title';
  if (f.exampleUrls.length < 2) return unverifiable(`need ≥2 example pages to compare ${label}s for a shared keyword`);
  const [a, b] = await Promise.all([
    fetchLight(browser, f.exampleUrls[0], timeoutMs),
    fetchLight(browser, f.exampleUrls[1], timeoutMs),
  ]);
  if (!a || !b) return unverifiable('could not load both example pages');
  const shared = sharedTitleKeyword(onH1 ? a.h1 : a.title, onH1 ? b.h1 : b.title);
  return shared
    ? confirmed(`2 cited pages still share the ${label} keyword "${shared}"`)
    : unverifiable(
        `the first 2 cited pages share no obvious ${label} keyword now, but the finding spans ${f.count} groups — other pages weren't compared; not dropping`,
      );
}

/**
 * Per-page "Page has N broken outbound link(s)": the first example URL is the
 * on-site container page; the dead links are the remaining (external) example
 * URLs. Fetch the first external one and confirm a 4xx/5xx. Confirm-only — a
 * 200 means that one link recovered, but other links on the page may still be
 * dead, so we never refute (and never fetch the container, which would falsely
 * read 200).
 */
async function verifyBrokenOutboundPage(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  if (f.exampleUrls.length < 2) return unverifiable('report did not cite the specific outbound link to re-fetch');
  let containerReg = '';
  try {
    containerReg = registrable(new URL(f.exampleUrls[0]).hostname);
  } catch {
    /* leave empty → treat all as external */
  }
  const links = f.exampleUrls.slice(1).filter((u) => {
    try {
      return registrable(new URL(u).hostname) !== containerReg;
    } catch {
      return false;
    }
  });
  if (links.length === 0) return unverifiable('no external outbound link cited to re-fetch');
  const state = await fetchLight(browser, links[0], timeoutMs);
  if (!state) return unverifiable(`could not load cited outbound link ${links[0]}`);
  return state.status >= 400
    ? confirmed(`cited outbound link returns HTTP ${state.status}`)
    : unverifiable(
        `cited outbound link now returns HTTP ${state.status}; other links on the page unchecked — not dropping`,
      );
}

/**
 * Verdict for a re-fetched outbound link by HTTP status. Confirm-only: a 4xx/5xx
 * confirms the broken link; a sub-400 status is `unverified` (external-link
 * liveness is volatile — never drop on it). Pure, so it's unit-tested directly.
 */
export function brokenOutboundVerdict(status: number): CheckResult {
  return status >= 400
    ? confirmed(`outbound link returns HTTP ${status}`)
    : unverifiable(
        `outbound link now returns HTTP ${status}; external-link liveness is volatile (transient outage / UA gating) — not dropping`,
      );
}

/**
 * Site-wide "Broken outbound link": the example URL IS the dead link. Re-fetch
 * it with the lightweight path (no axe/coverage/scroll — wasted on a dead
 * external link) and read the status. Confirm-only.
 */
async function verifyBrokenOutbound(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  if (!f.exampleUrl) return unverifiable('no outbound link cited to re-fetch');
  const state = await fetchLight(browser, f.exampleUrl, timeoutMs);
  return state
    ? brokenOutboundVerdict(state.status)
    : unverifiable(`could not load cited outbound link ${f.exampleUrl}`);
}

/** Sitemap membership: confirm when the cited indexable page is absent from the sitemap. */
export function verifySitemapMembership(f: ReportFinding, site: LiveSite): CheckResult {
  if (site.sitemapUrls.size === 0) return unverifiable('no sitemap could be fetched');
  if (!f.exampleUrl) return unverifiable('no example URL to check against the sitemap');
  if (site.sitemapUrls.has(normUrl(f.exampleUrl))) return refuted('cited page IS present in the sitemap');
  // Present → refute is safe. Absent → only a CONFIRM if the sitemap was read
  // in full; if truncated, the page may live in an unread child sitemap, so we
  // can't assert "absent" (never assert on incomplete data).
  return site.sitemapCapped
    ? unverifiable(
        'sitemap fetch was truncated (large multi-sitemap index) — cannot assert the page is absent; not confirming',
      )
    : confirmed('cited page is absent from the sitemap');
}

/** Orphan / unreachable: confirm when the cited page isn't reachable from the homepage. */
export function verifyReachability(f: ReportFinding, site: LiveSite): CheckResult {
  if (!f.exampleUrl) return unverifiable('no example URL to test reachability', 'no-example');
  if (site.reachable.has(normUrl(f.exampleUrl)))
    return refuted('cited page IS reachable from the homepage via internal links');
  if (site.reachabilityCapped)
    return unverifiable(
      `cited page not seen within the ${REACHABILITY_MAX_PAGES}-page crawl cap — reachability inconclusive, not dropping`,
      'site-level',
    );
  return confirmed('cited page is not reachable from the homepage via internal links');
}

/**
 * Orphan page ("no internal links point to it"). Uses the persisted inbound graph
 * when available (uncapped): inbound > 0 refutes (positive evidence it isn't an
 * orphan); a crawled page with zero inbound (absent-or-empty in the graph)
 * confirms. Without the graph it falls back to reachability (a page reachable
 * from home necessarily has ≥1 inbound link). Plural-guarded by the caller.
 */
export function verifyOrphan(f: ReportFinding, site: LiveSite): CheckResult {
  if (!f.exampleUrl) return unverifiable('no example URL to test for orphan status', 'no-example');
  if (!site.incoming) return verifyReachability(f, site);
  if (site.incoming.size === 0) return unverifiable('inbound link graph is empty', 'site-level');
  const inc = site.incoming.get(normUrl(f.exampleUrl));
  if (inc && inc.length > 0) return refuted(`${inc.length} internal link(s) point to this page`);
  // The crawl's inbound graph lists every linked-to page, so a flagged (crawled)
  // page with no entry / an empty list genuinely receives no inbound internal links.
  return confirmed('no internal links point to this page (per the crawl link graph)');
}

/** Click depth: confirm when the cited page sits more than CLICK_DEPTH_BAR clicks
 *  from the homepage over the persisted crawl graph. Confirm-only (a low/absent
 *  depth could reflect an incomplete crawl, not a shallow page). */
export function verifyClickDepth(f: ReportFinding, site: LiveSite): CheckResult {
  if (!f.exampleUrl) return unverifiable('no example URL to measure click depth', 'no-example');
  if (!site.depthFromHome || site.depthFromHome.size === 0)
    return unverifiable('no crawl-graph depth data — click depth not derivable from a single live page', 'site-level');
  const d = site.depthFromHome.get(normUrl(f.exampleUrl));
  if (d === undefined)
    return unverifiable('cited page not reached in the crawl-graph BFS — depth inconclusive', 'site-level');
  return d > CLICK_DEPTH_BAR
    ? confirmed(`page is ${d} clicks from the homepage (> ${CLICK_DEPTH_BAR})`)
    : unverifiable(`page is only ${d} clicks from the homepage (≤ ${CLICK_DEPTH_BAR})`, 'site-level');
}

/** Low internal link equity: confirm when the cited page receives ≤ LOW_EQUITY_BAR
 *  inbound internal links over the persisted crawl graph. Confirm-only — raw
 *  inbound count is a broader proxy than the analyzer's PageRank-style score, so
 *  a higher count doesn't refute. */
export function verifyLinkEquity(f: ReportFinding, site: LiveSite): CheckResult {
  if (!f.exampleUrl) return unverifiable('no example URL to measure link equity', 'no-example');
  if (!site.incoming || site.incoming.size === 0)
    return unverifiable('no inbound link graph — link equity not derivable from a single live page', 'site-level');
  const inc = site.incoming.get(normUrl(f.exampleUrl));
  if (inc === undefined)
    return unverifiable('cited page not in the crawl link graph — equity inconclusive', 'site-level');
  return inc.length <= LOW_EQUITY_BAR
    ? confirmed(`only ${inc.length} internal link(s) point to this page (≤ ${LOW_EQUITY_BAR})`)
    : unverifiable(
        `${inc.length} internal links point to this page (> ${LOW_EQUITY_BAR}); raw count is a broad proxy — not dropping`,
        'site-level',
      );
}

/**
 * Broken/infinite pagination. Two finding forms:
 *  - Templated series (`…/page/{N}`, from the post-crawl analyzer): probe a page
 *    far past the end — a 4xx is a refute, a thin 200 confirms unboundedness.
 *  - Active "next"-control probe (from pagination-analyzer): RE-RUN the same
 *    live probe on the cited pages. Catches the in-page-anchor / normal
 *    client-side-nav false positive (where "next" reaches pages that exist):
 *    the `urlAdvanced`-gated probe won't reproduce it, so we refute. This is the
 *    live safety net for reports produced by a PRE-FIX crawl (whose stored
 *    analysis still carries the old false positive) and for cross-time site
 *    changes — same-run crawls are already gated at crawl time. Refute requires
 *    the cited examples to cover the finding (count ≤ pages probed), so it's
 *    exempt from guardPluralRefute.
 */
async function verifyPagination(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  const m = f.title.match(/(https?:\/\/\S*\{N\}\S*)/i);
  if (m) {
    const far = m[1].replace(/\{N\}/g, '9999');
    const state = await fetchLight(browser, far, timeoutMs);
    if (!state) return unverifiable(`could not load ${far}`);
    if (state.status >= 400)
      return refuted(`page #9999 correctly returns HTTP ${state.status} — pagination is bounded`);
    if (state.wordCount < 50)
      return confirmed(
        `page #9999 still returns HTTP 200 with thin content (${state.wordCount} words) — pagination never terminates`,
      );
    return unverifiable(
      `page #9999 returns HTTP 200 with ${state.wordCount} words — inconclusive without walking the full series`,
    );
  }

  // Active "next"-control form — re-run the real probe on each cited page.
  const urls = f.exampleUrls.slice(0, 5);
  if (urls.length === 0) return unverifiable('no example URL to re-probe for a "next" control');
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
    userAgent: DEFAULT_USER_AGENT,
  });
  await injectNamePolyfill(context);
  try {
    const page = await context.newPage();
    let probed = 0;
    let anyEmptied = false;
    for (const u of urls) {
      // Hard-cap each probe (parity with the crawl-time caller) so a frozen page
      // can't stall the verify pass past the rest of its budget.
      const res = await withTimeout(
        PaginationAnalyzer.probeJsNext(page, u),
        CRAWL_SETTINGS.BROKEN_PAGINATION_PROBE_TIMEOUT_MS + 2000,
        'pagination re-probe timeout',
      ).catch(() => null);
      const nextProbe = res?.nextProbe ?? null;
      if (!nextProbe) continue; // probe couldn't run / timed out on this page
      probed++;
      if (nextProbe.suspectedInfinite)
        return confirmed(`live "next" probe reproduces broken/infinite pagination on ${u}`);
      // Content collapsed after a click but the URL didn't advance → possible
      // broken IN-PLACE pagination a single light probe may under-observe.
      if (nextProbe.emptyAfterClick) anyEmptied = true;
    }
    if (probed === 0) return unverifiable('could not re-probe any cited page');
    // Never drop when there's a hint of broken behavior we might have under-observed
    // (doctrine: don't refute on a signal a single light load can under-observe).
    if (anyEmptied)
      return unverifiable(
        'a cited page\'s content collapsed after clicking "next" without a URL advance — possible broken in-place pagination; not dropping',
      );
    return f.count <= probed
      ? refuted(
          `re-probed all ${probed} cited page(s): "next" advances to real distinct pages or only an in-page anchor — not broken pagination`,
        )
      : unverifiable(`re-probed ${probed} of ${f.count} cited pages clean, but the rest weren't probed — not dropping`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/* --------------------------------------------------------------- orchestrator */

/**
 * Network + CPU throttling to match the crawl's conditions, so perf signals
 * (TTFB, CLS, TBT) are measured on a comparable footing. Omit / zero values for
 * no throttle (the default unthrottled crawl).
 */
export interface Throttle {
  downloadBps?: number;
  uploadBps?: number;
  latencyMs?: number;
  /** CPU slowdown multiplier (1 = none). */
  cpuRate?: number;
}

export interface LiveVerifyOptions {
  timeoutMs?: number;
  verbose?: boolean;
  /** Same network/CPU profile the crawl used (CLS/TBT need it to reproduce). */
  throttle?: Throttle;
  /** Persisted full-crawl link/sitemap graph (from `loadSiteData`). When present,
   *  site-level findings (orphan / unreachable / click-depth / low-link-equity /
   *  sitemap membership) are adjudicated against the WHOLE crawl rather than a
   *  bounded 120-page live BFS — removing the cap that left them `unverified`.
   *  Omit for a pure-live standalone run (the bounded BFS is then used). */
  siteData?: PersistedSiteGraph;
}

/**
 * Most-cited origin across all findings' example URLs — the site under audit.
 * Used to fetch the homepage for siteWidePage checkers whose findings carry no
 * per-page URL. Returns null when no finding cites an http(s) URL. Pure → tested.
 */
export function resolveSiteOrigin(findings: ReportFinding[]): string | null {
  const counts = new Map<string, number>();
  for (const f of findings) {
    for (const u of f.exampleUrls) {
      try {
        const origin = new URL(u).origin;
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      } catch {
        /* skip unparsable */
      }
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [origin, n] of counts) {
    if (n > bestN) {
      best = origin;
      bestN = n;
    }
  }
  return best;
}

/** Max distinct example pages re-fetched per plural finding (Slice 1 sampling).
 *  Bounds network cost; a finding spanning more pages than this stays
 *  `plural-undersampled` on an all-clean sample (never refuted on partial cover). */
export const MAX_SAMPLES_PER_FINDING = 3;
/** Global ceiling on distinct per-page live fetches across the whole report.
 *  When hit, remaining sample URLs are dropped (logged, not silent) so a huge
 *  report can't fan out unbounded fetches. Now that LOW findings are live-checked
 *  too (≈2× the finding set), the budget is collected in severity-priority order
 *  (see verifyReportLive) so a tight cap drops LOW sample URLs before high-severity
 *  ones; the ceiling is raised to absorb the extra LOW findings. */
const MAX_LIVE_FETCHES = 200;

/** Severity collection priority (lower = fetched first under the budget cap). */
const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** The example URLs to sample for a finding: the first occurrence always, plus
 *  up to MAX_SAMPLES_PER_FINDING-1 more for a plural finding (capped by how many
 *  pages it actually spans, so we never fetch more than the finding covers). */
function sampleUrlsFor(f: ReportFinding): string[] {
  const want = Math.min(MAX_SAMPLES_PER_FINDING, Math.max(1, f.count));
  return f.exampleUrls.slice(0, want);
}

/** Map a verdict status + reason code to a default confidence. confirmed/refuted
 *  on a stable signal are definitive (high); an LLM/heuristic call is low;
 *  everything else (partial, volatile, site-level) is medium. */
export function defaultConfidence(status: LiveStatus, code: VerdictReason): Confidence {
  if (status === 'confirmed' || status === 'refuted') return code === 'llm-unsure' ? 'low' : 'high';
  return code === 'llm-unsure' ? 'low' : 'medium';
}

/** Assemble a {@link LiveVerdict} from a finding, the matched checker kind, and a
 *  {@link CheckResult}, filling reasonCode/confidence (a structural `fallbackCode`
 *  covers checkers that left `code` unset; `confidence` can be overridden by the
 *  sampling aggregator). */
function toVerdict(
  f: ReportFinding,
  kind: string,
  r: CheckResult & { confidence?: Confidence },
  fallbackCode: VerdictReason = 'inconclusive',
): LiveVerdict {
  const reasonCode: VerdictReason =
    r.code ?? (r.status === 'confirmed' ? 'confirmed' : r.status === 'refuted' ? 'refuted' : fallbackCode);
  return {
    title: f.title,
    severity: f.severity,
    status: r.status,
    reason: r.reason,
    reasonCode,
    confidence: r.confidence ?? defaultConfidence(r.status, reasonCode),
    exampleUrl: f.exampleUrl,
    kind,
  };
}

/**
 * Aggregate the per-page {@link CheckResult}s of a plural finding's sampled
 * occurrences into one verdict — the pure, network-free core of Slice 1's
 * multi-example sampling. Cautious by construction:
 *   • ANY sampled page shows the defect → `confirmed` (high confidence if all
 *     sampled pages show it, else medium — the defect demonstrably exists).
 *   • EVERY sampled page is clean AND the sample covers the whole finding
 *     (`sampled ≥ count`, i.e. we fetched as many distinct pages as it spans) →
 *     `refuted`. This is the ONLY way a plural finding drops, and only when the
 *     sample is fully representative — preserving the legacy "never refute on
 *     partial evidence" guarantee that {@link guardPluralRefute} enforced.
 *   • Every sampled page clean but `sampled < count` → `plural-undersampled`
 *     (unverified): the unsampled occurrences may still be defective.
 *   • Mixed / all-inconclusive → carries the most informative `unverified`.
 * Confirm-only checkers never emit `refuted`, so they can only confirm-or-unverify
 * here — a not-yet-loaded page can never drop a real finding.
 */
export function aggregateSampledVerdict(
  results: CheckResult[],
  count: number,
): CheckResult & { confidence: Confidence } {
  const sampled = results.length;
  if (sampled === 0)
    return {
      status: 'unverified',
      reason: 'no sampled page could be loaded',
      code: 'unreachable',
      confidence: 'medium',
    };

  const confirms = results.filter((r) => r.status === 'confirmed');
  if (confirms.length > 0) {
    return {
      status: 'confirmed',
      reason:
        sampled > 1
          ? `defect present on ${confirms.length}/${sampled} sampled page(s): ${confirms[0].reason}`
          : confirms[0].reason,
      code: 'confirmed',
      confidence: confirms.length === sampled ? 'high' : 'medium',
    };
  }

  const refutes = results.filter((r) => r.status === 'refuted');
  if (refutes.length === sampled) {
    if (sampled >= count) {
      return {
        status: 'refuted',
        reason:
          sampled > 1
            ? `all ${sampled} sampled page(s) — the finding's full set — no longer show the issue: ${refutes[0].reason}`
            : refutes[0].reason,
        code: 'refuted',
        confidence: 'high',
      };
    }
    return {
      status: 'unverified',
      reason: `${sampled} of ${count} cited page(s) sampled are all clean, but ${count - sampled} weren't sampled — not dropping`,
      code: 'plural-undersampled',
      confidence: 'medium',
    };
  }

  // No confirms, not all clean → carry the most informative unverified reason.
  const unsure = results.find((r) => r.status === 'unverified') ?? results[0];
  return { status: 'unverified', reason: unsure.reason, code: unsure.code ?? 'inconclusive', confidence: 'medium' };
}

/** Live evidence captured for an AI-discovered (anomaly) finding's page — a
 *  viewport screenshot + status, for the Slice 4 vision verification. */
export interface AnomalyEvidence {
  status: number;
  finalUrl: string;
  /** Viewport screenshot as base64 PNG; null when capture failed / too large. */
  screenshot: string | null;
}

/**
 * Re-fetch each AI-discovered finding's cited page and capture a viewport
 * screenshot + status (Slice 4). Deduped — one navigation per distinct URL.
 * The screenshot backs the vision LLM verification of emergent UX/layout
 * anomalies the deterministic checkers can't enumerate. Returns an empty map
 * for no (valid http) URLs. Never throws — a failed page yields a null shot.
 */
export async function captureAnomalyEvidence(
  urls: string[],
  opts: LiveVerifyOptions = {},
): Promise<Map<string, AnomalyEvidence>> {
  const timeoutMs = opts.timeoutMs ?? THRESHOLDS.PAGE_TIMEOUT;
  const out = new Map<string, AnomalyEvidence>();
  const unique = [...new Set(urls)].filter((u) => /^https?:\/\//.test(u));
  if (unique.length === 0) return out;
  // SSRF scope: the anomalies' own origin (same-host allowed even if private).
  verifyOriginHost = (() => {
    try {
      return new URL(unique[0]).hostname;
    } catch {
      return undefined;
    }
  })();
  const browser = await chromium.launch();
  try {
    for (const url of unique) {
      if (!liveFetchAllowed(url)) continue;
      const context = await browser.newContext({
        viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
        deviceScaleFactor: VIEWPORT.DEVICE_SCALE_FACTOR,
        isMobile: true,
        hasTouch: true,
        userAgent: DEFAULT_USER_AGENT,
      });
      await injectNamePolyfill(context);
      try {
        const page = await context.newPage();
        // domcontentloaded (not `load`) for the same throttle/timeout reason as
        // captureOne; the networkidle settle below renders enough for the shot.
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
        let screenshot: string | null = null;
        try {
          const buf = await page.screenshot({ fullPage: false, type: 'png' });
          // Anthropic rejects images over 5MB — drop oversized shots (signals only).
          screenshot = buf.length <= 5_000_000 ? buf.toString('base64') : null;
        } catch {
          /* leave null → vision degrades to signals-only for this page */
        }
        out.set(url, { status: resp?.status() ?? 0, finalUrl: resp?.url() ?? url, screenshot });
      } catch {
        out.set(url, { status: 0, finalUrl: url, screenshot: null });
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return out;
}

/**
 * Parse the report and verify it live. Thin wrapper over {@link verifyFindings}
 * for callers (and tests) that start from `audit-report.md`. The phase runner
 * uses {@link verifyFindings} directly with the FULL prepared finding set, so it
 * is not limited to the findings the curated report renders as blocks.
 */
export async function verifyReportLive(reportMd: string, opts: LiveVerifyOptions = {}): Promise<LiveVerifyResult> {
  return verifyFindings(parseReportFindings(reportMd), opts);
}

/**
 * Re-fetch each finding's example(s) and re-assert the claim live. Per-page
 * findings sample up to {@link MAX_SAMPLES_PER_FINDING} distinct example pages
 * (deduped, globally capped in severity-priority order); special / site-level /
 * no-fetch kinds keep their dedicated verifiers. Findings with no example URL or
 * no matching checker resolve to `unverified` with a categorized reason code.
 */
export async function verifyFindings(
  findings: ReportFinding[],
  opts: LiveVerifyOptions = {},
): Promise<LiveVerifyResult> {
  const timeoutMs = opts.timeoutMs ?? THRESHOLDS.PAGE_TIMEOUT;
  liveFetchErrors.clear();
  const verdicts: LiveVerdict[] = [];

  // The audited site's host: same-host re-fetches are allowed even if private
  // (a local-site audit), while a stray private URL parsed from the report is
  // blocked by the SSRF guard.
  const siteOriginForGuard = resolveSiteOrigin(findings);
  verifyOriginHost = siteOriginForGuard
    ? (() => {
        try {
          return new URL(siteOriginForGuard).hostname;
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const plan = findings.map((f) => {
    const checker = CHECKERS.find((c) => c.match(f.title.toLowerCase()));
    return { f, checker };
  });

  // Per-page signal fetches: every fetchable, non-special kind, sampling up to
  // MAX_SAMPLES_PER_FINDING distinct example pages per plural finding (Slice 1).
  // Globally capped so a large report can't fan out unbounded fetches; dropped
  // sample URLs are logged (not silent) so coverage gaps are visible.
  const urlsToFetch = new Set<string>();
  let needsSiteCtx = false;
  let hasSpecial = false;
  let needsHomepage = false;
  let droppedSampleUrls = 0;
  // Collect sample URLs in severity-priority order so that when the global fetch
  // cap is tight, LOW sample URLs are dropped before CRITICAL/HIGH/MEDIUM ones.
  // Stable sort keeps report order within a severity. Flag-setting below is
  // order-independent, so iterating the sorted plan is safe.
  const orderedPlan = [...plan].sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity]);
  for (const { f, checker } of orderedPlan) {
    if (!checker) continue;
    if (checker.kind === 'site-graph') needsSiteCtx = true;
    if (checker.siteWidePage) needsHomepage = true;
    if (SPECIAL_KINDS.has(checker.kind)) hasSpecial = true;
    else if (!checker.noFetch && !checker.siteWidePage) {
      for (const u of sampleUrlsFor(f)) {
        if (urlsToFetch.has(u)) continue;
        if (urlsToFetch.size >= MAX_LIVE_FETCHES) {
          droppedSampleUrls++;
          continue;
        }
        urlsToFetch.add(u);
      }
    }
  }
  if (droppedSampleUrls > 0) {
    console.log(
      `  ⚠️  live-verify fetch cap (${MAX_LIVE_FETCHES}) reached — ${droppedSampleUrls} additional sample URL(s) skipped; affected plural findings may render as plural-undersampled.`,
    );
  }
  // Resolve the site origin from the most-cited on-site host across all findings
  // (used for the homepage fetch that backs siteWidePage checkers). External
  // example URLs (broken-outbound links) lose to the dominant on-site origin.
  const siteOrigin = needsHomepage ? resolveSiteOrigin(findings) : null;

  const cache = new Map<string, LiveSignals | null>();
  const verdictByPlan = new Map<ReportFinding, CheckResult & { kind: string }>();
  let homepageSignals: LiveSignals | null = null;

  if (urlsToFetch.size > 0 || hasSpecial || needsSiteCtx || (needsHomepage && siteOrigin)) {
    const browser = await chromium.launch();
    try {
      // 1. Per-page signal captures. Sequential page loads — the dominant cost
      // of the live pass — so show an in-place counter + ETA (verbose keeps the
      // per-URL lines).
      const fetchProgress = urlsToFetch.size > 0 ? new PhaseProgress('Re-fetching pages', urlsToFetch.size) : null;
      let n = 0;
      for (const url of urlsToFetch) {
        n++;
        if (opts.verbose) console.log(`  … live-fetching (${n}/${urlsToFetch.size}) ${url}`);
        cache.set(url, await captureWithRetry(browser, url, timeoutMs, opts.throttle, !!opts.verbose));
        fetchProgress?.tick();
      }
      fetchProgress?.done(`Re-fetched ${urlsToFetch.size} page(s)`);

      // 1b. Homepage capture backing the siteWidePage checkers (resource hints,
      // E-E-A-T) — those findings cite no per-page URL.
      if (needsHomepage && siteOrigin) {
        const homeUrl = `${siteOrigin}/`;
        if (opts.verbose) console.log(`  … live-fetching site homepage for site-wide checks: ${homeUrl}`);
        homepageSignals =
          cache.get(homeUrl) ?? (await captureWithRetry(browser, homeUrl, timeoutMs, opts.throttle, !!opts.verbose));
        cache.set(homeUrl, homepageSignals);
      }

      // 2. Site context for site-level findings. PREFER the persisted full-crawl
      // graph (uncapped — removes the 120-page BFS cap that left orphan /
      // unreachable / sitemap-membership findings `unverified` on large sites);
      // fall back to a bounded live BFS + sitemap fetch when none was supplied.
      let site: LiveSite | null = opts.siteData
        ? {
            sitemapUrls: opts.siteData.sitemapUrls,
            sitemapCapped: opts.siteData.sitemapCapped,
            reachable: new Set(opts.siteData.depthFromHome.keys()),
            reachabilityCapped: false,
            incoming: opts.siteData.incoming,
            depthFromHome: opts.siteData.depthFromHome,
          }
        : null;
      if (site && opts.verbose)
        console.log(
          `  … using persisted crawl graph for site-level checks (${site.reachable.size} reachable, ${site.incoming?.size ?? 0} inbound entries, ${site.sitemapUrls.size} sitemap URLs)`,
        );
      if (!site && needsSiteCtx) {
        // Derive the origin from a site-graph finding's OWN example (always
        // on-site) — NOT the first finding of any kind, whose example could be
        // an external URL (e.g. a broken-outbound link) → wrong-origin sitemap.
        const siteGraphUrl = plan.find((p) => p.checker?.kind === 'site-graph' && p.f.exampleUrl)?.f.exampleUrl;
        if (siteGraphUrl) {
          const origin = new URL(siteGraphUrl).origin;
          if (opts.verbose) console.log(`  … building site context (sitemap + reachability) for ${origin}`);
          const sitemap = await fetchSitemapUrls(origin, timeoutMs);
          const wantsReach = plan.some(
            (p) => p.checker?.kind === 'site-graph' && /orphan|unreachable/i.test(p.f.title),
          );
          const reach = wantsReach
            ? await buildReachable(browser, origin, timeoutMs)
            : { set: new Set<string>(), capped: true };
          site = {
            sitemapUrls: sitemap.urls,
            sitemapCapped: sitemap.capped,
            reachable: reach.set,
            reachabilityCapped: reach.capped,
          };
        }
      }

      // 3. Special-kind verifiers (multi-page / series / site-level).
      for (const { f, checker } of plan) {
        if (!checker || !SPECIAL_KINDS.has(checker.kind)) continue;
        let r: CheckResult;
        if (checker.kind === 'duplicate') r = await verifyDuplicate(f, browser, timeoutMs);
        else if (checker.kind === 'cannibalisation') r = await verifyKeywordCannibalisation(f, browser, timeoutMs);
        else if (checker.kind === 'broken-pagination') r = await verifyPagination(f, browser, timeoutMs);
        else if (checker.kind === 'broken-outbound-page') r = await verifyBrokenOutboundPage(f, browser, timeoutMs);
        else if (checker.kind === 'broken-outbound') r = await verifyBrokenOutbound(f, browser, timeoutMs);
        else if (checker.kind === 'robots-ai') r = await verifyRobotsAi(f, timeoutMs, siteOriginForGuard);
        else if (checker.kind === 'robots-sitemap') r = await verifyRobotsSitemap(f, timeoutMs, siteOriginForGuard);
        else if (checker.kind === 'css-js-blocked') r = await verifyCssJsBlocked(f, timeoutMs, siteOriginForGuard);
        else if (checker.kind === 'site-graph') {
          const t = f.title.toLowerCase();
          if (!site) r = unverifiable('site context unavailable', 'site-level');
          else if (/missing from sitemap|not (listed )?in sitemap/.test(t)) r = verifySitemapMembership(f, site);
          else if (/orphan/.test(t)) r = verifyOrphan(f, site);
          else if (/unreachable/.test(t)) r = verifyReachability(f, site);
          else if (/click depth|clicks? from/.test(t)) r = verifyClickDepth(f, site);
          else if (/link equity|(low|few)[^.]*internal link/.test(t)) r = verifyLinkEquity(f, site);
          else r = unverifiable('link-graph metric not derivable from available data', 'site-level');
        } else r = unverifiable('unhandled special kind');
        // `duplicate` and `broken-pagination` do their own count-coverage gating
        // (refute only when the cited examples cover the whole finding), so they
        // are EXEMPT from the blunt count>1 guard — which would otherwise
        // downgrade those legitimate, fully-covered drops. Others keep the guard.
        // robots-ai checks the single site-wide robots.txt — fully representative,
        // so a refute is sound; exempt it from the first-example plural guard.
        const selfGated =
          checker.kind === 'duplicate' ||
          checker.kind === 'broken-pagination' ||
          checker.kind === 'robots-ai' ||
          checker.kind === 'robots-sitemap' ||
          checker.kind === 'css-js-blocked';
        const guarded = selfGated ? r : guardPluralRefute(r, f);
        verdictByPlan.set(f, { ...guarded, kind: checker.kind });
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  for (const { f, checker } of plan) {
    if (!checker) {
      verdicts.push(toVerdict(f, 'none', unverifiable('no live checker for this finding kind', 'no-checker')));
      continue;
    }
    const special = verdictByPlan.get(f);
    if (special) {
      verdicts.push(toVerdict(f, special.kind, special));
      continue;
    }
    if (checker.noFetch) {
      verdicts.push(toVerdict(f, checker.kind, checker.check({} as LiveSignals, f)));
      continue;
    }
    if (checker.siteWidePage) {
      // Site-wide page claim: judged against the resolved homepage. Confirm-only,
      // so no plural guard is needed (the checker never refutes).
      const r = homepageSignals
        ? checker.check(homepageSignals, f)
        : unverifiable(
            siteOrigin
              ? 'could not load the site homepage for the site-wide check'
              : 'no on-site URL in the report to resolve the homepage',
            siteOrigin ? 'unreachable' : 'no-example',
          );
      verdicts.push(toVerdict(f, checker.kind, r));
      continue;
    }
    // Per-page checker: sample up to MAX_SAMPLES_PER_FINDING example pages and
    // aggregate. A plural finding refutes only when the WHOLE sample is clean and
    // the sample covers every occurrence (see aggregateSampledVerdict) — the
    // multi-example replacement for the old first-example-only guardPluralRefute.
    const sampleUrls = sampleUrlsFor(f);
    if (sampleUrls.length === 0) {
      verdicts.push(toVerdict(f, checker.kind, unverifiable('no concrete example URL in report', 'no-example')));
      continue;
    }
    const results: CheckResult[] = sampleUrls.map((u) => {
      const signals = cache.get(u);
      return signals
        ? checker.check(signals, f)
        : unverifiable(`could not load ${u}${unreachableReason(u)}`, 'unreachable');
    });
    verdicts.push(toVerdict(f, checker.kind, aggregateSampledVerdict(results, f.count)));
  }

  return { verdicts, signalsByUrl: cache };
}

/**
 * Compact, LLM-friendly snapshot of a page's live signals (Slice 3). Drops the
 * verbose / low-signal fields (the raw header map is summarised to the handful
 * of headers that matter) so the prompt stays small. Pure → unit-tested.
 */
export function liveSignalsSnapshot(s: LiveSignals): Record<string, unknown> {
  const h = s.headers ?? {};
  const keptHeaders: Record<string, string> = {};
  for (const k of [
    'content-encoding',
    'content-language',
    'cache-control',
    'vary',
    'x-robots-tag',
    'permissions-policy',
    'content-security-policy',
    'strict-transport-security',
    'x-frame-options',
    'server',
    'x-powered-by',
  ]) {
    if (h[k]) keptHeaders[k] = h[k];
  }
  return {
    status: s.status,
    finalUrl: s.finalUrl,
    redirectCount: s.redirectCount,
    title: s.title,
    titleLength: s.title.length,
    description: s.description,
    descriptionLength: s.description?.length ?? 0,
    canonical: s.canonical,
    htmlLang: s.htmlLang,
    h1Count: s.h1Count,
    wordCount: s.wordCount,
    semanticRatio: Number(s.semanticRatio.toFixed(2)),
    iframeCount: s.iframeCount,
    emptyAnchorCount: s.emptyAnchorCount,
    inputsWithoutAutocomplete: s.inputsWithoutAutocomplete,
    scriptsNoSri: s.scriptsNoSri,
    mainCount: s.mainCount,
    resourceHintCount: s.resourceHintCount,
    privacyLinkCount: s.privacyLinkCount,
    eeatSignals: s.eeatSignals,
    ttfbMs: s.ttfbMs,
    tlsMs: s.tlsMs,
    clsValue: Number(s.clsValue.toFixed(3)),
    tbtMs: s.tbtMs,
    unusedCssPct: s.unusedCssRatio >= 0 ? Math.round(s.unusedCssRatio * 100) : null,
    unusedJsPct: s.unusedJsRatio >= 0 ? Math.round(s.unusedJsRatio * 100) : null,
    totalRequests: s.totalRequests,
    totalBytes: s.totalBytes,
    htmlBytes: s.htmlBytes,
    thirdPartyOrigins: s.thirdPartyOrigins,
    thirdPartyRequests: s.thirdPartyRequests,
    thirdPartyBytes: s.thirdPartyBytes,
    renderBlockingTotal: s.renderBlockingTotal,
    oversizedImages: s.oversizedImages,
    jpgPngImages: s.jpgPngImages,
    modernImages: s.modernImages,
    preConsentTrackingCookies: s.preConsentTrackingCookies,
    contrastViolations: s.contrastViolations >= 0 ? s.contrastViolations : null,
    headers: keptHeaders,
  };
}

/**
 * A refute DROPS the finding from the verified report. We only ever re-fetch
 * the FIRST example, so for a multi-occurrence finding ("Canonicals are not set
 * … affects 44 occurrences") a clean first page can't speak for the other 43.
 * Downgrade such a refute to `unverified` — same "never refute on partial
 * evidence" doctrine as the load-dependent / DOM-underobservable paths. A
 * confirm on the one page is still valid (the defect demonstrably exists);
 * single-occurrence findings (count ≤ 1) refute normally — the sampled page IS
 * the whole finding.
 */
function guardPluralRefute(r: CheckResult, f: ReportFinding): CheckResult {
  if (r.status === 'refuted' && f.count > 1) {
    return unverifiable(
      `only the first of ${f.count} occurrences was re-fetched and it no longer shows the issue; the other ${f.count - 1} are unchecked — not dropping (single-page check: ${r.reason})`,
      'plural-undersampled',
    );
  }
  return r;
}

/**
 * Resolve a finding title + already-captured signals to a verdict — the pure,
 * network-free per-finding core of {@link verifyReportLive}'s loop (checker
 * lookup → check → plural guard). Exported so the refute/confirm contract of
 * individual checkers can be unit-tested without launching a browser.
 */
export function checkFindingSignals(title: string, signals: LiveSignals, count = 1): CheckResult {
  const checker = CHECKERS.find((c) => c.match(title.toLowerCase()));
  if (!checker) return unverifiable('no live checker for this finding kind');
  const f: ReportFinding = { title, severity: 'HIGH', count, exampleUrls: [] };
  if (checker.noFetch) return checker.check({} as LiveSignals, f);
  return guardPluralRefute(checker.check(signals, f), f);
}
