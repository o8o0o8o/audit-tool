/**
 * Imports stored runs as audits (task 3.8): builds the model, stores it with the reports and the raw
 * archive in the file store, records artifacts, and loads it through the normal loader.
 *   yarn --cwd web import-run <run dir> [<run dir> …]
 *   yarn --cwd web import-run --all [--base=lead-results] [--limit=n] [--with-evidence]
 * Re-running skips runs already imported (by legacy_run_id = <domain>/<timestamp>).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { artifacts, auditAttempts, auditDocuments, audits, findings } from '../db/schema';
import { getPlatform } from '../lib/platform';
import { repoRootFrom } from '../lib/platform/local/dispatcher';
import { loadAudit } from '../lib/core/loader';
import { findOrCreateSite, normalizeTarget } from '../lib/core/sites';
import { comparableKey, normalizeRunOptions, profileHash } from '@model/run-options';
import { buildAuditModel, writeRawArchive } from '../../lib/model/build/build-audit-model';
import { classify } from '../../lib/platform-worker/files';
import { walkFiles } from '../../lib/platform-worker/snapshot';

const args = process.argv.slice(2);
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const root = repoRootFrom();

function storedRuns(bases: string[]): string[] {
  const out: string[] = [];
  for (const base of bases) {
    const b = path.resolve(root, base);
    if (!existsSync(b)) continue;
    for (const d of readdirSync(b)) {
      const dd = path.join(b, d);
      if (!statSync(dd).isDirectory()) continue;
      for (const t of readdirSync(dd)) if (existsSync(path.join(dd, t, 'manifest.json.gz'))) out.push(path.join(dd, t));
    }
  }
  return out;
}

export async function importRun(
  runDir: string,
  opts: { withEvidence?: boolean } = {},
): Promise<{ auditId: string; skipped: boolean; ms: number }> {
  const t0 = Date.now();
  const db = getDb();
  const { files } = getPlatform();
  const legacy = `${path.basename(path.dirname(runDir))}/${path.basename(runDir)}`;
  const [dup] = await db
    .select({ id: audits.id, status: audits.status })
    .from(audits)
    .where(eq(audits.legacyRunId, legacy));
  if (dup?.status === 'succeeded') return { auditId: dup.id, skipped: true, ms: 0 };
  if (dup) await db.delete(audits).where(eq(audits.id, dup.id));

  const auditId = randomUUID();
  const doc = buildAuditModel({ runDir, auditId, profile: 'standard' });
  const mode = doc.audit.mode;
  const target = normalizeTarget(doc.audit.targetUrl, mode === 'page');
  const site = await findOrCreateSite(db, target.host);
  const options = normalizeRunOptions(mode, {
    preset: ['quick', 'standard', 'deep', 'sales', 'marketing', 'seo', 'custom'].includes(String(doc.audit.preset))
      ? doc.audit.preset
      : null,
    perf: doc.audit.perf,
    visual: doc.audit.visual,
    passive: doc.audit.passive,
  });
  const finished = doc.audit.finishedAt ? new Date(doc.audit.finishedAt) : statSync(runDir).mtime;
  await db.insert(audits).values({
    id: auditId,
    legacyRunId: legacy,
    siteId: site.id,
    mode,
    targetUrl: target.url,
    preset: options.preset,
    options,
    profile: 'standard',
    profileHash: profileHash(mode, 'standard', options),
    comparableKey: comparableKey(mode, 'standard', options),
    status: 'built',
    currentAttempt: 1,
    source: runDir.includes(`${path.sep}lead-results${path.sep}`) ? 'pipeline' : 'internal',
    modelVersion: doc.modelVersion,
    createdAt: doc.audit.startedAt ? new Date(doc.audit.startedAt) : finished,
    startedAt: doc.audit.startedAt ? new Date(doc.audit.startedAt) : null,
    finishedAt: finished,
  });
  await db.insert(auditAttempts).values({ auditId, attempt: 1, dispatchNonce: 'import', status: 'built' });

  const prefix = `audits/${auditId}/1/`;
  await files.put(`${prefix}model/site.json.gz`, gzipSync(JSON.stringify(doc)), { contentType: 'application/gzip' });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'import-'));
  const rows: (typeof artifacts.$inferInsert)[] = [];
  const add = async (rel: string, body: Uint8Array, kind: string | null, pageUrl: string | null = null) => {
    const res = await files.put(prefix + rel, body);
    if (kind)
      rows.push({
        auditId,
        kind,
        blobKey: prefix + rel,
        bytes: res.bytes,
        sha256: res.sha256,
        pageUrl,
        createdAt: finished,
        expiresAt: null,
      });
  };
  try {
    const archive = path.join(tmp, 'raw-archive.tar.gz');
    writeRawArchive(runDir, archive);
    await add('model/raw-archive.tar.gz', readFileSync(archive), 'raw_archive');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of walkFiles(runDir)) {
    const rel = path.relative(runDir, f).split(path.sep).join('/');
    if (rel.startsWith('model/')) continue;
    const c = classify(rel, {});
    if (!c || !c.kind) continue;
    if (
      !opts.withEvidence &&
      (c.kind === 'evidence' || (c.kind === 'screenshot' && rel !== doc.siteProfile.homepageScreenshot))
    )
      continue;
    await add(rel, readFileSync(f), c.kind, c.pageUrl ?? null);
  }
  for (let i = 0; i < rows.length; i += 1000) await db.insert(artifacts).values(rows.slice(i, i + 1000));
  const res = await loadAudit(db, files, auditId, {});
  if (res.outcome !== 'succeeded') {
    // The cron loader may have taken it first.
    const [row] = await db.select({ status: audits.status }).from(audits).where(eq(audits.id, auditId));
    if (row?.status !== 'succeeded') throw new Error(`load ended ${res.outcome} (${row?.status})`);
  }
  return { auditId, skipped: false, ms: Date.now() - t0 };
}

async function main(): Promise<void> {
  const runs = args.includes('--all')
    ? storedRuns(opt('base') ? [opt('base')!] : ['audit-results', 'lead-results']).slice(
        0,
        Number(opt('limit')) || undefined,
      )
    : args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
  let ok = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const r of runs) {
    try {
      const res = await importRun(r, { withEvidence: args.includes('--with-evidence') });
      if (res.skipped) skipped++;
      else {
        ok++;
        if (runs.length <= 20 || ok % 50 === 0)
          console.log(`imported ${path.relative(root, r)} → ${res.auditId} (${res.ms} ms)`);
      }
    } catch (err) {
      failed.push(`${path.relative(root, r)}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const db = getDb();
  const sizes = await db.execute(
    sql`select pg_size_pretty(pg_total_relation_size('audit_documents')) as docs, pg_size_pretty(pg_total_relation_size('findings')) as findings`,
  );
  const [counts] = await db.select({ audits: sql<number>`count(*)::int` }).from(audits);
  const [docs] = await db.select({ n: sql<number>`count(*)::int` }).from(auditDocuments);
  const [f] = await db.select({ n: sql<number>`count(*)::int` }).from(findings);
  console.log(
    `${ok} imported, ${skipped} already there, ${failed.length} failed; audits ${counts?.audits}, documents ${docs?.n}, findings ${f?.n}; sizes ${JSON.stringify(sizes.rows[0])}`,
  );
  failed.slice(0, 30).forEach((x) => console.log(`  ✗ ${x}`));
  await closeDb();
  if (failed.length) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
