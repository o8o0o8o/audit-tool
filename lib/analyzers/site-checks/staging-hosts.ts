/**
 * Staging / development hosts found in certificate transparency logs (crt.sh)
 * that are open to the public and to search engines. A host is protected when
 * it answers 401/403, redirects to a login/SSO page or shows a password form.
 * crt.sh is slow and often fails; any failure marks the check 'skipped'.
 * At most 20 hosts, 3 at a time, each with one page GET (+ robots.txt).
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { defaultHttpFetcher, plural, runPool, type HttpProbeFetcher } from './http-probe';
import type { SiteProbeResult } from './site-checks-types';

const MAX_HOSTS = 20;
const CONCURRENCY = 3;

export const STAGING_LABEL =
  /(^|[.-])(staging|stage|stg|dev|develop|test|qa|uat|preview|beta|sandbox|demo)([.-]|\d|$)/i;

/** Staging-looking hostnames under `domain` from a crt.sh JSON body (wildcards skipped), capped at 20. */
export function stagingHostsFromCt(body: string, domain: string, limit = MAX_HOSTS): string[] {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const d = domain.toLowerCase();
  const out = new Set<string>();
  for (const row of rows) {
    const nv = (row as { name_value?: unknown })?.name_value;
    if (typeof nv !== 'string') continue;
    for (const raw of nv.split(/\s+/)) {
      const h = raw.toLowerCase().replace(/\.$/, '');
      if (!h || h.includes('*') || !h.endsWith(`.${d}`) || !/^[a-z0-9.-]+$/.test(h)) continue;
      if (STAGING_LABEL.test(h.slice(0, -(d.length + 1)))) out.add(h);
    }
  }
  return [...out].sort().slice(0, limit);
}

const LOGIN_URL =
  /login|signin|sign-in|sso|oauth|auth|okta|onelogin|microsoftonline|accounts\.google|cloudflareaccess/i;
const PASSWORD_FIELD = /<input[^>]+type\s*=\s*["']?password/i;

/** True when meta robots / googlebot or X-Robots-Tag carries noindex or none. */
export function isNoindex(headers: Record<string, string>, html: string): boolean {
  if (/\b(?:noindex|none)\b/i.test(headers['x-robots-tag'] ?? '')) return true;
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (
      /name\s*=\s*["']?(?:robots|googlebot)\b/i.test(tag) &&
      /content\s*=\s*["'][^"']*\b(?:noindex|none)\b/i.test(tag)
    ) {
      return true;
    }
  }
  return false;
}

/** True when robots.txt has `Disallow: /` in the group for `User-agent: *`. */
export function robotsDisallowsAll(robots: string): boolean {
  let inStar = false;
  let lastWasAgent = false;
  for (const line of robots.split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) inStar = false;
      if (val === '*') inStar = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (inStar && key === 'disallow' && val === '/') return true;
  }
  return false;
}

export type StagingVerdict = 'indexable' | 'reachable' | null;

export class StagingHostsAnalyzer {
  static async analyze(domain: string, fetcher: HttpProbeFetcher = defaultHttpFetcher): Promise<SiteProbeResult> {
    const skipped = (note: string): SiteProbeResult => ({
      issues: [],
      checks: [{ id: 'staging-hosts', label: 'Staging hosts', status: 'skipped', note }],
    });
    const ct = await fetcher(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, {
      timeoutMs: 20000,
      maxBytes: 8 * 1024 * 1024,
    });
    if (ct?.status !== 200) return skipped('certificate transparency lookup (crt.sh) failed');
    const hosts = stagingHostsFromCt(ct.body, domain);
    if (!hosts.length) {
      return {
        issues: [],
        checks: [{ id: 'staging-hosts', label: 'Staging hosts', status: 'pass', note: 'no staging hosts in CT logs' }],
      };
    }

    const indexable: string[] = [];
    const reachable: string[] = [];
    await runPool(hosts, CONCURRENCY, async (host) => {
      const res = await fetcher(`https://${host}/`, { maxBytes: 256 * 1024 });
      if (res?.status !== 200) return; // unreachable, 401/403 protected, or error page
      if (!/html/i.test(res.headers['content-type'] ?? 'text/html')) return;
      let finalHost = host;
      let finalUrl: URL | null = null;
      try {
        finalUrl = new URL(res.url);
        finalHost = finalUrl.hostname.toLowerCase();
      } catch {
        /* keep host */
      }
      if (finalUrl && finalHost !== host) {
        if (LOGIN_URL.test(finalHost) || LOGIN_URL.test(finalUrl.pathname)) return; // SSO gate
        if (!STAGING_LABEL.test(finalHost.slice(0, -(domain.length + 1)))) return; // redirects to production
      } else if (finalUrl && LOGIN_URL.test(finalUrl.pathname)) return;
      if (PASSWORD_FIELD.test(res.body)) return; // login form
      if (isNoindex(res.headers, res.body)) {
        reachable.push(host);
        return;
      }
      const robots = await fetcher(`https://${finalHost}/robots.txt`, { maxBytes: 64 * 1024 });
      if (robots?.status === 200 && robotsDisallowsAll(robots.body)) reachable.push(host);
      else indexable.push(host);
    });

    const issues: Issue[] = [];
    const list = (h: string[]) => h.sort().map(escapeHtml).join(', ');
    if (indexable.length) {
      issues.push({
        message: 'Staging or development host is publicly indexable',
        detail: `These non-production hosts (found in certificate transparency logs) serve pages to anyone, without noindex or a robots.txt block: ${list(indexable)}. Search engines can index them as duplicate content and they often expose unfinished features or test data. Put them behind authentication (or at least send X-Robots-Tag: noindex).`,
        severity: SEVERITY.MEDIUM,
      });
    }
    if (reachable.length) {
      issues.push({
        message: 'Staging or development host is publicly reachable',
        detail: `These non-production hosts are blocked from indexing but open to anyone: ${list(reachable)}. Consider putting them behind authentication.`,
        severity: SEVERITY.LOW,
      });
    }
    return {
      issues,
      checks: [
        {
          id: 'staging-hosts',
          label: 'Staging hosts',
          status: indexable.length ? 'fail' : reachable.length ? 'warn' : 'pass',
          note: `${plural(hosts.length, 'host')} from CT logs checked${indexable.length + reachable.length ? `, ${indexable.length + reachable.length} public` : ''}`,
        },
      ],
    };
  }
}
