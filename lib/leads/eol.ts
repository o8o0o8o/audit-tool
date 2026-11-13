/**
 * End-of-life lookup against the generated table `lib/data/eol-versions.json`
 * (built by `scripts/build-eol-data.ts` from endoflife.date; never edited by hand).
 */

import eolData from '../data/eol-versions.json';
import { PRODUCTS } from './versions';
import type { EolHit, VersionEvidence } from './types';

export interface EolCycle {
  cycle: string;
  releaseDate: string | null;
  /** ISO date, `false` (still maintained) or `true` (ended, date unknown). */
  eol: string | boolean;
}

export interface EolTable {
  generatedAt: string;
  source: string;
  products: Record<string, { label: string; cycles: EolCycle[] }>;
  notCovered: string[];
}

export const EOL_TABLE = eolData as unknown as EolTable;

export interface EolStatus {
  cycle: string;
  eolDate: string | null;
  isEol: boolean;
}

const isUnder = (version: string, cycle: string) => version === cycle || version.startsWith(`${cycle}.`);

function cycleEnded(cycle: EolCycle, today: string): boolean {
  if (cycle.eol === true) return true;
  if (cycle.eol === false) return false;
  return cycle.eol < today; // ISO dates compare as strings
}

/**
 * Status of `version` of `product`, or null when the table cannot answer (unknown product, or a
 * version it has no cycle for). Never guesses: "unknown" is null, not "maintained".
 *
 * A version more specific than the table's cycles (`7.4.33` vs cycle `7.4`) takes the longest
 * matching cycle. A version less specific than the cycles (Drupal `8` vs cycles `8.9`, `8.8`…) is
 * end-of-life only if every cycle under it has ended; the date is then the last of them.
 */
export function eolStatus(
  product: string,
  version: string,
  today: string = new Date().toISOString().slice(0, 10),
  table: EolTable = EOL_TABLE,
): EolStatus | null {
  const cycles = table.products[product]?.cycles;
  if (!cycles?.length || !/^\d+(?:\.\d+)*$/.test(version)) return null;

  const containing = cycles.filter((c) => isUnder(version, c.cycle)).sort((a, b) => b.cycle.length - a.cycle.length)[0];
  if (containing) {
    return {
      cycle: containing.cycle,
      eolDate: typeof containing.eol === 'string' ? containing.eol : null,
      isEol: cycleEnded(containing, today),
    };
  }

  const under = cycles.filter((c) => isUnder(c.cycle, version));
  if (!under.length) return null;
  if (!under.every((c) => cycleEnded(c, today))) return { cycle: version, eolDate: null, isEol: false };
  const dates = under.map((c) => (typeof c.eol === 'string' ? c.eol : null));
  const eolDate = dates.every((d): d is string => d !== null) ? dates.sort().at(-1)! : null;
  return { cycle: version, eolDate, isEol: true };
}

/**
 * End-of-life hits for the versions seen on a site. Only CMSs, frameworks and PHP can raise one:
 * a bundled library (jQuery inside a CMS) is patched by the CMS and belongs to the advisory check.
 */
export function eolHits(
  versions: VersionEvidence[],
  today: string = new Date().toISOString().slice(0, 10),
  table: EolTable = EOL_TABLE,
): EolHit[] {
  const hits: EolHit[] = [];
  for (const v of versions) {
    const role = PRODUCTS[v.product]?.role;
    const eligible = role === 'cms' || role === 'framework' || v.product === 'php';
    if (!eligible || v.conflict) continue;
    const status = eolStatus(v.product, v.version, today, table);
    if (!status?.isEol) continue;
    const hit: EolHit = {
      product: v.product,
      label: v.label,
      version: v.version,
      cycle: status.cycle,
      eolDate: status.eolDate,
      kinds: v.kinds,
    };
    if (v.product === 'php') hit.upstreamOnly = true;
    hits.push(hit);
  }
  return hits;
}

/** `Drupal 7 (ended 2025-01-05)`: the form used in the CSV `eol` column. */
export function formatEolHit(hit: EolHit): string {
  return `${hit.label} ${hit.version}${hit.eolDate ? ` (ended ${hit.eolDate})` : ' (ended)'}`;
}
