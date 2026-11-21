import { raiseWork } from '../../../../../../lib/core/cron-gate';
import { cancelAudit } from '../../../../../../lib/core/audits';
import { ctx, handle, onFinished, requireInternalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await requireInternalPrincipal();
  const { id } = await params;
  const { db, platform } = ctx();
  const res = await cancelAudit(db, principal, id, {
    cancelRun: (a, n) => platform.dispatcher.cancel(a, n),
    onFinished,
  });
  await raiseWork(platform.files);
  return Response.json(res);
});
