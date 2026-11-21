import { continueSource, workerSession } from '../../../../lib/core/worker';
import { ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** The stored files of the capped audit this one continues (null when it continues none). */
export const GET = handle(async (request: Request) => {
  const { db } = ctx();
  const s = await workerSession(db, request.headers.get('authorization'));
  return Response.json(await continueSource(db, s));
});
