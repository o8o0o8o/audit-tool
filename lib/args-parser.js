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
 * Supports: --origin=<url>, --compare=<url>, --proceed, --perf, --save-html, --concurrency=<number>, --heap-size=<mb>, --config=<path>, --init-config
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
    concurrency: 5, // Default to 5 concurrent pages
    concurrencyExplicit: false, // Track if user explicitly set concurrency
    heapSize: null, // Heap size in MB (default 8192, can override via NODE_HEAP_SIZE env)
    config: null, // Path to config file
    initConfig: false, // Generate sample config
    warnings: [], // Collect validation warnings
  };

  for (const arg of args) {
    if (arg.startsWith("--origin=")) {
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
    }
  }

  return parsed;
}

module.exports = { parseArgs, calculateSafeConcurrency };
