import { raiseWork } from '../../../../../../lib/core/cron-gate';
import { completeImport } from '../../../../../../lib/core/imports';
import { apiPrincipal, ctx, handle, readJson } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Ends an import: records the uploaded artifacts and sets `built`; the loader takes over. */
export const POST = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await apiPrincipal(request);
  const { id } = await params;
  const { db, platform } = ctx();
  const res = await completeImport(db, platform.files, principal, id, await readJson(request));
  await raiseWork(platform.files);
  return Response.json(res);
});
