import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { artifacts, auditRunData, audits, pages } from '../../db/schema';
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

/** Days after which a finished audit's page data is deleted (design §9). */
export const PAGE_DATA_DAYS = 90;

/** `PAGE_DATA_RETENTION_DAYS`: a whole number of days; `0` keeps page data for ever. */
export function pageDataDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PAGE_DATA_RETENTION_DAYS;
  const v = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : PAGE_DATA_DAYS;
}

/** The model's row chunks in the file store: page chunks and the run data. `site.json.gz` is kept. */
const PAGE_DATA_FILE = /^audits\/[^/]+\/\d+\/model\/(pages-\d+\.ndjson|run-data\.json)\.gz$/;

/**
 * Deletes the page data of audits that ended more than `days` ago (design §9): the `pages` rows and
 * the run data in Postgres, and in the file store the model's page chunks, its run data and the raw
 * archive. What stays: the audit row, findings, scores, recommendations, site checks, the site
 * document, the stored reports, and screenshots until their own expiry.
 *
 * Such an audit can no longer be re-scored, re-rendered, reloaded or continued; its report is the
 * HTML stored by the run. This cannot be undone. Files go first and the mark last, so a run that
 * stops halfway is finished by the next one.
 */
export async function dropOldPageData(
  db: Db,
  files: FileStore,
  opts: { now?: Date; days?: number; max?: number; budgetMs?: number } = {},
): Promise<number> {
  const days = opts.days ?? pageDataDays();
  if (days <= 0) return 0;
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 120_000);
  const old = await db
    .select({ id: audits.id })
    .from(audits)
    .where(
      and(
        inArray(audits.status, [...FINAL]),
        isNull(audits.pagesDroppedAt),
        lt(audits.finishedAt, new Date(now.getTime() - days * 86400_000)),
      ),
    )
    .orderBy(asc(audits.finishedAt))
    .limit(opts.max ?? 200);
  let dropped = 0;
  for (const { id } of old) {
    if (Date.now() > deadline) break;
    const keys: string[] = [];
    for await (const f of files.list(`audits/${id}/`)) if (PAGE_DATA_FILE.test(f.key)) keys.push(f.key);
    const archives = await db
      .select({ id: artifacts.id, key: artifacts.blobKey })
      .from(artifacts)
      .where(and(eq(artifacts.auditId, id), eq(artifacts.kind, 'raw_archive'), isNull(artifacts.deletedAt)));
    await files.delete([...keys, ...archives.map((a) => a.key)]);
    await db.transaction(async (tx) => {
      if (archives.length)
        await tx
          .update(artifacts)
          .set({ deletedAt: now })
          .where(
            inArray(
              artifacts.id,
              archives.map((a) => a.id),
            ),
          );
      await tx.delete(pages).where(eq(pages.auditId, id));
      await tx.delete(auditRunData).where(eq(auditRunData.auditId, id));
      await tx.update(audits).set({ pagesDroppedAt: now }).where(eq(audits.id, id));
    });
    dropped++;
  }
  return dropped;
}

/**
 * Retention cron (§9): deletes expired files and marks their rows; prunes rate events after 24 h;
 * deletes the checkpoint snapshots of finished audits; deletes the page data of old audits.
 */
export async function runRetention(
  db: Db,
  files: FileStore,
  now = new Date(),
): Promise<{ files: number; rateEvents: number; checkpoints: number; pageData: number }> {
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
    pageData: await dropOldPageData(db, files, { now }),
  };
}
