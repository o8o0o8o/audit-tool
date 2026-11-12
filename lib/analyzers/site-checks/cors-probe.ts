/**
 * Checks whether the site's endpoints reflect an arbitrary Origin (and the
 * `null` origin) in Access-Control-Allow-Origin. With credentials allowed, any
 * website a logged-in user visits can read their responses. Two GETs per URL,
 * the origin plus at most 5 API URLs.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { defaultHttpFetcher, plural, runPool, type HttpProbeFetcher } from './http-probe';
import { orgDomain, type SiteProbeResult } from './site-checks-types';

export const CORS_TEST_ORIGIN = 'https://cors-check.invalid';
const TEST_ORIGINS = [CORS_TEST_ORIGIN, 'null'];
const MAX_API_URLS = 5;
const CONCURRENCY = 2;

export type CorsVerdict = 'credentials' | 'reflect' | null;

/** Pure verdict for one response to a request sent with `Origin: sent`. */
export function corsVerdict(headers: Record<string, string>, sent: string): CorsVerdict {
  const acao = (headers['access-control-allow-origin'] ?? '').trim();
  if (!acao || acao === '*' || acao.toLowerCase() !== sent.toLowerCase()) return null;
  return (headers['access-control-allow-credentials'] ?? '').trim().toLowerCase() === 'true'
    ? 'credentials'
    : 'reflect';
}

export interface RequestEntry {
  url: string;
  resourceType?: string;
  method?: string;
}

/** Same-site fetch/xhr GET URLs, deduped by host+path, capped at 5. */
export function selectApiUrls(origin: string, requests: Iterable<RequestEntry>, limit = MAX_API_URLS): string[] {
  let org: string;
  try {
    org = orgDomain(new URL(origin).hostname);
  } catch {
    return [];
  }
  const out = new Map<string, string>();
  for (const r of requests) {
    if (out.size >= limit) break;
    if (r.resourceType && r.resourceType !== 'fetch' && r.resourceType !== 'xhr') continue;
    if (r.method && r.method.toUpperCase() !== 'GET') continue;
    try {
      const u = new URL(r.url);
      const h = u.hostname.toLowerCase();
      if (!/^https?:$/.test(u.protocol) || (h !== org && !h.endsWith(`.${org}`))) continue;
      const key = `${u.host}${u.pathname}`;
      if (!out.has(key)) out.set(key, u.href);
    } catch {
      /* skip */
    }
  }
  return [...out.values()];
}

export class CorsProbe {
  static async probe(
    origin: string,
    apiUrls: string[] = [],
    fetcher: HttpProbeFetcher = defaultHttpFetcher,
  ): Promise<SiteProbeResult> {
    const urls = [...new Set([origin, ...apiUrls.slice(0, MAX_API_URLS)])];
    const withCreds = new Map<string, string>();
    const reflect = new Map<string, string>();
    let answered = 0;
    const jobs = urls.flatMap((url) => TEST_ORIGINS.map((sent) => ({ url, sent })));
    await runPool(jobs, CONCURRENCY, async ({ url, sent }) => {
      const res = await fetcher(url, { headers: { Origin: sent }, redirect: 'manual', maxBytes: 0 });
      if (!res) return;
      answered++;
      const v = corsVerdict(res.headers, sent);
      const label = `${url} (Origin: ${sent})`;
      if (v === 'credentials') withCreds.set(url, label);
      else if (v === 'reflect' && !withCreds.has(url)) reflect.set(url, label);
    });
    for (const u of withCreds.keys()) reflect.delete(u);

    const issues: Issue[] = [];
    const fmt = (m: Map<string, string>) => [...m.values()].map(escapeHtml).join(', ');
    if (withCreds.size) {
      issues.push({
        message: 'CORS reflects arbitrary origins with credentials',
        detail: `These endpoints echo any Origin in Access-Control-Allow-Origin and send Access-Control-Allow-Credentials: true: ${fmt(withCreds)}. Any website a logged-in visitor opens can read these responses with the visitor's cookies. Allow only a fixed list of trusted origins.`,
        severity: SEVERITY.HIGH,
      });
    }
    if (reflect.size) {
      issues.push({
        message: 'CORS reflects arbitrary origins',
        detail: `These endpoints echo any Origin in Access-Control-Allow-Origin (without credentials): ${fmt(reflect)}. Low risk for public data, but use a fixed allow-list or "*" so it cannot turn into a credentialed leak later.`,
        severity: SEVERITY.LOW,
      });
    }
    return {
      issues,
      checks: [
        {
          id: 'cors',
          label: 'CORS policy',
          status: withCreds.size ? 'fail' : reflect.size ? 'warn' : answered ? 'pass' : 'skipped',
          note: answered ? `${plural(urls.length, 'URL')} checked` : 'no response',
        },
      ],
    };
  }
}
