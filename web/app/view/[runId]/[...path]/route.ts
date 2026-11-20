import { NextResponse } from 'next/server';

import { isValidRunId } from '../../../../lib/audit-options';
import { fetchBlob, publicBlobUrl } from '../../../../lib/blob';

export const dynamic = 'force-dynamic';

// Vercel Blob serves .html as an attachment with a script-blocking CSP, so reports would
// download instead of opening. This proxies a run's files and serves them inline. The
// `sandbox` CSP puts the page in an opaque origin: report scripts (charts) run, but can't
// reach this app's origin. Relative links (evidence/…) resolve back through this route.
// Images are only ever loaded inside a report, so they redirect to Blob instead of being proxied.
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const INLINE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
};
const REDIRECT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);
// A run's files don't change after upload, but a re-run of the same GitHub Actions job
// overwrites them, so the CDN keeps a copy for an hour rather than for good.
const CACHE_CONTROL = 'public, max-age=300, s-maxage=3600';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string; path: string[] }> }) {
  const { runId, path } = await params;
  if (!isValidRunId(runId) || path.length === 0 || !path.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }
  const pathname = `audits/${runId}/${path.join('/')}`;
  const ext = path[path.length - 1].split('.').pop()?.toLowerCase() ?? '';
  try {
    if (REDIRECT_EXTENSIONS.has(ext)) {
      return new Response(null, {
        status: 302,
        headers: { Location: publicBlobUrl(pathname), 'Cache-Control': CACHE_CONTROL },
      });
    }
    const upstream = await fetchBlob(pathname);
    // Never cache a miss: the file may still be uploading.
    if (!upstream) {
      return NextResponse.json({ error: 'not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!upstream.body) return NextResponse.json({ error: 'unavailable' }, { status: 502 });
    const contentType = INLINE_TYPES[ext] ?? upstream.headers.get('content-type') ?? 'application/octet-stream';
    return new Response(upstream.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': CACHE_CONTROL,
      },
    });
  } catch (err) {
    console.error('blob view failed', err);
    return NextResponse.json({ error: 'blob storage unavailable' }, { status: 502 });
  }
}
