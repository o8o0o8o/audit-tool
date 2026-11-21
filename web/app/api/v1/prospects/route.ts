import { listProspects, upsertProspect } from '../../../../lib/core/prospects';
import { apiPrincipal, ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request: Request) => {
  const principal = await apiPrincipal(request);
  const q = new URL(request.url).searchParams;
  const prospects = await listProspects(ctx().db, principal, {
    stage: q.get('stage') || undefined,
    domain: q.get('domain') || undefined,
    fit_score_min: q.get('fit_score_min') ? Number(q.get('fit_score_min')) : undefined,
    do_not_contact: q.has('do_not_contact') ? q.get('do_not_contact') === 'true' : undefined,
  });
  return Response.json({ prospects });
});

/** Body: a CSV record ({ company, website, stage, … }); creates or updates by website. */
export const POST = handle(async (request: Request) => {
  const principal = await apiPrincipal(request);
  const body = (await readJson(request)) as { record?: Record<string, string> };
  return Response.json(await upsertProspect(ctx().db, principal, body?.record ?? (body as Record<string, string>)));
});
