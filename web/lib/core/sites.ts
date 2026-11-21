import { asc, eq, sql } from 'drizzle-orm';
import { parse } from 'tldts';
import type { Db } from '../../db/client';
import { siteAliases, sites } from '../../db/schema';
import { CoreError } from './errors';

export interface NormalizedTarget {
  /** The URL to audit: origin for site modes, the page URL (no fragment) for `page`. */
  url: string;
  /** Lower-case host, punycode for IDN, no port. */
  host: string;
  /** eTLD+1 from the Public Suffix List, private section included (acme.github.io is its own). */
  registrableDomain: string;
}

/** Parses what a person typed (with or without scheme) into a host and its registrable domain. */
export function normalizeTarget(raw: string, keepPath = false): NormalizedTarget {
  const text = raw.trim();
  if (!text) throw new CoreError('invalid_input', 'url is required');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text.replace(/^\/\//, '')}`);
  } catch {
    throw new CoreError('invalid_input', 'url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new CoreError('invalid_input', 'url must use http or https');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const registrableDomain = registrableDomainOf(host);
  u.hash = '';
  return { url: keepPath ? u.toString() : u.origin, host, registrableDomain };
}

export function registrableDomainOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  const info = parse(h, { allowPrivateDomains: true });
  if (info.isIp || h === 'localhost' || !info.domain) return h; // IPs, localhost, unknown suffixes: the host itself
  return info.domain;
}

/** Host as stored: lower-case, punycode, no trailing dot. Accepts a bare domain or a URL. */
export function normalizeHost(domainOrUrl: string): string {
  return normalizeTarget(domainOrUrl).host;
}

/** Finds the site for a host through its aliases, else by host; creates it when missing. */
export async function findOrCreateSite(
  db: Db,
  host: string,
): Promise<{ id: string; host: string; registrableDomain: string }> {
  const found = await findSiteByHost(db, host);
  if (found) return found;
  await db
    .insert(sites)
    .values({ host, registrableDomain: registrableDomainOf(host) })
    .onConflictDoNothing({ target: sites.host });
  const [row] = await db.select().from(sites).where(eq(sites.host, host));
  return { id: row!.id, host: row!.host, registrableDomain: row!.registrableDomain };
}

export async function findSiteByHost(db: Db, host: string) {
  const [alias] = await db
    .select({ id: sites.id, host: sites.host, registrableDomain: sites.registrableDomain })
    .from(siteAliases)
    .innerJoin(sites, eq(sites.id, siteAliases.siteId))
    .where(eq(siteAliases.host, host));
  if (alias) return alias;
  const [row] = await db
    .select({ id: sites.id, host: sites.host, registrableDomain: sites.registrableDomain })
    .from(sites)
    .where(eq(sites.host, host));
  return row ?? null;
}

/**
 * Resolves what an API caller calls a "domain" (§5): the host through aliases, then the host
 * itself, then any site with that registrable domain (the apex first, then the oldest).
 */
export async function resolveSites(db: Db, domain: string) {
  const host = normalizeHost(domain);
  const direct = await findSiteByHost(db, host);
  if (direct) return [direct];
  const reg = registrableDomainOf(host);
  return db
    .select({ id: sites.id, host: sites.host, registrableDomain: sites.registrableDomain })
    .from(sites)
    .where(eq(sites.registrableDomain, reg))
    .orderBy(sql`(${sites.host} = ${reg}) desc`, sql`(${sites.host} = ${'www.' + reg}) desc`, asc(sites.firstSeenAt));
}

export async function addAlias(
  db: Db,
  host: string,
  siteId: string,
  reason: 'redirect' | 'www' | 'manual',
): Promise<void> {
  await db
    .insert(siteAliases)
    .values({ host, siteId, reason })
    .onConflictDoUpdate({ target: siteAliases.host, set: { siteId, reason } });
}

export async function listAliases(db: Db, siteId: string): Promise<string[]> {
  const rows = await db.select({ host: siteAliases.host }).from(siteAliases).where(eq(siteAliases.siteId, siteId));
  return rows.map((r) => r.host);
}
