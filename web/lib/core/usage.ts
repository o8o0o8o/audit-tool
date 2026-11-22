/**
 * Usage per user, counted from the `audits` rows: no table of its own. A user is a person who logs
 * in to /internal (`audits.created_by_admin_id`), an API client (`created_by_client_id`), or, for
 * audits that name neither, their source (public scans, the pipeline, scripts).
 *
 * Counts cover audits that still exist: deleting a site deletes its audits and their usage with it.
 * Pages are the pages an audit loaded, which the audit row keeps after its page data is deleted.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { admins, apiClients, audits } from '../../db/schema';
import { requireInternal, type Principal } from './principal';

export interface UsageRow {
  user_kind: 'admin' | 'client' | 'other';
  /** Admin's email, API client's name, or the source for audits with no user. */
  user: string;
  name: string | null;
  audits: number;
  websites: number;
  pages: number;
  /** Audits by type. */
  full: number;
  quick: number;
  page: number;
  succeeded: number;
  failed: number;
  last_audit_at: string | null;
}

export const USAGE_DEFAULT_DAYS = 30;

/** Usage between `from` (inclusive) and `to` (exclusive), by the audit's creation time; busiest first. */
export async function usageByUser(
  db: Db,
  principal: Principal,
  range: { from?: Date; to?: Date } = {},
  now = new Date(),
): Promise<{ from: string; to: string; rows: UsageRow[] }> {
  requireInternal(principal);
  const to = range.to ?? now;
  const from = range.from ?? new Date(to.getTime() - USAGE_DEFAULT_DAYS * 86400_000);
  const count = (cond: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${cond})::int`;
  const rows = await db
    .select({
      adminId: audits.createdByAdminId,
      clientId: audits.createdByClientId,
      source: sql<string>`case when ${audits.createdByAdminId} is null and ${audits.createdByClientId} is null then ${audits.source} end`,
      email: admins.email,
      adminName: admins.name,
      clientName: apiClients.name,
      audits: sql<number>`count(*)::int`,
      websites: sql<number>`count(distinct ${audits.siteId})::int`,
      pages: sql<number>`coalesce(sum(${audits.pagesProcessed}), 0)::int`,
      full: count(sql`${audits.mode} = 'full'`),
      quick: count(sql`${audits.mode} = 'quick'`),
      page: count(sql`${audits.mode} = 'page'`),
      succeeded: count(sql`${audits.status} = 'succeeded'`),
      failed: count(sql`${audits.status} = 'failed'`),
      last: sql<Date | null>`max(${audits.createdAt})`,
    })
    .from(audits)
    .leftJoin(admins, eq(admins.id, audits.createdByAdminId))
    .leftJoin(apiClients, eq(apiClients.id, audits.createdByClientId))
    .where(and(gte(audits.createdAt, from), lt(audits.createdAt, to)))
    .groupBy(
      audits.createdByAdminId,
      audits.createdByClientId,
      sql`case when ${audits.createdByAdminId} is null and ${audits.createdByClientId} is null then ${audits.source} end`,
      admins.email,
      admins.name,
      apiClients.name,
    )
    .orderBy(desc(sql`coalesce(sum(${audits.pagesProcessed}), 0)`), desc(sql`count(*)`));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rows: rows.map((r) => ({
      user_kind: r.adminId ? 'admin' : r.clientId ? 'client' : 'other',
      user: r.adminId
        ? (r.email ?? 'deleted admin')
        : r.clientId
          ? (r.clientName ?? 'deleted client')
          : (r.source ?? 'internal'),
      name: r.adminId ? r.adminName : null,
      audits: r.audits,
      websites: r.websites,
      pages: r.pages,
      full: r.full,
      quick: r.quick,
      page: r.page,
      succeeded: r.succeeded,
      failed: r.failed,
      last_audit_at: r.last ? new Date(r.last).toISOString() : null,
    })),
  };
}
