const fs = require("fs");
const { generateHTML } = require("./generateHTML");

// Import modularized components
const { parseArgs } = require("./lib/args-parser");
const { loadConfig, generateSampleConfig } = require("./lib/config-loader");
const { printAuditSummary } = require("./lib/utils/cli-summary");

// Import SEOData from extracted module (avoids circular dependency)
const { SEOData } = require("./lib/seo-data");

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

async function audit() {
  try {
    const { validateArguments, validateURL } = require('./validators');

    // Parse command-line arguments
    const args = parseArgs(process.argv.slice(2));

    // Handle --init-config: generate sample config and exit
    if (args.initConfig) {
      const configPath = '.seoauditrc';
      if (fs.existsSync(configPath)) {
        console.error(`❌ Config file already exists: ${configPath}`);
        process.exit(1);
      }
      fs.writeFileSync(configPath, generateSampleConfig());
      console.log(`✅ Created sample config: ${configPath}`);
      console.log('Edit this file to customize thresholds and settings.');
      process.exit(0);
    }

    // Validate arguments
    const validation = validateArguments(args);
    if (!validation.valid) {
      console.error("");
      console.error(`❌ ${validation.error}`);
      console.error("");
      console.error("Usage: node robots.js --origin=<website-url> [OPTIONS]");
      console.error("       node robots.js --sitemap=<file> [OPTIONS]");
      console.error("");
      console.error("Options:");
      console.error("  --origin=<url>          Website URL to audit (required unless --sitemap is used)");
      console.error("  --sitemap=<file>        Local sitemap XML file (origin derived from URLs)");
      console.error("  --compare=<url>         Compare origin with another site (page-by-page comparison)");
      console.error("  --compare-sitemap=<file> Local sitemap XML file for comparison site");
      console.error("  --proceed               Resume from saved progress");
      console.error("  --perf                  Enable performance metrics collection");
      console.error("  --save-html             Save HTML snapshots of pages");
      console.error("  --concurrency=<number>  Parallel pages (1-20, default: 5)");
      console.error("  --repo=<path>           Local git repo for source code analysis");
      console.error("  --config=<path>         Path to config file");
      console.error("  --init-config           Generate sample .seoauditrc file");
      console.error("");
      console.error("Examples:");
      console.error("  node robots.js --origin=https://example.com");
      console.error("  node robots.js --origin=https://example.com --perf");
      console.error("  node robots.js --sitemap=./sitemap.xml --perf");
      console.error("  node robots.js --origin=https://example.com --repo=../my-website");
      console.error("  node robots.js --origin=https://example.com --config=my-config.json");
      console.error("  node robots.js --init-config");
      console.error("");
      console.error("Comparison mode:");
      console.error("  node robots.js --origin=https://staging.example.com --compare=https://www.example.com");
      console.error("  node robots.js --sitemap=./old.xml --compare-sitemap=./new.xml");
      console.error("");
      process.exit(1);
    }

    // Load configuration (from file or defaults)
    const config = loadConfig(args.config);

    // Print any argument validation warnings
    if (args.warnings && args.warnings.length > 0) {
      args.warnings.forEach(warning => console.warn(`⚠️  ${warning}`));
    }

    // Apply config to concurrency only if not explicitly set via CLI
    if (!args.concurrencyExplicit && config.crawl && config.crawl.concurrency) {
      args.concurrency = config.crawl.concurrency;
    }

    // Additional URL validation (skip when using sitemap file)
    if (args.origin) {
      const urlValidation = validateURL(args.origin);
      if (!urlValidation.valid) {
        console.error("");
        console.error(`❌ Invalid URL: ${urlValidation.error}`);
        console.error("");
        process.exit(1);
      }
      console.log(`✅ URL validated: ${args.origin}`);
    } else if (args.sitemap) {
      console.log(`📄 Using local sitemap: ${args.sitemap}`);
    }

    console.log(`🔄 Concurrency: ${args.concurrency} pages at a time`);
    if (args.perf) console.log(`📊 Performance metrics: enabled`);

    // Check if comparison mode
    if (args.compare || args.compareSitemap) {
      if (!args.origin && !args.sitemap) {
        console.error("");
        console.error("❌ Comparison mode requires --origin or --sitemap for the origin site");
        console.error("");
        process.exit(1);
      }

      if (!args.compare && !args.compareSitemap) {
        console.error("");
        console.error("❌ Comparison mode requires --compare or --compare-sitemap for the comparison site");
        console.error("");
        process.exit(1);
      }

      // Validate compare URL if provided
      if (args.compare) {
        const compareValidation = validateURL(args.compare);
        if (!compareValidation.valid) {
          console.error("");
          console.error(`❌ Invalid compare URL: ${compareValidation.error}`);
          console.error("");
          process.exit(1);
        }
      }

      const originLabel = args.origin || args.sitemap;
      const compareLabel = args.compare || args.compareSitemap;
      console.log(`🔀 Comparison mode: ${originLabel} vs ${compareLabel}`);

      // Warn if comparing same domain (only when both are URLs)
      if (args.origin && args.compare) {
        const originDomain = new URL(args.origin).hostname;
        const compareDomain = new URL(args.compare).hostname;
        if (originDomain === compareDomain) {
          console.log('⚠️  Warning: Comparing same domain - results may be identical');
        }
      }

      // Import ComparisonAudit (it now imports SEOData from lib/seo-data.js)
      const { ComparisonAudit } = require("./lib/comparison/comparison-audit");
      const comparison = new ComparisonAudit(args.origin, args.compare, {
        proceed: args.proceed,
        perf: args.perf,
        saveHtml: args.saveHtml,
        concurrency: args.concurrency,
        sitemap: args.sitemap,
        compareSitemap: args.compareSitemap,
      });

      await comparison.audit();
      return;
    }

    const seo = new SEOData(args.origin, args.proceed, args.perf, args.saveHtml, args.concurrency, args.sitemap);

    await seo.audit();

    // Run repo analysis if --repo flag is provided
    if (args.repo) {
      const { validateRepoPath } = require('./validators');
      const repoValidation = validateRepoPath(args.repo);
      if (!repoValidation.valid) {
        console.error(`\n⚠️  Repo analysis skipped: ${repoValidation.error}`);
      } else {
        console.log(`\n📂 Running source code analysis on: ${repoValidation.resolvedPath}`);
        try {
          const { RepoOrchestrator } = require('./lib/orchestrators/repo-orchestrator');
          const repoAnalysis = RepoOrchestrator.analyze(repoValidation.resolvedPath, seo.data);
          seo.data.repoAnalysis = repoAnalysis;

          // Merge repo issues into the main error aggregator
          for (const issue of repoAnalysis.issues || []) {
            seo.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of repoAnalysis.warnings || []) {
            seo.saveError(warning.message, warning.detail, warning.severity);
          }

          const issueCount = (repoAnalysis.issues?.length || 0) + (repoAnalysis.warnings?.length || 0);
          console.log(`✅ Repo analysis complete: ${issueCount} finding(s)`);
        } catch (error) {
          console.error('⚠️  Repo analysis failed:', error.message);
        }
      }
    }

    // Save to history for tracking
    try {
      if (seo.data && seo.fileManager?.timestamp) {
        const { HistoryManager } = require('./historyManager');
        const manager = new HistoryManager(seo.domainName);
        manager.addAuditSnapshot(seo.data, seo.fileManager.timestamp);
      } else {
        console.log('⚠️  Could not save audit history: missing audit data or timestamp');
      }
    } catch (error) {
      console.log('⚠️  Could not save audit history:', error.message);
    }

    // Generate HTML report in the same directory as the JSON file
    const htmlOutputPath = seo.fileManager.getHtmlFilePath();
    generateHTML(seo.file, seo.domainName, htmlOutputPath);

    // Print CLI summary
    printAuditSummary(seo.data, seo.domainName, htmlOutputPath);
  } catch (error) {
    console.error("Error during audit:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Export SEOData class for programmatic use (re-export from lib/seo-data.js)
module.exports = { SEOData };

// CLI entry point - only run when executed directly
if (require.main === module) {
  audit();
}
