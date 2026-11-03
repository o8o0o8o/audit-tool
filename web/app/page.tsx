'use client';

import { useState, type FormEvent } from 'react';

const fieldStyle = { display: 'flex', flexDirection: 'column' as const, gap: 4, marginBottom: 12 };
const inputStyle = { padding: 8, fontSize: 16, maxWidth: '100%', boxSizing: 'border-box' as const };

export default function DispatchPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      url: form.get('url'),
      perf: form.get('perf') === 'on',
      llm: form.get('llm') === 'on',
      verify: form.get('verify') === 'on',
      contentResearch: form.get('contentResearch') === 'on',
      concurrency: form.get('concurrency'),
      limit: form.get('limit'),
      evidenceCap: form.get('evidenceCap'),
    };
    setSubmitting(true);
    setError(null);
    setRunId(null);
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dispatch-key': String(form.get('accessKey') ?? '') },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) setError(data.error ?? `Dispatch failed (${res.status})`);
      else setRunId(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dispatch failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Run an SEO audit</h1>
      <form onSubmit={onSubmit}>
        <label style={fieldStyle}>
          Website URL
          <input name="url" type="url" required placeholder="https://example.com" style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          Access key (only if the server requires one)
          <input name="accessKey" type="password" autoComplete="current-password" style={inputStyle} />
        </label>
        <fieldset style={{ marginBottom: 12 }}>
          <legend>Options</legend>
          <label style={{ display: 'block' }}>
            <input name="perf" type="checkbox" /> Performance metrics (--perf)
          </label>
          <label style={{ display: 'block' }}>
            <input name="llm" type="checkbox" /> LLM passes (--llm)
          </label>
          <label style={{ display: 'block' }}>
            <input name="verify" type="checkbox" /> Live verification (--verify)
          </label>
          <label style={{ display: 'block' }}>
            <input name="contentResearch" type="checkbox" /> Content research (--content-research)
          </label>
        </fieldset>
        <label style={fieldStyle}>
          Concurrency (1–20)
          <input name="concurrency" type="number" min={1} max={20} defaultValue={5} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          Page limit (optional)
          <input name="limit" type="number" min={1} placeholder="all pages" style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          Evidence cap (1–100)
          <input name="evidenceCap" type="number" min={1} max={100} defaultValue={10} style={inputStyle} />
        </label>
        <button type="submit" disabled={submitting} style={{ padding: '8px 16px', fontSize: 16 }}>
          {submitting ? 'Dispatching…' : 'Start audit'}
        </button>
      </form>
      {error && (
        <p role="alert" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}
      {runId && (
        <p>
          Audit dispatched. <a href={`/runs/${runId}`}>View run {runId}</a>
        </p>
      )}
    </main>
  );
}
