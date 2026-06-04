#!/usr/bin/env node

// Load .env file if present
import * as fs from 'fs';
import * as path from 'path';
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    process.env[key] ??= value;
  }
}

import { spawn } from 'child_process';
import * as zlib from 'zlib';
import type { ParsedArgs } from './lib/types';
import { parseArgs } from './lib/args-parser';
import { validateURL, sanitizeDomainName } from './validators';
import { printHelp, interactiveMode } from './lib/cli-interactive';
import { FileManager } from './lib/storage/file-manager';
import { readCompressedJson } from './lib/utils';
import pkg from './package.json';

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

async function audit(restoredArgs?: ParsedArgs, restartCount: number = 0) {
  try {
    // Parse arguments from command line or use restored values
    let args = restoredArgs ?? parseArgs(process.argv.slice(2));

    // Handle --version flag
    if (args.version) {
      console.log(`seo-audit v${pkg.version}`);
      process.exit(0);
    }

    // Handle --help flag
    if (args.help) {
      printHelp();
      process.exit(0);
    }

    // Interactive mode when no args provided
    if (!args.origin && !args.sitemap && !restoredArgs && process.stdin.isTTY) {
      args = (await interactiveMode()) as ParsedArgs;
    }

    const { origin, sitemap, compare, proceed, perf, saveHtml } = args;

    // Validate that origin or sitemap is provided
    if (!args.origin && !args.sitemap) {
      printHelp();
      process.exit(1);
    }

    // URL validation using centralized validator (skip when using sitemap file)
    if (origin) {
      const originValidation = validateURL(origin);
      if (!originValidation.valid) {
        console.error(`Error: Invalid URL "${origin}"`);
        console.error(originValidation.error);
        process.exit(1);
      }
    }

    // Validate sitemap file exists
    if (sitemap) {
      if (!fs.existsSync(sitemap)) {
        console.error(`Error: Sitemap file not found: "${sitemap}"`);
        process.exit(1);
      }
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
    const heapSize = process.env.NODE_HEAP_SIZE ?? args.heapSize ?? 8192;
    const childArgs = [
      `--max-old-space-size=${heapSize}`, // Heap limit (default 8GB, configurable via NODE_HEAP_SIZE env or --heap-size arg)
      '--expose-gc', // Allow gc() calls
      '--import=tsx', // Enable TypeScript support
      'robots.ts',
    ];
    if (origin) childArgs.push(`--origin=${origin}`);
    if (sitemap) childArgs.push(`--sitemap=${sitemap}`);
    if (args.compareSitemap) childArgs.push(`--compare-sitemap=${args.compareSitemap}`);
    if (compare) childArgs.push(`--compare=${compare}`);
    if (proceed) childArgs.push('--proceed');
    if (perf) childArgs.push('--perf');
    if (saveHtml) childArgs.push('--save-html');
    if (args.screenshots) childArgs.push('--screenshots');
    if (args.concurrency) childArgs.push(`--concurrency=${args.concurrency}`);
    if (args.repo) childArgs.push(`--repo=${args.repo}`);
    if (args.open) childArgs.push('--open');
    if (args.verbose) childArgs.push('--verbose');
    if (args.ci !== null && args.ci !== undefined) childArgs.push(`--ci=${args.ci}`);
    if (args.json) childArgs.push('--json');
    if (args.exclude && args.exclude.length > 0) {
      args.exclude.forEach((pattern) => childArgs.push(`--exclude=${pattern}`));
    }
    if (args.limit) childArgs.push(`--limit=${args.limit}`);
    if (args.dryRun) childArgs.push('--dry-run');
    if (args.preset) childArgs.push(`--preset=${args.preset}`);
    if (args.webhook) childArgs.push(`--webhook=${args.webhook}`);
    if (args.generateCi) childArgs.push('--generate-ci');
    if (args.validateConfig) childArgs.push('--validate-config');
    if (args.sites) childArgs.push(`--sites=${args.sites}`);
    if (args.slack) childArgs.push(`--slack=${args.slack}`);
    if (args.brandLogo) childArgs.push(`--brand-logo=${args.brandLogo}`);
    if (args.brandName) childArgs.push(`--brand-name=${args.brandName}`);

    // Phase 2 report, AI passes and verification all run inside the child
    // process, so their flags must be forwarded — otherwise they are silently
    // dropped (the child never sees them, so no LLM pass / no verified report).
    if (args.config) childArgs.push(`--config=${args.config}`);
    if (args.phase2 === false) childArgs.push('--no-phase2');
    if (args.llmNarrative) childArgs.push('--llm-narrative');
    if (args.llmFindings) childArgs.push('--llm-findings');
    if (args.llmVerify) childArgs.push('--llm-verify');
    if (args.verify) childArgs.push('--verify');
    if (args.noScore) childArgs.push('--no-score');
    if (args.evidence === false) childArgs.push('--no-evidence');
    if (args.evidenceCap && args.evidenceCap !== 10) childArgs.push(`--evidence-cap=${args.evidenceCap}`);

    const child = spawn('node', childArgs, {
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error('\n❌ Failed to start child process:', error.message);
      process.exit(1);
    });

    child.on('exit', async (code) => {
      if (code !== 0) {
        console.log('\n⚠️  Process crashed or interrupted (exit code: ' + code + ')');

        // Try to show crash progress summary
        try {
          const domain = args.origin ? sanitizeDomainName(args.origin) : args.sitemap ? 'sitemap' : 'unknown';
          const latestRun = FileManager.findLatestRun(domain);
          if (latestRun) {
            const manifestPath = path.join(latestRun, 'manifest.json.gz');
            if (fs.existsSync(manifestPath)) {
              const data = readCompressedJson<{ pageData?: { processedPages?: unknown[]; pages?: Record<string, unknown> }; sitemaps?: { total?: number } }>(manifestPath);
              const processed = data.pageData?.processedPages?.length ?? Object.keys(data.pageData?.pages ?? {}).length;
              const total = data.sitemaps?.total ?? 0;
              if (total > 0) {
                const pct = ((processed / total) * 100).toFixed(1);
                console.log(`   Progress before crash: ${processed}/${total} pages (${pct}%)`);
              }
            }
          }
        } catch {
          /* ignore - best effort */
        }

        if (restartCount >= MAX_RESTART_ATTEMPTS) {
          console.error(`\n❌ Maximum restart attempts (${MAX_RESTART_ATTEMPTS}) reached. Giving up.`);
          console.error('Please check the logs above for errors and try again manually.');
          throw new Error(`Maximum restart attempts (${MAX_RESTART_ATTEMPTS}) reached`);
        }

        console.log(
          `🔄 Restarting with --proceed to resume from saved progress (attempt ${restartCount + 1}/${MAX_RESTART_ATTEMPTS})...\n`,
        );

        // Restart with proceed flag enabled
        await audit({ ...args, proceed: true }, restartCount + 1);
      } else {
        console.log('\n✅ Audit completed successfully (exit code: 0)');
      }
    });
  } catch (error: unknown) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

// Check for watch mode
const watchArgs = parseArgs(process.argv.slice(2));
if (watchArgs.watch) {
  const intervalMin = watchArgs.watch;
  console.log(`\nWatch mode: re-auditing every ${intervalMin} minute(s). Press Ctrl+C to stop.\n`);

  void (async function watchLoop() {
    while (true) {
      try {
        await audit();
      } catch (err: unknown) {
        console.error(`\n⚠️ Audit failed: ${(err as Error).message}. Will retry next cycle.`);
      }
      console.log(`\nNext audit in ${intervalMin} minute(s)...`);
      await new Promise((r) => setTimeout(r, intervalMin * 60 * 1000));
    }
  })();
} else {
  void audit().catch((err: unknown) => {
    console.error('Audit failed:', (err as Error).message ?? err);
    process.exit(1);
  });
}
