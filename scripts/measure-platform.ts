/**
 * Times the platform's database work on one stored run: build the model, load it, re-score,
 * render the report, and the main read tools. Uses a throwaway schema in DATABASE_URL_TEST and a
 * temp file store; nothing is written to the dev database or to the run folder.
 *
 *   npx tsx scripts/measure-platform.ts <run dir> [--scale=10]
 *
 * --scale=N repeats the run's pages N times under made-up URLs, to see how a larger audit behaves.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTestDb, sql } from '../web/db/test-db';
import { audits } from '../web/db/schema';
import { buildAuditModel, buildRowParts, readRun } from '../lib/model/build/build-audit-model';
import { PAGE_CHUNK_SIZE } from '../lib/model/page';
import { getAudit, listAudits } from '../web/lib/core/audits';
import { loadAudit } from '../web/lib/core/loader';
import { getLeadSummary } from '../web/lib/core/lead-summary';
import { internalPrincipal } from '../web/lib/core/principal';
import { ensureScored } from '../web/lib/core/rescore';
import { materialize } from '../web/lib/core/render-report';
import { getSite, listFindings } from '../web/lib/core/results';
import { findOrCreateSite } from '../web/lib/core/sites';
import { LocalFileStore } from '../web/lib/platform/local/file-store';

const args = process.argv.slice(2);
const runDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? '');
const scale = Math.max(1, Number(args.find((a) => a.startsWith('--scale='))?.split('=')[1]) || 1);

const rows: Array<[string, string]> = [];
/** Heap still in use after a collection (run with NODE_OPTIONS=--expose-gc), else resident memory. */
function memory(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  return gc ? process.memoryUsage().heapUsed : process.memoryUsage().rss;
}

/** Every statement sent to Postgres (one network round trip each), counted per step. */
let queries = 0;
{
  const pg = createRequire(path.resolve(__dirname, '../web/package.json'))('pg') as {
    Client: { prototype: { query: (...a: unknown[]) => unknown } };
  };
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args: unknown[]) {
    queries++;
    return original.apply(this, args);
  };
}

async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const before = memory();
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  const t0 = performance.now();
  const q0 = queries;
  const out = await fn();
  const sent = queries - q0;
  const ms = performance.now() - t0;
  clearInterval(watch);
  const kept = Math.max(0, memory() - before) / 1e6;
  const time = ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
  rows.push([name, `${time.padEnd(9)} ${String(sent).padStart(4)} queries, kept +${kept.toFixed(0)} MB, process peak ${(peak / 1e6).toFixed(0)} MB`]);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set');
  const t = await createTestDb(url);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const store = new LocalFileStore(path.join(dir, 'files'), { appUrl: 'http://127.0.0.1:9', secret: 'x'.repeat(40) });
  const p = internalPrincipal();
  try {
    const id = randomUUID();
    const source = await timed('read the run folder', () => readRun(runDir));
    const domain = String((source.manifest as { domain?: string }).domain ?? 'measure.example');
    const doc = await timed('build the site document', () => buildAuditModel({ runDir, auditId: id }, source));
    const parts = await timed('build page rows and run data', () => buildRowParts(runDir, source));
    const pages = [...parts.pages];
    for (let k = 1; k < scale; k++)
      for (const r of parts.pages) pages.push({ ...r, url: `${r.url}${r.url.includes('?') ? '&' : '?'}copy=${k}` });

    const prefix = `audits/${id}/1/model/`;
    await store.put(`${prefix}site.json.gz`, gzipSync(JSON.stringify(doc)));
    await store.put(`${prefix}run-data.json.gz`, gzipSync(JSON.stringify(parts.runData)));
    for (let i = 0; i * PAGE_CHUNK_SIZE < pages.length; i++)
      await store.put(
        `${prefix}pages-${String(i + 1).padStart(4, '0')}.ndjson.gz`,
        gzipSync(
          pages
            .slice(i * PAGE_CHUNK_SIZE, (i + 1) * PAGE_CHUNK_SIZE)
            .map((r) => JSON.stringify(r))
            .join('\n'),
        ),
      );
    const site = await findOrCreateSite(t.db, domain);
    await t.db.insert(audits).values({
      id,
      siteId: site.id,
      mode: doc.audit.mode,
      targetUrl: `https://${domain}`,
      profile: 'standard',
      profileHash: id,
      comparableKey: 'k',
      status: 'built',
      source: 'internal',
      currentAttempt: 1,
      finishedAt: new Date(),
    });

    const loaded = await timed('load into Postgres', () => loadAudit(t.db, store, id));
    if (loaded.outcome === 'failed') throw new Error(`load failed: ${loaded.error}`);
    await timed('re-score (first read after a load)', () => ensureScored(t.db, store, [id]));
    const [audit] = await t.db
      .select()
      .from(audits)
      .where(sql`id = ${id}`);
    const out = path.join(dir, 'run');
    await timed('rebuild the run folder for a render (no screenshots)', async () => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(out, { recursive: true });
      await materialize(t.db, null, audit!, out);
    });
    await timed('get_audit', () => getAudit(t.db, p, id));
    await timed('list_audits', () => listAudits(t.db, p, { limit: 100 }));
    await timed('get_site', () => getSite(t.db, p, { domain }));
    await timed('get_site (second call)', () => getSite(t.db, p, { domain }));
    await timed('list_findings (first 100)', () => listFindings(t.db, p, { domain, limit: 100 }));
    await timed('get_lead_summary', () => getLeadSummary(t.db, p, { domain }).catch((e: Error) => e.message));

    const sizes = await t.db.execute(sql`
      select c.relname as name, pg_total_relation_size(c.oid) as bytes, c.reltuples::bigint as est
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind = 'r'
      order by 2 desc limit 6`);
    const count = await t.db.execute(
      sql`select count(*)::int as n, avg(pg_column_size(sections))::int as avg from pages`,
    );
    const c = count.rows[0] as { n: number; avg: number };
    console.log(
      `\n${runDir}\n${c.n} page rows (scale ${scale}), ${doc.findings.length} findings, ${(c.avg / 1024).toFixed(1)} kB per page row on average\n`,
    );
    for (const [name, v] of rows) console.log(`  ${name.padEnd(52)} ${v}`);
    console.log('\n  Largest tables:');
    for (const r of sizes.rows as Array<{ name: string; bytes: string }>)
      console.log(`    ${r.name.padEnd(24)} ${(Number(r.bytes) / 1e6).toFixed(1)} MB`);
  } finally {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
