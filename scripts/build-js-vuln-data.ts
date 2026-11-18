/**
 * Build the JavaScript-library vulnerability table used by the audit and the lead gate
 * (lib/analyzers/security/js-vulnerability-db.ts).
 *
 * Usage:
 *   npx tsx scripts/build-js-vuln-data.ts
 *
 * Source: the Retire.js repository (https://github.com/RetireJS/retire.js, Apache-2.0),
 * `repository/jsrepository-v4.json`: for each library, the version ranges with a published
 * advisory and the patterns that read a version from a script's address, file name or content.
 * Output: lib/data/js-vulnerabilities.json
 *
 * Advisories are never typed in by hand: a "known vulnerability" claim goes into reports and
 * teasers, so each one must be traceable to its CVE or GitHub advisory. Re-run to refresh.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE = 'https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v4.json';
const OUT = join(__dirname, '..', 'lib', 'data', 'js-vulnerabilities.json');

interface SourceLibrary {
  vulnerabilities?: Array<{
    below?: string;
    atOrAbove?: string;
    severity?: string;
    identifiers?: { summary?: string; CVE?: string[]; githubID?: string; bug?: string; issue?: string };
    info?: string[];
  }>;
  extractors?: { uri?: string[]; filename?: string[]; filecontent?: string[] };
}

async function main() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${SOURCE}`);
  const source = (await res.json()) as Record<string, SourceLibrary>;

  const libraries: Record<string, unknown> = {};
  let advisories = 0;
  for (const [name, lib] of Object.entries(source)) {
    if (name === 'retire-example' || name === 'dont check') continue;
    const vulnerabilities = (lib.vulnerabilities ?? [])
      .filter((v) => v.below)
      .map((v) => ({
        below: v.below,
        ...(v.atOrAbove ? { atOrAbove: v.atOrAbove } : {}),
        severity: v.severity ?? 'medium',
        cve: v.identifiers?.CVE ?? [],
        ...(v.identifiers?.githubID ? { ghsa: v.identifiers.githubID } : {}),
        summary: (v.identifiers?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        ...(v.info?.[0] ? { info: v.info[0] } : {}),
      }));
    const extractors = {
      uri: lib.extractors?.uri ?? [],
      filename: lib.extractors?.filename ?? [],
      filecontent: lib.extractors?.filecontent ?? [],
    };
    if (vulnerabilities.length === 0) continue;
    if (!extractors.uri.length && !extractors.filename.length && !extractors.filecontent.length) continue;
    advisories += vulnerabilities.length;
    libraries[name] = { vulnerabilities, extractors };
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), source: SOURCE, libraries }, null, 1) + '\n',
  );
  console.log(`Wrote ${OUT}: ${Object.keys(libraries).length} libraries, ${advisories} advisories`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
