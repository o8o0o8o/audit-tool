/** Waiting for an audit: one held call instead of a polling loop, with a short answer. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { audits } from '../../web/db/schema';
import { getAudit, startAudit, waitForAudit, WAIT_MAX_SECONDS } from '../../web/lib/core/audits';
import { internalPrincipal } from '../../web/lib/core/principal';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

const me = internalPrincipal();

/** A clock the test moves, and a sleep that moves it and can change the audit on the way. */
function fake(onSleep?: (elapsedMs: number) => Promise<void>) {
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const start = clock;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      await onSleep?.(clock - start);
    },
  };
}

/** `sleep` and `now` of one clock, for a call whose timing the test does not look at. */
const clock = () => {
  const f = fake();
  return { sleep: f.sleep, now: f.now };
};

void test('wait: a quick scan is one call — it returns the moment the audit ends', { skip: SKIP_DB }, async () => {
  const a = await startAudit(t.db, me, { url: 'wait-quick.example', mode: 'quick' });
  const f = fake(async (elapsed) => {
    if (elapsed >= 90_000)
      await t.db.update(audits).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(audits.id, a.audit_id));
  });
  const res = await waitForAudit(t.db, me, a.audit_id, { timeoutSeconds: 280, sleep: f.sleep, now: f.now });
  assert.equal(res.finished, true);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.eta_seconds, 0);
  assert.match(res.next_step, /get_lead_summary/);
  assert.equal(
    f.sleeps.reduce((x, y) => x + y, 0),
    90_000,
    'stopped at the end, not at the timeout',
  );
  assert.ok('scores' in res, 'scores come with the finished answer');
});

void test('wait: the answer is short and says what to do next', { skip: SKIP_DB }, async () => {
  const a = await startAudit(t.db, me, { url: 'wait-full.example', mode: 'full' });
  const started = new Date(Date.parse('2026-11-23T10:00:00Z') - 10 * 60_000);
  await t.db
    .update(audits)
    .set({ status: 'running', phase: 'crawl', startedAt: started, pagesProcessed: 100, pagesTotal: 400 })
    .where(eq(audits.id, a.audit_id));

  // 100 of 400 pages in 10 minutes: about 30 more minutes of crawl. Far away: do not loop.
  const f = fake();
  const far = await waitForAudit(t.db, me, a.audit_id, { timeoutSeconds: 50, sleep: f.sleep, now: f.now });
  assert.equal(far.finished, false);
  assert.deepEqual(far.pages, { processed: 100, total: 400 });
  assert.ok(far.eta_seconds! > 25 * 60 && far.eta_seconds! < 40 * 60, String(far.eta_seconds));
  assert.match(far.next_step, /Do not call in a loop/);
  assert.match(far.next_step, /min left/);
  assert.equal(
    f.sleeps.reduce((x, y) => x + y, 0),
    50_000,
    'held for the whole timeout',
  );
  assert.ok(f.sleeps.length <= 18, 'reads the row every few seconds, not constantly');

  // Small on purpose: an assistant pays for every field.
  const full = await getAudit(t.db, me, a.audit_id);
  assert.ok(JSON.stringify(far).length < JSON.stringify(full).length / 2, 'much smaller than get_audit');
  for (const k of ['options', 'artifacts', 'links', 'scores']) assert.ok(!(k in far), k);

  // Nearly done: one more call will see the end, and it says how long to hold.
  await t.db.update(audits).set({ pagesProcessed: 395 }).where(eq(audits.id, a.audit_id));
  const near = await waitForAudit(t.db, me, a.audit_id, { timeoutSeconds: 1, ...clock() });
  assert.ok(near.eta_seconds! < 260, String(near.eta_seconds));
  assert.match(near.next_step, /once more with timeout_seconds=\d+/);

  // Not started: no pace to read, so the start estimate is used.
  const b = await startAudit(t.db, me, { url: 'wait-queued.example', mode: 'page' });
  const queued = await waitForAudit(t.db, me, b.audit_id, { timeoutSeconds: 1, ...clock() });
  assert.equal(queued.status, 'queued');
  assert.ok(queued.eta_seconds !== null && queued.eta_seconds >= 30);

  // A failed audit is finished too, and the answer says so.
  await t.db
    .update(audits)
    .set({ status: 'failed', error: 'the site refused the scan' })
    .where(eq(audits.id, b.audit_id));
  const failed = await waitForAudit(t.db, me, b.audit_id, clock());
  assert.equal(failed.finished, true);
  assert.match(failed.next_step, /Ended as failed \(the site refused the scan\)/);

  // The timeout is capped, whatever is asked.
  const g = fake();
  await waitForAudit(t.db, me, a.audit_id, { timeoutSeconds: 100_000, sleep: g.sleep, now: g.now });
  assert.equal(
    g.sleeps.reduce((x, y) => x + y, 0),
    WAIT_MAX_SECONDS * 1000,
  );
});
