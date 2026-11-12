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

## Architecture

Full file tree and design notes live in `docs/architecture.md`. **Read the matching section there before changing** the crawler/evidence capture, Phase 2 report (`lib/phase2/`), Phase 3 verification (`lib/phase3/`, live checkers and their never-refute rules), Phase 4 content research (`lib/phase4/`), or the `--llm` / `--repo` layers. Report ranking rules: `docs/report-rules.md`.

**LLM effort policy.** Every LLM call this tool makes (the `--verify` LLM fallback, the `--llm` pass set — narrative, findings, repo, revalidation — and the Phase 4 content-research steps, across both the API and `claude` CLI transports in `lib/phase2/` + `lib/phase3/` + `lib/phase4/` + `lib/analyzers/repo/llm-repo-analyzer.ts`) must use **low effort**: no extended thinking on API calls, and the lowest effort/thinking setting available on the CLI. These tasks are simple classification/prose — low effort keeps cost and latency down. Apply this default when adding or modifying any LLM call.

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
- `--visual` - run the visual (UI defect) analyzers: broken images/media, template tokens, lorem ipsum, mojibake, clipped text (opt-in)
- `--no-agentic` - skip the agentic browsing checks (accessible name, click target role, form label, hover-only content, llms.txt); on by default
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

- **favicon-manifest-validator.ts**: Site-wide favicon and web manifest fetch checks (status, content type, icon size, manifest JSON and icons)
- **caching-analyzer.ts**: CDN detection, cache headers, Service Worker
- **image-optimization-analyzer.ts**: Image format, size, lazy loading, upscaled `<img>` without srcset and upscaled CSS background images
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
- **site-text-files-analyzer.ts**: security.txt (RFC 9116) and ads.txt / app-ads.txt checks, fetched once before the crawl

### Site-Wide Validators

- **analytics-validator.ts**: Cross-site tracking consistency
- **duplicate-checker.ts**: Duplicate titles and descriptions
- **indexability-validator.ts**: Site-wide indexability issues
- **international-seo-validator.ts**: Language implementation consistency
- **link-structure-analyzer.ts**: Internal link patterns
- **social-media-validator.ts**: Social meta tag consistency
- **structured-data-validator.ts**: Schema markup consistency

### Visual (`visual` check family)

Opt-in via `--visual` (or `visual: true` in `.seoauditrc`; `--no-visual` overrides). Findings route to the UX section; Phase 3 never refutes them. The run's metadata records `visual` (a `--proceed` resume keeps the checkpoint's value), and a clean run shows "No UI issues found" in the HTML and Phase 2 reports. The HTML report has a dedicated **UI Issues** section with crawl-time screenshots of each defect and highlight boxes (`lib/crawler/visual-shot-capture.ts`, `lib/reports/sections/ui-issues.ts`; needs evidence on).

- **broken-media-analyzer.ts**: Broken `<img>` (loaded with naturalWidth 0) and failed 4xx/5xx image/media requests
- **text-integrity-analyzer.ts**: Unrendered template tokens (`{{ }}`, `undefined`, `NaN`, `[object Object]`), lorem ipsum, mojibake, clipped text

Spike notes on screenshot diffing and an LLM vision pass: `docs/visual-checks-spike.md`.

### Agentic Browsing (`agentic` check family)

On by default; `--no-agentic` (or `agentic: false` in `.seoauditrc`) turns it off. `lib/analyzers/agentic/` — findings go to the Agentic Browsing section with its own `agentic` score; Phase 3 never refutes them.

- Interactive elements without an accessible name (HIGH)
- Unlabeled click targets without an interactive role (MEDIUM)
- Form inputs without a form label (HIGH)
- Content reachable only via hover-only or JS-only interactions (MEDIUM)
- llms.txt missing (LOW) or invalid (MEDIUM) — checked once per site, reusing the AEO fetch

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

### Web app live progress

When `AUDIT_PROGRESS_FILE` is set, `ProgressReporter` (`lib/utils/progress-reporter.ts`) writes `{processed,total,phase,updatedAt}` there (throttled, atomic). `.github/workflows/audit.yml` uploads it every ~20s via `web/scripts/upload-results.mjs --progress` to `audits/<runId>/progress.json`; `GET /api/runs/<runId>` merges it as `progress`, and the home page (`web/app/page.tsx`, helpers in `web/lib/audit-progress.ts`) shows a blocking progress overlay, then embeds the finished report. See `web/README.md`.

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
- Sitemap image/video/news extension errors: `<image:image>` without `<image:loc>`, more than 1000 images per URL, video missing thumbnail/title/description/content-or-player or with a duration outside 1–28800 s, news missing name/language/publication date/title, media URLs that are not absolute, and extension tags without an `xmlns` declaration (LOW)
- Sitemap image/video URLs that fail to load (main audit only; up to 50 URLs, 5 at a time; redirects followed; 401/403/429 counted as blocked, not failed)

### Pagination / Crawl-Budget Issues

- **Broken / infinite pagination** — a "next" link that keeps advancing past the real last page into empty, duplicate, or soft-404 listings (HTTP 200, no real content). Wastes crawl budget. Detected two ways:
  - _Post-crawl (`broken-pagination-analyzer.ts`)_ — groups crawled pages by series key (`/page/{N}`, `?page=N`, …), finds a contiguous broken tail (soft-404 OR thin + near-duplicate), and reports a HIGH finding. Corroborated by `truncatedPaginationSeries` (series that hit the discovery cap).
  - _Active probe (`pagination-analyzer.ts`)_ — for JS-driven "next" controls with no static href, opens an isolated page and clicks "next" up to a bounded number of times; flags when the control stays enabled while content stops changing or empties out. Budget-capped per audit (`BROKEN_PAGINATION_MAX_PROBES`).

### International / Hreflang Issues

- Hreflang alternates that are not fully-qualified URLs (relative or protocol-relative)
- Self-referential hreflang missing
- Bidirectional hreflang reciprocity violations
- Duplicate hreflang assignments within a language group

### Visual Issues

- Broken images detected (HIGH); failed image or media requests (MEDIUM)
- Images / CSS background images upscaled beyond natural resolution (LOW/MEDIUM)
- Unrendered template tokens in page text (HIGH); placeholder text (lorem ipsum) (MEDIUM)
- Garbled characters (mojibake) in page text (MEDIUM); text clipped by its container (LOW)

### Site Text Files

- security.txt: missing (LOW); no `Contact` (MEDIUM); `Expires` missing, unparseable or past (MEDIUM); `Expires` more than a year ahead (LOW); not `text/plain` (LOW); only at legacy `/security.txt` (LOW). PGP cleartext-signed files are unwrapped (signature not verified)
- ads.txt / app-ads.txt: invalid record lines (LOW); missing ads.txt (MEDIUM) only when a crawled page has a detected ad network (decided post-crawl; refetched on resume from an older checkpoint)
- An HTML / soft-404 response or a redirect to another host (apex ↔ `www.` counts as same host) counts as a missing file; network errors give no finding

### Favicon / Manifest Issues

Site-wide, fetched once per audit (`favicon-manifest-validator.ts`); timeouts, network errors and SSRF-blocked or `data:` URLs give no finding. On resume from an older checkpoint (pages without captured head links) icon/manifest links are read from the homepage; if it cannot be read, no "Favicon missing" is reported.

- Favicon missing — no `<link rel="icon">` and `/favicon.ico` returns non-2xx or an HTML page (MEDIUM)
- Favicon returns error status / is not an image (MEDIUM); favicon smaller than 48px (LOW)
- Web manifest failed to load, invalid manifest JSON, manifest icon returns 404 (MEDIUM)

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
