import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { newRunId, parseAuditRequest, toWorkflowInputs } from '../../../lib/audit-options';

// Best-effort per-instance limit; serverless instances don't share it, so DISPATCH_SECRET is the real gate.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = Number(process.env.DISPATCH_RATE_LIMIT) || 5;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }
  const parsed = parseAuditRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors.join('; ') }, { status: 400 });

  // Validation and config errors come first; nothing is dispatched without a matching key.
  const token = process.env.GITHUB_TOKEN;
  if (!token) return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });

  // Fail closed: an unset DISPATCH_SECRET must not leave the endpoint public.
  const secret = process.env.DISPATCH_SECRET;
  if (!secret) return NextResponse.json({ error: 'DISPATCH_SECRET not configured' }, { status: 500 });
  if (!secretMatches(request.headers.get('x-dispatch-key') ?? '', secret)) {
    return NextResponse.json({ error: 'invalid access key' }, { status: 401 });
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) return NextResponse.json({ error: 'too many audits dispatched; try again later' }, { status: 429 });

  const owner = process.env.GITHUB_OWNER || 'o8o0o8o';
  const repo = process.env.GITHUB_REPO || 'audit-tool';
  const workflow = process.env.GITHUB_WORKFLOW || 'audit.yml';
  const ref = process.env.GITHUB_REF || 'main';
  const runId = newRunId();
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs: toWorkflowInputs(parsed.options, runId) }),
    });
  } catch {
    return NextResponse.json({ error: 'could not reach the GitHub API' }, { status: 502 });
  }
  if (!res.ok) {
    let message = '';
    try {
      message = ((await res.json()) as { message?: string }).message ?? '';
    } catch {}
    return NextResponse.json(
      { error: `GitHub API error ${res.status}${message ? `: ${message.split(token).join('***')}` : ''}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ runId });
}
