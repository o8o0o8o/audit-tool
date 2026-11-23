import { CoreError } from '../../../../lib/core/errors';
import { botCheckFromEnv, publicScansOpen, startPublicScan } from '../../../../lib/core/public';
import { secretFromEnv } from '../../../../lib/core/tokens';
import { clientIp, ctx, handle, kickQueue, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** The public form's only action (design §7): a quick scan or a single-page audit, behind the bot check (when configured) and the limits. */
export const POST = handle(async (request: Request) => {
  if (!publicScansOpen()) throw new CoreError('not_found');
  const body = (await readJson(request)) as { url?: unknown; mode?: unknown; turnstile_token?: unknown };
  const res = await startPublicScan(
    ctx().db,
    { url: body?.url, mode: body?.mode, token: typeof body?.turnstile_token === 'string' ? body.turnstile_token : '' },
    {
      ip: clientIp(request),
      botCheck: botCheckFromEnv(),
      ipSecret: secretFromEnv('SESSION_SECRET'),
    },
  );
  if (!res.reused) await kickQueue();
  return Response.json({ audit_id: res.audit_id });
});
