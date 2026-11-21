/**
 * Rebuilds the model of audits loaded before a model change, from their stored raw archive, and
 * loads it again (today: adds the page rows and run data the report renders from).
 *   yarn --cwd web tsx scripts/reload-audits.ts [<audit id> …]   (no id: every succeeded audit without page rows)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, inArray, notExists } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { audits, auditRunData, loadProgress } from '../db/schema';
import { getPlatform } from '../lib/platform';
import { loadAudit } from '../lib/core/loader';
import { findArtifactByKind } from '../lib/core/reports';
import { writeAuditModel } from '../../lib/model/build/build-audit-model';
import { normalizeRunOptions } from '@model/run-options';

async function main(): Promise<void> {
  const db = getDb();
  const { files } = getPlatform();
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const rows = ids.length
    ? await db
        .select()
        .from(audits)
        .where(inArray(audits.id, ids))
    : await db
        .select()
        .from(audits)
        .where(
          and(
            eq(audits.status, 'succeeded'),
            notExists(db.select().from(auditRunData).where(eq(auditRunData.auditId, audits.id))),
          ),
        );
  for (const a of rows) {
    const archive = await findArtifactByKind(db, a.id, 'raw_archive');
    const got = archive ? await files.get(archive.blobKey) : null;
    if (!got) {
      console.log(`${a.id}: no raw archive, skipped`);
      continue;
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'reload-'));
    try {
      writeFileSync(path.join(tmp, 'raw.tar.gz'), Buffer.from(await new Response(got.body).arrayBuffer()));
      const runDir = path.join(tmp, 'run', 'site', '2000-01-01_00-00-00');
      execFileSync('mkdir', ['-p', runDir]);
      execFileSync('tar', ['-xzf', path.join(tmp, 'raw.tar.gz'), '-C', runDir]);
      const options = normalizeRunOptions(a.mode as 'full' | 'quick' | 'page', a.options);
      writeAuditModel({
        runDir,
        auditId: a.id,
        mode: a.mode as 'full' | 'quick' | 'page',
        profile: a.profile as 'public' | 'standard',
        preset: options.preset,
      });
      const prefix = `audits/${a.id}/${a.currentAttempt}/model/`;
      for (const f of readdirSync(path.join(runDir, 'model'))) {
        if (f === 'raw-archive.tar.gz') continue;
        await files.put(prefix + f, readFileSync(path.join(runDir, 'model', f)));
      }
      await db.delete(loadProgress).where(eq(loadProgress.auditId, a.id));
      await db.update(audits).set({ status: 'built' }).where(eq(audits.id, a.id));
      const res = await loadAudit(db, files, a.id);
      console.log(`${a.id}: ${res.outcome} (${res.chunks} chunk(s))`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
