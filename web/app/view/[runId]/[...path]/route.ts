import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

import { isValidRunId } from '../../../../lib/audit-options';

export const dynamic = 'force-dynamic';

// Vercel Blob serves .html as an attachment with a script-blocking CSP, so reports would
// download instead of opening. This proxies a run's files and serves them inline. The
// `sandbox` CSP puts the page in an opaque origin: report scripts (charts) run, but can't
// reach this app's origin. Relative links (evidence/…) resolve back through this route.
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const INLINE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
};

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string; path: string[] }> }) {
  const { runId, path } = await params;
  if (!isValidRunId(runId) || path.length === 0 || !path.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }
  const pathname = `audits/${runId}/${path.join('/')}`;
  try {
    const { blobs } = await list({ prefix: pathname, limit: 10 });
    const blob = blobs.find((b) => b.pathname === pathname);
    if (!blob) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const upstream = await fetch(blob.url, { cache: 'no-store' });
    if (!upstream.ok || !upstream.body) return NextResponse.json({ error: 'unavailable' }, { status: 502 });
    const ext = path[path.length - 1].split('.').pop()?.toLowerCase() ?? '';
    const contentType = INLINE_TYPES[ext] ?? upstream.headers.get('content-type') ?? 'application/octet-stream';
    return new Response(upstream.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    console.error('blob view failed', err);
    return NextResponse.json({ error: 'blob storage unavailable' }, { status: 502 });
  }
}
