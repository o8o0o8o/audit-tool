/**
 * Review log and the precision loop.
 *
 * `docs/gtm/review-log.csv` holds one row per highlight verdict: the reviewer approves or rejects each
 * highlight, not the prospect as a whole, so the precision of every finding type can be read off it.
 *
 * `docs/gtm/gate-suspended.json` lists finding types taken off the allowlist. During the pilot a
 * rejection on factual grounds suspends the type until someone finds the cause and resumes it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCsv, serializeCsv, withFileLock } from './csv-store';

export const DEFAULT_REVIEW_LOG = 'docs/gtm/review-log.csv';
export const DEFAULT_SUSPENDED = 'docs/gtm/gate-suspended.json';

export const REVIEW_LOG_HEADER = [
  'reviewed_at',
  'domain',
  'highlight',
  'type',
  'root_cause',
  'verdict',
  'factual',
  'reason',
  'fact',
];

export interface ReviewRow {
  reviewedAt: string;
  domain: string;
  /** 1-based position on the teaser. */
  highlight: number;
  type: string;
  rootCause: string;
  verdict: 'approve' | 'reject';
  /** A rejection because the fact is wrong (not because of tone, relevance or timing). */
  factual: boolean;
  reason: string;
  fact: string;
}

export function appendReviewRows(rows: ReviewRow[], file: string = DEFAULT_REVIEW_LOG): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(file, () => {
    const existing = fs.existsSync(file) ? parseCsv(fs.readFileSync(file, 'utf8')) : [REVIEW_LOG_HEADER];
    for (const r of rows) {
      existing.push([
        r.reviewedAt,
        r.domain,
        String(r.highlight),
        r.type,
        r.rootCause,
        r.verdict,
        r.factual ? 'yes' : '',
        r.reason,
        r.fact,
      ]);
    }
    fs.writeFileSync(file, serializeCsv(existing));
  });
}

export function readReviewRows(file: string = DEFAULT_REVIEW_LOG): ReviewRow[] {
  if (!fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, 'utf8'))
    .slice(1)
    .filter((r) => r.length >= 6)
    .map((r) => ({
      reviewedAt: r[0],
      domain: r[1],
      highlight: Number(r[2]),
      type: r[3],
      rootCause: r[4],
      verdict: r[5] === 'reject' ? 'reject' : 'approve',
      factual: r[6] === 'yes',
      reason: r[7] ?? '',
      fact: r[8] ?? '',
    }));
}

/** Approval rate per finding type: the measured precision of the gate. */
export function precisionByType(
  rows: ReviewRow[],
): Array<{ type: string; approved: number; rejected: number; factual: number; rate: number }> {
  const byType = new Map<string, { approved: number; rejected: number; factual: number }>();
  for (const r of rows) {
    const t = byType.get(r.type) ?? { approved: 0, rejected: 0, factual: 0 };
    if (r.verdict === 'approve') t.approved++;
    else {
      t.rejected++;
      if (r.factual) t.factual++;
    }
    byType.set(r.type, t);
  }
  return [...byType].map(([type, t]) => ({ type, ...t, rate: t.approved / Math.max(t.approved + t.rejected, 1) }));
}

export type SuspendedTypes = Record<string, { since: string; domain: string; reason: string }>;

export function readSuspended(file: string = DEFAULT_SUSPENDED): SuspendedTypes {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SuspendedTypes;
  } catch {
    return {};
  }
}

export function suspendType(type: string, domain: string, reason: string, file: string = DEFAULT_SUSPENDED): void {
  const all = readSuspended(file);
  all[type] ??= { since: new Date().toISOString().slice(0, 10), domain, reason };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}

export function resumeType(type: string, file: string = DEFAULT_SUSPENDED): boolean {
  const all = readSuspended(file);
  if (!(type in all)) return false;
  delete all[type];
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  return true;
}
