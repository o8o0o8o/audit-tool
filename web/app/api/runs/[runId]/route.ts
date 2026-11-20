import { NextResponse } from 'next/server';

import { isValidRunId } from '../../../../lib/audit-options';
import { fetchBlob } from '../../../../lib/blob';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!isValidRunId(runId)) return NextResponse.json({ error: 'invalid run id' }, { status: 400 });

  try {
    // Both blobs are overwritten during a run, so read past the Blob CDN copy.
    const [statusRes, progress] = await Promise.all([
      fetchBlob(`audits/${runId}/status.json`, { fresh: true }),
      readProgress(runId),
    ]);
    if (!statusRes) return NextResponse.json({ error: 'run not found yet' }, { status: 404 });
    const status = await statusRes.json();
    return NextResponse.json(progress ? { ...status, progress } : status, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('blob status read failed', err);
    return NextResponse.json({ error: 'blob storage unavailable' }, { status: 502 });
  }
}

/** The progress blob is overwritten every ~20s. Missing/broken = no progress. */
async function readProgress(runId: string): Promise<unknown> {
  try {
    const res = await fetchBlob(`audits/${runId}/progress.json`, { fresh: true });
    return res ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}
