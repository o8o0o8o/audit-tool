const { spawn } = require("child_process");
const { parseArgs } = require("./lib/args-parser");
const { validateURL } = require("./validators");

const MAX_RESTART_ATTEMPTS = 3;

// Global error handlers for unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Promise Rejection:');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('\n❌ Uncaught Exception:');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
});

async function audit(restoredArgs, restartCount = 0) {
  try {
    // Parse arguments from command line or use restored values
    const args = restoredArgs || parseArgs(process.argv.slice(2));

    const { origin, compare, proceed, perf, saveHtml } = args;

    // Validate that origin is provided
    if (!origin) {
      console.error("Error: Website URL is required");
      console.error("");
      console.error("Usage: node start --origin=<website-url> [OPTIONS]");
      console.error("");
      console.error("Options:");
      console.error("  --origin=<url>          Website URL to audit (required)");
      console.error("  --compare=<url>         Compare origin with another site (page-by-page comparison)");
      console.error("  --proceed               Resume from saved progress");
      console.error("  --perf                  Enable performance metrics collection");
      console.error("  --save-html             Save full HTML snapshots of each page");
      console.error("  --concurrency=<number>  Number of pages to crawl in parallel (1-20, default: 5)");
      console.error("  --heap-size=<mb>        Node.js heap size in MB (512-32768, default: 8192)");
      console.error("");
      console.error("Examples:");
      console.error("  node start --origin=https://example.com");
      console.error("  node start --origin=https://example.com --perf");
      console.error("  node start --origin=https://example.com --save-html");
      console.error("  node start --origin=https://example.com --concurrency=10");
      console.error("  node start --origin=https://example.com --proceed --perf");
      console.error("");
      console.error("Comparison mode:");
      console.error("  node start --origin=https://staging.example.com --compare=https://www.example.com");
      console.error("  node start --origin=https://new-site.com --compare=https://old-site.com --perf");
      process.exit(1);
    }

    // URL validation using centralized validator
    const originValidation = validateURL(origin);
    if (!originValidation.valid) {
      console.error(`Error: Invalid URL "${origin}"`);
      console.error(originValidation.error);
      process.exit(1);
    }

    // Validate compare URL if provided
    if (compare) {
      const compareValidation = validateURL(compare);
      if (!compareValidation.valid) {
        console.error(`Error: Invalid compare URL "${compare}"`);
        console.error(compareValidation.error);
        process.exit(1);
      }
    }

    // Build arguments for child process
    // Use --max-old-space-size to increase heap limit for large sites
    // Also use --expose-gc to allow manual garbage collection hints
    const heapSize = process.env.NODE_HEAP_SIZE || args.heapSize || 8192;
    const childArgs = [
      `--max-old-space-size=${heapSize}`,  // Heap limit (default 8GB, configurable via NODE_HEAP_SIZE env or --heap-size arg)
      "--expose-gc",                        // Allow gc() calls
      "robots.js",
      `--origin=${origin}`
    ];
    if (compare) childArgs.push(`--compare=${compare}`);
    if (proceed) childArgs.push("--proceed");
    if (perf) childArgs.push("--perf");
    if (saveHtml) childArgs.push("--save-html");
    if (args.concurrency) childArgs.push(`--concurrency=${args.concurrency}`);

    const child = spawn("node", childArgs, {
      stdio: "inherit",
    });

    child.on("error", (error) => {
      console.error("\n❌ Failed to start child process:", error.message);
      process.exit(1);
    });

    child.on("exit", async (code) => {
      if (code !== 0) {
        console.log("\n⚠️  Process crashed or interrupted (exit code: " + code + ")");

        if (restartCount >= MAX_RESTART_ATTEMPTS) {
          console.error(`\n❌ Maximum restart attempts (${MAX_RESTART_ATTEMPTS}) reached. Giving up.`);
          console.error("Please check the logs above for errors and try again manually.");
          process.exit(1);
        }

        console.log(`🔄 Restarting with --proceed to resume from saved progress (attempt ${restartCount + 1}/${MAX_RESTART_ATTEMPTS})...\n`);

        // Restart with proceed flag enabled
        await audit({
          origin: args.origin,
          compare: args.compare,
          proceed: true,
          perf: args.perf,
          saveHtml: args.saveHtml,
          concurrency: args.concurrency,
        }, restartCount + 1);
      } else {
        console.log("\n✅ Audit completed successfully (exit code: 0)");
      }
    });
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

audit();
