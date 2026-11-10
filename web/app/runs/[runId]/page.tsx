'use client';

import { use, useEffect, useState } from 'react';

interface RunFile {
  name: string;
  url: string;
}

interface RunStatus {
  runId: string;
  url?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  files?: RunFile[];
  ghRunUrl?: string;
  error?: string;
  options?: { preset?: string; sections?: string };
}

const POLL_MS = 15000;

function isReport(name: string): boolean {
  if (name.includes('/')) return false;
  return (
    /^(audit-report(\.verified)?|content-research-report)\.(pdf|html)$/.test(name) ||
    /^[^/]+\.[a-z]{2,}\.html$/i.test(name)
  );
}

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
        const data = (await res.json()) as RunStatus & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 404 ? 'Waiting for the workflow to start…' : (data.error ?? `Error ${res.status}`));
        } else {
          setError(null);
          setStatus(data);
          if (data.status !== 'running' && data.status !== 'queued') return;
        }
      } catch {
        if (!cancelled) setError('Could not load run status');
      }
      if (!cancelled) timer = setTimeout(load, POLL_MS);
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);

  const reports = (status?.files ?? []).filter((f) => isReport(f.name));

  return (
    <main>
      <h1>Run {runId}</h1>
      {error && <p className="muted">{error}</p>}
      {status && (
        <>
          <p data-testid="run-status">Status: {status.status}</p>
          {status.url && <p>Site: {status.url}</p>}
          {status.options && (
            <p data-testid="run-preset">
              Preset: {status.options.preset || 'full audit'}
              {status.options.sections ? ` (${status.options.sections.split(',').join(', ')})` : ''}
            </p>
          )}
          {status.error && <p className="error">{status.error}</p>}
          {reports.length > 0 && (
            <ul className="run-list">
              {reports.map((f) => (
                <li key={f.url}>
                  <a data-testid="report-link" href={`/view/${runId}/${f.name}`} target="_blank" rel="noreferrer">
                    {f.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {status.ghRunUrl && (
            <p>
              <a
                className="link-accent"
                data-testid="gh-run-link"
                href={status.ghRunUrl}
                target="_blank"
                rel="noreferrer"
              >
                GitHub Actions run
              </a>
            </p>
          )}
        </>
      )}
    </main>
  );
}
