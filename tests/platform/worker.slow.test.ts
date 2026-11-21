/**
 * Slow: a real worker (scripts/platform-worker.ts, started by the local Dispatcher) against a site
 * on 127.0.0.1. Run with PLATFORM_SLOW_TESTS=1 (and Docker's Postgres):
 *   PLATFORM_SLOW_TESTS=1 npx tsx --test tests/platform/worker.slow.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, eq, sql, SKIP_DB, type TestDb } from './db-harness';
import { SECRET, tempStore } from './helpers';
import { startFixtureSite, startWorkerServer } from './worker-server';
import { artifacts, audits, suppressedDomains } from '../../web/db/schema';
import { startAudit } from '../../web/lib/core/audits';
import { internalPrincipal } from '../../web/lib/core/principal';
import { dispatchNext } from '../../web/lib/core/queue';
import { reap } from '../../web/lib/core/reaper';
import { loadAudit } from '../../web/lib/core/loader';
import { LocalDispatcher } from '../../web/lib/platform/local/dispatcher';
import { LocalWorkerIdentity } from '../../web/lib/platform/local/identity';
import type { LocalFileStore } from '../../web/lib/platform/local/file-store';

const SKIP = SKIP_DB || (process.env.PLATFORM_SLOW_TESTS === '1' ? false : 'slow: set PLATFORM_SLOW_TESTS=1');
const caps = { public: 1, api: 2, internal: 2, pipeline: 1 };
let t: TestDb;
let files: ReturnType<typeof tempStore>;
let app: Awaited<ReturnType<typeof startWorkerServer>>;
let dispatcher: LocalDispatcher;
let platformDir: string;
const identity = new LocalWorkerIdentity(SECRET);

before(async () => {
  if (SKIP) return;
  t = await createTestDb();
  const deps = { db: t.db, files: undefined as unknown as LocalFileStore, identity, secret: SECRET };
  app = await startWorkerServer(deps);
  files = tempStore(app.url); // the upload grant must point at this server
  deps.files = files.store;
  platformDir = mkdtempSync(path.join(os.tmpdir(), 'platform-slow-'));
  dispatcher = new LocalDispatcher(identity, {
    appUrl: app.url,
    repoRoot: path.resolve(__dirname, '../..'),
    extraEnv: { PLATFORM_HEARTBEAT_MS: '2000', PLATFORM_PROGRESS_MS: '1000', CRUX_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
  Object.assign(dispatcher, { platformDir });
});
after(async () => {
  await app?.close();
  await t?.close();
  files?.cleanup();
  if (platformDir) rmSync(platformDir, { recursive: true, force: true });
});

async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const statusOf = async (id: string) => (await t.db.select().from(audits).where(eq(audits.id, id)))[0]!;
const logOf = (id: string, attempt: number) => {
  const f = path.join(platformDir, 'logs', `${id}-${attempt}.log`);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

void test(
  'slow: a quick scan of a local site ends succeeded with a report_html artifact',
  { skip: SKIP, timeout: 240_000 },
  async () => {
    const site = await startFixtureSite({ pages: 3 });
    try {
      const s = await startAudit(t.db, internalPrincipal(), { url: site.origin, mode: 'quick' });
      await dispatchNext(t.db, { dispatcher }, { caps });
      await until(
        async () => ['built', 'failed', 'cancelled'].includes((await statusOf(s.audit_id)).status),
        200_000,
        'built',
      );
      const built = await statusOf(s.audit_id);
      assert.equal(built.status, 'built', logOf(s.audit_id, 1).slice(-3000));
      const loaded = await loadAudit(t.db, files.store, s.audit_id);
      assert.equal(
        (await statusOf(s.audit_id)).status,
        'succeeded',
        JSON.stringify({ loaded, error: (await statusOf(s.audit_id)).error }),
      );
      const rows = await t.db.select().from(artifacts).where(eq(artifacts.auditId, s.audit_id));
      assert.ok(rows.some((r) => r.kind === 'report_html'));
      assert.ok(rows.some((r) => r.kind === 'raw_archive'));
    } finally {
      await site.close();
    }
  },
);

void test(
  'slow: a worker killed mid-crawl resumes from its snapshot and the page count is complete',
  { skip: SKIP, timeout: 360_000 },
  async () => {
    const site = await startFixtureSite({ pages: 10, delayMs: 2500 });
    try {
      const s = await startAudit(t.db, internalPrincipal(), { url: site.origin, mode: 'quick' });
      await dispatchNext(t.db, { dispatcher }, { caps });
      await until(async () => /snapshot 1 taken/.test(logOf(s.audit_id, 1)), 120_000, 'the first snapshot');
      await dispatcher.cancel(s.audit_id, 1); // kill the whole process group
      const t0 = new Date(Date.now() + 11 * 60_000); // the reaper's clock: the heartbeat has stopped
      await reap(t.db, dispatcher, { now: t0 });
      assert.equal((await statusOf(s.audit_id)).status, 'stalled');
      await reap(t.db, dispatcher, { now: new Date(t0.getTime() + 60_000) });
      assert.equal((await statusOf(s.audit_id)).status, 'queued');
      await dispatchNext(t.db, { dispatcher }, { caps });
      await until(
        async () => ['built', 'failed'].includes((await statusOf(s.audit_id)).status),
        300_000,
        'attempt 2 built',
      );
      const row = await statusOf(s.audit_id);
      assert.equal(row.status, 'built', logOf(s.audit_id, 2).slice(-3000));
      assert.equal(row.currentAttempt, 2);
      assert.match(logOf(s.audit_id, 2), /restored \d+ file\(s\) from attempt 1/);
      await loadAudit(t.db, files.store, s.audit_id);
      const doc = (
        await t.db.execute(
          sql`select (document->'pages'->>'ok')::int as ok from audit_documents where audit_id = ${s.audit_id}`,
        )
      ).rows[0] as { ok: number } | undefined;
      assert.equal(doc?.ok, 11, 'homepage + 10 pages');
    } finally {
      await site.close();
    }
  },
);

void test(
  'slow: a homepage redirecting to a guarded domain ends cancelled with nothing stored',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    await t.db
      .insert(suppressedDomains)
      .values({ registrableDomain: 'guarded.example', reason: 'legal' })
      .onConflictDoNothing();
    const site = await startFixtureSite({ redirectTo: 'http://guarded.example/' });
    try {
      const s = await startAudit(t.db, internalPrincipal(), { url: site.origin, mode: 'quick' });
      await dispatchNext(t.db, { dispatcher }, { caps });
      await until(
        async () => ['cancelled', 'failed', 'built'].includes((await statusOf(s.audit_id)).status),
        100_000,
        'cancelled',
      );
      const row = await statusOf(s.audit_id);
      assert.equal(row.status, 'cancelled', logOf(s.audit_id, 1).slice(-2000));
      assert.equal(row.error, 'scan_guard');
      assert.equal((await t.db.select().from(artifacts).where(eq(artifacts.auditId, s.audit_id))).length, 0);
    } finally {
      await site.close();
    }
  },
);
