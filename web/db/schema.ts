/**
 * Platform tables (design: docs/platform-api.md §4 "Exact schema").
 * Each table is added in the build step that names it (docs/platform-api-build.md §5).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  real,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
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

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    host: text('host').notNull().unique(),
    registrableDomain: text('registrable_domain').notNull(),
    firstSeenAt: tz('first_seen_at').notNull().defaultNow(),
    deletionPendingAt: tz('deletion_pending_at'),
  },
  (t) => [index('sites_registrable_domain').on(t.registrableDomain)],
);

export const siteAliases = pgTable(
  'site_aliases',
  {
    host: text('host').primaryKey(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
  },
  (t) => [check('site_aliases_reason', sql`${t.reason} in ('redirect','www','manual')`)],
);

// ── Audits ──────────────────────────────────────────────────────────────────

export const ACTIVE_AUDIT_STATUSES = ['queued', 'dispatched', 'running', 'built', 'loading'] as const;
export const AUDIT_STATUSES = [...ACTIVE_AUDIT_STATUSES, 'succeeded', 'failed', 'cancelled', 'stalled'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const audits = pgTable(
  'audits',
  {
    id: uuid('id').primaryKey(),
    legacyRunId: text('legacy_run_id').unique(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
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
    /** Set by the loader when the page cap stopped the crawl: `{ cap, pagesLoaded, sitemapUrls, sitemapHeld }`. */
    pageCap: jsonb('page_cap'),
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
  /** Hash of the scoring code the stored scores were computed with (not in the design's SQL); re-scored when it changes. */
  scoringVersion: text('scoring_version'),
    /** Failed loads so far; at 3 the loader sets the audit `failed` with the error (not in the design's SQL). */
    loadAttempts: integer('load_attempts').notNull().default(0),
    /** Failed re-scores with the current scoring code; at 3 the audit is marked and the queue moves on. */
    scoreAttempts: integer('score_attempts').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
    startedAt: tz('started_at'),
    finishedAt: tz('finished_at'),
    error: text('error'),
  },
  (t) => [
    check('audits_mode', sql`${t.mode} in ('full','quick','page')`),
    check('audits_profile', sql`${t.profile} in ('public','standard')`),
    check(
      'audits_status',
      sql`${t.status} in ('queued','dispatched','running','built','loading','succeeded','failed','cancelled','stalled')`,
    ),
    check('audits_source', sql`${t.source} in ('public','internal','api','pipeline')`),
    unique('audits_client_idempotency').on(t.createdByClientId, t.idempotencyKey),
    // one audit in progress per client, site and profile
    uniqueIndex('audits_active')
      .on(t.createdByClientId, t.siteId, t.profileHash)
      .where(sql`status in ('queued','dispatched','running','built','loading')`),
    index('audits_site_status').on(t.siteId, t.status, t.finishedAt.desc()),
    index('audits_site_comparable').on(t.siteId, t.comparableKey, t.finishedAt.desc()),
    index('audits_client_ref').on(t.createdByClientId, t.externalRef),
    index('audits_queue')
      .on(t.source, t.createdAt)
      .where(sql`status = 'queued'`),
  ],
);

export const auditAttempts = pgTable(
  'audit_attempts',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    dispatchNonce: text('dispatch_nonce').notNull(),
    ghRunId: bigint('gh_run_id', { mode: 'number' }),
    ghRunAttempt: integer('gh_run_attempt'),
    sessionHash: text('session_hash'),
    registeredAt: tz('registered_at'),
    heartbeatAt: tz('heartbeat_at'),
    status: text('status').notNull(),
  },
  (t) => [
    // Every worker call (heartbeat, progress, upload, status) finds its attempt by session.
    index('audit_attempts_session')
      .on(t.sessionHash)
      .where(sql`session_hash is not null`),
    primaryKey({ columns: [t.auditId, t.attempt] }),
    unique('audit_attempts_gh_run').on(t.ghRunId, t.ghRunAttempt),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    pageUrl: text('page_url'),
    findingId: uuid('finding_id').references((): AnyPgColumn => findings.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    blobKey: text('blob_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    expiresAt: tz('expires_at'),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    check(
      'artifacts_kind',
      sql`${t.kind} in ('report_html','report_md','report_pdf','report_verified_md','report_verified_pdf','content_research_md','content_research_pdf','teaser_md','teaser_pdf','screenshot','evidence','gate_evidence','raw_archive')`,
    ),
    index('artifacts_audit').on(t.auditId, t.kind),
    // A report asks for each of its files by key.
    index('artifacts_audit_key').on(t.auditId, t.blobKey),
    index('artifacts_expires')
      .on(t.expiresAt)
      .where(sql`deleted_at is null`),
  ],
);

// ── Limits and log ──────────────────────────────────────────────────────────

export const rateEvents = pgTable(
  'rate_events',
  {
    bucket: text('bucket').notNull(),
    at: tz('at').notNull().defaultNow(),
  },
  (t) => [index('rate_events_bucket').on(t.bucket, t.at)],
);

export const actionLog = pgTable('action_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: tz('at').notNull().defaultNow(),
  principal: text('principal').notNull(),
  action: text('action').notNull(),
  target: text('target'),
});

// ── Step 2: prospects, guard, jobs, webhooks ────────────────────────────────

/**
 * `extra` is not in the design's SQL: it keeps the companies.csv columns the lead pipeline reads and
 * writes (stack columns, fit_reasons, run_dir, …) so the pipeline can run on the API store unchanged.
 */
export const prospects = pgTable(
  'prospects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    company: text('company').notNull(),
    website: text('website'),
    registrableDomains: text('registrable_domains').array().notNull(),
    fitScore: integer('fit_score'),
    stage: text('stage').notNull(),
    stageAt: tz('stage_at').notNull().defaultNow(),
    doNotContact: boolean('do_not_contact').notNull().default(false),
    hasAudit: text('has_audit'),
    owner: text('owner'),
    notes: text('notes'),
    extra: jsonb('extra').$type<Record<string, string>>().notNull().default({}),
  },
  (t) => [
    check('prospects_has_audit', sql`${t.hasAudit} in ('yes','failed')`),
    index('prospects_domains').using('gin', t.registrableDomains),
    uniqueIndex('prospects_website').on(t.website),
  ],
);

export const suppressedDomains = pgTable(
  'suppressed_domains',
  {
    registrableDomain: text('registrable_domain').primaryKey(),
    reason: text('reason').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [check('suppressed_domains_reason', sql`${t.reason} in ('owner_request','legal')`)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    requestedBy: uuid('requested_by')
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: text('status').notNull(),
    dispatchNonce: text('dispatch_nonce'),
    ghRunId: bigint('gh_run_id', { mode: 'number' }),
    ghRunAttempt: integer('gh_run_attempt'),
    sessionHash: text('session_hash'),
    heartbeatAt: tz('heartbeat_at'),
    tries: integer('tries').notNull().default(0),
    createdAt: tz('created_at').notNull().defaultNow(),
    finishedAt: tz('finished_at'),
  },
  (t) => [
    check('jobs_type', sql`${t.type} in ('render-pdf')`),
    check('jobs_status', sql`${t.status} in ('queued','dispatched','running','done','failed')`),
    // Every call of a job's worker finds its job by session.
    index('jobs_session')
      .on(t.sessionHash)
      .where(sql`session_hash is not null`),
    uniqueIndex('jobs_active')
      .on(t.type, t.auditId, t.kind)
      .where(sql`status in ('queued','dispatched','running')`),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    kind: text('kind'),
    externalRef: text('external_ref'),
    attempt: integer('attempt').notNull().default(0),
    statusCode: integer('status_code'),
    nextAttemptAt: tz('next_attempt_at'),
    deliveredAt: tz('delivered_at'),
  },
  (t) => [
    index('webhook_due')
      .on(t.nextAttemptAt)
      .where(sql`delivered_at is null`),
  ],
);

// ── Step 3: the model's site part ───────────────────────────────────────────

export const auditDocuments = pgTable('audit_documents', {
  auditId: uuid('audit_id')
    .primaryKey()
    .references(() => audits.id, { onDelete: 'cascade' }),
  modelVersion: text('model_version').notNull(),
  document: jsonb('document').notNull(),
  bytes: integer('bytes').notNull(),
});

export const loadProgress = pgTable(
  'load_progress',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    chunk: text('chunk').notNull(),
    doneAt: tz('done_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.auditId, t.chunk] })],
);

export const checkTypes = pgTable('check_types', {
  code: text('code').primaryKey(),
  title: text('title').notNull(),
  family: text('family'),
  category: text('category'),
  tier: text('tier'),
  defaultSeverity: text('default_severity'),
  description: text('description'),
  fix: text('fix'),
  leadFactType: text('lead_fact_type'),
  derived: boolean('derived').notNull().default(false),
});

export const checkTypeAliases = pgTable('check_type_aliases', {
  oldCode: text('old_code').primaryKey(),
  code: text('code')
    .notNull()
    .references(() => checkTypes.code),
});

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    code: text('code')
      .notNull()
      .references(() => checkTypes.code),
    params: jsonb('params').notNull().default({}),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    category: text('category').notNull(),
    scope: text('scope').notNull(),
    occurrences: integer('occurrences').notNull(),
    pagesTotal: integer('pages_total'),
  },
  (t) => [
    check('findings_severity', sql`${t.severity} in ('critical','high','medium','low')`),
    check('findings_scope', sql`${t.scope} in ('page','site')`),
    index('findings_code').on(t.code, t.auditId),
    index('findings_severity_idx').on(t.auditId, t.severity),
  ],
);

export const scores = pgTable(
  'scores',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    score: integer('score'),
    source: text('source'),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.category] }),
    check('scores_source', sql`${t.source} in ('lab','field','findings')`),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    title: text('title').notNull(),
    codes: text('codes').array().notNull(),
    impact: text('impact'),
    effort: text('effort'),
    quickWin: boolean('quick_win').notNull().default(false),
    fix: text('fix'),
    pagesAffected: integer('pages_affected'),
  },
  (t) => [primaryKey({ columns: [t.auditId, t.rank] })],
);

export const siteChecks = pgTable(
  'site_checks',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull(),
    note: text('note'),
    details: jsonb('details'),
  },
  (t) => [primaryKey({ columns: [t.auditId, t.checkId] })],
);

export const scanQuality = pgTable(
  'scan_quality',
  {
    auditId: uuid('audit_id')
      .primaryKey()
      .references(() => audits.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    reasons: text('reasons')
      .array()
      .notNull()
      .default(sql`'{}'`),
    homepageRead: boolean('homepage_read').notNull(),
    pagesRequested: integer('pages_requested').notNull(),
    pagesOk: integer('pages_ok').notNull(),
    pagesBlocked: integer('pages_blocked').notNull(),
    pagesFailed: integer('pages_failed').notNull(),
    errorsByType: jsonb('errors_by_type').notNull().default({}),
    botProtection: text('bot_protection'),
    sitemapTotal: integer('sitemap_total'),
    sitemapCrawled: integer('sitemap_crawled'),
    probesBlocked: integer('probes_blocked').notNull().default(0),
  },
  (t) => [check('scan_quality_state', sql`${t.state} in ('ok','partial','blocked')`)],
);

export const siteProfiles = pgTable(
  'site_profiles',
  {
    auditId: uuid('audit_id')
      .primaryKey()
      .references(() => audits.id, { onDelete: 'cascade' }),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'`),
    multilang: boolean('multilang'),
    aiCrawlerRules: jsonb('ai_crawler_rules'),
    llmsTxt: text('llms_txt'),
    schemaTypes: text('schema_types')
      .array()
      .notNull()
      .default(sql`'{}'`),
    httpVersion: text('http_version'),
    cdn: text('cdn'),
    securityHeaders: text('security_headers')
      .array()
      .notNull()
      .default(sql`'{}'`),
    hasContactForm: boolean('has_contact_form'),
    formProviders: text('form_providers')
      .array()
      .notNull()
      .default(sql`'{}'`),
    ctas: jsonb('ctas'),
    bookingLinks: text('booking_links')
      .array()
      .notNull()
      .default(sql`'{}'`),
    homepageScreenshotArtifactId: uuid('homepage_screenshot_artifact_id').references(() => artifacts.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [check('site_profiles_llms_txt', sql`${t.llmsTxt} in ('valid','invalid','missing')`)],
);

export const fieldMetrics = pgTable(
  'field_metrics',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    url: text('url'),
    formFactor: text('form_factor').notNull(),
    lcpP75: integer('lcp_p75'),
    clsP75: real('cls_p75'),
    inpP75: integer('inp_p75'),
    ttfbP75: integer('ttfb_p75'),
    fcpP75: integer('fcp_p75'),
  },
  (t) => [
    check('field_metrics_scope', sql`${t.scope} in ('origin','url')`),
    index('field_metrics_audit').on(t.auditId),
  ],
);

export const disclosures = pgTable(
  'disclosures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    target: text('target').notNull(),
    firstAuditId: uuid('first_audit_id').references(() => audits.id, { onDelete: 'set null' }),
    lastSeenAuditId: uuid('last_seen_audit_id').references(() => audits.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('open'),
    owner: text('owner'),
    notes: text('notes'),
    createdAt: tz('created_at').notNull().defaultNow(),
    sentAt: tz('sent_at'),
    closedAt: tz('closed_at'),
  },
  (t) => [
    check('disclosures_status', sql`${t.status} in ('open','sent','resolved','dropped')`),
    unique('disclosures_site_code_target').on(t.siteId, t.code, t.target),
    index('disclosures_open')
      .on(t.siteId)
      .where(sql`status = 'open'`),
  ],
);

// ── Step 4: lead results ────────────────────────────────────────────────────

export const technologies = pgTable(
  'technologies',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    version: text('version'),
    confidence: text('confidence'),
    eolDate: date('eol_date'),
    evidence: jsonb('evidence'),
  },
  (t) => [
    index('technologies_audit').on(t.auditId),
    index('technologies_version').on(t.name, t.version),
    index('technologies_kind').on(t.kind, t.name),
  ],
);

export const trackingIds = pgTable(
  'tracking_ids',
  {
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    pagesSeen: integer('pages_seen'),
    sendsHits: boolean('sends_hits'),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.kind, t.value] }),
    check('tracking_ids_kind', sql`${t.kind} in ('ga4','gtm','meta_pixel','ua','ads','other')`),
    index('tracking_ids_value').on(t.kind, t.value),
  ],
);

export const leadGateRuns = pgTable(
  'lead_gate_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'cascade' }),
    runAt: tz('run_at').notNull(),
    source: text('source').notNull(),
    teaserReady: boolean('teaser_ready').notNull(),
    candidatesDropped: jsonb('candidates_dropped').notNull().default([]),
    previous: jsonb('previous'),
  },
  (t) => [
    check('lead_gate_runs_source', sql`${t.source} in ('workflow','pipeline')`),
    unique('lead_gate_runs_audit_run_at').on(t.auditId, t.runAt),
  ],
);

export const leadFacts = pgTable(
  'lead_facts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    gateRunId: bigint('gate_run_id', { mode: 'number' })
      .notNull()
      .references(() => leadGateRuns.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    rootCause: text('root_cause').notNull(),
    weight: text('weight').notNull(),
    fact: text('fact').notNull(),
    url: text('url'),
    gate: text('gate').notNull(),
    dependsOn: text('depends_on').notNull(),
    evidence: jsonb('evidence').notNull().default({}),
  },
  (t) => [
    check('lead_facts_weight', sql`${t.weight} in ('heavy','medium','light')`),
    check('lead_facts_gate', sql`${t.gate} in ('pass','fail')`),
    check('lead_facts_depends_on', sql`${t.dependsOn} in ('pages','homepage','dns')`),
    index('lead_facts_run').on(t.gateRunId),
  ],
);

// ── Step 6 (first part): page rows and the run's own data, so reports render from the database ──

/** One row per crawled page (design §4 `pages`); `sections` holds the full page record. */
export const pages = pgTable('pages', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
  chunk: integer('chunk').notNull(),
  url: text('url').notNull(),
  finalUrl: text('final_url'),
  statusCode: integer('status_code'),
  blocked: boolean('blocked').notNull().default(false),
  template: text('template'),
  segment: text('segment'),
  title: text('title'),
  metaDescription: text('meta_description'),
  canonical: text('canonical'),
  h1: text('h1').array().notNull().default(sql`'{}'`),
  lang: text('lang'),
  indexable: boolean('indexable'),
  inSitemap: boolean('in_sitemap'),
  depth: integer('depth'),
  wordCount: integer('word_count'),
  schemaTypes: text('schema_types').array().notNull().default(sql`'{}'`),
  ttfbMs: integer('ttfb_ms'),
  lcpMs: integer('lcp_ms'),
  cls: real('cls'),
  fcpMs: integer('fcp_ms'),
  inpMs: integer('inp_ms'),
  tbtMs: integer('tbt_ms'),
  speedIndexMs: integer('speed_index_ms'),
  lcpElement: text('lcp_element'),
  bytes: bigint('bytes', { mode: 'number' }),
  weight: jsonb('weight'),
  requests: integer('requests'),
  selectionReason: text('selection_reason'),
  sections: jsonb('sections').notNull().default({}),
}, (t) => [
  uniqueIndex('pages_audit_url').on(t.auditId, sql`md5(${t.url})`),
  index('pages_audit_chunk').on(t.auditId, t.chunk),
]);

/**
 * Not in the design's SQL: the run-level data the HTML report is rendered from (manifest, metadata,
 * analysis with every finding and its examples, incoming links), one jsonb per name. With `pages`,
 * the report is rendered from the database alone (screenshots stay in the file store).
 */
export const auditRunData = pgTable('audit_run_data', {
  auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  data: jsonb('data').notNull(),
}, (t) => [primaryKey({ columns: [t.auditId, t.name] }), check('audit_run_data_name', sql`${t.name} in ('manifest','metadata','analysis','incoming-links')`)]);
