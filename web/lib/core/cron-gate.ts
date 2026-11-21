/**
 * Lets the crons leave Postgres alone while the platform is idle, so Neon can scale its compute to zero.
 *
 * Two small files in the FileStore (Blob in production) carry the state; reading one is a Blob read,
 * not a database query:
 * - `signals/work-raised`: a timestamp, written by every request that creates work for a cron (a new
 *   or continued audit, a pipeline import, a PDF job, a cancel), after its database write committed.
 * - `signals/idle-since`: written by a cron that found no work in the database; the time its check began.
 *
 * Work is pending when the raise is later than the start of the last idle check (with a margin for clock
 * skew between functions), or when either file is missing. A raise that happened before the check began
 * is visible to that check, so no work is lost. While anything is open (audits not finished, jobs not
 * finished, webhook deliveries not given up) the check finds it and the marker stays raised; a running
 * audit therefore keeps the reaper and the loader working until it ends.
 *
 * Daily work (retention) and re-scoring after a deploy do not need the marker: retention runs from its
 * own daily cron, and stored scores are re-computed on read when the scoring code changed.
 */
import { and, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { audits, jobs, webhookDeliveries } from '../../db/schema';
import type { FileStore } from '../platform/types';

export const WORK_RAISED_KEY = 'signals/work-raised';
export const IDLE_SINCE_KEY = 'signals/idle-since';
/** Clock difference allowed between the function that raises and the cron that clears. */
export const CLOCK_MARGIN_MS = 30_000;

const OPEN_AUDIT = ['queued', 'dispatched', 'running', 'built', 'loading'];
const OPEN_JOB = ['queued', 'dispatched', 'running'];

async function readTime(files: FileStore, key: string): Promise<number | null> {
  try {
    const f = await files.get(key);
    if (!f) return null;
    const text = await new Response(f.body).text();
    const t = Number(text.trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

async function writeTime(files: FileStore, key: string, t: number): Promise<void> {
  await files.put(key, new TextEncoder().encode(String(t)), { contentType: 'text/plain' });
}

/**
 * Marks that a cron has work. Call after the database write that created the work has committed.
 * A failed write is logged and ignored: the request has already succeeded, and the next raise or
 * the fallback check (see `cronGate`) picks the work up.
 */
export async function raiseWork(files: FileStore, now = Date.now()): Promise<void> {
  try {
    await writeTime(files, WORK_RAISED_KEY, now);
  } catch (err) {
    console.error('[cron-gate] could not raise the work marker', err);
  }
}

/** Is anything open that a cron must move on? One small query; the indexes on status cover it. */
export async function hasOpenWork(db: Db): Promise<boolean> {
  const [audit] = await db
    .select({ x: sql`1` })
    .from(audits)
    .where(inArray(audits.status, OPEN_AUDIT))
    .limit(1);
  if (audit) return true;
  const [job] = await db
    .select({ x: sql`1` })
    .from(jobs)
    .where(inArray(jobs.status, OPEN_JOB))
    .limit(1);
  if (job) return true;
  const [delivery] = await db
    .select({ x: sql`1` })
    .from(webhookDeliveries)
    .where(and(isNull(webhookDeliveries.deliveredAt), isNotNull(webhookDeliveries.nextAttemptAt)))
    .limit(1);
  return !!delivery;
}

export interface CronGate {
  /** True when the crons should query the database on this tick. */
  shouldRun(): Promise<boolean>;
  /** After a tick that ran: if the database has no open work, record the platform as idle. */
  settle(): Promise<void>;
}

/**
 * `fallbackMs`: even while idle, look at the database once in this long, in case a raise was lost
 * (a failed Blob write). The default, 6 hours, wakes Neon four times a day for a moment.
 */
export function cronGate(db: Db, files: FileStore, opts: { fallbackMs?: number; now?: () => number } = {}): CronGate {
  const fallbackMs = opts.fallbackMs ?? 6 * 60 * 60_000;
  const now = opts.now ?? Date.now;
  let checkStartedAt = 0;
  return {
    async shouldRun() {
      const [raised, idleSince] = await Promise.all([
        readTime(files, WORK_RAISED_KEY),
        readTime(files, IDLE_SINCE_KEY),
      ]);
      checkStartedAt = now();
      if (idleSince == null) return true;
      if (raised != null && raised >= idleSince - CLOCK_MARGIN_MS) return true;
      return checkStartedAt - idleSince >= fallbackMs;
    },
    async settle() {
      const started = checkStartedAt || now();
      if (await hasOpenWork(db)) return;
      // Recheck the raise: one written after this tick began must not be hidden by the idle mark.
      const raised = await readTime(files, WORK_RAISED_KEY);
      if (raised != null && raised >= started - CLOCK_MARGIN_MS) return;
      await writeTime(files, IDLE_SINCE_KEY, started);
    },
  };
}

/**
 * Wraps one cron step: it runs only when the gate says so, and returns null (nothing to log) when it
 * is skipped. `settle`: after the step, record the platform as idle if the database has no open work.
 * Give that to one step; the others only read the marker.
 */
export function gated<T>(
  db: Db,
  files: FileStore,
  fn: () => Promise<T>,
  opts: { settle?: boolean; fallbackMs?: number } = {},
): () => Promise<T | null> {
  const gate = cronGate(db, files, { fallbackMs: opts.fallbackMs });
  return async () => {
    if (!(await gate.shouldRun())) return null;
    const r = await fn();
    if (opts.settle) await gate.settle();
    return r;
  };
}
