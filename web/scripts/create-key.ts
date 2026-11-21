/**
 * Creates an API key and prints it once (only its hash is stored).
 *   yarn --cwd web key:create --name=local --scopes=audits:read,audits:start:quick,prospects:read [--rate=60] [--webhook=<url>]
 */
import { closeDb, getDb } from '../db/client';
import { createApiKey } from '../lib/core/auth';
import { parseScopes } from '../lib/core/principal';
import { actionLog } from '../db/schema';

const opt = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main(): Promise<void> {
  const name = opt('name');
  const scopes = parseScopes(opt('scopes') ?? '');
  if (!name || !scopes.length) throw new Error('usage: key:create --name=<name> --scopes=<a,b>');
  const db = getDb();
  const { id, key, webhookSecret } = await createApiKey(db, {
    name,
    scopes,
    rateLimitPerHour: Number(opt('rate')) || 60,
    webhookUrl: opt('webhook') ?? null,
  });
  await db.insert(actionLog).values({ principal: 'cli', action: 'key_created', target: `${name} (${id})` });
  console.log(`client ${name} (${id}), scopes: ${scopes.join(', ')}`);
  console.log(`API key (shown once): ${key}`);
  if (webhookSecret) console.log(`webhook secret (shown once): ${webhookSecret}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
