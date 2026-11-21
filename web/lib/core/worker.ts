/**
 * The worker side of the app (§3 "Worker auth"): register binds a run to an attempt and returns a
 * session token; every later call names the attempt by that session. A call from an attempt that is
 * no longer current, or for an audit that has ended, gets `stale_attempt` (409) and the worker stops.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { artifacts, auditAttempts, audits, sites } from '../../db/schema';
import type { FileStore, WorkerIdentity } from '../platform/types';
import { CoreError } from './errors';
import { checkGuard } from './guard';
import { addAlias, registrableDomainOf } from './sites';
import { randomToken, sha256Hex } from './tokens';

export const RegisterInput = z.object({
  audit_id: z.uuid(),
  attempt: z.number().int().positive(),
  nonce: z.string().min(8),
});

export interface WorkerSession {
  auditId: string;
  attempt: number;
}

export async function registerWorker(
  db: Db,
  identity: WorkerIdentity,
  token: string | null,
  raw: unknown,
  now = new Date(),
) {
  const input = RegisterInput.parse(raw);
  const claims = token ? await identity.verify(token) : null;
  if (!claims) throw new CoreError('unauthorized', 'worker identity not valid');
  if ((claims.id && claims.id !== input.audit_id) || (claims.attempt && claims.attempt !== input.attempt)) {
    throw new CoreError('unauthorized', 'identity was issued for another run');
  }
  const session = randomToken(32);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ audit: audits, attempt: auditAttempts })
      .from(auditAttempts)
      .innerJoin(audits, eq(audits.id, auditAttempts.auditId))
      .where(and(eq(auditAttempts.auditId, input.audit_id), eq(auditAttempts.attempt, input.attempt)))
      .for('update');
    if (!row || row.attempt.dispatchNonce !== input.nonce) throw new CoreError('unauthorized', 'nonce does not match');
    if (row.audit.currentAttempt !== input.attempt || row.audit.status !== 'dispatched')
      throw new CoreError('stale_attempt', 'attempt is not current');
    if (row.attempt.registeredAt) throw new CoreError('conflict', 'attempt already registered');
    await tx
      .update(auditAttempts)
      .set({
        registeredAt: now,
        heartbeatAt: now,
        sessionHash: sha256Hex(session),
        ghRunId: Number(claims.runId),
        ghRunAttempt: claims.runAttempt,
        status: 'running',
      })
      .where(and(eq(auditAttempts.auditId, input.audit_id), eq(auditAttempts.attempt, input.attempt)));
    await tx
      .update(audits)
      .set({ status: 'running', startedAt: row.audit.startedAt ?? now, phase: 'starting', progressAt: now })
      .where(eq(audits.id, input.audit_id));
    return row.audit;
  });
  const [site] = await db.select({ host: sites.host }).from(sites).where(eq(sites.id, result.siteId));
  return {
    session,
    audit: {
      audit_id: result.id,
      attempt: input.attempt,
      mode: result.mode,
      target_url: result.targetUrl,
      host: site?.host ?? '',
      profile: result.profile,
      options: result.options,
      source: result.source,
      resume_from_attempt: input.attempt > 1 ? input.attempt - 1 : null,
    },
  };
}

/** Resolves a session token to its attempt; refuses an old attempt or an ended audit. */
export async function workerSession(db: Db, authorization: string | null | undefined): Promise<WorkerSession> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new CoreError('unauthorized', 'missing session');
  const [row] = await db
    .select({
      auditId: auditAttempts.auditId,
      attempt: auditAttempts.attempt,
      current: audits.currentAttempt,
      status: audits.status,
    })
    .from(auditAttempts)
    .innerJoin(audits, eq(audits.id, auditAttempts.auditId))
    .where(eq(auditAttempts.sessionHash, sha256Hex(token)));
  if (!row) throw new CoreError('unauthorized', 'unknown session');
  if (row.attempt !== row.current || !['running', 'dispatched'].includes(row.status)) {
    throw new CoreError('stale_attempt', 'this attempt is no longer current');
  }
  return { auditId: row.auditId, attempt: row.attempt };
}

export async function heartbeat(db: Db, s: WorkerSession, now = new Date()): Promise<void> {
  await db
    .update(auditAttempts)
    .set({ heartbeatAt: now })
    .where(and(eq(auditAttempts.auditId, s.auditId), eq(auditAttempts.attempt, s.attempt)));
}

export const PHASES = [
  'starting',
  'restore',
  'crawl',
  'site-checks',
  'fingerprint',
  'gate',
  'report',
  'phase2',
  'verify',
  'content-research',
  'pdf',
  'build',
  'upload',
] as const;

export const ProgressInput = z.object({
  processed: z.number().int().min(0).nullish(),
  total: z.number().int().min(0).nullish(),
  phase: z.enum(PHASES).nullish(),
});

export async function reportProgress(db: Db, s: WorkerSession, raw: unknown, now = new Date()): Promise<void> {
  const p = ProgressInput.parse(raw);
  await db
    .update(audits)
    .set({
      ...(p.processed != null ? { pagesProcessed: p.processed } : {}),
      ...(p.total != null ? { pagesTotal: p.total } : {}),
      ...(p.phase ? { phase: p.phase } : {}),
      progressAt: now,
    })
    .where(eq(audits.id, s.auditId));
  await heartbeat(db, s, now);
}

export const ARTIFACT_KINDS = [
  'report_html',
  'report_md',
  'report_pdf',
  'report_verified_md',
  'report_verified_pdf',
  'content_research_md',
  'content_research_pdf',
  'teaser_md',
  'teaser_pdf',
  'screenshot',
  'evidence',
  'gate_evidence',
  'raw_archive',
] as const;

const ArtifactInput = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  key: z.string().min(1),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  page_url: z.string().nullish(),
});

export const StatusInput = z.object({
  status: z.enum(['running', 'built', 'succeeded', 'failed', 'cancelled']),
  phase: z.enum(PHASES).nullish(),
  error: z.string().max(2000).nullish(),
  tool_version: z.string().max(40).nullish(),
  model_version: z.string().max(40).nullish(),
  artifacts: z.array(ArtifactInput).max(20000).nullish(),
});

/** Retention (§9): screenshots, other evidence and PDFs expire by source; text never. */
export function artifactExpiry(kind: string, source: string, now: Date): Date | null {
  const expiring = kind === 'screenshot' || kind === 'evidence' || kind.endsWith('_pdf');
  if (!expiring) return null;
  const days = source === 'public' ? 30 : source === 'internal' ? null : 180;
  return days === null ? null : new Date(now.getTime() + days * 86400_000);
}

export async function reportStatus(
  db: Db,
  s: WorkerSession,
  raw: unknown,
  hooks: { onFinished?: (auditId: string) => Promise<void> } = {},
  now = new Date(),
): Promise<{ status: string }> {
  const input = StatusInput.parse(raw);
  const [audit] = await db.select().from(audits).where(eq(audits.id, s.auditId));
  if (!audit) throw new CoreError('not_found');
  const prefix = `audits/${s.auditId}/${s.attempt}/`;
  if (input.artifacts?.length) {
    const bad = input.artifacts.find((a) => !a.key.startsWith(prefix));
    if (bad) throw new CoreError('invalid_input', `artifact key outside ${prefix}: ${bad.key}`);
    await db.delete(artifacts).where(
      and(
        eq(artifacts.auditId, s.auditId),
        inArray(
          artifacts.blobKey,
          input.artifacts.map((a) => a.key),
        ),
      ),
    );
    for (let i = 0; i < input.artifacts.length; i += 1000) {
      await db.insert(artifacts).values(
        input.artifacts.slice(i, i + 1000).map((a) => ({
          auditId: s.auditId,
          kind: a.kind,
          blobKey: a.key,
          bytes: a.bytes,
          sha256: a.sha256,
          pageUrl: a.page_url ?? null,
          createdAt: now,
          expiresAt: artifactExpiry(a.kind, audit.source, now),
        })),
      );
    }
  }
  const terminal = input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled';
  // Guarded write: a cancel or the reaper may have ended this attempt since the session check.
  const written = await db
    .update(audits)
    .set({
      status: input.status,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.error !== undefined ? { error: input.error ?? null } : {}),
      ...(input.tool_version ? { toolVersion: input.tool_version } : {}),
      ...(input.model_version ? { modelVersion: input.model_version } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      progressAt: now,
    })
    .where(
      and(
        eq(audits.id, s.auditId),
        eq(audits.currentAttempt, s.attempt),
        inArray(audits.status, ['running', 'dispatched']),
      ),
    )
    .returning({ id: audits.id });
  if (!written.length) throw new CoreError('stale_attempt', 'this attempt is no longer current');
  await db
    .update(auditAttempts)
    .set({ status: input.status, heartbeatAt: now })
    .where(and(eq(auditAttempts.auditId, s.auditId), eq(auditAttempts.attempt, s.attempt)));
  if (terminal) await hooks.onFinished?.(s.auditId);
  return { status: input.status };
}

export type UploadArea = 'audit' | 'checkpoint';

export async function issueWorkerUpload(files: FileStore, s: WorkerSession, area: UploadArea, ttlSeconds = 3600) {
  const prefix = area === 'audit' ? `audits/${s.auditId}/${s.attempt}/` : `checkpoints/${s.auditId}/${s.attempt}/`;
  return { prefix, ...(await files.issueUpload(prefix, ttlSeconds)) };
}

/**
 * Asked by the worker when the homepage lands on another registrable domain, before it loads
 * anything else. Allowed: the host becomes an alias of the site (reason `redirect`).
 */
export async function workerGuard(db: Db, s: WorkerSession, rawHost: unknown) {
  const host = z.string().min(1).max(253).parse(rawHost).toLowerCase();
  const result = await checkGuard(db, host);
  if (result.allowed) {
    const [audit] = await db
      .select({ siteId: audits.siteId, host: sites.host })
      .from(audits)
      .innerJoin(sites, eq(sites.id, audits.siteId))
      .where(eq(audits.id, s.auditId));
    if (audit && audit.host !== host && registrableDomainOf(host) !== registrableDomainOf(audit.host)) {
      await addAlias(db, host, audit.siteId, 'redirect');
    }
  }
  return result;
}

/** The newest snapshot manifest among this audit's earlier attempts, for a resumed run. */
export async function latestSnapshot(
  files: FileStore,
  s: WorkerSession,
): Promise<{ attempt: number; manifest: unknown } | null> {
  for (let a = s.attempt - 1; a >= 1; a--) {
    const got = await files.get(`checkpoints/${s.auditId}/${a}/manifest.json`);
    if (got) return { attempt: a, manifest: JSON.parse(await new Response(got.body).text()) };
  }
  return null;
}

/** A snapshot object of an earlier attempt of the same audit, by content hash. */
export async function snapshotObject(files: FileStore, s: WorkerSession, attempt: number, sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha) || attempt < 1 || attempt >= s.attempt) throw new CoreError('invalid_input');
  const got = await files.get(`checkpoints/${s.auditId}/${attempt}/objects/${sha}`);
  if (!got) throw new CoreError('not_found');
  return got;
}
