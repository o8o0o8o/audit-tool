/**
 * Renders an audit's HTML report with the current report and scoring code, on view (design §2
 * "HTML report from Postgres", first stage). Input: the audit row (preset, sections), the raw run
 * archive stored with it, and its evidence files. The result is cached per audit and per version
 * of the report code, so a change to the generator shows on the next view of every audit.
 *
 * The renderer is the audit tool's own `scripts/render-report.ts`, run as a child process: web/
 * imports nothing from the root besides lib/model/. Production will run it in a worker job.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { audits } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { repoRootFrom } from '../platform/local/dispatcher';
import { findArtifactByKind } from './reports';

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

const inflight = new Map<string, Promise<string | null>>();

/** The report HTML for an audit, rendered with the current code (cached), or null when it cannot be. */
export async function renderReportHtml(db: Db, files: FileStore, auditId: string): Promise<string | null> {
  const [audit] = await db.select().from(audits).where(eq(audits.id, auditId));
  if (!audit || audit.status !== 'succeeded') return null;
  const archive = await findArtifactByKind(db, auditId, 'raw_archive');
  if (!archive) return null;
  const root = repoRootFrom();
  const key = `renders/${auditId}/${rendererVersion(root)}.html`;
  const cached = await files.get(key);
  if (cached) return new Response(cached.body).text();
  const running = inflight.get(key);
  if (running) return running;
  const job = render(files, audit, archive.blobKey, key, root).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function render(
  files: FileStore,
  audit: typeof audits.$inferSelect,
  archiveKey: string,
  cacheKey: string,
  root: string,
): Promise<string | null> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'render-'));
  try {
    const got = await files.get(archiveKey);
    if (!got) return null;
    const runDir = path.join(tmp, 'run');
    mkdirSync(runDir);
    writeFileSync(path.join(tmp, 'raw.tar.gz'), Buffer.from(await new Response(got.body).arrayBuffer()));
    execFileSync('tar', ['-xzf', path.join(tmp, 'raw.tar.gz'), '-C', runDir]);
    // Screenshots and other evidence the report shows (UI issues) come from the stored files.
    const prefix = `audits/${audit.id}/${audit.currentAttempt}/evidence/`;
    for await (const f of files.list(prefix)) {
      const body = await files.get(f.key);
      if (!body) continue;
      const dest = path.join(runDir, f.key.slice(`audits/${audit.id}/${audit.currentAttempt}/`.length));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await new Response(body.body).arrayBuffer()));
    }
    const options = (audit.options ?? {}) as { preset?: string | null; sections?: string[] };
    const out = path.join(tmp, 'report.html');
    const args = [
      '--import',
      pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      path.join(root, 'scripts', 'render-report.ts'),
      `--run=${runDir}`,
      `--out=${out}`,
      ...(options.preset ? [`--preset=${options.preset}`] : []),
      ...(options.sections?.length ? [`--sections=${options.sections.join(',')}`] : []),
    ];
    // cwd: the scratch folder, so the renderer finds no audit history of its own (history comes from the database later).
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
