/**
 * Audits companies from docs/gtm/companies.csv one at a time.
 * Picks the next row without `has_audit`, runs a capped prospect audit
 * (`start.ts --origin=https://<website> --limit=60 --concurrency=8 --perf --visual`; `--full` drops the cap),
 * and on success writes `has_audit=yes` back to the CSV. Failed runs are marked `failed`
 * so the loop moves on (clear the cell to retry).
 *
 * Usage: npx tsx scripts/audit-companies.ts [--once] [--full] [--csv=path]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const once = args.includes('--once');
const csvPath = args.find((a) => a.startsWith('--csv='))?.slice(6) ?? 'docs/gtm/companies.csv';
const MARK = 'has_audit';
// A lead audit needs the pattern, not every page: 60 pages surface template-wide
// issues; the full crawl took 1h17m+ per site.
const auditFlags = args.includes('--full') ? ['--perf', '--visual'] : ['--limit=60', '--concurrency=8', '--perf', '--visual'];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function load() {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  if (!header.includes(MARK)) header.push(MARK);
  return { rows, header, col: header.indexOf(MARK), site: header.indexOf('website') };
}

function save(rows: string[][]) {
  const eol = readFileSync(csvPath, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(csvPath, rows.map((r) => r.map(esc).join(',')).join(eol) + eol);
}

function mark(website: string, value: string) {
  // Re-read so manual edits made during a long audit are kept.
  const { rows, col, site } = load();
  for (const r of rows.slice(1)) if (r[site] === website) { while (r.length <= col) r.push(''); r[col] = value; }
  save(rows);
}

for (;;) {
  const { rows, col, site } = load();
  const next = rows.slice(1).find((r) => r[site]?.trim() && !r[col]?.trim());
  if (!next) { console.log('All companies audited.'); break; }

  const website = next[site].trim();
  const origin = /^https?:\/\//.test(website) ? website : `https://${website}`;
  console.log(`\n=== Auditing ${next[0]} (${origin}) ===`);
  const res = spawnSync('npx', ['tsx', 'start.ts', `--origin=${origin}`, ...auditFlags], { stdio: 'inherit' });
  if (res.signal === 'SIGINT') process.exit(130);

  const ok = res.status === 0;
  mark(next[site], ok ? 'yes' : 'failed');
  console.log(`=== ${website}: ${ok ? 'done' : `failed (exit ${res.status})`} ===`);
  if (once) break;
}
