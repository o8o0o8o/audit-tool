/**
 * Read tools over the site part of the model (task 4.5). Sites are addressed by `domain` or
 * `audit_id`; with a domain the newest succeeded audit that holds the data is used, and every
 * result names the audit it used (`audit_id`, `mode`, `scanned_at`) and its scan quality.
 */
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import {
  artifacts,
  audits,
  checkTypeAliases,
  checkTypes,
  fieldMetrics,
  findings,
  prospects,
  recommendations,
  scanQuality,
  scores,
  siteChecks,
  siteProfiles,
  sites,
  technologies,
  trackingIds,
} from '../../db/schema';
import { CoreError } from './errors';
import { hasScope, requireScope, type Principal } from './principal';
import { ensureScored, scoringVersion } from './rescore';
import { listAliases, registrableDomainOf, resolveSites } from './sites';

export const Target = z
  .object({
    audit_id: z.uuid().nullish().describe('A specific audit'),
    domain: z.string().nullish().describe('Site domain; the newest succeeded audit with the data is used'),
    mode: z.enum(['full', 'quick', 'page']).nullish().describe('Pin a mode when using domain'),
  })
  .refine((t) => t.audit_id || t.domain, 'give audit_id or domain');
export type Target = z.infer<typeof Target>;

export interface UsedAudit {
  audit_id: string;
  mode: string;
  scanned_at: string | null;
  domain: string;
  scan_quality: string | null;
}

/** Resolves a target to one succeeded audit. `exclude` skips modes that lack the data. */
export async function resolveAudit(db: Db, principal: Principal, raw: unknown, opts: { excludeModes?: string[] } = {}) {
  requireScope(principal, 'audits:read');
  const t = Target.parse(raw);
  const where: SQL[] = [eq(audits.status, 'succeeded')];
  if (t.audit_id) where.push(eq(audits.id, t.audit_id));
  else {
    const found = await resolveSites(db, t.domain!);
    if (!found.length) throw new CoreError('not_found', `no audits for ${t.domain}`);
    where.push(
      inArray(
        audits.siteId,
        found.map((s) => s.id),
      ),
    );
    if (t.mode) where.push(eq(audits.mode, t.mode));
    else if (opts.excludeModes?.length)
      where.push(sql`${audits.mode} not in ${sql.raw(`(${opts.excludeModes.map((m) => `'${m}'`).join(',')})`)}`);
  }
  const [row] = await db
    .select({
      id: audits.id,
      mode: audits.mode,
      finishedAt: audits.finishedAt,
      siteId: audits.siteId,
      host: sites.host,
      quality: scanQuality.state,
      homepageRead: scanQuality.homepageRead,
      comparableKey: audits.comparableKey,
      source: audits.source,
    })
    .from(audits)
    .innerJoin(sites, eq(sites.id, audits.siteId))
    .leftJoin(scanQuality, eq(scanQuality.auditId, audits.id))
    .where(and(...where))
    .orderBy(desc(audits.finishedAt))
    .limit(1);
  if (!row) {
    if (t.audit_id) {
      const [any] = await db.select({ status: audits.status }).from(audits).where(eq(audits.id, t.audit_id));
      if (any) throw new CoreError('audit_not_ready', `audit is ${any.status}`);
    }
    throw new CoreError('not_found', 'no succeeded audit holds this data');
  }
  const used: UsedAudit = {
    audit_id: row.id,
    mode: row.mode,
    scanned_at: row.finishedAt?.toISOString() ?? null,
    domain: row.host,
    scan_quality: row.quality ?? null,
  };
  return { used, row };
}

const SEV_ORDER = sql`case ${findings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

export const ListFindingsInput = z.object({
  severity_min: z.enum(['critical', 'high', 'medium', 'low']).nullish(),
  category: z.string().nullish(),
  codes: z.array(z.string()).nullish().describe('check_types codes; aliases accepted'),
  scope: z.enum(['page', 'site']).nullish(),
  limit: z.number().int().min(1).max(500).nullish(),
  cursor: z.string().nullish().describe('next_cursor of the previous page, with the same filters'),
});

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Opaque keyset cursor over (severity rank, occurrences desc, id). */
function encodeCursor(row: { severity: string; occurrences: number; id: string }): string {
  const rank = SEVERITIES.indexOf(row.severity);
  return Buffer.from(JSON.stringify([rank < 0 ? 3 : Math.min(rank, 3), row.occurrences, row.id])).toString('base64url');
}

function decodeCursor(cursor: string): [number, number, string] {
  try {
    const v = z
      .tuple([z.number().int().min(0).max(3), z.number().int(), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return v;
  } catch {
    throw new CoreError('invalid_input', 'cursor is not valid');
  }
}

export async function listFindings(db: Db, principal: Principal, raw: Record<string, unknown>) {
  const { used } = await resolveAudit(db, principal, raw);
  const input = ListFindingsInput.parse(raw);
  // A blocked request is never evidence: a blocked scan shows no findings, as in get_lead_summary.
  if (used.scan_quality === 'blocked') return { ...used, findings: [], count: 0, total: 0, next_cursor: null };
  const where: SQL[] = [eq(findings.auditId, used.audit_id)];
  if (input.severity_min)
    where.push(inArray(findings.severity, SEVERITIES.slice(0, SEVERITIES.indexOf(input.severity_min) + 1)));
  if (input.category) where.push(eq(findings.category, input.category));
  if (input.scope) where.push(eq(findings.scope, input.scope));
  if (input.codes?.length) {
    const aliases = await db.select().from(checkTypeAliases).where(inArray(checkTypeAliases.oldCode, input.codes));
    where.push(inArray(findings.code, [...input.codes, ...aliases.map((a) => a.code)]));
  }
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(...where));
  const page: SQL[] = [...where];
  if (input.cursor) {
    const [rank, occurrences, id] = decodeCursor(input.cursor);
    page.push(
      or(
        sql`${SEV_ORDER} > ${rank}`,
        and(sql`${SEV_ORDER} = ${rank}`, lt(findings.occurrences, occurrences)),
        and(sql`${SEV_ORDER} = ${rank}`, eq(findings.occurrences, occurrences), gt(findings.id, id)),
      )!,
    );
  }
  const limit = input.limit ?? 50;
  const rows = await db
    .select({
      id: findings.id,
      code: findings.code,
      params: findings.params,
      title: findings.title,
      severity: findings.severity,
      category: findings.category,
      scope: findings.scope,
      occurrences: findings.occurrences,
      pages_total: findings.pagesTotal,
    })
    .from(findings)
    .where(and(...page))
    .orderBy(SEV_ORDER, desc(findings.occurrences), asc(findings.id))
    .limit(limit + 1);
  const out = rows.slice(0, limit);
  return {
    ...used,
    findings: out,
    count: out.length,
    total: counted?.n ?? 0,
    next_cursor: rows.length > limit ? encodeCursor(out[out.length - 1]!) : null,
  };
}

export async function getRecommendations(db: Db, principal: Principal, raw: Record<string, unknown>) {
  const { used } = await resolveAudit(db, principal, raw);
  const input = z
    .object({
      quick_wins_only: z.boolean().nullish(),
      effort_max: z.string().nullish(),
      limit: z.number().int().min(1).max(500).nullish(),
    })
    .parse(raw);
  const rows = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.auditId, used.audit_id))
    .orderBy(asc(recommendations.rank));
  const minutes = (e: string | null) => {
    const m = e?.match(/(\d+)\s*(minute|min|hour|h|day|d)/i);
    if (!m) return null;
    const n = Number(m[1]);
    return /^h/i.test(m[2]!) ? n * 60 : /^d/i.test(m[2]!) ? n * 480 : n;
  };
  const max = input.effort_max ? minutes(input.effort_max) : null;
  const out = rows
    .filter((r) => !input.quick_wins_only || r.quickWin)
    .filter((r) => max === null || (minutes(r.effort) ?? 0) <= max)
    .slice(0, input.limit ?? 50)
    .map((r) => ({
      rank: r.rank,
      title: r.title,
      codes: r.codes,
      impact: r.impact,
      effort: r.effort,
      quick_win: r.quickWin,
      fix: r.fix,
      pages_affected: r.pagesAffected,
    }));
  return { ...used, recommendations: out };
}

export async function getSiteChecks(db: Db, principal: Principal, raw: Record<string, unknown>) {
  const { used } = await resolveAudit(db, principal, raw, { excludeModes: ['page'] });
  const input = z.object({ check_ids: z.array(z.string()).nullish(), status: z.string().nullish() }).parse(raw);
  const where: SQL[] = [eq(siteChecks.auditId, used.audit_id)];
  if (input.check_ids?.length) where.push(inArray(siteChecks.checkId, input.check_ids));
  if (input.status) where.push(eq(siteChecks.status, input.status));
  const rows = await db
    .select()
    .from(siteChecks)
    .where(and(...where))
    .orderBy(asc(siteChecks.checkId));
  return {
    ...used,
    checks: rows.map((r) => ({
      check_id: r.checkId,
      label: r.label,
      status: r.status,
      note: r.note,
      details: r.details,
    })),
  };
}

export async function getTechStack(db: Db, principal: Principal, raw: Record<string, unknown>) {
  const { used, row } = await resolveAudit(db, principal, raw, { excludeModes: ['page'] });
  const input = z.object({ kinds: z.array(z.string()).nullish() }).parse(raw);
  const blind = used.scan_quality === 'blocked' && !row.homepageRead;
  const where: SQL[] = [eq(technologies.auditId, used.audit_id)];
  if (input.kinds?.length) where.push(inArray(technologies.kind, input.kinds));
  const techs = blind
    ? []
    : await db
        .select()
        .from(technologies)
        .where(and(...where))
        .orderBy(asc(technologies.kind), asc(technologies.name));
  const ids = await db.select().from(trackingIds).where(eq(trackingIds.auditId, used.audit_id));
  return {
    ...used,
    technologies: techs.map((t) => ({
      name: t.name,
      kind: t.kind,
      version: t.version,
      confidence: t.confidence,
      eol_date: t.eolDate,
    })),
    tracking_ids: ids.map((t) => ({ kind: t.kind, value: t.value, pages_seen: t.pagesSeen, sends_hits: t.sendsHits })),
  };
}

export async function listCheckTypes(db: Db, principal: Principal, raw: Record<string, unknown> = {}) {
  requireScope(principal, 'audits:read');
  const input = z
    .object({ family: z.string().nullish(), category: z.string().nullish(), derived: z.boolean().nullish() })
    .parse(raw);
  const where: SQL[] = [];
  if (input.family) where.push(eq(checkTypes.family, input.family));
  if (input.category) where.push(eq(checkTypes.category, input.category));
  if (input.derived != null) where.push(eq(checkTypes.derived, input.derived));
  const rows = await db
    .select()
    .from(checkTypes)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(checkTypes.code))
    .limit(2000);
  return {
    check_types: rows.map((r) => ({
      code: r.code,
      title: r.title,
      family: r.family,
      category: r.category,
      default_severity: r.defaultSeverity,
      derived: r.derived,
    })),
  };
}

/** Stale audits of a score trend re-scored by one `get_site` call. */
const TREND_RESCORES_PER_READ = 5;

export async function getSite(db: Db, principal: Principal, raw: Record<string, unknown>) {
  const { used, row } = await resolveAudit(db, principal, raw);
  const aliases = await listAliases(db, row.siteId);
  const perMode = await db
    .select({ mode: audits.mode, n: sql<number>`count(*)::int`, last: sql<Date>`max(${audits.finishedAt})` })
    .from(audits)
    .where(and(eq(audits.siteId, row.siteId), eq(audits.status, 'succeeded')))
    .groupBy(audits.mode);
  // Scores are brought up to the current scoring code before they are returned. The trend's other
  // audits are re-scored a few per read (the cron does the rest) and only audits scored with the
  // same code as this one are in it, so a trend never mixes scoring versions.
  const comparable = and(
    eq(audits.siteId, row.siteId),
    eq(audits.status, 'succeeded'),
    eq(audits.comparableKey, row.comparableKey),
  );
  await ensureScored(db, null, [used.audit_id]);
  const others = await db
    .select({ id: audits.id })
    .from(audits)
    .where(comparable)
    .orderBy(desc(audits.finishedAt))
    .limit(50);
  await ensureScored(
    db,
    null,
    others.map((o) => o.id),
    { max: TREND_RESCORES_PER_READ },
  );
  const [scored] = await db.select({ version: audits.scoringVersion }).from(audits).where(eq(audits.id, used.audit_id));
  const scoreRows = await db.select().from(scores).where(eq(scores.auditId, used.audit_id));
  const [profile] = await db.select().from(siteProfiles).where(eq(siteProfiles.auditId, used.audit_id));
  const stack = await getTechStack(db, principal, { audit_id: used.audit_id });
  const trend = scored?.version
    ? await db
        .select({ audit_id: audits.id, finished_at: audits.finishedAt, score: scores.score })
        .from(audits)
        .innerJoin(scores, and(eq(scores.auditId, audits.id), eq(scores.category, 'overall')))
        .where(and(comparable, eq(audits.scoringVersion, scored.version)))
        .orderBy(asc(audits.finishedAt))
        .limit(50)
    : [];
  let prospect = null;
  if (hasScope(principal, 'prospects:read')) {
    const [p] = await db
      .select({
        company: prospects.company,
        stage: prospects.stage,
        fit_score: prospects.fitScore,
        do_not_contact: prospects.doNotContact,
      })
      .from(prospects)
      .where(sql`${prospects.registrableDomains} && array[${registrableDomainOf(used.domain)}]::text[]`)
      .limit(1);
    prospect = p ?? null;
  }
  return {
    ...used,
    host: used.domain,
    aliases,
    audits_per_mode: perMode.map((m) => ({
      mode: m.mode,
      count: m.n,
      latest: m.last ? new Date(m.last).toISOString() : null,
    })),
    scores: Object.fromEntries(scoreRows.map((s) => [s.category, s.score])),
    scoring_version: scored?.version ?? null,
    scores_current: scored?.version === scoringVersion(),
    stack: stack.technologies,
    tracking_ids: stack.tracking_ids,
    site_profile: profile
      ? {
          languages: profile.languages,
          multilang: profile.multilang,
          ai_crawler_rules: profile.aiCrawlerRules,
          llms_txt: profile.llmsTxt,
          schema_types: profile.schemaTypes,
          http_version: profile.httpVersion,
          cdn: profile.cdn,
          security_headers: profile.securityHeaders,
          has_contact_form: profile.hasContactForm,
          booking_links: profile.bookingLinks,
          ctas: profile.ctas,
        }
      : null,
    homepage_screenshot: profile?.homepageScreenshotArtifactId
      ? `/internal/audits/${used.audit_id}/a/${profile.homepageScreenshotArtifactId}`
      : null,
    prospect,
    score_trend: trend.map((t) => ({
      audit_id: t.audit_id,
      finished_at: t.finished_at?.toISOString() ?? null,
      overall: t.score,
    })),
  };
}

export async function fieldMetricRows(db: Db, auditId: string) {
  return db.select().from(fieldMetrics).where(eq(fieldMetrics.auditId, auditId));
}

export async function artifactCount(db: Db, auditId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(and(eq(artifacts.auditId, auditId), ne(artifacts.kind, 'evidence')));
  return r?.n ?? 0;
}
