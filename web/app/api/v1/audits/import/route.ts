import { beginImport } from '../../../../../lib/core/imports';
import { apiPrincipal, ctx, handle, readJson } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Starts publishing a finished local run; returns the audit id and an upload grant. */
export const POST = handle(async (request: Request) => {
  const principal = await apiPrincipal(request);
  const { db, platform } = ctx();
  return Response.json(await beginImport(db, platform.files, principal, await readJson(request)));
});
