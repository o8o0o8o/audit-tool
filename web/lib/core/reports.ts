import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { artifacts, audits } from '../../db/schema';
import { CoreError } from './errors';
import { requireScope, type Principal } from './principal';
import { signToken, verifyToken } from './tokens';

export const REPORT_TOKEN_TTL_SECONDS = 3600;

export const REPORT_KINDS = {
  html: 'report_html',
  md: 'report_md',
  pdf: 'report_pdf',
  verified_md: 'report_verified_md',
  verified_pdf: 'report_verified_pdf',
  content_research_md: 'content_research_md',
  content_research_pdf: 'content_research_pdf',
  teaser_md: 'teaser_md',
  teaser_pdf: 'teaser_pdf',
} as const;
export type ReportKind = keyof typeof REPORT_KINDS;

export function makeReportToken(
  auditId: string,
  secret: string,
  nowMs = Date.now(),
  ttl = REPORT_TOKEN_TTL_SECONDS,
  /** Internal views may open an audit that did not succeed (a failed run's partial report). */
  anyStatus = false,
): string {
  return signToken('report', { aud: auditId, ...(anyStatus ? { any: true } : {}) }, secret, ttl, nowMs);
}

/** The audit a report token opens, or null when altered or expired. */
export function reportTokenAudit(token: string, secret: string, nowMs = Date.now()): string | null {
  return verifyToken<{ aud: string }>('report', token, secret, nowMs)?.aud ?? null;
}

/**
 * The audit a report token opens, checked against the audit's state: readers see only
 * `succeeded` audits, unless the token was made for an internal view.
 */
export async function reportTokenTarget(
  db: Db,
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<string | null> {
  const claims = verifyToken<{ aud: string; any?: boolean }>('report', token, secret, nowMs);
  if (!claims?.aud) return null;
  const [audit] = await db.select({ status: audits.status }).from(audits).where(eq(audits.id, claims.aud));
  if (!audit || (audit.status !== 'succeeded' && !claims.any)) return null;
  return claims.aud;
}

/** Kinds a report link never serves: raw run data and gate evidence stay behind the API. */
const NOT_SERVED = new Set(['raw_archive', 'gate_evidence', 'model', 'other']);

/** May a report link serve this file now? Not a hidden kind, not past its expiry. */
export function servedByReportLink(art: { kind: string; expiresAt: Date | null }, nowMs = Date.now()): boolean {
  return !NOT_SERVED.has(art.kind) && (!art.expiresAt || art.expiresAt.getTime() > nowMs);
}

/** Report tokens are made only after checking the caller (§7). */
export async function reportUrl(
  db: Db,
  principal: Principal,
  input: { audit_id: string; kind: ReportKind },
  cfg: { appUrl: string; secret: string },
  nowMs = Date.now(),
): Promise<{ url: string; expires_at: string; kind: ReportKind }> {
  requireScope(principal, 'audits:read');
  const id = z.uuid().parse(input.audit_id);
  const [audit] = await db.select({ id: audits.id, status: audits.status }).from(audits).where(eq(audits.id, id));
  if (!audit) throw new CoreError('not_found', 'audit not found');
  const internal = principal.kind === 'internal';
  if (audit.status !== 'succeeded' && !internal) throw new CoreError('audit_not_ready', 'the audit has not finished');
  const art = await findArtifactByKind(db, id, REPORT_KINDS[input.kind]);
  if (!art) throw new CoreError('not_generated', `no ${input.kind} report for this audit`);
  const token = makeReportToken(id, cfg.secret, nowMs, REPORT_TOKEN_TTL_SECONDS, internal);
  const path = input.kind === 'html' ? 'report.html' : `a/${art.id}`;
  return {
    url: `${cfg.appUrl}/r/${token}/${path}`,
    expires_at: new Date(nowMs + REPORT_TOKEN_TTL_SECONDS * 1000).toISOString(),
    kind: input.kind,
  };
}

export async function findArtifactByKind(db: Db, auditId: string, kind: string) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.auditId, auditId), eq(artifacts.kind, kind), isNull(artifacts.deletedAt)))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  return row ?? null;
}

/** An artifact by id, only when it belongs to `auditId` (a token never opens another audit's file). */
export async function findAuditArtifact(db: Db, auditId: string, artifactId: string) {
  if (!z.uuid().safeParse(artifactId).success) return null;
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.auditId, auditId), isNull(artifacts.deletedAt)));
  return row ?? null;
}

/**
 * A file named by its path inside the run folder (the reports link screenshots and other reports
 * relatively). Only artifacts of this audit's current attempt; `..` and odd characters refused.
 */
export async function findArtifactByPath(db: Db, auditId: string, segments: string[]) {
  if (!segments.length || !segments.every((s) => /^[A-Za-z0-9._@-]+$/.test(s) && s !== '.' && s !== '..')) return null;
  const [audit] = await db.select({ attempt: audits.currentAttempt }).from(audits).where(eq(audits.id, auditId));
  if (!audit) return null;
  const key = `audits/${auditId}/${audit.attempt}/${segments.join('/')}`;
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.auditId, auditId), eq(artifacts.blobKey, key), isNull(artifacts.deletedAt)));
  if (row) return row;
  // An imported run keeps its own attempt number in the key.
  const [any] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.auditId, auditId),
        like(artifacts.blobKey, `audits/${auditId}/%/${segments.join('/')}`),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1);
  return any ?? null;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  gz: 'application/gzip',
};

export const contentTypeFor = (key: string) =>
  TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Headers every report/file response carries (§7): sandbox, no referrer, no sniffing. */
export const REPORT_HEADERS = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'private, max-age=300',
} as const;
