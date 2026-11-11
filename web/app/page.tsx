'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { estimateAuditDuration, formatEstimate, type AuditEstimate } from '../lib/audit-options';

const PRESETS = [
  { value: 'full', label: 'Full audit', summary: 'Every report section, using the options you would get with no preset.' },
  { value: 'sales', label: 'Sales', summary: 'Short executive summary, technology stack, CTAs/conversion and top issues.' },
  { value: 'marketing', label: 'Marketing', summary: 'SEO, content, CTAs/conversion, UX, performance and privacy.' },
  { value: 'seo', label: 'SEO', summary: 'The full technical SEO set.' },
  { value: 'custom', label: 'Custom', summary: 'Pick the report sections yourself.' },
] as const;

const SECTIONS: { value: string; label: string }[] = [
  { value: 'executive-summary', label: 'Executive summary' },
  { value: 'technology-stack', label: 'Technology stack' },
  { value: 'cta', label: 'CTAs / conversion' },
  { value: 'top-issues', label: 'Top issues' },
  { value: 'performance', label: 'Performance' },
  { value: 'seo', label: 'SEO' },
  { value: 'privacy', label: 'Privacy' },
  { value: 'accessibility', label: 'Accessibility' },
  { value: 'ux', label: 'UX' },
  { value: 'technical', label: 'Technical' },
  { value: 'charts', label: 'Charts' },
  { value: 'content-insights', label: 'Content insights' },
  { value: 'pages', label: 'Pages table' },
  { value: 'source-code', label: 'Source code' },
  { value: 'history', label: 'History' },
];

export default function DispatchPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>('full');
  const isCustom = preset === 'custom';
  const summary = PRESETS.find((p) => p.value === preset)?.summary;
  const formRef = useRef<HTMLFormElement>(null);
  const [estimate, setEstimate] = useState<AuditEstimate | null>(() =>
    estimateAuditDuration({
      url: '',
      preset: 'full',
      sections: [],
      perf: false,
      llm: false,
      verify: false,
      contentResearch: false,
      concurrency: 5,
      limit: null,
      evidenceCap: 10,
    }),
  );

  // The preset radio is controlled, so recompute after React commits the new preset.
  useEffect(() => {
    if (formRef.current) refreshEstimate(formRef.current);
  }, [preset]);

  function refreshEstimate(formEl: HTMLFormElement) {
    const form = new FormData(formEl);
    const formPreset = String(form.get('preset') ?? 'full');
    // Switching to Custom fires this before the section checkboxes render;
    // they mount all checked (defaultChecked), so count every section then.
    const hasSectionInputs = formEl.querySelector('input[name="sections"]') !== null;
    const sections = hasSectionInputs ? form.getAll('sections').map(String) : SECTIONS.map((s) => s.value);
    setEstimate(
      estimateAuditDuration({
        url: String(form.get('url') ?? ''),
        preset: formPreset,
        sections: formPreset === 'custom' ? sections : [],
        perf: form.get('perf') === 'on',
        llm: form.get('llm') === 'on',
        verify: form.get('verify') === 'on',
        contentResearch: form.get('contentResearch') === 'on',
        concurrency: String(form.get('concurrency') ?? ''),
        limit: String(form.get('limit') ?? ''),
        evidenceCap: String(form.get('evidenceCap') ?? ''),
      }),
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      url: form.get('url'),
      preset,
      sections: isCustom ? form.getAll('sections') : [],
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
      <h1>Run an audit</h1>
      <form
        ref={formRef}
        className="card"
        onSubmit={onSubmit}
        onChange={(e) => refreshEstimate(e.currentTarget)}
        onInput={(e) => refreshEstimate(e.currentTarget)}
      >
        <label className="form-field">
          Website URL
          <input name="url" type="url" required placeholder="https://example.com" className="form-input" />
        </label>
        <label className="form-field">
          Access key (only if the server requires one)
          <input name="accessKey" type="password" autoComplete="current-password" className="form-input" />
        </label>
        <fieldset className="form-presets">
          <legend>Preset</legend>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <label key={p.value} className="preset-choice">
                <input
                  name="preset"
                  type="radio"
                  value={p.value}
                  checked={preset === p.value}
                  onChange={() => setPreset(p.value)}
                />
                {p.label}
              </label>
            ))}
          </div>
          <p className="muted preset-summary">{summary}</p>
        </fieldset>
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
          <p className="form-subhead" hidden={!isCustom}>Report sections</p>
          <div className="section-grid" hidden={!isCustom}>
            {SECTIONS.map((sec) => (
              <label key={sec.value} className="form-check">
                <input name="sections" type="checkbox" value={sec.value} defaultChecked /> {sec.label}
              </label>
            ))}
          </div>
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
        <div className="form-actions">
          <button type="submit" className="btn" disabled={submitting}>
            {submitting ? 'Dispatching…' : 'Start audit'}
          </button>
          <span className="muted estimate" data-testid="audit-estimate">
            {estimate ? formatEstimate(estimate) : 'Pick a section to see an estimate'}
          </span>
        </div>
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
