/**
 * Shared reader/writer for the prospect list (`docs/gtm/companies.csv`).
 *
 * Two scripts write to this file: `scripts/audit-companies.ts` (the batch full audit, column
 * `has_audit`) and `scripts/lead-pipeline.ts` (stack, score and stage columns). A long run in one
 * must not undo a write made by the other, so every write here:
 *
 *   1. takes a lock file next to the CSV,
 *   2. re-reads the CSV from disk,
 *   3. changes only the named columns of the named rows,
 *   4. writes a temp file and renames it over the CSV (atomic on one filesystem).
 *
 * Rows are addressed by the `website` column. Unknown columns are appended to the header.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_COMPANIES_CSV = 'docs/gtm/companies.csv';
export const KEY_COLUMN = 'website';
/** Permanent stage: no pipeline command acts on such a row. */
export const DO_NOT_CONTACT = 'do_not_contact';

export type CompanyRecord = Record<string, string>;

export interface CompaniesTable {
  header: string[];
  /** Data rows, each padded to the header length. */
  rows: string[][];
  eol: '\n' | '\r\n';
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const escapeField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function serializeCsv(rows: string[][], eol: string = '\n'): string {
  return rows.map((r) => r.map(escapeField).join(',')).join(eol) + eol;
}

export function parseTable(text: string): CompaniesTable {
  const all = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const header = all[0] ?? [];
  const rows = all.slice(1).map((r) => {
    const padded = r.slice();
    while (padded.length < header.length) padded.push('');
    return padded;
  });
  return { header, rows, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function readTable(csvPath: string = DEFAULT_COMPANIES_CSV): CompaniesTable {
  return parseTable(fs.readFileSync(csvPath, 'utf8'));
}

export function toRecords(table: CompaniesTable): CompanyRecord[] {
  return table.rows.map((row) => {
    const record: CompanyRecord = {};
    table.header.forEach((name, i) => (record[name] = row[i] ?? ''));
    return record;
  });
}

export function readCompanies(csvPath: string = DEFAULT_COMPANIES_CSV): CompanyRecord[] {
  return toRecords(readTable(csvPath));
}

/** `https://www.Example.com/path` → `example.com`. The value used for result folders. */
export function domainOf(website: string): string {
  return website
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** `example.com` → `https://example.com`; a value that already has a scheme is kept. */
export function originOf(website: string): string {
  const trimmed = website.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, '') : `https://${trimmed.replace(/\/+$/, '')}`;
}

export const isDoNotContact = (record: CompanyRecord): boolean => record.stage?.trim() === DO_NOT_CONTACT;

/** Rows a pipeline command may act on: they have a website and are not marked do-not-contact. */
export function actionable(records: CompanyRecord[]): CompanyRecord[] {
  return records.filter((r) => r[KEY_COLUMN]?.trim() && !isDoNotContact(r));
}

export interface RowUpdate {
  website: string;
  values: Record<string, string>;
}

export function applyUpdates(
  table: CompaniesTable,
  updates: RowUpdate[],
): { table: CompaniesTable; missing: string[] } {
  const header = table.header.slice();
  const rows = table.rows.map((r) => r.slice());
  const keyIndex = header.indexOf(KEY_COLUMN);
  if (keyIndex < 0) throw new Error(`CSV has no "${KEY_COLUMN}" column`);
  const stageIndex = header.indexOf('stage');
  const missing: string[] = [];

  for (const update of updates) {
    const targets = rows.filter((r) => r[keyIndex] === update.website);
    if (!targets.length) {
      missing.push(update.website);
      continue;
    }
    for (const [column, value] of Object.entries(update.values)) {
      let index = header.indexOf(column);
      if (index < 0) {
        header.push(column);
        index = header.length - 1;
        for (const r of rows) r.push('');
      }
      for (const row of targets) {
        // do_not_contact is permanent: nothing but an explicit hand edit of the CSV may change it.
        if (column === 'stage' && stageIndex >= 0 && row[stageIndex]?.trim() === DO_NOT_CONTACT) continue;
        row[index] = value;
      }
    }
  }
  return { table: { header, rows, eol: table.eol }, missing };
}

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(lock: string): boolean {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    return age > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 && !processAlive(pid));
  } catch {
    return false; // the holder released it between our two calls: just retry
  }
}

/** Runs `fn` while holding `<file>.lock`. A lock left by a dead process, or older than a minute, is taken over. */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockIsStale(lock)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not lock ${file}: another process holds ${lock}`, { cause: error });
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function writeTableAtomic(csvPath: string, table: CompaniesTable): void {
  const tmp = path.join(path.dirname(csvPath), `.${path.basename(csvPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, serializeCsv([table.header, ...table.rows], table.eol));
  fs.renameSync(tmp, csvPath);
}

/**
 * Sets the given columns on the given rows and leaves everything else as it is on disk at the
 * moment of the write. Returns the websites that were not found.
 */
export function updateCompanies(csvPath: string, updates: RowUpdate[]): string[] {
  if (!updates.length) return [];
  return withFileLock(csvPath, () => {
    const { table, missing } = applyUpdates(readTable(csvPath), updates);
    writeTableAtomic(csvPath, table);
    return missing;
  });
}
