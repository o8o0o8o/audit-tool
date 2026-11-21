import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { artifacts, audits } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { pruneRateEvents } from './rate';

const FINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Checkpoint snapshots (`checkpoints/<audit>/<attempt>/…`) are only for resuming a run (§3): once the
 * audit is in a final state, or its row is gone, they are deleted. Safe to run again at any time.
 */
export async function deleteFinishedCheckpoints(db: Db, files: FileStore, maxKeys = 20_000): Promise<number> {
  const byAudit = new Map<string, string[]>();
  let n = 0;
  for await (const f of files.list('checkpoints/')) {
    const id = f.key.split('/')[1] ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) continue;
    byAudit.set(id, [...(byAudit.get(id) ?? []), f.key]);
    if (++n >= maxKeys) break;
  }
  const ids = [...byAudit.keys()];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const rows = await db
      .select({ id: audits.id, status: audits.status })
      .from(audits)
      .where(inArray(audits.id, batch));
    const status = new Map(rows.map((r) => [r.id, r.status]));
    for (const id of batch) {
      const st = status.get(id.toLowerCase());
      if (st !== undefined && !FINAL.has(st)) continue;
      const keys = byAudit.get(id)!;
      await files.delete(keys);
      deleted += keys.length;
    }
  }
  return deleted;
}

/**
 * Retention cron (§9): deletes expired files and marks their rows; prunes rate events after 24 h;
 * deletes the checkpoint snapshots of finished audits.
 */
export async function runRetention(
  db: Db,
  files: FileStore,
  now = new Date(),
): Promise<{ files: number; rateEvents: number; checkpoints: number }> {
  const expired = await db
    .select({ id: artifacts.id, key: artifacts.blobKey })
    .from(artifacts)
    .where(and(isNull(artifacts.deletedAt), lt(artifacts.expiresAt, now)))
    .limit(500);
  for (const a of expired) {
    await files.delete([a.key]);
    await db.update(artifacts).set({ deletedAt: now }).where(eq(artifacts.id, a.id));
  }
  return {
    files: expired.length,
    rateEvents: await pruneRateEvents(db, now),
    checkpoints: await deleteFinishedCheckpoints(db, files),
  };
}
