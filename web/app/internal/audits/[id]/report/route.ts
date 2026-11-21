import { NextResponse } from 'next/server';
import { makeReportToken } from '../../../../../lib/core/reports';
import { secretFromEnv } from '../../../../../lib/core/tokens';
import { internalPrincipal } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Opens the HTML report of an audit through a fresh 1 h token link (no cookie inside the report). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await internalPrincipal())) return NextResponse.redirect(new URL('/internal/login', request.url));
  return NextResponse.redirect(
    new URL(`/r/${makeReportToken(id, secretFromEnv('REPORT_TOKEN_SECRET'))}/report.html`, request.url),
  );
}
