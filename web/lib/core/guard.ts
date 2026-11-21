import { and, arrayOverlaps, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { prospects, siteAliases, sites, suppressedDomains } from '../../db/schema';
import { registrableDomainOf } from './sites';

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'do_not_contact' | 'suppressed'; registrableDomain: string };

/**
 * The scan guard (§4): a domain may be scanned unless its registrable domain, or that of any known
 * alias of its site, is a `do_not_contact` prospect or a suppressed domain. No override exists.
 */
export async function checkGuard(db: Db, hostOrDomain: string): Promise<GuardResult> {
  const host = hostOrDomain.toLowerCase().replace(/\.$/, '');
  const domains = new Set([registrableDomainOf(host)]);
  // Every alias of the site this host belongs to, and the site's own host.
  const siteIds = await db
    .select({ id: sites.id })
    .from(sites)
    .where(eq(sites.host, host))
    .union(db.select({ id: siteAliases.siteId }).from(siteAliases).where(eq(siteAliases.host, host)));
  if (siteIds.length) {
    const ids = siteIds.map((r) => r.id);
    const hosts = await db
      .select({ host: sites.host })
      .from(sites)
      .where(inArray(sites.id, ids))
      .union(db.select({ host: siteAliases.host }).from(siteAliases).where(inArray(siteAliases.siteId, ids)));
    for (const h of hosts) domains.add(registrableDomainOf(h.host));
  }
  const list = [...domains];
  const [suppressed] = await db
    .select()
    .from(suppressedDomains)
    .where(inArray(suppressedDomains.registrableDomain, list))
    .limit(1);
  if (suppressed) return { allowed: false, reason: 'suppressed', registrableDomain: suppressed.registrableDomain };
  const [dnc] = await db
    .select({ domains: prospects.registrableDomains })
    .from(prospects)
    .where(and(eq(prospects.doNotContact, true), arrayOverlaps(prospects.registrableDomains, list)))
    .limit(1);
  if (dnc)
    return {
      allowed: false,
      reason: 'do_not_contact',
      registrableDomain: dnc.domains.find((d) => domains.has(d)) ?? list[0]!,
    };
  return { allowed: true };
}

/** Is any prospect row (not only do_not_contact) on this domain? Full audits of prospects run passive. */
export async function isProspectDomain(db: Db, host: string): Promise<boolean> {
  const [row] = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(arrayOverlaps(prospects.registrableDomains, [registrableDomainOf(host)]))
    .limit(1);
  return !!row;
}
