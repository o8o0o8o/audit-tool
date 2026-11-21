/**
 * Platform tables (design: docs/platform-api.md §4 "Exact schema").
 * Each table is added in the build step that names it (docs/platform-api-build.md §5).
 */
import { sql } from 'drizzle-orm';
import {
  bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const tz = (name: string) => timestamp(name, { withTimezone: true });

// ── Access ──────────────────────────────────────────────────────────────────

export const apiClients = pgTable('api_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').array().notNull(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(60),
  createdAt: tz('created_at').notNull().defaultNow(),
  revokedAt: tz('revoked_at'),
});

// ── Sites ───────────────────────────────────────────────────────────────────

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  host: text('host').notNull().unique(),
  registrableDomain: text('registrable_domain').notNull(),
  firstSeenAt: tz('first_seen_at').notNull().defaultNow(),
  deletionPendingAt: tz('deletion_pending_at'),
}, (t) => [index('sites_registrable_domain').on(t.registrableDomain)]);

export const siteAliases = pgTable('site_aliases', {
  host: text('host').primaryKey(),
  siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
}, (t) => [check('site_aliases_reason', sql`${t.reason} in ('redirect','www','manual')`)]);

// ── Audits ──────────────────────────────────────────────────────────────────

export const ACTIVE_AUDIT_STATUSES = ['queued', 'dispatched', 'running', 'built', 'loading'] as const;
export const AUDIT_STATUSES = [...ACTIVE_AUDIT_STATUSES, 'succeeded', 'failed', 'cancelled', 'stalled'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const audits = pgTable('audits', {
  id: uuid('id').primaryKey(),
  legacyRunId: text('legacy_run_id').unique(),
  siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(),
  targetUrl: text('target_url').notNull(),
  preset: text('preset'),
  options: jsonb('options').notNull().default({}),
  profile: text('profile').notNull(),
  profileHash: text('profile_hash').notNull(),
  comparableKey: text('comparable_key').notNull(),
  status: text('status').notNull(),
  phase: text('phase'),
  loadBlocked: text('load_blocked'),
  pagesProcessed: integer('pages_processed'),
  pagesTotal: integer('pages_total'),
  progressAt: tz('progress_at'),
  currentAttempt: integer('current_attempt').notNull().default(0),
  source: text('source').notNull(),
  createdByClientId: uuid('created_by_client_id').references(() => apiClients.id),
  externalRef: text('external_ref'),
  idempotencyKey: text('idempotency_key'),
  toolVersion: text('tool_version'),
  modelVersion: text('model_version'),
  rendererVersion: text('renderer_version'),
  createdAt: tz('created_at').notNull().defaultNow(),
  startedAt: tz('started_at'),
  finishedAt: tz('finished_at'),
  error: text('error'),
}, (t) => [
  check('audits_mode', sql`${t.mode} in ('full','quick','page')`),
  check('audits_profile', sql`${t.profile} in ('public','standard')`),
  check('audits_status', sql`${t.status} in ('queued','dispatched','running','built','loading','succeeded','failed','cancelled','stalled')`),
  check('audits_source', sql`${t.source} in ('public','internal','api','pipeline')`),
  unique('audits_client_idempotency').on(t.createdByClientId, t.idempotencyKey),
  // one audit in progress per client, site and profile
  uniqueIndex('audits_active').on(t.createdByClientId, t.siteId, t.profileHash)
    .where(sql`status in ('queued','dispatched','running','built','loading')`),
  index('audits_site_status').on(t.siteId, t.status, t.finishedAt.desc()),
  index('audits_site_comparable').on(t.siteId, t.comparableKey, t.finishedAt.desc()),
  index('audits_client_ref').on(t.createdByClientId, t.externalRef),
  index('audits_queue').on(t.source, t.createdAt).where(sql`status = 'queued'`),
]);

export const auditAttempts = pgTable('audit_attempts', {
  auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  dispatchNonce: text('dispatch_nonce').notNull(),
  ghRunId: bigint('gh_run_id', { mode: 'number' }),
  ghRunAttempt: integer('gh_run_attempt'),
  sessionHash: text('session_hash'),
  registeredAt: tz('registered_at'),
  heartbeatAt: tz('heartbeat_at'),
  status: text('status').notNull(),
}, (t) => [
  primaryKey({ columns: [t.auditId, t.attempt] }),
  unique('audit_attempts_gh_run').on(t.ghRunId, t.ghRunAttempt),
]);

// finding_id gets its foreign key to findings in step 3, when findings exists.
export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
  pageUrl: text('page_url'),
  findingId: uuid('finding_id'),
  kind: text('kind').notNull(),
  blobKey: text('blob_key').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at'),
  deletedAt: tz('deleted_at'),
}, (t) => [
  check('artifacts_kind', sql`${t.kind} in ('report_html','report_md','report_pdf','report_verified_md','report_verified_pdf','content_research_md','content_research_pdf','teaser_md','teaser_pdf','screenshot','evidence','gate_evidence','raw_archive')`),
  index('artifacts_audit').on(t.auditId, t.kind),
  index('artifacts_expires').on(t.expiresAt).where(sql`deleted_at is null`),
]);

// ── Limits and log ──────────────────────────────────────────────────────────

export const rateEvents = pgTable('rate_events', {
  bucket: text('bucket').notNull(),
  at: tz('at').notNull().defaultNow(),
}, (t) => [index('rate_events_bucket').on(t.bucket, t.at)]);

export const actionLog = pgTable('action_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: tz('at').notNull().defaultNow(),
  principal: text('principal').notNull(),
  action: text('action').notNull(),
  target: text('target'),
});

