import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditAttempts, audits } from '../../db/schema';
import type { Dispatcher } from '../platform/types';

export const REAPER = {
  registerTimeoutMs: 15 * 60_000,
  heartbeatTimeoutMs: 10 * 60_000,
  /** At most 2 redispatches: attempt 3 is the last. */
  maxAttempts: 3,
};

export interface ReaperResult {
  redispatched: string[];
  stalled: string[];
  failed: string[];
}

/**
 * The reaper rules of §3:
 * - `dispatched`, not registered within 15 min: if the backend says the run is gone, redispatch;
 * - `running` with no heartbeat for 10 min: `stalled`, cancel the run; a stalled audit is
 *   redispatched (resuming from its snapshot) on the next pass;
 * - at most 2 redispatches, then `failed`.
 * `built`/`loading` audits need no rule here: the loader takes every one that is not locked.
 */
export async function reap(
  db: Db,
  dispatcher: Pick<Dispatcher, 'state' | 'cancel'>,
  opts: { now?: Date; onFinished?: (auditId: string) => Promise<void>; limits?: Partial<typeof REAPER> } = {},
): Promise<ReaperResult> {
  const now = opts.now ?? new Date();
  const lim = { ...REAPER, ...opts.limits };
  const out: ReaperResult = { redispatched: [], stalled: [], failed: [] };

  const requeue = async (auditId: string, attempt: number, attemptStatus: string) => {
    await db
      .update(auditAttempts)
      .set({ status: attemptStatus })
      .where(and(eq(auditAttempts.auditId, auditId), eq(auditAttempts.attempt, attempt)));
    if (attempt >= lim.maxAttempts) {
      await db
        .update(audits)
        .set({ status: 'failed', error: `gave up after ${attempt} attempts (${attemptStatus})`, finishedAt: now })
        .where(and(eq(audits.id, auditId), eq(audits.currentAttempt, attempt)));
      out.failed.push(auditId);
      await opts.onFinished?.(auditId);
    } else {
      await db
        .update(audits)
        .set({ status: 'queued', phase: null })
        .where(and(eq(audits.id, auditId), eq(audits.currentAttempt, attempt)));
      out.redispatched.push(auditId);
    }
  };

  // Never registered.
  const notRegistered = await db
    .select({ id: audits.id, attempt: audits.currentAttempt })
    .from(audits)
    .innerJoin(
      auditAttempts,
      and(eq(auditAttempts.auditId, audits.id), eq(auditAttempts.attempt, audits.currentAttempt)),
    )
    .where(
      and(
        eq(audits.status, 'dispatched'),
        sql`${auditAttempts.registeredAt} is null`,
        lt(audits.progressAt, new Date(now.getTime() - lim.registerTimeoutMs)),
      ),
    );
  for (const r of notRegistered) {
    if ((await dispatcher.state(r.id, r.attempt)) === 'gone') await requeue(r.id, r.attempt, 'lost');
  }

  // Heartbeat stopped.
  const silent = await db
    .select({ id: audits.id, attempt: audits.currentAttempt })
    .from(audits)
    .innerJoin(
      auditAttempts,
      and(eq(auditAttempts.auditId, audits.id), eq(auditAttempts.attempt, audits.currentAttempt)),
    )
    .where(
      and(
        eq(audits.status, 'running'),
        lt(auditAttempts.heartbeatAt, new Date(now.getTime() - lim.heartbeatTimeoutMs)),
      ),
    );
  for (const r of silent) {
    await db
      .update(audits)
      .set({ status: 'stalled' })
      .where(and(eq(audits.id, r.id), eq(audits.currentAttempt, r.attempt)));
    await dispatcher.cancel(r.id, r.attempt).catch(() => {});
    out.stalled.push(r.id);
  }

  // Stalled on an earlier pass: redispatch with resume, or give up.
  const stalled = await db
    .select({ id: audits.id, attempt: audits.currentAttempt })
    .from(audits)
    .where(and(eq(audits.status, 'stalled'), out.stalled.length ? notInArray(audits.id, out.stalled) : undefined));
  for (const r of stalled) await requeue(r.id, r.attempt, 'stalled');
  return out;
}
