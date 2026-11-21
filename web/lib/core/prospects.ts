/**
 * Prospects (design §4, tasks 2.1/2.5). The only prospect store; companies.csv becomes an export.
 * Rows carry the CSV's own columns in `extra`, so the lead pipeline's API store round-trips them.
 */
import { and, arrayOverlaps, asc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { actionLog, prospects } from '../../db/schema';
import { CoreError } from './errors';
import { principalLabel, requireScope, type Principal } from './principal';
import { normalizeHost, registrableDomainOf } from './sites';

type ProspectRow = typeof prospects.$inferSelect;

/** Columns stored as real columns; every other CSV column goes to `extra`. */
const COLUMNS = new Set(['company', 'website', 'fit_score', 'stage', 'stage_at', 'has_audit', 'owner', 'notes']);
export const DO_NOT_CONTACT_STAGE = 'do_not_contact';

export interface ProspectView {
  id: string;
  company: string;
  website: string | null;
  registrable_domains: string[];
  fit_score: number | null;
  stage: string;
  stage_at: string;
  do_not_contact: boolean;
  has_audit: string | null;
  owner: string | null;
  notes: string | null;
  /** All CSV columns as the pipeline reads them (CompanyRecord). */
  record: Record<string, string>;
}

export function toView(r: ProspectRow): ProspectView {
  const record: Record<string, string> = {
    ...r.extra,
    company: r.company,
    website: r.website ?? '',
    fit_score: r.fitScore === null ? (r.extra.fit_score ?? '') : String(r.fitScore),
    stage: r.stage,
    stage_at: r.extra.stage_at ?? r.stageAt.toISOString(),
    has_audit: r.hasAudit ?? '',
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
  };
  return {
    id: r.id,
    company: r.company,
    website: r.website,
    registrable_domains: r.registrableDomains,
    fit_score: r.fitScore,
    stage: r.stage,
    stage_at: r.stageAt.toISOString(),
    do_not_contact: r.doNotContact,
    has_audit: r.hasAudit,
    owner: r.owner,
    notes: r.notes,
    record,
  };
}

const intOrNull = (v: string | undefined) => (v && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** A CSV record (all string values) → row values. */
export function rowFromRecord(record: Record<string, string>) {
  const website = (record.website ?? '').trim();
  const host = website ? normalizeHost(website) : '';
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(record))
    if (!COLUMNS.has(k) || k === 'stage_at' || k === 'fit_score') extra[k] = v ?? '';
  const stage = (record.stage ?? '').trim() || 'new';
  const stageAt =
    record.stage_at && !Number.isNaN(Date.parse(record.stage_at)) ? new Date(record.stage_at) : new Date();
  const hasAudit = ['yes', 'failed'].includes((record.has_audit ?? '').trim()) ? record.has_audit!.trim() : null;
  return {
    company: (record.company ?? '').trim() || host || 'unknown',
    website: website || null,
    registrableDomains: host ? [registrableDomainOf(host)] : [],
    fitScore: intOrNull(record.fit_score),
    stage,
    stageAt,
    doNotContact: stage === DO_NOT_CONTACT_STAGE,
    hasAudit,
    owner: record.owner?.trim() || null,
    notes: record.notes?.trim() || null,
    extra,
  };
}

export const ListProspectsInput = z.object({
  stage: z.string().nullish(),
  fit_score_min: z.number().int().nullish(),
  do_not_contact: z.boolean().nullish(),
  domain: z.string().nullish(),
  limit: z.number().int().min(1).max(5000).nullish(),
});

export async function listProspects(
  db: Db,
  principal: Principal,
  raw: z.infer<typeof ListProspectsInput> = {},
): Promise<ProspectView[]> {
  requireScope(principal, 'prospects:read');
  const input = ListProspectsInput.parse(raw);
  const where: SQL[] = [];
  if (input.stage) where.push(eq(prospects.stage, input.stage));
  if (input.fit_score_min != null) where.push(gte(prospects.fitScore, input.fit_score_min));
  if (input.do_not_contact != null) where.push(eq(prospects.doNotContact, input.do_not_contact));
  if (input.domain)
    where.push(arrayOverlaps(prospects.registrableDomains, [registrableDomainOf(normalizeHost(input.domain))]));
  const rows = await db
    .select()
    .from(prospects)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(prospects.company))
    .limit(input.limit ?? 5000);
  return rows.map(toView);
}

export async function getProspect(db: Db, principal: Principal, domain: string): Promise<ProspectView | null> {
  requireScope(principal, 'prospects:read');
  const reg = registrableDomainOf(normalizeHost(domain));
  const [row] = await db
    .select()
    .from(prospects)
    .where(arrayOverlaps(prospects.registrableDomains, [reg]))
    .limit(1);
  return row ? toView(row) : null;
}

/** Creates a prospect, or updates the one with the same website. */
export async function upsertProspect(
  db: Db,
  principal: Principal,
  record: Record<string, string>,
): Promise<ProspectView> {
  requireScope(principal, 'prospects:write');
  const values = rowFromRecord(record);
  if (!values.website) throw new CoreError('invalid_input', 'website is required');
  // A do_not_contact row is never changed, by this path or any other.
  const [existing] = await db.select().from(prospects).where(eq(prospects.website, values.website));
  if (existing?.doNotContact) throw new CoreError('do_not_contact', 'a do_not_contact prospect is never changed');
  const [row] = await db
    .insert(prospects)
    .values(values)
    .onConflictDoUpdate({
      target: prospects.website,
      set: values,
      setWhere: eq(prospects.doNotContact, false),
    })
    .returning();
  // No row back: the prospect became do_not_contact between the check and the write.
  if (!row) throw new CoreError('do_not_contact', 'a do_not_contact prospect is never changed');
  if (values.doNotContact)
    await db
      .insert(actionLog)
      .values({ principal: principalLabel(principal), action: 'prospect_do_not_contact', target: values.website });
  return toView(row);
}

/**
 * Updates some columns of a prospect. A `do_not_contact` row is never changed (and never leaves
 * that stage); a move into do_not_contact is logged.
 */
export async function patchProspect(
  db: Db,
  principal: Principal,
  id: string,
  values: Record<string, string>,
): Promise<ProspectView> {
  requireScope(principal, 'prospects:write');
  const [row] = await db
    .select()
    .from(prospects)
    .where(eq(prospects.id, z.uuid().parse(id)));
  if (!row) throw new CoreError('not_found', 'prospect not found');
  if (row.doNotContact) throw new CoreError('do_not_contact', 'a do_not_contact prospect is never changed');
  const merged = { ...toView(row).record, ...values };
  const next = rowFromRecord(merged);
  const [updated] = await db
    .update(prospects)
    .set({ ...next, website: row.website })
    .where(eq(prospects.id, row.id))
    .returning();
  if (next.doNotContact)
    await db.insert(actionLog).values({
      principal: principalLabel(principal),
      action: 'prospect_do_not_contact',
      target: row.website ?? row.id,
    });
  else if (Object.keys(values).length)
    await db.insert(actionLog).values({
      principal: principalLabel(principal),
      action: 'prospect_edit',
      target: `${row.website}: ${Object.keys(values).join(',')}`,
    });
  return toView(updated!);
}

export async function countProspects(db: Db) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`, dnc: sql<number>`count(*) filter (where do_not_contact)::int` })
    .from(prospects);
  return r!;
}
