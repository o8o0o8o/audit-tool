/**
 * Lead pipeline: the sales-audit stages for the prospect list in docs/gtm/companies.csv.
 * Design: docs/gtm/sales-audit-system.md. Plan: docs/gtm/sales-audit-roadmap.md.
 *
 * Usage:
 *   npx tsx scripts/lead-pipeline.ts <command> [options]
 *
 * Commands:
 *   fingerprint   Stage 1: read each site's homepage + robots.txt and write the stack columns.
 *                 --only=<domain>      one site
 *                 --limit=<n>          at most n sites this run
 *                 --concurrency=<n>    sites in parallel (default 10; one or two requests per site)
 *                 --refresh            also redo rows that already have a fingerprint
 *                 --retry-unreadable   redo rows marked unreadable
 *                 --kinds=<a,b>        redo rows whose stack kind is one of these (after a rule change)
 *                 --no-browser         do not retry refused sites in headless Chromium
 *   summary       Counts per stack kind, confidence and end-of-life hits (the Gate 1 numbers).
 *   score         Stage 2: write fit_score, track and fit_reasons for every fingerprinted row.
 *                 --weights=<path>     weights file (default docs/gtm/lead-weights.json)
 *   select        Stage 2: score, then mark the top rows `selected` and the rest `parked`.
 *                 --top=<n>            how many to select (required)
 *                 --track=migrate|optimise   only rows on this track; the other track's selection is kept
 *                 --min-score=<n>      only rows with at least this score
 *                 --dry-run            print the choice, write nothing
 *   scan          Stage 3: lead scan (`start.ts --lead`) of every `selected` row, one site at a time.
 *                 --only=<domain>      one site, whatever its stage (except do_not_contact)
 *                 --limit=<n>          at most n sites this run
 *                 --timeout-min=<n>    hard limit per site (default 15); the whole process tree is stopped
 *                 --retry-failed       also take `failed` rows that have retries left (2 at most)
 *                 --page-limit=<n>     fewer pages than the lead cap of 25 (for a trial run)
 *                 --scan-only          stop after the scan; do not run the gate
 *   gate          Stages 4-5: build candidate highlights from a scan and confirm each by a second
 *                 method. Writes <run>/lead/lead.json; the row becomes teaser_ready or no_teaser.
 *                 --only=<domain>      one site
 *                 --run=<dir>          use this run folder (a lead scan or a full audit), with --only
 *                 --min-causes=<n>     distinct root causes needed for a teaser (default 3)
 *                 --no-browser         skip the checks that need a browser click
 *   disclosed <domain>   Record that a security disclosure was sent; outreach is blocked until then.
 *   teaser        Stage 6: write teaser.md, teaser.pdf and email.md for every teaser_ready row.
 *                 --only=<domain>      one site
 *   review        Write lead-results/leads-review.html: one card per teaser waiting for a verdict.
 *   approve <domain>                   All highlights confirmed by the reviewer → approved.
 *   reject <domain> --highlight=<n> --reason="…" [--factual]
 *                 One highlight refused → rejected. --factual: the fact itself is wrong; the finding
 *                 type is suspended until `resume-type <type>`.
 *   recheck <domain>                   Re-run the gate on the day of sending; a fact that no longer
 *                 holds sends the row back for review.
 *   mark <domain> <stage>              Record an outcome: sent, replied, no_reply, call_booked,
 *                 full_audit, do_not_contact. `sent` needs a recheck made the same day.
 *   precision     Approval rate per finding type, from docs/gtm/review-log.csv.
 *   resume-type <type>                 Put a suspended finding type back on the allowlist.
 *
 * Common options:
 *   --csv=<path>   prospect list (default docs/gtm/companies.csv)
 *   --out=<dir>    where fingerprint files and logs go (default lead-results). Lead scans themselves
 *                  are always written to lead-results/<domain>/<timestamp>/.
 *
 * Rows whose `stage` is `do_not_contact` are never touched by any command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPool } from '../lib/analyzers/site-checks/http-probe';
import {
  DEFAULT_COMPANIES_CSV,
  KEY_COLUMN,
  actionable,
  domainOf,
  originOf,
  readCompanies,
  updateCompanies,
  type CompanyRecord,
  type RowUpdate,
} from '../lib/leads/csv-store';
import {
  BrowserSession,
  fingerprintSite,
  httpPageFetcher,
  stackColumns,
  type BrowserReader,
} from '../lib/leads/fingerprint';
import { PlaywrightGateBrowser } from '../lib/leads/gate-browser';
import { buildLeadFile, leadDir, readLeadFile, writeLeadFile, type LeadFile } from '../lib/leads/lead-file';
import {
  appendReviewRows,
  precisionByType,
  readReviewRows,
  readSuspended,
  resumeType,
  suspendType,
} from '../lib/leads/review-log';
import { buildReviewPage, type ReviewCard } from '../lib/leads/review-page';
import { TEASER_CSS, TeaserError, buildTeaser, loadTeaserConfig } from '../lib/leads/teaser';
import { renderMarkdownToPdf } from '../lib/reports/pdf-renderer';
import { LEAD_RESULTS_DIR, stackJsonPath } from '../lib/leads/paths';
import { loadRun } from '../lib/leads/run-data';
import { GATE_DEFAULTS, runGate } from '../lib/leads/truth-gate';
import type { FingerprintResult, Track } from '../lib/leads/types';
import { readLatestRun, runAuditProcess } from '../lib/leads/run-audit';
import { DEFAULT_WEIGHTS_PATH, formatReasons, loadWeights, rank, type Ranked } from '../lib/leads/score';
import { MAX_SCAN_RETRIES, SELECTABLE_STAGES, canMove, isStage, stageOf, stageValues } from '../lib/leads/stages';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--'));
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const numberOption = (name: string, fallback: number) => {
  const raw = option(name);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const csvPath = option('csv') ?? DEFAULT_COMPANIES_CSV;
const outDir = option('out') ?? LEAD_RESULTS_DIR;

function usage(): never {
  const header = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  console.log(header.replace(/^ \* ?/gm, '').trim());
  process.exit(command ? 1 : 0);
}

/** At most `limit` calls of `fn` in flight; used to keep browser retries from piling up. */
function limited<A extends unknown[], R>(limit: number, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (...args: A) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn(...args);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const count = <T>(items: T[], key: (item: T) => string) => {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return [...out].sort((a, b) => b[1] - a[1]);
};

function printTable(title: string, rows: Array<[string, number]>, total: number) {
  console.log(`\n${title}`);
  for (const [name, n] of rows) {
    console.log(`  ${name.padEnd(28)} ${String(n).padStart(5)}  ${((n / Math.max(total, 1)) * 100).toFixed(1)}%`);
  }
}

async function fingerprint() {
  const only = option('only');
  const refresh = flag('refresh');
  const retryUnreadable = flag('retry-unreadable');
  const redoKinds = (option('kinds') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const records = actionable(readCompanies(csvPath));

  let todo = records.filter((r) => {
    if (only) return domainOf(r[KEY_COLUMN]) === domainOf(only);
    if (refresh) return true;
    if (!r.fingerprinted_at?.trim()) return true;
    if (redoKinds.includes(r.stack_kind)) return true;
    return retryUnreadable && r.stack_kind === 'unreadable';
  });
  const limit = numberOption('limit', todo.length);
  todo = todo.slice(0, limit);
  if (!todo.length) {
    console.log('Nothing to fingerprint. Use --refresh to redo existing rows.');
    return;
  }

  const session = flag('no-browser') ? null : new BrowserSession();
  const readInBrowser: BrowserReader | undefined = session ? limited(2, session.read) : undefined;
  const concurrency = numberOption('concurrency', 10);
  console.log(`Fingerprinting ${todo.length} site(s), ${concurrency} at a time${session ? '' : ', no browser retry'}…`);

  let pending: RowUpdate[] = [];
  let done = 0;
  let requests = 0;
  const kinds: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    const missing = updateCompanies(csvPath, pending);
    if (missing.length) console.warn(`  ⚠️  Not found in the CSV any more: ${missing.join(', ')}`);
    pending = [];
  };
  const onSigint = () => {
    flush();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    await runPool(todo, concurrency, async (record: CompanyRecord) => {
      const website = record[KEY_COLUMN];
      const result = await fingerprintSite(website, { readInBrowser });
      const file = stackJsonPath(result.domain, outDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 2));
      pending.push({ website, values: stackColumns(result) });
      requests += result.requestsSent;
      kinds.push(result.profile.kind);
      done++;
      const p = result.profile;
      const what = result.unreadableReason
        ? `unreadable (${result.unreadableReason})`
        : `${p.kind}${p.cms ? ` · ${p.cms}${p.cmsVersion ? ` ${p.cmsVersion}` : ''}` : ''}${p.framework ? ` · ${p.framework}` : ''} · ${p.confidence}`;
      console.log(`  [${done}/${todo.length}] ${result.domain}: ${what}`);
      if (pending.length >= 20) flush();
    });
  } finally {
    flush();
    process.off('SIGINT', onSigint);
    await session?.close();
  }

  printTable(
    'This run, by stack kind',
    count(kinds, (k) => k),
    kinds.length,
  );
  console.log(`\nRequests sent to prospect sites: ${requests} (${(requests / kinds.length).toFixed(1)} per site)`);
  console.log(`Stack columns written to ${csvPath}; details in ${outDir}/<domain>/stack.json`);
}

function summary() {
  const all = readCompanies(csvPath).filter((r) => r[KEY_COLUMN]?.trim());
  const done = all.filter((r) => r.fingerprinted_at?.trim());
  console.log(`${csvPath}: ${all.length} rows, ${done.length} fingerprinted, ${all.length - done.length} not yet.`);
  if (!done.length) return;

  const readable = done.filter((r) => r.stack_kind !== 'unreadable');
  printTable(
    'Stack kind',
    count(done, (r) => r.stack_kind || '(empty)'),
    done.length,
  );
  printTable(
    'Confidence (readable sites)',
    count(readable, (r) => r.stack_confidence || '(empty)'),
    readable.length,
  );
  printTable('CMS detected (top 25)', count(readable, (r) => r.cms_detected || '(none)').slice(0, 25), readable.length);
  printTable('Front end (top 12)', count(readable, (r) => r.framework || '(none)').slice(0, 12), readable.length);

  const unreadable = done.filter((r) => r.stack_kind === 'unreadable');
  if (unreadable.length) {
    printTable(
      'Unreadable, by reason',
      count(unreadable, (r) => r.stack_signals.replace(/^unreadable:/, '')),
      unreadable.length,
    );
  }

  const withEol = readable.filter((r) => r.eol?.trim());
  console.log(`\nEnd-of-life hits: ${withEol.length} site(s)`);
  printTable(
    'End-of-life, by product',
    count(
      withEol.flatMap((r) => r.eol.split(';').map((e) => e.trim().replace(/\s+\(ended.*$/, ''))),
      (e) => e,
    ).slice(0, 20),
    withEol.length,
  );

  const traffic = (r: CompanyRecord) => Number(r.traffic) || 0;
  const migrate = readable.filter((r) => ['legacy', 'hybrid'].includes(r.stack_kind));
  console.log(`\nMigrate track (legacy or hybrid): ${migrate.length}`);
  console.log(`  with traffic of 10k or more:    ${migrate.filter((r) => traffic(r) >= 10_000).length}`);
  console.log(`  at high confidence:             ${migrate.filter((r) => r.stack_confidence === 'high').length}`);

  const tagChanged = readable.filter(
    (r) =>
      r.cms?.trim() &&
      r.cms_detected &&
      !r.cms_detected.toLowerCase().includes(r.cms.trim().toLowerCase().split(/[;,]/)[0]),
  );
  console.log(
    `\nRows where the detected CMS differs from the list's "cms" tag: ${tagChanged.length} of ${readable.filter((r) => r.cms?.trim()).length} tagged`,
  );
}

const scoreValues = (r: Ranked): Record<string, string> => ({
  fit_score:
    r.fit.blocker === 'not fingerprinted yet' || r.record.stack_kind === 'unreadable' ? '' : String(r.fit.score),
  track: r.fit.track ?? '',
  fit_reasons: formatReasons(r.fit),
});

function rankAll(): Ranked[] {
  const weights = loadWeights(option('weights') ?? DEFAULT_WEIGHTS_PATH);
  return rank(actionable(readCompanies(csvPath)), weights).filter((r) => r.record.fingerprinted_at?.trim());
}

function printRanked(rows: Ranked[]) {
  for (const [i, r] of rows.entries()) {
    const rec = r.record;
    console.log(
      `  ${String(i + 1).padStart(3)}. ${String(r.fit.score).padStart(3)}  ${(r.fit.track ?? '-').padEnd(8)} ${domainOf(rec[KEY_COLUMN]).padEnd(30)} ${formatReasons(r.fit)}`,
    );
  }
}

function printMissing(rows: Ranked[]) {
  const missing = count(
    rows.flatMap((r) => r.fit.missing),
    (m) => m,
  );
  if (missing.length) {
    console.log('\nSignals with no data (they score zero):');
    for (const [name, n] of missing) console.log(`  ${name.padEnd(16)} ${n} of ${rows.length} rows`);
  }
}

function score() {
  const ranked = rankAll();
  if (!ranked.length) {
    console.log('No fingerprinted rows yet. Run `fingerprint` first.');
    return;
  }
  updateCompanies(
    csvPath,
    ranked.map((r) => ({ website: r.record[KEY_COLUMN], values: scoreValues(r) })),
  );
  console.log(`Scored ${ranked.length} row(s). Top 20:`);
  printRanked(ranked.filter((r) => !r.fit.blocker).slice(0, 20));
  printTable(
    'Track',
    count(
      ranked.filter((r) => r.fit.track),
      (r) => r.fit.track ?? '',
    ),
    ranked.length,
  );
  printMissing(ranked);
}

function select() {
  const top = numberOption('top', 0);
  if (!top) {
    console.error('select needs --top=<n>');
    process.exit(1);
  }
  const track = option('track');
  if (track && track !== 'migrate' && track !== 'optimise') {
    console.error('--track must be migrate or optimise');
    process.exit(1);
  }
  const minScore = numberOption('min-score', 0);
  const dryRun = flag('dry-run');

  const ranked = rankAll();
  const selectable = ranked.filter((r) => SELECTABLE_STAGES.includes(stageOf(r.record)));
  const eligible = selectable.filter(
    (r) => !r.fit.blocker && (!track || r.fit.track === track) && r.fit.score >= minScore,
  );
  const chosen = eligible.slice(0, top);
  const chosenSites = new Set(chosen.map((r) => r.record[KEY_COLUMN]));

  console.log(
    `${dryRun ? 'Would select' : 'Selected'} ${chosen.length} of ${eligible.length} eligible row(s)${track ? ` on the ${track} track` : ''}:`,
  );
  printRanked(chosen);
  const blocked = count(
    selectable.filter((r) => r.fit.blocker),
    (r) => r.fit.blocker ?? '',
  );
  if (blocked.length) {
    console.log('\nNot eligible:');
    for (const [reason, n] of blocked) console.log(`  ${reason.padEnd(40)} ${n}`);
  }
  printMissing(ranked);
  if (dryRun) return;

  const now = new Date();
  const updates: RowUpdate[] = ranked.map((r) => {
    const values = scoreValues(r);
    const current = stageOf(r.record);
    // With --track, only rows on that track are re-picked; a selection made for the other track stays.
    const inScope = !track || r.fit.track === track;
    if (SELECTABLE_STAGES.includes(current) && inScope) {
      const next = chosenSites.has(r.record[KEY_COLUMN]) ? 'selected' : 'parked';
      if (r.record.stage !== next) Object.assign(values, stageValues(next, now));
    } else if (!r.record.stage?.trim()) {
      Object.assign(values, stageValues(current, now)); // make a derived stage (unreadable) visible in the sheet
    }
    return { website: r.record[KEY_COLUMN], values };
  });
  updateCompanies(csvPath, updates);
  console.log(`\nWrote fit_score, track, fit_reasons and stage to ${csvPath}.`);
}

/** The origin to scan: where the fingerprint landed (www host, https), else the listed website. */
function scanOrigin(record: CompanyRecord): string {
  try {
    const stack = JSON.parse(fs.readFileSync(stackJsonPath(domainOf(record[KEY_COLUMN]), outDir), 'utf8')) as {
      finalUrl?: string | null;
      redirectedTo?: string | null;
    };
    if (stack.finalUrl && !stack.redirectedTo) return new URL(stack.finalUrl).origin;
  } catch {
    // no fingerprint file: fall back to the listed website
  }
  return originOf(record[KEY_COLUMN]);
}

const SCAN_LOG_HEADER = [
  'domain',
  'started_at',
  'result',
  'seconds',
  'pages_ok',
  'pages_failed',
  'pages_loaded',
  'requests',
  'field_data',
  'note',
];

function appendScanLog(row: string[]) {
  const file = path.join(outDir, 'scan-log.csv');
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${SCAN_LOG_HEADER.join(',')}\n`);
  fs.appendFileSync(file, `${row.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')}\n`);
}

async function scan() {
  const only = option('only');
  const retryFailed = flag('retry-failed');
  const timeoutMin = numberOption('timeout-min', 15);
  const pageLimit = option('page-limit');
  const attemptsOf = (r: CompanyRecord) => Number(r.scan_attempts) || 0;

  let todo = actionable(readCompanies(csvPath)).filter((r) => {
    if (only) return domainOf(r[KEY_COLUMN]) === domainOf(only);
    const stage = stageOf(r);
    return stage === 'selected' || (retryFailed && stage === 'failed' && attemptsOf(r) <= MAX_SCAN_RETRIES);
  });
  todo = todo.slice(0, numberOption('limit', todo.length));
  if (!todo.length) {
    console.log('Nothing to scan. Run `select --top=<n>` first, or use --only=<domain>.');
    return;
  }
  if (!process.env.CRUX_API_KEY) {
    console.log(
      'Note: CRUX_API_KEY is not set in this shell. Unless the audit config supplies a key, scans will have no real-user performance data.',
    );
  }
  console.log(
    `Lead scan of ${todo.length} site(s), ${timeoutMin} min limit each. Output per site: ${LEAD_RESULTS_DIR}/<domain>/<timestamp>/`,
  );

  let done = 0;
  const outcomes: string[] = [];
  for (const record of todo) {
    // The row may have been marked do_not_contact (or scanned by another run) since the list was read.
    const fresh = readCompanies(csvPath).find((r) => r[KEY_COLUMN] === record[KEY_COLUMN]);
    if (!fresh || !actionable([fresh]).length) continue;

    const website = record[KEY_COLUMN];
    const domain = domainOf(website);
    const origin = scanOrigin(record);
    const startedAt = new Date();
    const logFile = path.join(outDir, domain, 'scan.log');
    console.log(`\n[${++done}/${todo.length}] ${domain} → ${origin}`);

    const args = [`--origin=${origin}`, '--lead', ...(pageLimit ? [`--limit=${pageLimit}`] : [])];
    const run = await runAuditProcess(args, { timeoutMs: timeoutMin * 60_000, logFile });
    const summary = readLatestRun(origin, LEAD_RESULTS_DIR, startedAt);
    const seconds = Math.round(run.durationMs / 1000);

    let note: string;
    let ok = false;
    if (run.timedOut) note = `timed out after ${timeoutMin} min`;
    else if (!run.ok) note = `audit exited with code ${run.exitCode}`;
    else if (!summary) note = 'no run folder written';
    else if (summary.pagesOk === 0) {
      const errors = Object.keys(summary.errors)
        .filter((k) => !/^total/i.test(k))
        .join(', ');
      note = `no page could be read${errors ? ` (${errors})` : ''}`;
    } else {
      ok = true;
      note = `${summary.pagesOk} page(s) read, ${summary.leadScan?.requests?.total ?? '?'} requests, ${seconds}s`;
    }

    const attempts = attemptsOf(fresh) + 1;
    updateCompanies(csvPath, [
      {
        website,
        values: {
          ...stageValues(ok ? 'scanned' : 'failed', new Date()),
          run_dir: ok && summary ? summary.runDir : (fresh.run_dir ?? ''),
          scan_attempts: String(attempts),
          scan_note: note,
        },
      },
    ]);
    appendScanLog([
      domain,
      startedAt.toISOString(),
      ok ? 'scanned' : 'failed',
      String(seconds),
      String(summary?.pagesOk ?? 0),
      String(summary?.pagesFailed ?? 0),
      String(summary?.leadScan?.pagesLoaded ?? ''),
      String(summary?.leadScan?.requests?.total ?? ''),
      summary ? (summary.hasFieldData ? 'yes' : 'no') : '',
      note,
    ]);
    outcomes.push(ok ? 'scanned' : 'failed');
    console.log(`    ${ok ? '✓' : '✗'} ${note}${ok ? '' : ` — log: ${logFile}`}`);
    if (ok && summary && !flag('scan-only')) {
      const row = readCompanies(csvPath).find((r) => r[KEY_COLUMN] === website);
      if (row) await gateOne(row, summary.runDir, gateBrowserEnabled());
    }
  }

  printTable(
    'This run',
    count(outcomes, (o) => o),
    outcomes.length,
  );
  console.log(`\nPer-scan measurements: ${path.join(outDir, 'scan-log.csv')}`);
}

const gateBrowserEnabled = () => !flag('no-browser');

function readStack(domain: string): FingerprintResult | null {
  try {
    return JSON.parse(fs.readFileSync(stackJsonPath(domain, outDir), 'utf8')) as FingerprintResult;
  } catch {
    return null;
  }
}

/** Runs the gate for one row on one run folder, writes lead.json and moves the row's stage. */
async function gateOne(record: CompanyRecord, runDir: string, useBrowser: boolean): Promise<LeadFile | null> {
  const website = record[KEY_COLUMN];
  const domain = domainOf(website);
  let run;
  try {
    run = loadRun(runDir);
  } catch (error) {
    console.log(`    ✗ gate: ${(error as Error).message}`);
    return null;
  }
  const stack = readStack(domain)?.profile ?? null;
  const browser = useBrowser
    ? new PlaywrightGateBrowser(path.join(leadDir(runDir), 'evidence'), leadDir(runDir))
    : null;
  let lead: LeadFile;
  try {
    const gate = await runGate(
      run,
      stack,
      { get: httpPageFetcher, browser },
      { minCauses: numberOption('min-causes', GATE_DEFAULTS.minCauses), suspendedTypes: Object.keys(readSuspended()) },
    );
    lead = buildLeadFile({
      domain,
      company: record.company ?? domain,
      run,
      stack,
      gate,
      fitScore: record.fit_score ? Number(record.fit_score) : null,
      track: (record.track as Track) || null,
      scannedAt: record.stage_at ?? null,
    });
  } finally {
    await browser?.close();
  }
  const file = writeLeadFile(lead);

  const stage = stageOf(record);
  const next = lead.teaserReady ? 'teaser_ready' : 'no_teaser';
  const values: Record<string, string> = {
    run_dir: runDir,
    gate_at: lead.checkedAt,
    gate_causes: lead.causes.join('; '),
  };
  // Only rows in the scan part of the lifecycle move; a row already approved or sent keeps its stage.
  if (
    ['scanned', 'no_teaser', 'teaser_ready', 'selected', 'failed', 'fingerprinted', 'parked', 'new'].includes(stage)
  ) {
    Object.assign(values, stageValues(next, new Date()));
  }
  if (lead.disclosure.length && !record.disclosed?.trim()) values.disclosed = 'pending';
  updateCompanies(csvPath, [{ website, values }]);

  const control = lead.control.note ? ` (control: ${lead.control.note})` : '';
  console.log(
    `    gate: ${lead.causes.length} distinct cause(s)${lead.causes.length ? ` — ${lead.causes.join(', ')}` : ''} → ${next}${control}`,
  );
  for (const h of lead.highlights) console.log(`      • ${h.fact}`);
  if (lead.disclosure.length) {
    console.log(
      `      ⚠️  Security exposure found (${lead.disclosure.map((d) => d.check).join(', ')}): disclose it before any outreach. Row marked disclosed=pending.`,
    );
  }
  console.log(`      ${file}`);
  if (lead.teaserReady && !lead.disclosure.length) await writeTeaser(lead);
  return lead;
}

/** Writes teaser.md, email.md and teaser.pdf next to lead.json. Returns false when no teaser may be built. */
async function writeTeaser(lead: LeadFile): Promise<boolean> {
  const dir = leadDir(lead.runDir);
  let teaser;
  try {
    teaser = buildTeaser(lead, loadTeaserConfig());
  } catch (error) {
    if (!(error instanceof TeaserError)) throw error;
    console.log(`      no teaser: ${error.message}`);
    return false;
  }
  fs.writeFileSync(path.join(dir, 'teaser.md'), teaser.markdown);
  fs.writeFileSync(path.join(dir, 'email.md'), teaser.email);
  try {
    await renderMarkdownToPdf(teaser.markdown, path.join(dir, 'teaser.pdf'), {
      title: teaser.subject,
      imageBaseDir: dir,
      customCss: TEASER_CSS,
    });
    console.log(`      teaser: ${path.join(dir, 'teaser.pdf')}`);
  } catch (error) {
    console.log(`      teaser.md written; the PDF failed: ${(error as Error).message}`);
  }
  return true;
}

const positional = (n: number) => argv.filter((a) => !a.startsWith('--'))[n];

function findRow(domain: string | undefined): CompanyRecord {
  const record = domain ? readCompanies(csvPath).find((r) => domainOf(r[KEY_COLUMN]) === domainOf(domain)) : undefined;
  if (!record) {
    console.error(domain ? `No row for ${domain} in ${csvPath}` : 'A domain is required.');
    process.exit(1);
  }
  if (!actionable([record]).length) {
    console.error(`${domainOf(record[KEY_COLUMN])} is marked do_not_contact; nothing is done for it.`);
    process.exit(1);
  }
  return record;
}

function leadOf(record: CompanyRecord): LeadFile {
  const lead = record.run_dir?.trim() ? readLeadFile(record.run_dir.trim()) : null;
  if (!lead) {
    console.error(
      `${domainOf(record[KEY_COLUMN])}: no lead.json yet. Run \`gate --only=${domainOf(record[KEY_COLUMN])}\` first.`,
    );
    process.exit(1);
  }
  return lead;
}

async function teaser() {
  const only = option('only');
  const todo = actionable(readCompanies(csvPath)).filter((r) =>
    only ? domainOf(r[KEY_COLUMN]) === domainOf(only) : stageOf(r) === 'teaser_ready',
  );
  if (!todo.length) {
    console.log('No row is teaser_ready.');
    return;
  }
  for (const record of todo) {
    const domain = domainOf(record[KEY_COLUMN]);
    console.log(`\n${domain}`);
    if (record.disclosed === 'pending') {
      console.log('      blocked: a security disclosure is pending for this company.');
      continue;
    }
    await writeTeaser(leadOf(record));
  }
}

function review() {
  const cards: ReviewCard[] = [];
  for (const record of actionable(readCompanies(csvPath))) {
    if (stageOf(record) !== 'teaser_ready' || !record.run_dir?.trim()) continue;
    const lead = readLeadFile(record.run_dir.trim());
    if (lead) cards.push({ lead, stage: stageOf(record), disclosed: record.disclosed ?? '' });
  }
  cards.sort((a, b) => (b.lead.fitScore ?? 0) - (a.lead.fitScore ?? 0));
  const file = path.join(LEAD_RESULTS_DIR, 'leads-review.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildReviewPage(cards, path.dirname(file)));
  console.log(`${cards.length} teaser(s) to review: ${file}`);
}

function approve() {
  const record = findRow(positional(1));
  const domain = domainOf(record[KEY_COLUMN]);
  if (stageOf(record) !== 'teaser_ready') {
    console.error(`${domain} is ${stageOf(record)}, not teaser_ready.`);
    process.exit(1);
  }
  if (record.disclosed === 'pending') {
    console.error(`${domain}: a security disclosure is pending. Send it and run \`disclosed ${domain}\` first.`);
    process.exit(1);
  }
  const lead = leadOf(record);
  const now = new Date();
  appendReviewRows(
    lead.highlights.slice(0, 3).map((h, i) => ({
      reviewedAt: now.toISOString(),
      domain,
      highlight: i + 1,
      type: h.type,
      rootCause: h.rootCause,
      verdict: 'approve' as const,
      factual: false,
      reason: '',
      fact: h.fact,
    })),
  );
  updateCompanies(csvPath, [{ website: record[KEY_COLUMN], values: stageValues('approved', now) }]);
  console.log(
    `${domain}: approved. On the day of sending run \`recheck ${domain}\`, then send email.md with teaser.pdf.`,
  );
}

function reject() {
  const record = findRow(positional(1));
  const domain = domainOf(record[KEY_COLUMN]);
  const n = numberOption('highlight', 0);
  const reason = option('reason')?.trim();
  const lead = leadOf(record);
  const highlight = lead.highlights[n - 1];
  if (!highlight || !reason) {
    console.error('Usage: reject <domain> --highlight=<1-3> --reason="…" [--factual]');
    process.exit(1);
  }
  if (stageOf(record) !== 'teaser_ready') {
    console.error(`${domain} is ${stageOf(record)}, not teaser_ready.`);
    process.exit(1);
  }
  const factual = flag('factual');
  const now = new Date();
  appendReviewRows([
    {
      reviewedAt: now.toISOString(),
      domain,
      highlight: n,
      type: highlight.type,
      rootCause: highlight.rootCause,
      verdict: 'reject',
      factual,
      reason,
      fact: highlight.fact,
    },
  ]);
  updateCompanies(csvPath, [{ website: record[KEY_COLUMN], values: stageValues('rejected', now) }]);
  console.log(`${domain}: highlight ${n} rejected (${reason}).`);
  if (factual) {
    suspendType(highlight.type, domain, reason);
    console.log(
      `The "${highlight.type}" type is suspended: the gate will not pass it for any prospect until \`resume-type ${highlight.type}\`.`,
    );
  }
}

async function recheck() {
  const record = findRow(positional(1));
  const domain = domainOf(record[KEY_COLUMN]);
  if (stageOf(record) !== 'approved') {
    console.error(`${domain} is ${stageOf(record)}; only an approved teaser is rechecked.`);
    process.exit(1);
  }
  const before = leadOf(record);
  const shown = before.highlights.slice(0, 3).map((h) => h.rootCause);
  console.log(`${domain}: checking the ${shown.length} approved point(s) again…`);
  const after = await gateOne(record, before.runDir, gateBrowserEnabled());
  const stillTrue = after ? shown.filter((cause) => after.causes.slice(0, 3).includes(cause)) : [];
  const now = new Date();
  if (after && stillTrue.length === shown.length && !after.disclosure.length) {
    updateCompanies(csvPath, [{ website: record[KEY_COLUMN], values: { rechecked_at: now.toISOString() } }]);
    console.log(
      `\n${domain}: all ${shown.length} point(s) still hold. The teaser carries today's date; send it today, then run \`mark ${domain} sent\`.`,
    );
  } else {
    const gone = shown.filter((c) => !stillTrue.includes(c));
    updateCompanies(csvPath, [
      { website: record[KEY_COLUMN], values: { ...stageValues('scanned', now), rechecked_at: '' } },
    ]);
    // The fresh gate result decides where the row goes next.
    const row = readCompanies(csvPath).find((r) => r[KEY_COLUMN] === record[KEY_COLUMN]);
    if (row && after)
      updateCompanies(csvPath, [
        { website: record[KEY_COLUMN], values: stageValues(after.teaserReady ? 'teaser_ready' : 'no_teaser', now) },
      ]);
    console.log(
      `\n${domain}: no longer true: ${gone.join(', ') || 'the result changed'}. Do not send. The row needs a new review.`,
    );
  }
}

function mark() {
  const record = findRow(positional(1));
  const domain = domainOf(record[KEY_COLUMN]);
  const to = positional(2) ?? '';
  const allowed = ['sent', 'replied', 'no_reply', 'call_booked', 'full_audit', 'do_not_contact'];
  if (!isStage(to) || !allowed.includes(to)) {
    console.error(`Usage: mark <domain> <${allowed.join('|')}>`);
    process.exit(1);
  }
  const from = stageOf(record);
  if (!canMove(from, to)) {
    console.error(`${domain} is ${from}; it cannot move to ${to}.`);
    process.exit(1);
  }
  if (to === 'sent') {
    const today = new Date().toISOString().slice(0, 10);
    if ((record.rechecked_at ?? '').slice(0, 10) !== today) {
      console.error(
        `${domain}: run \`recheck ${domain}\` today before sending. A teaser is only sent on the day its facts were last confirmed.`,
      );
      process.exit(1);
    }
  }
  updateCompanies(csvPath, [{ website: record[KEY_COLUMN], values: stageValues(to, new Date()) }]);
  console.log(`${domain}: ${from} → ${to}${to === 'do_not_contact' ? ' (permanent)' : ''}`);
}

function precision() {
  const rows = readReviewRows();
  if (!rows.length) {
    console.log('No verdicts recorded yet.');
    return;
  }
  console.log(`${rows.length} highlight verdict(s) in docs/gtm/review-log.csv\n`);
  console.log('  type                 approved  rejected  factual  approval');
  for (const t of precisionByType(rows)) {
    console.log(
      `  ${t.type.padEnd(20)} ${String(t.approved).padStart(8)}  ${String(t.rejected).padStart(8)}  ${String(t.factual).padStart(7)}  ${(t.rate * 100).toFixed(0).padStart(7)}%`,
    );
  }
  const suspended = Object.entries(readSuspended());
  if (suspended.length) {
    console.log('\nSuspended types:');
    for (const [type, s] of suspended) console.log(`  ${type} since ${s.since} (${s.domain}: ${s.reason})`);
  }
}

async function gate() {
  const only = option('only');
  const explicitRun = option('run');
  if (explicitRun && !only) {
    console.error('--run needs --only=<domain> to say which row the run belongs to');
    process.exit(1);
  }
  const todo = actionable(readCompanies(csvPath)).filter((r) => {
    if (only) return domainOf(r[KEY_COLUMN]) === domainOf(only);
    return stageOf(r) === 'scanned' && r.run_dir?.trim();
  });
  if (!todo.length) {
    console.log('Nothing to gate. Rows need stage `scanned` and a run_dir; or use --only=<domain> [--run=<dir>].');
    return;
  }
  const results: string[] = [];
  for (const [i, record] of todo.entries()) {
    const runDir = explicitRun ?? record.run_dir?.trim();
    console.log(`\n[${i + 1}/${todo.length}] ${domainOf(record[KEY_COLUMN])}`);
    if (!runDir) {
      console.log('    ✗ no run folder on the row; scan it first or pass --run=<dir>');
      continue;
    }
    const lead = await gateOne(record, runDir, gateBrowserEnabled());
    if (lead) results.push(lead.teaserReady ? 'teaser_ready' : 'no_teaser');
  }
  if (results.length > 1) {
    printTable(
      'Gate result',
      count(results, (r) => r),
      results.length,
    );
    console.log(
      `\nTeaser yield: ${results.filter((r) => r === 'teaser_ready').length} of ${results.length} scanned prospect(s).`,
    );
  }
}

function disclosed() {
  const domain = argv.filter((a) => !a.startsWith('--'))[1];
  const record = domain ? readCompanies(csvPath).find((r) => domainOf(r[KEY_COLUMN]) === domainOf(domain)) : null;
  if (!record) {
    console.error('Usage: lead-pipeline.ts disclosed <domain>');
    process.exit(1);
  }
  updateCompanies(csvPath, [
    { website: record[KEY_COLUMN], values: { disclosed: new Date().toISOString().slice(0, 10) } },
  ]);
  console.log(`${domainOf(record[KEY_COLUMN])}: disclosure recorded as sent today. Outreach is no longer blocked.`);
}

async function main() {
  if (!command || flag('help')) usage();
  if (!fs.existsSync(csvPath)) {
    console.error(`Prospect list not found: ${csvPath}`);
    process.exit(1);
  }
  switch (command) {
    case 'fingerprint':
      await fingerprint();
      break;
    case 'summary':
      summary();
      break;
    case 'score':
      score();
      break;
    case 'select':
      select();
      break;
    case 'scan':
      await scan();
      break;
    case 'gate':
      await gate();
      break;
    case 'disclosed':
      disclosed();
      break;
    case 'teaser':
      await teaser();
      break;
    case 'review':
      review();
      break;
    case 'approve':
      approve();
      break;
    case 'reject':
      reject();
      break;
    case 'recheck':
      await recheck();
      break;
    case 'mark':
      mark();
      break;
    case 'precision':
      precision();
      break;
    case 'resume-type': {
      const type = positional(1) ?? '';
      console.log(resumeType(type) ? `${type}: back on the allowlist.` : `${type || '(no type)'} is not suspended.`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
