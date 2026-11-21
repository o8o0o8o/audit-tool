import { CoreError } from '../../../../lib/core/errors';
import { checkGuard } from '../../../../lib/core/guard';
import { hasScope } from '../../../../lib/core/principal';
import { normalizeHost } from '../../../../lib/core/sites';
import { apiPrincipal, ctx, handle } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** GET /api/v1/guard?domain= — may this domain be scanned? Asked by the pipeline before fingerprint and scan. */
export const GET = handle(async (request: Request) => {
  const principal = await apiPrincipal(request);
  // The answer says which domains are do-not-contact: only for keys that work with prospects.
  if (!hasScope(principal, 'prospects:read') && !hasScope(principal, 'audits:publish'))
    throw new CoreError('forbidden', 'missing scope prospects:read or audits:publish');
  const domain = new URL(request.url).searchParams.get('domain');
  if (!domain) throw new CoreError('invalid_input', 'domain is required');
  return Response.json(await checkGuard(ctx().db, normalizeHost(domain)));
});
