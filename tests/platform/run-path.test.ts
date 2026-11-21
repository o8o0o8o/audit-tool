/** Step 1/2 run path on the database: start, guard, queue, worker sessions, reaper. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from '../../web/db/test-db';
import { createTestDb, SKIP_DB, type TestDb } from './db-harness';
import { FakeDispatcher, SECRET } from './helpers';
import { auditAttempts, audits, prospects, suppressedDomains } from '../../web/db/schema';
import { createApiKey, authenticateApiKey } from '../../web/lib/core/auth';
import { cancelAudit, startAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import { internalPrincipal, type Principal } from '../../web/lib/core/principal';
import { dispatchNext } from '../../web/lib/core/queue';
import { reap } from '../../web/lib/core/reaper';
import {
  heartbeat,
  registerWorker,
  reportProgress,
  reportStatus,
  workerGuard,
  workerSession,
} from '../../web/lib/core/worker';
import { LocalWorkerIdentity } from '../../web/lib/platform/local/identity';
import { checkGuard } from '../../web/lib/core/guard';

let t: TestDb;
let client: Principal;
let quickOnly: Principal;
const identity = new LocalWorkerIdentity(SECRET);
const code = (c: string) => (e: unknown) => e instanceof CoreError && e.code === c;
const caps = { public: 1, api: 5, internal: 5, pipeline: 1 };

before(async () => {
  if (SKIP_DB) return;
  t = await createTestDb();
  const k = await createApiKey(t.db, {
    name: 'svc',
    scopes: ['audits:read', 'audits:start:quick', 'audits:cancel'],
    rateLimitPerHour: 1000,
  });
  client = await authenticateApiKey(t.db, `Bearer ${k.key}`);
  const k2 = await createApiKey(t.db, {
    name: 'svc2',
    scopes: ['audits:read', 'audits:start:quick'],
    rateLimitPerHour: 1000,
  });
  quickOnly = await authenticateApiKey(t.db, `Bearer ${k2.key}`);
});
after(async () => t?.close());
beforeEach(async () => {
  if (!SKIP_DB) await t.db.delete(audits);
});

void test(
  'start_audit: two simultaneous starts for the same client, site and profile give one audit',
  { skip: SKIP_DB },
  async () => {
    const [a, b] = await Promise.all([
      startAudit(t.db, client, { url: 'concurrent.example', mode: 'quick' }),
      startAudit(t.db, client, { url: 'https://concurrent.example/about', mode: 'quick' }),
    ]);
    assert.equal(a.audit_id, b.audit_id);
    assert.deepEqual([a.reused, b.reused].sort(), ['in_progress', null].sort());
    assert.equal((await t.db.select().from(audits)).length, 1);
  },
);

void test('start_audit: each reused value', { skip: SKIP_DB }, async () => {
  const first = await startAudit(t.db, client, { url: 'reuse.example', mode: 'quick', idempotency_key: 'k-1' });
  assert.equal(first.reused, null);
  assert.equal(
    (await startAudit(t.db, client, { url: 'reuse.example', mode: 'quick', idempotency_key: 'k-1' })).reused,
    'idempotent',
  );
  assert.equal((await startAudit(t.db, client, { url: 'reuse.example', mode: 'quick' })).reused, 'in_progress');
  await t.db.update(audits).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(audits.id, first.audit_id));
  const recent = await startAudit(t.db, quickOnly, {
    url: 'reuse.example',
    mode: 'quick',
    reuse_if_newer_than_hours: 24,
  });
  assert.equal(recent.reused, 'recent');
  assert.equal(recent.audit_id, first.audit_id);
  assert.equal(recent.status, 'succeeded');
  const fresh = await startAudit(t.db, quickOnly, { url: 'reuse.example', mode: 'quick' });
  assert.equal(fresh.reused, null);
});

void test('start_audit: scopes decide the mode', { skip: SKIP_DB }, async () => {
  await assert.rejects(startAudit(t.db, client, { url: 'a.example', mode: 'full' }), code('forbidden'));
  await assert.rejects(
    startAudit(t.db, client, { url: 'a.example', mode: 'quick', options: { pdf: true } }),
    code('forbidden'),
  );
  await assert.rejects(
    startAudit(t.db, { kind: 'report', auditId: 'x' }, { url: 'a.example', mode: 'quick' }),
    code('forbidden'),
  );
});

void test('scan guard: do_not_contact refused by www and apex; suppressed domains too', { skip: SKIP_DB }, async () => {
  await t.db
    .insert(prospects)
    .values({
      company: 'Blocked',
      website: 'blocked.example',
      registrableDomains: ['blocked.example'],
      stage: 'do_not_contact',
      doNotContact: true,
    })
    .onConflictDoNothing();
  await assert.rejects(startAudit(t.db, client, { url: 'blocked.example', mode: 'quick' }), code('do_not_contact'));
  await assert.rejects(
    startAudit(t.db, client, { url: 'https://www.blocked.example/x', mode: 'quick' }),
    code('do_not_contact'),
  );
  await t.db
    .insert(suppressedDomains)
    .values({ registrableDomain: 'gone.example', reason: 'owner_request' })
    .onConflictDoNothing();
  assert.deepEqual(await checkGuard(t.db, 'shop.gone.example'), {
    allowed: false,
    reason: 'suppressed',
    registrableDomain: 'gone.example',
  });
  assert.deepEqual(await checkGuard(t.db, 'fine.example'), { allowed: true });
});

void test(
  'queue: dispatches with caps; two loops at once never dispatch a row twice; a guarded row is cancelled',
  { skip: SKIP_DB },
  async () => {
    for (const d of ['q1', 'q2', 'q3', 'q4'])
      await startAudit(t.db, internalPrincipal(), { url: `${d}.example`, mode: 'quick' });
    const guarded = await startAudit(t.db, internalPrincipal(), { url: 'later-blocked.example', mode: 'quick' });
    await t.db
      .insert(suppressedDomains)
      .values({ registrableDomain: 'later-blocked.example', reason: 'legal' })
      .onConflictDoNothing();
    const fake = new FakeDispatcher();
    const finished: string[] = [];
    const [x, y] = await Promise.all([
      dispatchNext(
        t.db,
        { dispatcher: fake },
        { caps: { ...caps, internal: 3 }, onFinished: async (id) => void finished.push(id) },
      ),
      dispatchNext(
        t.db,
        { dispatcher: fake },
        { caps: { ...caps, internal: 3 }, onFinished: async (id) => void finished.push(id) },
      ),
    ]);
    const ids = fake.requests.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no row dispatched twice');
    assert.equal(x.length + y.length, 3, 'cap of 3 respected');
    assert.ok(fake.requests.every((r) => r.attempt === 1 && r.nonce.length > 10));
    const [g] = await t.db.select().from(audits).where(eq(audits.id, guarded.audit_id));
    assert.ok(g!.status === 'cancelled' || g!.status === 'queued');
    // the guarded row is reached once capacity frees up
    await t.db.update(audits).set({ status: 'succeeded' }).where(eq(audits.status, 'dispatched'));
    await dispatchNext(
      t.db,
      { dispatcher: fake },
      { caps: { ...caps, internal: 3 }, onFinished: async (id) => void finished.push(id) },
    );
    const [g2] = await t.db.select().from(audits).where(eq(audits.id, guarded.audit_id));
    assert.equal(g2!.status, 'cancelled');
    assert.equal(g2!.error, 'scan_guard');
    assert.ok(finished.includes(guarded.audit_id));
  },
);

void test('queue: a refused dispatch leaves the row queued', { skip: SKIP_DB }, async () => {
  const s = await startAudit(t.db, internalPrincipal(), { url: 'refused.example', mode: 'quick' });
  const fake = new FakeDispatcher();
  fake.refuse = true;
  await dispatchNext(t.db, { dispatcher: fake }, { caps });
  const [row] = await t.db.select().from(audits).where(eq(audits.id, s.audit_id));
  assert.equal(row!.status, 'queued');
  assert.equal(row!.currentAttempt, 0);
});

async function dispatchedAudit(url: string) {
  const s = await startAudit(t.db, internalPrincipal(), { url, mode: 'quick' });
  const fake = new FakeDispatcher();
  await dispatchNext(t.db, { dispatcher: fake }, { caps });
  const req = fake.requests.find((r) => r.id === s.audit_id)!;
  const token = identity.issue({ runId: '4242', runAttempt: 1, id: req.id, attempt: req.attempt });
  return { id: s.audit_id, req, token, fake };
}

void test(
  'worker: wrong nonce refused; second register refused; an older attempt gets 409',
  { skip: SKIP_DB },
  async () => {
    const { id, req, token } = await dispatchedAudit('worker.example');
    await assert.rejects(
      registerWorker(t.db, identity, token, { audit_id: id, attempt: 1, nonce: 'wrong-nonce-123' }),
      code('unauthorized'),
    );
    await assert.rejects(
      registerWorker(t.db, identity, 'forged.token', { audit_id: id, attempt: 1, nonce: req.nonce }),
      code('unauthorized'),
    );
    const reg = await registerWorker(t.db, identity, token, { audit_id: id, attempt: 1, nonce: req.nonce });
    assert.equal(reg.audit.mode, 'quick');
    await assert.rejects(
      registerWorker(t.db, identity, token, { audit_id: id, attempt: 1, nonce: req.nonce }),
      (e) => e instanceof CoreError && ['conflict', 'stale_attempt'].includes(e.code),
    );
    const s = await workerSession(t.db, `Bearer ${reg.session}`);
    await reportProgress(t.db, s, { processed: 3, total: 25, phase: 'crawl' });
    const [row] = await t.db.select().from(audits).where(eq(audits.id, id));
    assert.equal(row!.status, 'running');
    assert.equal(row!.pagesTotal, 25);
    // a redispatch makes attempt 2; attempt 1's session is now stale
    await t.db.update(audits).set({ status: 'queued' }).where(eq(audits.id, id));
    const fake = new FakeDispatcher();
    await dispatchNext(t.db, { dispatcher: fake }, { caps });
    assert.equal(fake.requests[0]!.attempt, 2);
    assert.equal(fake.requests[0]!.resumeFromAttempt, 1);
    await assert.rejects(workerSession(t.db, `Bearer ${reg.session}`), code('stale_attempt'));
  },
);

void test('worker: final status, guard on a redirect host', { skip: SKIP_DB }, async () => {
  const { id, req, token } = await dispatchedAudit('final.example');
  const reg = await registerWorker(t.db, identity, token, { audit_id: id, attempt: 1, nonce: req.nonce });
  const s = await workerSession(t.db, `Bearer ${reg.session}`);
  await t.db
    .insert(prospects)
    .values({
      company: 'X',
      website: 'redirect-dnc.example',
      registrableDomains: ['redirect-dnc.example'],
      stage: 'do_not_contact',
      doNotContact: true,
    })
    .onConflictDoNothing();
  assert.equal((await workerGuard(t.db, s, 'www.redirect-dnc.example')).allowed, false);
  assert.equal((await workerGuard(t.db, s, 'final-new.example')).allowed, true);
  const finished: string[] = [];
  await reportStatus(
    t.db,
    s,
    {
      status: 'succeeded',
      artifacts: [{ kind: 'report_html', key: `audits/${id}/1/final.example.html`, bytes: 10, sha256: 'a'.repeat(64) }],
    },
    { onFinished: async (x) => void finished.push(x) },
  );
  const [row] = await t.db.select().from(audits).where(eq(audits.id, id));
  assert.equal(row!.status, 'succeeded');
  assert.deepEqual(finished, [id]);
  await assert.rejects(
    reportStatus(t.db, s, {
      status: 'built',
      artifacts: [{ kind: 'report_html', key: 'audits/other/1/x.html', bytes: 1, sha256: 'a'.repeat(64) }],
    }),
    code('invalid_input'),
  );
});

void test('cancel: only the client that started it', { skip: SKIP_DB }, async () => {
  const s = await startAudit(t.db, client, { url: 'cancel.example', mode: 'quick' });
  const other = { ...client, clientId: '00000000-0000-4000-8000-000000000001' } as Principal;
  await assert.rejects(cancelAudit(t.db, other, s.audit_id), code('forbidden'));
  assert.equal((await cancelAudit(t.db, client, s.audit_id)).status, 'cancelled');
});

void test(
  'reaper with a fake clock: never registered → redispatch; heartbeat stopped → stalled then resumed; third failure → failed',
  { skip: SKIP_DB },
  async () => {
    const t0 = new Date('2026-11-21T12:00:00Z');
    const fake = new FakeDispatcher();
    // never registered, backend says gone
    const lost = await startAudit(t.db, internalPrincipal(), { url: 'lost.example', mode: 'quick' });
    await dispatchNext(t.db, { dispatcher: fake }, { caps, now: t0 });
    let r = await reap(t.db, fake, { now: new Date(t0.getTime() + 10 * 60_000) });
    assert.deepEqual(r.redispatched, [], 'not yet: within 15 minutes');
    fake.states.set(`${lost.audit_id}:1`, 'waiting');
    r = await reap(t.db, fake, { now: new Date(t0.getTime() + 20 * 60_000) });
    assert.deepEqual(r.redispatched, [], 'still waiting for a runner: leave it');
    fake.states.set(`${lost.audit_id}:1`, 'gone');
    r = await reap(t.db, fake, { now: new Date(t0.getTime() + 20 * 60_000) });
    assert.deepEqual(r.redispatched, [lost.audit_id]);
    await t.db.delete(audits).where(eq(audits.id, lost.audit_id));

    // heartbeat stopped
    const { id, req, token } = await dispatchedAudit('silent.example');
    const reg = await registerWorker(t.db, identity, token, { audit_id: id, attempt: 1, nonce: req.nonce }, t0);
    await heartbeat(t.db, await workerSession(t.db, `Bearer ${reg.session}`), t0);
    r = await reap(t.db, fake, { now: new Date(t0.getTime() + 11 * 60_000) });
    assert.deepEqual(r.stalled, [id]);
    assert.ok(fake.cancelled.includes(`${id}:1`));
    assert.equal((await t.db.select().from(audits).where(eq(audits.id, id)))[0]!.status, 'stalled');
    r = await reap(t.db, fake, { now: new Date(t0.getTime() + 12 * 60_000) });
    assert.deepEqual(r.redispatched, [id]);
    // attempts 2 and 3 also go silent → failed after the third
    for (const attempt of [2, 3]) {
      const f = new FakeDispatcher();
      await dispatchNext(t.db, { dispatcher: f }, { caps });
      const rq = f.requests.find((x) => x.id === id)!;
      assert.equal(rq.attempt, attempt);
      const tk = identity.issue({ runId: String(100 + attempt), runAttempt: 1, id, attempt });
      await registerWorker(t.db, identity, tk, { audit_id: id, attempt, nonce: rq.nonce }, t0);
      await t.db.update(auditAttempts).set({ heartbeatAt: t0 }).where(eq(auditAttempts.auditId, id));
      await reap(t.db, fake, { now: new Date(t0.getTime() + 30 * 60_000) });
      r = await reap(t.db, fake, { now: new Date(t0.getTime() + 31 * 60_000) });
    }
    const [row] = await t.db.select().from(audits).where(eq(audits.id, id));
    assert.equal(row!.status, 'failed');
    assert.deepEqual(r.failed, [id]);
  },
);
