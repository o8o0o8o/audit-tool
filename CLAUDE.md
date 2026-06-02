# SEO Audit Tool

## Project Overview

An automated SEO audit tool that analyzes websites for SEO compliance, performance metrics, and best practices. The tool crawls websites, validates meta tags, measures Core Web Vitals, and generates comprehensive HTML reports.

## Purpose

This tool performs comprehensive SEO audits by:

- Analyzing robots.txt configuration
- Validating sitemap structure and consistency
- Crawling all pages listed in sitemaps
- Checking SEO-critical elements (titles, descriptions, meta tags)
- Measuring Core Web Vitals (LCP, CLS, TTFB)
- Validating canonical URLs and alternate language links
- Detecting common SEO issues and inconsistencies
- Scoring pages and providing prioritized recommendations

## Technology Stack

- **Language**: TypeScript (strict mode incrementally enabled)
- **Runtime**: Node.js with tsx (TypeScript executor)
- **Browser Automation**: Playwright (Chromium)
- **HTML Parsing**: node-html-parser
- **Performance Monitoring**: Web Vitals API
- **Output**: JSON (gzip compressed), HTML reports, CSV exports

## Project Structure

```
audit-tool/
├── start.ts                    # Entry point - spawns audit with restart capability
├── robots.ts                   # SEOData class - thin orchestration layer (~380 lines)
├── generateHTML.ts             # HTML report generator - thin orchestrator (~190 lines)
├── generateCSV.ts              # CSV export generator
├── generateComparison.ts       # Audit comparison HTML report
├── historyManager.ts           # Historical audit tracking
├── validators.ts               # Input validation and sanitization
├── lib/
│   ├── args-parser.ts          # CLI argument parsing
│   ├── config-loader.ts        # Configuration file loading (.seoauditrc)
│   ├── constants.ts            # Centralized configuration and thresholds
│   ├── utils.ts                # Shared utility functions
│   ├── analyzers/
│   │   ├── accessibility/
│   │   │   ├── accessibility-analyzer.ts    # WCAG 2.1 compliance
│   │   │   └── mobile-friendly-analyzer.ts  # Mobile viewport testing
│   │   ├── analytics/
│   │   │   └── analytics-tracking-analyzer.ts  # GA4, GTM verification
│   │   ├── content/
│   │   │   ├── content-quality-analyzer.ts  # Readability, word count, word count by section
│   │   │   ├── cta-detector-analyzer.ts     # CTA detection (buttons, forms, tel/mailto links)
│   │   │   ├── freshness-analyzer.ts        # Content freshness, update signals
│   │   │   ├── language-detection-analyzer.ts # Trigram-based language detection, lang attr matching
│   │   │   ├── link-quality-analyzer.ts     # Link analysis
│   │   │   ├── outbound-link-checker.ts     # External link health checking with rate limiting
│   │   │   └── thin-content-analyzer.ts     # Thin/insufficient content detection
│   │   ├── international/
│   │   │   └── international-seo-analyzer.ts  # hreflang validation
│   │   ├── performance/
│   │   │   ├── caching-analyzer.ts          # CDN, cache headers
│   │   │   ├── code-coverage-analyzer.ts    # JS/CSS unused code via CDP Coverage API
│   │   │   ├── image-optimization-analyzer.ts  # Image optimization
│   │   │   └── resource-optimization-analyzer.ts  # Render-blocking
│   │   ├── security/
│   │   │   └── security-analyzer.ts         # HTTPS, security headers
│   │   ├── seo/
│   │   │   ├── advanced-schema-validator.ts # Detailed schema validation (FAQ, Product, etc.)
│   │   │   ├── aeo-analyzer.ts              # AI Search Readiness (AEO), llms.txt, AI crawlers
│   │   │   ├── crawlability-analyzer.ts     # Robots.txt analysis
│   │   │   ├── eeat-analyzer.ts             # E-E-A-T signals (author, trust, expertise)
│   │   │   ├── heading-analyzer.ts          # H1-H6 structure
│   │   │   ├── image-analyzer.ts            # Alt text validation
│   │   │   ├── indexability-analyzer.ts     # Canonical, noindex
│   │   │   ├── response-header-analyzer.ts   # Vary, Link, X-Robots-Tag, Content-Language headers
│   │   │   ├── structured-data-analyzer.ts  # Schema.org markup
│   │   │   ├── technical-seo-analyzer.ts    # Meta refresh, CMS detection, JS frameworks, DOCTYPE, iframes, HTML size
│   │   │   └── url-architecture-analyzer.ts # URL structure, parameters, depth
│   │   ├── site-wide/
│   │   │   ├── analytics-validator.ts       # Cross-site tracking
│   │   │   ├── content-similarity-analyzer.ts # Near-duplicate content via Jaccard similarity
│   │   │   ├── broken-pagination-analyzer.ts # Infinite/broken "next" pagination (crawl-budget waste)
│   │   │   ├── duplicate-checker.ts         # Duplicate content
│   │   │   ├── indexability-validator.ts    # Site-wide indexability
│   │   │   ├── international-seo-validator.ts  # Language consistency
│   │   │   ├── keyword-cannibalisation-analyzer.ts # Keyword conflicts detection
│   │   │   ├── link-structure-analyzer.ts   # Internal link patterns
│   │   │   ├── internal-pagerank-analyzer.ts # Iterative PageRank on internal link graph
│   │   │   ├── link-depth-analyzer.ts       # Orphan pages, link depth analysis
│   │   │   ├── social-media-validator.ts    # Social meta tags
│   │   │   └── structured-data-validator.ts # Schema consistency
│   │   └── social/
│   │       └── social-media-analyzer.ts     # OG tags, Twitter cards
│   ├── crawler/
│   │   ├── crawler-engine.ts    # Page crawling, browser management, analysis
│   │   └── vitals-collector.ts  # Core Web Vitals collection
│   ├── orchestrators/
│   │   ├── audit-orchestrator.ts   # Site-wide validation, page analysis workflow
│   │   └── progress-manager.ts     # Checkpoint persistence and restoration
│   ├── parsers/
│   │   ├── robots-parser.ts     # Robots.txt parsing
│   │   └── sitemap-parser.ts    # Sitemap XML parsing
│   ├── reports/
│   │   ├── data-processor.ts    # Report data loading and processing
│   │   ├── html-utils.ts        # HTML helper functions (escaping, formatting)
│   │   ├── metrics-metadata.ts  # Thresholds and metric definitions
│   │   └── sections/            # HTML report section generators
│   │       ├── index.ts         # Section exports
│   │       ├── styles.ts        # CSS styles
│   │       ├── scripts.ts       # JavaScript (charts, interactivity)
│   │       ├── executive-summary.ts
│   │       ├── quick-wins.ts
│   │       ├── top-issues.ts
│   │       ├── performance-stats.ts
│   │       ├── historical-progress.ts
│   │       ├── charts-section.ts
│   │       ├── config-info.ts
│   │       ├── pages-table.ts
│   │       ├── content-insights.ts    # New insights: PageRank, similarity, language, CTAs, coverage
│   │       ├── technology-stack.ts
│   │       └── source-code-analysis.ts
│   ├── scoring/
│   │   └── score-calculator.ts  # Score calculation and recommendations
│   ├── storage/
│   │   └── file-manager.ts      # File operations, compression, archiving
│   └── utils/
│       ├── error-aggregator.ts  # Error tracking and aggregation
│       ├── progress-reporter.ts # Real-time crawl progress display
│       └── cli-summary.ts       # CLI summary output after audit
├── package.json
├── tests/
│   └── analyzers.test.ts        # Unit tests for analyzers (node --test)
└── README.md
```

## Key Files

### start.ts

Entry point that spawns the audit process as a child process. Handles process crashes by automatically restarting with `--proceed` flag to resume from saved progress.

### robots.ts

Thin orchestration layer (~380 lines) containing the `SEOData` class. Exports `SEOData` for programmatic use. Delegates heavy lifting to:

- `lib/crawler/crawler-engine.ts` - Page crawling and browser management
- `lib/orchestrators/audit-orchestrator.ts` - Page analysis workflow
- `lib/orchestrators/progress-manager.ts` - Checkpoint persistence
- `lib/utils/error-aggregator.ts` - Error tracking

### generateHTML.ts

Thin HTML report orchestrator (~190 lines). Composes reports using extracted modules:

- `lib/reports/data-processor.ts` - Data loading and processing
- `lib/reports/html-utils.ts` - HTML helper functions
- `lib/reports/sections/` - Template section generators

### lib/crawler/crawler-engine.ts

Core crawling engine handling:

- Browser lifecycle management (Playwright)
- Batch processing with concurrency control
- Page analysis orchestration (runs all analyzers)
- Network/CPU throttling for performance testing
- Redirect chain tracking
- Link discovery and incoming link tracking

### lib/orchestrators/audit-orchestrator.ts

Audit workflow coordination:

- `analyzePages()` - Main crawling orchestration
- `runSiteWideValidation()` - Post-crawl site-wide checks
- Multilanguage detection
- Orphaned page identification

### lib/orchestrators/progress-manager.ts

Checkpoint persistence and restoration:

- `loadProgress()` - Restore from checkpoint files
- `saveProgress()` - Save with archiving support
- Archive file management for large sites
- Data optimization for storage

### lib/args-parser.ts

Centralized CLI argument parsing. Supports:

- `--origin=<url>` - Target website
- `--proceed` - Resume from saved progress
- `--perf` - Enable performance metrics
- `--save-html` - Save HTML snapshots
- `--concurrency=<n>` - Parallel crawling (1-20, default: 5)

### lib/constants.ts

Centralized configuration including:

- Severity levels: CRITICAL, HIGH, MEDIUM, LOW
- Performance thresholds: TTFB (800ms), LCP (2500ms), CLS (0.1), FCP (1800ms)
- Content thresholds: Title (30-60 chars), Description (120-160 chars)
- Network conditions: slow3g, fast3g, slow4g, normal
- Meta tags to monitor (18 different tags)

### lib/storage/file-manager.ts

Handles file operations with:

- Automatic gzip compression (70-80% space reduction)
- Auto-archiving for large sites (>5000 pages)
- Directory structure: `audit-results/domain.com/YYYY-MM-DD_HH-MM-SS/`
- Backward compatible with legacy uncompressed files

### lib/scoring/score-calculator.ts

Score calculation system:

- Overall score (0-100)
- Category scores: SEO, Performance, Accessibility, Security, Technical
- Quick wins identification (high impact, low effort)
- Fix recommendations with effort estimates

### historyManager.ts

Historical audit tracking:

- Saves audit snapshots over time
- Comparison between audits
- Trend data generation
- Detects improvements and regressions

### generateCSV.ts

Exports audit data to CSV files:

- `pages_overview.csv` - All metrics per page
- `issues_breakdown.csv` - Issues by severity
- `performance_metrics.csv` - Performance data
- `quick_wins.csv` - Prioritized actions
- `summary.csv` - High-level statistics

### generateComparison.ts

Generates HTML comparison report:

- Side-by-side score comparison
- Category score deltas
- Performance metrics changes
- Improvements and regressions

### validators.ts

Input validation and security:

- URL validation with protocol checking
- Filename sanitization (prevents path traversal)
- Suspicious pattern detection (XSS, shell injection)
- Rate limiter class for abuse prevention

## Analyzer Modules

### Accessibility

- **accessibility-analyzer.ts**: WCAG 2.1 compliance checks
- **mobile-friendly-analyzer.ts**: Mobile viewport and touch targets

### Analytics

- **analytics-tracking-analyzer.ts**: GA4, GTM, other tracking verification

### Content

- **content-quality-analyzer.ts**: Readability, word count, keyword density, text-to-HTML ratio
- **link-quality-analyzer.ts**: Internal/external link analysis

### International SEO

- **international-seo-analyzer.ts**: hreflang tag validation, language consistency

### Performance

- **caching-analyzer.ts**: CDN detection, cache headers, Service Worker
- **image-optimization-analyzer.ts**: Image format, size, lazy loading
- **resource-optimization-analyzer.ts**: Render-blocking resources, minification

### Security

- **security-analyzer.ts**: HTTPS, security headers (CSP, X-Frame-Options, HSTS)

### SEO

- **aeo-analyzer.ts**: AI Search Readiness (AEO) - llms.txt validation, AI crawler rules (GPTBot, ClaudeBot, PerplexityBot), semantic HTML ratio, content structure scoring, FAQ/Q&A detection
- **crawlability-analyzer.ts**: Robots.txt, crawl efficiency
- **heading-analyzer.ts**: H1-H6 structure and hierarchy
- **image-analyzer.ts**: Alt text and image metadata
- **indexability-analyzer.ts**: Canonical, noindex, nofollow
- **structured-data-analyzer.ts**: Schema.org markup validation

### Site-Wide Validators

- **analytics-validator.ts**: Cross-site tracking consistency
- **duplicate-checker.ts**: Duplicate titles and descriptions
- **indexability-validator.ts**: Site-wide indexability issues
- **international-seo-validator.ts**: Language implementation consistency
- **link-structure-analyzer.ts**: Internal link patterns
- **social-media-validator.ts**: Social meta tag consistency
- **structured-data-validator.ts**: Schema markup consistency

### Social

- **social-media-analyzer.ts**: Open Graph tags, Twitter cards

## Usage

### Installation

```bash
yarn
npx playwright install
```

### Running an Audit

```bash
npx tsx start.ts --origin=<website-url> [--perf] [--save-html] [--screenshots] [--proceed] [--concurrency=<number>]
```

### Export to CSV

```bash
npx tsx generateCSV.ts <json-file-path>
```

### Compare Audits

```bash
npx tsx historyManager.ts list <domain>
npx tsx generateComparison.ts <domain> <old-index> <new-index>
```

### History Management

```bash
npx tsx historyManager.ts save <json-file>
npx tsx historyManager.ts list <domain>
npx tsx historyManager.ts compare <domain> <old> <new>
```

## Output Files

### Directory Structure

```
audit-results/
└── domain.com/
    ├── audit-history.json              # Historical snapshots
    └── YYYY-MM-DD_HH-MM-SS/
        ├── manifest.json.gz             # Multi-file format index + evidence index
        ├── metadata.json.gz             # robots, sitemaps, CrUX, timing
        ├── analysis.json.gz             # Site-wide issues + summary
        ├── incoming-links.json.gz
        ├── pages/                       # Per-batch page JSONs
        ├── audit-report.md               # Phase 2 curated markdown
        ├── audit-report.html             # Phase 2 styled HTML (renderer input)
        ├── audit-report.pdf              # Phase 2 final curated PDF
        ├── audit-report.verified.md      # --verify variant (refuted dropped; every issue labelled)
        ├── audit-report.verified.pdf     # --verify variant PDF (✓ Verified / unverified per issue)
        ├── evidence/                    # Per-page evidence for sampled URLs
        │   └── <safe-filename>/
        │       ├── _meta.json           # { url, capturedAt } — self-describing
        │       ├── screenshot.mobile.png
        │       ├── screenshot.desktop.png
        │       ├── requests.json        # Network log
        │       ├── accessibility.json   # Heuristic checks
        │       ├── axe.json             # axe-core 4.x findings
        │       ├── psi.mobile.json      # PageSpeed Insights lab (when --perf)
        │       └── psi.desktop.json
        └── domain.com.html              # HTML report
```

**Representative-page sampling.** Evidence is captured only for a small bucketed sample (`/`, `/section`, `/section/*`), capped at 10 pages by default. See `lib/crawler/representative-sampler.ts`. The manifest's `evidence` section indexes which URL → which evidence directory; `null` if no pages were sampled. Use `--no-evidence` to skip capture entirely, or `--evidence-cap=N` to change the limit (1–100).

**PSI lab capture** is gated on `--perf`. Runs mobile + desktop strategies for each sampled URL at concurrency 4. Honours `CRUX_API_KEY` env var; works keyless at reduced rate limits.

**Phase 2 — curated PDF report.** After the crawl, `lib/phase2/phase2-runner.ts` reads the manifest + analysis artifacts, routes findings into sections (Performance / SEO / Privacy / Accessibility / UX / Technical) using keyword categorisation, caps each section at 12 findings, and produces a styled PDF resembling the human audit-report examples. Template-driven by default; add `--no-phase2` to skip. PDF rendering is via Playwright `page.pdf()` with a custom stylesheet in `lib/reports/pdf-renderer.ts`.

**Report rules — ranking, severity, categorization & determinism.** The rules governing how findings are ranked (category priority SEO > Performance > UX > Privacy/Security > Accessibility > Technical), severity-moderated against category scores, categorized, de-duplicated, and kept **deterministic** (same crawl data → identical report for everyone, independent of concurrent crawl-completion order) are documented in [`docs/report-rules.md`](docs/report-rules.md) and enforced in `lib/phase2/` + `lib/scoring/score-calculator.ts` + `lib/utils/error-aggregator.ts`. Keep that doc, the code, and the determinism tests in `tests/analyzers.test.ts` in sync.

**Optional LLM narrative.** `--llm-narrative` rewrites each section's `**Analysis.**` paragraph from generic counts ("26 distinct findings…") into 2–3 sentences anchored in the actual findings list. Requires `ANTHROPIC_API_KEY` env var. Disk-cached per audit so re-runs are free. Falls back to templated prose silently when the key is missing or the call fails. Typical cost: ~$0.02–$0.03 per audit at Sonnet pricing.

**Optional verification phase.** `--verify` (`lib/phase2/finding-verifier.ts`) runs after the normal Phase 2 report is written and never touches it. For each surviving finding it picks the **first concrete example** and re-checks the claim against the crawl data already on disk (`pages/*.json.gz` — titles, descriptions, canonicals, status codes, redirect chains, H1s, alt-image counts, `noindex`, sitemap membership are recorded for *every* crawled page, not just the sampled ones). Deterministic, no network, no API key. Each finding gets a verdict: **confirmed** (re-checks out → labelled `✓ Verified`), **refuted** (data contradicts it → auto-dropped, each logged with its reason), or **unchecked** (no verifier owns the kind, or the cited URL/signal isn't on disk — e.g. a broken *external* link → kept and labelled *unverified*, a neutral "no deterministic check applies" marker, NOT a defect). The result is a **separate** `audit-report.verified.{md,pdf}` (the normal `audit-report.*` is never touched) with a banner summarising the counts; every surviving issue carries its status in its header. The per-issue labels render ONLY in this report — gated by a `VerifyView` object threaded through `buildReportMarkdown`; absent for the normal report. A persistence caveat drove the design: storage strips/rewrites some `PageInfo` fields, so the verifiers read the fields that actually survive — `headings.h1Count` (not the stripped top-level `h1`), `indexability.hasNoindexTag` (not top-level `noindex`), `hasRedirects`/`redirectCount` (not the stripped `redirectChain`), `soft404`, and an "analyzed" gate (presence of `indexability`) so an absent `canonical`/`description` on an analyzed page reads as genuinely-missing while an absent field on a non-analyzed page stays `unchecked`. An absent field must never auto-drop a finding. Verifier kinds today: duplicate title/description, missing canonical/description, multiple-h1 (excludes keyword-cannibalisation wording so a same-keyword finding isn't dropped on a single page's H1 count), not-in-sitemap, noindex, redirect, soft-404; threshold checks that cross-check the persisted per-page metric against `THRESHOLDS` (CWV LCP/FCP/TTFB/TBT/TTI/CLS/INP, title/description length, page size, request count, h2 count); content volume (thin/expand, confirm-only); boolean per-page checks (console errors, per-page broken outbound links, author attribution); and a set of **confirm-only** checks against the rich analyzer sub-objects — empty-anchor (`anchorTextData.emptyAnchors`), oversized-images / legacy-image-format / excessive-image-size (`imageOptimization`), unused-code / unused-css (`codeCoverage`), render-blocking (`resourceOptimization.renderBlocking`), dom-children / excessive-dom (`domComplexityData`), third-party-payload (`thirdPartyData.totalSize`), tracking-before-consent (`consentData`). Confirm-only: missing-alt, thin/expand-content, and all the sub-object checks just listed (their persisted signal is a broader proxy than the exact finding, so a non-match stays `unchecked`, never a drop). Also confirm-only: contrast-aaa/contrast-aa (`colorContrastData.aaFailures/aaaFailures`), sri-missing (`sriData.missingIntegrity`), permissions-policy (`permissionsPolicyData`), cross-origin-isolation (`crossOriginPolicyData`), reduced-motion (`reducedMotionData`), autocomplete-missing (`formData.inputsWithoutAutocomplete`), too-many-fonts (`fontData.totalFonts`). `verifyShared` also handles single-cited "identical title/description" findings by scanning the FULL page index for ≥2 pages sharing the quoted value (prefix-matched, since description quotes are truncated). **Site-level verifiers** read a `SiteData` object (`loadSiteData` → `incoming-links.json.gz` + `metadata.json.gz`, threaded through `verifyFinding`/`verifyDetails` as an optional 4th arg): orphan-page / unreachable / click-depth (BFS from the homepage over the forward graph) / low-link-equity from the inbound link graph; robots-sensitive / robots-wildcards / robots-no-ai from `robots`; sitemap-not-crawled (cited URLs absent from the index) and the count-only "indexable pages missing from sitemap" (index scan of `indexability.isIndexable` vs the sitemap URL set). Two table-driven factories (`numericVerifier`, `booleanVerifier`) make adding per-page kinds a one-liner. On the lunacy reference run this lifts confirmed findings from 6 → 26 with 0 false refutations; on the siro.ai run the sub-object + site-level checks lift data-confirmed 26 → 55 (107 → ~50 still-unverified once the keyless CLI pass runs).

**LLM fallback (`lib/phase2/llm-finding-verify.ts`).** `--verify` runs a second stage over the findings the deterministic pass left `unchecked`: `collectUncheckedContexts` packages each with its first example + a compact `buildPageSignals` snapshot of the cited page, and Claude returns confirmed / refuted / unsure per finding (batched, disk-cached). **Two transports, auto-selected so a key is never required:** when `ANTHROPIC_API_KEY` is set it POSTs to the API (`llmVerifyFindings`, vanilla HTTPS, parallel batches); otherwise, if the `claude` CLI is on PATH it spawns it headless (`claudeCliVerifyFindings` → `claude -p --output-format json`, prompt on stdin, `extractCliResult` unwraps the `.result` envelope, then the SAME `parseLlmVerdicts`; uses the user's login — no key, no SDK). The CLI path is sequential, 180s/batch timeout, inherits the user's default model (no `--model` passed), and is disabled by `SEO_AUDIT_SKIP_CLAUDE_CLI=1` (binary overridable via `SEO_AUDIT_CLAUDE_CLI_BIN`). Both transports degrade silently to `[]` on any failure, leaving the deterministic result unchanged. LLM-confirmed → labelled **✓ Verified (AI)** (distinct from deterministic ✓ Verified); LLM-refuted → kept and logged as **AI-disputed** (the LLM never drops — only the deterministic pass does, since LLM judgment over partial evidence is too uncertain to silently remove a finding); unsure → stays *unverified*. The original report is still never touched. `buildPageSignals` surfaces a broad slice of the persisted analyzer sub-objects (`domComplexityData`, `anchorTextData`, `consentData` cookies, `codeCoverage`, `aeo`, `pwaData`, `security.missingHeaders`, `thirdPartyData`, `freshnessData`, `imageOptimization`, …) so the model can actually adjudicate most kinds; the wider the snapshot, the fewer "unsure".

**Site-wide rollup.** `buildSiteAggregate(pages)` computes cross-page counts (status distribution, PWA/analytics/structured-data/author/date-markup coverage, avg semantic-HTML ratio, trailing-slash split, thin-content pages, total empty anchors) and is passed to `llmVerifyFindings` as `siteContext`, included ONCE per batch prompt. This is what lets the LLM confirm "most/all pages lack X" and crawl-budget findings a single page can't prove.

**Three ways to supply LLM verdicts, in priority order (the first two need no API key):** (1) `--verify` reads `<runDir>/verify-verdicts.json` if present — a `{ findings: [{ key, verdict, reason }] }` file any Claude session (Claude Code, spawned subagents) can produce by reasoning over `collectUncheckedContexts(...)` + `buildSiteAggregate(...)`; injection wins over everything. (2) When `ANTHROPIC_API_KEY` is set, the live API call. (3) Otherwise, if the `claude` CLI is available, it is spawned headless (keyless). So with no key and no injected file, `--verify` still runs the full LLM stage by spawning the CLI. On the lunacy reference run, deterministic + LLM (rich per-page signals + site rollup) reached **73/125 confirmed** (26 data + 47 AI), 3 AI-disputed, 52 unverified. The remaining floor is genuinely un-derivable from current artifacts: topic-clustering claims, DNS/IPv6, robots.txt rules, off-page link targets, internal-link-graph (orphan/dead-end/reachability), response-header specifics, per-script coverage, near-duplicate content. AI-disputed findings (e.g. resource-hint findings contradicted by `resourceHints.preload:true`) are useful candidate analyzer false-positives to investigate. Verifier kinds live in an ordered registry in `finding-verifier.ts`; add a kind by appending a `{ match, verify }` entry. AI-discovered findings are always `unchecked`.

**Optional LLM anomaly detection.** `--llm-findings` (`lib/phase2/llm-anomaly.ts`) reasons over each representative page's evidence — the desktop screenshot (vision) plus structured signals (buttons, links + HTTP statuses, forms, pagination state incl. `infiniteScrollDetected`/`totalPages`, failed network requests) — to surface *emergent* functional/UX bugs the deterministic analyzers can't enumerate: dead buttons, CTAs to 404s, never-terminating pagination, forms posting nowhere, visually broken layout, placeholder content. Each finding is merged into its section as a synthetic finding tagged `🔍 AI-discovered` (with an **Evidence** block and the model's recommendation as the **Fix**), never mixed silently with deterministic results. Same client pattern as the narrative pass: dependency-free HTTPS, disk-cached per page (incl. image bytes), gated on `ANTHROPIC_API_KEY`, returns `[]` on any failure or when evidence/screenshots are absent (e.g. `--no-evidence`). Bounded to the representative-page sample; ~$0.02–$0.05 per page.

### JSON Results Structure

```json
{
  "robots": {
    "sitemaps": [],
    "user-agent": {}
  },
  "sitemaps": {
    "urls": {},
    "total": 0
  },
  "pageData": {
    "pages": {},
    "processedPages": [],
    "totalWithoutError": 0,
    "totalWithError": 0,
    "byError": {},
    "attempts": {}
  },
  "analysis": {
    "overall": [],
    "details": {}
  }
}
```

## Validation Rules

### Critical Issues

- Missing or empty title
- Missing or empty meta description
- Missing canonical URL
- Missing alternate links (multi-language sites)
- Pages not in sitemap
- Canonical URL mismatch
- HTTP errors (404, 500)

### Performance Thresholds

- TTFB > 800ms
- LCP > 2500ms
- CLS > 0.1
- FCP > 1800ms
- INP > 200ms
- Page size > 6MB
- Requests > 20

### Content Quality Thresholds

- Title: 30-60 characters optimal
- Description: 120-160 characters
- Minimum content: 300 words (recommended: 600)
- Text-to-HTML ratio: 25% minimum
- Keyword density: 3% maximum

### Content Issues

- Duplicate titles/descriptions
- Multiple h1 tags
- Excessive h2 tags (>10)
- Skipped heading levels
- Links without text
- Images without alt text

### Sitemap Issues

- Duplicate URLs
- Trailing slash inconsistencies
- Trailing-slash duplicate pairs (`/foo` and `/foo/` both present)
- `changefreq=always`+`priority=1.0` abuse (>80% of URLs)
- 4xx / 5xx URLs in sitemap (reconciled post-crawl against actual status codes)
- 3xx redirects in sitemap
- Incorrect origin
- Exceeds 50,000 URLs
- Missing in robots.txt

### Pagination / Crawl-Budget Issues

- **Broken / infinite pagination** — a "next" link that keeps advancing past the real last page into empty, duplicate, or soft-404 listings (HTTP 200, no real content). Wastes crawl budget. Detected two ways:
  - *Post-crawl (`broken-pagination-analyzer.ts`)* — groups crawled pages by series key (`/page/{N}`, `?page=N`, …), finds a contiguous broken tail (soft-404 OR thin + near-duplicate), and reports a HIGH finding. Corroborated by `truncatedPaginationSeries` (series that hit the discovery cap).
  - *Active probe (`pagination-analyzer.ts`)* — for JS-driven "next" controls with no static href, opens an isolated page and clicks "next" up to a bounded number of times; flags when the control stays enabled while content stops changing or empties out. Budget-capped per audit (`BROKEN_PAGINATION_MAX_PROBES`).

### International / Hreflang Issues

- Hreflang alternates that are not fully-qualified URLs (relative or protocol-relative)
- Self-referential hreflang missing
- Bidirectional hreflang reciprocity violations
- Duplicate hreflang assignments within a language group

### Privacy Issues

- Tracking cookies without consent banner
- Third-party cookies without consent
- Cookies with lifespan >365 days

### Image / Performance Issues

- Oversized images (raw size or natural-vs-display ratio)
- srcset candidate over-fetch (browser picked >1.5× display target)
- srcset under-resolution (browser picked <0.8× display target)
- w-descriptor srcset without `sizes` attribute
- Legacy font formats mixed with woff2 (≥25%)
- High percentage of unused CSS (with critical-CSS extraction hint)

## Configuration

### Network Conditions

```javascript
networkConditions: {
  slow3g: { download: 500000, upload: 750000, latency: 400 },
  fast3g: { download: 1500000, upload: 750000, latency: 150 },
  slow4g: { download: 4000000, upload: 3000000, latency: 100 },
  normal: { noThrottle: true }
}
```

### Viewport

```javascript
viewport: { width: 414, height: 896 } // Mobile viewport
```

## Error Handling

### Automatic Restart

If the process crashes, `start.ts` automatically restarts with `--proceed` to resume from the last checkpoint.

### Retry Logic

- Up to 3 attempts per page
- 30-second timeout per page
- Failed pages tracked and reported

### Known Errors

- `ERR_TOO_MANY_REDIRECTS`
- Network timeouts
- Page load failures
- Browser crashes

## Limitations

- Chromium browser only
- Mobile viewport only (414x896)
- Concurrency: 1-20 pages (default: 5)
- 30-second timeout per page
- Maximum 3 retries per URL

## License

ISC

## Author

Sergey Labut
