/** Route-handler glue: database, platform, principal from the request, finish hooks. Server only. */
import { raiseWork } from './core/cron-gate';
import { cookies } from 'next/headers';
import { getDb, type Db } from '../db/client';
import { getPlatform } from './platform';
import type { Platform } from './platform/types';
import { activeSessionPrincipal, authenticateApiKey, SESSION_COOKIE } from './core/auth';
import { CoreError, errorResponse } from './core/errors';
import type { Principal } from './core/principal';
import { sessionKeyFromEnv } from './core/tokens';
import { onAuditFinished } from './core/webhooks';
import { dispatchNext } from './core/queue';

export { errorResponse };

export function ctx(): { db: Db; platform: Platform } {
  return { db: getDb(), platform: getPlatform() };
}

export const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

export const onFinished = (auditId: string) => onAuditFinished(getDb(), auditId);

/** The internal session from the cookie, or null. */
export async function internalPrincipal(): Promise<Principal | null> {
  const jar = await cookies();
  return activeSessionPrincipal(getDb(), jar.get(SESSION_COOKIE)?.value, sessionKeyFromEnv());
}

export async function requireInternalPrincipal(): Promise<Principal> {
  const p = await internalPrincipal();
  if (!p) throw new CoreError('unauthorized', 'log in first');
  return p;
}

/** API key from `Authorization: Bearer`. */
export async function apiPrincipal(request: Request): Promise<Principal> {
  return authenticateApiKey(getDb(), request.headers.get('authorization'));
}

/** Dispatch right away when capacity is free (§3 "Queue"); the cron does it otherwise. */
export async function kickQueue(): Promise<void> {
  try {
    const { db, platform } = ctx();
    await raiseWork(platform.files);
    await dispatchNext(db, platform, { onFinished, max: 3 });
  } catch (err) {
    console.warn('dispatch from request failed; the cron will retry', err);
  }
}

/**
 * The caller's address for rate limits. Forwarded headers are believed only behind a proxy that
 * sets them itself (Vercel, or TRUST_PROXY=1); anywhere else the caller could write them, so
 * every direct caller shares one bucket.
 */
export function clientIp(request: Request): string {
  if (!process.env.VERCEL && process.env.TRUST_PROXY !== '1') return 'direct';
  return request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'direct';
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CoreError('invalid_input', 'request body must be JSON');
  }
}

/** Wraps a handler: CoreErrors and zod errors become JSON errors. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
      if (Array.isArray(issues)) {
        return Response.json(
          {
            error: 'invalid_input',
            message: issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '),
          },
          { status: 400 },
        );
      }
      return errorResponse(err);
    }
  };
}
