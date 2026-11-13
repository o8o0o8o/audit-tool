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
 * Usage: npx tsx scripts/audit-companies.ts [--once] [--full] [--active] [--timeout-min=n] [--csv=path]
 */
import {
  DEFAULT_COMPANIES_CSV,
  KEY_COLUMN,
  isDoNotContact,
  readCompanies,
  updateCompanies,
} from '../lib/leads/csv-store';
import { runAuditProcess } from '../lib/leads/run-audit';

const args = process.argv.slice(2);
const once = args.includes('--once');
const csvPath = args.find((a) => a.startsWith('--csv='))?.slice(6) ?? DEFAULT_COMPANIES_CSV;
const MARK = 'has_audit';
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
  updateCompanies(csvPath, [{ website, values: { [MARK]: value } }]);
}

async function main() {
  for (;;) {
    // Rows marked do_not_contact are skipped, like in every lead-pipeline command.
    const next = readCompanies(csvPath).find((r) => r[KEY_COLUMN]?.trim() && !r[MARK]?.trim() && !isDoNotContact(r));
    if (!next) {
      console.log('All companies audited.');
      break;
    }

    const website = next[KEY_COLUMN].trim();
    const origin = /^https?:\/\//.test(website) ? website : `https://${website}`;
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
    const why = res.timedOut ? `timed out after ${timeoutMin} min` : `exit ${res.exitCode}`;
    console.log(`=== ${website}: ${res.ok ? 'done' : `failed (${why})`} ===`);
    if (once) break;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
