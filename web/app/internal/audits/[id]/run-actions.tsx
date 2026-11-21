'use client';

import { useEffect, useState } from 'react';

export function RunActions(props: {
  auditId: string;
  active: boolean;
  succeeded: boolean;
  hasReportMd: boolean;
  hasPdf: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);

  // Live progress: reload the page while the audit runs.
  useEffect(() => {
    if (!props.active) return;
    const t = setInterval(() => window.location.reload(), 10_000);
    return () => clearInterval(t);
  }, [props.active]);

  async function post(path: string, body?: unknown) {
    setMessage('…');
    const res = await fetch(`/api/internal/audits/${props.auditId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    setMessage(res.ok ? `Done: ${data.status ?? 'ok'}` : (data.message ?? `Error ${res.status}`));
    if (res.ok) setTimeout(() => window.location.reload(), 1500);
  }

  return (
    <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {props.active && (
        <button type="button" className="btn btn--outline" onClick={() => void post('cancel')}>
          Cancel audit
        </button>
      )}
      {props.succeeded && props.hasReportMd && !props.hasPdf && (
        <button type="button" className="btn btn--outline" onClick={() => void post('pdf', { kind: 'pdf' })}>
          Generate PDF
        </button>
      )}
      {message && <span className="muted">{message}</span>}
    </p>
  );
}
