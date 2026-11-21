import { registerJob } from '../../../../lib/core/jobs';
import { registerWorker } from '../../../../lib/core/worker';
import { ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Binds a run to an audit attempt (`audit_id`) or to a PDF job (`job_id`) and returns a session. */
export const POST = handle(async (request: Request) => {
  const { db, platform } = ctx();
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const body = (await readJson(request)) as Record<string, unknown>;
  if (body && typeof body === 'object' && 'job_id' in body)
    return Response.json(await registerJob(db, platform.identity, token, body));
  return Response.json(await registerWorker(db, platform.identity, token, body));
});
