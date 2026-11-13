/**
 * Stage 2 of the lead pipeline: a fit score from 0 to 100 and a track per prospect.
 * Pure: reads one CSV row and the weights, makes no request.
 *
 * The weights live in `docs/gtm/lead-weights.json` so that sales can change them without touching
 * code. A signal the row has no data for scores zero and is listed in `missing`, so a low score can
 * be told apart from a thin row.
 */

import * as fs from 'node:fs';
import type { CompanyRecord } from './csv-store';
import { trackOf } from './stack-profile';
import type { StackKind, Track } from './types';

export const DEFAULT_WEIGHTS_PATH = 'docs/gtm/lead-weights.json';

export interface LeadWeights {
  weights: {
    stack: number;
    endOfLife: number;
    traffic: number;
    languages: number;
    jobKeywords: number;
    blogVelocity: number;
  };
  /** Share of the stack points per stack kind (kinds not listed earn nothing). */
  stackShare: Partial<Record<StackKind, number>>;
  /** Multiplier on the stack points when the stack is known at low confidence only. */
  lowConfidenceShare: number;
  /** Multiplier on the end-of-life points when the only hit is a PHP version from a header. */
  phpOnlyEndOfLifeShare: number;
  traffic: { floor: number; ceiling: number };
  languages: { minimum: number };
}

export const DEFAULT_WEIGHTS: LeadWeights = {
  weights: { stack: 30, endOfLife: 15, traffic: 20, languages: 10, jobKeywords: 15, blogVelocity: 10 },
  stackShare: { legacy: 1, hybrid: 1, builder: 0.5 },
  lowConfidenceShare: 0.7,
  phpOnlyEndOfLifeShare: 0.5,
  traffic: { floor: 1000, ceiling: 1_000_000 },
  languages: { minimum: 2 },
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Reads the weights file; a missing key falls back to the default, a wrong type is an error. */
export function loadWeights(file: string = DEFAULT_WEIGHTS_PATH): LeadWeights {
  if (!fs.existsSync(file)) return DEFAULT_WEIGHTS;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const pick = <T extends object>(section: string, defaults: T): T => {
    const given = (raw[section] ?? {}) as Record<string, unknown>;
    const out = { ...defaults } as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      if (given[key] === undefined) continue;
      if (!isNumber(given[key])) throw new Error(`${file}: "${section}.${key}" must be a number of 0 or more`);
      out[key] = given[key];
    }
    return out as T;
  };
  const scalar = (key: 'lowConfidenceShare' | 'phpOnlyEndOfLifeShare') => {
    if (raw[key] === undefined) return DEFAULT_WEIGHTS[key];
    if (!isNumber(raw[key])) throw new Error(`${file}: "${key}" must be a number of 0 or more`);
    return raw[key];
  };
  const weights = pick('weights', DEFAULT_WEIGHTS.weights);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 100) throw new Error(`${file}: the weights add up to ${total}; the maximum is 100`);
  const traffic = pick('traffic', DEFAULT_WEIGHTS.traffic);
  if (traffic.ceiling <= traffic.floor || traffic.floor <= 0) {
    throw new Error(`${file}: "traffic.ceiling" must be above "traffic.floor", and the floor above 0`);
  }
  return {
    weights,
    stackShare: pick('stackShare', { legacy: 1, hybrid: 1, builder: 0.5 } as Record<
      string,
      number
    >) as LeadWeights['stackShare'],
    lowConfidenceShare: scalar('lowConfidenceShare'),
    phpOnlyEndOfLifeShare: scalar('phpOnlyEndOfLifeShare'),
    traffic,
    languages: pick('languages', DEFAULT_WEIGHTS.languages),
  };
}

export interface ScoreLine {
  signal: 'stack' | 'endOfLife' | 'traffic' | 'languages' | 'jobKeywords' | 'blogVelocity';
  points: number;
  max: number;
  note: string;
}

export interface FitScore {
  score: number;
  track: Track | null;
  lines: ScoreLine[];
  /** Signals the row has no data for. */
  missing: string[];
  /** Why the row must not be selected for a scan, whatever its score; null when it may be. */
  blocker: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function trafficShare(traffic: number, floor: number, ceiling: number): number {
  if (!(traffic > floor)) return 0;
  if (traffic >= ceiling) return 1;
  return (Math.log10(traffic) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor));
}

/** A cell with a number in it, or null when it is empty or not a number. */
function numberCell(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/[\s,_]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 0–1 from a cell that holds a share (`0.6`), a percentage (`60%`) or yes/no. */
function shareCell(value: string | undefined): number | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  if (['yes', 'true', 'y'].includes(trimmed)) return 1;
  if (['no', 'false', 'n'].includes(trimmed)) return 0;
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (percent) return Math.min(Number(percent[1]) / 100, 1);
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? 1 : n;
}

export function scoreCompany(record: CompanyRecord, config: LeadWeights = DEFAULT_WEIGHTS): FitScore {
  const w = config.weights;
  const lines: ScoreLine[] = [];
  const missing: string[] = [];
  const kind = (record.stack_kind?.trim() || null) as StackKind | null;

  let blocker: string | null = null;
  if (!record.fingerprinted_at?.trim()) blocker = 'not fingerprinted yet';
  else if (kind === 'unreadable') blocker = 'site could not be read';
  else if (/\brobots:disallow-all\b/.test(record.stack_signals ?? '')) blocker = 'robots.txt disallows the whole site';
  else if (/\bredirect:/.test(record.stack_signals ?? '')) blocker = 'homepage redirects to another site';

  // Stack
  const share = kind ? (config.stackShare[kind] ?? 0) : 0;
  const lowConfidence = record.stack_confidence === 'low';
  const stackPoints = w.stack * share * (lowConfidence ? config.lowConfidenceShare : 1);
  const stackLabel = [record.cms_detected, record.cms_secondary].filter(Boolean).join(' + ');
  lines.push({
    signal: 'stack',
    points: round1(stackPoints),
    max: w.stack,
    note: kind
      ? `${kind}${stackLabel ? ` (${stackLabel})` : ''}${lowConfidence && share ? ', low confidence' : ''}`
      : 'unknown',
  });
  if (!kind) missing.push('stack');

  // End of life
  const eolEntries = (record.eol ?? '')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const phpOnly = eolEntries.length > 0 && eolEntries.every((e) => /^PHP\b/i.test(e));
  const eolPoints = eolEntries.length ? w.endOfLife * (phpOnly ? config.phpOnlyEndOfLifeShare : 1) : 0;
  lines.push({
    signal: 'endOfLife',
    points: round1(eolPoints),
    max: w.endOfLife,
    note: eolEntries.length ? eolEntries.join(', ') + (phpOnly ? ' (header only)' : '') : 'none seen',
  });

  // Traffic
  const traffic = numberCell(record.traffic);
  if (traffic === null) missing.push('traffic');
  lines.push({
    signal: 'traffic',
    points: round1(w.traffic * trafficShare(traffic ?? 0, config.traffic.floor, config.traffic.ceiling)),
    max: w.traffic,
    note: traffic === null ? 'no data' : `${traffic.toLocaleString('en-US')} visits`,
  });

  // Languages
  const languages = numberCell(record.languages);
  if (languages === null) missing.push('languages');
  lines.push({
    signal: 'languages',
    points: languages !== null && languages >= config.languages.minimum ? w.languages : 0,
    max: w.languages,
    note: languages === null ? 'no data' : `${languages} language${languages === 1 ? '' : 's'}`,
  });

  // Signals that need an export from the signal sheets: columns `job_keywords` and `blog_velocity`.
  for (const [signal, column] of [
    ['jobKeywords', 'job_keywords'],
    ['blogVelocity', 'blog_velocity'],
  ] as const) {
    const value = shareCell(record[column]);
    if (value === null) missing.push(column);
    lines.push({
      signal,
      points: round1(w[signal] * (value ?? 0)),
      max: w[signal],
      note: value === null ? 'no data' : record[column].trim(),
    });
  }

  const score = Math.round(lines.reduce((sum, l) => sum + l.points, 0));
  return { score, track: kind ? trackOf(kind) : null, lines, missing, blocker };
}

/** `stack 30; eol 15; traffic 12.4; lang 10` — the reasons column, non-zero lines only. */
export function formatReasons(fit: FitScore): string {
  const short: Record<ScoreLine['signal'], string> = {
    stack: 'stack',
    endOfLife: 'eol',
    traffic: 'traffic',
    languages: 'lang',
    jobKeywords: 'jobs',
    blogVelocity: 'blog',
  };
  const parts = fit.lines.filter((l) => l.points > 0).map((l) => `${short[l.signal]} ${l.points}`);
  if (fit.blocker) parts.push(`blocked: ${fit.blocker}`);
  return parts.join('; ');
}

export interface Ranked {
  record: CompanyRecord;
  fit: FitScore;
}

/** Highest score first; ties go to the larger site. */
export function rank(records: CompanyRecord[], config: LeadWeights = DEFAULT_WEIGHTS): Ranked[] {
  return records
    .map((record) => ({ record, fit: scoreCompany(record, config) }))
    .sort(
      (a, b) => b.fit.score - a.fit.score || (numberCell(b.record.traffic) ?? 0) - (numberCell(a.record.traffic) ?? 0),
    );
}
