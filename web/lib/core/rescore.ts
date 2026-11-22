/**
 * Keeps stored scores current (not in the design: scores were "computed once by the run"). When the
 * scoring code changes, an audit is re-scored from its database rows before it is shown, and the
 * `scores` rows and the site document are updated, so the database, the API and every report agree,
 * and a History compares audits scored the same way. A blocked scan keeps no scores. A freshly
 * loaded audit has no `scoring_version` (its scores are the run's own), so it is scored here too.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditDocuments, auditRunData, audits, scanQuality, scores } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { repoRootFrom } from '../platform/local/dispatcher';
import { materialize } from './render-report';

const SCORING_SOURCES = ['lib/scoring', 'lib/constants.ts', 'lib/utils.ts', 'scripts/score-run.ts'];
let cache: { at: number; root: string; value: string } | null = null;

function walk(p: string, out: string[]): void {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(path.join(p, e), out);
  else if (/\.(ts|json)$/.test(p)) out.push(p);
}

/** Hash of source files by path relative to the repo and contents, so every checkout of the same code agrees. */
export function hashSources(root: string, sources: string[]): string {
  const files: string[] = [];
  for (const s of sources) walk(path.join(root, s), files);
  const h = createHash('sha256');
  for (const f of files)
    h.update(path.relative(root, f).split(path.sep).join('/')).update('\0').update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

let toolAt: { root: string; ok: boolean } | null = null;

/**
 * Is the audit tool (its scripts and tsx) where the app runs? Re-scoring and report rendering start
 * it as a child process. A Vercel function has only the web app, so there it is not: stored scores
 * and the report HTML stored by the run are served as they are (build guide §8, item 3).
 */
export function auditToolAvailable(root = repoRootFrom()): boolean {
  if (toolAt?.root === root) return toolAt.ok;
  const ok =
    existsSync(path.join(root, 'scripts', 'score-run.ts')) &&
    existsSync(path.join(root, 'scripts', 'render-report.ts')) &&
    existsSync(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs'));
  toolAt = { root, ok };
  return ok;
}

/** Hash of the scoring code (checked at most every 2 s). */
export function scoringVersion(root = repoRootFrom()): string {
  if (cache && cache.root === root && Date.now() - cache.at < 2000) return cache.value;
  cache = { at: Date.now(), root, value: hashSources(root, SCORING_SOURCES) };
  return cache.value;
}

/** Failed re-scores of one audit, per scoring version, before it is marked and left alone. */
export const MAX_SCORE_ATTEMPTS = 3;
/** `scoring_version` of an audit that cannot be re-scored with this code: it has no stored run data. */
export const noDataMark = (version: string) => `${version}!no-data`;
/** `scoring_version` of an audit whose re-score failed MAX_SCORE_ATTEMPTS times with this code. */
export const failedMark = (version: string) => `${version}!failed`;

/** Audits still to be re-scored for this version: not scored with it, and not marked as impossible. */
const needsScoring = (version: string) =>
  or(
    isNull(audits.scoringVersion),
    notInArray(audits.scoringVersion, [version, noDataMark(version), failedMark(version)]),
  );

interface Scored {
  overallScore: number;
  categoryScores: Record<string, number>;
  performanceSource?: string;
}

const inflight = new Map<string, Promise<void>>();

/**
 * Re-scores the given audits whose stored scores come from other scoring code (or from the run
 * itself: the loader leaves `scoring_version` empty). `max` bounds the work of one call. An audit
 * without run data, or one that keeps failing, gets a mark in `scoring_version` so it is not tried
 * again until the scoring code changes; its scores stay as the run computed them.
 */
export async function ensureScored(
  db: Db,
  files: FileStore | null,
  auditIds: string[],
  opts: { max?: number } = {},
): Promise<void> {
  if (!auditIds.length) return;
  const root = repoRootFrom();
  if (!auditToolAvailable(root)) return;
  const version = scoringVersion(root);
  const stale = await db
    .select()
    .from(audits)
    .where(and(inArray(audits.id, auditIds), eq(audits.status, 'succeeded'), needsScoring(version)))
    .orderBy(asc(audits.scoreAttempts))
    .limit(opts.max ?? auditIds.length);
  for (const audit of stale) {
    const key = `${audit.id}:${version}`;
    let job = inflight.get(key);
    if (!job) {
      job = scoreOne(db, files, audit, root, version).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    await job;
  }
}

async function scoreOne(
  db: Db,
  files: FileStore | null,
  audit: typeof audits.$inferSelect,
  root: string,
  version: string,
): Promise<void> {
  const [hasData] = await db
    .select({ n: auditRunData.name })
    .from(auditRunData)
    .where(and(eq(auditRunData.auditId, audit.id), eq(auditRunData.name, 'manifest')));
  if (!hasData) {
    await db
      .update(audits)
      .set({ scoringVersion: noDataMark(version), scoreAttempts: 0 })
      .where(and(eq(audits.id, audit.id), eq(audits.status, 'succeeded')));
    return;
  }
  const [quality] = await db
    .select({ state: scanQuality.state })
    .from(scanQuality)
    .where(eq(scanQuality.auditId, audit.id));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rescore-'));
  try {
    const runDir = path.join(tmp, 'run');
    mkdirSync(runDir);
    await materialize(db, files, audit, runDir, { evidence: false });
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          '--import',
          pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
          path.join(root, 'scripts', 'score-run.ts'),
          `--run=${runDir}`,
        ],
        { cwd: tmp, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        (err, so, se) => (err ? reject(new Error(`${err.message}\n${se}`)) : resolve(so)),
      ),
    );
    const scored = JSON.parse(out.trim().split('\n').pop() ?? '{}') as Scored;
    if (typeof scored.overallScore !== 'number') throw new Error('score-run printed no scores');
    const blocked = quality?.state === 'blocked';
    const rows = [
      { category: 'overall', score: blocked ? null : scored.overallScore, source: null },
      ...Object.entries(scored.categoryScores ?? {}).map(([category, score]) => ({
        category,
        score: blocked ? null : Math.round(score),
        source:
          category === 'performance' && ['lab', 'field', 'findings'].includes(String(scored.performanceSource))
            ? (scored.performanceSource as 'lab' | 'field' | 'findings')
            : null,
      })),
    ];
    // Scores, the site document and the version change together: a reader never sees a mix.
    await db.transaction(async (tx) => {
      await tx.delete(scores).where(eq(scores.auditId, audit.id));
      await tx.insert(scores).values(rows.map((r) => ({ auditId: audit.id, ...r })));
      const [doc] = await tx.select().from(auditDocuments).where(eq(auditDocuments.auditId, audit.id));
      if (doc)
        await tx
          .update(auditDocuments)
          .set({ document: { ...(doc.document as object), scores: rows } })
          .where(eq(auditDocuments.auditId, audit.id));
      await tx.update(audits).set({ scoringVersion: version, scoreAttempts: 0 }).where(eq(audits.id, audit.id));
    });
  } catch (err) {
    console.error(`[rescore] ${audit.id}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}`);
    const [row] = await db
      .update(audits)
      .set({ scoreAttempts: sql`${audits.scoreAttempts} + 1` })
      .where(eq(audits.id, audit.id))
      .returning({ n: audits.scoreAttempts });
    if ((row?.n ?? 0) >= MAX_SCORE_ATTEMPTS)
      await db
        .update(audits)
        .set({ scoringVersion: failedMark(version), scoreAttempts: 0 })
        .where(eq(audits.id, audit.id));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** True when the audit's stored scores were computed with the current scoring code. */
export function scoresCurrent(storedVersion: string | null): boolean {
  return storedVersion === scoringVersion();
}

/**
 * Cron step: re-scores up to `max` audits whose scores come from other scoring code. Audits that
 * failed before go last and the newest go first, so one that cannot be scored never holds the rest.
 */
export async function rescoreStale(db: Db, files: FileStore | null, max = 20): Promise<number> {
  if (!auditToolAvailable()) return 0;
  const version = scoringVersion();
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.status, 'succeeded'), needsScoring(version)))
    .orderBy(asc(audits.scoreAttempts), sql`${audits.finishedAt} desc nulls last`, asc(audits.id))
    .limit(max);
  await ensureScored(
    db,
    files,
    rows.map((r) => r.id),
  );
  return rows.length;
}
