/** People who log in to /internal, and usage counted per user. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, eq, SKIP_DB, type TestDb } from './db-harness';
import { SECRET } from './helpers';
import { admins, audits } from '../../web/db/schema';
import {
  authenticateApiKey,
  createApiKey,
  createPersonalMcpKey,
  hashPassword,
  mcpSetupPrompt,
  PERSONAL_MCP_SCOPES,
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

void test(
  'MCP setup: a personal key in one step, counted as the person, replaced by the next, dead with its owner',
  { skip: SKIP_DB },
  async () => {
    await t.db.delete(audits);
    const eve = await upsertAdmin(t.db, { email: 'eve@example.com', name: 'Eve', password: 'eve password 123' });
    const session: Principal = { kind: 'internal', label: 'admin:eve@example.com', adminId: eve.id };

    const first = await createPersonalMcpKey(t.db, session);
    assert.equal(first.replaced, 0);
    const viaKey = await authenticateApiKey(t.db, `Bearer ${first.key}`);
    assert.equal(viaKey.kind, 'client');
    assert.equal(viaKey.kind === 'client' && viaKey.adminId, eve.id);
    assert.deepEqual(viaKey.kind === 'client' && [...viaKey.scopes].sort(), [...PERSONAL_MCP_SCOPES].sort());
    assert.ok(!PERSONAL_MCP_SCOPES.includes('prospects:write') && !PERSONAL_MCP_SCOPES.includes('audits:publish'));

    // The prompt carries all an assistant needs, with the address the person uses.
    const setup = mcpSetupPrompt('https://app.example/', first.key);
    assert.equal(setup.url, 'https://app.example/api/mcp');
    assert.ok(setup.prompt.includes(setup.url) && setup.prompt.includes(`Bearer ${first.key}`));
    assert.ok(
      setup.prompt.includes(setup.command) && setup.command.startsWith('claude mcp add --transport http audit '),
    );
    assert.match(setup.prompt, /list_audits/);
    assert.match(setup.prompt, /do not print it again/);

    // An audit from the key and one from the form are one user on the usage page.
    const a = await startAudit(t.db, viaKey, { url: 'https://mcp-one.example', mode: 'quick' });
    const b = await startAudit(t.db, session, { url: 'https://mcp-two.example', mode: 'quick' });
    for (const id of [a.audit_id, b.audit_id])
      assert.equal((await t.db.select().from(audits).where(eq(audits.id, id)))[0]!.createdByAdminId, eve.id);
    const usage = (await usageByUser(t.db, internalPrincipal())).rows.filter((r) => r.audits > 0);
    assert.deepEqual(
      usage.map((r) => [r.user_kind, r.user, r.audits, r.websites]),
      [['admin', 'eve@example.com', 2, 2]],
    );

    // A new key switches the old one off; other people's keys and service keys are left alone.
    const service = await createApiKey(t.db, { name: 'svc-keep', scopes: ['audits:read'] });
    const second = await createPersonalMcpKey(t.db, session);
    assert.equal(second.replaced, 1);
    await assert.rejects(authenticateApiKey(t.db, `Bearer ${first.key}`), code('unauthorized'));
    assert.ok(await authenticateApiKey(t.db, `Bearer ${second.key}`));
    assert.ok(await authenticateApiKey(t.db, `Bearer ${service.key}`));

    // Only a logged-in person can make one; a disabled person's key stops at once.
    await assert.rejects(createPersonalMcpKey(t.db, viaKey), code('forbidden'));
    await t.db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.id, eve.id));
    await assert.rejects(authenticateApiKey(t.db, `Bearer ${second.key}`), code('unauthorized'));
  },
);
