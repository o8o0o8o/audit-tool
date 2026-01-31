const { spawn } = require("child_process");
const { parseArgs } = require("./lib/args-parser");

async function audit(restoredArgs) {
  try {
    // Parse arguments from command line or use restored values
    const args = restoredArgs || parseArgs(process.argv.slice(2));

    const { origin, proceed, perf, saveHtml } = args;

    // Validate that origin is provided
    if (!origin) {
      console.error("Error: Website URL is required");
      console.error("");
      console.error("Usage: node start --origin=<website-url> [--proceed] [--perf] [--save-html] [--concurrency=<number>]");
      console.error("");
      console.error("Options:");
      console.error("  --origin=<url>          Website URL to audit (required)");
      console.error("  --proceed               Resume from saved progress");
      console.error("  --perf                  Enable performance metrics collection");
      console.error("  --save-html             Save full HTML snapshots of each page");
      console.error("  --concurrency=<number>  Number of pages to crawl in parallel (1-20, default: 5)");
      console.error("");
      console.error("Examples:");
      console.error("  node start --origin=https://example.com");
      console.error("  node start --origin=https://example.com --perf");
      console.error("  node start --origin=https://example.com --save-html");
      console.error("  node start --origin=https://example.com --concurrency=10");
      console.error("  node start --origin=https://example.com --proceed --perf");
      process.exit(1);
    }

    // Basic URL validation
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https protocols are allowed');
      }
    } catch (error) {
      console.error(`Error: Invalid URL "${origin}"`);
      console.error(error.message);
      process.exit(1);
    }

    // Build arguments for child process
    // Use --max-old-space-size to increase heap limit for large sites
    // Also use --expose-gc to allow manual garbage collection hints
    const childArgs = [
      "--max-old-space-size=8192",  // 8GB heap limit
      "--expose-gc",                // Allow gc() calls
      "robots.js",
      `--origin=${origin}`
    ];
    if (proceed) childArgs.push("--proceed");
    if (perf) childArgs.push("--perf");
    if (saveHtml) childArgs.push("--save-html");
    if (args.concurrency) childArgs.push(`--concurrency=${args.concurrency}`);

    const child = spawn("node", childArgs, {
      stdio: "inherit",
    });

    child.on("exit", async (code) => {
      if (code !== 0) {
        child.kill();

        console.log("\n⚠️  Process crashed or interrupted (exit code: " + code + ")");
        console.log("🔄 Restarting with --proceed to resume from saved progress...\n");

        // Restart with proceed flag enabled
        await audit({
          origin: args.origin,
          proceed: true,
          perf: args.perf,
          saveHtml: args.saveHtml,
          concurrency: args.concurrency,
        });
      } else {
        console.log("\n✅ Audit completed successfully (exit code: 0)");
      }
    });
  } catch (error) {
    console.log(error);
  }
}

audit();
