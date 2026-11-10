'use client';

import { useState, type FormEvent } from 'react';

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
      <form className="card" onSubmit={onSubmit}>
        <label className="form-field">
          Website URL
          <input name="url" type="url" required placeholder="https://example.com" className="form-input" />
        </label>
        <label className="form-field">
          Access key (only if the server requires one)
          <input name="accessKey" type="password" autoComplete="current-password" className="form-input" />
        </label>
        <fieldset className="form-options">
          <legend>Options</legend>
          <label className="form-check">
            <input name="perf" type="checkbox" /> Performance metrics (--perf)
          </label>
          <label className="form-check">
            <input name="llm" type="checkbox" /> LLM passes (--llm)
          </label>
          <label className="form-check">
            <input name="verify" type="checkbox" /> Live verification (--verify)
          </label>
          <label className="form-check">
            <input name="contentResearch" type="checkbox" /> Content research (--content-research)
          </label>
        </fieldset>
        <label className="form-field">
          Concurrency (1–20)
          <input name="concurrency" type="number" min={1} max={20} defaultValue={5} className="form-input" />
        </label>
        <label className="form-field">
          Page limit (optional)
          <input name="limit" type="number" min={1} placeholder="all pages" className="form-input" />
        </label>
        <label className="form-field">
          Evidence cap (1–100)
          <input name="evidenceCap" type="number" min={1} max={100} defaultValue={10} className="form-input" />
        </label>
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? 'Dispatching…' : 'Start audit'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {runId && (
        <p>
          Audit dispatched.{' '}
          <a className="link-accent" href={`/runs/${runId}`}>
            View run {runId}
          </a>
        </p>
      )}
    </main>
  );
}
