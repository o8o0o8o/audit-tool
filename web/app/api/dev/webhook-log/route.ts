import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { repoRootFrom } from '../../../../lib/platform/local/dispatcher';

export const dynamic = 'force-dynamic';

/** Local stand-in for a consumer's webhook address (design §10): logs what it receives. Local mode only. */
export async function POST(request: Request) {
  if (process.env.PLATFORM_MODE !== 'local') return new Response('not found', { status: 404 });
  const dir = path.join(repoRootFrom(), '.platform', 'logs');
  mkdirSync(dir, { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    timestamp: request.headers.get('x-audit-timestamp'),
    signature: request.headers.get('x-audit-signature'),
    body: await request.text(),
  };
  appendFileSync(path.join(dir, 'webhooks.log'), JSON.stringify(entry) + '\n');
  return Response.json({ ok: true });
}
