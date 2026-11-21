import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { rateEvents } from '../../db/schema';

/**
 * Counts events in `bucket` during the last `windowMs`; when below `max`, records one more and
 * returns true. Under a transaction-level advisory lock on the bucket, so concurrent calls count right.
 */
export async function takeRate(
  db: Db,
  bucket: string,
  max: number,
  windowMs: number,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'rate:' + bucket}))`);
    const since = new Date(now.getTime() - windowMs);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(rateEvents)
      .where(and(eq(rateEvents.bucket, bucket), gt(rateEvents.at, since)));
    if ((row?.n ?? 0) >= max) return false;
    await tx.insert(rateEvents).values({ bucket, at: now });
    return true;
  });
}

/** Counts without recording (used to check a lockout before verifying a password). */
export async function countRate(db: Db, bucket: string, windowMs: number, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rateEvents)
    .where(and(eq(rateEvents.bucket, bucket), gt(rateEvents.at, new Date(now.getTime() - windowMs))));
  return row?.n ?? 0;
}

export async function recordRate(db: Db, bucket: string, now = new Date()): Promise<void> {
  await db.insert(rateEvents).values({ bucket, at: now });
}

/** Retention: rate events older than 24 h are deleted. */
export async function pruneRateEvents(db: Db, now = new Date()): Promise<number> {
  const res = await db.delete(rateEvents).where(lt(rateEvents.at, new Date(now.getTime() - 24 * 3600_000)));
  return res.rowCount ?? 0;
}
