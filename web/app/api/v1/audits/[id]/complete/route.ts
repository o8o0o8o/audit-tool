import { completeImport } from '../../../../../../lib/core/imports';
import { apiPrincipal, ctx, handle, readJson } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Ends an import: records the uploaded artifacts and sets `built`; the loader takes over. */
export const POST = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await apiPrincipal(request);
  const { id } = await params;
  const { db, platform } = ctx();
  return Response.json(await completeImport(db, platform.files, principal, id, await readJson(request)));
});
