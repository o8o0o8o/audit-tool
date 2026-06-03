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
import type { Browser } from 'playwright';
import { THRESHOLDS, DEFAULT_USER_AGENT, VIEWPORT } from '../constants';

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

    // Collect the first real example URL — ONLY from the "Affected pages"
    // block. Scanning to the next heading would otherwise walk into Fix /
    // Resources and grab an external doc link, then re-check the wrong page.
    let exampleUrl: string | undefined;
    let inAffected = false;
    for (let k = j + 1; k < lines.length && !/^#{2,3}\s/.test(lines[k]); k++) {
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
        exampleUrl = url;
        break;
      }
      if (exampleUrl) break;
    }

    findings.push({ title, severity: severity as Severity, count, exampleUrl });
  }

  return findings;
}

/* ------------------------------------------------------- live signal capture */

const AD_HOST_RE = /(doubleclick|googlesyndication|google-analytics|googletagservices|adservice|adsystem|adnxs|amazon-adsystem|criteo|taboola|outbrain|pubmatic|rubiconproject|openx|scorecardresearch|moatads|adroll|quantserve)\b/i;

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
async function captureOne(browser: Browser, url: string, timeoutMs: number): Promise<LiveSignals | null> {
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT },
    userAgent: DEFAULT_USER_AGENT,
  });
  const requests: { host: string; type: string; bytes: number }[] = [];
  try {
    const page = await context.newPage();
    page.on('response', (resp) => {
      try {
        const u = new URL(resp.url());
        const len = Number(resp.headers()['content-length'] ?? 0);
        requests.push({ host: u.hostname, type: resp.request().resourceType(), bytes: Number.isFinite(len) ? len : 0 });
      } catch {
        /* ignore unparsable */
      }
    });

    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    if (!response) return null;
    // Give client-side hydration / deferred content a chance to mount before we
    // read DOM signals. networkidle can never settle on sites with persistent
    // connections (analytics, websockets), so cap it and ignore the timeout.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    const status = response.status();
    const finalUrl = response.url();
    const pageHost = new URL(finalUrl).hostname;

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
      };
    });

    // Navigation-timing TTFB (responseStart), in ms.
    const ttfbMs = await page
      .evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        return nav ? Math.round(nav.responseStart) : null;
      })
      .catch(() => null);

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

function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return (url.href.endsWith('/') ? url.href.slice(0, -1) : url.href).toLowerCase();
  } catch {
    return u.toLowerCase();
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
    match: (t) => /orphan|unreachable|missing from sitemap|link equity|click depth/.test(t),
    check: () => unverifiable('site-level (link graph / sitemap) — not derivable from one live page'),
  },
  {
    kind: 'broken-pagination',
    noFetch: true,
    match: (t) => /broken pagination|pagination wastes/.test(t),
    check: () => unverifiable('series-level claim — needs the full paginated series, not one page'),
  },
  {
    kind: 'broken-outbound',
    noFetch: true,
    match: (t) => /broken outbound|broken (external )?link/.test(t),
    check: () => unverifiable('outbound target not isolated in the report example — fetch the link, not the page'),
  },
  {
    kind: 'vitals',
    noFetch: true,
    match: (t) => /\bcls\b|\btbt\b|\binp\b|layout shift|blocking time/.test(t),
    check: () => unverifiable('CLS/TBT/INP need Web-Vitals instrumentation not captured by the light live load'),
  },
  {
    kind: 'coverage',
    noFetch: true,
    match: (t) => /unused (css|code)/.test(t),
    check: () => unverifiable('unused CSS/code needs CDP coverage instrumentation'),
  },
  {
    kind: 'contrast',
    noFetch: true,
    match: (t) => /contrast/.test(t),
    check: () => unverifiable('color contrast needs an axe-core pass'),
  },
  {
    kind: 'consent',
    noFetch: true,
    match: (t) => /consent|tracking cookie/.test(t),
    check: () => unverifiable('pre-consent tracking needs the two-pass consent capture'),
  },
];

/* --------------------------------------------------------------- orchestrator */

export interface LiveVerifyOptions {
  timeoutMs?: number;
  verbose?: boolean;
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

  // Resolve the checker for each finding up-front so we only fetch URLs that
  // actually have a live checker (site-level kinds need no fetch).
  const plan = findings.map((f) => {
    const t = f.title.toLowerCase();
    const checker = CHECKERS.find((c) => c.match(t));
    return { f, checker };
  });

  const urlsToFetch = new Set<string>();
  for (const { f, checker } of plan) {
    if (!checker || checker.noFetch) continue; // noFetch checkers read no live signals
    if (f.exampleUrl) urlsToFetch.add(f.exampleUrl);
  }

  const cache = new Map<string, LiveSignals | null>();
  if (urlsToFetch.size > 0) {
    const browser = await chromium.launch();
    try {
      let n = 0;
      for (const url of urlsToFetch) {
        n++;
        if (opts.verbose) console.log(`  … live-fetching (${n}/${urlsToFetch.size}) ${url}`);
        cache.set(url, await captureOne(browser, url, timeoutMs));
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
    if (checker.noFetch) {
      const r = checker.check({} as LiveSignals, f);
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
  const f: ReportFinding = { title, severity: 'HIGH', count };
  if (checker.noFetch) return checker.check({} as LiveSignals, f);
  return guardPluralRefute(checker.check(signals, f), f);
}
