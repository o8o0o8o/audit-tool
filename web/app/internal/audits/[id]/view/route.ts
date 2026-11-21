import { NextResponse } from 'next/server';
import { findArtifactByKind, makeReportToken, REPORT_HEADERS } from '../../../../../lib/core/reports';
import { secretFromEnv } from '../../../../../lib/core/tokens';
import { loadShell, wrapReport } from '../../../../../lib/report-shell';
import { ctx, internalPrincipal } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

/**
 * The one view of an audit's HTML report: the report itself as the page, with the site header and
 * footer around it (lib/report-shell.ts). Sandboxed like /r/<token>: the report holds text the
 * audited site controls. Relative links (screenshots) resolve under a fresh token link.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  if (!(await internalPrincipal()))
    return NextResponse.redirect(new URL(`/internal/login?next=${encodeURIComponent(url.pathname)}`, url));
  const { db, platform } = ctx();
  const art = await findArtifactByKind(db, id, 'report_html');
  const file = art ? await platform.files.get(art.blobKey) : null;
  if (!art || !file) return new Response('This audit has no HTML report.', { status: 404 });
  const report = await new Response(file.body).text();
  const token = makeReportToken(id, secretFromEnv('REPORT_TOKEN_SECRET'));
  const shell = await loadShell(url.origin);
  return new Response(wrapReport(report, shell, `/r/${token}/`), {
    headers: { ...REPORT_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}
