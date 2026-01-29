/**
 * Command-line Argument Parser
 * Centralized argument parsing to avoid duplication
 */

/**
 * Parse command-line arguments
 * Supports: --origin=<url>, --proceed, --perf, --save-html, --concurrency=<number>
 * @param {string[]} args - Command-line arguments
 * @returns {object} Parsed arguments
 */
function parseArgs(args) {
  const parsed = {
    origin: null,
    proceed: false,
    perf: false,
    saveHtml: false, // Default to false (no HTML saving)
    concurrency: 5, // Default to 5 concurrent pages
  };

  for (const arg of args) {
    if (arg.startsWith("--origin=")) {
      parsed.origin = arg.substring("--origin=".length);
    } else if (arg === "--proceed") {
      parsed.proceed = true;
    } else if (arg === "--perf") {
      parsed.perf = true;
    } else if (arg === "--save-html") {
      parsed.saveHtml = true;
    } else if (arg.startsWith("--concurrency=")) {
      const value = parseInt(arg.substring("--concurrency=".length), 10);
      if (!isNaN(value) && value > 0 && value <= 20) {
        parsed.concurrency = value;
      }
    }
  }

  return parsed;
}

module.exports = { parseArgs };
