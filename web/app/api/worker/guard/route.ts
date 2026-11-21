import { workerGuard, workerSession } from '../../../../lib/core/worker';
import { ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  const s = await workerSession(db, request.headers.get('authorization'));
  const body = (await readJson(request)) as { host?: unknown };
  return Response.json(await workerGuard(db, s, body?.host));
});
