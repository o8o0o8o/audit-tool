import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

import { isValidRunId } from '../../../../lib/audit-options';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!isValidRunId(runId)) return NextResponse.json({ error: 'invalid run id' }, { status: 400 });

  const pathname = `audits/${runId}/status.json`;
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const blob = blobs.find((b) => b.pathname === pathname);
    if (!blob) return NextResponse.json({ error: 'run not found yet' }, { status: 404 });
    const res = await fetch(blob.url, { cache: 'no-store' });
    if (!res.ok) return NextResponse.json({ error: 'status unavailable' }, { status: 502 });
    return NextResponse.json(await res.json(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'blob storage unavailable' }, { status: 502 });
  }
}
