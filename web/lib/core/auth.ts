import { randomBytes, scryptSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { admins, apiClients } from '../../db/schema';
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

const LOGIN_ALL_BUCKET = 'login:all';
/** Failed logins from all addresses together, per window. */
const LOGIN_MAX_FAILURES_ALL = 30;

export const ipBucket = (ip: string, secret: string) => `login:ip:${sha256Hex(`${secret}:${ip}`).slice(0, 32)}`;

export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt:<salt hex>:<hash hex>` for a new password. */
export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Adds a person who can log in to /internal, or gives an existing one a new password and enables them. */
export async function upsertAdmin(
  db: Db,
  input: { email: string; name?: string | null; password: string },
): Promise<{ id: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('not an email address');
  const passwordHash = hashPassword(input.password);
  const [had] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email));
  if (had) {
    await db
      .update(admins)
      .set({ passwordHash, disabledAt: null, ...(input.name ? { name: input.name } : {}) })
      .where(eq(admins.id, had.id));
    return { id: had.id, created: false };
  }
  const [row] = await db
    .insert(admins)
    .values({ email, name: input.name ?? null, passwordHash })
    .returning({ id: admins.id });
  return { id: row!.id, created: true };
}

/** A hash no password matches, checked when the email is unknown so both cases take the same time. */
const NO_ADMIN_HASH = `scrypt:${'00'.repeat(16)}:${'00'.repeat(64)}`;

/**
 * Internal login. With an email: that person's password, and the session names them. Without one:
 * the shared `INTERNAL_PASSWORD_HASH`, accepted only while the `admins` table is empty, so that once
 * people exist every session belongs to one of them. Failed attempts are counted per IP (keyed
 * hash); after 5 in 15 minutes every attempt is refused, even with the right password, until the
 * window passes. Returns the session cookie value.
 */
export async function login(
  db: Db,
  input: { email?: string; password: string; ip: string },
  cfg: { passwordHash: string | undefined; sessionSecret: string },
  now = new Date(),
): Promise<string> {
  const email = input.email ? normalizeEmail(input.email) : '';
  const bucket = ipBucket(input.ip, cfg.sessionSecret);
  // Count, check and record under one lock, so parallel guesses cannot each see "4 so far".
  // The overall bucket stops guessing from many addresses.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rate:login'))`);
    if (
      (await countRate(tx, bucket, LOGIN_WINDOW_MS, now)) >= LOGIN_MAX_FAILURES ||
      (await countRate(tx, LOGIN_ALL_BUCKET, LOGIN_WINDOW_MS, now)) >= LOGIN_MAX_FAILURES_ALL
    )
      return 'limited' as const;
    if (email) {
      const [admin] = await tx.select().from(admins).where(eq(admins.email, email));
      const usable = admin && !admin.disabledAt ? admin : null;
      if (verifyPassword(input.password, usable?.passwordHash ?? NO_ADMIN_HASH) && usable) {
        await tx.update(admins).set({ lastLoginAt: now }).where(eq(admins.id, usable.id));
        return { admin: usable.id, email: usable.email };
      }
    } else {
      const [anyAdmin] = await tx.select({ id: admins.id }).from(admins).limit(1);
      if (anyAdmin) return 'need_email' as const;
      if (!cfg.passwordHash) return 'not_set' as const;
      if (verifyPassword(input.password, cfg.passwordHash)) return {};
    }
    await recordRate(tx, bucket, now);
    await recordRate(tx, LOGIN_ALL_BUCKET, now);
    return 'wrong' as const;
  });
  if (outcome === 'limited') throw new CoreError('rate_limited', 'too many failed logins; try again later');
  if (outcome === 'need_email') throw new CoreError('unauthorized', 'log in with your email and password');
  if (outcome === 'not_set') throw new CoreError('unauthorized', 'INTERNAL_PASSWORD_HASH is not set');
  if (outcome === 'wrong') throw new CoreError('unauthorized', email ? 'wrong email or password' : 'wrong password');
  return signToken('session', { sub: 'internal', ...outcome }, cfg.sessionSecret, SESSION_TTL_SECONDS, now.getTime());
}

export function sessionPrincipal(
  cookie: string | undefined,
  sessionSecret: string,
  nowMs = Date.now(),
): Principal | null {
  if (!cookie) return null;
  const claims = verifyToken<{ sub: string; admin?: string; email?: string }>('session', cookie, sessionSecret, nowMs);
  if (claims?.sub !== 'internal') return null;
  return claims.admin && claims.email
    ? { kind: 'internal', label: `admin:${claims.email}`, adminId: claims.admin }
    : { kind: 'internal', label: 'internal' };
}

const revokedBucket = (cookie: string) => `session:revoked:${sha256Hex(cookie).slice(0, 40)}`;

/**
 * Logout ends the session on the server too: the cookie's hash is kept until the cookie would
 * have expired anyway (rate events live 24 h, a session 12 h), so a copied cookie stops working.
 */
export async function revokeSession(db: Db, cookie: string | undefined, now = new Date()): Promise<void> {
  if (cookie) await recordRate(db, revokedBucket(cookie), now);
}

/** The session behind a cookie, unless it is invalid, expired or was logged out. */
export async function activeSessionPrincipal(
  db: Db,
  cookie: string | undefined,
  sessionSecret: string,
  now = new Date(),
): Promise<Principal | null> {
  const principal = sessionPrincipal(cookie, sessionSecret, now.getTime());
  if (!principal || !cookie) return null;
  const revoked = await countRate(db, revokedBucket(cookie), SESSION_TTL_SECONDS * 1000, now);
  return revoked > 0 ? null : principal;
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
