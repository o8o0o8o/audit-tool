/**
 * MCP tool definitions (design §5): name, description, zod input, a call into lib/core. Every tool
 * describes itself well enough for an agent to pick it; results are plain typed data.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/client';
import type { Platform } from '../platform/types';
import { cancelAudit, continueAudit, getAudit, listAudits, startAudit, TERMINAL_STATUSES } from '../core/audits';
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
import { LeadSummary, LeadSummaryRow } from '@model/lead-summary';

export interface McpDeps {
  db: Db;
  platform: Platform;
  principal: Principal;
  appUrl: string;
  reportSecret: string;
}

const MAX_BYTES = 100_000;

function ok(data: unknown) {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_BYTES)
    text = JSON.stringify({
      truncated: true,
      note: 'response cut at ~100 KB; narrow the request',
      data: text.slice(0, MAX_BYTES),
    });
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: (typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data
      : { result: data }) as Record<string, unknown>,
  };
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
  const server = new McpServer({ name: 'audit-platform', version: '0.1.0' }, { capabilities: { tools: {} } });
  const { db, principal } = d;
  const finished = (id: string) => onAuditFinished(db, id);

  server.registerTool(
    'start_audit',
    {
      title: 'Start an audit',
      description:
        'Queue an SEO/technical audit of a site. mode=quick: passive 25-page scan (~4 min, most common for lead enrichment); mode=page: one page; mode=full: whole site (needs audits:start:full). ' +
        'Returns at once with audit_id; then call wait_for_audit (or rely on the webhook). reused tells you when an existing audit was returned instead: idempotent (same idempotency_key), in_progress (your audit of this site is running), recent (a finished one newer than reuse_if_newer_than_hours — read it at once). Refused with do_not_contact for sites that must not be scanned.',
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
        'Status, phase, progress, timings, options, model version, scores, scan quality and stored files of one audit. page_cap is set when the page cap stopped the crawl (see continue_audit); continued_from names the audit this one continues.',
      inputSchema: { audit_id: z.string() },
    },
    wrap(async (a) => getAudit(db, principal, a.audit_id)),
  );

  server.registerTool(
    'wait_for_audit',
    {
      title: 'Wait for an audit',
      description:
        'Waits up to timeout_seconds (max 50) and returns as soon as the audit finishes; otherwise returns its current status and progress, and you call again. For callers without a webhook.',
      inputSchema: { audit_id: z.string(), timeout_seconds: z.number().min(1).max(50).optional() },
    },
    wrap(async (a) => {
      const until = Date.now() + Math.min(50, a.timeout_seconds ?? 50) * 1000;
      for (;;) {
        const view = await getAudit(db, principal, a.audit_id);
        const done = (TERMINAL_STATUSES as readonly string[]).includes(view.status);
        if (done || Date.now() >= until) return { ...view, finished: done };
        await new Promise((r) => setTimeout(r, 2000));
      }
    }),
  );

  server.registerTool(
    'list_audits',
    {
      title: 'List audits',
      description:
        'Audits newest first, filtered by domain, mode, status, source (public/internal/api/pipeline), external_ref or since (ISO date).',
      inputSchema: {
        domain: z.string().optional(),
        mode: z.enum(['full', 'quick', 'page']).optional(),
        status: z.string().optional(),
        source: z.enum(['public', 'internal', 'api', 'pipeline']).optional(),
        external_ref: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    wrap(async (a) => ({ audits: await listAudits(db, principal, a) })),
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
      outputSchema: LeadSummary,
    },
    async (a) => {
      try {
        const s = await getLeadSummary(db, principal, a);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(s, null, 1) }],
          structuredContent: s as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_lead_summaries',
    {
      title: 'Lead summaries of every site',
      description:
        'One row per site (latest full and latest quick audit; set latest_only=false for every audit) with the default lead signals: scan quality, whether outreach is blocked, scores, issue counts, gate-verified facts (counts and the three heaviest), real-user speed, stack, tracking, site profile, SPF and DMARC, quick wins, links. Public scans and single-page audits are not included. ' +
        'Filter by mode, domain, scan_quality, teaser_ready, outreach_blocked, min_heavy_facts, max_overall_score, prospect_stage. Newest first; pass next_cursor back as cursor for the next page. ' +
        'Scores and issue counts are empty for a blocked scan. Never start outreach when outreach_blocked is true. For the full detail of one site use get_lead_summary.',
      inputSchema: ListLeadSummariesInput.shape,
      outputSchema: { summaries: z.array(LeadSummaryRow), count: z.number().int(), next_cursor: z.string().nullable() },
    },
    async (a) => {
      try {
        const res = await listLeadSummaries(db, principal, a);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res, null, 1) }],
          structuredContent: res as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return fail(err);
      }
    },
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
        'Findings of an audit with code, params, title, severity and occurrence count, most severe first. Filter by severity_min, category, codes (see list_check_types), scope. Returns `total` (all findings that match the filters), `count` (this page) and `next_cursor`: pass it back as `cursor` with the same filters for the next page; null on the last page. A blocked scan returns no findings.',
      inputSchema: {
        ...target,
        severity_min: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        category: z.string().optional().describe('performance, seo, privacy, accessibility, ux, technical, agentic'),
        codes: z.array(z.string()).optional(),
        scope: z.enum(['page', 'site']).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Page size, default 50'),
        cursor: z.string().optional().describe('next_cursor of the previous page'),
      },
    },
    wrap(async (a) => listFindings(db, principal, a)),
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
      description: 'Fixes ranked by impact, with effort and the finding codes each resolves.',
      inputSchema: {
        ...target,
        quick_wins_only: z.boolean().optional(),
        effort_max: z.string().optional().describe('e.g. "2 hours"'),
        limit: z.number().int().optional(),
      },
    },
    wrap(async (a) => getRecommendations(db, principal, a)),
  );

  server.registerTool(
    'get_site_checks',
    {
      title: 'Site checks',
      description:
        'Site-level check rows: email DNS (SPF, DMARC, DKIM…), exposed files, missing-page status, takeover, JS libraries, GTM, GA4 hits…',
      inputSchema: { ...target, check_ids: z.array(z.string()).optional(), status: z.string().optional() },
    },
    wrap(async (a) => getSiteChecks(db, principal, a)),
  );

  server.registerTool(
    'list_check_types',
    {
      title: 'Finding vocabulary',
      description: 'The finding codes used by list_findings, with title, family, category and default severity.',
      inputSchema: { family: z.string().optional(), category: z.string().optional(), derived: z.boolean().optional() },
    },
    wrap(async (a) => listCheckTypes(db, principal, a)),
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
      description: 'Prospect rows filtered by stage, fit_score_min, do_not_contact (needs prospects:read).',
      inputSchema: {
        stage: z.string().optional(),
        fit_score_min: z.number().int().optional(),
        do_not_contact: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    wrap(async (a) => ({ prospects: (await listProspects(db, principal, a)).map(({ record: _r, ...p }) => p) })),
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
