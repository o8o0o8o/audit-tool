// Enable TypeScript imports via tsx
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { exec, execFile } from 'child_process';
import { generateHTML } from './generateHTML';
import { getOpenCommand, getHostname } from './lib/utils';

// Import modularized components
import { parseArgs, calculateSafeConcurrency } from './lib/args-parser';
import { loadConfig, generateSampleConfig, applyConfigToConstants, getConfigSummary } from './lib/config-loader';
import * as constants from './lib/constants';
import { printAuditSummary, getJsonSummary, type AuditResultsExtended } from './lib/utils/cli-summary';
import { validateArguments, validateURL, validateRepoPath, isFetchAllowed } from './validators';
import { generateWorkflow } from './lib/utils/github-actions-generator';
import { ComparisonAudit } from './lib/comparison/comparison-audit';
import { RepoOrchestrator } from './lib/orchestrators/repo-orchestrator';
import { analyzeRepoWithLlm, type RepoContext } from './lib/analyzers/repo/llm-repo-analyzer';
import { HistoryManager } from './historyManager';
import { generateBadgeSVG } from './lib/utils/badge-generator';

// Import SEOData from extracted module (avoids circular dependency)
import { SEOData } from './lib/seo-data';

// Graceful Ctrl+C handler - save progress before exiting
let _seoInstance: SEOData | null = null;
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Audit interrupted (Ctrl+C)');
  if (_seoInstance) {
    try {
      console.log('Saving progress before exit...');
      void _seoInstance.saveData();
      console.log('Progress saved. Resume with --proceed flag.');
    } catch (e: unknown) {
      console.error('Could not save progress:', (e as Error).message);
    }
  }
  process.exit(130);
});

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

/** Severity ordering for prioritising which crawl findings to send to the LLM. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Previous audit's overall score for "vs Previous" — `??`, not `||`, so a real 0 isn't discarded as unmeasured. */
export function previousScoreFrom(lastAudit: { summary?: { overallScore?: number | null } } | undefined): number | null {
  return lastAudit?.summary?.overallScore ?? null;
}

/**
 * Assemble the grounding context for the LLM repo pass from the deterministic
 * result + the crawl aggregator. Pure data shaping — no I/O.
 */
function buildRepoContext(
  repoAnalysis: {
    framework?: string | null;
    version?: string | null;
    router?: string | null;
    configFile?: string | null;
    issues?: Array<{ message?: string; severity?: string }>;
    warnings?: Array<{ message?: string; severity?: string }>;
    sourceMapping?: Record<string, unknown>;
  },
  seoData: { analysis?: { details?: Record<string, { severity?: string; examples?: string[] }> } } | null,
): RepoContext {
  const knownIssues = [...(repoAnalysis.issues ?? []), ...(repoAnalysis.warnings ?? [])].map((i) => ({
    message: String(i.message ?? ''),
    severity: String(i.severity ?? 'medium'),
  }));

  const sanitize = (s: string) =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

  const details = seoData?.analysis?.details ?? {};
  const crawlFindings = Object.entries(details)
    .map(([message, d]) => ({
      message,
      severity: String(d?.severity ?? 'medium'),
      example: Array.isArray(d?.examples) && d.examples.length ? sanitize(String(d.examples[0])) : undefined,
    }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));

  const sourceMapFiles = Array.from(
    new Set(
      Object.values(repoAnalysis.sourceMapping ?? {})
        .flatMap((locs) => (Array.isArray(locs) ? locs : []))
        .map((loc) => (loc && typeof loc === 'object' ? (loc as { file?: unknown }).file : undefined))
        .filter((f): f is string => typeof f === 'string' && f.length > 0),
    ),
  );

  return {
    framework: repoAnalysis.framework ?? null,
    version: repoAnalysis.version ?? null,
    router: repoAnalysis.router ?? null,
    configFile: repoAnalysis.configFile ?? null,
    knownIssues,
    crawlFindings,
    sourceMapFiles,
  };
}

async function audit() {
  try {
    // Parse command-line arguments
    const args = parseArgs(process.argv.slice(2));

    // Handle --sites: batch audit multiple URLs from a file
    if (args.sites) {
      if (!fs.existsSync(args.sites)) {
        console.error(`File not found: ${args.sites}`);
        process.exit(1);
      }
      const rawLines = fs
        .readFileSync(args.sites, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      // Apply the SAME validation as --origin to every batch line: reject
      // malformed URLs and private/internal hosts (SSRF) up front instead of
      // relying on `startsWith('http')` + the downstream ctor.
      const urls: string[] = [];
      for (const line of rawLines) {
        const v = validateURL(line);
        if (!v.valid) {
          console.warn(`Skipping invalid site line: ${line} — ${v.error?.split('\n')[0]}`);
          continue;
        }
        const gate = isFetchAllowed(line);
        if (!gate.allowed) {
          console.warn(`Skipping blocked site line: ${line} — ${gate.reason}`);
          continue;
        }
        urls.push(line);
      }

      if (urls.length === 0) {
        console.error('No valid URLs found in sites file');
        process.exit(1);
      }

      console.log(`\nBatch audit: ${urls.length} sites\n`);
      const results = [];
      for (let i = 0; i < urls.length; i++) {
        console.log(`\n[${i + 1}/${urls.length}] Auditing: ${urls[i]}\n`);
        try {
          const batchSeo = new SEOData(urls[i], false, args.perf, false, args.concurrency, null as string | null, {
            verbose: args.verbose,
            limit: args.limit ?? 20, // Default limit for batch mode
          });
          await batchSeo.audit();

          const score = batchSeo.data.analysis?.summary?.overallScore ?? 0;
          const issues = batchSeo.data.analysis?.summary?.totalIssues ?? 0;
          results.push({ url: urls[i], score, issues, status: 'ok' });
          console.log(`  Score: ${score}/100 | Issues: ${issues}`);

          await batchSeo.saveData();
          const batchHtmlPath = batchSeo.fileManager.getHtmlFilePath();
          generateHTML(batchSeo.file, batchSeo.domainName ?? 'unknown', batchHtmlPath);
        } catch (e: unknown) {
          const err = e as Error;
          results.push({ url: urls[i], score: 0, issues: 0, status: `error: ${err.message}` });
          console.error(`  Failed: ${err.message}`);
        }
      }

      // Print batch summary
      console.log('\n\n' + '='.repeat(60));
      console.log('BATCH AUDIT SUMMARY');
      console.log('='.repeat(60));
      results.forEach((r) => {
        const icon =
          r.status === 'ok' ? (r.score >= 70 ? '\x1b[32m\u2713\x1b[0m' : '\x1b[33m!\x1b[0m') : '\x1b[31m\u2717\x1b[0m';
        console.log(`  ${icon} ${r.url.padEnd(50)} Score: ${String(r.score).padStart(3)} | Issues: ${r.issues}`);
      });
      console.log('='.repeat(60));
      const avgScore =
        Math.round(
          results.filter((r) => r.status === 'ok').reduce((s, r) => s + r.score, 0) /
            results.filter((r) => r.status === 'ok').length,
        ) || 0;
      console.log(`  Average score: ${avgScore}/100`);
      console.log('');
      process.exit(0);
    }

    // Handle --validate-config: validate config and exit
    if (args.validateConfig) {
      try {
        const config = loadConfig(args.config);
        console.log('Config is valid.');
        console.log(`  Thresholds: ${Object.keys(config.thresholds ?? {}).length} defined`);
        console.log(`  Crawl concurrency: ${config.crawl?.concurrency ?? 5}`);
        console.log(`  Query param mode: ${config.queryParams?.mode ?? 'strip_tracking'}`);
        process.exit(0);
      } catch (e: unknown) {
        console.error(`Config validation failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Handle --generate-ci: create GitHub Actions workflow and exit
    if (args.generateCi) {
      if (!args.origin) {
        console.error('--generate-ci requires --origin=<url>');
        process.exit(1);
      }
      const dir = '.github/workflows';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const workflowPath = `${dir}/seo-audit.yml`;
      fs.writeFileSync(workflowPath, generateWorkflow(args.origin));
      console.log(`Created ${workflowPath}`);
      console.log('Commit this file to enable scheduled SEO audits in GitHub Actions.');
      process.exit(0);
    }

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
      console.error('');
      console.error(`❌ ${validation.error}`);
      console.error('');
      console.error('Usage: node robots.js --origin=<website-url> [OPTIONS]');
      console.error('       node robots.js --sitemap=<file> [OPTIONS]');
      console.error('');
      console.error('Options:');
      console.error('  --origin=<url>          Website URL to audit (required unless --sitemap is used)');
      console.error('  --sitemap=<file>        Local sitemap XML file (origin derived from URLs)');
      console.error('  --compare=<url>         Compare origin with another site (page-by-page comparison)');
      console.error('  --compare-sitemap=<file> Local sitemap XML file for comparison site');
      console.error('  --proceed               Resume from saved progress');
      console.error('  --perf                  Enable performance metrics collection');
      console.error('  --save-html             Save HTML snapshots of pages');
      console.error('  --concurrency=<number>  Parallel pages (1-20, default: 5)');
      console.error('  --repo=<path>           Local git repo for source code analysis');
      console.error('  --exclude=<pattern>     Exclude URLs matching regex (repeatable)');
      console.error('  --limit=<number>        Max pages to audit');
      console.error('  --ci[=<threshold>]      CI mode: exit 1 if score < threshold (default: 70)');
      console.error('  --json                  Output JSON summary to stdout');
      console.error('  --config=<path>         Path to config file');
      console.error('  --init-config           Generate sample .seoauditrc file');
      console.error('  --open                  Auto-open HTML report in browser');
      console.error('  --verbose, -v           Show detailed per-URL logging');
      console.error('');
      console.error('Examples:');
      console.error('  node robots.js --origin=https://example.com');
      console.error('  node robots.js --origin=https://example.com --perf');
      console.error('  node robots.js --sitemap=./sitemap.xml --perf');
      console.error('  node robots.js --origin=https://example.com --repo=../my-website');
      console.error('  node robots.js --origin=https://example.com --config=my-config.json');
      console.error('  node robots.js --init-config');
      console.error('');
      console.error('Comparison mode:');
      console.error('  node robots.js --origin=https://staging.example.com --compare=https://www.example.com');
      console.error('  node robots.js --sitemap=./old.xml --compare-sitemap=./new.xml');
      console.error('');
      process.exit(1);
    }

    // Load configuration (from file or defaults)
    const config = loadConfig(args.config);

    // Apply user-defined thresholds from .seoauditrc to constants
    applyConfigToConstants(config, constants);

    // Show config summary in verbose mode
    if (args.verbose) {
      console.log(getConfigSummary(config));
    }

    // Print any argument validation warnings
    if (args.warnings && args.warnings.length > 0) {
      args.warnings.forEach((warning) => console.warn(`⚠️  ${warning}`));
    }

    // Apply presets
    if (args.preset === 'quick') {
      if (!args.concurrencyExplicit) args.concurrency = 10;
      args.limit ??= 50;
      args.perf = false;
      console.log('Quick preset: 50 pages max, no perf metrics, concurrency 10');
    } else if (args.preset === 'deep') {
      if (!args.concurrencyExplicit) args.concurrency = 3;
      args.perf = true;
      args.saveHtml = true;
      console.log('Deep preset: all pages, perf enabled, HTML snapshots, concurrency 3');
    }

    // Apply config to concurrency only if not explicitly set via CLI
    if (!args.concurrencyExplicit && config.crawl?.concurrency) {
      args.concurrency = config.crawl.concurrency;
    }

    // Additional URL validation (skip when using sitemap file)
    if (args.origin) {
      const urlValidation = validateURL(args.origin);
      if (!urlValidation.valid) {
        console.error('');
        console.error(`❌ Invalid URL: ${urlValidation.error}`);
        console.error('');
        process.exit(1);
      }
      console.log(`✅ URL validated: ${args.origin}`);
    } else if (args.sitemap) {
      console.log(`📄 Using local sitemap: ${args.sitemap}`);
    }

    // Smart concurrency info
    const sysInfo = calculateSafeConcurrency();
    console.log(
      `🔄 Concurrency: ${args.concurrency} pages at a time (safe max: ${sysInfo.maxSafe} based on ${sysInfo.reason})`,
    );
    if (args.perf) console.log(`📊 Performance metrics: enabled`);
    if (args.limit) console.log(`🔢 Page limit: ${args.limit}`);
    if (args.exclude && args.exclude.length > 0) console.log(`🚫 Excluding: ${args.exclude.join(', ')}`);

    // Check if comparison mode
    if (args.compare || args.compareSitemap) {
      if (!args.origin && !args.sitemap) {
        console.error('');
        console.error('❌ Comparison mode requires --origin or --sitemap for the origin site');
        console.error('');
        process.exit(1);
      }

      if (!args.compare && !args.compareSitemap) {
        console.error('');
        console.error('❌ Comparison mode requires --compare or --compare-sitemap for the comparison site');
        console.error('');
        process.exit(1);
      }

      // Validate compare URL if provided
      if (args.compare) {
        const compareValidation = validateURL(args.compare);
        if (!compareValidation.valid) {
          console.error('');
          console.error(`❌ Invalid compare URL: ${compareValidation.error}`);
          console.error('');
          process.exit(1);
        }
      }

      const originLabel = args.origin ?? args.sitemap;
      const compareLabel = args.compare ?? args.compareSitemap;
      console.log(`🔀 Comparison mode: ${originLabel} vs ${compareLabel}`);

      // Warn if comparing same domain (only when both are URLs)
      if (args.origin && args.compare) {
        const originDomain = getHostname(args.origin);
        const compareDomain = getHostname(args.compare);
        if (originDomain && compareDomain && originDomain === compareDomain) {
          console.log('⚠️  Warning: Comparing same domain - results may be identical');
        }
      }

      // Import ComparisonAudit (it now imports SEOData from lib/seo-data.js)
      const comparison = new ComparisonAudit(args.origin, args.compare, {
        proceed: args.proceed,
        perf: args.perf,
        saveHtml: args.saveHtml,
        concurrency: args.concurrency,
        sitemap: args.sitemap,
        compareSitemap: args.compareSitemap,
        open: args.open,
      });

      await comparison.audit();
      return;
    }

    const seo = new SEOData(args.origin, args.proceed, args.perf, args.saveHtml, args.concurrency, args.sitemap, {
      verbose: args.verbose,
      open: args.open,
      exclude: args.exclude,
      limit: args.limit,
      dryRun: args.dryRun,
      screenshots: args.screenshots,
      cruxApiKey: config.apiKeys?.crux ?? null,
      evidence: args.evidence,
      evidenceCap: args.evidenceCap,
    });
    _seoInstance = seo;

    await seo.audit();

    // Dry run: show what would be audited and exit
    if (args.dryRun) {
      const urls = Object.keys(seo.data.sitemaps?.urls ?? {});
      const concurrency = args.concurrency || 5;
      const estSecondsPerPage = args.perf ? 8 : 4;
      const estTotalSeconds = Math.ceil(urls.length / concurrency) * estSecondsPerPage;
      const estMinutes = Math.ceil(estTotalSeconds / 60);

      console.log(`\n🔍 Dry run: ${urls.length} URLs would be audited\n`);
      console.log(`   Concurrency: ${concurrency}`);
      console.log(`   Performance: ${args.perf ? 'Enabled' : 'Disabled'}`);
      console.log(`   Estimated time: ~${estMinutes} minute${estMinutes !== 1 ? 's' : ''}`);
      if (urls.length > 1000) {
        console.log(`   ⚠️  Large site: consider using --limit=500 for faster first audit`);
      }
      console.log('');
      urls.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
      console.log(`\nRun without --dry-run to start crawling.`);
      process.exit(0);
    }

    // Run repo analysis if --repo flag is provided
    if (args.repo) {
      const repoValidation = validateRepoPath(args.repo);
      if (!repoValidation.valid) {
        console.error(`\n⚠️  Repo analysis skipped: ${repoValidation.error}`);
      } else {
        console.log(`\n📂 Source code analysis — ${repoValidation.resolvedPath}`);
        try {
          const repoPath = repoValidation.resolvedPath ?? args.repo;
          const repoAnalysis = RepoOrchestrator.analyze(repoPath, seo.data);

          // Optional LLM layer on top of the deterministic core (never replaces
          // it): finds issues no rule enumerates, confirms crawl findings against
          // the source, and proposes code-aware fixes. Own try/catch + silent
          // degradation so a failure can never lose the deterministic result.
          if (args.llmRepo) {
            try {
              console.log('  - LLM pass (find more / confirm / fix)…');
              const ctx = buildRepoContext(repoAnalysis, seo.data);
              const llmFindings = await analyzeRepoWithLlm(repoPath, ctx, {
                cacheDir: path.join(seo.fileManager.resultsDir, 'llm-cache'),
                verbose: args.verbose === true,
              });
              if (llmFindings.length > 0) {
                repoAnalysis.llmFindings = llmFindings;
                console.log(`  - LLM pass: ${llmFindings.length} AI finding(s)`);
              } else {
                console.log('  - LLM pass: no additional findings (or no transport).');
              }
            } catch (e: unknown) {
              console.error('  ⚠️  LLM pass failed (deterministic result kept):', (e as Error).message);
            }
          }

          seo.data.repoAnalysis = repoAnalysis;
          seo.fileManager.writeRepoAnalysis(repoAnalysis);

          // Merge repo issues into the main error aggregator. Tag the message so
          // they read as source-tree/build checks, not live-crawl findings — they
          // inspect the committed source (e.g. a robots.txt under public/), and
          // sitting untagged among crawl findings they can contradict the live
          // site (which may serve a dynamically-generated robots.txt/sitemap the
          // repo check can't see). The Source Code Analysis section still renders
          // them from repoAnalysis directly with their plain messages.
          const REPO_TAG = '🗂 Repo/build check';
          for (const issue of repoAnalysis.issues || []) {
            seo.saveError(`${REPO_TAG}: ${issue.message ?? ''}`, issue.detail ?? '', issue.severity);
          }
          for (const warning of repoAnalysis.warnings || []) {
            seo.saveError(`${REPO_TAG}: ${warning.message ?? ''}`, warning.detail ?? '', warning.severity);
          }
          // LLM findings are additive — surface them (tagged) alongside the rest.
          for (const f of repoAnalysis.llmFindings ?? []) {
            const detail = `🔍 AI-discovered. ${f.detail}${f.fix ? ` — Fix: ${f.fix}` : ''}`;
            seo.saveError(f.message ?? '', detail, f.severity);
          }

          const issueCount =
            (repoAnalysis.issues?.length ?? 0) +
            (repoAnalysis.warnings?.length ?? 0) +
            (repoAnalysis.llmFindings?.length ?? 0);
          console.log(`  ✓ Source analysis complete: ${issueCount} finding(s)`);
        } catch (error: unknown) {
          console.error('⚠️  Repo analysis failed:', (error as Error).message);
        }
      }
    }

    // Save to history for tracking and get previous score for diff
    try {
      if (seo.data && seo.fileManager?.timestamp) {
        const manager = new HistoryManager(seo.domainName!);

        // Get previous score before adding new snapshot
        try {
          const history = manager.loadHistory();
          if (history?.audits && history.audits.length > 0) {
            const lastAudit = history.audits[history.audits.length - 1];
            seo.data.previousScore = previousScoreFrom(lastAudit);
          }
        } catch (e: unknown) {
          console.debug('Could not load previous history:', (e as Error).message);
        }

        manager.addAuditSnapshot(seo.data, seo.fileManager.timestamp);
      } else {
        console.log('⚠️  Could not save audit history: missing audit data or timestamp');
      }
    } catch (error: unknown) {
      console.log('⚠️  Could not save audit history:', (error as Error).message);
    }

    // Store branding info if provided (must be set before HTML generation)
    if (args.brandLogo || args.brandName) {
      seo.data.branding = { logo: args.brandLogo, name: args.brandName };
    }

    // Generate HTML report in the same directory as the JSON file
    const htmlOutputPath = seo.fileManager.getHtmlFilePath();
    generateHTML(seo.file, seo.domainName!, htmlOutputPath);

    // Phase 2 — curated markdown + PDF report. Opt-out via --no-phase2.
    let phase2Succeeded = false;
    if (args.phase2 !== false) {
      // Persist the latest analysis state before Phase 2 reads from disk.
      // Repo-analysis findings (and any other post-audit() saveError calls)
      // are only in memory until this re-save fires.
      try {
        await seo.saveData();
      } catch (e: unknown) {
        console.debug('Pre-Phase-2 save skipped:', (e as Error).message);
      }
      try {
        const { runPhase2 } = await import('./lib/phase2/phase2-runner');
        const pdfPath = await runPhase2(seo.fileManager.resultsDir, {
          llmNarrative: args.llmNarrative === true,
          llmFindings: args.llmFindings === true,
          llmVerify: args.llmVerify === true,
          noScore: args.noScore === true,
          verbose: args.verbose === true,
        });
        console.log(`📄 Curated report: ${pdfPath}`);
        phase2Succeeded = true;
      } catch (e: unknown) {
        // Surface this loudly: the audit itself succeeded, but the curated
        // PDF the user expects is missing. A swallowed debug line here means a
        // silently absent report. Show the cause and how to regenerate.
        console.log('⚠️  Phase 2 curated report failed:', (e as Error).message);
        console.log(
          `   Regenerate with: npx tsx -e "import {runPhase2} from './lib/phase2/phase2-runner'; runPhase2('${seo.fileManager.resultsDir}',{verbose:true}).then(p=>console.log(p))"`,
        );
        if (args.verbose === true) console.error((e as Error).stack);
      }
    }

    // Phase 3 — verification (--verify). Reads the report + phase2-state.json
    // Phase 2 just wrote and emits a SEPARATE audit-report.verified.* set; the
    // main report is never touched. Isolated from Phase 2 so a verify failure
    // (network, Playwright) can't lose the curated report, and re-runnable on
    // its own — re-verify an existing audit anytime without re-crawling.
    if (phase2Succeeded && args.verify === true) {
      try {
        const { runVerifyPhase } = await import('./lib/phase3/verify-runner');
        await runVerifyPhase(seo.fileManager.resultsDir, { verbose: args.verbose === true });
      } catch (e: unknown) {
        console.log('⚠️  Verification phase failed:', (e as Error).message);
        console.log(
          `   Re-verify with: npx tsx -e "import {runVerifyPhase} from './lib/phase3/verify-runner'; runVerifyPhase('${seo.fileManager.resultsDir}',{verbose:true}).then(p=>console.log(p))"`,
        );
        if (args.verbose === true) console.error((e as Error).stack);
      }
    }

    // Phase 4 — competitive content research (--content-research). Opt-in and
    // fully isolated: reads Phase 1 artifacts off disk, crawls a bounded sample
    // of competitor content, and emits a SEPARATE content-research-report.* set
    // plus content-research-state.json. A failure here can never lose the audit
    // or the curated/verified reports. Independent of phase2Succeeded — it does
    // not depend on the Phase 2 report.
    if (args.contentResearch === true) {
      try {
        const { runContentResearchPhase, parseCompetitorsArg } = await import('./lib/phase4/phase4-runner');
        const competitors =
          parseCompetitorsArg(args.competitors).length > 0
            ? parseCompetitorsArg(args.competitors)
            : (config.competitors ?? []);
        await runContentResearchPhase(seo.fileManager.resultsDir, {
          verbose: args.verbose === true,
          competitors,
          // The LLM steps (discovery + plan synthesis) follow the same keyless
          // transport as the other passes; enabled with --llm, else they no-op
          // when no transport is reachable.
          llm: args.llmNarrative === true,
        });
      } catch (e: unknown) {
        console.log('⚠️  Content research phase failed:', (e as Error).message);
        console.log(
          `   Re-run with: npx tsx -e "import {runContentResearchPhase} from './lib/phase4/phase4-runner'; runContentResearchPhase('${seo.fileManager.resultsDir}',{verbose:true}).then(p=>console.log(p))"`,
        );
        if (args.verbose === true) console.error((e as Error).stack);
      }
    }

    // LLM usage/cost rollup — captured by the shared tracker across every
    // Phase 2/3 LLM call. Attach to the results for the summary box and persist
    // a standalone ledger. Best-effort: never let accounting break the audit.
    try {
      const { getLlmUsageSnapshot } = await import('./lib/utils/llm-usage-tracker');
      const llmUsage = getLlmUsageSnapshot();
      if (llmUsage.totalCalls > 0 || llmUsage.cachedCalls > 0) {
        (seo.data as AuditResultsExtended).llmUsage = llmUsage;
        fs.writeFileSync(path.join(seo.fileManager.resultsDir, 'llm-usage.json'), JSON.stringify(llmUsage, null, 2));
      }
    } catch (e: unknown) {
      console.debug('LLM usage rollup skipped:', (e as Error).message);
    }

    // Extract summary once to avoid repeated deep property access
    const summary = seo.data.analysis?.summary ?? ({} as Record<string, unknown>);
    const score = (summary.overallScore as number) ?? 0;
    const totalIssues = (summary.totalIssues as number) ?? 0;
    const totalPages = Object.keys(seo.data.pageData?.pages ?? {}).length;

    // Generate SVG score badge
    try {
      const badgePath = path.join(seo.fileManager.resultsDir, 'badge.svg');
      fs.writeFileSync(badgePath, generateBadgeSVG(score, seo.domainName!));
    } catch (e: unknown) {
      console.debug('Badge generation failed:', (e as Error).message);
    }

    // Print CLI summary (use file:// URL for clickable path in terminal)
    const absoluteHtmlPath = path.resolve(htmlOutputPath);
    const clickableReportPath = `file://${absoluteHtmlPath}`;

    if (args.json) {
      // JSON mode: output machine-readable summary to stdout
      const jsonSummary = getJsonSummary(seo.data as AuditResultsExtended, seo.domainName!, clickableReportPath);
      console.log(JSON.stringify(jsonSummary, null, 2));
    } else {
      printAuditSummary(seo.data as AuditResultsExtended, seo.domainName!, clickableReportPath);
    }

    // CI mode: exit with code 1 if score is below threshold
    if (args.ci !== null && args.ci !== undefined) {
      if (score < args.ci) {
        console.error(`\nCI check failed: score ${score} is below threshold ${args.ci}`);
        process.exit(1);
      }
      console.log(`\nCI check passed: score ${score} >= threshold ${args.ci}`);
    }

    // Helper: POST JSON to a URL (used for Slack + webhooks)
    const postJson = (url: string, payload: string, label: string) => {
      try {
        const parsed = new URL(url);
        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(parsed, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        });
        req.on('error', (e) => console.log(`${label} failed: ${e.message}`));
        req.write(payload);
        req.end();
        console.log(`${label} sent`);
      } catch (e: unknown) {
        console.log(`${label} error: ${(e as Error).message}`);
      }
    };

    // Send Slack notification if configured
    if (args.slack) {
      const emoji = score >= 80 ? ':white_check_mark:' : score >= 60 ? ':warning:' : ':x:';
      postJson(
        args.slack,
        JSON.stringify({
          text: `${emoji} *SEO Audit Complete: ${seo.domainName}*\nScore: *${score}/100* | Issues: ${totalIssues}\nCritical: ${(summary.criticalCount as number) ?? 0} | High: ${(summary.highCount as number) ?? 0}`,
        }),
        'Slack notification',
      );
    }

    // Send webhook notification if configured
    if (args.webhook) {
      const jsonSummary = getJsonSummary(seo.data as AuditResultsExtended, seo.domainName!, clickableReportPath);
      postJson(args.webhook, JSON.stringify(jsonSummary), `Webhook to ${args.webhook}`);
    }

    // Send desktop notification (best effort, no dependency required)
    try {
      if (process.platform === 'darwin') {
        execFile('osascript', [
          '-e',
          `display notification "Score: ${score}/100 | ${totalPages} pages crawled" with title "SEO Audit Complete" subtitle "${seo.domainName}"`,
        ]);
      }
    } catch (e: unknown) {
      console.debug('Desktop notification failed:', (e as Error).message);
    }

    // Append to audit log
    try {
      const logEntry = `${new Date().toISOString()} | ${seo.domainName} | Score: ${score} | Issues: ${totalIssues} | Pages: ${totalPages}\n`;
      fs.appendFileSync('audit-results/audit.log', logEntry);
    } catch (e: unknown) {
      console.debug('Audit log append failed:', (e as Error).message);
    }

    // Auto-open HTML report in browser if --open flag is set
    if (seo.shouldOpenReport) {
      const openCmd = getOpenCommand();
      exec(`${openCmd} "${absoluteHtmlPath}"`, (err) => {
        if (err) console.log('Could not auto-open report:', err.message);
      });
    }
  } catch (error: unknown) {
    const err = error as Error;
    console.error('\n❌ Audit failed: ' + err.message);
    if (err.stack) console.error('\n' + err.stack);

    // Provide actionable hints based on common errors
    if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
      console.error(
        '\n💡 Hint: The domain could not be resolved. Check that the URL is correct and the site is online.',
      );
    } else if (err.message.includes('ECONNREFUSED')) {
      console.error('\n💡 Hint: Connection refused. The server may be down or blocking requests.');
    } else if (err.message.includes('ETIMEDOUT') || err.message.includes('timeout')) {
      console.error('\n💡 Hint: Request timed out. Try increasing timeout with --config or reducing --concurrency.');
    } else if (err.message.includes('ERR_CERT') || err.message.includes('certificate')) {
      console.error('\n💡 Hint: SSL certificate error. The site may have an expired or invalid certificate.');
    } else if (err.message.includes('ENOMEM') || err.message.includes('heap')) {
      console.error('\n💡 Hint: Out of memory. Try reducing --concurrency or increasing --heap-size.');
    } else if (err.message.includes('sitemap')) {
      console.error('\n💡 Hint: Sitemap issue. Verify the sitemap URL in robots.txt or use --sitemap=<file>.');
    }

    console.error('\n🔄 You can resume from the last checkpoint with: --proceed');
    process.exit(1);
  }
}

// Export SEOData class for programmatic use (re-export from lib/seo-data.js)
export { SEOData };
// CLI entry point - only run when executed directly
const isMainModule = typeof require !== 'undefined' && require.main === module;
const isDirectRun = process.argv[1]?.endsWith('robots.ts') || process.argv[1]?.endsWith('robots.js');
if (isMainModule || isDirectRun) {
  void audit();
}
