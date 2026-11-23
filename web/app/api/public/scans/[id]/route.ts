import { CoreError } from '../../../../../lib/core/errors';
import { publicScanView } from '../../../../../lib/core/public';
import { ctx, handle } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** What the result page polls: the state of one public audit, by its id. Nothing of other audits. */
export const GET = handle(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const view = await publicScanView(ctx().db, id);
  if (!view) throw new CoreError('not_found');
  return Response.json(view, { headers: { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
});
