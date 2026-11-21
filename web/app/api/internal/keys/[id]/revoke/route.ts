import { actionLog } from '../../../../../../db/schema';
import { revokeApiKey } from '../../../../../../lib/core/auth';
import { ctx, handle, requireInternalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  await requireInternalPrincipal();
  const { id } = await params;
  const { db } = ctx();
  await revokeApiKey(db, id);
  await db.insert(actionLog).values({ principal: 'internal', action: 'key_revoked', target: id });
  return Response.json({ ok: true });
});
