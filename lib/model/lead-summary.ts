/**
 * `get_lead_summary` output (design §5): a fixed, documented shape so a script maps fields 1:1 and
 * an agent knows what each field means. Published as the tool's output schema.
 */
import { z } from 'zod';
import { FieldMetric, LeadFact, Technology, TrackingId } from './site';

export const LeadSummary = z
  .object({
    audit_id: z.string(),
    mode: z.enum(['full', 'quick', 'page']),
    scanned_at: z.string().nullable(),
    domain: z.string(),
    scan_quality: z.object({
      state: z.enum(['ok', 'partial', 'blocked']),
      reasons: z.array(z.string()),
      pages_read: z.number().int(),
      pages_blocked: z.number().int(),
    }),
    outreach_blocked: z.boolean().describe('True when the site has an open disclosure: do not start outreach'),
    disclosure: z
      .object({ status: z.string(), since: z.string() })
      .nullable()
      .describe('Status and date only, no detail'),
    facts: z.array(LeadFact).describe('Gate-passed facts from the latest gate run, heaviest first; never raw findings'),
    gate_run_at: z
      .string()
      .nullable()
      .describe('When those facts were checked; a teaser still needs a same-day re-check'),
    teaser_ready: z.boolean(),
    unverified_findings: z
      .array(z.object({ code: z.string(), title: z.string(), severity: z.string(), occurrences: z.number().int() }))
      .describe('Top findings by severity, for internal triage only; not verified'),
    quick_wins: z
      .array(z.object({ title: z.string(), impact: z.string().nullable(), effort: z.string().nullable() }))
      .describe('Top 3 recommendations'),
    stack: z
      .array(Technology)
      .describe(
        'CMS, framework, libraries with versions and EOL; empty for a blocked scan whose homepage was not read',
      ),
    vendors: z.record(z.string(), z.array(z.string())).describe('Vendor names by kind'),
    tracking_ids: z.array(TrackingId),
    site_profile: z.object({
      languages: z.array(z.string()),
      has_contact_form: z.boolean().nullable(),
      booking_links: z.array(z.string()),
      ai_crawler_rules: z.record(z.string(), z.string()).nullable(),
      llms_txt: z.string().nullable(),
    }),
    scores: z.record(z.string(), z.number().int().nullable()).nullable().describe('null for a blocked scan'),
    field_metrics: z.array(
      FieldMetric.extend({ pass: z.boolean().nullable().describe('All Core Web Vitals within Google thresholds') }),
    ),
    counts: z.record(z.string(), z.number().int()).describe('Findings by category'),
    links: z.object({
      report: z.string().describe('Permanent internal address of the audit (login required)'),
      homepage_screenshot: z.string().nullable(),
    }),
    prospect: z
      .object({
        company: z.string(),
        stage: z.string(),
        fit_score: z.number().int().nullable(),
        do_not_contact: z.boolean(),
      })
      .nullable()
      .describe('With prospects:read'),
  })
  .describe('What lead enrichment needs about one site, from one audit');
export type LeadSummary = z.infer<typeof LeadSummary>;
