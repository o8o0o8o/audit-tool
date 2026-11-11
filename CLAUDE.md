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

- **Language**: TypeScript (fully `strict: true`, plus `noImplicitReturns` and `noFallthroughCasesInSwitch`)
- **Runtime**: Node.js with tsx (TypeScript executor)
- **Browser Automation**: Playwright (Chromium)
- **HTML Parsing**: node-html-parser
- **Performance Monitoring**: Web Vitals API
- **Output**: JSON (gzip compressed), HTML reports, CSV exports

## Project Structure

```
audit-tool/
├── start.ts                    # Entry point - spawns audit with restart capability
├── robots.ts                   # CLI runner / sub-command dispatcher (~620 lines); re-exports SEOData
├── lib/seo-data.ts             # SEOData class - thin orchestration layer (~620 lines)
├── generateHTML.ts             # HTML report generator - thin orchestrator (~470 lines)
├── generateCSV.ts              # CSV export generator
├── generateComparison.ts       # Audit comparison HTML report
├── historyManager.ts           # Historical audit tracking
├── validators.ts               # Input validation and sanitization
├── lib/
│   ├── args-parser.ts          # CLI argument parsing
│   ├── config-loader.ts        # Configuration file loading (.seoauditrc)
│   ├── constants.ts            # Centralized configuration and thresholds
│   ├── utils.ts                # Shared utility functions
│   ├── analyzers/               # 89 analyzer modules total; tree below is representative
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
│   │   │   # …and more (16 performance analyzers total)
│   │   ├── repo/                            # Source-code analysis backing --repo (7 files)
│   │   ├── security/
│   │   │   └── security-analyzer.ts         # HTTPS, security headers
│   │   │   # …and more (10 security analyzers total)
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
│   └── analyzers.test.ts        # Unit tests for analyzers (tsx --test)
└── README.md
```

## Key Files

### start.ts

Entry point that spawns the audit process as a child process. Handles process crashes by automatically restarting with `--proceed` flag to resume from saved progress.

### robots.ts

CLI entry/runner (~620 lines): one `audit()` function dispatching the sub-commands (`--sites`, `--validate-config`, `--generate-ci`, `--init-config`, comparison, `--repo`, history) and the main pipeline. Re-exports `SEOData` (which lives in `lib/seo-data.ts`) for programmatic use.

### lib/seo-data.ts

Thin orchestration layer (~620 lines) containing the `SEOData` class. Delegates heavy lifting to:

- `lib/crawler/crawler-engine.ts` - Page crawling and browser management
- `lib/orchestrators/audit-orchestrator.ts` - Page analysis workflow
- `lib/orchestrators/progress-manager.ts` - Checkpoint persistence
- `lib/utils/error-aggregator.ts` - Error tracking

### generateHTML.ts

Thin HTML report orchestrator (~470 lines). Composes reports using extracted modules:

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

Centralized CLI argument parsing. ~40 flags total — see `lib/args-parser.ts` (and `completions.sh`) for the full set; the README usage section is the canonical user-facing list. Common ones:

- `--origin=<url>` - Target website
- `--proceed` - Resume from saved progress
- `--perf` - Enable performance metrics
- `--save-html` - Save HTML snapshots
- `--screenshots` - Capture page screenshots
- `--concurrency=<n>` - Parallel crawling (1-20, default: 5)
- `--verify` - Phase 3 live verification (see Phase 3 above)
- `--llm` - run all optional LLM passes (section narrative, emergent-bug findings, source-repo reasoning, finding-revalidation; also Phase 4 competitor discovery + content-plan synthesis)
- `--content-research` - Phase 4 competitive content research (opt-in; see Phase 4 below)
- `--competitors=<csv|file>` - competitor hosts for `--content-research` (optional; LLM discovers when omitted; also `competitors: []` in `.seoauditrc`)
- `--phase2` / `--no-phase2` - curated PDF report (on by default)
- `--no-score` - strip scores and the scoring-rules explanation from the HTML report and the Phase 2 report (CSV export unchanged); with scores on, every score links to the generated `#score-rules` block (`lib/scoring/scoring-rules.ts`)
- `--preset=<name>` - `quick|standard|deep` (crawl speed) or role presets `sales|marketing|seo|custom` that also select report sections (in order) and finding groups; `--sections=<csv>` / `--checks=<csv>` build a `custom` one. Defined in `lib/presets.ts`; each preset, its data and rationale are in [`docs/audit-presets.md`](docs/audit-presets.md)
- `--evidence` / `--no-evidence` / `--evidence-cap=<n>` - per-page evidence capture

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

### Report theme preview

The HTML report uses the FocusReactive brand theme (dark, `#00E56D` accent, Inter) from `lib/reports/sections/design-tokens.ts`; `yarn run preview:report` renders `tests/fixtures/report-fixture/` into `web/public/report/index.html` (gitignored).

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
    ├── audit-history.json.gz           # Historical snapshots (gzip; legacy .json read as fallback)
    └── YYYY-MM-DD_HH-MM-SS/
        ├── manifest.json.gz             # Multi-file format index + evidence index
        ├── metadata.json.gz             # robots, sitemaps, CrUX, timing
        ├── analysis.json.gz             # Site-wide issues + summary
        ├── incoming-links.json.gz
        ├── pages/                       # Per-batch page JSONs
        ├── audit-report.md               # Phase 2 curated markdown
        ├── audit-report.html             # Phase 2 styled HTML (renderer input)
        ├── audit-report.pdf              # Phase 2 final curated PDF
        ├── phase2-state.json             # Phase 2 → Phase 3 boundary: render inputs (suppression, narratives, anomalies, noScore) for standalone re-verify
        ├── audit-report.verified.md      # --verify variant (Phase 3; refuted dropped; every issue labelled)
        ├── audit-report.verified.pdf     # --verify variant PDF (✓ Verified / unverified per issue)
        ├── audit-report.refuted.md       # --verify: the findings DROPPED as refuted (candidate false positives), with each reason; omitted when none refuted
        ├── content-research-report.md     # Phase 4 (--content-research): competitive gap matrix + content plan (+ .html, .pdf)
        ├── content-research-state.json    # Phase 4 render inputs (gaps, plan, competitors) for standalone re-run
        ├── content-research-data.json     # OPTIONAL input: { keywords:[{term,volume,difficulty}] } to enrich gap ranking
        ├── evidence/                    # Per-page evidence for sampled URLs
        │   └── <safe-filename>/
        │       ├── _meta.json           # { url, capturedAt } — self-describing
        │       ├── screenshot.mobile.png
        │       ├── screenshot.desktop.png
        │       ├── screenshot.firstload.png  # viewport shot right after load (pre-settle) — the CLS "before"
        │       ├── overlays.json        # issue-element rects (doc coords) + CLS shift sources + page meta + shot dims
        │       ├── requests.json        # Network log
        │       ├── accessibility.json   # Heuristic checks
        │       ├── axe.json             # axe-core 4.x findings
        │       ├── psi.mobile.json      # PageSpeed Insights lab (when --perf)
        │       └── psi.desktop.json
        └── domain.com.html              # HTML report
```

**Representative-page sampling.** Evidence is captured only for a small bucketed sample (`/`, `/section`, `/section/*`), capped at 10 pages by default. See `lib/crawler/representative-sampler.ts`. The manifest's `evidence` section indexes which URL → which evidence directory; `null` if no pages were sampled. Use `--no-evidence` to skip capture entirely, or `--evidence-cap=N` to change the limit (1–100).

**Issue-aware visual evidence.** For sampled pages, `lib/crawler/visual-overlay-collector.ts` measures document-coordinate rects of issue elements at evidence-capture time (images missing alt / oversized / legacy format, empty anchors, multiple H1s, small touch targets, interstitials, first CTA vs the fold, axe color-contrast nodes) into `overlays.json`, plus the page's title/description and the mobile screenshot's true CSS-px size (`shot` — a full-page capture can be wider than `scrollWidth` by the scrollbar gutter, and the renderer must size the bitmap from the capture's own dims or boxes drift). The vitals pass records CLS `sources[]` attribution (selector, previousRect, currentRect), and `#basicTest` grabs a first-load viewport shot for sampler-eligible pages (`wouldSample` peek). Phase 2 (`evidenceKindFor` + `buildEvidenceBlock` in `phase2-runner.ts`) then renders issue-aware evidence per finding: a CSS-cropped annotated screenshot with %-positioned highlight boxes, a CLS before/after pair (first-load vs settled, dashed ghost = pre-shift position), a SERP preview card for title/description findings, a **head snippet card** (reconstructed `<head>` with the offending/missing line flagged — canonical, noindex, hreflang, html-lang, charset, doctype; per-aspect honesty guards skip the card when the sampled page contradicts the claim), or a **data panel**: network breakdown by resource type / by origin with third-party flagged (aggregated from the sampled page's `requests.json` via `summarizeRequests`), per-file unused-code bars (CDP coverage summary persisted in `overlays.json` `panels.coverage`), and the render-blocking `<head>` resource list (`panels.renderBlocking`, measured in-page) — falling back to the plain mobile+desktop pair when the data is absent (old audits, `--no-evidence`). Slice 3 adds: **LCP evidence** (element highlighted on the shot via vitals `lcpSelector`/`lcpRect` attribution + a sub-parts breakdown panel), a **JS-off vs hydrated pair** (`screenshot.nojs.png`, captured in a throwaway `javaScriptEnabled:false` context per sampled page) for JS-rendering findings, **pagination-probe step screenshots** (`evidence/<safe>--pagination-probe/step-*.png`, written by `probeJsNext` only when the probe flags the series) rendered as a load→click→empty sequence, a **landmark overlay** for missing-`<main>` (tints present landmarks; skips when `<main>` exists), **form-label/autocomplete element overlays**, and **link-graph facts** (per-cited-URL inbound count + sitemap membership from `incoming-links.json.gz` + metadata + `manifest.progress.processedPages` — a crawled page absent from the inbound map renders as 0 inbound links; an uncrawled URL makes no claim). All geometry is pure render-time CSS over the existing PNGs (no image processing); the mapping invariants are documented on `annotatedFigureHtml`. The full issue → visual-evidence roadmap lives in [`docs/visual-evidence-matrix.md`](docs/visual-evidence-matrix.md).

**PSI lab capture** is gated on `--perf`. Runs mobile + desktop strategies for each sampled URL at concurrency 4. Honours `CRUX_API_KEY` env var; works keyless at reduced rate limits.

**Phase 2 — curated PDF report.** After the crawl, `lib/phase2/phase2-runner.ts` reads the manifest + analysis artifacts, routes findings into sections (Performance / SEO / Privacy / Accessibility / UX / Technical) using keyword categorisation, caps each section at 12 findings, and produces a styled PDF resembling the human audit-report examples. Template-driven by default; add `--no-phase2` to skip. PDF rendering is via Playwright `page.pdf()` with a custom stylesheet in `lib/reports/pdf-renderer.ts`. Add `--no-score` to strip all scores from the report — the per-category header projections (`current → ~projected`), the per-finding point chips (`+~N pts`), and the methodology paragraph that explains them; findings, severities, counts and fixes are unaffected. Implemented by threading `noScore` through `buildReportMarkdown`, which leaves the `ScoreImpact` model undefined (suppressing both annotation sites) and drops the scoring legend from `buildPurpose`. Alongside the report, Phase 2 persists **`phase2-state.json`** — the exact render inputs (LLM-suppression keys, narrative paragraphs, anomaly findings, `noScore`) — as the explicit **Phase 2 → Phase 3 boundary**, so the verification phase can re-render the verified report identically from disk alone.

**Report rules — ranking, severity, categorization & determinism.** The rules governing how findings are ranked (category priority SEO > Performance > UX > Privacy/Security > Accessibility > Technical), severity-moderated against category scores, categorized, de-duplicated, and kept **deterministic** (same crawl data → identical report for everyone, independent of concurrent crawl-completion order) are documented in [`docs/report-rules.md`](docs/report-rules.md) and enforced in `lib/phase2/` + `lib/scoring/score-calculator.ts` + `lib/utils/error-aggregator.ts`. Keep that doc, the code, and the determinism tests in `tests/analyzers.test.ts` in sync.

**Phase 4 — competitive content research (`--content-research`), opt-in & isolated.** A separate phase: `lib/phase4/phase4-runner.ts` exports `runContentResearchPhase(runDir, options)`, invoked by `robots.ts` after Phase 3 (its own try/catch + re-run hint — a failure can't lose the audit or the curated/verified reports; it is independent of `phase2Succeeded` because it reads Phase 1 artifacts directly). **Standalone re-runnable** — everything is on disk: `npx tsx -e "import {runContentResearchPhase} from './lib/phase4/phase4-runner'; runContentResearchPhase('<runDir>',{verbose:true})"`. It answers "what should we write next?" rather than "is the site healthy?": (1) loads our crawled pages (`loadAllPages`) and builds our topic map; (2) resolves competitors — explicit `--competitors=a.com,b.com` (CSV or file, also `competitors:[]` in `.seoauditrc`), else LLM discovery (`competitor-discovery.ts`, only with `--llm`; every suggested URL re-validated through `validateURL` + `isFetchAllowed` by `filterValidCompetitors` — anti-hallucination guard mirroring `parseLlmRepoFindings`); (3) **crawls a bounded sample of competitor content** (`competitor-crawl.ts` — self-contained Playwright, NOT the full `CrawlerEngine`, since only topic signal is needed: title/headings/`topKeywords`; bounded by `CONTENT_RESEARCH` constants — ≤5 competitors, ≤40 pages each, content/editorial paths prioritised from the competitor sitemap or a homepage link scrape, every URL through the SSRF guard); (4) **computes the competitive gap deterministically** (`competitive-gap.ts`, pure/unit-tested — reuses `ContentGapAnalyzer.buildKeywordIndex`/`clusterKeywords` so competitor topics are derived exactly like ours; flags topics competitors cover that we cover thinly/not-at-all (`missing`/`thin`) or where our best page is far shorter than theirs (`depth`), ranked by an opportunity score); (5) optional **injection enrichment** — `<runDir>/content-research-data.json` (`{ keywords:[{term,volume,difficulty}] }`) joins real search demand onto matching gaps and re-ranks; (6) **content plan** — `synthesizeContentPlan` (LLM, with `--llm`) or the templated `buildContentPlan` fallback. Emits a **separate** `content-research-report.{md,html,pdf}` (gap matrix + prioritized plan) via the shared `renderMarkdownToPdf`, plus a versioned `content-research-state.json`; the main report is never touched. **Keyless & graceful throughout:** no competitors + no LLM → falls back to surfacing our own thinnest topics (`computeSelfGaps`); a competitor unreachable → noted and skipped; no LLM → templated plan. LLM steps use the shared keyless transport (`lib/phase4/llm-client.ts` → API or `claude` CLI, disk-cached, `content-research` usage category) under the low-effort policy below.

**LLM effort policy.** Every LLM call this tool makes (the `--verify` LLM fallback, the `--llm` pass set — narrative, findings, repo, revalidation — and the Phase 4 content-research steps, across both the API and `claude` CLI transports in `lib/phase2/` + `lib/phase3/` + `lib/phase4/` + `lib/analyzers/repo/llm-repo-analyzer.ts`) must use **low effort**: no extended thinking on API calls, and the lowest effort/thinking setting available on the CLI. These tasks are simple classification/prose — low effort keeps cost and latency down. Apply this default when adding or modifying any LLM call.

**Optional LLM narrative (part of `--llm`).** The narrative pass rewrites each section's `**Analysis.**` paragraph from generic counts ("26 distinct findings…") into 2–3 sentences anchored in the actual findings list. **Keyless fallback like `--verify`:** with `ANTHROPIC_API_KEY` it calls the API; otherwise, if the `claude` CLI is on PATH it spawns it headless (shared transport in `lib/phase2/claude-cli.ts`). Disk-cached per audit (API and CLI replies under distinct keys) so re-runs are free. Falls back to templated prose silently only when neither transport is reachable or the call fails. Typical cost: ~$0.02–$0.03 per audit at Sonnet pricing.

**Phase 3 — verification (`--verify`), live re-fetch by default.** Verification is its own phase: `lib/phase3/verify-runner.ts` exports `runVerifyPhase(runDir, options)`, invoked by `robots.ts` after Phase 2 succeeds (its own try/catch + re-verify hint — a verify failure can't lose the curated report). Everything it needs is on disk (Phase 1 artifacts + `audit-report.md` + `phase2-state.json`), so it is **standalone re-runnable**: re-verify an existing audit against the live site at any later time, without re-crawling or re-running the LLM passes — `npx tsx -e "import {runVerifyPhase} from './lib/phase3/verify-runner'; runVerifyPhase('<runDir>',{verbose:true})"`. When `phase2-state.json` is absent (audits that predate it), verdicts are unaffected; the verified report just renders with templated prose, no anomaly findings, and no LLM suppression. The live pass (`lib/phase3/live-verifier.ts`) runs after the normal Phase 2 report is written and never touches it. It **parses the report just written** (`audit-report.md`), takes each finding's concrete example URLs — **all severities incl. LOW**; **sampling up to `MAX_SAMPLES_PER_FINDING` (3) distinct pages for a plural finding** (templated `…/page/{N}` series keys are not real pages) — **re-fetches them live** with Playwright, and re-asserts the claim against the _current_ page(s) — sidestepping the persistence gaps that left findings `unverified` on disk (third-party origins, iframe count, HTML-doc size, etc. are all present on a live page). Fetches are deduped and globally capped (`MAX_LIVE_FETCHES`, dropped sample URLs logged, never silent). Three verdicts: **confirmed** (`✓ Verified`), **refuted** (dropped + logged), **unverified** (no live checker, no example URL, page unreachable, or a site-level/cross-page/instrumentation-only claim a single light load can't settle). A guiding principle keeps it trustworthy: it **only refutes (drops) on STABLE signals** — DOM structure that's deterministic at load (canonical, SRI, DOM children, render-blocking head scripts, form autocomplete attrs) — and **never refutes on signals a single light load can under-observe or that vary between loads**. After `goto('load')` it waits for a capped `networkidle` (5s, ignored on timeout) so hydration settles. Four never-refute paths: (1) **load-dependent network aggregates** (third-party origins/requests/payload, ad-script bytes, total transfer, served-HTML size, image bytes) via `overOrUnsure` — `content-length` sums miss chunked responses and a light load under-triggers consent-gated/lazy/scroll resources; (2) **under-observable DOM signals** (thin-content word count, empty anchors, oversized/legacy images) via `presentOrUnsure` — these only mount after hydration or below-the-fold scroll, so absence at load is `unverified`, presence is `confirmed`; (3) **volatile signals** — TTFB (CDN POP / cache warmth) and iframe presence (consent-gated/lazy/facade iframes mount post-interaction) are confirm-only: over-threshold / present ⇒ `confirmed`, otherwise `unverified`, never refuted; (4) **multi-occurrence findings** via multi-example sampling (`aggregateSampledVerdict`) — up to 3 distinct example pages are re-fetched and their per-page results aggregated: ANY sampled page showing the defect ⇒ `confirmed`; EVERY sampled page clean ⇒ `refuted` **only when the sample covers the whole finding** (`sampled ≥ count`, e.g. a `count ≤ 3` finding fully sampled), otherwise `plural-undersampled` (unverified). This is the cautious replacement for the old first-example-only `guardPluralRefute`: a plural finding still never drops on partial evidence, but a fully-sampled clean finding can now legitimately refute. Confirm-only checkers never emit `refuted`, so a not-yet-loaded page can never drop a real finding. The banner counts over the FULL prepared finding set (all severities — `confirmed + refuted + unverified` sums to it), mirroring the legacy disk pass's total basis; **all severities are live-checked, including LOW** — when the global fetch budget (`MAX_LIVE_FETCHES`) is tight, sample URLs are collected in severity-priority order (CRITICAL→HIGH→MEDIUM→LOW) so a LOW finding's URLs are dropped before a high-severity finding's. Note this total spans every prepared finding, including section-capped and minor findings that render as summary lines without a per-finding badge, so the unverified tally can exceed the number of individually-badged blocks shown (same behaviour as the disk pass). Result is a **separate** `audit-report.verified.{md,pdf}` with a **timestamped** banner (the live site changes, so the report is point-in-time; the main report is never touched). **Refuted (dropped) findings are also saved to `audit-report.refuted.md`** — each with its severity, checker kind, re-checked URL, and the reason it was dropped — so the dropped set isn't lost to the console; a recurring refute there is a candidate analyzer false-positive to investigate (`writeRefutedReport`, shared by the live and offline passes; the file is omitted when nothing was refuted). Verdicts are keyed back to the in-memory findings by matching the parsed `### <title>` to `sanitizeProse(message)`, then rendered through the same `VerifyView` path as the disk pass. Add a per-page live checker by appending a `{ kind, match, check }` entry to the ordered `CHECKERS` registry. **Every finding kind in a report is OWNED by a checker — there is no "no live checker" fallback for known kinds.** Stable server-rendered signals confirm AND refute (plural-guarded): **title-length** / **description-length** (vs `TITLE_*`/`DESCRIPTION_*`), **missing-main** (`<main>`/`role="main"`), **privacy-link** (anchor href/text scan). Confirm-only additions: **tls** (navigation-timing handshake `connectEnd − secureConnectionStart`; volatile like TTFB). Cross-page **cannibalisation** (`SPECIAL_KINDS`) fetches the first 2 cited pages and confirms a shared title keyword (`sharedTitleKeyword`). Findings that cite NO per-page URL but describe a site-wide page property — **resource-hints** ("most pages lack preconnect/preload"), **eeat** ("low E-E-A-T across site") — are flagged `siteWidePage`; the orchestrator resolves the site origin (`resolveSiteOrigin`, most-cited on-site host) and runs them confirm-only against the homepage. Pure cross-page aggregates (**topic-coverage**: "topics with thin coverage", "content gaps") are owned by a `noFetch` checker that returns `unverified` with a site-level reason (route to the offline/LLM pass) rather than the "no live checker" gap. A further batch of **Tier-1 gap-closers** (kinds that previously hit the "no live checker" fallback in real reports) is now owned: confirm-AND-refute on stable signals — **url-length** / **url-depth** (measured on the cited URL vs `URL_LENGTH_MAX`/`URL_DEPTH_MAX`), **hreflang-duplicate** (duplicate `hreflang` in head), **multiple-h1** (`h1Count`), **social-tags** (Open Graph / Twitter Card presence), **video-schema** (`<video>` + JSON-LD `VideoObject`); confirm-only on under-observable signals — **form-labels** (controls lacking an accessible label / placeholder-as-label), **inline-css** (`<style>` bytes vs `INLINE_CSS_SIZE_WARNING`), **video-captions** (`<video>` without a caption/subtitle track), **lazy-loading** (many `<img>`, none `loading="lazy"`), **dead-end** (exactly-zero same-origin links — confirm-only, never refuted since a naive link count is broader than the crawl-graph notion), **structured-data-coverage** (`siteWidePage`, no JSON-LD on the homepage); plus site-level **crawl-budget** / **error-rate** `noFetch` checkers, the **robots-sitemap** SPECIAL checker (`Sitemap:` directive in `robots.txt`, mirrors `robots-ai`), and a widened **coverage** matcher that now also catches "unused JavaScript" wording. A **tranche-1** batch (more kinds that previously hit the "no live checker" fallback) adds: confirm-AND-refute on stable signals — **canonical-mismatch** ("loc and canonical don't match": compares the page's live canonical against the cited loc, `normUrl`-equalized for trailing-slash/fragment; a missing canonical is the separate `missing-canonical` finding, not a refute; plural-guarded); confirm-only on volatile / site-wide signals — **redirect-chain** ("multiple redirects" / "long redirect chain": counts live 3xx hops via `request().redirectedFrom()`, ≥2 confirms, never refutes since chains vary with geo/cookies/Accept-Language), **lcp-preload** (`siteWidePage`: "LCP images not preloaded across site" — confirmed when the homepage declares no `<link rel="preload" as="image">`; ordered BEFORE `vitals` so its `/\blcp\b/` matcher can't claim it); plus a second batch — confirm-AND-refute on the stable cited URL: **session-id** ("Session ID detected in URL": mirrors `UrlArchitectureAnalyzer`'s exact detection — a session-keyword query param or path `…sid=` assignment, NOT a bare substring, so the stale "re-**sid**-ent"/"residential" false positive correctly refutes); confirm-only on under-observable DOM: **too-many-links** (total `<a href>` vs `LINKS_PER_PAGE_WARNING` via `overOrUnsure` — link count only grows as JS hydrates), **affiliate-link** ("Affiliate link without sponsored/nofollow": scans for affiliate-looking hrefs missing both `rel=sponsored` and `rel=nofollow`, mirroring `ExternalLinksAnalyzer.isAffiliateLink`; MUST precede `empty-anchor`, whose `/links? without/` matcher would otherwise claim "…link without…"); and the SPECIAL **css-js-blocked** checker ("CSS/JS files may be blocked": fetches `robots.txt` once and confirms/refutes a wildcard `Disallow: /*.js`/`/*.css` under `*` or a major bot with no `Allow` override, mirroring `RobotsParser`; exempt from the plural guard like `robots-ai`). A **tranche-2** batch closes owned-but-mismatched and remaining stable gaps: the **form-labels** matcher was widened to also catch "placeholder as … only label" and "fields lack `<label>`" wordings; new confirm-AND-refute checkers — **missing-description** (`<meta name="description">` presence; placed after `description-length` so the "too short/long" wording stays with the length checker), **noindex** (`<meta name="robots">`/`googlebot` noindex OR an X-Robots-Tag header; distinct from the header-only `x-robots-noindex`); confirm-only — **total-image-size** (sum of image bytes vs `TOTAL_IMAGE_SIZE_MAX` via `overOrUnsure`); and two `noFetch` site-level kinds owned (not "no live checker" gaps) — **near-duplicate-content** (cross-page shingle similarity) and **ai-content-structure** (AEO composite score). A **tier-a** batch (kinds surfaced once LOW findings became live-checked) widens existing matchers and adds one checker: **duplicate** now also matches "identical title(s)/description(s)" (routes to `verifyDuplicate`), **near-duplicate-content** also matches "very similar content" (site-level relabel), and a new deterministic **url-case** checker ("URL contains uppercase letters" — confirms/refutes on the cited URL's path+query, no new signal). Genuinely not single-load-verifiable and left documented (not owned): source-maps-exposed (needs asset fetch), above-the-fold content (layout-fragile), robots.txt 429 (transient), srcset over-fetch (volatile sizing), and AI/repo-discovered findings (always no-checker by design). A **tier-b** batch adds NEW live-signal capture in `captureOne`'s DOM evaluate and the matching checkers: confirm-AND-refute on server-rendered signals — **h2-count** (`h2Count` vs `H2_COUNT`), **pwa-manifest** (`<link rel=manifest>`; also owns "app not installable"), **theme-color**, **apple-touch-icon**, **noscript** (`<noscript>` presence); confirm-only on under-observable signals — **inline-js** (`inlineJsBytes` vs `INLINE_JS_SIZE_WARNING`), **video-poster** / **video-title** / **autoplay-video** (`videosWithoutPoster`/`videosWithoutTitle`/`autoplayVideosNoControls`), **http-internal-links** (`httpInternalLinks`). A **tier-c** batch closes most of the remaining floor: confirm-AND-refute — **skipped-heading** (`hasHeadingSkip` from the rendered heading sequence), **freshness** (per-page date markup — `hasFreshnessSignal`); confirm-only — **redirect-served** (live `redirectCount`>0), **redirect-temporary** (a 302/303/307 in `redirectStatuses`), **text-html-ratio** (`textHtmlRatio` < 25%); the **site-graph** matcher was widened to own "clicks from homepage" wording (confirms via the persisted crawl graph); and a final **cross-page-aggregate** `noFetch` checker (kept LAST in `CHECKERS`) relabels genuine whole-crawl aggregates (anchor-text distribution, internal-link-graph opportunities, hub pages, site-wide thin-content/freshness/author coverage, cross-page URL patterns, sitemap crawl coverage) as **site-level** rather than the misleading "no live checker". This took the static no-checker set 53→16 across tiers A+B+C. Genuinely irreducible (NOT owned, by design or single-load-impossible): robots.txt rule findings (sensitive paths / wildcard patterns), CSS-introspection kinds (font-display FOIT, prefers-reduced-motion — cross-origin stylesheets throw on `cssRules`), runtime-only (service worker), DNS (IPv6/AAAA), layout-fragile (above-the-fold conversion), crawl-level pagination (load-more / truncated series), and AI/repo-discovered findings.

**Verdict taxonomy + breakdown (trustworthiness).** Every live verdict carries a categorized `reasonCode` (`VerdictReason`) and a `confidence` (`high`/`medium`/`low`), so the formerly-opaque `unverified` bucket is broken down honestly: the verified report's banner includes a **"Why findings are unverified"** line (`verdictBreakdownLine`) counting each category — `no-checker` / `no-example` / `unreachable` / `under-observable` / `load-dependent` / `volatile` / `site-level` / `plural-undersampled` / `llm-unsure` / `inconclusive`. None are defects — each is a deliberate non-decision. Codes are set at the source: `confirmed`/`refuted` from the helpers, `load-dependent` from `overOrUnsure`, `under-observable` from `presentOrUnsure`, `volatile` on TTFB/TLS/iframe/INP, `site-level` on the `noFetch`/`siteWidePage` checkers, `plural-undersampled` from the sampler.

**Response-header / robots checkers.** `captureOne` now records the main-document response headers (`LiveSignals.headers`, lowercased) and the `<html lang>`, enabling stable confirm-AND-refute checkers: `x-robots-noindex`, `missing permissions-policy`, `cross-origin-isolation` (COOP+COEP), `server-disclosure` (Server / X-Powered-By), `vary-user-agent`, `content-language-mismatch`, and `compression` (generic + Brotli-specific). An empty header map → `unverified` (`unreachable`), never a false refute. A `robots-ai` SPECIAL_KIND verifier (`robotsAiVerdict`) fetches `robots.txt` once and checks AI-crawler rules ("no explicit AI crawler rules" / "AI crawlers blocked") — site-wide and fully representative, so exempt from the plural guard.

**LLM stage in the LIVE pass (not just offline).** After the deterministic live checkers, `runLiveLlmStage` packages the still-`unverified` findings with the FRESH live signals (`liveSignalsSnapshot`) and asks the LLM (injected `verify-verdicts.json` > API > keyless `claude` CLI, same priority as the offline pass). Caution preserved exactly: the LLM may only **upgrade to confirmed** (rendered `✓ Verified (AI)`); an LLM "refuted" is a kept-but-flagged **AI-disputed** note, never a drop. Honors the low-effort LLM policy.

**Vision verification of AI-discovered findings (Slice 4).** `verifyAnomaliesLive` re-fetches each findings-pass anomaly's cited page, screenshots it (`captureAnomalyEvidence`), and asks the LLM whether the emergent UX/layout bug still manifests — **vision on the API transport** (`llmVerifyFindingsVision`, one call per item with the screenshot), **signals-only on the keyless CLI** (text-only, mirroring `llm-anomaly`). Anomalies render from `state.anomalies` (keyed by title, not in `baseDetails`), so their AI confirmations go into the rendering `aiConfirmed` set but are excluded from the `renderedTotal`-based unverified tally. Confirm/flag-dispute only — never a drop. Coverage is guarded by a test (`tests/analyzers.test.ts`) asserting every known finding kind resolves to a real checker, never the "no live checker" fallback.

**Full per-page instrumentation (not a light load).** `captureOne` runs what the crawler runs: auto-scrolls to trigger lazy/below-the-fold content, records accurate transfer sizes via `request.sizes()` (not `content-length`), and captures CDP **CSS/JS coverage** (unused-code/CSS), a `PerformanceObserver` for **CLS + TBT**, **pre-consent cookies** (third-party / known-tracker names present before any interaction), and an **axe-core color-contrast** scan. **Device + network/CPU parity:** the context uses the crawler's mobile device profile (`VIEWPORT` + `deviceScaleFactor`/`isMobile`/`hasTouch`), and the crawl now records its throttle profile (`results.crawlProfile` → `metadata.json.gz`); the live pass reads it (`loadCrawlThrottle` in `lib/phase3/verify-runner.ts`) and re-applies the same network/CPU throttle via CDP, so TTFB/CLS/TBT are measured on equal footing (without throttle, CLS/TBT read ~0 and stay unverified). **Special (non-per-page) kinds** handled by dedicated async verifiers in `verifyReportLive` (`SPECIAL_KINDS`): **duplicate** title/description (fetches the first 2 example pages and compares), **cannibalisation** (first 2 cited pages → shared title keyword), **site-graph** (`missing-from-sitemap` / `not (listed )?in sitemap` against the sitemap URL set; `orphan`/`unreachable`/`click-depth`/`low-link-equity` against the link graph. **The live pass prefers the PERSISTED full-crawl graph** — `runVerifyPhase` passes `loadSiteData(runDir)`'s inbound graph + homepage click-depth + sitemap set as `LiveVerifyOptions.siteData`, so these are adjudicated over the WHOLE crawl (uncapped): `orphan` confirms zero-inbound / refutes on inbound>0 (`verifyOrphan`), `unreachable` over the full reachable set (`reachabilityCapped:false`), `click-depth`>`CLICK_DEPTH_BAR` and `low-link-equity`≤`LOW_EQUITY_BAR` confirm-only (mirroring the offline bars). Only a pure standalone run with no `siteData` falls back to the bounded 120-page live BFS + live sitemap fetch — where, if the BFS hits the cap, a missing page is `unverified`, never a false orphan), and **broken-pagination** (probes `…/page/9999`: a 4xx is a refute, a 200 with thin content confirms unbounded pagination). **Set `SEO_AUDIT_VERIFY_OFFLINE=1` to use the legacy deterministic disk pass below instead** (reproducible, no network, no API key).

**Legacy deterministic verification (`SEO_AUDIT_VERIFY_OFFLINE=1`).** `lib/phase3/finding-verifier.ts` runs after the normal Phase 2 report is written and never touches it. For each surviving finding it picks the **first concrete example** and re-checks the claim against the crawl data already on disk (`pages/*.json.gz` — titles, descriptions, canonicals, status codes, redirect chains, H1s, alt-image counts, `noindex`, sitemap membership are recorded for _every_ crawled page, not just the sampled ones). Deterministic, no network, no API key. Each finding gets a verdict: **confirmed** (re-checks out → labelled `✓ Verified`), **refuted** (data contradicts it → auto-dropped, each logged with its reason), or **unchecked** (no verifier owns the kind, or the cited URL/signal isn't on disk — e.g. a broken _external_ link → kept and labelled _unverified_, a neutral "no deterministic check applies" marker, NOT a defect). The result is a **separate** `audit-report.verified.{md,pdf}` (the normal `audit-report.*` is never touched) with a banner summarising the counts; every surviving issue carries its status in its header. The per-issue labels render ONLY in this report — gated by a `VerifyView` object threaded through `buildReportMarkdown`; absent for the normal report. A persistence caveat drove the design: storage strips/rewrites some `PageInfo` fields, so the verifiers read the fields that actually survive — `headings.h1Count` (not the stripped top-level `h1`), `indexability.hasNoindexTag` (not top-level `noindex`), `hasRedirects`/`redirectCount` (not the stripped `redirectChain`), `soft404`, and an "analyzed" gate (presence of `indexability`) so an absent `canonical`/`description` on an analyzed page reads as genuinely-missing while an absent field on a non-analyzed page stays `unchecked`. An absent field must never auto-drop a finding. Verifier kinds today: duplicate title/description, missing canonical/description, multiple-h1 (excludes keyword-cannibalisation wording so a same-keyword finding isn't dropped on a single page's H1 count), not-in-sitemap, noindex, redirect, soft-404; threshold checks that cross-check the persisted per-page metric against `THRESHOLDS` (CWV LCP/FCP/TTFB/TBT/TTI/CLS/INP, title/description length, page size, request count, h2 count); content volume (thin/expand, confirm-only); boolean per-page checks (console errors, per-page broken outbound links, author attribution); and a set of **confirm-only** checks against the rich analyzer sub-objects — empty-anchor (`anchorTextData.emptyAnchors`), oversized-images / legacy-image-format / excessive-image-size (`imageOptimization`), unused-code / unused-css (`codeCoverage`), render-blocking (`resourceOptimization.renderBlocking`), dom-children / excessive-dom (`domComplexityData`), third-party-payload (`thirdPartyData.totalSize`), tracking-before-consent (`consentData`). Confirm-only: missing-alt, thin/expand-content, and all the sub-object checks just listed (their persisted signal is a broader proxy than the exact finding, so a non-match stays `unchecked`, never a drop). Also confirm-only: contrast-aaa/contrast-aa (`colorContrastData.aaFailures/aaaFailures`), sri-missing (`sriData.missingIntegrity`), permissions-policy (`permissionsPolicyData`), cross-origin-isolation (`crossOriginPolicyData`), reduced-motion (`reducedMotionData`), autocomplete-missing (`formData.inputsWithoutAutocomplete`), too-many-fonts (`fontData.totalFonts`). `verifyShared` also handles single-cited "identical title/description" findings by scanning the FULL page index for ≥2 pages sharing the quoted value (prefix-matched, since description quotes are truncated). **Site-level verifiers** read a `SiteData` object (`loadSiteData` → `incoming-links.json.gz` + `metadata.json.gz`, threaded through `verifyFinding`/`verifyDetails` as an optional 4th arg): orphan-page / unreachable / click-depth (BFS from the homepage over the forward graph) / low-link-equity from the inbound link graph; robots-sensitive / robots-wildcards / robots-no-ai from `robots`; sitemap-not-crawled (cited URLs absent from the index) and the count-only "indexable pages missing from sitemap" (index scan of `indexability.isIndexable` vs the sitemap URL set). Two table-driven factories (`numericVerifier`, `booleanVerifier`) make adding per-page kinds a one-liner. On the lunacy reference run this lifts confirmed findings from 6 → 26 with 0 false refutations; on the siro.ai run the sub-object + site-level checks lift data-confirmed 26 → 55 (107 → ~50 still-unverified once the keyless CLI pass runs).

**LLM fallback (`lib/phase3/llm-finding-verify.ts`).** `--verify` runs a second stage over the findings the deterministic pass left `unchecked`: `collectUncheckedContexts` packages each with its first example + a compact `buildPageSignals` snapshot of the cited page, and Claude returns confirmed / refuted / unsure per finding (batched, disk-cached). **Two transports, auto-selected so a key is never required:** when `ANTHROPIC_API_KEY` is set it POSTs to the API (`llmVerifyFindings`, vanilla HTTPS, parallel batches); otherwise, if the `claude` CLI is on PATH it spawns it headless (`claudeCliVerifyFindings` → `claude -p --output-format json`, prompt on stdin, `extractCliResult` unwraps the `.result` envelope, then the SAME `parseLlmVerdicts`; uses the user's login — no key, no SDK). The CLI path is sequential, 180s/batch timeout, inherits the user's default model (no `--model` passed), and is disabled by `SEO_AUDIT_SKIP_CLAUDE_CLI=1` (binary overridable via `SEO_AUDIT_CLAUDE_CLI_BIN`). Both transports degrade silently to `[]` on any failure, leaving the deterministic result unchanged. LLM-confirmed → labelled **✓ Verified (AI)** (distinct from deterministic ✓ Verified); LLM-refuted → kept and logged as **AI-disputed** (the LLM never drops — only the deterministic pass does, since LLM judgment over partial evidence is too uncertain to silently remove a finding); unsure → stays _unverified_. The original report is still never touched. `buildPageSignals` surfaces a broad slice of the persisted analyzer sub-objects (`domComplexityData`, `anchorTextData`, `consentData` cookies, `codeCoverage`, `aeo`, `pwaData`, `security.missingHeaders`, `thirdPartyData`, `freshnessData`, `imageOptimization`, …) so the model can actually adjudicate most kinds; the wider the snapshot, the fewer "unsure".

**Site-wide rollup.** `buildSiteAggregate(pages)` computes cross-page counts (status distribution, PWA/analytics/structured-data/author/date-markup coverage, avg semantic-HTML ratio, trailing-slash split, thin-content pages, total empty anchors) and is passed to `llmVerifyFindings` as `siteContext`, included ONCE per batch prompt. This is what lets the LLM confirm "most/all pages lack X" and crawl-budget findings a single page can't prove.

**Three ways to supply LLM verdicts, in priority order (the first two need no API key):** (1) `--verify` reads `<runDir>/verify-verdicts.json` if present — a `{ findings: [{ key, verdict, reason }] }` file any Claude session (Claude Code, spawned subagents) can produce by reasoning over `collectUncheckedContexts(...)` + `buildSiteAggregate(...)`; injection wins over everything. (2) When `ANTHROPIC_API_KEY` is set, the live API call. (3) Otherwise, if the `claude` CLI is available, it is spawned headless (keyless). So with no key and no injected file, `--verify` still runs the full LLM stage by spawning the CLI. On the lunacy reference run, deterministic + LLM (rich per-page signals + site rollup) reached **73/125 confirmed** (26 data + 47 AI), 3 AI-disputed, 52 unverified. The remaining floor is genuinely un-derivable from current artifacts: topic-clustering claims, DNS/IPv6, robots.txt rules, off-page link targets, internal-link-graph (orphan/dead-end/reachability), response-header specifics, per-script coverage, near-duplicate content. AI-disputed findings (e.g. resource-hint findings contradicted by `resourceHints.preload:true`) are useful candidate analyzer false-positives to investigate. Verifier kinds live in an ordered registry in `finding-verifier.ts`; add a kind by appending a `{ match, verify }` entry. AI-discovered findings are always `unchecked`.

**Optional LLM repo layer (part of `--llm`, active with `--repo`).** The repo pass (`lib/analyzers/repo/llm-repo-analyzer.ts`) is the reasoning layer ON TOP OF the deterministic `--repo` analyzers — it never replaces them; the deterministic core is the fast, exact, reproducible substrate and the LLM uses it as **grounding**. It meets the three goals pure static analysis can't: (1) **find more** — issues no hardcoded rule enumerates; (2) **confirm** — does the source actually explain a given crawl finding, and how; (3) **fix** — a concrete, code-aware suggestion. `robots.ts` builds a `RepoContext` (framework facts + deterministic `knownIssues` + the crawl's `crawlFindings` from `analysis.details` + the source-mapper's `sourceMapFiles`), `gatherSourceFiles` reads a bounded, traversal-guarded set of high-signal files (config + framework entry points + source-map-cited files; capped count + per-file size), and the model returns validated `LlmRepoFinding`s. **Trust model mirrors `--verify`:** the LLM only ADDS findings (never drops a deterministic one), and `parseLlmRepoFindings` DROPS any finding citing a file not in the provided context (anti-hallucination). Findings are tagged `🔍 AI-discovered`, rendered in the Source Code Analysis section (with the **Fix**) and merged into the aggregator. **Keyless fallback like `--verify`:** API with `ANTHROPIC_API_KEY`, else headless `claude` CLI via the shared `lib/phase2/claude-cli.ts` transport; disk-cached per audit; returns `[]` on any failure / no transport / no source. Its own try/catch in `robots.ts` means an LLM failure can never lose the deterministic repo result.

**Optional LLM anomaly detection (part of `--llm`).** The findings pass (`lib/phase2/llm-anomaly.ts`) reasons over each representative page's evidence — the desktop screenshot (vision) plus structured signals (buttons, links + HTTP statuses, forms, pagination state incl. `infiniteScrollDetected`/`totalPages`, failed network requests) — to surface _emergent_ functional/UX bugs the deterministic analyzers can't enumerate: dead buttons, CTAs to 404s, never-terminating pagination, forms posting nowhere, visually broken layout, placeholder content. Each finding is merged into its section as a synthetic finding tagged `🔍 AI-discovered` (with an **Evidence** block and the model's recommendation as the **Fix**), never mixed silently with deterministic results. **Per-page anomalies are consolidated into one finding per defect class before rendering** (`consolidateAnomalies` in `phase2-runner.ts`, run once before both `buildReportMarkdown` and `writePhase2State` so the report and the Phase 3 verify pass agree): the model emits a stable kebab-case `kind` slug per finding and anomalies sharing a `kind` collapse into a single multi-occurrence finding (`occurrences[]`, worst severity wins, dominant section) — **grouped across sections** since the same defect is sometimes filed under `ux` on one page and `technical` on another; instead of N near-identical "affects 1 occurrence" findings. Caches predating the `kind` field fall back to normalized-title grouping (kept section-scoped, conservative). Same client pattern as the narrative pass: dependency-free HTTPS, disk-cached per page (incl. image bytes), returns `[]` on any failure or when evidence is absent (e.g. `--no-evidence`). **Keyless fallback like `--verify`:** with `ANTHROPIC_API_KEY` it calls the API with vision; otherwise, if the `claude` CLI is on PATH it spawns it headless via the shared `lib/phase2/claude-cli.ts` transport — but that path is **signals-only** (headless `claude -p` is text-only, so the screenshot is dropped and only signal-derived anomalies — dead links, failed requests, unbounded pagination, form actions — are reachable; cache keyed separately by transport). CLI runs sequentially (parallel for the API). Bounded to the representative-page sample; ~$0.02–$0.05 per page.

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
  - _Post-crawl (`broken-pagination-analyzer.ts`)_ — groups crawled pages by series key (`/page/{N}`, `?page=N`, …), finds a contiguous broken tail (soft-404 OR thin + near-duplicate), and reports a HIGH finding. Corroborated by `truncatedPaginationSeries` (series that hit the discovery cap).
  - _Active probe (`pagination-analyzer.ts`)_ — for JS-driven "next" controls with no static href, opens an isolated page and clicks "next" up to a bounded number of times; flags when the control stays enabled while content stops changing or empties out. Budget-capped per audit (`BROKEN_PAGINATION_MAX_PROBES`).

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

## Git Workflow

Work directly on `main`. **Do not create branches in this repo** — commit to `main`, even when default guidance suggests branching first.

## License

ISC

## Author

Sergey Labut
