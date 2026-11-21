import { jobSession } from '../../../../lib/core/jobs';
import { issueWorkerUpload, workerSession } from '../../../../lib/core/worker';
import { ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request: Request) => {
  const { db, platform } = ctx();
  const auth = request.headers.get('authorization');
  const body = (await readJson(request)) as { area?: string };
  const job = await jobSession(db, auth);
  if (job) {
    const prefix = `audits/${job.auditId}/${job.attempt}/`;
    return Response.json({ prefix, ...(await platform.files.issueUpload(prefix, 3600)) });
  }
  return Response.json(
    await issueWorkerUpload(
      platform.files,
      await workerSession(db, auth),
      body?.area === 'checkpoint' ? 'checkpoint' : 'audit',
    ),
  );
});
