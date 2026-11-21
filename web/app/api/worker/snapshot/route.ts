import { latestSnapshot, workerSession } from '../../../../lib/core/worker';
import { ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** The newest snapshot of an earlier attempt of this audit (null when none). */
export const GET = handle(async (request: Request) => {
  const { db, platform } = ctx();
  const s = await workerSession(db, request.headers.get('authorization'));
  return Response.json(await latestSnapshot(platform.files, s));
});
