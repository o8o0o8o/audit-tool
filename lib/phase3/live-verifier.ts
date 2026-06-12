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
 * Scope: only CRITICAL / HIGH / MEDIUM findings are verified (LOW is skipped).
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
import type { Browser, Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { THRESHOLDS, DEFAULT_USER_AGENT, VIEWPORT, CRAWL_SETTINGS } from '../constants';
import { PaginationAnalyzer } from '../analyzers/seo/pagination-analyzer';
import { withTimeout } from '../crawler/resilience';
import { isFetchAllowed } from '../../validators';

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

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

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

export interface LiveVerdict {
  title: string;
  severity: Severity;
  status: LiveStatus;
  reason: string;
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
 * LOW findings are dropped (CRITICAL/HIGH/MEDIUM only).
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
    if (severity === 'LOW') continue;
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

const AD_HOST_RE = /(doubleclick|googlesyndication|google-analytics|googletagservices|adservice|adsystem|adnxs|amazon-adsystem|criteo|taboola|outbrain|pubmatic|rubiconproject|openx|scorecardresearch|moatads|adroll|quantserve)\b/i;

/** Common tracking-cookie name prefixes (GA, FB, GTM, Hotjar, …). */
const TRACKER_COOKIE_RE = /^(_ga|_gid|_gat|_fbp|_fbc|_gcl|_hj|_uet|__hs|hubspotutk|mp_|amplitude|_pk_|optimizely|_clck|_clsk|IDE|test_cookie|fr|MUID)/i;

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
function jsUnusedRatio(entries: { source?: string; functions: { ranges: { count: number; startOffset: number; endOffset: number }[] }[] }[]): number {
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
async function captureOne(browser: Browser, url: string, timeoutMs: number, throttle?: Throttle): Promise<LiveSignals | null> {
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
  // Accurate per-request transfer sizes come from `request.sizes()` on
  // 'requestfinished' (real responseBodySize, incl. chunked) rather than the
  // unreliable content-length header.
  const requests: { host: string; type: string; bytes: number }[] = [];
  const sizings: Promise<void>[] = [];
  try {
    const page = await context.newPage();
    page.on('requestfinished', (req) => {
      sizings.push(
        (async () => {
          try {
            const s = await req.sizes();
            requests.push({ host: new URL(req.url()).hostname, type: req.resourceType(), bytes: s.responseBodySize > 0 ? s.responseBodySize : 0 });
          } catch {
            /* request may have no recordable size */
          }
        })(),
      );
    });

    // CLS + long-task (TBT proxy) observers must be installed before any script
    // runs on the page.
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number; __tbt: number };
      w.__cls = 0;
      w.__tbt = 0;
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

    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
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

    // CLS / TBT readout.
    const vitals = await page
      .evaluate(() => {
        const w = window as unknown as { __cls?: number; __tbt?: number };
        return { cls: w.__cls ?? 0, tbt: Math.round(w.__tbt ?? 0) };
      })
      .catch(() => ({ cls: 0, tbt: 0 }));

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

      const SEMANTIC = ['header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'figure', 'figcaption', 'details', 'summary', 'time', 'mark'];
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

      // `<main>` landmark (the "Missing <main> element" finding). role="main"
      // counts as an equivalent landmark.
      const mainCount = document.querySelectorAll('main, [role="main"]').length;

      // Resource hints in the document head/body. rel is case-insensitive in
      // HTML, so use the `i` attribute flag.
      const resourceHintCount = document.querySelectorAll(
        'link[rel~="preconnect" i], link[rel~="preload" i], link[rel~="dns-prefetch" i], link[rel~="prefetch" i], link[rel~="modulepreload" i]',
      ).length;

      // Privacy-policy links: href OR visible text mentions "privacy".
      let privacyLinkCount = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a.getAttribute('href') ?? '').toLowerCase();
        const text = (a.textContent ?? '').toLowerCase();
        if (/privacy/.test(href) || /privacy/.test(text)) privacyLinkCount++;
      }

      // E-E-A-T proxy signals on the page (0–4).
      let eeatSignals = 0;
      if (document.querySelector('[rel="author"], [itemprop="author"], [class*="author" i], [class*="byline" i]')) eeatSignals++;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      if (anchors.some((a) => /about/.test(((a.getAttribute('href') ?? '') + ' ' + (a.textContent ?? '')).toLowerCase()))) eeatSignals++;
      if (anchors.some((a) => /contact/.test(((a.getAttribute('href') ?? '') + ' ' + (a.textContent ?? '')).toLowerCase()))) eeatSignals++;
      if (Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) => /"@type"\s*:\s*"(Person|Organization)"/.test(s.textContent ?? ''))) eeatSignals++;

      return {
        title: (document.title ?? '').trim(),
        description: descEl ? (descEl.getAttribute('content') ?? '').trim() : null,
        canonical: canonicalEl ? (canonicalEl.getAttribute('href') ?? '').trim() : null,
        h1Count: document.querySelectorAll('h1').length,
        iframeCount: document.querySelectorAll('iframe').length,
        wordCount,
        semanticRatio,
        emptyAnchorCount,
        inputsWithoutAutocomplete,
        scriptsNoSri,
        maxChildren,
        jpgPngImages,
        modernImages,
        renderBlockingTotal,
        renderBlockingThirdParty,
        oversizedImages,
        mainCount,
        resourceHintCount,
        privacyLinkCount,
        eeatSignals,
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
      scriptsNoSri: dom.scriptsNoSri,
      maxChildren: dom.maxChildren,
      jpgPngImages: dom.jpgPngImages,
      modernImages: dom.modernImages,
      renderBlockingTotal: dom.renderBlockingTotal,
      renderBlockingThirdParty: dom.renderBlockingThirdParty,
      thirdPartyOrigins: new Set(thirdParty.map((r) => r.host)).size,
      thirdPartyRequests: thirdParty.length,
      thirdPartyBytes: thirdParty.reduce((n, r) => n + r.bytes, 0),
      adScriptBytes: thirdParty.filter((r) => r.type === 'script' && AD_HOST_RE.test(r.host)).reduce((n, r) => n + r.bytes, 0),
      largestImageBytes: imageBytes.length ? Math.max(...imageBytes) : 0,
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
    };
  } catch {
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/* ----------------------------------------------------------- live checkers */

export interface CheckResult {
  status: LiveStatus;
  reason: string;
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

const confirmed = (reason: string): CheckResult => ({ status: 'confirmed', reason });
const refuted = (reason: string): CheckResult => ({ status: 'refuted', reason });
const unverifiable = (reason: string): CheckResult => ({ status: 'unverified', reason });

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
    : unverifiable(`live load measured ${label} = ${value}${unit} (≤ ${limit}${unit}); a single light load can under-count this — not dropping`);
}

/**
 * Confirm-only for DOM signals a single load can UNDER-observe — lazy /
 * below-the-fold images, JS-injected anchors, content that hydrates after load.
 * Confirmed when the defect is present at load; otherwise `unverified` (the
 * page may exhibit it once fully exercised). NEVER refuted, so a not-yet-loaded
 * page can't drop a real finding.
 */
function presentOrUnsure(present: boolean, whenPresent: string, whenAbsent: string): CheckResult {
  return present ? confirmed(whenPresent) : unverifiable(whenAbsent);
}

/**
 * Verdict for a title/description length finding. The value is server-rendered
 * and stable at load, so this confirms/refutes on the live measurement (a
 * multi-occurrence refute is later downgraded by guardPluralRefute). A missing
 * value routes to `unverified` — "too long/short" can't be judged on absent
 * text, and a missing title/description is a separate finding. Pure → unit-tested.
 */
export function titleDescriptionVerdict(field: 'title' | 'description', value: string | null, tooLong: boolean, min: number, max: number): CheckResult {
  const text = (value ?? '').trim();
  if (!text) return unverifiable(`no ${field} on the page now — a missing ${field} is a separate finding, not "too ${tooLong ? 'long' : 'short'}"`);
  const len = text.length;
  if (tooLong) {
    return len > max ? confirmed(`${field} is ${len} chars (> ${max})`) : refuted(`${field} is ${len} chars (≤ ${max})`);
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

// Ordered: more specific kinds first (the first match wins).
const CHECKERS: LiveChecker[] = [
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
      ),
  },
  {
    kind: 'html-exceeds-3mb',
    match: (t) => /html/.test(t) && /3\s?mb|exceeds/.test(t),
    check: (s) => overOrUnsure(s.htmlBytes, 3_000_000, 'served HTML', ' bytes'),
  },
  {
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
        ? unverifiable('TTFB not reported by navigation timing')
        : s.ttfbMs > THRESHOLDS.TTFB
          ? confirmed(`TTFB is ${s.ttfbMs}ms (> ${THRESHOLDS.TTFB}ms)`)
          : unverifiable(`TTFB is ${s.ttfbMs}ms on this fetch (≤ ${THRESHOLDS.TTFB}ms); TTFB varies with CDN POP / cache warmth — not dropping`),
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
    kind: 'sri-missing',
    match: (t) => /subresource integrity|sri/.test(t),
    check: (s) => (s.scriptsNoSri > 0 ? confirmed(`${s.scriptsNoSri} cross-origin script(s) without integrity`) : refuted('all cross-origin scripts have SRI')),
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
        : unverifiable(`this page's semantic ratio is ${(s.semanticRatio * 100).toFixed(0)}% — site-wide claim not provable from one page`),
  },
  {
    kind: 'thin-content',
    match: (t) => /thin content|low content|very thin/.test(t),
    check: (s) =>
      s.wordCount < THRESHOLDS.THIN_CONTENT_LOW
        ? confirmed(`${s.wordCount} words (< ${THRESHOLDS.THIN_CONTENT_LOW})`)
        : unverifiable(`${s.wordCount} words at load (≥ ${THRESHOLDS.THIN_CONTENT_LOW}); content may hydrate/lazy-load — not dropping`),
  },
  {
    // Title length — a stable, server-rendered signal, so confirm/refute both
    // apply (multi-occurrence refutes are downgraded by guardPluralRefute).
    kind: 'title-length',
    match: (t) => /title/.test(t) && /(too short|too long)/.test(t),
    check: (s, f) => titleDescriptionVerdict('title', s.title, /too long/.test(f.title.toLowerCase()), THRESHOLDS.TITLE_MIN, THRESHOLDS.TITLE_MAX),
  },
  {
    kind: 'description-length',
    match: (t) => /description/.test(t) && /(too short|too long)/.test(t),
    check: (s, f) => titleDescriptionVerdict('description', s.description, /too long/.test(f.title.toLowerCase()), THRESHOLDS.DESCRIPTION_MIN, THRESHOLDS.DESCRIPTION_MAX),
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
    check: (s) => (s.mainCount === 0 ? confirmed('no <main> / role="main" landmark on the page') : refuted(`${s.mainCount} <main>/role="main" landmark(s) present`)),
  },
  {
    // "No privacy policy link found". Footer privacy links are server-rendered →
    // confirm/refute both apply (plural-guarded for multi-page findings).
    kind: 'privacy-link',
    match: (t) => /privacy policy link|privacy.*link|no.*privacy/.test(t),
    check: (s) => (s.privacyLinkCount === 0 ? confirmed('no visible privacy-policy link on the page') : refuted(`${s.privacyLinkCount} privacy-policy link(s) present`)),
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
        ? unverifiable('TLS handshake time not reported (connection reused / no fresh secure handshake on this navigation)')
        : s.tlsMs > THRESHOLDS.TLS_HANDSHAKE
          ? confirmed(`TLS handshake ${s.tlsMs}ms (> ${THRESHOLDS.TLS_HANDSHAKE}ms)`)
          : unverifiable(`TLS handshake ${s.tlsMs}ms on this fetch (≤ ${THRESHOLDS.TLS_HANDSHAKE}ms); handshake time varies with session resumption / CDN POP — not dropping`),
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
      ),
  },
  // Site-level / cross-page / instrumentation-only kinds: a single live page
  // load cannot adjudicate these. Marked noFetch (the orchestrator skips the
  // fetch) and reported as `unverified` with the reason.
  {
    kind: 'duplicate',
    noFetch: true,
    match: (t) => /duplicate (page )?(title|meta description)/.test(t),
    check: () => unverifiable('duplication needs ≥2 pages compared — single-page live fetch cannot confirm'),
  },
  {
    kind: 'site-graph',
    noFetch: true,
    match: (t) => /orphan|unreachable|missing from sitemap|not (listed )?in sitemap|link equity|click depth/.test(t),
    check: () => unverifiable('site-level (link graph / sitemap) — not derivable from one live page'),
  },
  {
    // Keyword cannibalisation: "Multiple pages target the same keyword in their
    // titles". Cross-page — the special verifier fetches the first 2 cited pages
    // and checks their titles for a shared keyword. Confirm-only.
    kind: 'cannibalisation',
    noFetch: true,
    match: (t) => /same keyword|cannibal|keyword.*(in (their )?titles?|conflict)/.test(t),
    check: () => unverifiable('keyword cannibalisation handled by the special multi-page verifier'),
  },
  {
    // Cross-page topic aggregates ("Many topics with thin coverage",
    // "High-opportunity content gaps") are computed over the WHOLE crawl's topic
    // clusters — a single live page can't reproduce them. Owned (so it isn't a
    // "no live checker" gap) and routed to the offline / LLM pass.
    kind: 'topic-coverage',
    noFetch: true,
    match: (t) => /topic|content gap|topical/.test(t),
    check: () => unverifiable('cross-page topic / coverage aggregate (computed over the whole crawl) — not derivable from a single live page; use the offline or LLM verification pass'),
  },
  {
    kind: 'broken-pagination',
    noFetch: true,
    match: (t) => /broken pagination|pagination wastes/.test(t),
    check: () => unverifiable('series-level claim — needs the full paginated series, not one page'),
  },
  {
    // Per-page "Page has N broken outbound link(s)": the example's first URL is
    // the ON-SITE container page, not the dead link — fetching it gets HTTP 200
    // and would FALSELY refute. Routed to a special verifier that fetches the
    // cited external link instead. Listed before the site-wide kind below.
    kind: 'broken-outbound-page',
    noFetch: true,
    match: (t) => /page has \d+ broken outbound|broken outbound link\(s\)/.test(t),
    check: () => unverifiable('per-page broken-outbound handled by the special verifier'),
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
    check: () => unverifiable('site-wide broken-outbound handled by the special verifier'),
  },
  {
    kind: 'vitals',
    match: (t) => /\bcls\b|\btbt\b|\binp\b|layout shift|blocking time/.test(t),
    // CLS/TBT measured live via PerformanceObserver under the crawl's
    // network/CPU/device profile. Confirm-only (they vary load to load). INP
    // needs real interaction → unverified.
    check: (s, f) => {
      const t = f.title.toLowerCase();
      if (/\bcls\b|layout shift/.test(t)) return overOrUnsure(Number(s.clsValue.toFixed(3)), THRESHOLDS.CLS, 'CLS');
      if (/\btbt\b|blocking time/.test(t)) return overOrUnsure(s.tbtMs, THRESHOLDS.TBT, 'TBT', 'ms');
      return unverifiable('INP needs real user interaction — not measurable from an automated load');
    },
  },
  {
    kind: 'coverage',
    match: (t) => /unused (css|code)/.test(t),
    // Unused-bytes ratio from Playwright CSS/JS coverage. Confirm-only: deferred
    // / interaction-loaded code can only raise real usage, never the reverse.
    check: (s, f) => {
      // "unused CSS" → CSS coverage; "unused code" means unused JavaScript → JS coverage.
      const ratio = /css/.test(f.title.toLowerCase()) ? s.unusedCssRatio : s.unusedJsRatio;
      if (ratio < 0) return unverifiable('coverage not measurable on this page');
      const pct = Math.round(ratio * 100);
      return pct > 50 ? confirmed(`${pct}% of downloaded bytes unused`) : unverifiable(`${pct}% unused at load (≤ 50%); deferred code may raise this — not dropping`);
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
          : unverifiable('no contrast violations on the rendered page at load — interaction-gated views unscanned; not dropping'),
  },
];

/* ------------------------- site-level + multi-page + series verifiers ------- */

/** Kinds the orchestrator handles with dedicated async verifiers (site context,
 *  multi-page comparison, or series walk) instead of the per-page registry. */
const SPECIAL_KINDS = new Set(['duplicate', 'site-graph', 'broken-pagination', 'broken-outbound-page', 'broken-outbound', 'cannibalisation']);

/** Page cap for the homepage reachability BFS (orphan/unreachable checks). */
const REACHABILITY_MAX_PAGES = 120;

export interface LiveSite {
  /** Normalized URLs declared in the sitemap(s); empty if none fetched. */
  sitemapUrls: Set<string>;
  /** True when the sitemap fetch was truncated (budget / fan-out / URL cap) —
   *  the set is INCOMPLETE, so a missing URL can't be asserted absent. */
  sitemapCapped: boolean;
  /** Normalized URLs reachable from the homepage via internal links (bounded BFS). */
  reachable: Set<string>;
  /** True when the BFS hit its page cap — reachability is then INCOMPLETE, so a
   *  missing URL can't be asserted as an orphan (→ unverified, never refute). */
  reachabilityCapped: boolean;
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
  while (queue.length && budget-- > 0) {
    const sm = queue.shift() as string;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm, timeoutMs);
    if (!xml) continue;
    const isIndex = /<sitemapindex/i.test(xml);
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const loc = m[1].trim();
      if (isIndex) {
        if (queue.length < 50) queue.push(loc);
        else droppedChild = true;
      } else {
        urls.add(normUrl(loc));
        if (urls.size >= 50000) return { urls, capped: true };
      }
    }
  }
  // Incomplete if the fetch budget ran out with sitemaps still queued, or the
  // index fan-out cap dropped a child we never read.
  return { urls, capped: queue.length > 0 || droppedChild };
}

/** Bounded BFS from the homepage over internal links → reachable URL set. */
async function buildReachable(browser: Browser, origin: string, timeoutMs: number): Promise<{ set: Set<string>; capped: boolean }> {
  const MAX_PAGES = REACHABILITY_MAX_PAGES;
  const start = `${origin}/`;
  const reachable = new Set<string>([normUrl(start)]);
  const queue: string[] = [start];
  const originReg = registrable(new URL(origin).hostname);
  const context = await browser.newContext({ viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT }, userAgent: DEFAULT_USER_AGENT });
  let visited = 0;
  // True once we DISCOVER a reachable URL but stop enqueuing it for crawling
  // (cap reached). The graph is then only partially explored, so a URL absent
  // from `reachable` can't be asserted as an orphan — coverage is incomplete
  // even if the queue happens to drain to empty.
  let suppressed = false;
  try {
    const page = await context.newPage();
    while (queue.length && visited < MAX_PAGES) {
      const url = queue.shift() as string;
      visited++;
      if (!liveFetchAllowed(url)) continue;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href));
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
  // Capped if the loop stopped with work left OR we ever suppressed an enqueue.
  return { set: reachable, capped: queue.length > 0 || suppressed };
}

/** Light fetch: status + title + description + word count (no heavy instrumentation). */
async function fetchLight(browser: Browser, url: string, timeoutMs: number): Promise<{ status: number; title: string; description: string | null; h1: string; wordCount: number } | null> {
  if (!liveFetchAllowed(url)) return null;
  const context = await browser.newContext({ viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT }, userAgent: DEFAULT_USER_AGENT });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
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
export function duplicateVerdict(field: 'title' | 'description', a: string | null, b: string | null, count: number): CheckResult {
  if (!a || !b) return unverifiable(`a cited page is missing its ${field}`);
  if (a.trim() === b.trim()) return confirmed(`2 pages share the same ${field}: "${a.slice(0, 60)}"`);
  return count <= 2
    ? refuted(`the ${field}s of the only ${count} cited pages now differ`)
    : unverifiable(`the first 2 of ${count} cited pages now differ, but the other ${count - 2} weren't compared — not dropping`);
}

/** Duplicate title/description: fetch the first two example pages and compare. */
async function verifyDuplicate(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  const isDesc = /description/i.test(f.title);
  const field: 'title' | 'description' = isDesc ? 'description' : 'title';
  if (f.exampleUrls.length < 2) return unverifiable(`only one example page cited — need ≥2 to compare ${field}s`);
  const [a, b] = await Promise.all([fetchLight(browser, f.exampleUrls[0], timeoutMs), fetchLight(browser, f.exampleUrls[1], timeoutMs)]);
  if (!a || !b) return unverifiable('could not load both example pages');
  return duplicateVerdict(field, isDesc ? a.description : a.title, isDesc ? b.description : b.title, f.count);
}

/** Generic title tokens that don't prove keyword cannibalisation on their own. */
const TITLE_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'home', 'page', 'site', 'official', 'welcome']);

/**
 * First non-trivial word (≥4 chars, not a stopword) shared by two titles, or
 * null when they share none. Pure → unit-tested. The match is the live evidence
 * that two pages still compete for the same keyword in their titles.
 */
export function sharedTitleKeyword(a: string, b: string): string | null {
  const toks = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !TITLE_STOPWORDS.has(w)));
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

async function verifyKeywordCannibalisation(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  const onH1 = cannibalisationElement(f.title) === 'h1';
  const label = onH1 ? 'H1' : 'title';
  if (f.exampleUrls.length < 2) return unverifiable(`need ≥2 example pages to compare ${label}s for a shared keyword`);
  const [a, b] = await Promise.all([fetchLight(browser, f.exampleUrls[0], timeoutMs), fetchLight(browser, f.exampleUrls[1], timeoutMs)]);
  if (!a || !b) return unverifiable('could not load both example pages');
  const shared = sharedTitleKeyword(onH1 ? a.h1 : a.title, onH1 ? b.h1 : b.title);
  return shared
    ? confirmed(`2 cited pages still share the ${label} keyword "${shared}"`)
    : unverifiable(`the first 2 cited pages share no obvious ${label} keyword now, but the finding spans ${f.count} groups — other pages weren't compared; not dropping`);
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
    : unverifiable(`cited outbound link now returns HTTP ${state.status}; other links on the page unchecked — not dropping`);
}

/**
 * Verdict for a re-fetched outbound link by HTTP status. Confirm-only: a 4xx/5xx
 * confirms the broken link; a sub-400 status is `unverified` (external-link
 * liveness is volatile — never drop on it). Pure, so it's unit-tested directly.
 */
export function brokenOutboundVerdict(status: number): CheckResult {
  return status >= 400
    ? confirmed(`outbound link returns HTTP ${status}`)
    : unverifiable(`outbound link now returns HTTP ${status}; external-link liveness is volatile (transient outage / UA gating) — not dropping`);
}

/**
 * Site-wide "Broken outbound link": the example URL IS the dead link. Re-fetch
 * it with the lightweight path (no axe/coverage/scroll — wasted on a dead
 * external link) and read the status. Confirm-only.
 */
async function verifyBrokenOutbound(f: ReportFinding, browser: Browser, timeoutMs: number): Promise<CheckResult> {
  if (!f.exampleUrl) return unverifiable('no outbound link cited to re-fetch');
  const state = await fetchLight(browser, f.exampleUrl, timeoutMs);
  return state ? brokenOutboundVerdict(state.status) : unverifiable(`could not load cited outbound link ${f.exampleUrl}`);
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
    ? unverifiable('sitemap fetch was truncated (large multi-sitemap index) — cannot assert the page is absent; not confirming')
    : confirmed('cited page is absent from the sitemap');
}

/** Orphan / unreachable: confirm when the cited page isn't reachable from the homepage. */
export function verifyReachability(f: ReportFinding, site: LiveSite): CheckResult {
  if (!f.exampleUrl) return unverifiable('no example URL to test reachability');
  if (site.reachable.has(normUrl(f.exampleUrl))) return refuted('cited page IS reachable from the homepage via internal links');
  if (site.reachabilityCapped) return unverifiable(`cited page not seen within the ${REACHABILITY_MAX_PAGES}-page crawl cap — reachability inconclusive, not dropping`);
  return confirmed('cited page is not reachable from the homepage via internal links');
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
    if (state.status >= 400) return refuted(`page #9999 correctly returns HTTP ${state.status} — pagination is bounded`);
    if (state.wordCount < 50) return confirmed(`page #9999 still returns HTTP 200 with thin content (${state.wordCount} words) — pagination never terminates`);
    return unverifiable(`page #9999 returns HTTP 200 with ${state.wordCount} words — inconclusive without walking the full series`);
  }

  // Active "next"-control form — re-run the real probe on each cited page.
  const urls = f.exampleUrls.slice(0, 5);
  if (urls.length === 0) return unverifiable('no example URL to re-probe for a "next" control');
  const context = await browser.newContext({ viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT }, userAgent: DEFAULT_USER_AGENT });
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
      if (nextProbe.suspectedInfinite) return confirmed(`live "next" probe reproduces broken/infinite pagination on ${u}`);
      // Content collapsed after a click but the URL didn't advance → possible
      // broken IN-PLACE pagination a single light probe may under-observe.
      if (nextProbe.emptyAfterClick) anyEmptied = true;
    }
    if (probed === 0) return unverifiable('could not re-probe any cited page');
    // Never drop when there's a hint of broken behavior we might have under-observed
    // (doctrine: don't refute on a signal a single light load can under-observe).
    if (anyEmptied) return unverifiable('a cited page\'s content collapsed after clicking "next" without a URL advance — possible broken in-place pagination; not dropping');
    return f.count <= probed
      ? refuted(`re-probed all ${probed} cited page(s): "next" advances to real distinct pages or only an in-page anchor — not broken pagination`)
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

/**
 * Parse the report, re-fetch each finding's first example, and re-assert the
 * claim live. One fetch per DISTINCT example URL (cached). Findings with no
 * example URL or no matching checker resolve to `unverified`.
 */
export async function verifyReportLive(reportMd: string, opts: LiveVerifyOptions = {}): Promise<LiveVerdict[]> {
  const timeoutMs = opts.timeoutMs ?? THRESHOLDS.PAGE_TIMEOUT;
  const findings = parseReportFindings(reportMd);
  const verdicts: LiveVerdict[] = [];

  // The audited site's host: same-host re-fetches are allowed even if private
  // (a local-site audit), while a stray private URL parsed from the report is
  // blocked by the SSRF guard.
  const siteOriginForGuard = resolveSiteOrigin(findings);
  verifyOriginHost = siteOriginForGuard ? (() => { try { return new URL(siteOriginForGuard).hostname; } catch { return undefined; } })() : undefined;

  const plan = findings.map((f) => {
    const checker = CHECKERS.find((c) => c.match(f.title.toLowerCase()));
    return { f, checker };
  });

  // Per-page signal fetches: every fetchable, non-special kind with an example.
  const urlsToFetch = new Set<string>();
  let needsSiteCtx = false;
  let hasSpecial = false;
  let needsHomepage = false;
  for (const { f, checker } of plan) {
    if (!checker) continue;
    if (checker.kind === 'site-graph') needsSiteCtx = true;
    if (checker.siteWidePage) needsHomepage = true;
    if (SPECIAL_KINDS.has(checker.kind)) hasSpecial = true;
    else if (!checker.noFetch && !checker.siteWidePage && f.exampleUrl) urlsToFetch.add(f.exampleUrl);
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
      // 1. Per-page signal captures.
      let n = 0;
      for (const url of urlsToFetch) {
        n++;
        if (opts.verbose) console.log(`  … live-fetching (${n}/${urlsToFetch.size}) ${url}`);
        cache.set(url, await captureOne(browser, url, timeoutMs, opts.throttle));
      }

      // 1b. Homepage capture backing the siteWidePage checkers (resource hints,
      // E-E-A-T) — those findings cite no per-page URL.
      if (needsHomepage && siteOrigin) {
        const homeUrl = `${siteOrigin}/`;
        if (opts.verbose) console.log(`  … live-fetching site homepage for site-wide checks: ${homeUrl}`);
        homepageSignals = cache.get(homeUrl) ?? (await captureOne(browser, homeUrl, timeoutMs, opts.throttle));
        cache.set(homeUrl, homepageSignals);
      }

      // 2. Site context (sitemap + reachability) for site-level findings.
      let site: LiveSite | null = null;
      if (needsSiteCtx) {
        // Derive the origin from a site-graph finding's OWN example (always
        // on-site) — NOT the first finding of any kind, whose example could be
        // an external URL (e.g. a broken-outbound link) → wrong-origin sitemap.
        const siteGraphUrl = plan.find((p) => p.checker?.kind === 'site-graph' && p.f.exampleUrl)?.f.exampleUrl;
        if (siteGraphUrl) {
          const origin = new URL(siteGraphUrl).origin;
          if (opts.verbose) console.log(`  … building site context (sitemap + reachability) for ${origin}`);
          const sitemap = await fetchSitemapUrls(origin, timeoutMs);
          const wantsReach = plan.some((p) => p.checker?.kind === 'site-graph' && /orphan|unreachable/i.test(p.f.title));
          const reach = wantsReach ? await buildReachable(browser, origin, timeoutMs) : { set: new Set<string>(), capped: true };
          site = { sitemapUrls: sitemap.urls, sitemapCapped: sitemap.capped, reachable: reach.set, reachabilityCapped: reach.capped };
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
        else if (checker.kind === 'site-graph') {
          if (!site) r = unverifiable('site context unavailable');
          else if (/missing from sitemap|not (listed )?in sitemap/i.test(f.title)) r = verifySitemapMembership(f, site);
          else if (/orphan|unreachable/i.test(f.title)) r = verifyReachability(f, site);
          else r = unverifiable('link-equity / click-depth not derivable from a bounded live crawl');
        } else r = unverifiable('unhandled special kind');
        // `duplicate` and `broken-pagination` do their own count-coverage gating
        // (refute only when the cited examples cover the whole finding), so they
        // are EXEMPT from the blunt count>1 guard — which would otherwise
        // downgrade those legitimate, fully-covered drops. Others keep the guard.
        const selfGated = checker.kind === 'duplicate' || checker.kind === 'broken-pagination';
        const guarded = selfGated ? r : guardPluralRefute(r, f);
        verdictByPlan.set(f, { ...guarded, kind: checker.kind });
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  for (const { f, checker } of plan) {
    if (!checker) {
      verdicts.push({ title: f.title, severity: f.severity, status: 'unverified', reason: 'no live checker for this finding kind', exampleUrl: f.exampleUrl, kind: 'none' });
      continue;
    }
    const special = verdictByPlan.get(f);
    if (special) {
      verdicts.push({ title: f.title, severity: f.severity, status: special.status, reason: special.reason, exampleUrl: f.exampleUrl, kind: special.kind });
      continue;
    }
    if (checker.noFetch) {
      const r = checker.check({} as LiveSignals, f);
      verdicts.push({ title: f.title, severity: f.severity, status: r.status, reason: r.reason, exampleUrl: f.exampleUrl, kind: checker.kind });
      continue;
    }
    if (checker.siteWidePage) {
      // Site-wide page claim: judged against the resolved homepage. Confirm-only,
      // so no plural guard is needed (the checker never refutes).
      const r = homepageSignals
        ? checker.check(homepageSignals, f)
        : unverifiable(siteOrigin ? 'could not load the site homepage for the site-wide check' : 'no on-site URL in the report to resolve the homepage');
      verdicts.push({ title: f.title, severity: f.severity, status: r.status, reason: r.reason, exampleUrl: f.exampleUrl, kind: checker.kind });
      continue;
    }
    if (!f.exampleUrl) {
      verdicts.push({ title: f.title, severity: f.severity, status: 'unverified', reason: 'no concrete example URL in report', exampleUrl: undefined, kind: checker.kind });
      continue;
    }
    const signals = cache.get(f.exampleUrl);
    if (!signals) {
      verdicts.push({ title: f.title, severity: f.severity, status: 'unverified', reason: `could not load ${f.exampleUrl}`, exampleUrl: f.exampleUrl, kind: checker.kind });
      continue;
    }
    const r = guardPluralRefute(checker.check(signals, f), f);
    verdicts.push({ title: f.title, severity: f.severity, status: r.status, reason: r.reason, exampleUrl: f.exampleUrl, kind: checker.kind });
  }

  return verdicts;
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
