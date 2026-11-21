import { patchProspect } from '../../../../../lib/core/prospects';
import { apiPrincipal, ctx, handle, readJson } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Body: { values: { column: value, … } }. A do_not_contact row is never changed. */
export const PATCH = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await apiPrincipal(request);
  const { id } = await params;
  const body = (await readJson(request)) as { values?: Record<string, string> };
  return Response.json(await patchProspect(ctx().db, principal, id, body?.values ?? {}));
});
