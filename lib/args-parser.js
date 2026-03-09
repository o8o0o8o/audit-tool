/**
 * Command-line Argument Parser
 * Centralized argument parsing to avoid duplication
 */

const os = require('os');

/**
 * Calculate safe concurrency based on available system resources
 * Each browser context uses ~50-100MB of memory
 * @returns {object} { maxSafe: number, reason: string }
 */
function calculateSafeConcurrency() {
  const MEMORY_PER_BROWSER_MB = 150; // Conservative estimate including overhead
  const MIN_FREE_MEMORY_MB = 512; // Keep at least 512MB free for system

  const totalMemoryMB = Math.floor(os.totalmem() / (1024 * 1024));
  const freeMemoryMB = Math.floor(os.freemem() / (1024 * 1024));
  const availableForBrowsers = Math.max(0, freeMemoryMB - MIN_FREE_MEMORY_MB);

  // Calculate max concurrent browsers based on available memory
  const memoryBasedMax = Math.floor(availableForBrowsers / MEMORY_PER_BROWSER_MB);

  // Also consider CPU cores (don't exceed 2x CPU cores)
  const cpuCores = os.cpus().length;
  const cpuBasedMax = cpuCores * 2;

  // Take the lower of the two limits
  const maxSafe = Math.max(1, Math.min(memoryBasedMax, cpuBasedMax, 20));

  let reason = '';
  if (memoryBasedMax < cpuBasedMax) {
    reason = `memory (${freeMemoryMB}MB free, ~${MEMORY_PER_BROWSER_MB}MB per browser)`;
  } else {
    reason = `CPU cores (${cpuCores} cores)`;
  }

  return { maxSafe, reason, freeMemoryMB, cpuCores };
}

/**
 * Parse command-line arguments
 * Supports: --origin=<url>, --compare=<url>, --proceed, --perf, --save-html, --concurrency=<number>, --heap-size=<mb>, --config=<path>, --init-config, --help, --open, --verbose
 * @param {string[]} args - Command-line arguments
 * @returns {object} Parsed arguments
 */
function parseArgs(args) {
  const parsed = {
    origin: null,
    compare: null, // URL of comparison site for page-by-page comparison
    sitemap: null, // Path to local sitemap XML file
    compareSitemap: null, // Path to local sitemap XML file for comparison site
    proceed: false,
    perf: false,
    saveHtml: false, // Default to false (no HTML saving)
    screenshots: false, // Save viewport screenshots per page
    concurrency: 5, // Default to 5 concurrent pages
    concurrencyExplicit: false, // Track if user explicitly set concurrency
    heapSize: null, // Heap size in MB (default 8192, can override via NODE_HEAP_SIZE env)
    config: null, // Path to config file
    initConfig: false, // Generate sample config
    repo: null, // Path to local git repository for source code analysis
    exclude: [], // URL patterns to exclude from crawling
    limit: null, // Max pages to audit
    onlyErrors: false, // Only show pages with errors in report
    dryRun: false, // Show what would be audited without crawling
    generateCi: false, // Generate GitHub Actions workflow
    validateConfig: false, // Validate config file and exit
    webhook: null, // URL to POST audit results to
    version: false, // Show version
    help: false, // Show help text
    open: false, // Auto-open HTML report in browser
    verbose: false, // Verbose output (per-URL logging)
    quiet: false, // Minimal output (suppress info messages)
    preset: null, // Audit preset: quick, standard, deep
    sites: null, // File with list of URLs for batch audit
    slack: null, // Slack webhook URL for notifications
    watch: null, // Watch mode interval in minutes
    brandLogo: null, // Custom logo URL for report branding
    brandName: null, // Custom brand name for report
    ci: null, // CI mode: exit code 1 if score < threshold
    json: false, // Output JSON summary to stdout
    warnings: [], // Collect validation warnings
  };

  for (const arg of args) {
    if (arg === "--version" || arg === "-V") {
      parsed.version = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--open") {
      parsed.open = true;
    } else if (arg === "--verbose" || arg === "-v") {
      parsed.verbose = true;
    } else if (arg === "--quiet" || arg === "-q") {
      parsed.quiet = true;
    } else if (arg.startsWith("--preset=")) {
      const preset = arg.substring("--preset=".length).toLowerCase();
      if (['quick', 'standard', 'deep'].includes(preset)) {
        parsed.preset = preset;
      } else {
        parsed.warnings.push(`Unknown preset "${preset}". Use: quick, standard, or deep.`);
      }
    } else if (arg.startsWith("--ci=")) {
      const val = parseInt(arg.substring("--ci=".length), 10);
      parsed.ci = isNaN(val) ? 70 : Math.max(0, Math.min(100, val));
    } else if (arg === "--ci") {
      parsed.ci = 70; // Default threshold
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg.startsWith("--origin=")) {
      parsed.origin = arg.substring("--origin=".length);
    } else if (arg.startsWith("--compare=")) {
      parsed.compare = arg.substring("--compare=".length);
    } else if (arg.startsWith("--sitemap=")) {
      parsed.sitemap = arg.substring("--sitemap=".length);
    } else if (arg.startsWith("--compare-sitemap=")) {
      parsed.compareSitemap = arg.substring("--compare-sitemap=".length);
    } else if (arg === "--proceed") {
      parsed.proceed = true;
    } else if (arg === "--perf") {
      parsed.perf = true;
    } else if (arg === "--save-html") {
      parsed.saveHtml = true;
    } else if (arg === "--screenshots") {
      parsed.screenshots = true;
    } else if (arg.startsWith("--concurrency=")) {
      const rawValue = arg.substring("--concurrency=".length);
      const value = parseInt(rawValue, 10);
      if (isNaN(value)) {
        parsed.warnings.push(`Invalid concurrency value "${rawValue}" - must be a number. Using default (5).`);
      } else if (value < 1) {
        parsed.warnings.push(`Concurrency ${value} is too low - minimum is 1. Using 1.`);
        parsed.concurrency = 1;
        parsed.concurrencyExplicit = true;
      } else if (value > 20) {
        parsed.warnings.push(`Concurrency ${value} is too high - maximum is 20. Using 20.`);
        parsed.concurrency = 20;
        parsed.concurrencyExplicit = true;
      } else {
        // Validate against system resources
        const { maxSafe, reason, freeMemoryMB } = calculateSafeConcurrency();
        if (value > maxSafe) {
          parsed.warnings.push(
            `Concurrency ${value} exceeds safe limit of ${maxSafe} based on ${reason}. ` +
            `Using ${maxSafe} to prevent system instability. ` +
            `(Free memory: ${freeMemoryMB}MB)`
          );
          parsed.concurrency = maxSafe;
        } else {
          parsed.concurrency = value;
        }
        parsed.concurrencyExplicit = true;
      }
    } else if (arg.startsWith("--heap-size=")) {
      const rawValue = arg.substring("--heap-size=".length);
      const value = parseInt(rawValue, 10);
      if (isNaN(value)) {
        parsed.warnings.push(`Invalid heap-size value "${rawValue}" - must be a number. Using default.`);
      } else if (value < 512) {
        parsed.warnings.push(`Heap size ${value}MB is too low - minimum is 512MB. Using 512MB.`);
        parsed.heapSize = 512;
      } else if (value > 32768) {
        parsed.warnings.push(`Heap size ${value}MB is too high - maximum is 32768MB. Using 32768MB.`);
        parsed.heapSize = 32768;
      } else {
        parsed.heapSize = value;
      }
    } else if (arg.startsWith("--config=")) {
      parsed.config = arg.substring("--config=".length);
    } else if (arg === "--init-config") {
      parsed.initConfig = true;
    } else if (arg.startsWith("--repo=")) {
      parsed.repo = arg.substring("--repo=".length);
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--generate-ci") {
      parsed.generateCi = true;
    } else if (arg === "--validate-config") {
      parsed.validateConfig = true;
    } else if (arg.startsWith("--webhook=")) {
      parsed.webhook = arg.substring("--webhook=".length);
    } else if (arg.startsWith("--sites=")) {
      parsed.sites = arg.substring("--sites=".length);
    } else if (arg.startsWith("--slack=")) {
      parsed.slack = arg.substring("--slack=".length);
    } else if (arg.startsWith("--watch=")) {
      const val = parseInt(arg.substring("--watch=".length), 10);
      parsed.watch = isNaN(val) ? 60 : Math.max(1, val);
    } else if (arg === "--watch") {
      parsed.watch = 60; // Default 60 minutes
    } else if (arg.startsWith("--brand-logo=")) {
      parsed.brandLogo = arg.substring("--brand-logo=".length);
    } else if (arg.startsWith("--brand-name=")) {
      parsed.brandName = arg.substring("--brand-name=".length);
    } else if (arg === "--only-errors") {
      parsed.onlyErrors = true;
    } else if (arg.startsWith("--exclude=")) {
      const pattern = arg.substring("--exclude=".length);
      if (pattern) parsed.exclude.push(pattern);
    } else if (arg.startsWith("--limit=")) {
      const rawValue = arg.substring("--limit=".length);
      const value = parseInt(rawValue, 10);
      if (isNaN(value) || value < 1) {
        parsed.warnings.push(`Invalid limit value "${rawValue}" - must be a positive number. Ignoring.`);
      } else {
        parsed.limit = value;
      }
    } else if (arg !== "--origin" && arg !== "--compare" && arg !== "--sitemap" && arg !== "--compare-sitemap" && arg !== "--concurrency" && arg !== "--heap-size" && arg !== "--config" && arg !== "--repo") {
      // Unknown flag - ignore silently (could be a typo)
    }
  }

  return parsed;
}

module.exports = { parseArgs, calculateSafeConcurrency };
