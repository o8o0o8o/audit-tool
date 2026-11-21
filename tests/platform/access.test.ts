import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { createTestDb, SKIP_DB, type TestDb } from './db-harness';
import { authenticateApiKey, createApiKey, login, revokeApiKey, sessionPrincipal } from '../../web/lib/core/auth';
import { requireScope } from '../../web/lib/core/principal';
import { getAudit } from '../../web/lib/core/audits';
import { CoreError } from '../../web/lib/core/errors';
import { SECRET } from './helpers';
import { signToken } from '../../web/lib/core/tokens';

const salt = randomBytes(16);
const HASH = `scrypt:${salt.toString('hex')}:${scryptSync('correct horse battery', salt, 64).toString('hex')}`;
let t: TestDb;
before(async () => {
  if (!SKIP_DB) t = await createTestDb();
});
after(async () => t?.close());

const code = (c: string) => (e: unknown) => e instanceof CoreError && e.code === c;

void test('a core call without a principal throws', { skip: SKIP_DB }, async () => {
  await assert.rejects(
    getAudit(t.db, undefined as never, '00000000-0000-4000-8000-000000000000'),
    code('unauthorized'),
  );
  assert.throws(() => requireScope(null, 'audits:read'), code('unauthorized'));
});

void test('login: the sixth wrong password is refused, even when right', { skip: SKIP_DB }, async () => {
  const cfg = { passwordHash: HASH, sessionSecret: SECRET };
  const now = new Date('2026-11-21T10:00:00Z');
  const cookie = await login(t.db, { password: 'correct horse battery', ip: '10.0.0.9' }, cfg, now);
  assert.equal(sessionPrincipal(cookie, SECRET, now.getTime())?.kind, 'internal');
  for (let i = 0; i < 5; i++)
    await assert.rejects(login(t.db, { password: 'nope', ip: '10.0.0.1' }, cfg, now), code('unauthorized'));
  await assert.rejects(
    login(t.db, { password: 'correct horse battery', ip: '10.0.0.1' }, cfg, now),
    code('rate_limited'),
  );
  // after the 15-minute window it works again
  const later = new Date(now.getTime() + 16 * 60_000);
  assert.ok(await login(t.db, { password: 'correct horse battery', ip: '10.0.0.1' }, cfg, later));
});

void test('a tampered or expired session cookie is refused', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  const cookie = signToken('session', { sub: 'internal' }, SECRET, 3600, now);
  assert.ok(sessionPrincipal(cookie, SECRET, now));
  const [body, sig] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'internal', typ: 'session', exp: 9999999999 })).toString(
    'base64url',
  );
  assert.equal(sessionPrincipal(`${forged}.${sig}`, SECRET, now), null);
  assert.equal(sessionPrincipal(`${body}.${sig!.slice(0, -1)}A`, SECRET, now), null);
  assert.equal(sessionPrincipal(cookie, SECRET, now + 2 * 3600_000), null);
  assert.equal(sessionPrincipal(signToken('report', { sub: 'internal' }, SECRET, 3600, now), SECRET, now), null);
});

void test('API keys: revoked key refused; the hourly limit returns rate_limited', { skip: SKIP_DB }, async () => {
  const { id, key } = await createApiKey(t.db, { name: 'k1', scopes: ['audits:read'], rateLimitPerHour: 2 });
  const p = await authenticateApiKey(t.db, `Bearer ${key}`);
  assert.equal(p.kind, 'client');
  await authenticateApiKey(t.db, `Bearer ${key}`);
  await assert.rejects(authenticateApiKey(t.db, `Bearer ${key}`), code('rate_limited'));
  await revokeApiKey(t.db, id);
  await assert.rejects(authenticateApiKey(t.db, `Bearer ${key}`), code('unauthorized'));
  await assert.rejects(authenticateApiKey(t.db, 'Bearer ak_unknown'), code('unauthorized'));
});
