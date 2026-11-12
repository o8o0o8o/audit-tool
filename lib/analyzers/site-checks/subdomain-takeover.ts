/**
 * Dangling-CNAME check for the audited host and the same-site subdomains the
 * crawl linked to. A host whose CNAME points at a hosting service where the
 * target no longer exists (NXDOMAIN, or the service's "no such site" page) can
 * be claimed by anyone: a subdomain takeover. One DNS lookup per host, plus one
 * HTTPS request only for hosts whose CNAME points at a known service.
 */

import { promises as dnsPromises } from 'node:dns';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { isAbsentError } from './email-dns-analyzer';
import { orgDomain, type SiteProbeResult } from './site-checks-types';

const MAX_HOSTS = 30;

/** Services where a dangling CNAME can be claimed, with their "unclaimed" page text (can-i-take-over-xyz). */
export const TAKEOVER_SERVICES: Array<{ name: string; cname: RegExp; fingerprint?: RegExp }> = [
  { name: 'GitHub Pages', cname: /\.github\.io$/, fingerprint: /There isn't a GitHub Pages site here/i },
  { name: 'Heroku', cname: /\.(?:herokuapp|herokudns|herokussl)\.com$/, fingerprint: /no-such-app\.html|No such app/i },
  { name: 'AWS S3', cname: /\.s3[.-](?:[a-z0-9-]+\.)?amazonaws\.com$|\.s3-website[.-]/, fingerprint: /NoSuchBucket/ },
  {
    name: 'Azure',
    cname:
      /\.(?:azurewebsites\.net|cloudapp\.net|cloudapp\.azure\.com|trafficmanager\.net|blob\.core\.windows\.net|azureedge\.net)$/,
  },
  { name: 'Surge', cname: /\.surge\.sh$/, fingerprint: /project not found/i },
  { name: 'Shopify', cname: /\.myshopify\.com$/, fingerprint: /Sorry, this shop is currently unavailable/i },
  {
    name: 'Pantheon',
    cname: /\.pantheonsite\.io$/,
    fingerprint: /The gods are wise, but do not know of the site which you seek/i,
  },
  { name: 'Zendesk', cname: /\.zendesk\.com$/, fingerprint: /Help Center Closed/i },
  { name: 'Bitbucket', cname: /\.bitbucket\.io$/, fingerprint: /Repository not found/i },
  { name: 'ReadMe', cname: /\.readme\.io$/, fingerprint: /Project doesnt exist\.\.\. yet!/i },
  { name: 'Ghost', cname: /\.ghost\.io$/, fingerprint: /Failed to resolve DNS path for this host/i },
  {
    name: 'Webflow',
    cname: /proxy-ssl\.webflow\.com$/,
    fingerprint: /The page you are looking for doesn't exist or has been moved/i,
  },
];

export interface TakeoverLookup {
  resolveCname(host: string): Promise<string[]>;
  /** Resolves A/AAAA; rejects with ENOTFOUND when the name does not exist. */
  resolveAddress(host: string): Promise<unknown>;
  fetchBody(url: string): Promise<string | null>;
}

function defaultLookup(): TakeoverLookup {
  const resolver = new dnsPromises.Resolver({ timeout: 5000, tries: 2 });
  return {
    resolveCname: (h) => resolver.resolveCname(h),
    resolveAddress: async (h) => {
      try {
        return await resolver.resolve4(h);
      } catch (e) {
        if (isAbsentError(e)) return await resolver.resolve6(h);
        throw e;
      }
    },
    fetchBody: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
        return (await res.text()).slice(0, 20000);
      } catch {
        return null;
      }
    },
  };
}

/** Same-site hostnames from the origin and from crawled link domains, origin first. */
export function collectSiteHosts(origin: string, linkHosts: Iterable<string>): string[] {
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return [];
  }
  const org = orgDomain(originHost);
  const hosts = new Set<string>([originHost]);
  for (const raw of linkHosts) {
    const h = raw.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (h === org || h.endsWith(`.${org}`)) hosts.add(h);
    if (hosts.size >= MAX_HOSTS) break;
  }
  return [...hosts];
}

export class SubdomainTakeoverAnalyzer {
  static async analyze(hosts: string[], lookup: TakeoverLookup = defaultLookup()): Promise<SiteProbeResult> {
    const issues: Issue[] = [];
    let checked = 0;
    for (const host of hosts.slice(0, MAX_HOSTS)) {
      let cnames: string[];
      try {
        cnames = await lookup.resolveCname(host);
      } catch {
        continue; // no CNAME (or lookup failed): nothing to take over
      }
      checked++;
      for (const target of cnames.map((c) => c.toLowerCase().replace(/\.$/, ''))) {
        const service = TAKEOVER_SERVICES.find((s) => s.cname.test(target));
        if (!service) continue;
        let reason: string | null = null;
        try {
          await lookup.resolveAddress(target);
        } catch (e) {
          if (isAbsentError(e)) reason = `${target} does not resolve (NXDOMAIN)`;
        }
        if (!reason && service.fingerprint) {
          const body = await lookup.fetchBody(`https://${host}/`);
          if (body && service.fingerprint.test(body)) reason = `${service.name} shows its "unclaimed site" page`;
        }
        if (reason) {
          issues.push({
            message: 'Dangling CNAME: possible subdomain takeover',
            detail: `${host} is a CNAME to ${target} (${service.name}), but ${reason}. Anyone can claim that ${service.name} resource and serve content on ${host}. Remove the DNS record or reclaim the resource.`,
            severity: SEVERITY.HIGH,
          });
        }
      }
    }
    return {
      issues,
      checks: [
        {
          id: 'subdomain-takeover',
          label: 'Subdomain takeover',
          status: issues.length ? 'fail' : 'pass',
          note: issues.length
            ? `${issues.length} dangling CNAME${issues.length > 1 ? 's' : ''}`
            : `${hosts.length} host${hosts.length === 1 ? '' : 's'} checked, ${checked} with a CNAME`,
        },
      ],
    };
  }
}
