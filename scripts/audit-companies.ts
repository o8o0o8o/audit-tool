/**
 * Audits companies from docs/gtm/companies.csv one at a time.
 * Picks the next row without `has_audit`, runs a capped prospect audit
 * (`start.ts --origin=https://<website> --limit=60 --concurrency=8 --perf --visual --passive`; `--full` drops the cap),
 * and on success writes `has_audit=yes` back to the CSV. Failed runs are marked `failed`
 * so the loop moves on (clear the cell to retry).
 *
 * These sites did not ask to be audited, so the run is passive by default (`--passive`: no requests
 * for unlinked files, no forged headers, no crawler impersonation). `--active` runs every probe;
 * use it only for a site whose owner agreed.
 *
 * Each audit has a hard time limit (default 180 minutes, `--timeout-min=<n>`); the whole process
 * tree is stopped when it is reached and the row is marked `failed`.
 *
 * For the small lead scan of a prospect see `scripts/lead-pipeline.ts scan`.
 *
 * With the platform API configured (AUDIT_API_URL + AUDIT_API_KEY) the prospect rows are read and
 * written through it (the CSV is not written), the scan guard is asked before each audit, and each
 * finished run is published as a `full` audit (POST /api/v1/audits/import).
 * A `has_audit` mark the platform did not take is retried, then saved to
 * lead-results/pending-prospect-updates.json and sent first on the next start, so a site is not
 * audited twice. With `--csv` / `--store=csv` and the platform configured, its scan guard is still asked.
 *
 * Usage: npx tsx scripts/audit-companies.ts [--once] [--full] [--active] [--timeout-min=n] [--csv=path] [--store=csv|api]
 */
import { DEFAULT_COMPANIES_CSV, KEY_COLUMN, isDoNotContact } from '../lib/leads/csv-store';
import { openProspectStore, type ApiProspectStore } from '../lib/leads/prospect-store';
import { publishRun } from '../lib/leads/publish';
import { readLatestRun, runAuditProcess } from '../lib/leads/run-audit';

const args = process.argv.slice(2);
const once = args.includes('--once');
const csvPath = args.find((a) => a.startsWith('--csv='))?.slice(6) ?? DEFAULT_COMPANIES_CSV;
const MARK = 'has_audit';
const store = openProspectStore({
  csvPath,
  store:
    args.find((a) => a.startsWith('--store='))?.slice(8) ?? (args.some((a) => a.startsWith('--csv=')) ? 'csv' : null),
});
// A lead audit needs the pattern, not every page: 60 pages surface template-wide
// issues; the full crawl took 1h17m+ per site.
const auditFlags = [
  ...(args.includes('--full') ? ['--perf', '--visual'] : ['--limit=60', '--concurrency=8', '--perf', '--visual']),
  ...(args.includes('--active') ? [] : ['--passive']),
];
const timeoutArg = Number(args.find((a) => a.startsWith('--timeout-min='))?.slice('--timeout-min='.length));
const timeoutMin = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : 180;

/**
 * Writes only the `has_audit` cell of this website's row(s), under the shared CSV lock, so a
 * lead-pipeline run that updates other columns in the meantime is not overwritten (and manual
 * edits made during a long audit are kept).
 */
function mark(website: string, value: string) {
  store.update([{ website, values: { [MARK]: value } }]);
}

async function main() {
  try {
    await store.load();
  } catch (error) {
    console.error(`The prospect list could not be loaded. ${(error as Error).message}`);
    process.exit(1);
  }
  const skipped = new Set<string>();
  for (;;) {
    // Rows marked do_not_contact are skipped, like in every lead-pipeline command.
    const next = store
      .records()
      .find((r) => r[KEY_COLUMN]?.trim() && !r[MARK]?.trim() && !isDoNotContact(r) && !skipped.has(r[KEY_COLUMN]));
    if (!next) {
      console.log('All companies audited.');
      break;
    }

    const website = next[KEY_COLUMN].trim();
    const origin = /^https?:\/\//.test(website) ? website : `https://${website}`;
    const g = await store.guard(new URL(origin).hostname);
    if (!g.allowed) {
      console.log(`${website}: refused by the scan guard (${g.reason ?? 'blocked'}); skipped`);
      skipped.add(next[KEY_COLUMN]);
      continue;
    }
    const startedAt = new Date();
    console.log(`\n=== Auditing ${next.company ?? website} (${origin}) ===`);
    let interrupted = false;
    const onSigint = () => {
      interrupted = true;
    };
    process.once('SIGINT', onSigint);
    const res = await runAuditProcess([`--origin=${origin}`, ...auditFlags], { timeoutMs: timeoutMin * 60_000 });
    process.off('SIGINT', onSigint);
    if (interrupted) process.exit(130); // an interrupted audit is not marked, so it is picked up again

    mark(next[KEY_COLUMN], res.ok ? 'yes' : 'failed');
    const run = res.ok ? readLatestRun(origin, 'audit-results', startedAt) : null;
    if (run && store.kind === 'api') {
      const pub = await publishRun(store as ApiProspectStore, run.runDir).catch(
        (e: Error) => (console.log(`publish failed: ${e.message}`), null),
      );
      if (pub) console.log(`published: audit ${pub.auditId}`);
    }
    await store.flush();
    const why = res.timedOut ? `timed out after ${timeoutMin} min` : `exit ${res.exitCode}`;
    console.log(`=== ${website}: ${res.ok ? 'done' : `failed (${why})`} ===`);
    if (once) break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
