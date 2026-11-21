/**
 * Imports docs/gtm/companies.csv into `prospects` (task 2.1), or five made-up rows with --sample.
 *   yarn --cwd web tsx scripts/seed-prospects.ts [--csv=<path>] [--sample]
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { closeDb, getDb } from '../db/client';
import { prospects } from '../db/schema';
import { countProspects, rowFromRecord } from '../lib/core/prospects';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) (row.push(cell), rows.push(row));
  return rows;
}

const SAMPLE: Record<string, string>[] = [
  { company: 'Acme Example', website: 'acme.example', stage: 'new' },
  { company: 'Globex Demo', website: 'globex.test', stage: 'fingerprinted', fit_score: '40' },
  { company: 'Initech Sample', website: 'initech.example', stage: 'selected', fit_score: '65' },
  { company: 'Umbrella Fixture', website: 'umbrella.test', stage: 'scanned' },
  { company: 'Hooli Blocked', website: 'hooli.example', stage: 'do_not_contact' },
];

async function main(): Promise<void> {
  const db = getDb();
  let records: Record<string, string>[];
  if (process.argv.includes('--sample')) records = SAMPLE;
  else {
    const csv =
      process.argv.find((a) => a.startsWith('--csv='))?.slice(6) ??
      path.resolve(__dirname, '../../docs/gtm/companies.csv');
    const [header, ...rows] = parseCsv(readFileSync(csv, 'utf8'));
    records = rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
  }
  const values = records.filter((r) => r.website?.trim()).map(rowFromRecord);
  const unique = [...new Map(values.map((v) => [v.website, v])).values()];
  for (let i = 0; i < unique.length; i += 500) {
    await db
      .insert(prospects)
      .values(unique.slice(i, i + 500))
      // A re-run keeps what the database has, with one exception: a row the CSV now marks
      // do_not_contact becomes do_not_contact (never the other way; a row already marked is not changed).
      .onConflictDoUpdate({
        target: prospects.website,
        set: { doNotContact: true, stage: sql`excluded.stage`, stageAt: sql`now()` },
        setWhere: sql`excluded.do_not_contact and not prospects.do_not_contact`,
      });
  }
  const c = await countProspects(db);
  console.log(
    `${records.length} rows read, ${unique.length} with a website; prospects: ${c.n} (${c.dnc} do_not_contact)`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
