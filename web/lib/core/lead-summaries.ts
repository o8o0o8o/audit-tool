/**
 * Every lead summary in one call: reads the `lead_summary` view (one row per succeeded full or quick
 * audit, public scans left out) or `lead_summary_latest` (the newest per site and scan type). The
 * view is the signal set; this only filters, pages and shapes its rows.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { LeadSummaryRow } from '@model/lead-summary';
import type { Db } from '../../db/client';
import { CoreError } from './errors';
import { hasScope, requireScope, type Principal } from './principal';

export const ListLeadSummariesInput = z.object({
  latest_only: z.boolean().default(true).describe('Only the newest audit of each site and scan type'),
  mode: z.enum(['full', 'quick']).optional(),
  domain: z.string().max(253).optional().describe('Part of the domain'),
  scan_quality: z.enum(['ok', 'partial', 'blocked']).optional(),
  teaser_ready: z.boolean().optional(),
  outreach_blocked: z.boolean().optional(),
  min_heavy_facts: z.number().int().min(0).optional(),
  max_overall_score: z.number().int().min(0).max(100).optional(),
  prospect_stage: z.string().max(60).optional().describe('Needs prospects:read'),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().max(100).optional(),
});

type Row = Record<string, unknown>;
const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null;
const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function shape(r: Row, withProspect: boolean): LeadSummaryRow {
  return {
    audit_id: String(r.audit_id),
    domain: String(r.domain),
    host: String(r.host),
    mode: r.mode as 'full' | 'quick',
    source: String(r.source),
    scanned_at: iso(r.scanned_at),
    scan_quality: r.scan_quality as 'ok' | 'partial' | 'blocked',
    pages_read: Number(r.pages_read),
    pages_blocked: Number(r.pages_blocked),
    bot_protection: (r.bot_protection as string | null) ?? null,
    outreach_blocked: r.outreach_blocked === true,
    prospect:
      withProspect && r.prospect_company
        ? {
            company: String(r.prospect_company),
            stage: (r.prospect_stage as string | null) ?? null,
            fit_score: int(r.prospect_fit_score),
            do_not_contact: r.do_not_contact === true,
          }
        : null,
    scores: {
      overall: int(r.score_overall),
      seo: int(r.score_seo),
      performance: int(r.score_performance),
      accessibility: int(r.score_accessibility),
      security: int(r.score_security),
      technical: int(r.score_technical),
      agentic: int(r.score_agentic),
      performance_source: (r.performance_source as string | null) ?? null,
    },
    issues: {
      total: Number(r.issues_total),
      critical: Number(r.issues_critical),
      high: Number(r.issues_high),
      by_category: (r.issues_by_category as Record<string, number>) ?? {},
    },
    facts: {
      heavy: Number(r.facts_heavy),
      medium: Number(r.facts_medium),
      light: Number(r.facts_light),
      top: (r.top_facts as LeadSummaryRow['facts']['top']) ?? [],
      gate_run_at: iso(r.gate_run_at),
      teaser_ready: r.teaser_ready === true,
    },
    field_speed: {
      lcp_p75: int(r.lcp_p75),
      inp_p75: int(r.inp_p75),
      cls_p75: int(r.cls_p75),
      cwv_pass: (r.cwv_pass as boolean | null) ?? null,
    },
    stack: {
      cms: (r.cms as string | null) ?? null,
      framework: (r.framework as string | null) ?? null,
      cdn: (r.cdn as string | null) ?? null,
      consent_tool: (r.consent_tool as string | null) ?? null,
      eol_software: (r.eol_software as string[] | null) ?? [],
      vulnerable_js_libraries: Number(r.vulnerable_js_libraries),
    },
    tracking: {
      has_ga4: r.has_ga4 === true,
      has_gtm: r.has_gtm === true,
      has_meta_pixel: r.has_meta_pixel === true,
      ga4_sends_hits: (r.ga4_sends_hits as boolean | null) ?? null,
    },
    site: {
      languages: (r.languages as string[] | null) ?? [],
      multilang: r.multilang === true,
      has_contact_form: (r.has_contact_form as boolean | null) ?? null,
      has_booking_link: r.has_booking_link === true,
      llms_txt: (r.llms_txt as string | null) ?? null,
      ai_crawlers_blocked: Number(r.ai_crawlers_blocked),
    },
    email: { spf: (r.spf as string | null) ?? null, dmarc: (r.dmarc as string | null) ?? null },
    quick_wins: (r.quick_wins as LeadSummaryRow['quick_wins']) ?? [],
    links: {
      report: String(r.report_path),
      homepage_screenshot: (r.homepage_screenshot_path as string | null) ?? null,
    },
  };
}

export async function listLeadSummaries(
  db: Db,
  principal: Principal,
  raw: unknown,
): Promise<{ summaries: LeadSummaryRow[]; count: number; next_cursor: string | null }> {
  requireScope(principal, 'audits:read');
  const input = ListLeadSummariesInput.parse(raw ?? {});
  const withProspect = hasScope(principal, 'prospects:read');
  if (input.prospect_stage && !withProspect) throw new CoreError('forbidden', 'prospect_stage needs prospects:read');

  const where: SQL[] = [];
  if (input.mode) where.push(sql`mode = ${input.mode}`);
  if (input.domain) where.push(sql`position(${input.domain.toLowerCase()} in domain) > 0`);
  if (input.scan_quality) where.push(sql`scan_quality = ${input.scan_quality}`);
  if (input.teaser_ready !== undefined) where.push(sql`teaser_ready = ${input.teaser_ready}`);
  if (input.outreach_blocked !== undefined) where.push(sql`outreach_blocked = ${input.outreach_blocked}`);
  if (input.min_heavy_facts !== undefined) where.push(sql`facts_heavy >= ${input.min_heavy_facts}`);
  if (input.max_overall_score !== undefined) where.push(sql`score_overall <= ${input.max_overall_score}`);
  if (input.prospect_stage) where.push(sql`prospect_stage = ${input.prospect_stage}`);
  if (input.cursor) {
    const [at, id] = input.cursor.split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !z.uuid().safeParse(id).success)
      throw new CoreError('invalid_input', 'cursor is not valid');
    where.push(sql`(scanned_at, audit_id) < (${at}::timestamptz, ${id}::uuid)`);
  }
  const view = input.latest_only ? sql`lead_summary_latest` : sql`lead_summary`;
  const res = await db.execute(
    sql`select * from ${view} ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
        order by scanned_at desc, audit_id desc limit ${input.limit + 1}`,
  );
  const rows = res.rows as Row[];
  const page = rows.slice(0, input.limit).map((r) => shape(r, withProspect));
  const last = page[page.length - 1];
  return {
    summaries: page,
    count: page.length,
    next_cursor: rows.length > input.limit && last?.scanned_at ? `${last.scanned_at}|${last.audit_id}` : null,
  };
}
