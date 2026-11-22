/** People who log in to /internal, and usage counted per user. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { SECRET } from './helpers';
import { admins, audits } from '../../web/db/schema';
import {
  authenticateApiKey,
  createApiKey,
  hashPassword,
  login,
  sessionPrincipal,
  upsertAdmin,
} from '../../web/lib/core/auth';
import { startAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import { internalPrincipal, type Principal } from '../../web/lib/core/principal';
import { usageByUser } from '../../web/lib/core/usage';

let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

const code = (c: string) => (err: unknown) => err instanceof CoreError && err.code === c;
const SHARED = 'shared password 123';
const cfg = { passwordHash: hashPassword(SHARED), sessionSecret: SECRET };
const NOW = new Date('2026-11-22T10:00:00Z');
let ip = 0;
const nextIp = () => `10.1.0.${++ip}`;

void test(
  'admins: the shared password works until a person exists; then each logs in as themselves',
  { skip: SKIP_DB },
  async () => {
    const shared = await login(t.db, { password: SHARED, ip: nextIp() }, cfg, NOW);
    assert.deepEqual(sessionPrincipal(shared, SECRET, NOW.getTime()), { kind: 'internal', label: 'internal' });

    const ann = await upsertAdmin(t.db, { email: ' Ann@Example.com ', name: 'Ann', password: 'ann password 123' });
    assert.equal(ann.created, true);
    await assert.rejects(upsertAdmin(t.db, { email: 'bob@example.com', password: 'short' }), /12 characters/);
    await assert.rejects(upsertAdmin(t.db, { email: 'not-an-email', password: 'long enough 123' }), /email/);

    await assert.rejects(login(t.db, { password: SHARED, ip: nextIp() }, cfg, NOW), code('unauthorized'));
    await assert.rejects(
      login(t.db, { email: 'ann@example.com', password: SHARED, ip: nextIp() }, cfg, NOW),
      code('unauthorized'),
    );
    await assert.rejects(
      login(t.db, { email: 'nobody@example.com', password: 'ann password 123', ip: nextIp() }, cfg, NOW),
      code('unauthorized'),
    );

    const cookie = await login(
      t.db,
      { email: 'ANN@example.com', password: 'ann password 123', ip: nextIp() },
      cfg,
      NOW,
    );
    assert.deepEqual(sessionPrincipal(cookie, SECRET, NOW.getTime()), {
      kind: 'internal',
      label: 'admin:ann@example.com',
      adminId: ann.id,
    });
    const [row] = await t.db.select().from(admins).where(eq(admins.id, ann.id));
    assert.equal(row!.lastLoginAt?.toISOString(), NOW.toISOString());
    assert.ok(!row!.passwordHash.includes('ann password'));

    // Disabled: no login. A new password enables the same person again.
    await t.db.update(admins).set({ disabledAt: NOW }).where(eq(admins.id, ann.id));
    await assert.rejects(
      login(t.db, { email: 'ann@example.com', password: 'ann password 123', ip: nextIp() }, cfg, NOW),
      code('unauthorized'),
    );
    const again = await upsertAdmin(t.db, { email: 'ann@example.com', password: 'a newer password 1' });
    assert.deepEqual(again, { id: ann.id, created: false });
    assert.ok(await login(t.db, { email: 'ann@example.com', password: 'a newer password 1', ip: nextIp() }, cfg, NOW));
  },
);

void test('usage: audits, websites, pages and types are counted per user', { skip: SKIP_DB }, async () => {
  await t.db.delete(audits);
  const ann = await upsertAdmin(t.db, { email: 'ann@example.com', name: 'Ann', password: 'ann password 123' });
  const bob = await upsertAdmin(t.db, { email: 'bob@example.com', password: 'bob password 123' });
  const as = (id: string, email: string): Principal => ({ kind: 'internal', label: `admin:${email}`, adminId: id });
  const key = await createApiKey(t.db, {
    name: 'crm',
    scopes: ['audits:read', 'audits:start:quick'],
    rateLimitPerHour: 1000,
  });
  const client = await authenticateApiKey(t.db, `Bearer ${key.key}`);

  const finish = (id: string, pages: number, status = 'succeeded') =>
    t.db.update(audits).set({ status, pagesProcessed: pages, finishedAt: new Date() }).where(eq(audits.id, id));
  const run = async (who: Principal, url: string, mode: 'full' | 'quick' | 'page', pages: number, status?: string) => {
    const a = await startAudit(t.db, who, { url, mode });
    assert.equal(a.reused, null, url);
    await finish(a.audit_id, pages, status);
    return a.audit_id;
  };
  const first = await run(as(ann.id, 'ann@example.com'), 'https://one.example', 'full', 400);
  await run(as(ann.id, 'ann@example.com'), 'https://one.example', 'quick', 25);
  await run(as(ann.id, 'ann@example.com'), 'https://two.example/pricing', 'page', 1, 'failed');
  await run(as(bob.id, 'bob@example.com'), 'https://one.example', 'quick', 25);
  await run(client, 'https://three.example', 'quick', 20);
  await run(internalPrincipal(), 'https://four.example', 'quick', 10);

  const [stored] = await t.db.select().from(audits).where(eq(audits.id, first));
  assert.equal(stored!.createdByAdminId, ann.id);

  const usage = await usageByUser(t.db, internalPrincipal());
  const row = (user: string) => usage.rows.find((r) => r.user === user);
  assert.deepEqual(
    { ...row('ann@example.com'), last_audit_at: null },
    {
      user_kind: 'admin',
      user: 'ann@example.com',
      name: 'Ann',
      audits: 3,
      websites: 2,
      pages: 426,
      full: 1,
      quick: 1,
      page: 1,
      succeeded: 2,
      failed: 1,
      last_audit_at: null,
    },
  );
  assert.equal(row('bob@example.com')?.pages, 25);
  assert.equal(row('crm')?.user_kind, 'client');
  assert.equal(row('crm')?.pages, 20);
  assert.equal(row('internal')?.user_kind, 'other');
  assert.equal(usage.rows[0]!.user, 'ann@example.com', 'busiest first');

  // A period before these audits has none; an API client may not read usage.
  const earlier = await usageByUser(t.db, internalPrincipal(), { to: new Date(Date.now() - 86400_000) });
  assert.equal(earlier.rows.length, 0);
  await assert.rejects(usageByUser(t.db, client), code('forbidden'));

  // A disabled admin keeps their audits and their name in the counts.
  await t.db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, bob.id));
  assert.equal(
    (await usageByUser(t.db, internalPrincipal())).rows.find((r) => r.user === 'bob@example.com')?.audits,
    1,
  );
});
