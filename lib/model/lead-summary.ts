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

/**
 * One row of the `lead_summary` view (migration `0011_lead_summary_views`): the default signal set
 * of a site, from one audit. `list_lead_summaries` returns these. To change the set, replace the
 * view in a new migration and this schema with it.
 */
export const LeadSummaryRow = z.object({
  audit_id: z.string(),
  domain: z.string(),
  host: z.string(),
  mode: z.enum(['full', 'quick']),
  source: z.string(),
  scanned_at: z.string().nullable(),
  scan_quality: z.enum(['ok', 'partial', 'blocked']),
  pages_read: z.number().int(),
  pages_blocked: z.number().int(),
  bot_protection: z.string().nullable(),
  outreach_blocked: z.boolean().describe('The site has an open disclosure: do not start outreach'),
  prospect: z
    .object({
      company: z.string(),
      stage: z.string().nullable(),
      fit_score: z.number().int().nullable(),
      do_not_contact: z.boolean(),
    })
    .nullable()
    .describe('With prospects:read, when the domain is a prospect'),
  scores: z
    .object({
      overall: z.number().int().nullable(),
      seo: z.number().int().nullable(),
      performance: z.number().int().nullable(),
      accessibility: z.number().int().nullable(),
      security: z.number().int().nullable(),
      technical: z.number().int().nullable(),
      agentic: z.number().int().nullable(),
      performance_source: z.string().nullable().describe('lab or field'),
    })
    .describe('All null for a blocked scan'),
  issues: z
    .object({
      total: z.number().int(),
      critical: z.number().int(),
      high: z.number().int(),
      by_category: z.record(z.string(), z.number().int()),
    })
    .describe('Unverified findings, for triage; zero for a blocked scan'),
  facts: z
    .object({
      heavy: z.number().int(),
      medium: z.number().int(),
      light: z.number().int(),
      top: z.array(z.object({ type: z.string(), weight: z.string(), fact: z.string(), url: z.string().nullable() })),
      gate_run_at: z.string().nullable(),
      teaser_ready: z.boolean(),
    })
    .describe('Gate-verified facts of the latest gate run; `top` is the three heaviest'),
  field_speed: z
    .object({
      lcp_p75: z.number().nullable(),
      inp_p75: z.number().nullable(),
      cls_p75: z.number().nullable(),
      cwv_pass: z.boolean().nullable(),
    })
    .describe('Real-user data for the whole site; null when Google has none'),
  stack: z.object({
    cms: z.string().nullable(),
    framework: z.string().nullable(),
    cdn: z.string().nullable(),
    consent_tool: z.string().nullable(),
    eol_software: z.array(z.string()).describe('Software past its end of life at scan time'),
    vulnerable_js_libraries: z.number().int(),
  }),
  tracking: z.object({
    has_ga4: z.boolean(),
    has_gtm: z.boolean(),
    has_meta_pixel: z.boolean(),
    ga4_sends_hits: z.boolean().nullable(),
  }),
  site: z.object({
    languages: z.array(z.string()),
    multilang: z.boolean(),
    has_contact_form: z.boolean().nullable(),
    has_booking_link: z.boolean(),
    llms_txt: z.string().nullable(),
    ai_crawlers_blocked: z.number().int().describe('AI crawlers that robots.txt disallows'),
  }),
  email: z.object({ spf: z.string().nullable(), dmarc: z.string().nullable() }).describe('pass, warn, fail or skipped'),
  quick_wins: z.array(z.object({ title: z.string(), impact: z.string().nullable(), effort: z.string().nullable() })),
  links: z.object({ report: z.string(), homepage_screenshot: z.string().nullable() }),
});
export type LeadSummaryRow = z.infer<typeof LeadSummaryRow>;
