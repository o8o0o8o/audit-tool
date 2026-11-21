import { appendGateRun, listGateRuns } from '../../../../../../lib/core/imports';
import { apiPrincipal, ctx, handle, readJson } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Appends a pipeline gate run (the LeadFile JSON); rerank and recheck add one each. */
export const POST = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await apiPrincipal(request);
  const { id } = await params;
  return Response.json(await appendGateRun(ctx().db, principal, id, await readJson(request)));
});

export const GET = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await apiPrincipal(request);
  const { id } = await params;
  return Response.json({ gate_runs: await listGateRuns(ctx().db, principal, id) });
});
