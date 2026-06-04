# Visual Evidence Matrix — issue → targeted visual proof

**Problem.** Today every finding embeds the same context-free, full-page mobile/desktop screenshot pair of its first sampled example (`buildScreenshotBlock`, `lib/phase2/phase2-runner.ts:1248`). The screenshot proves the page exists, not the issue. This document audits every signal the tool emits and maps each to the *best possible* visual evidence, with feasibility against the current pipeline.

## Where evidence can be captured

The live Playwright `Page` exists only during the crawl: analyzers run on it, then `captureRepresentativeEvidence` (`lib/crawler/page-data-builder.ts:1165`) takes the screenshots, then the context closes. Phase 2 is read-only (persisted JSON + the evidence dir). So every targeted capture must happen at crawl time — **or** be a pure *render* over already-persisted data (rects drawn as positioned `<div>`s over the existing screenshot in `pdf-renderer.ts` HTML — no image processing library needed).

## Technique legend

| ID | Technique | How |
|----|-----------|-----|
| **T1** | Element highlight | Screenshot (full or clipped to element + padding) with red outline / callout on the offending element(s). Either inject overlay CSS pre-screenshot, or persist `{selector, rect}` and draw positioned divs over the existing screenshot at render time. |
| **T2** | Before/after pair | Two screenshots of the same page at two moments (first paint vs post-shift; pre vs post interaction). |
| **T3** | Filmstrip | 4–6 frames during load (CDP `Page.startScreencast` or timed `page.screenshot()`), key element highlighted in the frame where it appears. |
| **T4** | Fold-line / viewport clip | First-viewport screenshot, or full-page shot with a labelled fold line and highlights above/below it. |
| **T5** | Side-by-side comparison | Two different pages' screenshots or snippet cards next to each other (duplicates, JS-off vs hydrated). |
| **T6** | Rendered data panel | Not a page screenshot: a diagram generated from persisted data — waterfall, treemap by origin, coverage bars, link-graph excerpt, redirect chain, heading outline. Rendered as HTML/SVG in the report. |
| **T7** | Snippet card | Styled code/header/robots.txt excerpt with the offending line highlighted. For markup/header issues a screenshot is meaningless — this IS the visual evidence. |
| **T8** | Interaction sequence | Screenshots straddling an interaction (pagination "next" click probe, consent state). |
| **T9** | Multi-element overlay | One screenshot, many color-coded boxes (all contrast failures, all small touch targets, all empty anchors). |
| **SERP** | SERP preview mock | Google-style result card rendered from title/description/URL with truncation/absence visualised. Pure render, no capture. |

## Feasibility legend

- ✅ **render-only** — all data already persisted; only Phase 2 rendering work
- 🟡 **measured-not-persisted** — the analyzer already touches the element/rect live; persist `{selector, rect}` and it becomes render-only
- 🔴 **new capture** — needs new crawl-time instrumentation (extra screenshot, screencast, observer attribution, probe shots)
- ⬜ **non-visual** — a page screenshot can't show it; snippet/diagram (T6/T7/SERP) is the honest evidence

---

## Performance

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| `cls-over-threshold` | First-paint screenshot vs post-shift screenshot; shifted nodes outlined with old→new rect arrows and per-node score | T2 + T1 | 🔴 `vitals-collector.ts:433` discards `LayoutShiftAttribution.sources` (node, previousRect, currentRect) — persist them; add an early screenshot at first-paint/DCL |
| `lcp-over-threshold` | Filmstrip of load; frame where LCP element paints, element outlined, ms badge | T3 + T1 | 🔴 LCP entry's `element` attribution not persisted; screencast not wired |
| `tbt` / `tti` / `inp` | Main-thread timeline strip: long-task blocks labelled by attributed script | T6 | 🟡 `longTasks[].attribution` (name, containerSrc) **is** persisted (`vitals-collector.ts:485-507`) — renderer only |
| `ttfb-over-threshold`, `slow-tls`, `dns-slow` | Navigation-timing waterfall bar (DNS / TLS / TTFB / download segments, threshold marker) | T6 | ✅ nav timing persisted |
| `oversized-images` | Offending `<img>` outlined; callout "intrinsic 3840×2160 → displayed 414×233 (9.3×)" | T1 | 🟡 `image-optimization-analyzer.ts:71-90` measures `getBoundingClientRect()` live but persists only counts |
| `legacy-image-format` | Same highlight; badge "JPEG 840 KB — AVIF would be ~210 KB" | T1 | 🟡 same gap |
| `excessive-image-size` | Top-N heaviest images outlined + size chips, or image-weight treemap | T9 / T6 | 🟡 per-image bytes in requests.json (sampled pages); selectors not persisted |
| `srcset` over-fetch / under-resolution / missing `sizes` | Image outlined + chip "picked 2048w for a 414px slot" | T1 | 🟡 candidates measured live, not persisted |
| `above-fold-image-size` | Viewport clip with above-fold images outlined + byte chips | T4 + T9 | 🟡 `above-fold-analyzer.ts` already does viewport intersection |
| `render-blocking`, `render-blocking-third-party` | `<head>` snippet with blocking tags highlighted **+** waterfall showing the blocked first-paint window | T7 + T6 | ✅ resources persisted in `resourceOptimization` |
| `unused-code` / `unused-css` | Per-file coverage bars (used vs unused bytes), critical-CSS hint | T6 | ✅ `codeCoverage` persisted |
| `too-many-requests` / `page-too-big` | Request treemap by type/origin; total vs threshold | T6 | ✅ requests.json (sampled pages) |
| `third-party-payload` / `-origins` / `-requests`, `heavy-ads` | Treemap/pie by registrable origin; ad hosts flagged | T6 | ✅ requests.json + `thirdPartyData` |
| `excessive-dom` / `dom-children` | Hotspot subtree outlined on screenshot + "1 482 children" callout; node-count bar | T1 + T6 | 🟡 `dom-complexity-analyzer` finds the max-children element live; selector not persisted |
| `too-many-fonts`, font-loading issues | Font table (family / format / bytes / display) ; FOUT before/after pair where detectable | T6 (+T2) | ✅ `fontData` persisted; FOUT pair would be 🔴 |
| caching / compression / HTTP-protocol issues | Response-headers card with missing/weak directives highlighted | T7 | ⬜ non-visual by nature |
| `resource-hints-missing` | `<head>` snippet + "origins that would benefit" list from requests.json | T7 + T6 | ✅ |
| `redirect` / `redirect-loop` | Chain diagram: `URL → 301 → URL → 302 → …` with hop latencies | T6 | 🔴 storage strips `redirectChain` (only `redirectCount` survives) — persist the chain |
| `large-html` / `html-exceeds-3mb` | Size bar vs threshold; biggest inline blobs listed | T6 | ✅ |
| PWA / manifest family | Manifest snippet with missing/invalid fields highlighted; icon preview grid | T7 | ⬜ |

## SEO — on-page

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| missing / short / long **title** & **description** | SERP preview mock with truncation ellipsis or "Google will generate one" placeholder | SERP | ✅ pure render |
| `duplicate-title` / `duplicate-description` | Two SERP previews side by side, identical text highlighted | T5 + SERP | ✅ |
| `multiple-h1` / `missing-h1` | All H1s outlined on screenshot; heading-outline tree beside it | T1 + T6 | 🟡 `headings` persisted as counts; selectors trivially capturable |
| `heading-structure-broken`, `too-many-h2` | Heading outline tree with the skip (H1→H3) marked red | T6 | 🟡 levels persisted, sequence partially |
| `missing-canonical`, `canonical-mismatch`, `noindex`, meta-robots issues | `<head>` snippet card, offending/missing line highlighted | T7 | ⬜ |
| `soft-404` | The page screenshot **is** the evidence — pair it with the `HTTP 200` status badge ("looks like an error page, returns 200") | T4 | ✅ already captured; just add the badge framing |
| `thin-content` / `expand-content` | Full-page shot with main-content region tinted + word-count callout vs threshold | T1 | 🟡 content region detectable live |
| `empty-anchor`, `generic-anchor-text` | Offending links outlined with their (missing) text shown | T9 | 🟡 `anchorTextData` persists counts/samples, not selectors |
| broken internal / outbound links | Link outlined + status chip (404/timeout); optionally click-through screenshot of the 404 | T1 (+T8) | 🔴 target pages not screenshotted today |
| `links-to-redirects`, `internal-links-http` | Snippet of hrefs + chain/protocol chips | T7 | ✅ |
| schema family (missing/invalid/incomplete, all types) | JSON-LD snippet with missing property marked; rich-result preview mock where applicable (FAQ, Product, Breadcrumb) | T7 + SERP | ⬜ render-only |
| `content-stale`, `copyright-year-outdated` | Footer/byline **crop** with the stale year circled | T1 | 🟡 element findable live |
| `author-missing`, low E-E-A-T | Byline-area crop (or top-of-article crop annotated "no author/byline found") | T1 | 🟡 |
| JS-rendered title/H1/content/links (`javascript-rendering-analyzer`) | Side-by-side: JS-disabled render vs hydrated screenshot — what crawlers without JS see | T5 | 🔴 needs one extra JS-off load per sampled page (or render raw served HTML offline) |
| `intrusive-interstitial` | Viewport shot with overlay outlined + "%.0f%% of viewport covered" | T4 + T1 | 🟡 selector + coverage already in detail string (`interstitial-analyzer.ts:111`) — structure it |
| `ad-density-high` | All ad containers outlined, ad-vs-content ratio bar | T9 + T6 | 🟡 selectors in detail strings (`ad-density-analyzer.ts:102`) |
| no CTA / `conversion-below-fold` | Full-page shot with fold line; first CTA outlined below it ("first CTA at 2.4 viewports") | T4 + T1 | 🟡 `cta-detector-analyzer` measures positions live |
| `language-mismatch`, content-language header | Snippet: `html[lang="en"]` vs detected-language sample sentence | T7 | ⬜ |
| hreflang family | Reciprocity matrix (page × locale, ✓/✗ cells); alternate-link snippet | T6 + T7 | ⬜ |
| URL architecture (long/deep/params/session-id) | URL anatomy card with the offending segment highlighted | T7 | ⬜ |
| `missing-doctype`, `missing-html-lang`, deprecated elements, shadow-DOM content | Markup snippet card | T7 | ⬜ |
| AEO / llms.txt family | llms.txt snippet (or 404 response card); robots.txt AI-bot rules highlighted | T7 | ⬜ |

## SEO — site-wide / cross-page

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| `broken-pagination` (incl. JS probe) | Sequence: page 2 (real content) vs page 47 (empty/duplicate) side by side, "next" control outlined and still enabled | T8 + T5 | 🔴 **high value** — `pagination-analyzer.ts` probe already clicks "next" on a live page; just screenshot each probe step |
| `keyword-cannibalisation` | The 2–3 competing pages' SERP previews stacked, shared keyword highlighted | T5 + SERP | ✅ titles/H1s persisted |
| near-duplicate content / `duplicate-content` | Side-by-side screenshots + similarity % bar; matching paragraph excerpts highlighted | T5 | 🟡 screenshots exist only if both pages sampled |
| `orphan-page`, `unreachable`, `click-depth-high`, `low-link-equity`, PageRank | Link-graph excerpt: homepage → … → page, BFS path drawn (or absence of inbound edges) | T6 | ✅ `incoming-links.json.gz` persisted |
| `not-in-sitemap`, sitemap 4xx/3xx, trailing-slash pairs, sitemap abuse | Sitemap-vs-crawl Venn / diff table; offending `<url>` entries snippet | T6 + T7 | ✅ |
| robots family (sensitive paths, wildcards, AI-block, conflicts) | robots.txt snippet, offending rule highlighted, affected-URL count chip | T7 | ✅ |
| `crawl-budget-waste` | Stacked bar: crawled URLs by outcome (ok / redirect / 404 / duplicate / pagination tail) | T6 | ✅ |
| content gaps / topic coverage / segments | Topic-cluster bubble map with thin clusters flagged | T6 | ✅ data exists; rendering only |
| analytics inconsistency, social-profile absence | Coverage matrix (page × tag, ✓/✗) | T6 | ✅ |

## Accessibility

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| `contrast-aa` / `contrast-aaa` | Crops of failing text, each with fg/bg swatches + "2.7:1 < 4.5:1" chip | T1/T9 | 🟡 **cheapest win** — axe.json already persists `nodes[].target` CSS selectors; only rects missing (capturable in the same axe pass) |
| form label / autocomplete / fieldset / submit issues | Offending inputs outlined + expected-attribute callout | T1 | 🟡 axe + `formData` identify nodes live |
| `form-submit-insecure` | Form outlined + action-URL chip (http://) | T1 + T7 | 🟡 |
| `missing-main-landmark`, ARIA-live issues | Landmark overlay (header/nav/main/footer regions tinted; missing `main` shown as gap) | T9 | 🔴 region rects need capture |
| `touch-target-small` | All sub-44px targets boxed with px sizes | T9 | 🟡 `mobile-friendly-analyzer` measures rects live |
| missing alt text | Each alt-less image outlined + "alt=∅" chip | T9 | 🟡 |
| `viewport-missing` | The existing mobile screenshot already shows the zoomed-out desktop layout — frame it as "rendered on 414px without viewport meta" | T4 | ✅ |
| `no-prefers-reduced-motion` | Stylesheet snippet (no media query present) | T7 | ⬜ |
| video captions/poster/title | Video element outlined + missing `<track>`/`poster` snippet | T1 + T7 | 🟡 |

## Security & Privacy

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| missing security headers (CSP/HSTS/XFO/nosniff/Permissions-Policy/COOP-COEP), weak CSP | Response-headers card: present ✓ / missing ✗ rows | T7 | ⬜ |
| `sri-missing` | Script-tag snippet, missing `integrity` highlighted | T7 | ⬜ |
| SSL-certificate family | Certificate card (issuer, expiry countdown, CN vs host) | T7 | ⬜ |
| mixed content (active/passive) | Insecure resource outlined on page + http:// URL chip; browser-style "Not secure" framing | T1 + T7 | 🟡 resource URLs persisted; element mapping needs capture |
| `tracking-before-consent` | Pre-interaction screenshot (consent banner visible, un-clicked) **paired with** "cookies already set" table | T4 + T6 | 🟡 `consentData` cookies persisted; banner screenshot = the existing mobile shot, needs the pairing frame |
| third-party cookies / excessive lifespan | Cookie table: name / domain / lifespan, offenders highlighted | T6 | ✅ |
| info disclosure (server header, source maps, comments) | Header/comment snippet, leaked value highlighted | T7 | ⬜ |
| `open-redirect-potential` | URL anatomy card, redirect param highlighted | T7 | ⬜ |

## Technical / Repo / Analytics

| Issue | Best visual evidence | Technique | Feasibility / gap |
|---|---|---|---|
| console / recurring JS errors | Console excerpt card (message, source, count across pages) | T7 | ✅ persisted |
| framework-config findings (`repo/` family: Next/Nuxt/Gatsby/Astro, package issues) | Config-file snippet with missing/incorrect line highlighted | T7 | ⬜ code-level, no page |
| web-component / shadow-DOM findings | Markup snippet + (where relevant) JS-off vs hydrated side-by-side | T7 + T5 | 🔴 for the pair |
| technology / CMS detection (informational) | Detected-stack badge strip | T6 | ✅ |
| `ipv6-missing`, nameserver issues | DNS record table | T6 | ⬜ |

---

## Cross-cutting gaps (the enablers)

1. **Uniform `visualEvidence` field on findings.** Today selectors live in three inconsistent places: axe.json `target[]`, prose detail strings (interstitial, ad-density), or nowhere (images, touch targets, DOM hotspot, CTAs, empty anchors — all *measured* live, then discarded). Persist `{ selector, rect, label }[]` per finding at analysis time; everything 🟡 above becomes render-only.
2. **Overlay rendering at report time, not capture time.** The PDF is already rendered via Playwright HTML (`pdf-renderer.ts:207`). Persisted rects can be drawn as absolutely-positioned divs over the existing `<img>` — no second screenshot, no image-processing dependency, works retroactively on any sampled page.
3. **CLS attribution + early screenshot** (`vitals-collector.ts:433`): keep `sources[]` (selector, previousRect, currentRect) instead of discarding entries; add one screenshot at first paint to pair with the existing post-load shot. This is the user-visible flagship (before/after with shift arrows).
4. **LCP element + filmstrip**: persist the LCP entry's element selector; optional screencast frames for T3.
5. **Probe screenshots**: the pagination prober and (future) broken-link checks already navigate live pages — `page.screenshot()` at each step is nearly free and produces the most persuasive evidence in the report.
6. **Persist `redirectChain`** (currently stripped by storage) to draw chain diagrams.
7. **Snippet/diagram renderers** (T6/T7/SERP) cover the entire ⬜ class — roughly half of all finding kinds — where a screenshot was never the right evidence at all.

## Suggested rollout order (impact ÷ effort)

| # | Work item | Unlocks | Effort | Status |
|---|-----------|---------|--------|--------|
| 1 | SERP preview + snippet-card renderers (pure Phase 2) | all title/description/canonical/robots/schema/header findings | S | ✅ SERP, head snippet cards (canonical/noindex/hreflang/lang/charset/doctype), schema card (JSON-LD types + snippet), security-headers card |
| 2 | Overlay-div renderer over existing screenshots + overlays.json | the whole 🟡 class | S–M | ✅ |
| 3 | axe selector → rect capture (same pass) | contrast, forms, alt, landmarks | S | ✅ contrast, form-label/autocomplete, landmarks overlay (missing-`<main>`) |
| 4 | Image-optimization rect persistence | all image findings | S | ✅ |
| 5 | CLS sources + first-paint screenshot | the flagship before/after | M | ✅ |
| 6 | Data panels: waterfall, treemap, coverage bars, link-graph, sitemap diff | most ✅ T6 rows | M | ✅ network by type/origin, coverage bars, render-blocking list, link-graph facts (inbound count + sitemap ✓/✗ per cited URL) |
| 7 | Pagination-probe step screenshots | broken-pagination sequence | S | ✅ step-0/1/final saved when probe flags the series |
| 8 | Fold-line + CTA/interstitial overlays | UX findings | S | ✅ |
| 9 | JS-off vs hydrated side-by-side | JS-rendering findings | M | ✅ screenshot.nojs.png (JS-disabled context) paired with hydrated |
| 10 | LCP filmstrip (screencast) | LCP | M–L | ✅ as LCP-element highlight + sub-parts breakdown panel (filmstrip/screencast deemed not worth the runtime cost) |
