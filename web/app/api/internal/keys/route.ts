import { desc } from 'drizzle-orm';
import { apiClients, actionLog } from '../../../../db/schema';
import { createApiKey } from '../../../../lib/core/auth';
import { CoreError } from '../../../../lib/core/errors';
import { parseScopes } from '../../../../lib/core/principal';
import { assertWebhookUrl } from '../../../../lib/core/webhooks';
import { ctx, handle, readJson, requireInternalPrincipal } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  await requireInternalPrincipal();
  const rows = await ctx()
    .db.select({
      id: apiClients.id,
      name: apiClients.name,
      scopes: apiClients.scopes,
      rateLimitPerHour: apiClients.rateLimitPerHour,
      webhookUrl: apiClients.webhookUrl,
      createdAt: apiClients.createdAt,
      revokedAt: apiClients.revokedAt,
    })
    .from(apiClients)
    .orderBy(desc(apiClients.createdAt));
  return Response.json({ keys: rows });
});

/** API key management exists only in the internal app (design §5 "Scopes"). The key is shown once. */
export const POST = handle(async (request: Request) => {
  await requireInternalPrincipal();
  const body = (await readJson(request)) as { name?: string; scopes?: string; rate?: number; webhookUrl?: string };
  if (!body?.name?.trim()) throw new CoreError('invalid_input', 'name is required');
  let scopes;
  try {
    scopes = parseScopes(String(body.scopes ?? ''));
  } catch (err) {
    throw new CoreError('invalid_input', (err as Error).message);
  }
  const { db, platform } = ctx();
  const webhookUrl = body.webhookUrl?.trim() || null;
  if (webhookUrl) {
    try {
      assertWebhookUrl(webhookUrl, platform.mode === 'local');
    } catch (err) {
      throw new CoreError('invalid_input', (err as Error).message);
    }
  }
  const res = await createApiKey(db, {
    name: body.name.trim(),
    scopes,
    rateLimitPerHour: Number(body.rate) || 60,
    webhookUrl,
  });
  await db
    .insert(actionLog)
    .values({ principal: 'internal', action: 'key_created', target: `${body.name} (${res.id})` });
  return Response.json(res);
});
