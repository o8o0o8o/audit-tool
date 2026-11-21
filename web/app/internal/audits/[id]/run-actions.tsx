'use client';

import { useEffect, useState } from 'react';

export function RunActions(props: {
  auditId: string;
  active: boolean;
  succeeded: boolean;
  hasReportMd: boolean;
  hasPdf: boolean;
  /** The cap that stopped the crawl; the audit can then be continued with a higher one. */
  pageCap?: number | null;
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

  async function continueAudit(form: FormData) {
    setMessage('…');
    const res = await fetch(`/api/internal/audits/${props.auditId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxPages: form.get('maxPages') }),
    });
    const data = (await res.json().catch(() => ({}))) as { audit_id?: string; message?: string };
    if (res.ok && data.audit_id) window.location.href = `/internal/audits/${data.audit_id}`;
    else setMessage(data.message ?? `Error ${res.status}`);
  }

  if (props.succeeded && props.pageCap) {
    return (
      <>
        <form
          data-testid="continue-form"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void continueAudit(new FormData(e.currentTarget));
          }}
        >
          <label htmlFor="continue-max-pages">New page cap (0 = no cap)</label>
          <input
            id="continue-max-pages"
            name="maxPages"
            type="number"
            min={0}
            max={100000}
            defaultValue={Math.min(props.pageCap * 2, 100000)}
            className="form-input"
            style={{ width: 140 }}
          />
          <button type="submit" className="btn btn--outline">
            Continue crawl
          </button>
        </form>
        <RunActions {...props} pageCap={null} />
      </>
    );
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
