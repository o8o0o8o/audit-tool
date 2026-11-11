import { estimateAuditDuration, type EstimateInput } from './audit-options';

export interface RunProgress {
  processed: number;
  total: number;
  phase?: 'pages' | 'discovered';
  updatedAt?: string;
}

export interface RunFile {
  name: string;
  url?: string;
}

export interface RunStatus {
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  ghRunUrl?: string;
  files?: RunFile[];
  progress?: RunProgress;
}

export interface EtaResult {
  processed: number;
  total: number;
  percent: number;
  phaseLabel: string;
  /** Remaining minutes, or null when unknown. */
  remainingMinutes: number | null;
}

/** A run that has not started (404) or not reported progress for this long is considered stalled. */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;

// <domain>.html only — never Phase 2/3 PDF-source pages like audit-report.verified.html.
const MAIN_REPORT_PATTERN = /^(?!audit-report\.|content-research-report\.)[^/]+\.[a-z]{2,}\.html$/i;

function toMs(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Progress + remaining time. Recomputed from the current total on every poll, so a total
 * that grows mid-run (discovered links) moves the ETA; processed is clamped to total.
 */
export function computeEta(
  progress: RunProgress | null | undefined,
  startedAt: string | number | null | undefined,
  now: number,
  options: Omit<EstimateInput, 'limit'> | null,
): EtaResult {
  const total = Math.max(0, Math.floor(progress?.total ?? 0));
  const processed = Math.min(Math.max(0, Math.floor(progress?.processed ?? 0)), total);
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const phaseLabel = progress?.phase === 'discovered' ? 'discovering links' : progress ? 'crawling pages' : 'starting';

  let remainingMinutes: number | null = null;
  const start = toMs(startedAt);
  if (start !== null && processed > 0 && total > 0) {
    const elapsed = Math.max(0, now - start);
    remainingMinutes = Math.max(0, Math.ceil(((elapsed / processed) * (total - processed)) / 60000));
  } else if (options) {
    const estimate = estimateAuditDuration({ ...options, limit: total > 0 ? total : null });
    if (estimate) {
      const elapsedMin = start !== null ? Math.max(0, now - start) / 60000 : 0;
      remainingMinutes = Math.max(1, Math.ceil(estimate.minutes - elapsedMin));
    }
  }
  return { processed, total, percent, phaseLabel, remainingMinutes };
}

export function findMainReport(files: RunFile[] | null | undefined): RunFile | null {
  return files?.find((f) => MAIN_REPORT_PATTERN.test(f.name)) ?? null;
}

export type RunViewState = 'waiting' | 'running' | 'succeeded' | 'succeeded-no-report' | 'failed' | 'stalled';

/** `status` is the `/api/runs/<id>` body, or 404 when the run has not published a status yet. */
export function runViewState(status: RunStatus | 404, dispatchedAt: number | null, now: number): RunViewState {
  if (status === 404) {
    return dispatchedAt !== null && now - dispatchedAt > STALL_THRESHOLD_MS ? 'stalled' : 'waiting';
  }
  switch (status.status) {
    case 'succeeded':
      return findMainReport(status.files) ? 'succeeded' : 'succeeded-no-report';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default: {
      const last = toMs(status.progress?.updatedAt) ?? toMs(status.startedAt);
      return last !== null && now - last > STALL_THRESHOLD_MS ? 'stalled' : 'running';
    }
  }
}

export function readRunParam(search: string): string | null {
  const value = new URLSearchParams(search).get('run');
  return value ? value : null;
}
