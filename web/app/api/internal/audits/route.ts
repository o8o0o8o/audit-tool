import { listAudits, startAudit } from '../../../../lib/core/audits';
import { CoreError } from '../../../../lib/core/errors';
import { parseAuditRequest } from '../../../../lib/audit-options';
import { ctx, handle, kickQueue, readJson, requireInternalPrincipal } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** The internal dispatch form: the form's fields → start_audit with the internal principal. */
export const POST = handle(async (request: Request) => {
  const principal = await requireInternalPrincipal();
  const body = (await readJson(request)) as Record<string, unknown>;
  const parsed = parseAuditRequest(body);
  if (!parsed.ok) throw new CoreError('invalid_input', parsed.errors.join('; '));
  const o = parsed.options;
  const mode = o.singlePage ? 'page' : o.quickScan ? 'quick' : 'full';
  const { db } = ctx();
  const res = await startAudit(db, principal, {
    url: o.url,
    mode,
    preset: o.preset,
    options: {
      sections: o.sections,
      perf: o.perf,
      llm: o.llm,
      verify: o.verify,
      contentResearch: o.contentResearch,
      visual: o.visual,
      concurrency: o.concurrency,
      limit: o.limit,
      evidenceCap: o.evidenceCap,
      pdf: body.pdf === true,
    },
    active: body.active === true,
  });
  if (res.status === 'queued') await kickQueue();
  return Response.json({ runId: res.audit_id, ...res });
});

export const GET = handle(async (request: Request) => {
  const principal = await requireInternalPrincipal();
  const q = new URL(request.url).searchParams;
  const { db } = ctx();
  const audits = await listAudits(db, principal, {
    domain: q.get('domain') || undefined,
    status: q.get('status') || undefined,
    limit: Number(q.get('limit')) || 100,
  });
  return Response.json({ audits });
});
