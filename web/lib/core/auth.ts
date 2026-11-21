import { scryptSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { apiClients } from '../../db/schema';
import { CoreError } from './errors';
import { type Principal, type Scope } from './principal';
import { countRate, recordRate, takeRate } from './rate';
import { randomToken, safeEqual, sha256Hex, signToken, verifyToken } from './tokens';

export const SESSION_COOKIE = 'audit_session';
export const SESSION_TTL_SECONDS = 12 * 3600;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

/** Checks a password against `scrypt:<salt hex>:<hash hex>` (made by `yarn hash-password`). */
export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split(/[:$]/);
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const got = scryptSync(password, Buffer.from(saltHex, 'hex'), hashHex.length / 2).toString('hex');
  return safeEqual(got, hashHex);
}

export const ipBucket = (ip: string, secret: string) => `login:ip:${sha256Hex(`${secret}:${ip}`).slice(0, 32)}`;

/**
 * Internal login. Failed attempts are counted per IP (keyed hash); after 5 in 15 minutes every
 * attempt is refused, even with the right password, until the window passes.
 * Returns the session cookie value.
 */
export async function login(
  db: Db,
  input: { password: string; ip: string },
  cfg: { passwordHash: string | undefined; sessionSecret: string },
  now = new Date(),
): Promise<string> {
  if (!cfg.passwordHash) throw new CoreError('unauthorized', 'INTERNAL_PASSWORD_HASH is not set');
  const bucket = ipBucket(input.ip, cfg.sessionSecret);
  if ((await countRate(db, bucket, LOGIN_WINDOW_MS, now)) >= LOGIN_MAX_FAILURES) {
    throw new CoreError('rate_limited', 'too many failed logins; try again later');
  }
  if (!verifyPassword(input.password, cfg.passwordHash)) {
    await recordRate(db, bucket, now);
    throw new CoreError('unauthorized', 'wrong password');
  }
  return signToken('session', { sub: 'internal' }, cfg.sessionSecret, SESSION_TTL_SECONDS, now.getTime());
}

export function sessionPrincipal(
  cookie: string | undefined,
  sessionSecret: string,
  nowMs = Date.now(),
): Principal | null {
  if (!cookie) return null;
  const claims = verifyToken<{ sub: string }>('session', cookie, sessionSecret, nowMs);
  return claims?.sub === 'internal' ? { kind: 'internal', label: 'internal' } : null;
}

// ── API keys ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'ak_';

export async function createApiKey(
  db: Db,
  input: { name: string; scopes: Scope[]; rateLimitPerHour?: number; webhookUrl?: string | null },
): Promise<{ id: string; key: string; webhookSecret: string | null }> {
  const key = `${KEY_PREFIX}${randomToken(32)}`;
  const webhookSecret = input.webhookUrl ? randomToken(32) : null;
  const [row] = await db
    .insert(apiClients)
    .values({
      name: input.name,
      keyHash: sha256Hex(key),
      scopes: input.scopes,
      rateLimitPerHour: input.rateLimitPerHour ?? 60,
      webhookUrl: input.webhookUrl ?? null,
      webhookSecret,
    })
    .returning({ id: apiClients.id });
  return { id: row!.id, key, webhookSecret };
}

export async function revokeApiKey(db: Db, id: string, now = new Date()): Promise<void> {
  await db.update(apiClients).set({ revokedAt: now }).where(eq(apiClients.id, id));
}

/**
 * Bearer auth for MCP and REST. Refuses unknown and revoked keys; counts the call against the
 * client's `rate_limit_per_hour` through `rate_events`.
 */
export async function authenticateApiKey(
  db: Db,
  authorization: string | null | undefined,
  now = new Date(),
): Promise<Principal> {
  const key = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !key.startsWith(KEY_PREFIX)) throw new CoreError('unauthorized', 'missing or malformed API key');
  const [client] = await db
    .select()
    .from(apiClients)
    .where(eq(apiClients.keyHash, sha256Hex(key)));
  if (!client || client.revokedAt) throw new CoreError('unauthorized', 'invalid or revoked API key');
  if (!(await takeRate(db, `client:${client.id}`, client.rateLimitPerHour, 3600_000, now))) {
    throw new CoreError('rate_limited', `rate limit of ${client.rateLimitPerHour} calls per hour reached`);
  }
  return { kind: 'client', clientId: client.id, name: client.name, scopes: client.scopes as Scope[] };
}
