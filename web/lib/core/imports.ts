/**
 * Publishing a run made outside the platform (tasks 3.8 and 4.7): the lead pipeline's local scans
 * and stored runs. `beginImport` creates the audit (source `pipeline`) and an upload grant; the
 * caller uploads the model and files, then `completeImport` sets `built` and the loader takes over.
 * `appendGateRun` adds a pipeline gate run (rerank, recheck) to an audit; nothing else changes.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { auditAttempts, audits, leadFacts, leadGateRuns } from '../../db/schema';
import type { FileStore } from '../platform/types';
import { comparableKey, normalizeRunOptions, profileHash } from '@model/run-options';
import { factDependsOn } from '@model/vendor-kinds';
import { CoreError } from './errors';
import { checkGuard } from './guard';
import { requireScope, type Principal } from './principal';
import { findOrCreateSite, normalizeTarget } from './sites';
import { randomToken, sha256Hex } from './tokens';
import { artifactExpiry, ARTIFACT_KINDS } from './worker';

export const BeginImportInput = z.object({
  url: z.string().min(1),
  mode: z.enum(['full', 'quick', 'page']),
  legacy_run_id: z.string().max(200).nullish().describe('The run folder (<domain>/<timestamp>) or an old run id'),
  external_ref: z.string().max(200).nullish(),
  finished_at: z.string().datetime({ offset: true }).nullish(),
});

export async function beginImport(db: Db, files: FileStore, principal: Principal, raw: unknown, now = new Date()) {
  requireScope(principal, 'audits:publish');
  const input = BeginImportInput.parse(raw);
  const target = normalizeTarget(input.url, input.mode === 'page');
  const guard = await checkGuard(db, target.host);
  if (!guard.allowed) throw new CoreError('do_not_contact', `${guard.registrableDomain} must not be scanned`);
  if (input.legacy_run_id) {
    const [dup] = await db
      .select({ id: audits.id, status: audits.status })
      .from(audits)
      .where(eq(audits.legacyRunId, input.legacy_run_id));
    if (dup && dup.status !== 'running') return { audit_id: dup.id, already_imported: true as const };
    if (dup) await db.delete(audits).where(eq(audits.id, dup.id)); // a half-finished import starts over
  }
  const site = await findOrCreateSite(db, target.host);
  const options = normalizeRunOptions(input.mode, {});
  const id = randomUUID();
  const session = randomToken(32);
  await db.insert(audits).values({
    id,
    legacyRunId: input.legacy_run_id ?? null,
    siteId: site.id,
    mode: input.mode,
    targetUrl: target.url,
    options,
    profile: 'standard',
    profileHash: profileHash(input.mode, 'standard', options),
    comparableKey: comparableKey(input.mode, 'standard', options),
    status: 'running',
    phase: 'upload',
    currentAttempt: 1,
    source: 'pipeline',
    createdByClientId: principal.kind === 'client' ? principal.clientId : null,
    externalRef: input.external_ref ?? null,
    createdAt: now,
    startedAt: now,
    finishedAt: input.finished_at ? new Date(input.finished_at) : null,
  });
  await db.insert(auditAttempts).values({
    auditId: id,
    attempt: 1,
    dispatchNonce: 'import',
    sessionHash: sha256Hex(session),
    registeredAt: now,
    heartbeatAt: now,
    status: 'running',
  });
  const prefix = `audits/${id}/1/`;
  return {
    audit_id: id,
    attempt: 1,
    prefix,
    upload: await files.issueUpload(prefix, 6 * 3600),
    already_imported: false as const,
  };
}

const Artifact = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  key: z.string(),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  page_url: z.string().nullish(),
});

/** An import is finished and added to only by the client that began it (or internally). */
function assertOwnImport(principal: Principal, ownerClientId: string | null): void {
  if (principal.kind === 'client' && ownerClientId !== principal.clientId)
    throw new CoreError('forbidden', 'not your import');
}

export async function completeImport(
  db: Db,
  files: FileStore,
  principal: Principal,
  auditId: string,
  raw: unknown,
  now = new Date(),
) {
  requireScope(principal, 'audits:publish');
  const input = z
    .object({
      artifacts: z.array(Artifact).max(20000),
      tool_version: z.string().nullish(),
      model_version: z.string().nullish(),
    })
    .parse(raw);
  const [audit] = await db
    .select()
    .from(audits)
    .where(eq(audits.id, z.uuid().parse(auditId)));
  if (!audit || audit.source !== 'pipeline') throw new CoreError('not_found', 'import not found');
  assertOwnImport(principal, audit.createdByClientId);
  if (audit.status !== 'running') throw new CoreError('conflict', `import is ${audit.status}`);
  if (!(await files.get(`audits/${auditId}/1/model/site.json.gz`)))
    throw new CoreError('invalid_input', 'upload model/site.json.gz first');
  const { artifacts } = await import('../../db/schema');
  for (const a of input.artifacts)
    if (!a.key.startsWith(`audits/${auditId}/1/`))
      throw new CoreError('invalid_input', `artifact outside the audit: ${a.key}`);
  for (let i = 0; i < input.artifacts.length; i += 1000) {
    const chunk = input.artifacts.slice(i, i + 1000);
    if (chunk.length) {
      await db.insert(artifacts).values(
        chunk.map((a) => ({
          auditId,
          kind: a.kind,
          blobKey: a.key,
          bytes: a.bytes,
          sha256: a.sha256,
          pageUrl: a.page_url ?? null,
          createdAt: now,
          expiresAt: artifactExpiry(a.kind, 'pipeline', now),
        })),
      );
    }
  }
  await db
    .update(audits)
    .set({
      status: 'built',
      phase: null,
      toolVersion: input.tool_version ?? null,
      modelVersion: input.model_version ?? null,
      finishedAt: audit.finishedAt ?? now,
    })
    .where(eq(audits.id, auditId));
  await db
    .update(auditAttempts)
    .set({ status: 'built' })
    .where(and(eq(auditAttempts.auditId, auditId), eq(auditAttempts.attempt, 1)));
  return { audit_id: auditId, status: 'built' };
}

/** A gate run as the pipeline writes it (lib/leads/lead-file.ts LeadFile), appended with source `pipeline`. */
export const GateRunInput = z
  .object({
    checkedAt: z.string(),
    rerankedAt: z.string().nullish(),
    teaserReady: z.boolean(),
    highlights: z.array(
      z
        .object({
          type: z.string(),
          rootCause: z.string().nullish(),
          weight: z.string().nullish(),
          fact: z.string(),
          url: z.string().nullish(),
          evidence: z.unknown().nullish(),
        })
        .passthrough(),
    ),
    candidatesDropped: z.array(z.unknown()).nullish(),
    previous: z.unknown().nullish(),
  })
  .passthrough();

export async function appendGateRun(db: Db, principal: Principal, auditId: string, raw: unknown) {
  requireScope(principal, 'audits:publish');
  const lead = GateRunInput.parse(raw);
  const [audit] = await db
    .select({ id: audits.id, owner: audits.createdByClientId })
    .from(audits)
    .where(eq(audits.id, z.uuid().parse(auditId)));
  if (!audit) throw new CoreError('not_found', 'audit not found');
  assertOwnImport(principal, audit.owner);
  const runAt = new Date(lead.rerankedAt ?? lead.checkedAt);
  const [existing] = await db
    .select({ id: leadGateRuns.id })
    .from(leadGateRuns)
    .where(and(eq(leadGateRuns.auditId, auditId), eq(leadGateRuns.runAt, runAt)));
  if (existing) return { gate_run_id: existing.id, duplicate: true };
  const [row] = await db
    .insert(leadGateRuns)
    .values({
      auditId,
      runAt,
      source: 'pipeline',
      teaserReady: lead.teaserReady,
      candidatesDropped: lead.candidatesDropped ?? [],
      previous: lead.previous ?? null,
    })
    .returning({ id: leadGateRuns.id });
  if (lead.highlights.length) {
    await db.insert(leadFacts).values(
      lead.highlights.map((h) => ({
        gateRunId: row!.id,
        type: h.type,
        rootCause: h.rootCause ?? h.type,
        weight: ['heavy', 'medium', 'light'].includes(h.weight ?? '') ? h.weight! : 'light',
        fact: h.fact,
        url: h.url ?? null,
        gate: 'pass',
        dependsOn: factDependsOn(h.type),
        evidence: (h.evidence as object) ?? {},
      })),
    );
  }
  return { gate_run_id: row!.id, duplicate: false };
}

export async function listGateRuns(db: Db, principal: Principal, auditId: string) {
  requireScope(principal, 'audits:read');
  const [audit] = await db
    .select({ status: audits.status })
    .from(audits)
    .where(eq(audits.id, z.uuid().parse(auditId)));
  if (!audit) throw new CoreError('not_found', 'audit not found');
  if (audit.status !== 'succeeded' && principal.kind !== 'internal')
    throw new CoreError('audit_not_ready', 'the audit has not finished');
  return db.select().from(leadGateRuns).where(eq(leadGateRuns.auditId, auditId)).orderBy(desc(leadGateRuns.runAt));
}
