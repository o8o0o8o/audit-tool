import { eq } from 'drizzle-orm';
import { jobs } from '../../../../db/schema';
import { jobSession } from '../../../../lib/core/jobs';
import { heartbeat, workerSession } from '../../../../lib/core/worker';
import { ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  const auth = request.headers.get('authorization');
  const job = await jobSession(db, auth);
  if (job) await db.update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, job.jobId));
  else await heartbeat(db, await workerSession(db, auth));
  return Response.json({ ok: true });
});
