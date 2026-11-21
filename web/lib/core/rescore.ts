/**
 * Keeps stored scores current (not in the design: scores were "computed once by the run"). When the
 * scoring code changes, an audit is re-scored from its database rows before it is shown, and the
 * `scores` rows and the site document are updated, so the database, the API and every report agree,
 * and a History compares audits scored the same way. A blocked scan keeps no scores.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditDocuments, auditRunData, audits, scanQuality, scores } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { repoRootFrom } from '../platform/local/dispatcher';
import { materialize } from './render-report';

const SCORING_SOURCES = ['lib/scoring', 'lib/constants.ts', 'lib/utils.ts', 'scripts/score-run.ts'];
let cache: { at: number; value: string } | null = null;

function walk(p: string, out: string[]): void {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(path.join(p, e), out);
  else if (/\.(ts|json)$/.test(p)) out.push(p);
}

/** Hash of the scoring code (checked at most every 2 s). */
export function scoringVersion(root = repoRootFrom()): string {
  if (cache && Date.now() - cache.at < 2000) return cache.value;
  const files: string[] = [];
  for (const s of SCORING_SOURCES) walk(path.join(root, s), files);
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(readFileSync(f));
  cache = { at: Date.now(), value: h.digest('hex').slice(0, 16) };
  return cache.value;
}

interface Scored {
  overallScore: number;
  categoryScores: Record<string, number>;
  performanceSource?: string;
}

/** Re-scores the given audits whose stored scores come from older scoring code. */
export async function ensureScored(db: Db, files: FileStore, auditIds: string[]): Promise<void> {
  if (!auditIds.length) return;
  const root = repoRootFrom();
  const version = scoringVersion(root);
  const stale = await db
    .select()
    .from(audits)
    .where(
      and(
        inArray(audits.id, auditIds),
        eq(audits.status, 'succeeded'),
        or(isNull(audits.scoringVersion), ne(audits.scoringVersion, version)),
      ),
    );
  for (const audit of stale) {
    const [hasData] = await db
      .select({ n: auditRunData.name })
      .from(auditRunData)
      .where(and(eq(auditRunData.auditId, audit.id), eq(auditRunData.name, 'manifest')));
    if (!hasData) continue;
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
      await db.transaction(async (tx) => {
        await tx.delete(scores).where(eq(scores.auditId, audit.id));
        await tx.insert(scores).values(rows.map((r) => ({ auditId: audit.id, ...r })));
        const [doc] = await tx.select().from(auditDocuments).where(eq(auditDocuments.auditId, audit.id));
        if (doc)
          await tx
            .update(auditDocuments)
            .set({ document: { ...(doc.document as object), scores: rows } })
            .where(eq(auditDocuments.auditId, audit.id));
        await tx.update(audits).set({ scoringVersion: version }).where(eq(audits.id, audit.id));
      });
    } catch (err) {
      console.error(`[rescore] ${audit.id}: ${err instanceof Error ? err.message : err}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Cron step: re-scores up to `max` audits whose scores come from older scoring code. */
export async function rescoreStale(db: Db, files: FileStore, max = 20): Promise<number> {
  const version = scoringVersion();
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.status, 'succeeded'), or(isNull(audits.scoringVersion), ne(audits.scoringVersion, version))))
    .limit(max);
  await ensureScored(
    db,
    files,
    rows.map((r) => r.id),
  );
  return rows.length;
}
