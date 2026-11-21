/** Guards added after the code review: races, do_not_contact, report links, private addresses, dead jobs. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { SECRET } from './helpers';
import { auditAttempts, audits, jobs, prospects, webhookDeliveries } from '../../web/db/schema';
import { cancelAudit, startAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import { JOB_LIMITS, reapJobs } from '../../web/lib/core/jobs';
import { upsertProspect } from '../../web/lib/core/prospects';
import type { Principal } from '../../web/lib/core/principal';
import { reap, REAPER } from '../../web/lib/core/reaper';
import { makeReportToken, reportTokenTarget, reportUrl, servedByReportLink } from '../../web/lib/core/reports';
import { findOrCreateSite, isPrivateHost } from '../../web/lib/core/sites';
import { assertWebhookUrl, isPrivateAddress } from '../../web/lib/core/webhooks';
import { reportStatus } from '../../web/lib/core/worker';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

const code = (c: string) => (e: unknown) => e instanceof CoreError && e.code === c;
const internal: Principal = { kind: 'internal', label: 'internal' };

async function audit(status: string, extra: Partial<typeof audits.$inferInsert> = {}) {
  const site = await findOrCreateSite(t.db, `r${randomUUID().slice(0, 8)}.example`);
  const id = randomUUID();
  await t.db.insert(audits).values({
    id,
    siteId: site.id,
    mode: 'quick',
    targetUrl: `https://${site.host}`,
    profile: 'standard',
    profileHash: id,
    comparableKey: 'k',
    status,
    source: 'api',
    currentAttempt: 1,
    ...extra,
  });
  return id;
}
const statusOf = async (id: string) =>
  (await t.db.select({ s: audits.status }).from(audits).where(eq(audits.id, id)))[0]!.s;

void test('do_not_contact: an upsert never changes the row or clears the flag', { skip: SKIP_DB }, async () => {
  const p: Principal = internal;
  const website = `https://dnc-${randomUUID().slice(0, 6)}.example`;
  await upsertProspect(t.db, p, { company: 'A', website, stage: 'do_not_contact' });
  await assert.rejects(upsertProspect(t.db, p, { company: 'B', website, stage: 'new' }), code('do_not_contact'));
  const [row] = await t.db.select().from(prospects).where(eq(prospects.website, website));
  assert.equal(row!.doNotContact, true);
  assert.equal(row!.company, 'A');
});

void test('a worker status after a cancel is refused and the audit stays cancelled', { skip: SKIP_DB }, async () => {
  const id = await audit('running');
  await t.db.insert(auditAttempts).values({ auditId: id, attempt: 1, status: 'running', dispatchNonce: 'n' });
  let finished = 0;
  const onFinished = async () => void finished++;
  assert.equal((await cancelAudit(t.db, internal, id, { onFinished })).status, 'cancelled');
  await assert.rejects(
    reportStatus(t.db, { auditId: id, attempt: 1 }, { status: 'built' }, { onFinished }),
    code('stale_attempt'),
  );
  assert.equal(await statusOf(id), 'cancelled');
  // A second cancel reports the state and queues no second event.
  assert.equal((await cancelAudit(t.db, internal, id, { onFinished })).status, 'cancelled');
  assert.equal(finished, 1);
});

void test('reaper: a run past the time limit fails; a built run is left alone', { skip: SKIP_DB }, async () => {
  const now = new Date('2026-11-21T10:00:00Z');
  const old = new Date(now.getTime() - REAPER.maxRunMs - 60_000);
  const hung = await audit('running');
  await t.db
    .insert(auditAttempts)
    .values({ auditId: hung, attempt: 1, dispatchNonce: 'n', status: 'running', registeredAt: old, heartbeatAt: now });
  const built = await audit('built');
  await t.db
    .insert(auditAttempts)
    .values({ auditId: built, attempt: 1, dispatchNonce: 'n', status: 'built', registeredAt: old, heartbeatAt: old });
  const cancelled: string[] = [];
  const res = await reap(
    t.db,
    { state: async () => 'running', cancel: async (id) => void cancelled.push(id) },
    { now },
  );
  assert.ok(res.failed.includes(hung));
  assert.deepEqual(cancelled, [hung]);
  assert.equal(await statusOf(hung), 'failed');
  assert.equal(await statusOf(built), 'built');
});

void test('PDF jobs: a silent job is requeued, then failed after the last try', { skip: SKIP_DB }, async () => {
  const id = await audit('succeeded');
  const now = new Date('2026-11-21T10:00:00Z');
  const silent = new Date(now.getTime() - JOB_LIMITS.silentMs - 1000);
  const [job] = await t.db
    .insert(jobs)
    .values({ type: 'render-pdf', auditId: id, kind: 'report', status: 'running', tries: 1, heartbeatAt: silent })
    .returning({ id: jobs.id });
  assert.deepEqual((await reapJobs(t.db, undefined, now)).requeued, [job!.id]);
  await t.db
    .update(jobs)
    .set({ status: 'dispatched', tries: JOB_LIMITS.maxTries, heartbeatAt: silent })
    .where(eq(jobs.id, job!.id));
  assert.deepEqual((await reapJobs(t.db, undefined, now)).failed, [job!.id]);
  const [after] = await t.db.select().from(jobs).where(eq(jobs.id, job!.id));
  assert.equal(after!.status, 'failed');
});

void test(
  'report links: only succeeded audits for clients; hidden kinds and expired files not served',
  { skip: SKIP_DB },
  async () => {
    const failed = await audit('failed');
    const client: Principal = {
      kind: 'client',
      clientId: randomUUID(),
      name: 'c',
      scopes: ['audits:read'],
    } as Principal;
    await assert.rejects(
      reportUrl(t.db, client, { audit_id: failed, kind: 'html' }, { appUrl: 'http://x', secret: SECRET }),
      code('audit_not_ready'),
    );
    assert.equal(await reportTokenTarget(t.db, makeReportToken(failed, SECRET), SECRET), null);
    assert.equal(
      await reportTokenTarget(t.db, makeReportToken(failed, SECRET, Date.now(), 3600, true), SECRET),
      failed,
    );
    const ok = await audit('succeeded');
    assert.equal(await reportTokenTarget(t.db, makeReportToken(ok, SECRET), SECRET), ok);
    assert.equal(servedByReportLink({ kind: 'raw_archive', expiresAt: null }), false);
    assert.equal(servedByReportLink({ kind: 'gate_evidence', expiresAt: null }), false);
    assert.equal(servedByReportLink({ kind: 'screenshot', expiresAt: new Date(Date.now() - 1000) }), false);
    assert.equal(servedByReportLink({ kind: 'screenshot', expiresAt: null }), true);
  },
);

void test('private addresses: IPv4 inside IPv6, odd forms, and audit targets', async () => {
  for (const ip of [
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a00:1',
    '198.18.0.1',
    '::1',
    'fd00::1',
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '::ffff:5db8:d822', '2606:2800:220:1::1'])
    assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(new URL('http://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');
  assert.throws(() => assertWebhookUrl('http://[::ffff:127.0.0.1]:5432/', false), /private/);
  assert.throws(() => assertWebhookUrl('http://localhost/x', false), /private/);
  assertWebhookUrl('https://hooks.example.com/x', false);
  for (const h of ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', 'db.internal'])
    assert.equal(isPrivateHost(h), true, h);
  assert.equal(isPrivateHost('example.com'), false);
});

void test('start_audit refuses a private target outside local mode', { skip: SKIP_DB }, async () => {
  const before = process.env.PLATFORM_MODE;
  process.env.PLATFORM_MODE = 'production';
  try {
    await assert.rejects(
      startAudit(t.db, internal, { url: 'http://169.254.169.254', mode: 'quick' }),
      code('invalid_input'),
    );
  } finally {
    if (before === undefined) delete process.env.PLATFORM_MODE;
    else process.env.PLATFORM_MODE = before;
  }
  assert.equal((await t.db.select().from(webhookDeliveries)).length, 0);
});
