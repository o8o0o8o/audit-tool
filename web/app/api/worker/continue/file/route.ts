import { continueFile, workerSession } from '../../../../../lib/core/worker';
import { ctx, handle } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request: Request) => {
  const { db, platform } = ctx();
  const s = await workerSession(db, request.headers.get('authorization'));
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const got = await continueFile(db, platform.files, s, key);
  return new Response(got.body, { headers: { 'content-type': 'application/octet-stream' } });
});
