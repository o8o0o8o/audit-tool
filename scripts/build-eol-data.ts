/**
 * Build the end-of-life table used by the lead pipeline (lib/leads/eol.ts).
 *
 * Usage:
 *   npx tsx scripts/build-eol-data.ts
 *
 * Source: https://endoflife.date (public API, one request per product).
 * Output: lib/data/eol-versions.json
 *   { generatedAt, source, products: { slug: { label, cycles: [{ cycle, releaseDate, eol }] } }, notCovered: [slug] }
 *
 * `eol` is the ISO date a release cycle stopped receiving fixes, `false` when it is still
 * maintained, or `true` when the source only says that it has ended.
 *
 * The dates are never typed in by hand: an "end of life" claim goes to a prospect, so it must be
 * traceable to a source. Re-run this script to refresh the file.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PRODUCTS } from '../lib/leads/versions';

const API = 'https://endoflife.date/api';
const OUT = join(__dirname, '..', 'lib', 'data', 'eol-versions.json');

interface SourceCycle {
  cycle: string | number;
  releaseDate?: string;
  eol?: string | boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return (await res.json()) as T;
}

async function main() {
  const available = new Set(await getJson<string[]>(`${API}/all.json`));
  const products: Record<
    string,
    { label: string; cycles: Array<{ cycle: string; releaseDate: string | null; eol: string | boolean }> }
  > = {};
  const notCovered: string[] = [];

  for (const [slug, info] of Object.entries(PRODUCTS)) {
    if (!available.has(slug)) {
      notCovered.push(slug);
      continue;
    }
    const cycles = await getJson<SourceCycle[]>(`${API}/${slug}.json`);
    products[slug] = {
      label: info.label,
      cycles: cycles
        .filter((c) => c.cycle !== undefined && c.eol !== undefined)
        .map((c) => ({ cycle: String(c.cycle), releaseDate: c.releaseDate ?? null, eol: c.eol as string | boolean })),
    };
    console.log(`  ${slug}: ${products[slug].cycles.length} cycles`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const data = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'https://endoflife.date',
    products,
    notCovered,
  };
  writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
  console.log(`\nWrote ${OUT}`);
  console.log(
    `Covered: ${Object.keys(products).length} products. Not covered by the source: ${notCovered.join(', ') || 'none'}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
