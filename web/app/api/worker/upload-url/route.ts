import { z } from 'zod';
import { CoreError } from '../../../../lib/core/errors';
import { jobSession } from '../../../../lib/core/jobs';
import { uploadPrefix, workerSession } from '../../../../lib/core/worker';
import { ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const Input = z.object({
  area: z.enum(['audit', 'checkpoint']).default('audit'),
  key: z.string().min(1).max(1024),
  content_type: z.string().max(200).nullish(),
});

/** How long one upload URL works; the worker asks again for a file it has to retry later. */
const URL_TTL_SECONDS = 900;

/**
 * Production stores: a URL for one upload, straight to storage. The key must lie under the prefix
 * of the caller's session (its audit and attempt), so a worker writes its own files and nothing else.
 */
export const POST = handle(async (request: Request) => {
  const { db, platform } = ctx();
  if (!platform.files.presignUpload) throw new CoreError('not_found');
  const auth = request.headers.get('authorization');
  const input = Input.parse(await readJson(request));
  const job = await jobSession(db, auth);
  const prefix = job
    ? `audits/${job.auditId}/${job.attempt}/`
    : uploadPrefix(await workerSession(db, auth), input.area);
  if (!input.key.startsWith(prefix) || input.key.split('/').includes('..'))
    throw new CoreError('forbidden', 'key outside the allowed prefix');
  return Response.json(await platform.files.presignUpload(input.key, URL_TTL_SECONDS, input.content_type ?? undefined));
});
