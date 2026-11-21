/**
 * The site part of the AuditModel (design §2): one document per audit, stored in
 * `audit_documents` and repeated in part as filterable rows. Every field has a description, so
 * `z.toJSONSchema(SiteDocument)` reads as the model's documentation (`describe_model`).
 */
import { z } from 'zod';

const Severity = z.enum(['critical', 'high', 'medium', 'low']).describe('Severity, lower-case');
const nullableInt = z.number().int().nullable();

export const ScanQuality = z
  .object({
    state: z
      .enum(['ok', 'partial', 'blocked'])
      .describe(
        'ok; partial: 10–50 % of pages blocked or probes blocked; blocked: homepage unreadable or ≥ 50 % blocked',
      ),
    reasons: z.array(z.string()).describe('Why the state is not ok, in plain words'),
    homepageRead: z.boolean().describe('The homepage (or, for a single-page audit, the page) was read'),
    pagesRequested: z.number().int().describe('Pages the crawl asked for'),
    pagesOk: z.number().int().describe('Pages answered 2xx and not challenged'),
    pagesBlocked: z.number().int().describe('Pages answered 401/403/429 or a bot challenge'),
    pagesFailed: z.number().int().describe('Pages that failed otherwise (4xx/5xx, network errors)'),
    errorsByType: z
      .record(z.string(), z.number().int())
      .describe('Failed pages by error key (status code, challenge-503, ERR_…)'),
    botProtection: z.string().nullable().describe('Bot-protection vendor when visible'),
    sitemapTotal: nullableInt.describe('URLs listed in the sitemaps'),
    sitemapCrawled: nullableInt.describe('Sitemap URLs the crawl read'),
    probesBlocked: z.number().int().describe('Site checks that could not run because the site refused them'),
  })
  .describe(
    'How much of the site the scan could read. Findings from blocked pages are dropped; a blocked scan has no scores.',
  );
export type ScanQuality = z.infer<typeof ScanQuality>;

export const Score = z.object({
  category: z.string().describe("'overall', 'seo', 'performance', 'accessibility', 'security', 'technical', 'agentic'"),
  score: nullableInt.describe('0–100; null for a blocked scan'),
  source: z
    .enum(['lab', 'field', 'findings'])
    .nullable()
    .describe('Performance only: lab run, real-user (CrUX) data, or findings'),
});

export const Finding = z.object({
  id: z.string().describe('Stable id from audit, code and params'),
  code: z.string().describe('check_types.code; derived from the title when not explicit'),
  params: z.record(z.string(), z.unknown()).describe('Values taken out of the title: numbers, quoted values, URLs'),
  title: z.string().describe('The finding as the report shows it'),
  severity: Severity,
  category: z.string().describe('Report section: performance, seo, privacy, accessibility, ux, technical, agentic'),
  scope: z.enum(['page', 'site']).describe('page: raised per page; site: one site-wide fact'),
  occurrences: z.number().int().describe('How many times it was raised'),
  pagesTotal: nullableInt.describe('Pages it was checked on, when known'),
  examples: z.array(z.string()).describe('Up to 3 examples as plain text (full occurrences arrive with page rows)'),
});
export type Finding = z.infer<typeof Finding>;

export const Recommendation = z.object({
  rank: z.number().int().describe('1 = highest impact'),
  title: z.string(),
  codes: z.array(z.string()).describe('Finding codes this fix resolves'),
  impact: z.string().nullable().describe('High / Medium / Low'),
  effort: z.string().nullable().describe('Estimated effort, e.g. "30 minutes"'),
  quickWin: z.boolean().describe('High impact, low effort'),
  fix: z.string().nullable().describe('What to do'),
  pagesAffected: nullableInt,
});

export const SiteCheck = z.object({
  checkId: z.string().describe('e.g. spf, dmarc, exposed-files, js-libraries'),
  label: z.string(),
  status: z.string().describe('pass, warn, fail or skipped'),
  note: z.string().nullable(),
  details: z.unknown().nullable().describe('Check-specific detail rows'),
});

export const SiteProfile = z.object({
  languages: z.array(z.string()).describe('Languages declared in <html lang> across pages'),
  multilang: z.boolean().nullable(),
  aiCrawlerRules: z
    .record(z.string(), z.string())
    .nullable()
    .describe('robots.txt rules per AI crawler: allowed / disallowed / not set'),
  llmsTxt: z.enum(['valid', 'invalid', 'missing']).nullable(),
  schemaTypes: z.array(z.string()).describe('Schema.org types seen'),
  httpVersion: z.string().nullable(),
  cdn: z.string().nullable(),
  securityHeaders: z.array(z.string()).describe('Security headers present on the homepage'),
  hasContactForm: z.boolean().nullable(),
  formProviders: z.array(z.string()),
  ctas: z
    .array(z.object({ text: z.string(), href: z.string().nullable(), aboveFold: z.boolean().nullable() }))
    .describe('Homepage calls to action'),
  bookingLinks: z.array(z.string()).describe('Links to booking / scheduling tools'),
  homepageScreenshot: z.string().nullable().describe('Run-folder path of the homepage screenshot'),
});

export const FieldMetric = z.object({
  scope: z.enum(['origin', 'url']),
  url: z.string().nullable(),
  formFactor: z.string(),
  lcpP75: nullableInt,
  clsP75: z.number().nullable(),
  inpP75: nullableInt,
  ttfbP75: nullableInt,
  fcpP75: nullableInt,
});

export const Technology = z.object({
  name: z.string(),
  kind: z
    .string()
    .describe(
      'cms, framework, library, runtime, server, cdn, hosting, analytics, tag_manager, consent, session_replay, chat, ads, forms, crm, ab_testing, search, other',
    ),
  version: z.string().nullable(),
  confidence: z.string().nullable(),
  eolDate: z.string().nullable().describe('End-of-life date (YYYY-MM-DD) when the version is past or near it'),
  evidence: z.unknown().nullable(),
});

export const TrackingId = z.object({
  kind: z.enum(['ga4', 'gtm', 'meta_pixel', 'ua', 'ads', 'other']),
  value: z.string(),
  pagesSeen: nullableInt,
  sendsHits: z.boolean().nullable(),
});

export const LeadFact = z.object({
  type: z.string().describe('Lead finding type (lib/leads/sales-signals.ts ALLOWLIST)'),
  rootCause: z.string(),
  weight: z.enum(['heavy', 'medium', 'light']),
  fact: z.string().describe('One sentence, facts only'),
  url: z.string().nullable(),
  gate: z.enum(['pass', 'fail']),
  dependsOn: z
    .enum(['pages', 'homepage', 'dns'])
    .describe('What a blocked scan may still report: dns always, homepage when read, pages never'),
  evidence: z.unknown(),
});

export const GateRun = z.object({
  runAt: z.string(),
  source: z.enum(['workflow', 'pipeline']),
  teaserReady: z.boolean(),
  facts: z.array(LeadFact),
  candidatesDropped: z.array(z.unknown()),
  previous: z.unknown().nullable(),
  disclosure: z.array(z.unknown()).describe('Security exposures to disclose before any outreach'),
});

export const SiteDocument = z
  .object({
    modelVersion: z.string().describe('AuditModel version, major.minor.patch'),
    audit: z.object({
      mode: z.enum(['full', 'quick', 'page']),
      targetUrl: z.string(),
      domain: z.string(),
      runFolder: z.string().describe('<domain>/<timestamp> of the raw run'),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      elapsedMs: nullableInt,
      passive: z.boolean(),
      profile: z.enum(['public', 'standard']).nullable(),
      preset: z.string().nullable(),
      perf: z.boolean(),
      visual: z.boolean(),
    }),
    scanQuality: ScanQuality,
    scores: z.array(Score),
    counts: z.object({
      total: z.number().int(),
      bySeverity: z.record(Severity, z.number().int()),
      byCategory: z.record(z.string(), z.number().int()),
    }),
    findings: z.array(Finding),
    recommendations: z.array(Recommendation),
    siteChecks: z.array(SiteCheck),
    siteProfile: SiteProfile,
    fieldMetrics: z.array(FieldMetric),
    robots: z.object({ sitemaps: z.array(z.string()), userAgents: z.array(z.string()) }),
    sitemaps: z.object({ total: nullableInt }),
    pages: z.object({ crawled: z.number().int(), ok: z.number().int() }),
    leadScan: z
      .object({
        cap: nullableInt,
        selected: z.array(z.object({ url: z.string(), reason: z.string().nullable() })),
        requests: nullableInt,
      })
      .nullable()
      .describe('Quick scans: the pages picked and why'),
    stack: z
      .object({
        kind: z.string().nullable(),
        confidence: z.string().nullable(),
        technologies: z.array(Technology),
        trackingIds: z.array(TrackingId),
      })
      .nullable()
      .describe(
        'From the fingerprint step (homepage + robots.txt) and the crawl; null when the fingerprint did not run',
      ),
    gateRuns: z.array(GateRun).describe('Truth-gate runs, oldest first'),
    disclosures: z
      .array(z.object({ code: z.string(), target: z.string() }))
      .describe('Security exposures (standard profile only)'),
  })
  .describe('The site part of one audit');
export type SiteDocument = z.infer<typeof SiteDocument>;
