import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { ACTIVE_AUDIT_STATUSES, actionLog, artifacts, audits, scanQuality, scores, sites } from '../../db/schema';
import {
  AuditMode,
  FULL_ONLY_OPTIONS,
  comparableKey,
  estimateMinutes,
  normalizeRunOptions,
  profileHash,
  type AuditProfile,
  type RunOptions,
} from '@model/run-options';
import { CoreError } from './errors';
import { checkGuard, isProspectDomain } from './guard';
import { assertPrincipal, hasScope, principalLabel, requireScope, type Principal } from './principal';
import { findOrCreateSite, isPrivateHost, normalizeTarget, resolveSites } from './sites';

export const StartAuditInput = z.object({
  url: z.string().min(1).describe('Site (any page of it) or, for mode=page, the page URL'),
  mode: AuditMode,
  preset: z.string().nullish(),
  options: z.record(z.string(), z.unknown()).nullish().describe('RunOptions: perf, visual, pdf, limit, …'),
  external_ref: z.string().max(200).nullish().describe("Caller's own reference, e.g. hubspot:company:123"),
  idempotency_key: z.string().max(200).nullish(),
  reuse_if_newer_than_hours: z
    .number()
    .positive()
    .max(24 * 365)
    .nullish(),
  /** Internal only: run a full audit of a prospect without --passive (owner agreed). Logged. */
  active: z.boolean().nullish(),
});
export type StartAuditInput = z.infer<typeof StartAuditInput>;

export type Reused = 'idempotent' | 'in_progress' | 'recent' | null;

export interface StartAuditResult {
  audit_id: string;
  status: string;
  estimate_minutes: number;
  reused: Reused;
}

type AuditRow = typeof audits.$inferSelect;

/** lib/model has its own zod copy, so ZodErrors are recognised by shape, not instanceof. */
export function zodMessage(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
  return Array.isArray(issues)
    ? issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')
    : String(err);
}

function sourceOf(p: Principal): 'internal' | 'api' {
  return p.kind === 'internal' ? 'internal' : 'api';
}

const isUniqueViolation = (err: unknown) => {
  const e = (err as { cause?: { code?: string }; code?: string }) ?? {};
  return e.code === '23505' || e.cause?.code === '23505';
};

/** §5 `start_audit`, in the documented order: guard, idempotency, in progress, recent, new. */
export async function startAudit(
  db: Db,
  principal: Principal,
  rawInput: StartAuditInput,
  opts: {
    now?: Date;
    source?: 'internal' | 'api' | 'pipeline' | 'public';
    profile?: AuditProfile;
    allowPrivateTarget?: boolean;
  } = {},
): Promise<StartAuditResult> {
  const input = StartAuditInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const mode = input.mode;
  if (principal.kind === 'report') throw new CoreError('forbidden');
  requireScope(principal, mode === 'full' ? 'audits:start:full' : 'audits:start:quick');
  if (mode !== 'full' && !hasScope(principal, 'audits:start:quick')) throw new CoreError('forbidden_mode');

  let options: RunOptions;
  try {
    options = normalizeRunOptions(mode, {
      ...(input.options ?? {}),
      ...(input.preset !== undefined ? { preset: input.preset ?? null } : {}),
    });
  } catch (err) {
    throw new CoreError('invalid_input', zodMessage(err));
  }
  if (FULL_ONLY_OPTIONS.some((k) => options[k]) && !hasScope(principal, 'audits:start:full')) {
    throw new CoreError('forbidden_mode', 'LLM, verify and content research need audits:start:full');
  }
  if (options.pdf) requireScope(principal, 'audits:pdf');
  if (input.active && principal.kind !== 'internal')
    throw new CoreError('forbidden', 'active audits are internal only');

  const target = normalizeTarget(input.url, mode === 'page');
  // Every caller (form, API, MCP) is refused a local or private target; local mode audits fixtures.
  if (process.env.PLATFORM_MODE !== 'local' && !opts.allowPrivateTarget && isPrivateHost(target.host))
    throw new CoreError('invalid_input', 'url must not point at localhost or a private network');
  // 1. Scan guard.
  const guard = await checkGuard(db, target.host);
  if (!guard.allowed) throw new CoreError('do_not_contact', `${guard.registrableDomain} must not be scanned`);

  const site = await findOrCreateSite(db, target.host);
  if (mode === 'full' && (await isProspectDomain(db, target.host))) {
    if (input.active) {
      await db.insert(actionLog).values({
        principal: principalLabel(principal),
        action: 'active_audit_of_prospect',
        target: target.host,
        at: now,
      });
    } else options = { ...options, passive: true };
  }
  const profile: AuditProfile = opts.profile ?? 'standard';
  const hash = profileHash(mode, profile, options);
  const clientId = principal.kind === 'client' ? principal.clientId : null;
  const estimate = estimateMinutes(mode, options);
  const result = (row: Pick<AuditRow, 'id' | 'status'>, reused: Reused): StartAuditResult => ({
    audit_id: row.id,
    status: row.status,
    estimate_minutes: estimate,
    reused,
  });

  // 2. Same idempotency key from this client.
  const byKey = async () =>
    input.idempotency_key && clientId
      ? (
          await db
            .select()
            .from(audits)
            .where(and(eq(audits.createdByClientId, clientId), eq(audits.idempotencyKey, input.idempotency_key)))
        )[0]
      : undefined;
  // 3. This client's audit of the same site and profile still in progress.
  const inProgress = async () =>
    (
      await db
        .select()
        .from(audits)
        .where(
          and(
            clientId ? eq(audits.createdByClientId, clientId) : sql`${audits.createdByClientId} is null`,
            eq(audits.siteId, site.id),
            eq(audits.profileHash, hash),
            inArray(audits.status, [...ACTIVE_AUDIT_STATUSES]),
          ),
        )
        .limit(1)
    )[0];

  const k = await byKey();
  if (k) return result(k, 'idempotent');
  const p = clientId ? await inProgress() : undefined;
  if (p) return result(p, 'in_progress');

  // 4. A recent succeeded audit of the same site and profile, from any source, not blocked.
  if (input.reuse_if_newer_than_hours) {
    const since = new Date(now.getTime() - input.reuse_if_newer_than_hours * 3600_000);
    const [recent] = await db
      .select({ id: audits.id, status: audits.status })
      .from(audits)
      .leftJoin(scanQuality, eq(scanQuality.auditId, audits.id))
      .where(
        and(
          eq(audits.siteId, site.id),
          eq(audits.profileHash, hash),
          eq(audits.status, 'succeeded'),
          gt(audits.finishedAt, since),
          or(sql`${scanQuality.state} is null`, ne(scanQuality.state, 'blocked')),
        ),
      )
      .orderBy(desc(audits.finishedAt))
      .limit(1);
    if (recent) return result(recent, 'recent');
  }

  // 5. A new audit. Two calls at the same moment: the unique indexes refuse the second insert.
  const id = randomUUID();
  try {
    await db.insert(audits).values({
      id,
      siteId: site.id,
      mode,
      targetUrl: target.url,
      preset: options.preset,
      options,
      profile,
      profileHash: hash,
      comparableKey: comparableKey(mode, profile, options),
      status: 'queued',
      source: opts.source ?? sourceOf(principal),
      createdByClientId: clientId,
      externalRef: input.external_ref ?? null,
      idempotencyKey: input.idempotency_key ?? null,
      createdAt: now,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = (await byKey()) ?? (await inProgress());
    if (again)
      return result(
        again,
        again.idempotencyKey === input.idempotency_key && input.idempotency_key ? 'idempotent' : 'in_progress',
      );
    throw err;
  }
  return result({ id, status: 'queued' }, null);
}

// ── Reads ────────────────────────────────────────────────────────────────────

function canReadAudit(p: Principal, auditId: string): boolean {
  assertPrincipal(p);
  if (p.kind === 'report') return p.auditId === auditId;
  return hasScope(p, 'audits:read');
}

export async function getAuditRow(db: Db, auditId: string): Promise<AuditRow | null> {
  if (!z.uuid().safeParse(auditId).success) return null;
  const [row] = await db.select().from(audits).where(eq(audits.id, auditId));
  return row ?? null;
}

export interface AuditView {
  audit_id: string;
  domain: string;
  target_url: string;
  mode: string;
  preset: string | null;
  profile: string;
  source: string;
  status: string;
  phase: string | null;
  progress: { processed: number | null; total: number | null; updated_at: string | null };
  options: unknown;
  external_ref: string | null;
  attempt: number;
  error: string | null;
  load_blocked: string | null;
  tool_version: string | null;
  model_version: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  scan_quality: string | null;
  scores: Record<string, number | null>;
  artifacts: { id: string; kind: string; key: string; bytes: number }[];
  links: { internal: string };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function getAudit(db: Db, principal: Principal, auditId: string): Promise<AuditView> {
  if (!canReadAudit(principal, auditId)) throw new CoreError('forbidden', 'missing scope audits:read');
  const row = await getAuditRow(db, auditId);
  if (!row) throw new CoreError('not_found', 'audit not found');
  const [site] = await db.select({ host: sites.host }).from(sites).where(eq(sites.id, row.siteId));
  const scoreRows = await db.select().from(scores).where(eq(scores.auditId, row.id));
  const [quality] = await db
    .select({ state: scanQuality.state })
    .from(scanQuality)
    .where(eq(scanQuality.auditId, row.id));
  const files = await db
    .select({ id: artifacts.id, kind: artifacts.kind, key: artifacts.blobKey, bytes: artifacts.bytes })
    .from(artifacts)
    .where(and(eq(artifacts.auditId, row.id), sql`${artifacts.deletedAt} is null`, ne(artifacts.kind, 'evidence')));
  return {
    audit_id: row.id,
    domain: site?.host ?? '',
    target_url: row.targetUrl,
    mode: row.mode,
    preset: row.preset,
    profile: row.profile,
    source: row.source,
    status: row.status,
    phase: row.phase,
    progress: { processed: row.pagesProcessed, total: row.pagesTotal, updated_at: iso(row.progressAt) },
    options: row.options,
    external_ref: row.externalRef,
    attempt: row.currentAttempt,
    error: row.error,
    load_blocked: row.loadBlocked,
    tool_version: row.toolVersion,
    model_version: row.modelVersion,
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    scan_quality: quality?.state ?? null,
    scores: Object.fromEntries(scoreRows.map((s) => [s.category, s.score])),
    artifacts: files.filter((f) => f.kind !== 'screenshot'),
    links: { internal: `/internal/audits/${row.id}` },
  };
}

export const ListAuditsInput = z.object({
  domain: z.string().nullish(),
  mode: AuditMode.nullish(),
  status: z.string().nullish(),
  source: z.enum(['public', 'internal', 'api', 'pipeline']).nullish(),
  external_ref: z.string().nullish(),
  since: z.string().datetime({ offset: true }).nullish(),
  limit: z.number().int().min(1).max(500).nullish(),
});

export async function listAudits(db: Db, principal: Principal, raw: z.infer<typeof ListAuditsInput> = {}) {
  requireScope(principal, 'audits:read');
  const input = ListAuditsInput.parse(raw);
  const where: SQL[] = [];
  if (input.domain) {
    const found = await resolveSites(db, input.domain);
    if (!found.length) return [];
    where.push(
      inArray(
        audits.siteId,
        found.map((s) => s.id),
      ),
    );
  }
  if (input.mode) where.push(eq(audits.mode, input.mode));
  if (input.status) where.push(eq(audits.status, input.status));
  if (input.source) where.push(eq(audits.source, input.source));
  if (input.external_ref) where.push(eq(audits.externalRef, input.external_ref));
  if (input.since) where.push(gt(audits.createdAt, new Date(input.since)));
  const rows = await db
    .select({
      audit_id: audits.id,
      domain: sites.host,
      target_url: audits.targetUrl,
      mode: audits.mode,
      preset: audits.preset,
      source: audits.source,
      status: audits.status,
      phase: audits.phase,
      pages_processed: audits.pagesProcessed,
      pages_total: audits.pagesTotal,
      external_ref: audits.externalRef,
      created_at: audits.createdAt,
      finished_at: audits.finishedAt,
      legacy_run_id: audits.legacyRunId,
    })
    .from(audits)
    .innerJoin(sites, eq(sites.id, audits.siteId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(audits.createdAt))
    .limit(input.limit ?? 50);
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), finished_at: iso(r.finished_at) }));
}

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** Only the client that started the audit (with audits:cancel), or internal. */
export async function cancelAudit(
  db: Db,
  principal: Principal,
  auditId: string,
  deps: {
    cancelRun?: (auditId: string, attempt: number) => Promise<void>;
    onFinished?: (auditId: string) => Promise<void>;
  } = {},
  now = new Date(),
): Promise<{ audit_id: string; status: string }> {
  requireScope(principal, 'audits:cancel');
  const row = await getAuditRow(db, auditId);
  if (!row) throw new CoreError('not_found', 'audit not found');
  if (principal.kind === 'client' && row.createdByClientId !== principal.clientId)
    throw new CoreError('forbidden', 'not your audit');
  if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) return { audit_id: row.id, status: row.status };
  const done = await db
    .update(audits)
    .set({ status: 'cancelled', error: 'cancelled', finishedAt: now })
    .where(and(eq(audits.id, row.id), notInArray(audits.status, [...TERMINAL_STATUSES])))
    .returning({ id: audits.id });
  if (!done.length) {
    // It ended while this request was in flight: report what it became, queue no second webhook.
    const after = await getAuditRow(db, auditId);
    return { audit_id: row.id, status: after?.status ?? row.status };
  }
  if (row.currentAttempt > 0 && deps.cancelRun) await deps.cancelRun(row.id, row.currentAttempt).catch(() => {});
  await deps.onFinished?.(row.id);
  return { audit_id: row.id, status: 'cancelled' };
}
