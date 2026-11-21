import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { auditAttempts, audits, sites } from '../../db/schema';
import { DispatchUnavailable, type Platform } from '../platform/types';
import { checkGuard } from './guard';
import { randomToken } from './tokens';

export type Source = 'public' | 'internal' | 'api' | 'pipeline';

/** How many audits of each source may be dispatched or running at once (§3 "Queue"). */
export const DEFAULT_CAPS: Record<Source, number> = { public: 1, api: 2, internal: 2, pipeline: 1 };

export function capsFromEnv(env: Record<string, string | undefined> = process.env): Record<Source, number> {
  const caps = { ...DEFAULT_CAPS };
  for (const s of Object.keys(caps) as Source[]) {
    const v = Number(env[`QUEUE_CAP_${s.toUpperCase()}`]);
    if (Number.isInteger(v) && v >= 0) caps[s] = v;
  }
  return caps;
}

export interface DispatchedRun {
  auditId: string;
  attempt: number;
}

interface Hooks {
  onFinished?: (auditId: string) => Promise<void>;
}

/**
 * Dispatches queued audits oldest first while their source has capacity. Serialised by one
 * transaction-level advisory lock, so two cron loops (or a cron and a request) never dispatch the
 * same row or overfill a cap. The guard is checked again here: a domain guarded while its audit
 * waited ends `cancelled` (`scan_guard`).
 */
export async function dispatchNext(
  db: Db,
  platform: Pick<Platform, 'dispatcher'>,
  opts: { now?: Date; caps?: Record<Source, number>; max?: number } & Hooks = {},
): Promise<DispatchedRun[]> {
  const caps = opts.caps ?? capsFromEnv();
  const out: DispatchedRun[] = [];
  for (let i = 0; i < (opts.max ?? 20); i++) {
    const now = opts.now ?? new Date();
    const picked = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('platform:dispatch'))`);
      const busy = await tx
        .select({ source: audits.source, n: sql<number>`count(*)::int` })
        .from(audits)
        .where(inArray(audits.status, ['dispatched', 'running']))
        .groupBy(audits.source);
      const full = (Object.keys(caps) as Source[]).filter((s) => (busy.find((b) => b.source === s)?.n ?? 0) >= caps[s]);
      const [row] = await tx
        .select({
          id: audits.id,
          attempt: audits.currentAttempt,
          host: sites.host,
          mode: audits.mode,
          targetUrl: audits.targetUrl,
          profile: audits.profile,
        })
        .from(audits)
        .innerJoin(sites, eq(sites.id, audits.siteId))
        .where(and(eq(audits.status, 'queued'), full.length ? notInArray(audits.source, full) : undefined))
        .orderBy(asc(audits.createdAt))
        .limit(1)
        .for('update', { of: audits, skipLocked: true });
      if (!row) return null;
      const guard = await checkGuard(tx as unknown as Db, row.host ?? '');
      if (!guard.allowed) {
        await tx
          .update(audits)
          .set({ status: 'cancelled', error: 'scan_guard', finishedAt: now })
          .where(eq(audits.id, row.id));
        return { cancelled: row.id } as const;
      }
      const attempt = row.attempt + 1;
      const nonce = randomToken(18);
      await tx.insert(auditAttempts).values({ auditId: row.id, attempt, dispatchNonce: nonce, status: 'dispatched' });
      await tx
        .update(audits)
        .set({ status: 'dispatched', currentAttempt: attempt, phase: null, progressAt: now })
        .where(eq(audits.id, row.id));
      return { row, attempt, nonce } as const;
    });
    if (!picked) break;
    if ('cancelled' in picked) {
      await opts.onFinished?.(picked.cancelled as string);
      continue;
    }
    const { row, attempt, nonce } = picked;
    try {
      await platform.dispatcher.dispatch({
        kind: 'audit',
        id: row.id,
        attempt,
        nonce,
        inputs: { mode: row.mode, url: row.targetUrl, profile: row.profile },
        ...(attempt > 1 ? { resumeFromAttempt: attempt - 1 } : {}),
      });
      out.push({ auditId: row.id, attempt });
    } catch (err) {
      // The backend refused: the row goes back to the queue, this attempt is dead.
      await db
        .update(audits)
        .set({ status: 'queued', currentAttempt: attempt - 1 })
        .where(and(eq(audits.id, row.id), eq(audits.currentAttempt, attempt), eq(audits.status, 'dispatched')));
      await db.delete(auditAttempts).where(and(eq(auditAttempts.auditId, row.id), eq(auditAttempts.attempt, attempt)));
      if (err instanceof DispatchUnavailable) break;
      throw err;
    }
  }
  return out;
}
