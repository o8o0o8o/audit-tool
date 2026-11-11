import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

import { isValidRunId } from '../../../../lib/audit-options';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!isValidRunId(runId)) return NextResponse.json({ error: 'invalid run id' }, { status: 400 });

  const pathname = `audits/${runId}/status.json`;
  const progressPathname = `audits/${runId}/progress.json`;
  try {
    const [{ blobs }, { blobs: progressBlobs }] = await Promise.all([
      list({ prefix: pathname, limit: 1 }),
      list({ prefix: progressPathname, limit: 1 }),
    ]);
    const blob = blobs.find((b) => b.pathname === pathname);
    if (!blob) return NextResponse.json({ error: 'run not found yet' }, { status: 404 });
    const res = await fetch(blob.url, { cache: 'no-store' });
    if (!res.ok) return NextResponse.json({ error: 'status unavailable' }, { status: 502 });
    const status = await res.json();
    const progress = await readProgress(progressBlobs.find((b) => b.pathname === progressPathname)?.url);
    return NextResponse.json(progress ? { ...status, progress } : status, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('blob status read failed', err);
    return NextResponse.json({ error: 'blob storage unavailable' }, { status: 502 });
  }
}

/** The progress blob is overwritten every ~20s; the query string defeats any CDN copy. Missing/broken = no progress. */
async function readProgress(url: string | undefined): Promise<unknown> {
  if (!url) return undefined;
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}
