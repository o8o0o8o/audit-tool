/**
 * Command-line Argument Parser
 * Centralized argument parsing to avoid duplication
 */

import type { ParsedArgs as BaseParsedArgs } from './types';

/** `--agentic` / `--no-agentic`; null defers to `.seoauditrc` (default on). */
export type ParsedArgs = BaseParsedArgs & { agentic: boolean | null };
import { isPresetName, parseCsvList, unknownPresetMessage } from './presets';
import * as os from 'os';

/**
 * Calculate safe concurrency based on available system resources
 * Each browser context uses ~50-100MB of memory
 * @returns {object} { maxSafe: number, reason: string }
 */
function calculateSafeConcurrency() {
  const MEMORY_PER_BROWSER_MB = 150; // Conservative estimate including overhead
  const MIN_FREE_MEMORY_MB = 512; // Keep at least 512MB free for system

  const freeMemoryMB = Math.floor(os.freemem() / (1024 * 1024));
  const availableForBrowsers = Math.max(0, freeMemoryMB - MIN_FREE_MEMORY_MB);

  // Calculate max concurrent browsers based on available memory
  const memoryBasedMax = Math.floor(availableForBrowsers / MEMORY_PER_BROWSER_MB);

  // Also consider CPU cores (don't exceed 2x CPU cores)
  const cpuCores = os.cpus().length;
  const cpuBasedMax = cpuCores * 2;

  // Take the lower of the two limits
  const maxSafe = Math.max(1, Math.min(memoryBasedMax, cpuBasedMax, 20));

  let reason: string;
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
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    origin: null as string | null,
    compare: null as string | null, // URL of comparison site for page-by-page comparison
    sitemap: null as string | null, // Path to local sitemap XML file
    compareSitemap: null as string | null, // Path to local sitemap XML file for comparison site
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
    exclude: [] as string[], // URL patterns to exclude from crawling
    limit: null, // Max pages to audit
    dryRun: false, // Show what would be audited without crawling
    generateCi: false, // Generate GitHub Actions workflow
    validateConfig: false, // Validate config file and exit
    webhook: null, // URL to POST audit results to
    version: false, // Show version
    help: false, // Show help text
    open: false, // Auto-open HTML report in browser
    verbose: false, // Verbose output (per-URL logging)
    preset: null, // Audit preset: quick, standard, deep, sales, marketing, seo, custom
    sections: [] as string[], // --sections for --preset=custom
    checks: [] as string[], // --checks for --preset=custom
    sites: null, // File with list of URLs for batch audit
    slack: null, // Slack webhook URL for notifications
    watch: null, // Watch mode interval in minutes
    brandLogo: null, // Custom logo URL for report branding
    brandName: null, // Custom brand name for report
    ci: null, // CI mode: exit code 1 if score < threshold
    json: false, // Output JSON summary to stdout
    phase2: true, // Generate Phase 2 curated PDF report (--no-phase2 to skip)
    // The four LLM passes below are all enabled together by the single `--llm` flag.
    llmNarrative: false, // Rewrite per-section Analysis prose
    llmFindings: false, // Vision + signals pass for emergent functional/UX anomalies
    llmRepo: false, // Reason over the source repo (find more / confirm / fix) atop --repo
    llmVerify: false, // Revalidate findings + drop confirmed duplicates/false positives before the final report
    verify: false, // Phase 3 verification — re-check each finding's first example (live by default; crawl data with SEO_AUDIT_VERIFY_OFFLINE=1), emit a separate verified report
    visual: null as boolean | null, // --visual / --no-visual; null defers to `.seoauditrc` (default off)
    agentic: null,
    noScore: false, // When true, strip all scores (category projections + per-finding point chips) from the curated PDF report
    evidence: true, // Capture per-page evidence for representative URLs (--no-evidence to skip)
    evidenceCap: 10, // Max representative pages to capture (default 10)
    lead: false, // --lead: lead scan of a prospect site (small, passive, own results folder)
    passive: false, // --passive: skip the site probes that go beyond reading published pages
    contentResearch: false, // Phase 4 — competitive content research + content plan (opt-in)
    competitors: null, // Competitor URLs (CSV or file path); optional — LLM discovers when omitted
    warnings: [] as string[], // Collect validation warnings
    errors: [] as string[], // Fatal argument errors
  };

  let evidenceCapExplicit = false;
  for (const arg of args) {
    if (arg === '--lead') {
      parsed.lead = true;
    } else if (arg === '--passive') {
      parsed.passive = true;
    } else if (arg === '--version' || arg === '-V') {
      parsed.version = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--open') {
      parsed.open = true;
    } else if (arg === '--verbose' || arg === '-v') {
      parsed.verbose = true;
    } else if (arg.startsWith('--preset=')) {
      const preset = arg.substring('--preset='.length).toLowerCase();
      if (isPresetName(preset)) {
        parsed.preset = preset;
      } else {
        parsed.errors.push(unknownPresetMessage(preset));
      }
    } else if (arg.startsWith('--sections=')) {
      parsed.sections = parseCsvList(arg.substring('--sections='.length));
    } else if (arg.startsWith('--checks=')) {
      parsed.checks = parseCsvList(arg.substring('--checks='.length));
    } else if (arg.startsWith('--ci=')) {
      const val = parseInt(arg.substring('--ci='.length), 10);
      parsed.ci = isNaN(val) ? 70 : Math.max(0, Math.min(100, val));
    } else if (arg === '--ci') {
      parsed.ci = 70; // Default threshold
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--no-phase2') {
      parsed.phase2 = false;
    } else if (arg === '--phase2') {
      parsed.phase2 = true;
    } else if (arg === '--verify') {
      parsed.verify = true;
    } else if (
      arg === '--llm-narrative' ||
      arg === '--llm-findings' ||
      arg === '--llm-repo' ||
      arg === '--llm-verify'
    ) {
      // Removed in favour of the single `--llm` flag — warn rather than silently no-op.
      parsed.warnings.push(`${arg} was removed — use --llm to enable all AI passes.`);
    } else if (arg === '--llm') {
      // Single flag for the whole AI pass set: section-narrative rewrite,
      // emergent-bug findings, source-repo reasoning (with --repo), and
      // finding-revalidation before the final report. (Phase 3 `--verify` is
      // separate — it is deterministic-first and runs offline without a key.)
      parsed.llmNarrative = true;
      parsed.llmFindings = true;
      parsed.llmRepo = true;
      parsed.llmVerify = true;
    } else if (arg === '--visual') {
      parsed.visual = true;
    } else if (arg === '--no-visual') {
      parsed.visual = false;
    } else if (arg === '--agentic') {
      parsed.agentic = true;
    } else if (arg === '--no-agentic') {
      parsed.agentic = false;
    } else if (arg === '--no-score') {
      parsed.noScore = true;
    } else if (arg === '--score') {
      parsed.noScore = false;
    } else if (arg === '--content-research') {
      parsed.contentResearch = true;
    } else if (arg.startsWith('--competitors=')) {
      const val = arg.substring('--competitors='.length).trim();
      parsed.competitors = val || null;
    } else if (arg === '--no-evidence') {
      parsed.evidence = false;
    } else if (arg === '--evidence') {
      parsed.evidence = true;
    } else if (arg.startsWith('--evidence-cap=')) {
      const val = parseInt(arg.substring('--evidence-cap='.length), 10);
      if (isNaN(val) || val < 1) {
        parsed.warnings.push(`Invalid --evidence-cap value "${arg.substring('--evidence-cap='.length)}" — must be a positive integer. Ignoring.`);
      } else {
        parsed.evidenceCap = Math.min(val, 100); // safety ceiling
        evidenceCapExplicit = true;
      }
    } else if (arg.startsWith('--origin=')) {
      parsed.origin = arg.substring('--origin='.length);
    } else if (arg.startsWith('--compare=')) {
      parsed.compare = arg.substring('--compare='.length);
    } else if (arg.startsWith('--sitemap=')) {
      parsed.sitemap = arg.substring('--sitemap='.length);
    } else if (arg.startsWith('--compare-sitemap=')) {
      parsed.compareSitemap = arg.substring('--compare-sitemap='.length);
    } else if (arg === '--proceed') {
      parsed.proceed = true;
    } else if (arg === '--perf') {
      parsed.perf = true;
    } else if (arg === '--save-html') {
      parsed.saveHtml = true;
    } else if (arg === '--screenshots') {
      parsed.screenshots = true;
    } else if (arg.startsWith('--concurrency=')) {
      const rawValue = arg.substring('--concurrency='.length);
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
              `(Free memory: ${freeMemoryMB}MB)`,
          );
          parsed.concurrency = maxSafe;
        } else {
          parsed.concurrency = value;
        }
        parsed.concurrencyExplicit = true;
      }
    } else if (arg.startsWith('--heap-size=')) {
      const rawValue = arg.substring('--heap-size='.length);
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
    } else if (arg.startsWith('--config=')) {
      parsed.config = arg.substring('--config='.length);
    } else if (arg === '--init-config') {
      parsed.initConfig = true;
    } else if (arg.startsWith('--repo=')) {
      parsed.repo = arg.substring('--repo='.length);
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--generate-ci') {
      parsed.generateCi = true;
    } else if (arg === '--validate-config') {
      parsed.validateConfig = true;
    } else if (arg.startsWith('--webhook=')) {
      parsed.webhook = arg.substring('--webhook='.length);
    } else if (arg.startsWith('--sites=')) {
      parsed.sites = arg.substring('--sites='.length);
    } else if (arg.startsWith('--slack=')) {
      parsed.slack = arg.substring('--slack='.length);
    } else if (arg.startsWith('--watch=')) {
      const val = parseInt(arg.substring('--watch='.length), 10);
      parsed.watch = isNaN(val) ? 60 : Math.max(1, val);
    } else if (arg === '--watch') {
      parsed.watch = 60; // Default 60 minutes
    } else if (arg.startsWith('--brand-logo=')) {
      parsed.brandLogo = arg.substring('--brand-logo='.length);
    } else if (arg.startsWith('--brand-name=')) {
      parsed.brandName = arg.substring('--brand-name='.length);
    } else if (arg.startsWith('--exclude=')) {
      const pattern = arg.substring('--exclude='.length);
      if (pattern) parsed.exclude.push(pattern);
    } else if (arg.startsWith('--limit=')) {
      const rawValue = arg.substring('--limit='.length);
      const value = parseInt(rawValue, 10);
      if (isNaN(value) || value < 1) {
        parsed.warnings.push(`Invalid limit value "${rawValue}" - must be a positive number. Ignoring.`);
      } else {
        parsed.limit = value;
      }
    } else if (
      arg !== '--origin' &&
      arg !== '--compare' &&
      arg !== '--sitemap' &&
      arg !== '--compare-sitemap' &&
      arg !== '--concurrency' &&
      arg !== '--heap-size' &&
      arg !== '--config' &&
      arg !== '--repo'
    ) {
      // Unknown flag - ignore silently (could be a typo)
    }
  }

  if (parsed.lead) applyLeadMode(parsed, { evidenceCapExplicit });
  return parsed;
}

/** Lead-scan settings. The page cap is a ceiling: `--limit` can lower it, never raise it. */
export const LEAD_MODE = { pageCap: 25, concurrency: 3, evidenceCap: 5, resultsBase: 'lead-results' } as const;

/**
 * `--lead`: a scan of a site whose owner did not ask for it. Small (one total page cap), slow
 * (few pages at a time), passive (no probing), and kept apart from full audits (own results
 * folder, no curated report, no history entry). Nothing here applies without the flag.
 */
export function applyLeadMode(parsed: ParsedArgs, opts: { evidenceCapExplicit?: boolean } = {}): void {
  parsed.passive = true;
  parsed.limit = Math.min(parsed.limit ?? LEAD_MODE.pageCap, LEAD_MODE.pageCap);
  if (!parsed.concurrencyExplicit || parsed.concurrency > LEAD_MODE.concurrency) {
    parsed.concurrency = LEAD_MODE.concurrency;
  }
  parsed.visual ??= true;
  if (!opts.evidenceCapExplicit) parsed.evidenceCap = LEAD_MODE.evidenceCap;
  parsed.phase2 = false;

  const dropped: string[] = [];
  if (parsed.perf) {
    parsed.perf = false;
    dropped.push('--perf (a lead scan uses real-user data, not a throttled lab run on every page)');
  }
  if (parsed.verify) {
    parsed.verify = false;
    dropped.push('--verify');
  }
  if (parsed.llmNarrative || parsed.llmFindings || parsed.llmRepo || parsed.llmVerify) {
    parsed.llmNarrative = parsed.llmFindings = parsed.llmRepo = parsed.llmVerify = false;
    dropped.push('--llm');
  }
  if (parsed.contentResearch) {
    parsed.contentResearch = false;
    dropped.push('--content-research');
  }
  if (dropped.length) parsed.warnings.push(`--lead ignores ${dropped.join(', ')}.`);
  for (const [flag, value] of [['--compare', parsed.compare], ['--sites', parsed.sites], ['--repo', parsed.repo], ['--sitemap', parsed.sitemap]] as const) {
    if (value) parsed.errors.push(`--lead cannot be combined with ${flag}.`);
  }
}

/** Child-process flags that carry `--lead` / `--passive` across a `start.ts` restart. */
export function leadChildArgs(args: Pick<ParsedArgs, 'lead' | 'passive'>): string[] {
  if (args.lead) return ['--lead'];
  return args.passive ? ['--passive'] : [];
}

export { parseArgs, calculateSafeConcurrency };

/** Child-process flags that carry an explicit `--visual` / `--no-visual` choice across a `start.ts` restart. */
export function visualChildArgs(visual: boolean | null | undefined): string[] {
  if (visual === true) return ['--visual'];
  if (visual === false) return ['--no-visual'];
  return [];
}

/** Child-process flags that carry an explicit `--agentic` / `--no-agentic` choice across a `start.ts` restart. */
export function agenticChildArgs(agentic: boolean | null | undefined): string[] {
  if (agentic === true) return ['--agentic'];
  if (agentic === false) return ['--no-agentic'];
  return [];
}
