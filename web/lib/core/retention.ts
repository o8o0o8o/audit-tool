import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { artifacts } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { pruneRateEvents } from './rate';

/** Retention cron (§9): deletes expired files and marks their rows; prunes rate events after 24 h. */
export async function runRetention(
  db: Db,
  files: FileStore,
  now = new Date(),
): Promise<{ files: number; rateEvents: number }> {
  const expired = await db
    .select({ id: artifacts.id, key: artifacts.blobKey })
    .from(artifacts)
    .where(and(isNull(artifacts.deletedAt), lt(artifacts.expiresAt, now)))
    .limit(500);
  for (const a of expired) {
    await files.delete([a.key]);
    await db.update(artifacts).set({ deletedAt: now }).where(eq(artifacts.id, a.id));
  }
  return { files: expired.length, rateEvents: await pruneRateEvents(db, now) };
}
