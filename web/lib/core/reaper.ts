import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditAttempts, audits } from '../../db/schema';
import type { Dispatcher } from '../platform/types';

export const REAPER = {
  registerTimeoutMs: 15 * 60_000,
  heartbeatTimeoutMs: 10 * 60_000,
  /** A dispatched run that never registers is given up on after this, whatever the backend says. */
  registerHardTimeoutMs: 60 * 60_000,
  /** One attempt may not run longer than this, heartbeat or not (the worker's own limit is 350 min). */
  maxRunMs: 390 * 60_000,
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

  // Every write names the status it expects, so a run that reported `built` or was cancelled
  // between the select and the write is left alone.
  const requeue = async (auditId: string, attempt: number, attemptStatus: string, from: string) => {
    const current = and(eq(audits.id, auditId), eq(audits.currentAttempt, attempt), eq(audits.status, from));
    if (attempt >= lim.maxAttempts) {
      const done = await db
        .update(audits)
        .set({ status: 'failed', error: `gave up after ${attempt} attempts (${attemptStatus})`, finishedAt: now })
        .where(current)
        .returning({ id: audits.id });
      if (!done.length) return;
      out.failed.push(auditId);
      await opts.onFinished?.(auditId);
    } else {
      const done = await db
        .update(audits)
        .set({ status: 'queued', phase: null })
        .where(current)
        .returning({ id: audits.id });
      if (!done.length) return;
      out.redispatched.push(auditId);
    }
    await db
      .update(auditAttempts)
      .set({ status: attemptStatus })
      .where(and(eq(auditAttempts.auditId, auditId), eq(auditAttempts.attempt, attempt)));
  };

  // Never registered.
  const notRegistered = await db
    .select({ id: audits.id, attempt: audits.currentAttempt, progressAt: audits.progressAt })
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
    const hard = r.progressAt && r.progressAt.getTime() < now.getTime() - lim.registerHardTimeoutMs;
    if (hard) await dispatcher.cancel(r.id, r.attempt).catch(() => {});
    if (hard || (await dispatcher.state(r.id, r.attempt)) === 'gone')
      await requeue(r.id, r.attempt, 'lost', 'dispatched');
  }

  // Running too long: the child can hang while the worker keeps sending heartbeats.
  const overtime = await db
    .select({ id: audits.id, attempt: audits.currentAttempt })
    .from(audits)
    .innerJoin(
      auditAttempts,
      and(eq(auditAttempts.auditId, audits.id), eq(auditAttempts.attempt, audits.currentAttempt)),
    )
    .where(and(eq(audits.status, 'running'), lt(auditAttempts.registeredAt, new Date(now.getTime() - lim.maxRunMs))));
  for (const r of overtime) {
    const done = await db
      .update(audits)
      .set({ status: 'failed', error: `stopped after ${Math.round(lim.maxRunMs / 60_000)} minutes`, finishedAt: now })
      .where(and(eq(audits.id, r.id), eq(audits.currentAttempt, r.attempt), eq(audits.status, 'running')))
      .returning({ id: audits.id });
    if (!done.length) continue;
    await db
      .update(auditAttempts)
      .set({ status: 'failed' })
      .where(and(eq(auditAttempts.auditId, r.id), eq(auditAttempts.attempt, r.attempt)));
    await dispatcher.cancel(r.id, r.attempt).catch(() => {});
    out.failed.push(r.id);
    await opts.onFinished?.(r.id);
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
    const done = await db
      .update(audits)
      .set({ status: 'stalled' })
      .where(and(eq(audits.id, r.id), eq(audits.currentAttempt, r.attempt), eq(audits.status, 'running')))
      .returning({ id: audits.id });
    if (!done.length) continue;
    await dispatcher.cancel(r.id, r.attempt).catch(() => {});
    out.stalled.push(r.id);
  }

  // Stalled on an earlier pass: redispatch with resume, or give up.
  const stalled = await db
    .select({ id: audits.id, attempt: audits.currentAttempt })
    .from(audits)
    .where(and(eq(audits.status, 'stalled'), out.stalled.length ? notInArray(audits.id, out.stalled) : undefined));
  for (const r of stalled) await requeue(r.id, r.attempt, 'stalled', 'stalled');
  return out;
}
