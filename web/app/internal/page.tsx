'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  QUICK_SCAN,
  estimateAuditDuration,
  formatEstimate,
  type AuditEstimate,
  type EstimateInput,
} from '../../lib/audit-options';
import {
  computeEta,
  findMainReport,
  readRunParam,
  runViewState,
  type RunStatus,
  type RunViewState,
} from '../../lib/audit-progress';

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
  window.history.replaceState(null, '', runId ? `/internal?run=${encodeURIComponent(runId)}` : '/internal');
}

function formatRemaining(minutes: number | null): string {
  if (minutes === null) return 'Estimating time left…';
  if (minutes < 1) return 'Less than a minute left';
  return `About ${minutes} min left`;
}

const PRESETS = [
  {
    value: 'full',
    label: 'All sections',
    summary: 'Every report section, with no preset applied.',
  },
  {
    value: 'sales',
    label: 'Sales',
    summary: 'Short executive summary, technology stack, CTAs/conversion and top issues.',
  },
  { value: 'marketing', label: 'Marketing', summary: 'SEO, content, CTAs/conversion, UX, performance and privacy.' },
  { value: 'seo', label: 'SEO', summary: 'The full technical SEO set.' },
  { value: 'custom', label: 'Custom', summary: 'Pick the report sections yourself.' },
] as const;

// `disabled`: not working in hosted runs yet, so shown but not selectable (a disabled
// checkbox is never submitted, so the request always sends false for it).
const OPTIONS: readonly { name: string; label: string; flag: string; disabled?: boolean }[] = [
  { name: 'perf', label: 'Performance metrics', flag: '--perf' },
  { name: 'llm', label: 'LLM passes', flag: '--llm', disabled: true },
  { name: 'verify', label: 'Live verification', flag: '--verify', disabled: true },
  { name: 'contentResearch', label: 'Content research', flag: '--content-research', disabled: true },
  { name: 'visual', label: 'UI defect checks', flag: '--visual' },
  // Off by default: PDFs are printed only on request (design §2); "Generate PDF" on the run page later.
  { name: 'pdf', label: 'PDF reports', flag: '--pdf' },
];

const SCANS: readonly { value: 'full' | 'quick' | 'page'; label: string; flag: string; summary: string }[] = [
  {
    value: 'full',
    label: 'Full audit',
    flag: '--origin',
    summary:
      'Every page in the sitemap, with the security probes. Pick Quick scan for a short, read-only scan, or Single page to audit one URL.',
  },
  {
    value: 'quick',
    label: 'Quick scan',
    flag: '--lead',
    summary:
      'Reads 25 published pages, 3 at a time, and nothing else: no probing of hidden files or hosts, no lab performance run (real-user data only), UI checks on, no PDF report. Use it for sites whose owner did not ask for an audit. Works with any preset.',
  },
  {
    value: 'page',
    label: 'Single page',
    flag: '--page',
    summary:
      'Audits only the URL you enter. robots.txt and the sitemap are read just to say whether this page is blocked or listed; checks that compare pages or probe the domain (DNS, exposed files, staging hosts) are skipped. Works with any preset.',
  },
];

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
  /** Full audit, Quick scan (`--lead`) or Single page (`--page`). */
  const [scan, setScan] = useState<'full' | 'quick' | 'page'>('full');
  const quickScan = scan === 'quick';
  const singlePage = scan === 'page';
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
      visual: false,
      concurrency: 5,
      limit: null,
      evidenceCap: 10,
    }),
  );

  // The preset radio and the quick scan switch are controlled, so recompute after React commits them.
  useEffect(() => {
    if (formRef.current) refreshEstimate(formRef.current);
  }, [preset, scan]);

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
        const res = await fetch(`/api/internal/audits/${encodeURIComponent(runId!)}/status`, { cache: 'no-store' });
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
        visual: form.get('visual') === 'on',
        concurrency: String(form.get('concurrency') ?? ''),
        limit: String(form.get('limit') ?? ''),
        evidenceCap: String(form.get('evidenceCap') ?? ''),
        quickScan: form.get('scan') === 'quick',
        singlePage: form.get('scan') === 'page',
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
      visual: form.get('visual') === 'on',
      pdf: form.get('pdf') === 'on',
      concurrency: form.get('concurrency'),
      limit: form.get('limit'),
      evidenceCap: form.get('evidenceCap'),
      quickScan: form.get('scan') === 'quick',
      singlePage: form.get('scan') === 'page',
    };
    setSubmitting(true);
    setError(null);
    clearRun();
    try {
      const res = await fetch('/api/internal/audits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { runId?: string; error?: string; message?: string };
      if (!res.ok || !data.runId) setError(data.message ?? data.error ?? `Dispatch failed (${res.status})`);
      else {
        const options: Omit<EstimateInput, 'limit'> = {
          url: String(body.url ?? ''),
          preset,
          sections: body.sections.map(String),
          perf: body.perf,
          llm: body.llm,
          verify: body.verify,
          contentResearch: body.contentResearch,
          visual: body.visual,
          concurrency: String(body.concurrency ?? ''),
          evidenceCap: String(body.evidenceCap ?? ''),
          quickScan: body.quickScan,
          singlePage: body.singlePage,
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
      <button type="button" className="btn btn--outline" onClick={clearRun}>
        New audit
      </button>
    );

    if (state === 'waiting' || state === 'running') {
      const eta = computeEta(
        status?.progress,
        status?.startedAt ?? storedRun.current?.dispatchedAt,
        now,
        storedRun.current?.options ?? null,
      );
      const hasProgress = eta.total > 0;
      return (
        <div
          className="audit-overlay"
          data-testid="audit-overlay"
          role="dialog"
          aria-modal="true"
          aria-busy="true"
          aria-label="Audit in progress"
        >
          <div className="audit-overlay-card card">
            <h2>{state === 'waiting' ? 'Starting the audit…' : 'Audit running'}</h2>
            <p className="muted">
              Run {id} · {eta.phaseLabel}
            </p>
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={eta.percent}
            >
              <div className="progress-bar-fill" style={{ width: `${hasProgress ? eta.percent : 0}%` }} />
            </div>
            <p className="progress-count">
              {hasProgress ? `${eta.processed} / ${eta.total} pages` : 'Waiting for the crawler to start'}
            </p>
            <p className="muted">{formatRemaining(eta.remainingMinutes)}</p>
            {ghLink && <p>{ghLink}</p>}
          </div>
        </div>
      );
    }

    if (state === 'stalled') {
      return (
        <div
          className="audit-overlay"
          data-testid="audit-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Audit stalled"
        >
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
      const src = main.url ?? `/internal/audits/${id}/report`;
      return (
        <section className="run-result">
          <p className="run-result-actions">
            Audit finished.{' '}
            <a className="link-accent" href={`/internal/audits/${id}/view`} target="_blank" rel="noreferrer">
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
              <a className="link-accent" href={f.url ?? '#'} target="_blank" rel="noreferrer">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
        <p>
          <a className="link-accent" href={`/internal/audits/${id}`}>
            View run {id}
          </a>
        </p>
        {newAudit}
      </section>
    );
  }

  return (
    <section className="section contacts" aria-labelledby="audit-heading">
      <div className="container">
        <div className="contacts__wrap">
          <div className="contacts__wrap-left">
            <div className="contacts__header">
              <h1 className="section__title section__title--sm" id="audit-heading">
                Website Audit
              </h1>
              <p className="contacts__text">
                Crawls the site and checks SEO, performance, accessibility, security and UX. The report opens here when
                the run finishes.
              </p>
            </div>
            <ul className="contacts__list list-arrow">
              <li>Every page in the sitemap</li>
              <li>Prioritised findings</li>
              <li>PDF and HTML report</li>
            </ul>
          </div>

          <div className="contacts__wrap-right">
            <form
              ref={formRef}
              inert={polling || view === 'stalled'}
              className="contacts-form"
              aria-label="Audit form"
              onSubmit={onSubmit}
              onChange={(e) => refreshEstimate(e.currentTarget)}
              onInput={(e) => refreshEstimate(e.currentTarget)}
            >
              <div className="contacts-form__wrap">
                <div className="contacts-form__item">
                  <label className="contacts-form__label" htmlFor="audit-url">
                    {singlePage ? 'Page URL' : 'Website URL'}
                  </label>
                  <input
                    id="audit-url"
                    name="url"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    required
                    placeholder={singlePage ? 'Page URL (example.com/pricing)' : 'Website URL (example.com)'}
                    className="form-input"
                  />
                </div>
                <div className="contacts-form__item">
                  <span className="contacts-form__label" id="audit-preset-label">
                    Preset
                  </span>
                  <div className="contacts-form__checklist" role="radiogroup" aria-labelledby="audit-preset-label">
                    {PRESETS.map((p) => (
                      <label key={p.value} className="checkbox-button">
                        <input
                          name="preset"
                          type="radio"
                          value={p.value}
                          checked={preset === p.value}
                          onChange={() => setPreset(p.value)}
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="contacts-form__hint">{summary}</p>
                </div>

                <div className="contacts-form__item" hidden={!isCustom}>
                  <span className="contacts-form__label" id="audit-sections-label">
                    Report sections
                  </span>
                  <div className="contacts-form__checklist" role="group" aria-labelledby="audit-sections-label">
                    {SECTIONS.map((sec) => (
                      <label key={sec.value} className="checkbox-button">
                        <input name="sections" type="checkbox" value={sec.value} defaultChecked />
                        <span>{sec.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="contacts-form__item">
                  <span className="contacts-form__label" id="audit-scan-label">
                    Scan
                  </span>
                  <div className="contacts-form__checklist" role="radiogroup" aria-labelledby="audit-scan-label">
                    {SCANS.map((sc) => (
                      <label key={sc.value} className="checkbox-button" title={sc.flag}>
                        <input
                          name="scan"
                          type="radio"
                          value={sc.value}
                          checked={scan === sc.value}
                          onChange={() => setScan(sc.value)}
                        />
                        <span>{sc.label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="contacts-form__hint">{SCANS.find((sc) => sc.value === scan)?.summary}</p>
                </div>

                <div className="contacts-form__item">
                  <span className="contacts-form__label" id="audit-options-label">
                    Options
                  </span>
                  <div className="contacts-form__checklist" role="group" aria-labelledby="audit-options-label">
                    {OPTIONS.map((o) => {
                      // A quick scan fixes these: no lab performance run, UI checks always on.
                      const fixedByQuickScan = quickScan && (o.name === 'perf' || o.name === 'visual');
                      const disabled = o.disabled || fixedByQuickScan;
                      return (
                        <label
                          // Remount when Quick scan flips, so the input never switches between controlled and not.
                          key={`${o.name}-${fixedByQuickScan}`}
                          className={disabled ? 'checkbox-button checkbox-button--disabled' : 'checkbox-button'}
                          title={
                            o.disabled
                              ? `${o.label} is not available yet`
                              : fixedByQuickScan
                                ? `Set by Quick scan`
                                : o.flag
                          }
                        >
                          <input
                            name={o.name}
                            type="checkbox"
                            disabled={disabled}
                            {...(fixedByQuickScan ? { checked: o.name === 'visual', readOnly: true } : {})}
                          />
                          <span>{o.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {scan === 'full' ? (
                  <>
                    <div className="contacts-form__item contacts-form__item--span-1 contacts-form__item--keep-label">
                      <label className="contacts-form__label" htmlFor="audit-concurrency">
                        Concurrency (1–20)
                      </label>
                      <input
                        id="audit-concurrency"
                        name="concurrency"
                        type="number"
                        min={1}
                        max={20}
                        defaultValue={5}
                        placeholder="Concurrency (1–20)"
                        className="form-input"
                      />
                    </div>
                    <div className="contacts-form__item contacts-form__item--span-1 contacts-form__item--keep-label">
                      <label className="contacts-form__label" htmlFor="audit-evidence-cap">
                        Evidence cap (1–100)
                      </label>
                      <input
                        id="audit-evidence-cap"
                        name="evidenceCap"
                        type="number"
                        min={1}
                        max={100}
                        defaultValue={10}
                        placeholder="Evidence cap (1–100)"
                        className="form-input"
                      />
                    </div>
                    <div className="contacts-form__item">
                      <label className="contacts-form__label" htmlFor="audit-limit">
                        Page limit (optional)
                      </label>
                      <input
                        id="audit-limit"
                        name="limit"
                        type="number"
                        min={1}
                        placeholder="Page limit (all pages when empty)"
                        className="form-input"
                      />
                    </div>
                  </>
                ) : (
                  <p className="contacts-form__item contacts-form__hint">
                    {quickScan
                      ? `Crawl settings are fixed for a quick scan: ${QUICK_SCAN.pages} pages, ${QUICK_SCAN.concurrency} at a time, evidence for ${QUICK_SCAN.evidenceCap}.`
                      : 'Crawl settings do not apply to a single page.'}
                  </p>
                )}

                <div className="contacts-form__item">
                  <button type="submit" className="btn btn--xl btn--block roll" disabled={submitting}>
                    <span className="roll__box">
                      <span data-text={submitting ? 'Dispatching…' : 'Start audit'}>
                        {submitting ? 'Dispatching…' : 'Start audit'}
                      </span>
                    </span>
                  </button>
                  <p className="contacts-form__note" data-testid="audit-estimate">
                    {estimate ? formatEstimate(estimate) : 'Pick a section to see an estimate'}
                  </p>
                  {error && (
                    <p role="alert" className="form-error">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
        {runId && view && renderRun(runId, view)}
      </div>
    </section>
  );
}
