import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { FakeDispatcher, tempStore } from './helpers';
import { audits } from '../../web/db/schema';
import { findOrCreateSite } from '../../web/lib/core/sites';
import { CLOCK_MARGIN_MS, cronGate, gated, IDLE_SINCE_KEY, raiseWork } from '../../web/lib/core/cron-gate';
import { cronTick, TICK_STEPS } from '../../web/lib/core/cron-steps';
import type { Platform } from '../../web/lib/platform/types';

let t: TestDb;
const files = tempStore();
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => {
  await t?.close();
  files.cleanup();
});

async function audit(status: string): Promise<string> {
  const id = randomUUID();
  const site = await findOrCreateSite(t.db, 'gate.example');
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: 'quick',
    targetUrl: 'https://gate.example',
    profile: 'standard',
    profileHash: randomUUID(),
    comparableKey: 'k',
    source: 'internal',
    status,
  });
  return id;
}

void test(
  'cron gate: idle skips the database, a raise or open work wakes it, the fallback looks now and then',
  { skip: SKIP_DB },
  async () => {
    let clock = 1_000_000_000;
    const now = () => clock;
    const gate = cronGate(t.db, files.store, { now, fallbackMs: 60 * 60_000 });

    // No marker yet: run, and with nothing open record idle.
    assert.equal(await gate.shouldRun(), true);
    await gate.settle();
    assert.ok(await files.store.get(IDLE_SINCE_KEY));
    clock += 60_000;
    assert.equal(await gate.shouldRun(), false, 'idle: skip');

    // A request creates work and raises the marker.
    const id = await audit('queued');
    await raiseWork(files.store, clock);
    clock += 60_000;
    assert.equal(await gate.shouldRun(), true, 'raised: run');
    await gate.settle();
    clock += 5 * 60_000;
    assert.equal(await gate.shouldRun(), true, 'still open: keeps running');

    // The audit ends; the next settle records idle and the crons stop.
    await t.db.update(audits).set({ status: 'succeeded' }).where(eq(audits.id, id));
    await gate.settle();
    clock += 60_000;
    assert.equal(await gate.shouldRun(), false, 'idle again');

    // A raise just before an idle mark (clock skew) still counts.
    await raiseWork(files.store, clock - CLOCK_MARGIN_MS / 2);
    await gate.settle();
    assert.equal(await gate.shouldRun(), true, 'raise within the margin');

    // A lost raise is picked up by the fallback.
    clock += 60 * 60_000;
    assert.equal(await gate.shouldRun(), true, 'fallback');
  },
);

void test('cron gate: a raise during a tick is not hidden by the idle mark', { skip: SKIP_DB }, async () => {
  const store = tempStore();
  try {
    let clock = 2_000_000_000;
    const gate = cronGate(t.db, store.store, { now: () => clock });
    assert.equal(await gate.shouldRun(), true);
    clock += 1_000;
    await raiseWork(store.store, clock); // after the tick began, before settle
    await gate.settle();
    assert.equal(await store.store.get(IDLE_SINCE_KEY), null);
  } finally {
    store.cleanup();
  }
});

void test('gated: a skipped step returns null and never calls the step', { skip: SKIP_DB }, async () => {
  const store = tempStore();
  try {
    let calls = 0;
    const step = gated(t.db, store.store, async () => ++calls, { settle: true });
    assert.equal(await step(), 1); // no marker: runs, then settles idle (nothing open in a fresh store's view)
    await t.db.update(audits).set({ status: 'succeeded' }); // nothing open from the first test
    await step();
    const before = calls;
    assert.equal(await step(), null);
    assert.equal(calls, before);
  } finally {
    store.cleanup();
  }
});

void test(
  'cron tick: runs every step but retention in one call, dispatches a queued audit, then goes idle',
  { skip: SKIP_DB },
  async () => {
    const store = tempStore();
    try {
      await t.db.update(audits).set({ status: 'succeeded' }); // nothing open from the tests above
      const dispatcher = new FakeDispatcher();
      const platform: Platform = {
        mode: 'local',
        files: store.store,
        dispatcher,
        identity: { verify: async () => null },
      };
      const id = await audit('queued');
      // Raised two minutes ago: a raise inside the clock margin would keep the idle mark away.
      await raiseWork(store.store, Date.now() - 120_000);

      const first = await cronTick(t.db, platform);
      assert.ok(first);
      assert.deepEqual(Object.keys(first).sort(), [...TICK_STEPS].sort());
      assert.ok(!('retention' in first));
      assert.ok(
        Object.values(first).every((r) => r.ok),
        JSON.stringify(first),
      );
      assert.deepEqual(
        dispatcher.requests.map((r) => r.id),
        [id],
      );
      assert.equal(await store.store.get(IDLE_SINCE_KEY), null, 'an audit is open: not idle');

      // The audit ends: the next tick records idle, and the one after leaves the database alone.
      await t.db.update(audits).set({ status: 'succeeded' }).where(eq(audits.id, id));
      assert.ok(await cronTick(t.db, platform));
      assert.ok(await store.store.get(IDLE_SINCE_KEY));
      assert.equal(await cronTick(t.db, platform), null);
    } finally {
      store.cleanup();
    }
  },
);

void test('cron tick: a step that throws does not stop the others', { skip: SKIP_DB }, async () => {
  const store = tempStore();
  const quiet = console.error;
  console.error = () => {};
  try {
    await t.db.update(audits).set({ status: 'succeeded' });
    const dispatcher = new FakeDispatcher();
    dispatcher.dispatch = async () => {
      throw new Error('backend exploded');
    };
    const id = await audit('queued');
    const tick = await cronTick(t.db, {
      mode: 'local',
      files: store.store,
      dispatcher,
      identity: { verify: async () => null },
    });
    assert.ok(tick);
    assert.deepEqual(tick.dispatch, { ok: false, error: 'backend exploded' });
    assert.equal(tick.reaper?.ok, true);
    assert.equal(tick.loader?.ok, true);
    const [row] = await t.db.select({ status: audits.status }).from(audits).where(eq(audits.id, id));
    assert.equal(row?.status, 'queued', 'the audit is back in the queue');
  } finally {
    console.error = quiet;
    store.cleanup();
  }
});
