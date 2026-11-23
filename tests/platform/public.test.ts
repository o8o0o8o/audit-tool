/** The public site (design §7): what a visitor may start and see. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { SECRET } from './helpers';
import { audits, rateEvents, suppressedDomains } from '../../web/db/schema';
import { startAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import { internalPrincipal } from '../../web/lib/core/principal';
import {
  botCheckConfigured,
  botCheckFromEnv,
  publicScansOpen,
  publicScanView,
  startPublicScan,
  turnstileCheck,
} from '../../web/lib/core/public';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());
beforeEach(async () => {
  if (SKIP_DB) return;
  await t.db.delete(audits);
  await t.db.delete(rateEvents);
});

const code = (c: string, text?: RegExp) => (err: unknown) =>
  err instanceof CoreError && err.code === c && (!text || text.test(err.message));
const human = async () => true;
let n = 0;
const ctx = (over: Partial<Parameters<typeof startPublicScan>[2]> = {}) => ({
  ip: `203.0.113.${++n}`,
  botCheck: human,
  ipSecret: SECRET,
  ...over,
});
const scan = (url: string, mode: 'quick' | 'page' = 'quick', over = {}) =>
  startPublicScan(t.db, { url, mode, token: 'tok' }, ctx(over));

void test('public site: off until switched on; a bot check only with both keys', async () => {
  assert.equal(publicScansOpen({}), false);
  assert.equal(publicScansOpen({ TURNSTILE_SITE_KEY: 'a' }), false);
  assert.equal(publicScansOpen({ PUBLIC_SCANS: 'off' }), false);
  assert.equal(publicScansOpen({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' }), true);
  assert.equal(publicScansOpen({ PUBLIC_SCANS: 'on' }), true);
  assert.equal(botCheckConfigured({ PUBLIC_SCANS: 'on' }), false);
  // With no keys there is no check to fail: an empty token passes.
  assert.equal(await botCheckFromEnv({ PUBLIC_SCANS: 'on' })('', '203.0.113.1'), true);
});

void test('bot check: asks Cloudflare with the secret and the token; anything but success is a refusal', async () => {
  let sent: URLSearchParams | null = null;
  const ok = turnstileCheck('the-secret', (async (_url: unknown, init?: RequestInit) => {
    sent = init?.body as URLSearchParams;
    return Response.json({ success: true });
  }) as typeof fetch);
  assert.equal(await ok('visitor-token', '203.0.113.9'), true);
  assert.equal(sent!.get('secret'), 'the-secret');
  assert.equal(sent!.get('response'), 'visitor-token');
  assert.equal(sent!.get('remoteip'), '203.0.113.9');
  assert.equal(await ok('', '203.0.113.9'), false, 'no token: not even asked');
  const no = (body: Response | Error) =>
    turnstileCheck('s', (async () => {
      if (body instanceof Error) throw body;
      return body;
    }) as typeof fetch)('tok', 'direct');
  assert.equal(await no(Response.json({ success: false })), false);
  assert.equal(await no(new Response('down', { status: 503 })), false);
  assert.equal(await no(new Error('network')), false);
});

void test(
  'public scan: a quick scan or one page, public source and profile, nothing else chosen by the visitor',
  { skip: SKIP_DB },
  async () => {
    const res = await scan('Example.org');
    assert.equal(res.reused, false);
    const [row] = await t.db.select().from(audits).where(eq(audits.id, res.audit_id));
    assert.equal(row!.source, 'public');
    assert.equal(row!.profile, 'public');
    assert.equal(row!.mode, 'quick');
    assert.equal(row!.status, 'queued');
    assert.equal(row!.createdByAdminId, null);
    assert.equal(row!.createdByClientId, null);

    // A full audit, options, or anything else in the request is refused or ignored.
    await assert.rejects(startPublicScan(t.db, { url: 'a.example', mode: 'full', token: 't' }, ctx()));
    const withExtras = await startPublicScan(
      t.db,
      { url: 'extras.example', mode: 'quick', token: 't', options: { llm: true, maxPages: 5000 }, profile: 'standard' },
      ctx(),
    );
    const [extra] = await t.db.select().from(audits).where(eq(audits.id, withExtras.audit_id));
    assert.equal(extra!.profile, 'public');
    assert.equal((extra!.options as { llm?: boolean }).llm, false);

    // Outside local mode a private address is refused (local mode audits fixtures on this machine).
    const mode = process.env.PLATFORM_MODE;
    process.env.PLATFORM_MODE = 'production';
    try {
      await assert.rejects(scan('http://localhost:3000'), code('invalid_input', /public website/));
      await assert.rejects(scan('10.0.0.8'), code('invalid_input'));
    } finally {
      process.env.PLATFORM_MODE = mode;
    }
    await assert.rejects(scan('not a url at all'), code('invalid_input'));
  },
);

void test('public scan: a failed bot check starts nothing and touches no limit', { skip: SKIP_DB }, async () => {
  await assert.rejects(scan('bot.example', 'quick', { botCheck: async () => false }), code('forbidden', /bot check/));
  assert.equal((await t.db.select().from(audits)).length, 0);
  assert.equal((await t.db.select().from(rateEvents)).length, 0);
});

void test('public scan: a guarded site gets a neutral refusal', { skip: SKIP_DB }, async () => {
  await t.db.insert(suppressedDomains).values({ registrableDomain: 'guarded.example', reason: 'owner_request' });
  await assert.rejects(scan('www.guarded.example'), (err: unknown) => {
    assert.ok(err instanceof CoreError);
    assert.equal(err.message, "This site can't be scanned.");
    assert.ok(!/contact|suppress|guard/i.test(err.message));
    return true;
  });
  assert.equal((await t.db.select().from(audits)).length, 0);
  await t.db.delete(suppressedDomains);
});

void test('public scan: the same target again returns the audit that exists', { skip: SKIP_DB }, async () => {
  const first = await scan('repeat.example');
  const again = await scan('https://www.repeat.example/some/page', 'quick', { ip: '198.51.100.7' });
  assert.deepEqual(again, { audit_id: first.audit_id, reused: true });
  assert.equal((await t.db.select().from(audits)).length, 1);
  assert.equal((await t.db.select().from(rateEvents)).length, 1, 'a repeat costs the visitor nothing');

  // A page audit is per address; another page of the site is a new audit.
  const page = await scan('repeat.example/pricing', 'page');
  assert.equal(page.reused, false);
  assert.equal((await scan('https://repeat.example/pricing', 'page')).audit_id, page.audit_id);
  assert.notEqual((await scan('repeat.example/about', 'page')).audit_id, page.audit_id);

  // A failed scan does not block a new one, and after a day the target is scanned again.
  await t.db.update(audits).set({ status: 'failed' }).where(eq(audits.id, first.audit_id));
  const retry = await scan('repeat.example');
  assert.equal(retry.reused, false);
  await t.db.update(audits).set({ status: 'succeeded' }).where(eq(audits.id, retry.audit_id));
  const nextDay = await scan('repeat.example', 'quick', { now: new Date(Date.now() + 25 * 3600_000) });
  assert.notEqual(nextDay.audit_id, retry.audit_id);
});

void test('public scan: limits per address, per site and overall', { skip: SKIP_DB }, async () => {
  const ip = '198.51.100.20';
  for (const host of ['a1.example', 'a2.example', 'a3.example']) await scan(host, 'quick', { ip });
  await assert.rejects(scan('a4.example', 'quick', { ip }), code('rate_limited', /last hour/));
  assert.ok(await scan('a4.example'), 'another address is not affected');

  // Finished audits do not count towards the cap on open ones.
  await assert.rejects(
    scan('a5.example', 'quick', { limits: { openAudits: 4 } }),
    code('rate_limited', /running right now/),
  );
  await t.db.update(audits).set({ status: 'succeeded' });
  assert.ok(await scan('a5.example', 'quick', { limits: { openAudits: 4 } }));

  // The cap per day counts every public audit of the last 24 hours, finished or not.
  await assert.rejects(scan('a6.example', 'quick', { limits: { perDay: 5 } }), code('rate_limited', /today/));
  assert.ok(await scan('a6.example', 'quick', { limits: { perDay: 5 }, now: new Date(Date.now() + 25 * 3600_000) }));

  for (const p of ['1', '2']) await scan(`pages.example/${p}`, 'page', { limits: { pagesPerDomainPerDay: 2 } });
  await assert.rejects(
    scan('pages.example/3', 'page', { limits: { pagesPerDomainPerDay: 2 } }),
    code('rate_limited', /page audits/),
  );
});

void test('public result: only audits the public site started, and no internals', { skip: SKIP_DB }, async () => {
  const pub = await scan('view.example');
  const internal = await startAudit(t.db, internalPrincipal(), { url: 'view.example', mode: 'quick' });
  assert.notEqual(internal.audit_id, pub.audit_id, 'an internal audit of the same site is a separate audit');

  const view = await publicScanView(t.db, pub.audit_id);
  assert.deepEqual(
    { ...view, created_at: null },
    {
      audit_id: pub.audit_id,
      mode: 'quick',
      target: 'https://view.example',
      status: 'running',
      processed: null,
      total: null,
      created_at: null,
      finished_at: null,
    },
  );
  assert.equal(await publicScanView(t.db, internal.audit_id), null);
  assert.equal(await publicScanView(t.db, 'not-a-uuid'), null);
  assert.equal(await publicScanView(t.db, '00000000-0000-4000-8000-000000000000'), null);

  for (const [status, shown] of [
    ['dispatched', 'running'],
    ['loading', 'running'],
    ['stalled', 'running'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ] as const) {
    await t.db.update(audits).set({ status, error: 'internal detail' }).where(eq(audits.id, pub.audit_id));
    const v = await publicScanView(t.db, pub.audit_id);
    assert.equal(v!.status, shown, status);
    assert.ok(!JSON.stringify(v).includes('internal detail'));
  }
});
