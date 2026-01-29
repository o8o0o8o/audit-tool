# SEO Audit Tool

An automated SEO audit tool that analyzes websites for SEO compliance, performance metrics, and best practices.

## Installation

```bash
yarn
npx playwright install
```

## Usage

### Basic Audit

```bash
node start --origin=https://example.com
```

### With Options

```bash
# Enable performance metrics collection (LCP, CLS, TTFB)
node start --origin=https://example.com --perf

# Resume from saved progress
node start --origin=https://example.com --proceed

# Save HTML snapshots of each page
node start --origin=https://example.com --save-html

# Set parallel crawling (faster audits)
node start --origin=https://example.com --concurrency=10

# Combine options
node start --origin=https://example.com --perf --save-html --proceed --concurrency=10
```

**Options:**
- `--origin=<url>` (required) - Website URL to audit
- `--perf` (optional) - Enable performance metrics collection (LCP, CLS, TTFB)
- `--proceed` (optional) - Resume from saved progress after interruption
- `--save-html` (optional) - Save full HTML snapshots of each crawled page
- `--concurrency=<number>` (optional) - Number of pages to crawl in parallel (1-20, default: 5)

**Notes:**
- Performance metrics collection is disabled by default for faster audits
- HTML snapshots are not saved by default to reduce disk usage
- Higher concurrency uses more system resources but completes audits faster

### Export to CSV

```bash
node generateCSV.js audit-results/domain.com/2024-01-15_10-30-00/SEOAnalysis__domain.com.json.gz
```

Creates CSV files in `domain.com_csv_exports/`:
- `pages_overview.csv` - All metrics per page
- `issues_breakdown.csv` - Issues by severity
- `performance_metrics.csv` - Performance data
- `quick_wins.csv` - Prioritized action items
- `summary.csv` - High-level statistics

### Compare Audits

```bash
# List available audit history
node historyManager.js list domain.com

# Compare two audits (by index from list)
node generateComparison.js domain.com 0 1
```

Creates `domain.com_comparison_0_vs_1.html` with side-by-side comparison.

### History Management

```bash
# Save current audit to history
node historyManager.js save audit-results/domain.com/2024-01-15_10-30-00/SEOAnalysis__domain.com.json.gz

# List all audits for a domain
node historyManager.js list domain.com

# Compare two historical audits
node historyManager.js compare domain.com 0 1
```

## Output Files

All results are stored in `audit-results/domain.com/YYYY-MM-DD_HH-MM-SS/`:

- `SEOAnalysis__domain.com.json.gz` - Audit data (gzip compressed)
- `domain.com.html` - Interactive HTML report
- `*__archive_part*.json.gz` - Archive files for large sites (>5000 pages)

Other files:
- `audit-results/domain.com/audit-history.json` - Historical audit snapshots
- `audit-results/failedPages.json` - Failed URLs list
- `audit_domain.com/` - HTML snapshots (only with `--save-html`)

## What Gets Checked

### Robots.txt
- Existence and structure
- Sitemap presence
- Crawlability rules

### Sitemap
- Duplicate URLs
- Trailing slash consistency
- Origin consistency
- Size limits (50,000 URLs)

### Page Analysis
- Title (presence, uniqueness, length)
- Meta description (presence, uniqueness, length)
- Canonical URLs
- Alternate language links (hreflang)
- Heading structure (h1-h6)
- Open Graph and Twitter meta tags
- Structured data (Schema.org)

### Performance (with `--perf`)
- TTFB (threshold: 800ms)
- LCP (threshold: 2500ms)
- CLS (threshold: 0.1)
- Page size (threshold: 6MB)
- Request count (threshold: 20)

### Security
- HTTPS enforcement
- Security headers (CSP, X-Frame-Options, etc.)

### Accessibility
- WCAG 2.1 compliance checks
- Mobile-friendly viewport

## Space Optimizations

- All JSON files are automatically gzip compressed (70-80% reduction)
- Incoming links stored as counts, not arrays
- Automatic archiving for sites with 5000+ pages
- Backward compatible with legacy uncompressed files

## Large Website Support

For sites with thousands of pages:
- Automatic archiving splits processed pages into separate files
- Progress files stay manageable (<100MB)
- Resume with `--proceed` loads all archive files automatically
- No manual intervention required

## License

ISC

## Author

Sergey Labut
