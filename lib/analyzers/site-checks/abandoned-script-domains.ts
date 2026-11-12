/**
 * Third-party script/iframe domains that no longer exist. If the registrable
 * domain behind a script tag returns NXDOMAIN, anyone can register it and
 * serve JavaScript that runs on every page that still loads it. One NS lookup
 * per registrable domain, at most 40.
 */

import { promises as dnsPromises } from 'node:dns';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { plural } from './http-probe';
import { orgDomain, type SiteProbeResult } from './site-checks-types';

const MAX_DOMAINS = 40;

export interface DomainLookup {
  /** Rejects with code ENOTFOUND when the name does not exist. */
  resolveNs(name: string): Promise<unknown>;
}

function defaultLookup(): DomainLookup {
  const resolver = new dnsPromises.Resolver({ timeout: 5000, tries: 2 });
  return { resolveNs: (n) => resolver.resolveNs(n) };
}

/** Third-party hosts grouped by registrable domain (site's own domain excluded), capped at 40 domains. */
export function groupThirdPartyHosts(
  origin: string,
  hosts: Iterable<string>,
  limit = MAX_DOMAINS,
): Map<string, string[]> {
  let own = '';
  try {
    own = orgDomain(new URL(origin).hostname);
  } catch {
    /* no origin: keep all */
  }
  const out = new Map<string, string[]>();
  for (const raw of hosts) {
    const h = raw.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!h || !h.includes('.') || /^[\d.]+$|:/.test(h) || h === 'localhost') continue;
    const org = orgDomain(h);
    if (org === own) continue;
    const list = out.get(org);
    if (list) {
      if (!list.includes(h)) list.push(h);
    } else if (out.size < limit) out.set(org, [h]);
  }
  return out;
}

export class AbandonedScriptDomains {
  static async analyze(
    origin: string,
    hosts: Iterable<string>,
    lookup: DomainLookup = defaultLookup(),
  ): Promise<SiteProbeResult> {
    const groups = groupThirdPartyHosts(origin, hosts);
    const dead: string[] = [];
    let answered = 0;
    for (const [org, list] of groups) {
      try {
        await lookup.resolveNs(org);
        answered++;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === 'ENOTFOUND' || code === 'NXDOMAIN') {
          answered++;
          dead.push(`${org} (${list.join(', ')})`);
        }
      }
    }
    const issues: Issue[] = [];
    if (dead.length) {
      issues.push({
        message: 'Script loaded from a domain that no longer resolves',
        detail: `The site loads scripts or iframes from ${dead.length > 1 ? 'domains that do' : 'a domain that does'} not exist (NXDOMAIN): ${dead.map(escapeHtml).join('; ')}. Anyone can register ${dead.length > 1 ? 'them' : 'it'} and serve JavaScript that runs on your pages. Remove these tags (or self-host the code).`,
        severity: SEVERITY.HIGH,
      });
    }
    return {
      issues,
      checks: [
        {
          id: 'abandoned-script-domains',
          label: 'Third-party script domains',
          status: dead.length ? 'fail' : !groups.size || !answered ? 'skipped' : 'pass',
          note: !groups.size
            ? 'no third-party scripts'
            : !answered
              ? 'DNS lookups failed'
              : dead.length
                ? `${plural(dead.length, 'domain')} unregistered`
                : `${plural(groups.size, 'domain')} checked`,
        },
      ],
    };
  }
}
