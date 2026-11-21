import { finishJob, jobSession } from '../../../../lib/core/jobs';
import { onPdfReady } from '../../../../lib/core/webhooks';
import { reportStatus, workerSession } from '../../../../lib/core/worker';
import { ctx, handle, onFinished, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  const auth = request.headers.get('authorization');
  const body = await readJson(request);
  const job = await jobSession(db, auth);
  if (job) return Response.json(await finishJob(db, job, body, { onPdfReady: (id) => onPdfReady(db, id) }));
  return Response.json(await reportStatus(db, await workerSession(db, auth), body, { onFinished }));
});
