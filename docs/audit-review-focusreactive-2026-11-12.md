# Audit report review: focusreactive.com (run 2026-11-12_11-55-06)

Review date: 2026-11-13. Run: `audit-results/focusreactive.com/2026-11-12_11-55-06/`, crawled with `--perf` (slow4g network throttling, CPU not throttled) in Playwright's bundled Chromium.

Every one of the 176 finding types was traced to the code that emits it, checked against 2–3 examples in the run data, and verified on the live site (curl and Playwright, low request volume). The biggest claims were then re-read in the code by hand.

**Verdict:** of roughly 18,000 per-page report entries, an estimated ~14,000 are false positives or noise. Several site-level findings are wrong too, including the only CRITICAL.

Already fixed: 61 false "Failed image or media requests" on working `.mp4` files. Playwright's Chromium has no H.264, so they ended in `NETWORK_NO_SOURCE` (commit `dc09b17`).

## Fix status (2026-11-13)

Fixed: #1–#29 except the items below. A re-run with the same flags (`--perf`, all pages) went from 22,686 to 12,223 report entries; the only CRITICAL now correctly says 0/377 pages have consent, and "Tracking cookies without consent banner" is a single site-wide HIGH. Regression tests: `tests/report-review-fixes.test.ts`.

Not fixed yet:
- Per-page anchor findings still count nav/footer links (over-optimized 112, same text → different pages 357, short anchors 134, duplicate anchor 123). Template links are now excluded from the site-wide anchor stats only.
- Same fact under several titles: orphan / unreachable / no incoming links, "Too many on-page links" vs "Page has too many links".
- "LCP image not preloaded" when the LCP `<img>` already has `fetchpriority="high"` in the served HTML.
- #30 partly: redirect stubs and files no longer count as crawled pages, but some rollups still use their own denominators.
- Not reviewed: findings added after the original run (long-cached assets without cache-busting 376, lazy-loaded content 367, JSON-LD telephone not shown 239).

## 1. Tool bugs, ranked by wrong report entries

| # | Bug | Wrong entries | Where |
|---|---|---|---|
| 1 | LocalBusiness missing openingHours / geo / image / priceRange counted once per office block (3) per page. The fields really are missing: these are 4 site facts | ~4,990 | `lib/analyzers/seo/advanced-schema-validator.ts:48` (helper), `:490-497` (LocalBusiness fields) |
| 2 | Site-level facts emitted on every page: 5 PWA checks, Permissions-Policy, COOP/COEP, SRI, cookie lifespan, multiple analytics, privacy link (reported 3 ways), the contact form's autocomplete and fieldset | ~4,900 | per analyzer, no site-level rollup |
| 3 | "Image larger than display size" runs on SVG icons (`x-logo.svg` alone = 1,634), counts per `<img>` element and ignores pixel density | ~1,800 of 2,587 | `lib/analyzers/performance/image-optimization-analyzer.ts:206` |
| 4 | Link counted as empty despite `aria-label` or img alt. `textContent?.trim() ?? aria-label` never falls back because `trim()` returns `""`; whitespace `innerText` is truthy | ~835 | `lib/analyzers/content/link-quality-analyzer.ts:41`, `lib/crawler/page-data-builder.ts:506` |
| 5 | ARIA live regions: an empty region is reported as a defect (starting empty is the correct pattern); overlapping selectors double count; hidden elements counted | ~650 | `lib/analyzers/accessibility/aria-live-analyzer.ts:45-94` |
| 6 | Bot-blocked links reported as broken: HEAD request, "SEOAuditBot" UA, no GET fallback, any status ≥ 400 counts as broken (403/429/405/999). The same fact is reported per page, site-wide and in the outbound checker. Many 403s are Cloudflare/bot challenges that headless Chromium also gets, so a GET fallback alone won't fix it: report them as "blocked / unverified", not broken | ~560 | `lib/analyzers/content/outbound-link-checker.ts:102,194-197`, `lib/analyzers/seo/external-links-analyzer.ts:316,358` |
| 7 | Contrast measured on hidden 0×0 elements and nested duplicates; rgba backgrounds treated as opaque | ~416 | `lib/analyzers/accessibility/color-contrast-analyzer.ts:58-91` |
| 8 | Render-blocking third-party scripts (HIGH) ignores `type="module"`; the only script flagged is Cloudflare's beacon | 416 HIGH | `lib/analyzers/performance/third-party-analyzer.ts:301` |
| 9 | Unused code (HIGH) measures uncompressed bytes against a 500 KB threshold (3–6× the transfer size); site-wide "118 MB unused CSS" sums one cached file 417 times | 416 HIGH + 284 | `lib/analyzers/performance/code-coverage-analyzer.ts:113-132,238,294` |
| 10 | Redirect sources analysed as separate pages, so 40 pages are counted twice. Causes all "identical titles", 30/31 near-duplicate titles, 9/14 identical descriptions, +23 missing canonicals, non-self canonicals. "Multiple redirects" is off by one (a single 308 shows as "2 redirects") | ~190 | `lib/crawler/page-data-builder.ts:574-587`, `lib/analyzers/performance/redirect-chain-analyzer.ts:74` |
| 11 | TrustArc pattern `'truste'` matches "trusted" in a script comment on every page, so the tool sees a CMP banner on 416 pages that has none. This turns the CRITICAL into the wrong finding, hides the real HIGH "no consent banner", and creates a fake "multiple consent platforms". It drives the "416/425 pages have a banner" CRITICAL (`:468`). A second CRITICAL from `analytics-validator.ts:185` (fires below 80% coverage) says 8/417 pages have consent; those 8 come from loose `/cookie.*consent/i` text matches. The two CRITICALs contradict each other | ~420 + the CRITICAL | `lib/analyzers/security/cookie-consent-analyzer.ts:91,273,468`, `lib/analyzers/analytics/analytics-tracking-analyzer.ts:188`, `lib/analyzers/site-wide/analytics-validator.ts:185` |
| 12 | "Form submits via GET" ignores the JS submit handler that does `fetch` POST | 173 | `lib/analyzers/accessibility/form-accessibility-analyzer.ts:111,255-261` |
| 13 | "Auto-playing carousel" fires on any `.swiper` without checking autoplay | 163 | `lib/analyzers/accessibility/reduced-motion-analyzer.ts:103-115,167-172` |
| 14 | A 64 px backdrop image deliberately blurred with `filter: blur` reported as an upscaled CSS background | 186 | `lib/analyzers/performance/image-optimization-analyzer.ts:93` |
| 15 | Open-redirect check flags LinkedIn and X share intents; the page has two share blocks, so 4 links (2 unique URLs) are counted per element instead of deduped by href | 182 | `lib/analyzers/security/open-redirect-analyzer.ts:59` |
| 16 | "Too many children" fires on article prose and Prism code blocks | 119 | `lib/analyzers/performance/dom-complexity-analyzer.ts:90` |
| 17 | Captions required on muted, silent decorative videos | 108 | `lib/analyzers/seo/media-seo-analyzer.ts:89` |
| 18 | Author detection misses the site's byline (`.article-hero__author-link`), so the report says 0% of pages have an author. YMYL check matches client names in the URL (quanthealth, marketfinance) | ~390 | `lib/utils.ts:983`, `eeat-analyzer.ts:217` |
| 19 | TBT built from long-animation-frame duration, which grows with network throttling. The only `--perf` artefact | 55 | `lib/crawler/vitals-collector.ts:557,578` |
| 20 | "Not listed in sitemap" emitted for every discovered URL, including redirect sources and 404s (9) | 51 | `lib/orchestrators/audit-orchestrator.ts:216` |
| 21 | "Load More without pagination" fires on a "Show More" button whose items are already in the served HTML | 24 | `lib/analyzers/seo/pagination-analyzer.ts:166` |
| 22 | Soft-404 patterns too loose (a bare `/not\s*found/i` matches ordinary page text), reported twice | 14 | `soft-404-analyzer.ts:16,26,308` |
| 23 | Non-HTML files (one PNG in this run; the PDF and MP4 failed to load) and 404 pages analysed as pages: fake DOCTYPE, charset, social tags, sitemap, thin content, click depth findings | ~20 | no content-type filter at link discovery (`page-data-builder.ts` ~579); 404s not skipped by page analyzers |
| 24 | `pageData.resourceHints` never filled, so "425/425 pages lack hints" is false | 1 + 5 | `resource-hints-analyzer.ts:44,265` |
| 25 | "Next.js detected" from code samples in articles, so 8 false noscript findings | 8 | `lib/analyzers/seo/technology-detector.ts:692` |
| 26 | "Large HTML" falls back to total page weight (GIFs included) | 3 | `lib/analyzers/seo/technical-seo-analyzer.ts:373` |
| 27 | Suspicious-link regex tested on the whole URL ("credit" in a framer.com help path), HIGH | 2 | `external-links-analyzer.ts:14,122` |
| 28 | OAI-SearchBot missing from the AI crawler list | 1 | `lib/analyzers/seo/aeo-analyzer.ts:51` |
| 29 | One cookie jar shared across the crawl, so cookies set by earlier pages are blamed on the current page | — | `cookie-consent-analyzer.ts:330` |
| 30 | Page totals use 425 (417 + 8 404s) in some places and 417 (still incl. the PNG) in others | — | site rollups |

Line numbers are as of commit `dc09b17`. All claims were re-verified on 2026-11-13 by three independent fact-check passes (code, run data, live site); corrections from those passes are applied.

## 2. Real issues on focusreactive.com

- **No consent banner at all.** GA4 (`_ga`) and visitor cookies (`fr_vid`, `fr_visitor_id`) are set on first load. No privacy-policy page: `/privacy-policy/`, `/privacy/`, `/cookie-policy/`, `/terms/` and `/legal/` all return 404.
- 152 real pages have no canonical, the homepage among them (the tool says 176–184 because it also counts redirect sources, 404s and the PNG). `/blog/reusable-section-component-headless-cms/` has a broken relative canonical (`href="eusable-section-component-headless-cms"`).
- 41 internal links and sitemap entries go through 308 redirects. 8 internally linked URLs return 404.
- About 20 outbound links are really dead (qatalog, payloadcms/public-nextjs-website, learnwithparam (410), payloadcms.com/pricing, storyblok `/docs/guide/*`, …).
- 14 broken images on 6 pages: expired Notion and CloudFront signed URLs, GitHub attachments, Wikimedia and Payload hotlinks, and 2 `<img src="">`.
- Oversized GIFs: 4.48 MB on `ai-search-implementation`, a 1.3 MB imgur GIF on the CLS article.
- JS `TypeError` (`addEventListener`) in `app.6585bc0d.js` on 8 legacy-template pages, which also lack `<main>`; 2 of them (the Sweden and Norway Next.js pages) also have no h1.
- Raw template token `style={{ paddingLeft: 16 }}` visible as text on `/nextjs-with-linaria-storybook/`.
- Contact form: no `autocomplete` on name, email and phone; checkbox group without a fieldset.
- Autoplay looping videos without pause controls (HIGH is too severe for decorative muted clips); 72 videos without a poster.
- 2 pages with more than one h1; 6 pages with skipped heading levels; 1 post without a meta description; 5 genuinely duplicated description groups; 26 uppercase `/blog/author/CamelCase/` URLs.
- 3 sitemap URLs without a trailing slash (country agency pages). 5 orphan pages (also reported as "unreachable" and "no incoming links").
- No security.txt. No Permissions-Policy header. No web-font preload (168 pages). Excessive DOM size on 185 pages.
- Typo "usefull" on `/storybook-graphql-kit/`. One `<a>` with no text on `/blog/payload-content-agent/`. 4× `<a>Link</a>` on `/the-growing-trend-of-self-hosting-empowering-web-independence/`.

## 3. Per-group detail

Full tables from the five verification passes, with the evidence for every finding type.

## Detail: indexing
I checked 45 report entries in the indexing group. The biggest error is systematic: 41 URLs that redirect were stored and analysed as if they were separate pages. 40 of their target pages were crawled under their own URLs too, so each of those 40 pages is counted twice. This alone produced every "duplicate title" finding, 30 of the 31 near-duplicate title groups, 9 of the 14 identical-description entries, 17 of the 18 "non-self canonical" pages, and inflated most per-page counts. The second error is that non-HTML files (a PNG, plus a PDF and an MP4 that failed) were queued and analysed as pages.

Real page count is 376 unique pages returning 200, not 417. The 417 includes the 41 redirect sources. I checked the live site with curl, low volume and one request at a time. Line numbers are in the current repo; I did not edit anything.

| Finding | Verdict | Evidence | Root cause file:line (non-REAL) |
|---|---|---|---|
| Canonicals are not set (176, HIGH) | PARTLY WRONG | 152 real pages have no canonical; 23 are redirect sources (repeating their target page) and 1 is the PNG. Live sample: 16 of 30 pages have no `<link rel=canonical>` | Redirect sources analysed as pages: crawler frontier is keyed on the requested URL, `page-data-builder.ts:574-587`; check is at `:414` |
| Some loc and canonical don't match (1, HIGH) | REAL (wording misleading) | Live `/blog/reusable-section-component-headless-cms/` has `<link rel="canonical" href="eusable-section-component-headless-cms">`, a broken relative canonical | — |
| Some pages have identical titles (9, HIGH) | FALSE POSITIVE (9/9) | Every pair is two redirect sources that end at the same final URL (e.g. `/blog/category/sanity/` and `/blog/category/headless-cms/` both go to `/headless-cms-deep-dive/`). Excluding redirect sources, no titles are duplicated | `page-data-builder.ts:140-150` with redirect sources stored as pages |
| Duplicate titles detected, "40 pages share titles" | FALSE POSITIVE | Same cause; 0 duplicates once redirect sources are excluded | `crawl-budget-analyzer.ts:~95-122` (no `hasRedirects` skip) |
| Near-duplicate page titles (31) | FALSE POSITIVE (30/31) | Every group contains a redirect source; only 1 group (`services/headless-cms-nextjs`, `next-js-expert-agency`, `about`) survives without them | `keyword-cannibalisation-analyzer.ts:340` (filter skips status only, not `hasRedirects`) |
| Some pages have identical descriptions (14, HIGH) | PARTLY WRONG (9 FP / 5 real) | 9 pairs are redirect artefacts; 5 real pairs (e.g. `nextjs-audit` and `nextjs-performance-audit`). Also restates the next finding | `page-data-builder.ts:~235-245` |
| Duplicate meta descriptions found (5) | REAL | Same 5 groups confirmed after removing redirect sources | — |
| Many pages with non-self-referencing canonicals (18), and Many pages canonicalized to other URLs (18) | FALSE POSITIVE (17/18, reported twice) | 17 are redirect sources whose canonical correctly points at the final URL; 1 is the broken canonical above | `indexability-validator.ts:~175`; `crawl-budget-analyzer.ts:105` |
| Multiple redirects detected (40, MEDIUM) | FALSE POSITIVE (37/40) | Recorded redirect chains: 37 have length 2 (1 hop) and 3 have length 3 (2 hops). The analyzer counts the final 200 response as a redirect ("2 redirects" for a single 308; live curl confirms 1 hop). Also repeats "Requested URLs redirect" (40 URLs overlap) | `redirect-chain-analyzer.ts:74-84` uses `redirectChain.length`, should be `length-1` (`page-data-builder.ts:452` does this correctly) |
| Requested URLs redirect before serving the page (41) | REAL | Live: internal links and the sitemap point at 308 URLs | — |
| Some URLs are not listed in sitemap (51) | FALSE POSITIVE (50/51) | 40 are 308 redirect sources, 8 return 404, 1 is the PNG, 2 were never crawled. Emitted for every discovered URL before the second crawl, whatever its status | `audit-orchestrator.ts:216-222` |
| Indexable pages missing from sitemap (1, HIGH) | FALSE POSITIVE | The only page is `/media/posts/f15a49afe586-image.png` (live: `content-type: image/png`) | `page-data-builder.ts:579` (no non-HTML filter on discovered links) |
| Pages missing social media tags (1, HIGH) | FALSE POSITIVE | Same PNG | same |
| Missing DOCTYPE (1) and Missing charset (1) | FALSE POSITIVE | Same PNG | same |
| Page is more than 4 clicks from homepage (1) | FALSE POSITIVE | Same PNG | same |
| Description meta tag is missing (2) | PARTLY WRONG (1 FP) | The vector-search blog post really has no description (live); the other is the PNG | same |
| Page has very thin content (9, "0 words") | FALSE POSITIVE (9/9) | 8 are 404 pages (live: `/sitecore-contentful-migration/` returns 404) and 1 is the PNG. Also says "recommended ≥300" while testing a different threshold | `thin-content-analyzer.ts:156-160` (no status/content-type filter) |
| Error pages wasting crawl budget (8 4xx) | REAL | 8 internally linked URLs return 404 live | — |
| Sitemap URLs were not successfully crawled (1) | NOISE (crawl artefact) | `/enhancing-content-creation-...-next-js/` is 200, 84 KB, 0.15 s live; it failed during the throttled run. `failedPages.json` also lists the PDF and MP4 that were tried as pages | crawl failure; non-HTML queueing `page-data-builder.ts:579` |
| Potential soft 404 detected (7) and Potential soft 404 page needs review (7) | FALSE POSITIVE (7/7, reported twice) | Every page is a full article returning 200. Matches come from code samples and prose: `throw new Error('Customer not found')`, "nothing here needs back-porting", "Page Not Found responses"; 3 pages have no match in the served HTML at all. One 30% signal is enough to emit | `soft-404-analyzer.ts:16` (`/not\s*found/i`), `:26` (`nothing\s*here`); double emit at `:308` |
| Orphan page (5), Page unreachable from homepage (6), Some pages have no incoming links (5) | REAL, but the same pages appear 3 times | No crawled page links to them; also checked the home, `/services/` and `/solutions/` live | triple reporting (orphan, unreachable, incoming-link validators) |
| Titles too long (131) / too short (49) | PARTLY WRONG | Counts match the data, but 11 long and 6 short are redirect sources counted twice. Short titles are mostly author, category and glossary pages | redirect sources as pages |
| Descriptions too long (162) / too short (41) | PARTLY WRONG | 16 long and 11 short are redirect sources counted twice; the rest are accurate (e.g. Sweden: 78 chars live) | same |
| More than one h1 (2) | REAL | Live: 2 `<h1>` on each | — |
| Preceding h1 missing (4) | REAL | Live on `/contact/` and `/ideal-cms-comparison-table/`: only h2 tags | — |
| Preceding h3 missing (2) | REAL | Live on `glossary/.../rendering/`: h2 then h4 | — |
| URL contains uppercase (26) | REAL | All are `/blog/author/CamelCase/`; the lowercase version returns 404 live | — |
| URL is too long (6) and Some URLs are too long (1) | PARTLY WRONG | The per-page check measures the path only (102) but says "URL"; the site-wide check measures the full URL (127). Same 6 URLs reported twice | `utils.ts:281-286` against `url-architecture-analyzer.ts:183` |
| Inconsistent trailing slash (1) | REAL (count slightly off) | 3 sitemap entries (`headless-cms-development-agency-europe`, `-australia`, `-united-states`) have no slash and return 200 live. The other 2 of the "5" are the PNG and a 404 | — |
| Multiple pages target the same keyword in titles (115) | NOISE | Redirect sources are excluded correctly, but overlapping n-grams ("headless cms development", "cms development agency") each count separately across intentional country landing pages | `keyword-cannibalisation-analyzer.ts:75-98` (subsumption only when page sets match) |
| Same keyword in H1 (32) | NOISE | "case study" on 29 case studies; "client projects" on portfolio filter pages | same |
| Many pages on topic: services, solutions, portfolio, blog, glossary (5) | NOISE | "Topic" is just the first URL folder | `keyword-cannibalisation-analyzer.ts:280-291` |
| Many topics with thin coverage (169) / High-opportunity content gaps | FALSE POSITIVE / NOISE | Topics are single words from each page's top keywords; the "top opportunities" include author surnames (kostareva, bashchuk, hodasevich, hramovich) | `content-gap-analyzer.ts:96-115` |
| Pages have very similar content (10) | REAL | No redirect sources involved; templated pages (e.g. UK and US agency pages; migrate-from-X-to-storyblok) | — |
| Page has low content (3) / Page content could be expanded (17) | NOISE | `/contact/`, glossary stubs, audit landing pages; overlapping bands | — |
| Author attribution 0% (eeat 0.0%; aeo 0/417) | FALSE POSITIVE | Live blog posts show a visible byline `<a class="article-hero__author-link" href="/blog/author/...">`. The selectors miss it: no `href*="/author/"` match, and no Article schema to read | `utils.ts:~985-997` (`detectAuthorInfo` selectors) |
| Unrendered template tokens (1, HIGH) | REAL | Live `/nextjs-with-linaria-storybook/` shows raw `<img ... style={{ paddingLeft: 16 }} />` as visible text in a `<p>` | — |
| Spelling "usefull" (1) | REAL | Present in live HTML of `/storybook-graphql-kit/` | — |

**Top bugs by number of wrong report entries**

1. **Redirect sources are crawled and analysed as separate pages, so 40 pages are counted twice** (`page-data-builder.ts:574-587`, frontier keyed on requested URL; several analyzers lack a `hasRedirects` skip). About 140 wrong entries: missing canonical +23, identical titles 9, "40 share titles" 1, near-duplicate titles 30, identical descriptions 9, non-self canonical 2, title/description length +44, plus the 50 "not in sitemap" entries that overlap with bug 2.
2. **"Not listed in sitemap" is emitted before the crawl for every discovered URL** (`audit-orchestrator.ts:216-222`). 50 wrong entries: redirect sources, 404s and the PNG.
3. **Redirect chain off-by-one** (`redirect-chain-analyzer.ts:74-84`). 37 wrong "Multiple redirects", and it repeats an existing finding.
4. **Non-HTML files (PNG, PDF, MP4) are queued as pages** (`page-data-builder.ts:579`). About 9 wrong entries: indexable-not-in-sitemap, social tags, DOCTYPE, charset, missing description, click depth, thin content, trailing slash, and (outside this group) third-party cookie and no `<article>`.
5. **Soft-404 patterns are too loose and reported twice** (`soft-404-analyzer.ts:16,26,308`). 14 wrong entries.
6. **Thin content ignores status and content type** (`thin-content-analyzer.ts:156`). 9 wrong entries, all 404s or the PNG.
7. **Author detection misses the site's byline** (`utils.ts:~985`). 2 site-wide findings wrongly say 0% of pages have an author.
8. **Content gaps and topics are built from single words and URL folders** (`content-gap-analyzer.ts:96`, `keyword-cannibalisation-analyzer.ts:280`). 7 noise entries.


## Detail: links
I checked every link finding type against the run data, the code and the live site. Of 24 types, 4 are real or partly real: the dead links inside the "broken outbound link" reports, the one generic-anchor page, the one empty link, and "same anchor text links to different pages". The other 20 are false positives, double counts or not worth acting on.

| Finding | Verdict | Evidence | Root cause (non-REAL) |
|---|---|---|---|
| Page has N broken outbound link(s) (320+57+8+5+2+2+1+1 = 396 entries) | MOSTLY FALSE POSITIVE | Status codes recorded: 403×443, 429×36, 405×11, 999×3, 419×2, 500×2, 404×23, 410×1. 373 of the 396 page entries contain no 404/410 at all. clutch.co/profile/focusreactive is on 414 pages; it returns 403 to curl and to headless Chromium (Cloudflare challenge) but opens normally in an interactive browser ("FocusReactive Reviews (30)…"). linkedin.com/company, contentful.com/pricing, realthread.com, openai.com/chatgpt, gartner and medium all return 200 in a browser but 403/429 to the tool. npmjs and g2 show a Cloudflare challenge ("Just a moment…"), so the pages exist. news.ycombinator and salesforce answer 405/500 to HEAD and 200 to GET. support.google.com/…7645831 and …10000067 answer 404 to HEAD and 200 to GET. Really dead: qatalog, github payloadcms/public-nextjs-website, UsulPro/contentful-post-demo-app, learnwithparam (410), payloadcms.com/pricing, storyblok /docs/guide/*, calendly ?month=2023-05, storybook-addon-console (about 20 URLs) | lib/analyzers/content/outbound-link-checker.ts:102 counts any status ≥400 as broken, using a HEAD request (:186) with a bot UA "SEOAuditBot/1.0" and no GET fallback. Each page checks only its first 20 links (:72), and URL fragments are not removed, so `#anchor` variants count as separate links |
| Broken external link (174) | FALSE POSITIVE (almost all) | All 100 entries kept in analysis.json are HTTP 403 (clutch, linkedin company page, share-offsite). /profile/focusreactive appears twice (plain URL and a utm-tagged variant). This repeats the per-page finding above | lib/analyzers/seo/external-links-analyzer.ts:316-326 sends HEAD with the bot UA and :358 counts ≥400 as broken. The same thing is reported three times: per page, here, and in outbound-link-checker analyzeSiteWide |
| Empty anchor text (416, count=10 per page) | FALSE POSITIVE | Live: the logo `<a href="/" aria-label="Focus Reactive">` and 8 social icons, each with aria-label="Twitter/Linkedin/GitHub/YouTube" | lib/analyzers/content/link-quality-analyzer.ts:41: `textContent?.trim() ?? getAttribute('aria-label')`. trim() returns "" and never null, so the aria-label fallback never runs |
| Links with empty anchor text (416) | FALSE POSITIVE | The only example on every page is "/", the logo with aria-label | lib/crawler/page-data-builder.ts:506: `link.innerText \|\| aria-label`. innerText is whitespace (truthy), so aria-label is skipped; anchor-text-analyzer then trims it to "" |
| Many links with empty anchor text (443) | FALSE POSITIVE | 443 ≈ one logo link per page | Same aria-label bug, run on links that were already slimmed (next row) |
| Anchor text over-optimization ("" → / 100% of 416) | FALSE POSITIVE | The flagged anchor is the empty string | lib/orchestrators/progress-manager.ts:717 keeps only links with empty text (`!l.text…`) at checkpoint, so the site-wide anchor analysis only sees empty links. anchor-text-analyzer.ts:303 also does not exclude "" |
| Low anchor text diversity (0% of 443) | FALSE POSITIVE | The site has hundreds of distinct anchors per page (Sweden page: 30+). 443 is the slimmed set, not about 40×417 real internal links | progress-manager.ts:717 slimming, consumed at anchor-text-analyzer.ts:221-266 |
| Potentially over-optimized anchor text (132) | NOISE | Flags "view expertise" CTAs (6×), category chip "headless cms deep dive" (69×) and author names (29×). Template or listing labels, not keyword stuffing | anchor-text-analyzer.ts:131 counts any anchor repeated more than 5× within one page |
| Same anchor text links to different pages (394) | PARTLY WRONG / NOISE | On /about/, "blog" → 20 URLs is each team member's author link (real but deliberate). "view expertise" → 2 URLs are both 308 redirects. Hrefs are not normalized: "/blog" and "https://…/blog/" count as different | anchor-text-analyzer.ts:93 compares raw hrefs |
| Many links have very short anchor text (152) | NOISE | The anchors are the nav/footer template (home, services, country names, phone numbers), the same on every page; "&amp;" is not decoded | anchor-text-analyzer.ts:166 counts template links on every page |
| Generic anchor text (1) | REAL | Live self-hosting page has 4× `<a>Link</a>` (plausible, ghost, nextcloud, uptimekuma) | – |
| Some pages have links without any text (1) | REAL | Live: `<a href="https://ai-sdk.dev/"></a>` on /blog/payload-content-agent/ | – |
| Duplicate anchor text (147) | NOISE | "view expertise" ×6 service-card CTAs | link-quality-analyzer.ts:140 (count > 5, no template awareness) |
| Suspicious external link without nofollow (2, HIGH) | FALSE POSITIVE | The framer.com URL is /help/articles/how-ai-credits-and-agents-pricing-work/: "credit" matched the loan regex. casinoreviews.com is the subject of the site's own case study (client link) | external-links-analyzer.ts:14 and :122: regex tested against the full href, not the domain. HIGH severity |
| Links with potential open redirect parameters (182) | FALSE POSITIVE | All hits are third-party share intents (linkedin share-offsite?url=, x.com/intent/tweet?url=) pointing at the page itself. Each one is also counted twice ("4 links" = 2 unique × 2) | lib/analyzers/security/open-redirect-analyzer.ts:59-70 scans external links and does not dedupe |
| Link equity concentrated to few domains (304) | NOISE | The same footer set (clutch 5, linkedin 3, twitter 2) repeated on every page: a site-level fact shown per page | external-links-analyzer.ts:168-181 |
| High number of followed external links (11) | NOISE | Statistics articles citing sources (e.g. 144 on ai-web-development-statistics). Followed links to citations are normal | external-links-analyzer.ts:161 |
| Most external links pass link equity (1) / Top external destinations (1) | NOISE | Footer social and Clutch badges; the linkedin 1183 figure includes share links. Not actionable | external-links-analyzer.ts analyzeSiteWide |
| Too many on-page links (51) + Page has too many links (51) | REAL but DOUBLE COUNTED | /react-cms/ has 179 `<a>` served (reported 191 rendered). It is the same 51 pages listed under two titles | link-quality-analyzer.ts:213 and lib/analyzers/site-wide/link-structure-analyzer.ts:217 |
| Many hub pages with excessive outbound links (1) | NOISE | 413/417 pages have more than 20 internal links because the header and footer alone exceed 20 | link-structure-analyzer.ts:178 (the 20-link threshold is below any site navigation) |
| Significant internal linking opportunities (1) | NOISE / UNVERIFIED | 370/417 pages flagged by heuristic scoring; nothing concrete to check live | lib/analyzers/site-wide/linking-opportunity-analyzer.ts:343 |
| "Load More" pattern without pagination links (24) | FALSE POSITIVE | Live /portfolio/: 27 case links in the served HTML, 27 after clicking "Show More" (9/9 on /portfolio/next-js/). The button only reveals items that are already server-rendered | lib/analyzers/seo/pagination-analyzer.ts:166 does not compare with the served HTML the way the infinite-scroll check does. The same run's data also shows `nextUrl` picking a "Next.js" link (/next-js-expert-agency/) as the "next" page control |

**Top bugs, ranked by wrong report entries:**

1. **Bot-blocked links reported as broken** (about 560 wrong entries). Outbound and external link checks use HEAD with a "SEOAuditBot" UA and treat 403/429/405/999/5xx as broken, with no GET retry in a real browser. This causes 373 page entries with no real dead link, inflated counts on the remaining 23, most of the 174 site-wide entries, and a third duplicate family. Files: outbound-link-checker.ts:102,186 and external-links-analyzer.ts:316,358.
2. **aria-label ignored when deciding a link is empty** (about 835 entries). The bug is in link-quality-analyzer.ts:41 and page-data-builder.ts:506. It produces "Empty anchor text" (416), "Links with empty anchor text" (416) and the site-wide empty-anchor findings.
3. **Site-wide anchor checks run on slimmed checkpoint links** (3 site-level findings, all false). progress-manager.ts:717 keeps only empty-text links, so "Many links with empty anchor text 443", "over-optimization '' 100%" and "0% diversity" are all wrong.
4. **Template links counted on every page** (about 1,270 noise entries). Nav/footer anchors produce: 132 over-optimized, 394 same anchor/different URL, 152 short anchors, 147 duplicate anchor, 304 equity concentrated, and hub pages.
5. **Open-redirect check on third-party share URLs** (182 entries), plus links counted twice (open-redirect-analyzer.ts:59).
6. **"Show More" flagged without checking served HTML** (24 entries) at pagination-analyzer.ts:166.
7. **The same too-many-links fact reported twice** (51 duplicate entries).
8. **Suspicious-link regex runs on the whole URL** (2 entries, but HIGH severity) at external-links-analyzer.ts:122.


## Detail: perf
I checked 31 finding types in the perf group: 13 are false positives, 7 are partly wrong, 5 are real but not worth acting on, 5 are real and 1 is unverified. Most of the wrong entries come from five bugs. The worst is the "larger than display size" check, which runs on SVG icons: about 1,800 of its 2,587 entries are SVGs. Throttling causes the 55 false TBT findings. It also inflates the coverage byte counts, alongside a bug that measures uncompressed bytes.

| Finding | Verdict | Evidence | Root cause (non-REAL) |
|---|---|---|---|
| Render-blocking third-party scripts (416, HIGH) | FALSE POSITIVE | The only script flagged on every page is `static.cloudflareinsights.com/beacon.min.js`. Live it is `<script type="module">` at the end of `<body>`, and module scripts load deferred by default. No other host is flagged. | `lib/analyzers/performance/third-party-analyzer.ts:301`: `isBlocking = !async && !defer` ignores `type=module` and where the script sits |
| Large amount of unused code (416, HIGH) | PARTLY WRONG | Byte counts are uncompressed. `main.65aeeb21.js` is 356 KB but only 120 KB over the wire; `style.d12297bb.css` is 328 KB vs 55 KB. So "995 KB unused" is about 3x the real cost. The 500 KB threshold is compared against uncompressed bytes, so 416 of 425 pages fire. It is the same site-wide bundles repeated on every page. | `lib/analyzers/performance/code-coverage-analyzer.ts:130-134,213-217` (uses text length, not transfer size), `:294` |
| High percentage of unused CSS (284) | PARTLY WRONG | The percentages are plausible; the KB figures are uncompressed (about 6x the wire size). It is one global stylesheet repeated on every page. | same file `:213-217` |
| High average unused CSS site-wide (1): "118.1 MB of CSS went unused" | PARTLY WRONG | Adds up uncompressed bytes of the same cached file across 417 pages, so the number means nothing. | `code-coverage-analyzer.ts` ~`:375` |
| Some scripts consistently have high unused code (1) | NOISE | `main.js` is 79% unused on 408 pages. That is coverage at load with no interaction. A real template fact, but it is a restatement of the per-page finding. | – |
| TBT > 200 ms (55) | FALSE POSITIVE (artefact of throttling) | Live Sweden page: 0 `longtask` entries and one long-animation-frame (LoAF) entry with blockingDuration 0. Its duration is 503 ms throttled vs nothing without throttling. `react-cms`: LoAF 92 ms unthrottled, 1,282 ms on slow4g. Stored data: one LoAF of 561 ms recorded as TBT 511. The waiting time comes from network throttling, not the CPU. | `lib/crawler/vitals-collector.ts:557,578`: uses LoAF `duration - 50` instead of `longtask` (or LoAF `blockingDuration`), with no FCP→TTI window |
| LCP image not preloaded (49, HIGH) | PARTLY WRONG | 44 pages: LCP is the CSS background `why-us-bg.webp` set in an inline style, which the preload scanner cannot see, so preload helps (REAL). 5 pages (hygraph, best-self-hosted, serverless, the png): LCP is an `<img fetchpriority="high">` already in the served HTML, so preload adds nothing. Also, preloads are never read at all (next row). | `lib/analyzers/performance/resource-hints-analyzer.ts:44,53` |
| LCP images not preloaded across site (1) / Common resources that could be preloaded (1) | PARTLY WRONG | Aggregates of the row above, with the same 5 false entries. They duplicate the per-page finding. | `resource-hints-analyzer.ts:265,316` |
| Most pages lack resource hints: "425/425 pages" (1) | FALSE POSITIVE | `react-cms` and `ai-search-implementation` serve `<link rel="preload" as="font">` live. The run data has them in `pageData.technical.preload`. But `pageData.resourceHints` is never filled anywhere, so every page counts as having no hints. | `resource-hints-analyzer.ts:44,265` reads `pageData.resourceHints` (never set) instead of `technical.preload` |
| Images significantly larger than display size (2,587) | FALSE POSITIVE (mostly) | 1,634 of 2,558 page-level entries are `x-logo.svg` (1200×1227 shown at 18×18, 4 per page). 176 more are `fr-logo-footer.svg`, and further SVG icons show up in the 64×64 and 110×110 rows. There is one entry per `<img>` element, not per page, and duplicates are counted. There is no allowance for pixel density (ratio > 2). Real ones exist, e.g. `Aleksei.jpg` at w=320 shown at 38 px. | `lib/analyzers/performance/image-optimization-analyzer.ts:206` (no `isVectorOrInline` check, pushes per element, ignores pixel density) |
| CSS background images upscaled (332, LOW) | PARTLY WRONG | 186: `span.featured-card__backdrop` is a 64 px image with `filter: blur(24px)`, a deliberate blurred placeholder. 143: the hero `cover` image (1080 px landscape in a 414×896 portrait box) really is about 1.5x upscaled at 1x pixel density (minor, REAL). | `image-optimization-analyzer.ts:93` `classifyBackgroundUpscale` ignores CSS `filter: blur` |
| Images upscaled beyond natural resolution (2) | REAL | 200 px image shown at 372 px on `contentful-part-1` and its redirecting twin (counted twice). | – |
| Image files > 200 KB (10, HIGH) | REAL | 4.48 MB GIF on `ai-search-implementation`; 1.3 MB imgur GIF on the CLS article. | – |
| Excessive total image size (5, HIGH) | REAL | Same GIFs (4,490 KB, 1,554 KB). | – |
| JPG/PNG instead of WebP/AVIF (25) | PARTLY WRONG | Format is guessed from the file extension. `/_vercel/image?...` URLs (which send AVIF/WebP) and SVGs are never counted as modern. So "all images in older formats" fires because of one tiny `toggler.png` (headless-ecommerce-expert-agency). GIFs are reported as "JPG/PNG". | `image-optimization-analyzer.ts:178` (checks extension, not Content-Type) |
| Many images but none lazy-loaded (9) | FALSE POSITIVE | The glossary pages have 6 unique `<img>` in the HTML, all small SVG icons in the header and footer (logo, socials, clutch), duplicated in the DOM to 18. There are no content images. | `image-optimization-analyzer.ts:332` (counts SVG and chrome icons) |
| Too many requests (424) | NOISE | Counts are accurate (live `react-cms`: 33 unique vs 31 stored). It fires on 424 of 425 pages, the limit of 20 is arbitrary under HTTP/2, and about 12 of the requests are analytics (GA, Clarity, gaug.es, ahrefs, CF RUM beacons). | `lib/crawler/crawler-engine.ts:1428` |
| Large third-party payload (9) | REAL | The bytes are hotlinked content images (imgur GIFs at 1.5 MB, payloadcms.com `_next/image`), not third-party scripts. | – |
| Large HTML document (3) | FALSE POSITIVE | Live HTML: `ai-search-implementation` 122 KB (report says 4.5 MB), CLS article 80 KB (1.5 MB). `htmlSize` is never set, so the check falls back to `totalResponseSize` (whole page weight, GIFs included). | `lib/analyzers/seo/technical-seo-analyzer.ts:373` |
| Excessive DOM size (185) | REAL | Live `/blog/category/vercel/`: 1,724 elements (reported 1,706). | – |
| Element with too many children (119) | FALSE POSITIVE (mostly) | 96 are the article prose container `div.markdown.article-body_redesign`, where flat p/h2 siblings are normal. 13 are `code.language-*` blocks where Prism's syntax highlighting adds a span per token. Only the 7 `article-listing__grid` cases are plausible. "Virtualization" advice is wrong for an article. | `lib/analyzers/performance/dom-complexity-analyzer.ts:90,186` |
| Low text-to-HTML ratio (159) | NOISE | Live Switzerland page: 8,766 / 95,403 = 9.2%, so the number is correct. Not a ranking factor, and inline SVG and templates drive it. | – |
| Web fonts not preloaded (168) | REAL | Live Sweden page has no `<link rel=preload as=font>`; blog pages do. A template gap. | – |
| No resource preloading on large page (3) | REAL | Sweden page live: no preload at all. | – |
| No noscript fallback (8) | FALSE POSITIVE | Fires only when a framework is detected. `jsFramework = "Next.js"` comes from article text: code samples such as `'/((?!api\|_next/static...'` on `what-is-vercel` and `nextjs-caching-isr-ppr`. The site has no `_next` or `__NEXT_DATA__`. (`cms: "Webflow"` is matched just as loosely: `/webflow/i` anywhere in the HTML.) | `lib/analyzers/seo/technology-detector.ts:692-695` (regex over full HTML incl. `<code>`), used at `technical-seo-analyzer.ts:62,125` |
| Critical JS errors (8, HIGH) | REAL | Reproduced live on `composable-commerce-agency` and `migration-from-sitecore-to-directus`: `TypeError ... addEventListener` at `app.6585bc0d.js:14`. | – |
| JavaScript console errors (5) | PARTLY WRONG | `ab-testing...` reproduced: hotlinked `payloadcms.com/_next/image` returns 400 (REAL). `headless-cms-page-builder` and `MaksimBashchuk` did not reproduce (probably transient). The message leaves out the failing URL, and the stored data keeps only counts. | `consoleAnalysis` keeps no URL |
| Many console warnings (72) | NOISE | Live `migrate-to-wordpress`: 12 copies of the same "SplitText called before fonts loaded" (GSAP), which depends on timing and gets worse under throttling. | – |
| Pages "size is too big" / third-party request count | not emitted | – | – |
| Broken images / Failed media (6/108), SRI (416) | out of group (visual / security), not checked | – | – |

Top bugs, ranked by how many report entries they wrongly produce:

1. **"Larger than display size" counts SVGs, once per element, with no pixel-density allowance.** About 1,800+ of 2,587 entries (`image-optimization-analyzer.ts:206`).
2. **Render-blocking check ignores `type="module"`.** 416 entries plus the site-wide twin (`third-party-analyzer.ts:301`).
3. **Coverage measures uncompressed bytes against a 500 KB threshold.** 416 HIGH plus 284 entries with inflated KB figures, and the "118 MB" site-wide figure (`code-coverage-analyzer.ts:130-134,213-217,294`).
4. **CSS backdrop blur placeholder treated as an upscaled image.** 186 entries (`image-optimization-analyzer.ts:93`).
5. **"Too many children" fires on article prose and syntax-highlighted code blocks.** About 109 entries (`dom-complexity-analyzer.ts:90,186`).
6. **TBT is built from LoAF duration, which grows with network throttling.** 55 entries (`vitals-collector.ts:557,578`).
7. **`pageData.resourceHints` is never filled, so no preload is ever seen.** The "425/425 lack hints" finding and 5 LCP-preload entries; it also hides any real preloads (`resource-hints-analyzer.ts:44,265`).
8. **Image format guessed from the extension.** Up to 25 entries (`image-optimization-analyzer.ts:178`).
9. **Lazy-load check counts SVG icons.** 9 entries (`image-optimization-analyzer.ts:332`).
10. **Framework detection matches code samples in articles.** 8 noscript entries (`technology-detector.ts:692`).
11. **`htmlSize` falls back to total page weight.** 3 entries (`technical-seo-analyzer.ts:373`).


## Detail: a11y-ux
### Findings

The a11y-ux group has five findings that are wrong on nearly every page. Checked against the live site with Playwright (414px viewport) on 2026-11-13.

| Finding | Verdict | Evidence | Root cause (non-REAL) |
|---|---|---|---|
| Empty anchor text (416) / Links with empty anchor text (416) / Many links with empty anchor text (443) / Anchor over-optimization `""` → `/` | FALSE POSITIVE | Live: the "empty" links are the header logo (`aria-label="Focus Reactive"` plus `<img alt="Focus Reactive logo">`), the social icons (each has `aria-label`), the share links and "Back to top" (`aria-label`), and the Clutch link (img alt). Run data stores `text:"\n      \n    "` for `/`, which is about 10 false hits per page. | `lib/crawler/page-data-builder.ts:506`: `link.innerText \|\| aria-label`. Whitespace-only innerText is truthy, so aria-label is never used and img alt is never considered. Downstream: `link-quality-analyzer.ts:87`, `anchor-text-analyzer.ts:65` |
| Color contrast fails WCAG AA (416) | FALSE POSITIVE (almost all) | The worst case "Contact Us" rgb(0,0,0) on rgb(0,0,0) is a 0x0 hidden desktop button. The "on black" TOC `li` items are hidden on mobile (rect 0x0). Recomputed live with a visibility filter: nextjs-caching-isr-ppr 30 → 0, best-sanity-and-storyblok-alternatives 22 → 1. Only legacy-template next-js-expert-agency-sweden still has about 15 real ones (green #0AC526 on white, 2.33). One string is counted 4 times (li, a, span, span). | `lib/analyzers/accessibility/color-contrast-analyzer.ts:58-79`: no visibility or size check, and every nested element is counted. `:88-91`: rgba alpha is treated as opaque (nav `rgba(0,0,0,.5)`), background-image is ignored, and a missing background defaults to white. |
| Form submits to itself via GET (173) | FALSE POSITIVE | It is one site-wide contact form (`#mail-us-form`, inside a `<section>`). `main.65aeeb21.js` has `i.onsubmit=async o=>{o.preventDefault()...}` and `fetch("/api/contact/",{method:"POST"})`. Nothing goes into the URL. | `form-accessibility-analyzer.ts:111` (`selfPostGetDataForm`): ignores JS submit handlers |
| Form inputs missing autocomplete (173) | REAL (same single form, repeated per page) | name, email and phone have no `autocomplete`. One fix covers all 173 pages. | Site-level fact repeated per page |
| Radio/checkbox group without fieldset (171) | REAL (same form, repeated) | 8 `visitor-subject` checkboxes, 0 fieldsets. Each checkbox has an `aria-label`, so impact is low. | Repeated per page |
| Empty ARIA live regions (408) | FALSE POSITIVE | The empty regions are `#draggable-live-region` (the @shopify/draggable announcer in main.js, on every page), the share-status `span role=status aria-live=polite`, and Swiper's `.swiper-notification`. A region that starts empty is the correct pattern. Elements that have both `aria-live` and a `role` are counted twice. | `aria-live-analyzer.ts:45-66`: separate loops over `[aria-live]`, `[role=alert]` and `[role=status]` overlap, and `!text` is treated as a defect |
| Excessive assertive live regions (95) | FALSE POSITIVE / NOISE | Swiper notification (1 per slider) + draggable region + a `hidden` Cloudflare Turnstile fallback `<p role=alert>`. Pages with 2 sliders reach 4, which is over the threshold of 3. All are library defaults or hidden. | `aria-live-analyzer.ts:48,83` (hidden elements counted), threshold at `:94` |
| Large content in ARIA live regions (150) | NOISE | `.swiper-wrapper aria-live="polite"`. Swiper sets this itself when autoplay is off. | Library default |
| Auto-playing carousel/slider detected (163) | FALSE POSITIVE (title untrue) | storyblok-expert-agency (formerly `/storyblok-experts/`, now a 308): both sliders stayed on slide "1 / 4" and "1 / 3" for 12 s. The wrapper has `aria-live=polite`, which Swiper only sets when autoplay is disabled (`autoplay.enabled?"off":"polite"`). | `reduced-motion-analyzer.ts:103-115,165-170`: matches the `.swiper` class and never checks autoplay |
| Autoplay video without pause controls (105) | REAL (HIGH is too severe) | `<video autoplay muted loop playsinline>` with no controls and no button in its parent. It is a decorative screen recording. Codec-independent (attribute check). | — |
| Videos without captions (108) | FALSE POSITIVE | The videos are muted, looping silent screen recordings, so captions do not apply. | `media-seo-analyzer.ts:89,167`: `muted` is read but not used for captions |
| Video content without VideoObject schema (108) | NOISE | Decorative UI clips; rich results are not useful for them. | `media-seo-analyzer.ts:97` |
| Videos without accessible title (104) | NOISE | Decorative muted loop; the proper fix is aria-hidden, not a title. | — |
| Videos without poster (72) | REAL | switzerland has `poster=""`. Sweden has a poster and is correctly not flagged. | — |
| Broken images (6 pages) | PARTLY WRONG | 4 pages are real: expired signed S3/CloudFront URLs, curl 404/404/400. mgs-case-study and services/headless-cms-nextjs have `<img src="">`, a real CMS defect, but the report shows the page URL as the "image URL". | `broken-media-analyzer.ts:163`: shows `currentSrc` (resolves to the page) for `src=""` |
| Interactive elements without accessible name (14) | REAL | mgs-case-study: `<a href="" target=_blank><svg icon-link>` with no name. | — |
| Unlabeled click targets (11) | REAL | cms-kit: `.pyramid-pagination span` dots used as clickable pagination with no role or name. | — |
| Form inputs without a label (2, HIGH) | PARTLY WRONG | They are disabled checkboxes from a markdown task list (`li.task-list-item`), not form fields. Should be skipped or LOW. | `lib/analyzers/agentic/agentic-checks.ts:111-124`: does not skip `disabled` |
| Content reachable only via hover/JS (4) | UNVERIFIED | Offender `a.services-spoiler__head` is a real `<a href>` with `aria-expanded`. It comes from computed `hoverOnlySelectors`. I did not test the desktop `:hover` rule. | — |
| Missing `<main>` (9) | REAL | Live: next-js-expert-agency-sweden and composable-commerce-agency have 0 `main`, no h1, and a JS error. These are legacy-template pages. | — |
| No significant content above the fold (5) | PARTLY WRONG | /contact/ shows "Tell us about your project" at the top. It is flagged because the check only counts headings and images, and the page has no h1. | `above-fold-analyzer.ts:204` |
| Content lacks paragraph structure (4) | NOISE | /contact/, /services/, /solutions/ and the comparison table are form, hub and table pages. | `thin-content-analyzer.ts:94` |
| No conversion elements above fold (8) / none detectable (7) | REAL / NOISE | Legacy pages: no form, CTA buttons at y≈5000. The header "CONTACT US" nav link is not counted. | — |
| No author information found (376) / Most content pages lack author (0.0%) / Most pages lack author (0/417) | PARTLY WRONG | Blog posts have a visible byline (`.article-hero__author-name`, link to `/blog/author/…`), but no JSON-LD author. The run shows author = null on all 425 pages, including about 52 blog posts. Applying the check to service and case-study pages is noise. | `lib/utils.ts:983-993`: author selector list misses `[class*=author]` and `/author/` links |
| YMYL page without author (8) | FALSE POSITIVE | quanthealth-case-study and marketfinance-case-study match by URL substring ("health", "finance"). web-development-best-practices has a byline. | `eeat-analyzer.ts:217-223`: the URL regex matches client names |
| Low semantic HTML usage (202) / site-wide 9% (1) | NOISE | Semantic/generic element ratio. The pages already have `main`, `nav`, `section`, so the number is arbitrary. | `aeo-analyzer.ts:184,515` |
| No `<article>`/`<section>` (1) | FALSE POSITIVE | The flagged URL is `/media/posts/…image.png`, an image, not an HTML page. | `aeo-analyzer.ts:176`: runs on non-HTML responses |

### Top bugs by wrong report entries

1. **Link anchor text ignores `aria-label` and img alt:** about 834 entries (416 + 416 + the site-wide 443-link finding + the over-optimization finding). Cause: `page-data-builder.ts:506`.
2. **Contrast check counts hidden elements, nested duplicates and translucent backgrounds:** about 416 entries, nearly all false. Cause: `color-contrast-analyzer.ts:58-91`.
3. **ARIA live checks treat empty or library regions as defects and double count:** 408 + 95 + 150 = 653 entries. Cause: `aria-live-analyzer.ts:45-94`.
4. **The contact form's JS POST handler is ignored, so it is reported as a GET form:** 173 entries. The same single form also produces 173 + 171 real-but-repeated entries (autocomplete, fieldset) that belong in one site-level finding. Cause: `form-accessibility-analyzer.ts:111`.
5. **"Auto-playing" carousel is reported without checking autoplay:** 163 entries. Cause: `reduced-motion-analyzer.ts:103-170`.
6. **Author and YMYL detection miss the site's byline markup:** 376 + 2 site-level + 8 entries. Cause: `utils.ts:983`, `eeat-analyzer.ts:217`.
7. **Captions are required on muted decorative videos:** 108 entries, plus 108 + 104 noise entries (VideoObject, accessible title). Cause: `media-seo-analyzer.ts:89`.


## Detail: privacy-sec-schema
I checked all 25 finding types in the privacy, security, schema and PWA group. The only CRITICAL is wrong as written. The site really has no consent banner at all, but the tool thinks almost every page has a TrustArc banner because a JavaScript comment on every page contains the word "trusted". That one detection bug changes all of the cookie and consent findings. I checked the live site from an EU network location: no banner, no privacy policy page, and GA4 and visitor cookies are set on first load.

| Finding | Verdict | Evidence | Root cause (non-REAL) |
|---|---|---|---|
| [critical] Inconsistent cookie consent implementation (2 entries) | FALSE POSITIVE as written | Two different analyzers emit the same message with numbers that contradict each other: "8/417 have consent" (analytics) and "416 of 425 have a banner" (cookie analyzer). Live site, rendered in Playwright: no CMP script, no consent request, no fixed banner. The real state is "no consent at all", not "inconsistent". The 8 "consent" pages are articles whose text mentions cookies and consent (e.g. /google-consent-mode-v2/, /cdp-vs-cms/). The 416 "banners" are the TrustArc misdetection. The 425 total includes 8 pages that return 404 and one .png. | `lib/analyzers/security/cookie-consent-analyzer.ts:91` (`'truste'` matched against the whole HTML at :273). `lib/analyzers/analytics/analytics-tracking-analyzer.ts:188` (`/cookie.*consent/i` over the whole HTML). `lib/analyzers/site-wide/analytics-validator.ts:185` gives it CRITICAL. |
| Multiple consent platforms detected (TrustArc, CookieBot) | FALSE POSITIVE | Neither platform is on the site. TrustArc = "trusted" inside a visitor-id script comment. CookieBot = the word "cookieconsent" in the text of /solutions/enterprise-cms-migrations/. | `cookie-consent-analyzer.ts:90-91` (also `'cn-'` at :100 is just as loose) |
| [medium] Multiple tracking cookies set before consent (416) | PARTLY WRONG | The cookies are real on first load (`_ga`, `_ga_7LY9NKMMVS`, `fr_vid`, `fr_visitor_id`, 400 days). But the message assumes a banner exists. It should be the HIGH "Tracking cookies without consent banner" on 416 pages. | Same TrustArc misdetection |
| [high] Tracking cookies without consent banner (1) | PARTLY WRONG | It fired only on `/media/posts/f15a49afe586-image.png`, which is an image and sets no cookies. It is the only page where the TrustArc match failed. The real issue applies site-wide and is hidden elsewhere. Cookies come from one browser context shared by the whole crawl, so each page sees everything set by earlier pages. | `cookie-consent-analyzer.ts:330` (`context().cookies()`, never cleared). `crawler-engine.ts:737` (one context per crawl). |
| [medium] Third-party cookies without consent (1) | FALSE POSITIVE | The "third-party cookie" is `_cfuvid@.medium.com`, set by an embed on some earlier page. The .png sets nothing. | `cookie-consent-analyzer.ts:330` (shared cookie jar) |
| [low] Cookies with excessive lifespan (417) | NOISE | True: GA's 2-year cookies and `fr_*` show 400 days, which is Chrome's cap. It is one site-level fact repeated per page, and comes from the shared cookie jar. `fr_*` counts as "tracking" only because the pattern `'fr'` (meant for Facebook) is a substring match. | `cookie-consent-analyzer.ts:111` (`'fr'`; also `'IDE'` at :122), substring match |
| No privacy policy link found (412) + Privacy policy link missing on many pages [high] + Many pages lack privacy policy link | REAL, but triple-reported | Live: no privacy or cookie link in the rendered DOM; /privacy-policy/, /privacy/, /cookie-policy/, /terms/ and /legal/ all return 404. The 5 "has policy" pages only have table-of-contents anchors like `#15.-privacy%2C-consent…`. Site rollups say 5/417 and 412/425: two denominators. | `lib/utils.ts:915` (`/privacy/` matches in-page `#` anchors). Same fact emitted 3 ways. |
| Multiple analytics providers (412) | PARTLY WRONG | The site really has 5 trackers (GA4, Clarity, Gauges, Ahrefs, Cloudflare Insights). The tool counts hostnames instead: 5 hosts = only Google and Clarity, and it misses Gauges and Ahrefs. The conclusion is right by accident. Site fact repeated per page. | `lib/analyzers/performance/third-party-analyzer.ts:254` (`hosts.length > 3`). Category list at :40 lacks gaug.es and ahrefs. |
| External scripts missing SRI (416, MEDIUM) | NOISE | True: 6 of 7 rendered external scripts lack `integrity`, but they are versionless analytics loaders (clarity tag, gtag, gaug.es) that cannot carry SRI. 2 come from the served HTML; the rest are injected at runtime (Clarity by gtag, Gauges by the site's own main.js), so the site cannot add `integrity` to them. Site-level fact repeated per page. | `lib/analyzers/security/sri-analyzer.ts:37` (reads the rendered DOM, counts injected scripts) |
| Missing Permissions-Policy header (417, MEDIUM) | REAL, over-counted | curl: header absent. One header-config fact emitted 417 times. MEDIUM is high for a site that uses none of those browser features. | per-page emission (permissions-policy-analyzer.ts:58) |
| Missing cross-origin isolation headers (417) | NOISE | True: no COOP or COEP. Setting COEP `require-corp` would break the YouTube, Clarity and embed resources. Not actionable for a marketing site. Repeated per page. | `cross-origin-policy-analyzer.ts:84-90` |
| security.txt missing | REAL | /.well-known/security.txt and /security.txt both return 404 (HTML). | — |
| No explicit AI crawler rules in robots.txt | FALSE POSITIVE | Live robots.txt has an explicit `User-agent: OAI-SearchBot` group. OAI-SearchBot is not in the tool's crawler list. | `lib/analyzers/seo/aeo-analyzer.ts:51` (AI_CRAWLERS lacks OAI-SearchBot) |
| LocalBusiness missing openingHours / geo / image / priceRange (1248 each, 4,992 entries) | PARTLY WRONG (counting) | Every page has the same 3 office LocalBusiness blocks in its template (London, Warsaw, New York). 1248 = 416 × 3, counted per element. The fields really are missing, but this is 4 site-level facts. Examples repeat the same URL (/about/ twice). Missed real errors: `postalCode:"NY 10022"`, `addressCountry:"UNITED STATES"` (not ISO). | `lib/analyzers/seo/advanced-schema-validator.ts:48-53` / :490 (per schema per page, no dedupe) |
| Video content without VideoObject schema (108, MEDIUM) | NOISE | The video on /headless-cms-development-agency-sweden/ is a muted autoplay loop with no controls (a decorative screen recording). It is not an indexable content video. | `lib/analyzers/seo/media-seo-analyzer.ts:96` (no decorative-video exclusion) |
| Form submits to itself via GET (173) | FALSE POSITIVE | `#mail-us-form` has no action or method, but main.65aeeb21.js does `i.onsubmit=async o=>{o.preventDefault(),…}` and submits through JS (with Turnstile). Nothing goes into the URL. | `lib/analyzers/accessibility/form-accessibility-analyzer.ts:261` (ignores JS submit handlers) |
| Form inputs missing autocomplete (173) | REAL | Live: name, email and phone inputs have no `autocomplete`. Template-level, repeated per page. | — |
| No web app manifest / No service worker / No theme-color / No Apple touch icon / App not installable (417 each) + "No web app manifest found on any page" | NOISE (true, but filler) | Live: no manifest, theme-color or apple-touch-icon link; /manifest.json, /site.webmanifest, /apple-touch-icon.png and /sw.js all return 404. "App not installable" repeats manifest + service worker. 2,085 per-page entries for one site-level fact. docs/report-rules.md §0 says these are "Minor & informational" filler. | `lib/analyzers/performance/pwa-analyzer.ts:105,123,136,147,163` (per-page, site-level) |
| [high] Render-blocking third-party scripts (416) (perf group, found here) | FALSE POSITIVE | The script is `static.cloudflareinsights.com/beacon.min.js`, which is `type="module"` (deferred by default) and has SRI. | `third-party-analyzer.ts:301` (`!async && !defer` ignores `type=module`) |

**Top bugs, by number of wrong report entries**
1. **LocalBusiness counted once per block on every page** (`advanced-schema-validator.ts:48`): 4,992 entries for 4 site-level facts.
2. **PWA checks reported per page** (`pwa-analyzer.ts`): 2,086 entries for about 4 facts, all filler under report-rules §0.
3. **Site-level header and cookie facts repeated per page**: SRI 416, Permissions-Policy 417, COOP/COEP 417, cookie lifespan 417, multiple analytics 412, plus 412 privacy-policy entries. That is about 2,500 entries that should be about 6 site findings.
4. **TrustArc substring `'truste'` matching "trusted"** (`cookie-consent-analyzer.ts:91`, :273): flips the whole consent picture. It produces 416 wrongly worded "before consent" entries, hides the real HIGH "no consent banner" on 416 pages, and causes the fake "multiple platforms" finding and the 416/425 CRITICAL.
5. **Form GET check ignores JS submit handlers** (`form-accessibility-analyzer.ts:261`): 173 false entries.
6. **`type=module` treated as render-blocking** (`third-party-analyzer.ts:301`): 416 false HIGH entries.
7. **Whole-HTML regex `/cookie.*consent/i`** (`analytics-tracking-analyzer.ts:188`) and the duplicate CRITICAL from `analytics-validator.ts:185`: wrong numbers in the only CRITICAL.
8. **One cookie jar shared across the crawl** (`cookie-consent-analyzer.ts:330`): cookies from earlier pages are blamed on the current page, as in the .png's third-party cookie.
9. **Hostnames counted as providers** (`third-party-analyzer.ts:254`): wrong list on 412 pages.
10. **OAI-SearchBot missing from the AI crawler list** (`aeo-analyzer.ts:51`): 1 false entry.
11. **Denominator inconsistency**: 425 pages, including 404s and a .png, against 417 elsewhere in the site rollups.
