/** Route-handler glue: database, platform, principal from the request, finish hooks. Server only. */
import { cookies } from 'next/headers';
import { getDb, type Db } from '../db/client';
import { getPlatform } from './platform';
import type { Platform } from './platform/types';
import { authenticateApiKey, SESSION_COOKIE, sessionPrincipal } from './core/auth';
import { CoreError, errorResponse } from './core/errors';
import type { Principal } from './core/principal';
import { secretFromEnv } from './core/tokens';
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
  return sessionPrincipal(jar.get(SESSION_COOKIE)?.value, secretFromEnv('SESSION_SECRET'));
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
    await dispatchNext(db, platform, { onFinished, max: 3 });
  } catch (err) {
    console.warn('dispatch from request failed; the cron will retry', err);
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '127.0.0.1'
  );
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
