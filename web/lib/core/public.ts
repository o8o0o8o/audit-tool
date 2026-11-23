/**
 * The public site's side of the platform (design §7 "Public /"): a visitor starts a quick scan or a
 * single-page audit with no options, and sees only audits the public site started.
 *
 * Order of checks: the bot check when one is configured (no database is touched for a request that
 * fails it), the target
 * and the scan guard, a repeat of the same target (which returns the audit that exists and costs
 * nothing), the global caps on open public audits and on audits per day, the limit per address. The audit runs with the
 * `public` profile, so it is passive and has neither the secrets scan nor the takeover check.
 */
import { and, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { audits, sites } from '../../db/schema';
import { startAudit } from './audits';
import { CoreError } from './errors';
import { checkGuard } from './guard';
import { internalPrincipal } from './principal';
import { takeRate } from './rate';
import { isPrivateHost, normalizeTarget } from './sites';
import { sha256Hex } from './tokens';

export const PUBLIC_LIMITS = {
  /** New scans one address may start per hour. */
  perIpPerHour: 3,
  /** Public audits queued or running at once, over all visitors. */
  openAudits: 5,
  /** A repeat of the same target within this long returns the audit that exists. */
  sameTargetMs: 24 * 3600_000,
  /** Single-page audits of one domain per day (different pages). */
  pagesPerDomainPerDay: 5,
  /** New public audits in 24 hours, over all visitors: the backstop when addresses are rotated. */
  perDay: 100,
};

const OPEN = ['queued', 'dispatched', 'running', 'built', 'loading', 'stalled'];

export type BotCheck = (token: string, ip: string) => Promise<boolean>;

/**
 * Is the public site switched on? With both Turnstile keys, or with `PUBLIC_SCANS=on`, which opens it
 * without a bot check (decided 2026-11-23 for the first deployment): the limits below are then the
 * only protection.
 */
export function publicScansOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.PUBLIC_SCANS === 'on' || botCheckConfigured(env);
}

export function botCheckConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY;
}

/** The bot check of this deployment: Turnstile when its keys are set, otherwise none. */
export function botCheckFromEnv(env: Record<string, string | undefined> = process.env): BotCheck {
  return botCheckConfigured(env) ? turnstileCheck(env.TURNSTILE_SECRET_KEY!) : async () => true;
}

/** Cloudflare Turnstile's server-side check of the token the widget gave the visitor. */
export function turnstileCheck(secret: string, fetchFn: typeof fetch = fetch): BotCheck {
  return async (token, ip) => {
    if (!token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret, response: token });
    if (ip && ip !== 'direct') body.set('remoteip', ip);
    try {
      const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      return ((await res.json()) as { success?: boolean }).success === true;
    } catch {
      return false;
    }
  };
}

const Input = z.object({
  url: z.string().min(1).max(2000),
  mode: z.enum(['quick', 'page']),
  token: z.string().max(4096).default(''),
});

/** What a visitor is told when a site is on the do-not-scan list: nothing about why. */
const CANNOT_SCAN = "This site can't be scanned.";

export async function startPublicScan(
  db: Db,
  raw: unknown,
  ctx: {
    ip: string;
    botCheck: BotCheck;
    /** Keys the hash of the address in `rate_events`. */
    ipSecret: string;
    now?: Date;
    limits?: Partial<typeof PUBLIC_LIMITS>;
  },
): Promise<{ audit_id: string; reused: boolean }> {
  const input = Input.parse(raw);
  const now = ctx.now ?? new Date();
  const lim = { ...PUBLIC_LIMITS, ...ctx.limits };
  if (!(await ctx.botCheck(input.token, ctx.ip))) throw new CoreError('forbidden', 'The bot check failed. Try again.');

  const target = normalizeTarget(input.url, input.mode === 'page');
  if (process.env.PLATFORM_MODE !== 'local' && isPrivateHost(target.host))
    throw new CoreError('invalid_input', 'Enter the address of a public website.');
  if (!(await checkGuard(db, target.host)).allowed) throw new CoreError('forbidden', CANNOT_SCAN);

  // The same target again: the audit that exists, whoever asks. A quick scan is per domain, a page
  // audit per address.
  const since = new Date(now.getTime() - lim.sameTargetMs);
  const sameDomain = and(
    eq(audits.source, 'public'),
    eq(audits.mode, input.mode),
    eq(sites.registrableDomain, target.registrableDomain),
    gt(audits.createdAt, since),
    notInArray(audits.status, ['failed', 'cancelled']),
  );
  const [existing] = await db
    .select({ id: audits.id })
    .from(audits)
    .innerJoin(sites, eq(sites.id, audits.siteId))
    .where(input.mode === 'page' ? and(sameDomain, eq(audits.targetUrl, target.url)) : sameDomain)
    .orderBy(desc(audits.createdAt))
    .limit(1);
  if (existing) return { audit_id: existing.id, reused: true };

  if (input.mode === 'page') {
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(audits)
      .innerJoin(sites, eq(sites.id, audits.siteId))
      .where(sameDomain);
    if ((n?.n ?? 0) >= lim.pagesPerDomainPerDay)
      throw new CoreError('rate_limited', 'This site has had enough page audits for today. Try again tomorrow.');
  }
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(audits)
    .where(and(eq(audits.source, 'public'), inArray(audits.status, OPEN)));
  if ((open?.n ?? 0) >= lim.openAudits)
    throw new CoreError('rate_limited', 'Many scans are running right now. Try again in a few minutes.');
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(audits)
    .where(and(eq(audits.source, 'public'), gt(audits.createdAt, new Date(now.getTime() - 24 * 3600_000))));
  if ((today?.n ?? 0) >= lim.perDay)
    throw new CoreError('rate_limited', 'The free scans for today are used up. Try again tomorrow.');
  const bucket = `public:ip:${sha256Hex(`${ctx.ipSecret}:${ctx.ip}`).slice(0, 32)}`;
  if (!(await takeRate(db, bucket, lim.perIpPerHour, 3600_000, now)))
    throw new CoreError('rate_limited', 'You have started several scans in the last hour. Try again later.');

  try {
    // Fixed input: a visitor chooses the address and one of two modes, nothing else.
    const res = await startAudit(
      db,
      internalPrincipal('public-site'),
      { url: input.url, mode: input.mode },
      { now, source: 'public', profile: 'public' },
    );
    return { audit_id: res.audit_id, reused: res.reused !== null };
  } catch (err) {
    if (err instanceof CoreError && err.code === 'do_not_contact') throw new CoreError('forbidden', CANNOT_SCAN);
    throw err;
  }
}

export interface PublicScanView {
  audit_id: string;
  mode: 'quick' | 'page';
  target: string;
  /** `running` covers every state before the end, so a visitor sees no internals. */
  status: 'running' | 'succeeded' | 'failed';
  processed: number | null;
  total: number | null;
  created_at: string;
  finished_at: string | null;
}

/** A public audit by its id; null for any other id, including audits of other sources. */
export async function publicScanView(db: Db, auditId: string): Promise<PublicScanView | null> {
  if (!z.uuid().safeParse(auditId).success) return null;
  const [a] = await db
    .select()
    .from(audits)
    .where(and(eq(audits.id, auditId), eq(audits.source, 'public')));
  if (!a) return null;
  return {
    audit_id: a.id,
    mode: a.mode === 'page' ? 'page' : 'quick',
    target: a.targetUrl,
    status:
      a.status === 'succeeded' ? 'succeeded' : a.status === 'failed' || a.status === 'cancelled' ? 'failed' : 'running',
    processed: a.pagesProcessed,
    total: a.pagesTotal,
    created_at: a.createdAt.toISOString(),
    finished_at: a.finishedAt ? a.finishedAt.toISOString() : null,
  };
}
