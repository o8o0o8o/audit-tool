import { after } from 'next/server';
import { finishJob, jobSession } from '../../../../lib/core/jobs';
import { onPdfReady } from '../../../../lib/core/webhooks';
import { reportStatus, workerSession } from '../../../../lib/core/worker';
import { ctx, followWorkerReport, handle, onFinished, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
/** Room for the load that follows a final report (see `followWorkerReport`). */
export const maxDuration = 300;

/** Reports that end a run or a job: what comes next starts now, after the answer is sent. */
const FINAL = new Set(['built', 'succeeded', 'failed', 'cancelled', 'done']);

export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  const auth = request.headers.get('authorization');
  const body = await readJson(request);
  const job = await jobSession(db, auth);
  const res = job
    ? await finishJob(db, job, body, { onPdfReady: (id) => onPdfReady(db, id) })
    : await reportStatus(db, await workerSession(db, auth), body, { onFinished });
  if (FINAL.has(res.status)) after(() => followWorkerReport());
  return Response.json(res);
});
