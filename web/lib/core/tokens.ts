import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** A random URL-safe secret (session tokens, API keys, nonces). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A compact signed token: base64url(JSON claims) + "." + HMAC-SHA256. `typ` keeps one kind of token
 * from being accepted as another; `exp` is in seconds.
 */
export function signToken(
  typ: string,
  claims: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  const body = Buffer.from(JSON.stringify({ ...claims, typ, exp: Math.floor(nowMs / 1000) + ttlSeconds })).toString(
    'base64url',
  );
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  typ: string,
  token: string,
  secret: string,
  nowMs = Date.now(),
): (T & { exp: number }) | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, createHmac('sha256', secret).update(body).digest('base64url'))) return null;
  let claims: T & { typ?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.typ !== typ || typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null;
  return claims as T & { exp: number };
}

/**
 * The key session cookies are signed with: the session secret bound to the password hash, so
 * changing the password ends every open session.
 */
export function sessionKeyFromEnv(): string {
  return sha256Hex(`${secretFromEnv('SESSION_SECRET')}:${process.env.INTERNAL_PASSWORD_HASH ?? ''}`);
}

export function secretFromEnv(name: 'SESSION_SECRET' | 'REPORT_TOKEN_SECRET' | 'LOCAL_WORKER_SECRET'): string {
  const v = process.env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set to at least 32 characters`);
  return v;
}
