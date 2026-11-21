import {
  contentTypeFor,
  findArtifactByKind,
  findArtifactByPath,
  findAuditArtifact,
  REPORT_HEADERS,
  reportTokenAudit,
} from '../../../../lib/core/reports';
import { secretFromEnv } from '../../../../lib/core/tokens';
import { ctx } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const deny = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });

/**
 * The one way to open a report or a file (design §7). The signed token names one audit and an
 * expiry; relative links in the report resolve under the same prefix, so screenshots need no cookie.
 * Sandboxed: a report holds text the audited site controls and must never run with the app's origin.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; path: string[] }> }) {
  const { token, path } = await params;
  const auditId = reportTokenAudit(token, secretFromEnv('REPORT_TOKEN_SECRET'));
  if (!auditId) return deny(403, 'This link has expired or is not valid.');
  const { db, platform } = ctx();
  const art =
    path.length === 1 && path[0] === 'report.html'
      ? await findArtifactByKind(db, auditId, 'report_html')
      : path.length === 2 && path[0] === 'a'
        ? await findAuditArtifact(db, auditId, path[1]!)
        : await findArtifactByPath(db, auditId, path);
  if (!art) return deny(404, 'not found');
  const file = await platform.files.get(art.blobKey);
  if (!file) return deny(404, 'file no longer stored');
  return new Response(file.body, {
    headers: {
      ...REPORT_HEADERS,
      'Content-Type': contentTypeFor(art.blobKey),
      'Content-Length': String(file.bytes),
      'Content-Disposition': 'inline',
    },
  });
}
