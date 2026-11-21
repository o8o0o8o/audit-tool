import { CoreError } from '../../../../lib/core/errors';
import { jobFile, jobSession } from '../../../../lib/core/jobs';
import { ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** A PDF job reads its audit's files (report text, screenshots); nothing else. */
export const GET = handle(async (request: Request) => {
  const { db, platform } = ctx();
  const job = await jobSession(db, request.headers.get('authorization'));
  if (!job) throw new CoreError('unauthorized');
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const got = await jobFile(platform, job, key);
  return new Response(got.body, { headers: { 'content-type': 'application/octet-stream' } });
});
