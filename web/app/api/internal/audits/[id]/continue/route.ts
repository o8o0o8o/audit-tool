import { continueAudit } from '../../../../../../lib/core/audits';
import { CoreError } from '../../../../../../lib/core/errors';
import { ctx, handle, kickQueue, readJson, requireInternalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Continues an audit the page cap stopped: a new audit that crawls on from it. */
export const POST = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await requireInternalPrincipal();
  const { id } = await params;
  const body = ((await readJson(request)) ?? {}) as { maxPages?: unknown };
  const raw = body.maxPages;
  const maxPages = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  if (maxPages !== null && !Number.isInteger(maxPages))
    throw new CoreError('invalid_input', 'maxPages must be a whole number');
  const res = await continueAudit(ctx().db, principal, { audit_id: id, max_pages: maxPages });
  if (res.status === 'queued') await kickQueue();
  return Response.json(res);
});
