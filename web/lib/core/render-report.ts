/**
 * Renders an audit's HTML report on view, from the database, with the current report and scoring
 * code. Input: the audit row (preset, sections), `audit_run_data` (manifest, metadata, analysis,
 * incoming links), the `pages` rows, the History (earlier audits of the same site and settings) and
 * the screenshots in the file store. The result is cached per audit, per version of the report code
 * and per length of the history, so a change to the generator shows on the next view.
 *
 * The renderer is the audit tool's own `scripts/render-report.ts`, run as a child process on a
 * folder rebuilt from the rows: web/ imports nothing from the root besides lib/model/. Production
 * will run it in a worker job.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditDocuments, auditRunData, audits, pages, scores } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { repoRootFrom } from '../platform/local/dispatcher';
import { ensureScored } from './rescore';

/** The audit tool's files the report depends on; their contents version the cache. */
const RENDERER_SOURCES = [
  'generateHTML.ts',
  'lib/reports',
  'lib/scoring',
  'lib/constants.ts',
  'lib/presets.ts',
  'lib/phase2/categorize.ts',
  'scripts/render-report.ts',
];

let versionCache: { at: number; value: string } | null = null;

function walk(p: string, out: string[]): void {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(path.join(p, e), out);
  else if (/\.(ts|json)$/.test(p)) out.push(p);
}

/** Hash of the renderer's source files (checked at most every 2 s). */
export function rendererVersion(root = repoRootFrom()): string {
  if (versionCache && Date.now() - versionCache.at < 2000) return versionCache.value;
  const files: string[] = [];
  for (const s of RENDERER_SOURCES) walk(path.join(root, s), files);
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(readFileSync(f));
  versionCache = { at: Date.now(), value: h.digest('hex').slice(0, 16) };
  return versionCache.value;
}

type AuditRow = typeof audits.$inferSelect;

export interface HistoryEntry {
  date: string;
  overallScore: number | null;
  categoryScores: Record<string, number | null>;
  totalIssues: number;
  critical: number;
  high: number;
}

async function auditHistoryIds(db: Db, audit: AuditRow): Promise<string[]> {
  if (!audit.finishedAt) return [];
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(
      and(
        eq(audits.siteId, audit.siteId),
        eq(audits.comparableKey, audit.comparableKey),
        eq(audits.status, 'succeeded'),
        lt(audits.finishedAt, audit.finishedAt),
      ),
    )
    .limit(30);
  return rows.map((r) => r.id);
}

/**
 * The report's History: earlier succeeded audits of the same site with the same comparable key
 * (mode, preset, page limit, checks), finished before this one, oldest first.
 */
export async function auditHistory(db: Db, audit: AuditRow): Promise<HistoryEntry[]> {
  if (!audit.finishedAt) return [];
  const earlier = await db
    .select({ id: audits.id, finishedAt: audits.finishedAt, document: auditDocuments.document })
    .from(audits)
    .innerJoin(auditDocuments, eq(auditDocuments.auditId, audits.id))
    .where(
      and(
        eq(audits.siteId, audit.siteId),
        eq(audits.comparableKey, audit.comparableKey),
        eq(audits.status, 'succeeded'),
        lt(audits.finishedAt, audit.finishedAt),
      ),
    )
    .orderBy(asc(audits.finishedAt))
    .limit(30);
  if (!earlier.length) return [];
  const rows = await db
    .select()
    .from(scores)
    .where(
      inArray(
        scores.auditId,
        earlier.map((e) => e.id),
      ),
    );
  return earlier.map((e) => {
    const own = rows.filter((r) => r.auditId === e.id);
    const counts = (e.document as { counts?: { total?: number; bySeverity?: Record<string, number> } }).counts ?? {};
    return {
      date: e.finishedAt!.toISOString(),
      overallScore: own.find((r) => r.category === 'overall')?.score ?? null,
      categoryScores: Object.fromEntries(own.filter((r) => r.category !== 'overall').map((r) => [r.category, r.score])),
      totalIssues: counts.total ?? 0,
      critical: counts.bySeverity?.critical ?? 0,
      high: counts.bySeverity?.high ?? 0,
    };
  });
}

const inflight = new Map<string, Promise<string | null>>();

/** The report HTML for an audit, rendered from the database with the current code (cached), or null. */
export async function renderReportHtml(db: Db, files: FileStore, auditId: string): Promise<string | null> {
  const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
  if (!audit || audit.status !== 'succeeded') return null;
  const [hasData] = await db
    .select({ name: auditRunData.name })
    .from(auditRunData)
    .where(and(eq(auditRunData.auditId, auditId), eq(auditRunData.name, 'manifest')));
  if (!hasData) return null;
  const root = repoRootFrom();
  // This audit and the ones in its History are scored with the current scoring code first.
  const earlier = await auditHistoryIds(db, audit);
  await ensureScored(db, files, [audit.id, ...earlier]);
  const history = await auditHistory(db, audit);
  const key = `renders/${auditId}/${rendererVersion(root)}-h${history.length}.html`;
  const cached = await files.get(key);
  if (cached) return new Response(cached.body).text();
  const running = inflight.get(key);
  if (running) return running;
  const job = render(db, files, audit, key, root, history).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Rebuilds the run folder the renderer reads, from the rows (and the screenshots from the file store). */
export async function materialize(
  db: Db,
  files: FileStore,
  audit: AuditRow,
  runDir: string,
  opts: { evidence?: boolean } = {},
): Promise<void> {
  const data = Object.fromEntries(
    (await db.select().from(auditRunData).where(eq(auditRunData.auditId, audit.id))).map((r) => [r.name, r.data]),
  ) as Record<string, Record<string, unknown>>;
  const gz = (name: string, value: unknown) => writeFileSync(path.join(runDir, name), gzipSync(JSON.stringify(value)));
  const rows = await db
    .select({ url: pages.url, sections: pages.sections })
    .from(pages)
    .where(eq(pages.auditId, audit.id))
    .orderBy(asc(pages.chunk), asc(pages.id));
  const byUrl = new Map(rows.map((r) => [r.url, r.sections as Record<string, unknown>]));
  // Same batch files as the run wrote, so the manifest's page index stays true.
  const manifest = data.manifest ?? {};
  const batches = (
    (manifest.files as { pageBatches?: Array<{ file: string; urls?: string[] }> } | undefined)?.pageBatches ?? []
  ).filter((b) => b.file && !b.file.includes('..'));
  mkdirSync(path.join(runDir, 'pages'), { recursive: true });
  const written = new Set<string>();
  for (const b of batches) {
    const own = Object.fromEntries((b.urls ?? []).filter((u) => byUrl.has(u)).map((u) => [u, byUrl.get(u)]));
    Object.keys(own).forEach((u) => written.add(u));
    mkdirSync(path.dirname(path.join(runDir, b.file)), { recursive: true });
    gz(b.file, { urls: Object.keys(own), pages: own });
  }
  const rest = rows.filter((r) => !written.has(r.url));
  if (rest.length) {
    const file = 'pages/batch_rest.json.gz';
    gz(file, { urls: rest.map((r) => r.url), pages: Object.fromEntries(rest.map((r) => [r.url, r.sections])) });
    (manifest.files as { pageBatches: unknown[] }).pageBatches.push({
      file,
      count: rest.length,
      urls: rest.map((r) => r.url),
    });
  }
  gz('manifest.json.gz', manifest);
  gz('metadata.json.gz', data.metadata ?? {});
  gz('analysis.json.gz', data.analysis ?? {});
  gz('incoming-links.json.gz', data['incoming-links'] ?? {});
  // Screenshots the report shows (UI issues): binary files stay in the file store.
  if (opts.evidence === false) return;
  const prefix = `audits/${audit.id}/${audit.currentAttempt}/`;
  for await (const f of files.list(`${prefix}evidence/`)) {
    const body = await files.get(f.key);
    if (!body) continue;
    const dest = path.join(runDir, f.key.slice(prefix.length));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await new Response(body.body).arrayBuffer()));
  }
}

async function render(
  db: Db,
  files: FileStore,
  audit: AuditRow,
  cacheKey: string,
  root: string,
  history: HistoryEntry[],
): Promise<string | null> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'render-'));
  try {
    const runDir = path.join(tmp, 'run');
    mkdirSync(runDir);
    await materialize(db, files, audit, runDir);
    const options = (audit.options ?? {}) as { preset?: string | null; sections?: string[] };
    const out = path.join(tmp, 'report.html');
    const historyFile = path.join(tmp, 'history.json');
    writeFileSync(historyFile, JSON.stringify(history));
    const args = [
      '--import',
      pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      path.join(root, 'scripts', 'render-report.ts'),
      `--run=${runDir}`,
      `--out=${out}`,
      `--history=${historyFile}`,
      ...(options.preset ? [`--preset=${options.preset}`] : []),
      ...(options.sections?.length ? [`--sections=${options.sections.join(',')}`] : []),
    ];
    // cwd: the scratch folder, so the renderer reads no history file of its own.
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, args, { cwd: tmp, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }, (err, _so, se) =>
        err ? reject(new Error(`${err.message}\n${se}`)) : resolve(),
      ),
    );
    const html = readFileSync(out, 'utf8');
    await files.put(cacheKey, new TextEncoder().encode(html), { contentType: 'text/html' });
    return html;
  } catch (err) {
    console.error(`[render] ${audit.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
