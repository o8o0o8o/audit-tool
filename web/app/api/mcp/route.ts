import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CoreError } from '../../../lib/core/errors';
import { secretFromEnv } from '../../../lib/core/tokens';
import { buildMcpServer } from '../../../lib/mcp/tools';
import { apiPrincipal, appUrl, ctx } from '../../../lib/server';

export const dynamic = 'force-dynamic';
/** `wait_for_audit` holds a call for up to 280 seconds. */
export const maxDuration = 300;

/** MCP over Streamable HTTP, stateless: a server per request, the principal from the API key. */
async function handle(request: Request): Promise<Response> {
  let principal;
  try {
    principal = await apiPrincipal(request);
  } catch (err) {
    const e = err instanceof CoreError ? err : new CoreError('unauthorized');
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32001, message: `${e.code}: ${e.message}` }, id: null },
      { status: e.status },
    );
  }
  const { db, platform } = ctx();
  const server = buildMcpServer({
    db,
    platform,
    principal,
    appUrl: appUrl(),
    reportSecret: secretFromEnv('REPORT_TOKEN_SECRET'),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = () =>
  Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST' },
      id: null,
    },
    { status: 405 },
  );
export const DELETE = GET;
