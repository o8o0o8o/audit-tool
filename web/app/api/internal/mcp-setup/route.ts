import { actionLog } from '../../../../db/schema';
import { createPersonalMcpKey, mcpSetupPrompt } from '../../../../lib/core/auth';
import { appUrl, ctx, handle, requireInternalPrincipal } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/**
 * "Set up MCP": makes the logged-in person's own API key and returns it once, inside a prompt their
 * AI assistant can act on. A new key replaces the person's earlier one.
 */
export const POST = handle(async (request: Request) => {
  const principal = await requireInternalPrincipal();
  const { db } = ctx();
  const res = await createPersonalMcpKey(db, principal);
  await db.insert(actionLog).values({
    principal: principal.kind === 'internal' ? principal.label : 'internal',
    action: 'mcp_key_created',
    target: `${res.id}${res.replaced ? ` (replaced ${res.replaced})` : ''}`,
  });
  // The address the person is using, so the prompt works for whatever host served this page.
  const origin = process.env.APP_URL ? appUrl() : new URL(request.url).origin;
  return Response.json(
    { ...mcpSetupPrompt(origin, res.key), replaced: res.replaced },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
