import { reportProgress, workerSession } from '../../../../lib/core/worker';
import { ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  await reportProgress(db, await workerSession(db, request.headers.get('authorization')), await readJson(request));
  return Response.json({ ok: true });
});
