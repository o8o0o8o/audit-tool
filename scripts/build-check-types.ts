/**
 * Seeds lib/model/check-types.json: the first explicit finding codes (design §8.2): the 50 most
 * frequent findings across the stored runs in audit-results/ and lead-results/, plus every security
 * and email-DNS finding seen. Re-run to refresh; a code that changes needs a check_type_aliases row.
 *
 *   npx tsx scripts/build-check-types.ts
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { normalizeMessageForLookup } from '../lib/utils/finding-id';
import { categorize } from '../lib/phase2/categorize';
import { deriveCode } from '../lib/model/finding-codes';

const counts = new Map<string, { n: number; title: string; severity: string }>();
for (const base of ['audit-results', 'lead-results']) {
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base)) {
    const dd = path.join(base, d);
    if (!statSync(dd).isDirectory()) continue;
    for (const t of readdirSync(dd)) {
      const f = path.join(dd, t, 'analysis.json.gz');
      if (!existsSync(f)) continue;
      try {
        const a = JSON.parse(gunzipSync(readFileSync(f)).toString()) as {
          details?: Record<string, { severity?: string }>;
        };
        for (const [title, det] of Object.entries(a.details ?? {})) {
          const key = normalizeMessageForLookup(title);
          const cur = counts.get(key) ?? { n: 0, title: key, severity: det.severity ?? 'low' };
          cur.n++;
          counts.set(key, cur);
        }
      } catch {
        /* unreadable run */
      }
    }
  }
}
const SECURITY =
  /exposed|takeover|secret|vulnerab|outdated javascript|SPF|DMARC|DKIM|MTA-STS|CORS|bucket|staging|phpinfo|directory listing|\.git|\.env|htpasswd|security\.txt|CAA/i;
const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
const chosen = new Map<string, (typeof ranked)[number]>();
for (const r of ranked.slice(0, 50)) chosen.set(r.title, r);
for (const r of ranked) if (SECURITY.test(r.title)) chosen.set(r.title, r);
const rows = [...chosen.values()].map((r) => ({
  code: deriveCode(r.title).code,
  title: r.title,
  family: SECURITY.test(r.title) ? 'security' : categorize(r.title),
  category: categorize(r.title),
  default_severity: r.severity,
}));
const unique = [...new Map(rows.map((r) => [r.code, r])).values()].sort((a, b) => a.code.localeCompare(b.code));
writeFileSync('lib/model/check-types.json', JSON.stringify(unique, null, 2) + '\n');
console.log(`${unique.length} explicit codes written to lib/model/check-types.json`);
