/**
 * Prospect lifecycle for the lead pipeline. The `stage` column of the companies CSV holds one of
 * these values; `has_audit` is separate and keeps recording full audits.
 * Diagram: docs/gtm/sales-audit-system.md, "Prospect lifecycle and data".
 */

import { DO_NOT_CONTACT, type CompanyRecord } from './csv-store';

export const STAGES = [
  'new',
  'fingerprinted',
  'unreadable',
  'selected',
  'parked',
  'scanned',
  'failed',
  'teaser_ready',
  'no_teaser',
  'approved',
  'rejected',
  'sent',
  'replied',
  'no_reply',
  'call_booked',
  'full_audit',
  DO_NOT_CONTACT,
] as const;

export type Stage = (typeof STAGES)[number];

/** Allowed moves. `do_not_contact` can be reached from anywhere and left from nowhere. */
const MOVES: Record<Stage, Stage[]> = {
  new: ['fingerprinted', 'unreadable'],
  unreadable: ['new', 'fingerprinted', 'unreadable'],
  fingerprinted: ['selected', 'parked', 'fingerprinted', 'unreadable'],
  parked: ['selected', 'parked'],
  selected: ['scanned', 'failed', 'parked', 'selected'],
  failed: ['selected', 'parked'],
  scanned: ['teaser_ready', 'no_teaser', 'scanned'],
  no_teaser: ['scanned', 'teaser_ready'],
  teaser_ready: ['approved', 'rejected', 'scanned', 'no_teaser', 'teaser_ready'],
  approved: ['sent', 'scanned'],
  rejected: ['scanned'],
  sent: ['replied', 'no_reply'],
  replied: ['call_booked'],
  no_reply: [],
  call_booked: ['full_audit'],
  full_audit: [],
  do_not_contact: [],
};

export const isStage = (value: string): value is Stage => (STAGES as readonly string[]).includes(value);

export function canMove(from: Stage, to: Stage): boolean {
  if (from === DO_NOT_CONTACT) return false;
  if (to === DO_NOT_CONTACT) return true;
  return MOVES[from].includes(to);
}

/**
 * The stage of a row. Rows written before the `stage` column existed (or by the fingerprint
 * command, which does not set it) are read from what is on the row.
 */
export function stageOf(record: CompanyRecord): Stage {
  const explicit = record.stage?.trim();
  if (explicit && isStage(explicit)) return explicit;
  if (!record.fingerprinted_at?.trim()) return 'new';
  return record.stack_kind === 'unreadable' ? 'unreadable' : 'fingerprinted';
}

/** Stages from which `select` may pick or re-pick a row: nothing has been scanned or sent yet. */
export const SELECTABLE_STAGES: Stage[] = ['fingerprinted', 'parked', 'selected'];

/** A failed scan is retried at most this many times before the row stays `failed`. */
export const MAX_SCAN_RETRIES = 2;

export function stageValues(to: Stage, now: Date = new Date()): Record<string, string> {
  return { stage: to, stage_at: now.toISOString() };
}
