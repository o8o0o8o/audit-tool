import { CoreError } from '../../../../lib/core/errors';
import { secretFromEnv } from '../../../../lib/core/tokens';
import { verifyUploadToken } from '../../../../lib/platform/local/file-store';
import { ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/**
 * Local FileStore upload (the stand-in for a Blob client upload). The token names a prefix;
 * `x-file-key` must lie under it. Body: the raw file.
 */
export const POST = handle(async (request: Request) => {
  const { platform } = ctx();
  if (platform.mode !== 'local') throw new CoreError('not_found');
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const prefix = verifyUploadToken(token, secretFromEnv('LOCAL_WORKER_SECRET'));
  if (!prefix) throw new CoreError('unauthorized', 'upload token not valid');
  const key = request.headers.get('x-file-key') ?? '';
  if (!key.startsWith(prefix) || key.split('/').includes('..'))
    throw new CoreError('forbidden', 'key outside the allowed prefix');
  const body = new Uint8Array(await request.arrayBuffer());
  const res = await platform.files.put(key, body, { contentType: request.headers.get('content-type') ?? undefined });
  return Response.json({ key, ...res });
});
