import { NextResponse } from 'next/server';
import { makeReportToken } from '../../../../../../lib/core/reports';
import { secretFromEnv } from '../../../../../../lib/core/tokens';
import { internalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Permanent internal address of a file: checks the session, then redirects to a fresh token link. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; artifact: string }> }) {
  const { id, artifact } = await params;
  if (!(await internalPrincipal()))
    return NextResponse.redirect(
      new URL(`/internal/login?next=${encodeURIComponent(new URL(request.url).pathname)}`, request.url),
    );
  const token = makeReportToken(id, secretFromEnv('REPORT_TOKEN_SECRET'));
  return NextResponse.redirect(new URL(`/r/${token}/a/${encodeURIComponent(artifact)}`, request.url));
}
