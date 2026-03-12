/**
 * CLI Interactive Mode & Help
 * Provides interactive prompts when no args given, and help text display
 */

import * as readline from 'readline';

/**
 * Print help text to stdout
 */
function printHelp() {
  const help = `
SEO Audit Tool - Comprehensive website SEO analysis

Usage:
  node start --origin=<url> [OPTIONS]
  node start --sitemap=<file> [OPTIONS]

Required (one of):
  --origin=<url>            Website URL to audit
  --sitemap=<file>          Local sitemap XML file (origin derived from URLs)

Options:
  --perf                    Enable performance metrics collection (Core Web Vitals)
  --save-html               Save full HTML snapshots of each page
  --screenshots             Save PNG screenshots of each page
  --concurrency=<n>         Pages to crawl in parallel (1-20, default: 5)
  --proceed                 Resume from saved progress
  --repo=<path>             Local git repo for source code analysis
  --config=<path>           Path to config file (.seoauditrc)
  --init-config             Generate sample .seoauditrc file
  --open                    Auto-open HTML report in browser when done
  --verbose, -v             Show detailed per-URL logging
  --heap-size=<mb>          Node.js heap size in MB (512-32768, default: 8192)
  --exclude=<pattern>       Exclude URLs matching regex pattern (repeatable)
  --limit=<n>               Max number of pages to audit
  --only-errors             Only include pages with errors in report
  --dry-run                 Show URLs that would be audited, then exit
  --preset=<name>           Audit preset: quick, standard, or deep
  --quiet, -q               Minimal output (suppress info messages)
  --ci[=<threshold>]        CI mode: exit code 1 if score < threshold (default: 70)
  --json                    Output machine-readable JSON summary to stdout
  --webhook=<url>           POST audit summary JSON to this URL when done
  --slack=<url>             Slack webhook URL for notifications
  --sites=<file>            File with list of URLs for batch audit
  --watch[=<minutes>]       Watch mode: re-audit at interval (default: 60)
  --brand-logo=<url>        Custom logo URL for report header
  --brand-name=<name>       Custom brand name for report header
  --generate-ci             Generate GitHub Actions workflow file
  --validate-config         Validate config file and exit
  --version, -V             Show version number
  --help, -h                Show this help message

Comparison mode:
  --compare=<url>           Compare origin with another site (page-by-page)
  --compare-sitemap=<file>  Local sitemap XML for comparison site

Examples:
  node start --origin=https://example.com
  node start --origin=https://example.com --perf --open
  node start --sitemap=./sitemap.xml --perf
  node start --origin=https://example.com --repo=../my-website
  node start --origin=https://example.com --concurrency=10
  node start --origin=https://staging.example.com --compare=https://www.example.com
  node start --origin=https://example.com --watch=30
  node start --sites=urls.txt --perf

Other commands:
  node generateCSV.js <json-file>                      Export to CSV
  node historyManager.js list <domain>                  View audit history
  node generateComparison.js <domain> <old> <new>       Compare audits
  node start --init-config                              Create sample config
`;

  console.log(help);
}

/**
 * Prompt user for input interactively
 * @returns {Promise<object>} Parsed arguments from interactive input
 */
async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });

  console.log('\nSEO Audit Tool - Interactive Setup\n');

  const args: {
    origin: string | null;
    sitemap: string | null;
    compare: string | null;
    compareSitemap: string | null;
    proceed: boolean;
    perf: boolean;
    saveHtml: boolean;
    screenshots: boolean;
    concurrency: number;
    concurrencyExplicit: boolean;
    heapSize: number | null;
    config: string | null;
    initConfig: boolean;
    repo: string | null;
    exclude: string[];
    limit: number | null;
    onlyErrors: boolean;
    dryRun: boolean;
    preset: string | null;
    help: boolean;
    open: boolean;
    verbose: boolean;
    quiet: boolean;
    warnings: string[];
  } = {
    origin: null,
    sitemap: null,
    compare: null,
    compareSitemap: null,
    proceed: false,
    perf: false,
    saveHtml: false,
    screenshots: false,
    concurrency: 5,
    concurrencyExplicit: false,
    heapSize: null,
    config: null,
    initConfig: false,
    repo: null,
    exclude: [],
    limit: null,
    onlyErrors: false,
    dryRun: false,
    preset: null,
    help: false,
    open: false,
    verbose: false,
    quiet: false,
    warnings: [],
  };

  // URL or sitemap
  const url = await ask('Website URL (or path to sitemap.xml): ');
  if (!url) {
    rl.close();
    console.error('\nNo URL provided. Run with --help for usage information.');
    process.exit(1);
  }

  if (url.endsWith('.xml') || url.endsWith('.xml.gz')) {
    args.sitemap = url;
  } else {
    // Add protocol if missing
    args.origin = url.startsWith('http') ? url : `https://${url}`;
  }

  // Preset selection
  const presetAnswer = await ask(
    'Audit preset [1=quick ~2s/page, 2=standard ~4s/page, 3=deep ~6s/page] (default: 2): ',
  );
  if (presetAnswer === '1') {
    args.preset = 'quick';
    args.concurrency = 10;
    args.concurrencyExplicit = true;
  } else if (presetAnswer === '3') {
    args.preset = 'deep';
    args.perf = true;
    args.concurrency = 3;
    args.concurrencyExplicit = true;
  } else {
    args.preset = 'standard';
  }

  // Performance metrics (only ask if not already set by preset)
  if (!args.perf) {
    const perfAnswer = await ask('Enable performance metrics (Core Web Vitals)? (y/N): ');
    args.perf = perfAnswer.toLowerCase() === 'y';
  }

  // Page limit and concurrency use defaults (configurable via CLI args or .seoauditrc)

  // Screenshots
  const screenshotAnswer = await ask('Save page screenshots? (y/N): ');
  if (screenshotAnswer.toLowerCase() === 'y') {
    args.screenshots = true;
  }

  // Repo for source code analysis
  const repoAnswer = await ask('Path to source code repo for analysis (empty=skip): ');
  if (repoAnswer) {
    args.repo = repoAnswer;
  }

  // Always auto-open report
  args.open = true;

  rl.close();
  console.log('');

  return args;
}

/**
 * Print a colored summary banner to stderr
 * @param {number} score - Overall score
 * @param {string} grade - Letter grade
 * @param {string} domain - Domain name
 */
function printScoreBanner(score: number, grade: string, domain: string) {
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  const color = score >= 80 ? GREEN : score >= 60 ? YELLOW : RED;
  const emoji = score >= 90 ? '🏆' : score >= 70 ? '✅' : score >= 50 ? '⚠️' : '🚨';

  console.error('');
  console.error(`${BOLD}${emoji} ${domain}: ${color}${score}/100 (${grade})${RESET}`);
  console.error('');
}

export { printHelp, interactiveMode, printScoreBanner };
