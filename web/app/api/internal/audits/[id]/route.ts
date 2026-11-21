import { getAudit } from '../../../../../lib/core/audits';
import { ctx, handle, requireInternalPrincipal } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await requireInternalPrincipal();
  const { id } = await params;
  return Response.json(await getAudit(ctx().db, principal, id));
});
