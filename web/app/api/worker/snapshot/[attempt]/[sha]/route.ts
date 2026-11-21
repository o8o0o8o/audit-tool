import { snapshotObject, workerSession } from '../../../../../../lib/core/worker';
import { ctx, handle } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

export const GET = handle(
  async (request: Request, { params }: { params: Promise<{ attempt: string; sha: string }> }) => {
    const { db, platform } = ctx();
    const s = await workerSession(db, request.headers.get('authorization'));
    const { attempt, sha } = await params;
    const got = await snapshotObject(platform.files, s, Number(attempt), sha);
    return new Response(got.body, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(got.bytes) },
    });
  },
);
