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

- **Runtime**: Node.js
- **Browser Automation**: Playwright (Chromium)
- **HTML Parsing**: node-html-parser
- **Performance Monitoring**: Web Vitals API
- **Output**: JSON (gzip compressed), HTML reports, CSV exports

## Project Structure

```
audit-tool/
├── start.js                    # Entry point - spawns audit with restart capability
├── robots.js                   # SEOData class - thin orchestration layer (~380 lines)
├── generateHTML.js             # HTML report generator - thin orchestrator (~190 lines)
├── generateCSV.js              # CSV export generator
├── generateComparison.js       # Audit comparison HTML report
├── historyManager.js           # Historical audit tracking
├── validators.js               # Input validation and sanitization
├── lib/
│   ├── args-parser.js          # CLI argument parsing
│   ├── args-parser.js          # CLI argument parsing
│   ├── config-loader.js        # Configuration file loading (.seoauditrc)
│   ├── constants.js            # Centralized configuration and thresholds
│   ├── utils.js                # Shared utility functions
│   ├── analyzers/
│   │   ├── accessibility/
│   │   │   ├── accessibility-analyzer.js    # WCAG 2.1 compliance
│   │   │   └── mobile-friendly-analyzer.js  # Mobile viewport testing
│   │   ├── analytics/
│   │   │   └── analytics-tracking-analyzer.js  # GA4, GTM verification
│   │   ├── content/
│   │   │   ├── content-quality-analyzer.js  # Readability, word count
│   │   │   ├── freshness-analyzer.js        # Content freshness, update signals
│   │   │   ├── link-quality-analyzer.js     # Link analysis
│   │   │   └── thin-content-analyzer.js     # Thin/insufficient content detection
│   │   ├── international/
│   │   │   └── international-seo-analyzer.js  # hreflang validation
│   │   ├── performance/
│   │   │   ├── caching-analyzer.js          # CDN, cache headers
│   │   │   ├── image-optimization-analyzer.js  # Image optimization
│   │   │   └── resource-optimization-analyzer.js  # Render-blocking
│   │   ├── security/
│   │   │   └── security-analyzer.js         # HTTPS, security headers
│   │   ├── seo/
│   │   │   ├── advanced-schema-validator.js # Detailed schema validation (FAQ, Product, etc.)
│   │   │   ├── aeo-analyzer.js              # AI Search Readiness (AEO), llms.txt, AI crawlers
│   │   │   ├── crawlability-analyzer.js     # Robots.txt analysis
│   │   │   ├── eeat-analyzer.js             # E-E-A-T signals (author, trust, expertise)
│   │   │   ├── heading-analyzer.js          # H1-H6 structure
│   │   │   ├── image-analyzer.js            # Alt text validation
│   │   │   ├── indexability-analyzer.js     # Canonical, noindex
│   │   │   ├── structured-data-analyzer.js  # Schema.org markup
│   │   │   ├── technical-seo-analyzer.js    # Meta refresh, CMS detection, JS frameworks, DOCTYPE, iframes, HTML size
│   │   │   └── url-architecture-analyzer.js # URL structure, parameters, depth
│   │   ├── site-wide/
│   │   │   ├── analytics-validator.js       # Cross-site tracking
│   │   │   ├── duplicate-checker.js         # Duplicate content
│   │   │   ├── indexability-validator.js    # Site-wide indexability
│   │   │   ├── international-seo-validator.js  # Language consistency
│   │   │   ├── keyword-cannibalisation-analyzer.js # Keyword conflicts detection
│   │   │   ├── link-structure-analyzer.js   # Internal link patterns
│   │   │   ├── link-depth-analyzer.js       # Orphan pages, link depth analysis
│   │   │   ├── social-media-validator.js    # Social meta tags
│   │   │   └── structured-data-validator.js # Schema consistency
│   │   └── social/
│   │       └── social-media-analyzer.js     # OG tags, Twitter cards
│   ├── crawler/
│   │   ├── crawler-engine.js    # Page crawling, browser management, analysis
│   │   └── vitals-collector.js  # Core Web Vitals collection
│   ├── orchestrators/
│   │   ├── audit-orchestrator.js   # Site-wide validation, page analysis workflow
│   │   └── progress-manager.js     # Checkpoint persistence and restoration
│   ├── parsers/
│   │   ├── robots-parser.js     # Robots.txt parsing
│   │   └── sitemap-parser.js    # Sitemap XML parsing
│   ├── reports/
│   │   ├── data-processor.js    # Report data loading and processing
│   │   ├── html-utils.js        # HTML helper functions (escaping, formatting)
│   │   ├── metrics-metadata.js  # Thresholds and metric definitions
│   │   └── sections/            # HTML report section generators
│   │       ├── index.js         # Section exports
│   │       ├── styles.js        # CSS styles
│   │       ├── scripts.js       # JavaScript (charts, interactivity)
│   │       ├── executive-summary.js
│   │       ├── quick-wins.js
│   │       ├── top-issues.js
│   │       ├── performance-stats.js
│   │       ├── historical-progress.js
│   │       ├── charts-section.js
│   │       ├── config-info.js
│   │       └── pages-table.js
│   ├── scoring/
│   │   └── score-calculator.js  # Score calculation and recommendations
│   ├── storage/
│   │   └── file-manager.js      # File operations, compression, archiving
│   └── utils/
│       ├── error-aggregator.js  # Error tracking and aggregation
│       ├── progress-reporter.js # Real-time crawl progress display
│       └── cli-summary.js       # CLI summary output after audit
├── package.json
└── README.md
```

## Key Files

### start.js
Entry point that spawns the audit process as a child process. Handles process crashes by automatically restarting with `--proceed` flag to resume from saved progress.

### robots.js
Thin orchestration layer (~380 lines) containing the `SEOData` class. Exports `SEOData` for programmatic use. Delegates heavy lifting to:
- `lib/crawler/crawler-engine.js` - Page crawling and browser management
- `lib/orchestrators/audit-orchestrator.js` - Page analysis workflow
- `lib/orchestrators/progress-manager.js` - Checkpoint persistence
- `lib/utils/error-aggregator.js` - Error tracking

### generateHTML.js
Thin HTML report orchestrator (~190 lines). Composes reports using extracted modules:
- `lib/reports/data-processor.js` - Data loading and processing
- `lib/reports/html-utils.js` - HTML helper functions
- `lib/reports/sections/` - Template section generators

### lib/crawler/crawler-engine.js
Core crawling engine handling:
- Browser lifecycle management (Playwright)
- Batch processing with concurrency control
- Page analysis orchestration (runs all analyzers)
- Network/CPU throttling for performance testing
- Redirect chain tracking
- Link discovery and incoming link tracking

### lib/orchestrators/audit-orchestrator.js
Audit workflow coordination:
- `analyzePages()` - Main crawling orchestration
- `runSiteWideValidation()` - Post-crawl site-wide checks
- Multilanguage detection
- Orphaned page identification

### lib/orchestrators/progress-manager.js
Checkpoint persistence and restoration:
- `loadProgress()` - Restore from checkpoint files
- `saveProgress()` - Save with archiving support
- Archive file management for large sites
- Data optimization for storage

### lib/args-parser.js
Centralized CLI argument parsing. Supports:
- `--origin=<url>` - Target website
- `--proceed` - Resume from saved progress
- `--perf` - Enable performance metrics
- `--save-html` - Save HTML snapshots
- `--concurrency=<n>` - Parallel crawling (1-20, default: 5)

### lib/constants.js
Centralized configuration including:
- Severity levels: CRITICAL, HIGH, MEDIUM, LOW
- Performance thresholds: TTFB (800ms), LCP (2500ms), CLS (0.1), FCP (1800ms)
- Content thresholds: Title (30-60 chars), Description (120-160 chars)
- Network conditions: slow3g, fast3g, slow4g, normal
- Meta tags to monitor (18 different tags)

### lib/storage/file-manager.js
Handles file operations with:
- Automatic gzip compression (70-80% space reduction)
- Auto-archiving for large sites (>5000 pages)
- Directory structure: `audit-results/domain.com/YYYY-MM-DD_HH-MM-SS/`
- Backward compatible with legacy uncompressed files

### lib/scoring/score-calculator.js
Score calculation system:
- Overall score (0-100)
- Category scores: SEO, Performance, Accessibility, Security, Technical
- Quick wins identification (high impact, low effort)
- Fix recommendations with effort estimates

### historyManager.js
Historical audit tracking:
- Saves audit snapshots over time
- Comparison between audits
- Trend data generation
- Detects improvements and regressions

### generateCSV.js
Exports audit data to CSV files:
- `pages_overview.csv` - All metrics per page
- `issues_breakdown.csv` - Issues by severity
- `performance_metrics.csv` - Performance data
- `quick_wins.csv` - Prioritized actions
- `summary.csv` - High-level statistics

### generateComparison.js
Generates HTML comparison report:
- Side-by-side score comparison
- Category score deltas
- Performance metrics changes
- Improvements and regressions

### validators.js
Input validation and security:
- URL validation with protocol checking
- Filename sanitization (prevents path traversal)
- Suspicious pattern detection (XSS, shell injection)
- Rate limiter class for abuse prevention

## Analyzer Modules

### Accessibility
- **accessibility-analyzer.js**: WCAG 2.1 compliance checks
- **mobile-friendly-analyzer.js**: Mobile viewport and touch targets

### Analytics
- **analytics-tracking-analyzer.js**: GA4, GTM, other tracking verification

### Content
- **content-quality-analyzer.js**: Readability, word count, keyword density, text-to-HTML ratio
- **link-quality-analyzer.js**: Internal/external link analysis

### International SEO
- **international-seo-analyzer.js**: hreflang tag validation, language consistency

### Performance
- **caching-analyzer.js**: CDN detection, cache headers, Service Worker
- **image-optimization-analyzer.js**: Image format, size, lazy loading
- **resource-optimization-analyzer.js**: Render-blocking resources, minification

### Security
- **security-analyzer.js**: HTTPS, security headers (CSP, X-Frame-Options, HSTS)

### SEO
- **aeo-analyzer.js**: AI Search Readiness (AEO) - llms.txt validation, AI crawler rules (GPTBot, ClaudeBot, PerplexityBot), semantic HTML ratio, content structure scoring, FAQ/Q&A detection
- **crawlability-analyzer.js**: Robots.txt, crawl efficiency
- **heading-analyzer.js**: H1-H6 structure and hierarchy
- **image-analyzer.js**: Alt text and image metadata
- **indexability-analyzer.js**: Canonical, noindex, nofollow
- **structured-data-analyzer.js**: Schema.org markup validation

### Site-Wide Validators
- **analytics-validator.js**: Cross-site tracking consistency
- **duplicate-checker.js**: Duplicate titles and descriptions
- **indexability-validator.js**: Site-wide indexability issues
- **international-seo-validator.js**: Language implementation consistency
- **link-structure-analyzer.js**: Internal link patterns
- **social-media-validator.js**: Social meta tag consistency
- **structured-data-validator.js**: Schema markup consistency

### Social
- **social-media-analyzer.js**: Open Graph tags, Twitter cards

## Usage

### Installation
```bash
yarn
npx playwright install
```

### Running an Audit
```bash
node start --origin=<website-url> [--perf] [--save-html] [--proceed] [--concurrency=<number>]
```

### Export to CSV
```bash
node generateCSV.js <json-file-path>
```

### Compare Audits
```bash
node historyManager.js list <domain>
node generateComparison.js <domain> <old-index> <new-index>
```

### History Management
```bash
node historyManager.js save <json-file>
node historyManager.js list <domain>
node historyManager.js compare <domain> <old> <new>
```

## Output Files

### Directory Structure
```
audit-results/
└── domain.com/
    ├── audit-history.json              # Historical snapshots
    └── YYYY-MM-DD_HH-MM-SS/
        ├── SEOAnalysis__domain.com.json.gz        # Main results
        ├── SEOAnalysis__domain.com__archive_part1.json.gz  # Large site archives
        └── domain.com.html                        # HTML report
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
- Incorrect origin
- Exceeds 50,000 URLs
- Missing in robots.txt

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
If the process crashes, `start.js` automatically restarts with `--proceed` to resume from the last checkpoint.

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
