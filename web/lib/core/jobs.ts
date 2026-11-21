/**
 * PDF jobs (design §2 "PDFs: only on request", task 2.8): `request_pdf` queues a `render-pdf` job, a
 * second request for the same audit and kind joins it. The job runs on a worker that registers and
 * heartbeats like an audit attempt, bound to the `jobs` row.
 */
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { artifacts, audits, jobs } from '../../db/schema';
import type { Platform, WorkerIdentity } from '../platform/types';
import { CoreError } from './errors';
import { requireScope, type Principal } from './principal';
import { findArtifactByKind } from './reports';
import { randomToken, sha256Hex } from './tokens';
import { artifactExpiry } from './worker';

/** PDF kinds and the Markdown each is printed from. */
export const PDF_SOURCES = {
  pdf: { md: 'report_md', pdf: 'report_pdf', file: 'audit-report.md' },
  verified_pdf: { md: 'report_verified_md', pdf: 'report_verified_pdf', file: 'audit-report.verified.md' },
  content_research_pdf: { md: 'content_research_md', pdf: 'content_research_pdf', file: 'content-research-report.md' },
  teaser_pdf: { md: 'teaser_md', pdf: 'teaser_pdf', file: 'lead/teaser.md' },
} as const;
export type PdfKind = keyof typeof PDF_SOURCES;
export const PdfKindSchema = z.enum(['pdf', 'verified_pdf', 'content_research_pdf', 'teaser_pdf']);

export async function requestPdf(
  db: Db,
  principal: Principal,
  raw: { audit_id: string; kind: string },
): Promise<{ status: 'queued' | 'ready'; job_id: string | null }> {
  requireScope(principal, 'audits:pdf');
  const auditId = z.uuid().parse(raw.audit_id);
  const kind = PdfKindSchema.parse(raw.kind);
  const [audit] = await db.select({ status: audits.status }).from(audits).where(eq(audits.id, auditId));
  if (!audit) throw new CoreError('not_found', 'audit not found');
  if (audit.status !== 'succeeded') throw new CoreError('audit_not_ready', 'the audit has not finished');
  if (await findArtifactByKind(db, auditId, PDF_SOURCES[kind].pdf)) return { status: 'ready', job_id: null };
  if (!(await findArtifactByKind(db, auditId, PDF_SOURCES[kind].md)))
    throw new CoreError('not_generated', `no Markdown for ${kind} in this audit`);
  const clientId = principal.kind === 'client' ? principal.clientId : null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`job:${auditId}:${kind}`}))`);
    const [open] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'render-pdf'),
          eq(jobs.auditId, auditId),
          eq(jobs.kind, kind),
          inArray(jobs.status, ['queued', 'dispatched', 'running']),
        ),
      );
    if (open) {
      if (clientId && !open.requestedBy.includes(clientId)) {
        await tx
          .update(jobs)
          .set({ requestedBy: [...open.requestedBy, clientId] })
          .where(eq(jobs.id, open.id));
      }
      return { status: 'queued' as const, job_id: open.id };
    }
    const [row] = await tx
      .insert(jobs)
      .values({ type: 'render-pdf', auditId, kind, status: 'queued', requestedBy: clientId ? [clientId] : [] })
      .returning({ id: jobs.id });
    return { status: 'queued' as const, job_id: row!.id };
  });
}

export const JOB_LIMITS = { silentMs: 20 * 60_000, maxTries: 3 };

/**
 * A job whose worker died (or never registered) goes back to the queue, and fails after
 * `maxTries`, so dead jobs neither fill the two slots nor block a new request for that PDF.
 */
export async function reapJobs(
  db: Db,
  dispatcher?: Pick<Platform['dispatcher'], 'cancel'>,
  now = new Date(),
): Promise<{ requeued: string[]; failed: string[] }> {
  const out = { requeued: [] as string[], failed: [] as string[] };
  const silent = await db
    .select({ id: jobs.id, tries: jobs.tries, status: jobs.status })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ['dispatched', 'running']),
        lt(jobs.heartbeatAt, new Date(now.getTime() - JOB_LIMITS.silentMs)),
      ),
    );
  for (const j of silent) {
    const give = j.tries >= JOB_LIMITS.maxTries;
    const done = await db
      .update(jobs)
      .set(
        give
          ? { status: 'failed', finishedAt: now, sessionHash: null, dispatchNonce: null }
          : { status: 'queued', sessionHash: null, dispatchNonce: null },
      )
      .where(and(eq(jobs.id, j.id), eq(jobs.status, j.status), eq(jobs.tries, j.tries)))
      .returning({ id: jobs.id });
    if (!done.length) continue;
    await dispatcher?.cancel(j.id, j.tries).catch(() => {});
    (give ? out.failed : out.requeued).push(j.id);
  }
  return out;
}

export async function dispatchJobs(db: Db, platform: Pick<Platform, 'dispatcher'>, max = 2): Promise<string[]> {
  const out: string[] = [];
  await reapJobs(db, platform.dispatcher);
  for (let i = 0; i < max; i++) {
    const picked = await db.transaction(async (tx) => {
      const busy = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(inArray(jobs.status, ['dispatched', 'running']));
      if ((busy[0]?.n ?? 0) >= max) return null;
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.status, 'queued'))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return null;
      const nonce = randomToken(18);
      await tx
        .update(jobs)
        .set({ status: 'dispatched', dispatchNonce: nonce, tries: job.tries + 1, heartbeatAt: new Date() })
        .where(eq(jobs.id, job.id));
      return { ...job, nonce, attempt: job.tries + 1 };
    });
    if (!picked) break;
    try {
      await platform.dispatcher.dispatch({
        kind: 'render-pdf',
        id: picked.id,
        attempt: picked.attempt,
        nonce: picked.nonce,
        inputs: { audit_id: picked.auditId, kind: picked.kind },
      });
      out.push(picked.id);
    } catch (err) {
      await db.update(jobs).set({ status: 'queued' }).where(eq(jobs.id, picked.id));
      console.warn('job dispatch failed', err);
      break;
    }
  }
  return out;
}

// ── The job worker's side ────────────────────────────────────────────────────

export interface JobSession {
  jobId: string;
  auditId: string;
  attempt: number;
  kind: PdfKind;
}

export async function registerJob(db: Db, identity: WorkerIdentity, token: string | null, raw: unknown) {
  const input = z
    .object({ job_id: z.uuid(), attempt: z.number().int().positive(), nonce: z.string().min(8) })
    .parse(raw);
  const claims = token ? await identity.verify(token) : null;
  if (!claims || (claims.id && claims.id !== input.job_id))
    throw new CoreError('unauthorized', 'worker identity not valid');
  const session = randomToken(32);
  // One statement checks and spends the nonce, so two registrations cannot both pass.
  const [job] = await db
    .update(jobs)
    .set({
      status: 'running',
      dispatchNonce: null,
      sessionHash: sha256Hex(session),
      ghRunId: Number(claims.runId),
      ghRunAttempt: claims.runAttempt,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(jobs.id, input.job_id),
        eq(jobs.dispatchNonce, input.nonce),
        eq(jobs.status, 'dispatched'),
        eq(jobs.tries, input.attempt),
      ),
    )
    .returning();
  if (!job) throw new CoreError('unauthorized', 'job is not waiting for this run');
  const [audit] = await db.select({ attempt: audits.currentAttempt }).from(audits).where(eq(audits.id, job.auditId));
  const src = PDF_SOURCES[job.kind as PdfKind];
  const files = await db
    .select({ key: artifacts.blobKey, kind: artifacts.kind })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.auditId, job.auditId),
        inArray(artifacts.kind, [src.md, 'screenshot']),
        sql`${artifacts.deletedAt} is null`,
      ),
    );
  return {
    session,
    job: {
      job_id: job.id,
      audit_id: job.auditId,
      kind: job.kind,
      audit_attempt: audit?.attempt ?? 1,
      markdown: src.file,
      files,
    },
  };
}

export async function jobSession(db: Db, authorization: string | null | undefined): Promise<JobSession | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.sessionHash, sha256Hex(token)));
  if (!job) return null;
  if (job.status !== 'running') throw new CoreError('stale_attempt', 'job has ended');
  const [audit] = await db.select({ attempt: audits.currentAttempt }).from(audits).where(eq(audits.id, job.auditId));
  return { jobId: job.id, auditId: job.auditId, attempt: audit?.attempt ?? 1, kind: job.kind as PdfKind };
}

export async function finishJob(
  db: Db,
  s: JobSession,
  raw: unknown,
  hooks: { onPdfReady?: (jobId: string) => Promise<void> } = {},
  now = new Date(),
): Promise<{ status: string }> {
  const input = z
    .object({
      status: z.enum(['done', 'failed']),
      artifact: z
        .object({ key: z.string(), bytes: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
        .nullish(),
      error: z.string().nullish(),
    })
    .parse(raw);
  if (input.status === 'done' && input.artifact) {
    if (!input.artifact.key.startsWith(`audits/${s.auditId}/`))
      throw new CoreError('invalid_input', 'artifact outside the audit');
    const [audit] = await db.select({ source: audits.source }).from(audits).where(eq(audits.id, s.auditId));
    const kind = PDF_SOURCES[s.kind].pdf;
    await db.insert(artifacts).values({
      auditId: s.auditId,
      kind,
      blobKey: input.artifact.key,
      bytes: input.artifact.bytes,
      sha256: input.artifact.sha256,
      createdAt: now,
      expiresAt: artifactExpiry(kind, audit?.source ?? 'api', now),
    });
  }
  await db
    .update(jobs)
    .set({ status: input.status === 'done' && input.artifact ? 'done' : 'failed', finishedAt: now })
    .where(and(eq(jobs.id, s.jobId), eq(jobs.status, 'running')));
  if (input.status === 'done') await hooks.onPdfReady?.(s.jobId);
  return { status: input.status };
}

/** The job worker reads only its audit's files. */
export async function jobFile(platform: Pick<Platform, 'files'>, s: JobSession, key: string) {
  if (!key.startsWith(`audits/${s.auditId}/`) || key.split('/').includes('..')) throw new CoreError('forbidden');
  const got = await platform.files.get(key);
  if (!got) throw new CoreError('not_found');
  return got;
}
