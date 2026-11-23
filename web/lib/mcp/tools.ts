/**
 * MCP tool definitions (design §5): name, description, zod input, a call into lib/core. Every tool
 * describes itself well enough for an agent to pick it; results are plain typed data.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { answerText, capDetails, SERVER_INSTRUCTIONS, shortLeadRow, slimAudit, slimAuditRow } from './thrift';
import { z } from 'zod';
import type { Db } from '../../db/client';
import type { Platform } from '../platform/types';
import {
  cancelAudit,
  continueAudit,
  getAudit,
  listAudits,
  startAudit,
  WAIT_MAX_SECONDS,
  waitForAudit,
} from '../core/audits';
import { CoreError } from '../core/errors';
import { requestPdf } from '../core/jobs';
import { raiseWork } from '../core/cron-gate';
import { getLeadSummary } from '../core/lead-summary';
import { listLeadSummaries, ListLeadSummariesInput } from '../core/lead-summaries';
import type { Principal } from '../core/principal';
import { getProspect, listProspects } from '../core/prospects';
import { dispatchNext } from '../core/queue';
import { reportUrl, REPORT_KINDS, type ReportKind } from '../core/reports';
import {
  getRecommendations,
  getSite,
  getSiteChecks,
  getTechStack,
  listCheckTypes,
  listFindings,
} from '../core/results';
import { onAuditFinished } from '../core/webhooks';

export interface McpDeps {
  db: Db;
  platform: Platform;
  principal: Principal;
  appUrl: string;
  reportSecret: string;
}

/** One copy of the answer, as compact text (see thrift.ts). */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: answerText(data) }] };
}

function fail(err: unknown) {
  if (err instanceof CoreError)
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ error: err.code, message: err.message }) }],
    };
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] })?.issues;
  if (Array.isArray(issues))
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'invalid_input',
            message: issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '),
          }),
        },
      ],
    };
  console.error('[mcp]', err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'internal', message: 'internal error' }) }],
  };
}

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

const target = {
  audit_id: z.string().optional().describe('Audit id (UUID). Give this or domain.'),
  domain: z
    .string()
    .optional()
    .describe('Site domain, e.g. acme.com. The newest succeeded audit with the data is used.'),
  mode: z.enum(['full', 'quick', 'page']).optional().describe('Only use audits of this mode (with domain)'),
};

export function buildMcpServer(d: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'audit-platform', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const { db, principal } = d;
  const finished = (id: string) => onAuditFinished(db, id);

  server.registerTool(
    'start_audit',
    {
      title: 'Start an audit',
      description:
        'Queue an SEO/technical audit of a site. mode=quick: passive 25-page scan (~4 min, most common for lead enrichment); mode=page: one page; mode=full: whole site (needs audits:start:full). ' +
        'Returns at once with audit_id and estimate_minutes; then call wait_for_audit once with timeout_seconds=280 (or rely on the webhook) instead of polling. reused tells you when an existing audit was returned instead: idempotent (same idempotency_key), in_progress (your audit of this site is running), recent (a finished one newer than reuse_if_newer_than_hours — read it at once). Refused with do_not_contact for sites that must not be scanned.',
      inputSchema: {
        url: z.string().describe('Site (any page of it); for mode=page the exact page URL'),
        mode: z.enum(['quick', 'page', 'full']),
        preset: z.string().optional().describe('Optional preset: quick, standard, deep, sales, marketing, seo, custom'),
        options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'perf, visual, pdf (needs audits:pdf), limit, maxPages (page cap of a full audit: default 5000, 0 = none), concurrency, evidenceCap, llm/verify/contentResearch (full only)',
          ),
        external_ref: z.string().optional().describe('Your own reference, echoed in webhooks and list_audits'),
        idempotency_key: z.string().optional().describe('Same key from the same client returns the first audit'),
        reuse_if_newer_than_hours: z
          .number()
          .optional()
          .describe('Return a succeeded audit of the same site and settings if newer than this'),
      },
    },
    wrap(async (a) => {
      const res = await startAudit(db, principal, a);
      if (res.status === 'queued' && !res.reused) await raiseWork(d.platform.files);
      if (res.status === 'queued' && !res.reused)
        await dispatchNext(db, d.platform, { onFinished: finished, max: 2 }).catch(() => {});
      return res;
    }),
  );

  server.registerTool(
    'get_audit',
    {
      title: 'Get an audit',
      description:
        'Status, phase, progress, timings, options, scores, scan quality, page cap, the kinds of report it has (open one with get_report_url) and a count of its other stored files.',
      inputSchema: { audit_id: z.string() },
    },
    wrap(async (a) => slimAudit(await getAudit(db, principal, a.audit_id))),
  );

  server.registerTool(
    'wait_for_audit',
    {
      title: 'Wait for an audit',
      description:
        'Holds the call until the audit finishes or timeout_seconds pass (default 50, max 280), then returns a short answer: status, pages done, eta_seconds (estimated time left) and next_step (what to do now); scores are added once it has finished. ' +
        'A quick scan or single page takes 1-4 minutes: call once with timeout_seconds=280 and it normally returns finished. A full audit can take from minutes to hours: follow next_step, which says whether one more call will see the end or you should tell the user the time left and come back later. Do not poll get_audit or list_audits in a loop to wait. ' +
        'If your client cuts tool calls short (some stop at 60 s), use a smaller timeout_seconds.',
      inputSchema: { audit_id: z.string(), timeout_seconds: z.number().min(1).max(WAIT_MAX_SECONDS).optional() },
    },
    wrap(async (a) => waitForAudit(db, principal, a.audit_id, { timeoutSeconds: a.timeout_seconds })),
  );

  server.registerTool(
    'list_audits',
    {
      title: 'List audits',
      description:
        'Audits newest first, 20 by default, filtered by domain, mode, status, source (public/internal/api/pipeline), external_ref or since (ISO date). Not for waiting: use wait_for_audit.',
      inputSchema: {
        domain: z.string().optional(),
        mode: z.enum(['full', 'quick', 'page']).optional(),
        status: z.string().optional(),
        source: z.enum(['public', 'internal', 'api', 'pipeline']).optional(),
        external_ref: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 20'),
      },
    },
    wrap(async (a) => {
      const rows = await listAudits(db, principal, { ...a, limit: a.limit ?? 20 });
      return { count: rows.length, audits: rows.map((r) => slimAuditRow(r)) };
    }),
  );

  server.registerTool(
    'continue_audit',
    {
      title: 'Continue a capped audit',
      description:
        'For a full audit the page cap stopped (get_audit / list_audits show page_cap): starts a new full audit of the same site with the same options and a higher cap. It keeps the pages already loaded and loads more; the first audit is not changed. Needs audits:start:full and audits:read. Returns a new audit_id (reused=in_progress when a continuation is already queued or running); then call wait_for_audit. Refused when the audit was not stopped by the cap, has not succeeded, or its stored run is no longer kept.',
      inputSchema: {
        audit_id: z.string().describe('The capped audit'),
        max_pages: z
          .number()
          .int()
          .min(0)
          .max(100000)
          .optional()
          .describe('New page cap: more than the cap that stopped the audit, or 0 for none. Default: twice that cap'),
      },
    },
    wrap(async (a) => {
      const res = await continueAudit(db, principal, a);
      if (res.status === 'queued' && !res.reused) await raiseWork(d.platform.files);
      if (res.status === 'queued' && !res.reused)
        await dispatchNext(db, d.platform, { onFinished: finished, max: 2 }).catch(() => {});
      return res;
    }),
  );

  server.registerTool(
    'cancel_audit',
    {
      title: 'Cancel an audit',
      description: 'Cancels an audit you started (needs audits:cancel).',
      inputSchema: { audit_id: z.string() },
    },
    wrap(async (a) => {
      const res = await cancelAudit(db, principal, a.audit_id, {
        cancelRun: (id, at) => d.platform.dispatcher.cancel(id, at),
        onFinished: finished,
      });
      await raiseWork(d.platform.files);
      return res;
    }),
  );

  server.registerTool(
    'get_lead_summary',
    {
      title: 'Lead summary of a site',
      description:
        'What lead enrichment needs about one site: scan quality, gate-verified facts (heaviest first), whether outreach is blocked by an open security disclosure, quick wins, stack and vendors, tracking IDs, site profile, scores, field metrics, links. ' +
        'Check scan_quality.state: blocked means scores are null and only facts that do not depend on reading pages are listed. Never start outreach when outreach_blocked is true.',
      inputSchema: target,
    },
    wrap(async (a) => getLeadSummary(db, principal, a)),
  );

  server.registerTool(
    'list_lead_summaries',
    {
      title: 'Lead summaries of every site',
      description:
        'One short row per site (its latest full and latest quick audit; latest_only=false for every audit): scan quality, outreach_blocked, teaser_ready, overall score, issue counts, counts of gate-verified facts and the heaviest one, CMS, framework, Core Web Vitals pass, prospect stage. Public scans and single-page audits are not included. ' +
        'Filter by mode, domain, scan_quality, teaser_ready, outreach_blocked, min_heavy_facts, max_overall_score, prospect_stage. Newest first, 25 per page; next_cursor gives the next page. ' +
        'detail="full" returns every signal per row (all scores, issues per category, three facts, real-user speed, stack, tracking, site profile, SPF and DMARC, quick wins, links): use it with a small limit, or call get_lead_summary for one site. Never start outreach when outreach_blocked is true.',
      inputSchema: {
        ...ListLeadSummariesInput.shape,
        limit: z.number().int().min(1).max(500).optional().describe('Rows per page, default 25'),
        detail: z.enum(['short', 'full']).optional().describe('short (default) or full'),
      },
    },
    wrap(async ({ detail, ...a }) => {
      const res = await listLeadSummaries(db, principal, { ...a, limit: a.limit ?? 25 });
      return detail === 'full' ? res : { ...res, summaries: res.summaries.map(shortLeadRow) };
    }),
  );

  server.registerTool(
    'get_site',
    {
      title: 'Get a site',
      description:
        'Host, aliases, audits per mode, latest scores, stack and vendors, tracking IDs, site profile, homepage screenshot link, prospect state (with prospects:read) and the score trend over comparable audits.',
      inputSchema: target,
    },
    wrap(async (a) => getSite(db, principal, a)),
  );

  server.registerTool(
    'list_findings',
    {
      title: 'List findings',
      description:
        'Findings of an audit with code, params, title, severity and occurrence count, most severe first, 25 per page. Start with severity_min="high" unless the user wants everything. Filter by severity_min, category, codes (see list_check_types), scope. Returns `total` (all findings that match the filters), `count` (this page) and `next_cursor`: pass it back as `cursor` with the same filters for the next page; null on the last page. A blocked scan returns no findings.',
      inputSchema: {
        ...target,
        severity_min: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        category: z.string().optional().describe('performance, seo, privacy, accessibility, ux, technical, agentic'),
        codes: z.array(z.string()).optional(),
        scope: z.enum(['page', 'site']).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Page size, default 25'),
        cursor: z.string().optional().describe('next_cursor of the previous page'),
      },
    },
    wrap(async (a) => {
      const res = await listFindings(db, principal, { ...a, limit: a.limit ?? 25 });
      // The row id is of no use to a caller: no tool takes it.
      return { ...res, findings: res.findings.map(({ id: _id, ...f }) => f) };
    }),
  );

  server.registerTool(
    'get_tech_stack',
    {
      title: 'Tech stack',
      description:
        'Technologies and vendors (CMS, framework, libraries, CDN, analytics, consent…) with versions, confidence and end-of-life dates, and tracking IDs.',
      inputSchema: { ...target, kinds: z.array(z.string()).optional() },
    },
    wrap(async (a) => getTechStack(db, principal, a)),
  );

  server.registerTool(
    'get_recommendations',
    {
      title: 'Recommendations',
      description:
        'Fixes ranked by impact, with effort and the finding codes each resolves; the first 10. with_fix=true adds the how-to-fix text.',
      inputSchema: {
        ...target,
        quick_wins_only: z.boolean().optional(),
        effort_max: z.string().optional().describe('e.g. "2 hours"'),
        limit: z.number().int().optional().describe('Default 10'),
        with_fix: z.boolean().optional().describe('Include the how-to-fix text of each (long)'),
      },
    },
    wrap(async ({ with_fix, ...a }) => {
      const res = await getRecommendations(db, principal, { ...a, limit: a.limit ?? 10 });
      return with_fix ? res : { ...res, recommendations: res.recommendations.map(({ fix: _fix, ...r }) => r) };
    }),
  );

  server.registerTool(
    'get_site_checks',
    {
      title: 'Site checks',
      description:
        'Site-level check rows: email DNS (SPF, DMARC, DKIM…), exposed files, missing-page status, takeover, JS libraries, GTM, GA4 hits… Pass status="warn" or "fail", or check_ids, to see only what matters; long detail lists show their first 5 rows and details_total.',
      inputSchema: { ...target, check_ids: z.array(z.string()).optional(), status: z.string().optional() },
    },
    wrap(async (a) => {
      const res = await getSiteChecks(db, principal, a);
      return {
        ...res,
        checks: res.checks.map(({ details, ...c }) => ({
          ...c,
          // What passed or did not run has nothing to list; a long list shows its first rows and its length.
          ...(c.status === 'pass' || c.status === 'skipped' ? {} : capDetails(details)),
        })),
      };
    }),
  );

  server.registerTool(
    'list_check_types',
    {
      title: 'Finding vocabulary',
      description:
        'The finding codes used by list_findings: code, title and default severity. There are hundreds: give search (part of a code or title), category or family. Without a filter only the first 25 are returned, with the total.',
      inputSchema: {
        search: z.string().optional().describe('Part of a code or title'),
        family: z.string().optional(),
        category: z.string().optional(),
        derived: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 25'),
      },
    },
    wrap(async ({ search, limit, ...a }) => {
      const all = (await listCheckTypes(db, principal, a)).check_types;
      const q = search?.toLowerCase();
      const hits = q ? all.filter((c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) : all;
      return {
        total: hits.length,
        check_types: hits.slice(0, limit ?? 25).map((c) => ({
          code: c.code,
          title: c.title,
          default_severity: c.default_severity,
          ...(a.category ? {} : { category: c.category }),
        })),
      };
    }),
  );

  server.registerTool(
    'get_prospect',
    {
      title: 'Get a prospect',
      description: 'The prospect row for a domain (needs prospects:read), or null.',
      inputSchema: { domain: z.string() },
    },
    wrap(async (a) => ({ prospect: await getProspect(db, principal, a.domain) })),
  );

  server.registerTool(
    'list_prospects',
    {
      title: 'List prospects',
      description:
        'Prospect rows filtered by stage, fit_score_min, do_not_contact (needs prospects:read); 25 by default, `more` says whether the filter matches more. with_record=true adds every column of the list.',
      inputSchema: {
        stage: z.string().optional(),
        fit_score_min: z.number().int().optional(),
        do_not_contact: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 25'),
        with_record: z.boolean().optional().describe('Include every column of the prospect list as `record` (long)'),
      },
    },
    wrap(async ({ with_record, ...a }) => {
      const limit = a.limit ?? 25;
      // One more than asked, to say whether there are more.
      const rows = await listProspects(db, principal, { ...a, limit: limit + 1 });
      return {
        count: Math.min(rows.length, limit),
        more: rows.length > limit,
        // The row id is of no use here: get_prospect takes a domain.
        prospects: rows.slice(0, limit).map(({ record, id: _id, stage_at, ...p }) => ({
          ...p,
          stage_at: stage_at.slice(0, 10),
          ...(with_record ? { record } : {}),
        })),
      };
    }),
  );

  server.registerTool(
    'get_report_url',
    {
      title: 'Report link',
      description:
        'A link to one report of an audit, valid 1 hour, opened without login. not_generated when that file was not made (request_pdf makes PDFs).',
      inputSchema: {
        audit_id: z.string(),
        kind: z.enum(Object.keys(REPORT_KINDS) as [ReportKind, ...ReportKind[]]).optional(),
      },
    },
    wrap(async (a) =>
      reportUrl(
        db,
        principal,
        { audit_id: a.audit_id, kind: a.kind ?? 'html' },
        { appUrl: d.appUrl, secret: d.reportSecret },
      ),
    ),
  );

  server.registerTool(
    'request_pdf',
    {
      title: 'Request a PDF',
      description:
        "Queues a PDF of a finished audit's report (needs audits:pdf). ready when it exists already; joins a job already queued for the same audit and kind; pdf.ready webhook when done.",
      inputSchema: {
        audit_id: z.string(),
        kind: z.enum(['pdf', 'verified_pdf', 'content_research_pdf', 'teaser_pdf']),
      },
    },
    wrap(async (a) => {
      const res = await requestPdf(db, principal, a);
      await raiseWork(d.platform.files);
      return res;
    }),
  );

  return server;
}
