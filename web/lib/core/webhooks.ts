import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { apiClients, audits, jobs, sites, webhookDeliveries } from '../../db/schema';
import { createHmac } from 'node:crypto';

/** Retry delays after a failed delivery (§5 "Webhooks"): 1 min, 5 min, 30 min, 2 h. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

/** Queues `audit.<status>` for the client that started the audit, when it has a webhook. */
export async function onAuditFinished(db: Db, auditId: string, now = new Date()): Promise<void> {
  const [row] = await db
    .select({
      status: audits.status,
      clientId: audits.createdByClientId,
      ref: audits.externalRef,
      url: apiClients.webhookUrl,
    })
    .from(audits)
    .leftJoin(apiClients, eq(apiClients.id, audits.createdByClientId))
    .where(eq(audits.id, auditId));
  if (!row?.clientId || !row.url || !['succeeded', 'failed', 'cancelled'].includes(row.status)) return;
  await db.insert(webhookDeliveries).values({
    clientId: row.clientId,
    auditId,
    event: `audit.${row.status}`,
    externalRef: row.ref,
    nextAttemptAt: now,
  });
}

/** Queues `pdf.ready` for every client in the job's `requested_by` that has a webhook. */
export async function onPdfReady(db: Db, jobId: string, now = new Date()): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return;
  for (const clientId of job.requestedBy) {
    const [c] = await db.select({ url: apiClients.webhookUrl }).from(apiClients).where(eq(apiClients.id, clientId));
    if (c?.url)
      await db
        .insert(webhookDeliveries)
        .values({ clientId, auditId: job.auditId, event: 'pdf.ready', kind: job.kind, nextAttemptAt: now });
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('::ffff:')) return isPrivateAddress(h.slice(7));
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface PostResult {
  status: number;
}

/**
 * Resolves the host, refuses private and local ranges (unless `allowPrivate`, local mode only),
 * sends to the address that was checked, and does not follow redirects.
 */
export async function postWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  allowPrivate: boolean,
): Promise<PostResult> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('webhook must be http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const address = isIP(host) ? host : (await lookup(host)).address;
  if (!allowPrivate && isPrivateAddress(address)) throw new Error(`webhook address ${address} is private`);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: 'POST',
        host: address,
        servername: isIP(host) ? undefined : host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        headers: {
          ...headers,
          host: u.host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Sends due deliveries, one row lock each so overlapping crons never double-send. */
export async function deliverDueWebhooks(
  db: Db,
  opts: { now?: Date; allowPrivate?: boolean; post?: typeof postWebhook; max?: number } = {},
): Promise<number> {
  const post = opts.post ?? postWebhook;
  let sent = 0;
  for (let i = 0; i < (opts.max ?? 50); i++) {
    const now = opts.now ?? new Date();
    const done = await db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(webhookDeliveries)
        .where(and(isNull(webhookDeliveries.deliveredAt), lte(webhookDeliveries.nextAttemptAt, now)))
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!d) return null;
      const [ctx] = await tx
        .select({
          url: apiClients.webhookUrl,
          secret: apiClients.webhookSecret,
          status: audits.status,
          mode: audits.mode,
          host: sites.host,
        })
        .from(apiClients)
        .innerJoin(audits, eq(audits.id, d.auditId))
        .innerJoin(sites, eq(sites.id, audits.siteId))
        .where(eq(apiClients.id, d.clientId));
      let status = 0;
      if (ctx?.url && ctx.secret) {
        const body = JSON.stringify({
          event: d.event,
          audit_id: d.auditId,
          domain: ctx.host,
          mode: ctx.mode,
          status: ctx.status,
          external_ref: d.externalRef,
          ...(d.kind ? { kind: d.kind } : {}),
        });
        const ts = String(Math.floor(now.getTime() / 1000));
        try {
          status = (
            await post(
              ctx.url,
              { 'X-Audit-Timestamp': ts, 'X-Audit-Signature': signWebhook(ctx.secret, ts, body) },
              body,
              !!opts.allowPrivate,
            )
          ).status;
        } catch (err) {
          console.warn(`webhook ${d.id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      const ok = status >= 200 && status < 300;
      const attempt = d.attempt + 1;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      await tx
        .update(webhookDeliveries)
        .set({
          attempt,
          statusCode: status || null,
          deliveredAt: ok ? now : null,
          nextAttemptAt: ok || delay === undefined || !ctx?.url ? null : new Date(now.getTime() + delay),
        })
        .where(eq(webhookDeliveries.id, d.id));
      return ok;
    });
    if (done === null) break;
    if (done) sent++;
  }
  return sent;
}

export const pendingDeliveries = (db: Db) =>
  db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(isNull(webhookDeliveries.deliveredAt));
