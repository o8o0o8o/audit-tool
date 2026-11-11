'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { estimateAuditDuration, formatEstimate, type AuditEstimate, type EstimateInput } from '../lib/audit-options';
import { computeEta, findMainReport, readRunParam, runViewState, type RunStatus, type RunViewState } from '../lib/audit-progress';

const POLL_MS = 15_000;
const RUN_STORAGE_PREFIX = 'audit-run:';

interface StoredRun {
  dispatchedAt: number;
  options: Omit<EstimateInput, 'limit'> | null;
}

function loadStoredRun(runId: string): StoredRun | null {
  try {
    const raw = sessionStorage.getItem(RUN_STORAGE_PREFIX + runId);
    return raw ? (JSON.parse(raw) as StoredRun) : null;
  } catch {
    return null;
  }
}

function saveStoredRun(runId: string, run: StoredRun) {
  try {
    sessionStorage.setItem(RUN_STORAGE_PREFIX + runId, JSON.stringify(run));
  } catch {
    /* storage unavailable: the stall timer then starts from page load */
  }
}

function setRunParam(runId: string | null) {
  window.history.replaceState(null, '', runId ? `/?run=${encodeURIComponent(runId)}` : '/');
}

function formatRemaining(minutes: number | null): string {
  if (minutes === null) return 'Estimating time left…';
  if (minutes < 1) return 'Less than a minute left';
  return `About ${minutes} min left`;
}

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
  const [runStatus, setRunStatus] = useState<RunStatus | 404 | null>(null);
  const [view, setView] = useState<RunViewState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const storedRun = useRef<StoredRun | null>(null);
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

  useEffect(() => {
    const id = readRunParam(window.location.search);
    if (!id) return;
    storedRun.current = loadStoredRun(id);
    if (!storedRun.current) {
      storedRun.current = { dispatchedAt: Date.now(), options: null };
      saveStoredRun(id, storedRun.current);
    }
    setRunId(id);
    setView('waiting');
  }, []);

  const polling = runId !== null && (view === 'waiting' || view === 'running');
  // Keep polling while 'stalled' too: post-crawl phases (PDF, --verify, --llm) stop
  // updating progress, so a healthy run can look stalled and must still recover.
  const fetching = polling || (runId !== null && view === 'stalled');

  useEffect(() => {
    if (!runId || !fetching) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId!)}`, { cache: 'no-store' });
        if (cancelled) return;
        let status: RunStatus | 404 | null = null;
        if (res.status === 404) status = 404;
        else if (res.ok) status = (await res.json()) as RunStatus;
        if (cancelled) return;
        const t = Date.now();
        setNow(t);
        if (status === null) {
          // Transient API error: keep waiting, but still let the stall timer fire.
          setView((v) => (v === 'waiting' ? runViewState(404, storedRun.current?.dispatchedAt ?? null, t) : v));
          return;
        }
        setRunStatus(status);
        setView(runViewState(status, storedRun.current?.dispatchedAt ?? null, t));
      } catch {
        /* network blip: next tick retries */
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId, fetching]);

  function clearRun() {
    setRunParam(null);
    setRunId(null);
    setRunStatus(null);
    setView(null);
  }

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
    clearRun();
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dispatch-key': String(form.get('accessKey') ?? '') },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) setError(data.error ?? `Dispatch failed (${res.status})`);
      else {
        const options: Omit<EstimateInput, 'limit'> = {
          url: String(body.url ?? ''),
          preset,
          sections: body.sections.map(String),
          perf: body.perf,
          llm: body.llm,
          verify: body.verify,
          contentResearch: body.contentResearch,
          concurrency: String(body.concurrency ?? ''),
          evidenceCap: String(body.evidenceCap ?? ''),
        };
        storedRun.current = { dispatchedAt: Date.now(), options };
        saveStoredRun(data.runId, storedRun.current);
        setRunParam(data.runId);
        setRunId(data.runId);
        setView('waiting');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dispatch failed');
    } finally {
      setSubmitting(false);
    }
  }

  function renderRun(id: string, state: RunViewState) {
    const status = runStatus !== 404 ? runStatus : null;
    const ghLink = status?.ghRunUrl ? (
      <a className="link-accent" href={status.ghRunUrl} target="_blank" rel="noreferrer">
        GitHub Actions run
      </a>
    ) : null;
    const newAudit = (
      <button type="button" className="btn btn-secondary" onClick={clearRun}>
        New audit
      </button>
    );

    if (state === 'waiting' || state === 'running') {
      const eta = computeEta(status?.progress, status?.startedAt ?? storedRun.current?.dispatchedAt, now, storedRun.current?.options ?? null);
      const hasProgress = eta.total > 0;
      return (
        <div className="audit-overlay" data-testid="audit-overlay" role="dialog" aria-modal="true" aria-busy="true" aria-label="Audit in progress">
          <div className="audit-overlay-card card">
            <h2>{state === 'waiting' ? 'Starting the audit…' : 'Audit running'}</h2>
            <p className="muted">Run {id} · {eta.phaseLabel}</p>
            <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={eta.percent}>
              <div className="progress-bar-fill" style={{ width: `${hasProgress ? eta.percent : 0}%` }} />
            </div>
            <p className="progress-count">{hasProgress ? `${eta.processed} / ${eta.total} pages` : 'Waiting for the crawler to start'}</p>
            <p className="muted">{formatRemaining(eta.remainingMinutes)}</p>
            {ghLink && <p>{ghLink}</p>}
          </div>
        </div>
      );
    }

    if (state === 'stalled') {
      return (
        <div className="audit-overlay" data-testid="audit-overlay" role="dialog" aria-modal="true" aria-label="Audit stalled">
          <div className="audit-overlay-card card">
            <h2>The audit seems stalled</h2>
            <p className="muted">No progress for more than 10 minutes on run {id}.</p>
            {ghLink && <p>{ghLink}</p>}
            <button type="button" className="btn" onClick={clearRun}>
              Stop waiting
            </button>
          </div>
        </div>
      );
    }

    if (state === 'failed') {
      return (
        <section className="run-result card">
          <p role="alert" className="error">
            {status?.status === 'cancelled' ? 'The audit was cancelled.' : 'The audit failed.'} {status?.error}
          </p>
          {ghLink && <p>{ghLink}</p>}
          {newAudit}
        </section>
      );
    }

    const main = findMainReport(status?.files);
    if (state === 'succeeded' && main) {
      const src = `/view/${id}/${main.name}`;
      return (
        <section className="run-result">
          <p className="run-result-actions">
            Audit finished.{' '}
            <a className="link-accent" href={src} target="_blank" rel="noreferrer">
              Open report in a new tab
            </a>{' '}
            {newAudit}
          </p>
          <iframe className="report-frame" data-testid="report-frame" src={src} title={`Audit report ${main.name}`} />
        </section>
      );
    }

    return (
      <section className="run-result card">
        <p>Audit finished, but no main HTML report was found.</p>
        <ul>
          {(status?.files ?? []).map((f) => (
            <li key={f.name}>
              <a className="link-accent" href={`/view/${id}/${f.name}`} target="_blank" rel="noreferrer">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
        <p>
          <a className="link-accent" href={`/runs/${id}`}>
            View run {id}
          </a>
        </p>
        {newAudit}
      </section>
    );
  }

  return (
    <main>
      <h1>Run an audit</h1>
      <form
        ref={formRef}
        inert={polling || view === 'stalled'}
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
      {runId && view && renderRun(runId, view)}
    </main>
  );
}
