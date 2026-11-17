/**
 * DNS over HTTPS, as the truth gate's second method for email records. The scan asked the system
 * resolver; the gate asks two public resolvers over HTTPS (Cloudflare and Google), which answer from
 * their own caches, and both must agree. Implements the scan's `DnsLookup`, so the record parsing
 * is shared but the evidence is not.
 */

import type { DnsLookup } from '../analyzers/site-checks/email-dns-analyzer';

export interface DohResolver extends DnsLookup {
  name: string;
}

const PROVIDERS: Record<string, string> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};

/** The error `isAbsentError` reads as "no such record". */
const absent = () => Object.assign(new Error('no record'), { code: 'ENODATA' });

/** A TXT answer as the resolver sends it: one or more quoted strings, joined into one record. */
export function txtChunks(data: string): string[] {
  const quoted = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!quoted) return [data];
  return quoted.map((q) => q.slice(1, -1).replace(/\\(.)/g, '$1'));
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function dohResolver(name: keyof typeof PROVIDERS | string, fetchImpl: Fetch = fetch): DohResolver {
  const base = PROVIDERS[name];
  if (!base) throw new Error(`unknown DNS-over-HTTPS provider: ${name}`);
  const query = async (host: string, type: 'TXT' | 'MX' | 'CAA'): Promise<string[]> => {
    const res = await fetchImpl(`${base}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}`);
    const body = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
    // 3 = NXDOMAIN; 0 with no answer of the type = no record. Anything else (SERVFAIL…) is unknown.
    if (body.Status === 3) throw absent();
    if (body.Status !== 0) throw new Error(`${name} answered DNS status ${body.Status}`);
    const code = { TXT: 16, MX: 15, CAA: 257 }[type];
    const answers = (body.Answer ?? []).filter((a) => a.type === code).map((a) => a.data);
    if (!answers.length) throw absent();
    return answers;
  };
  return {
    name,
    resolveTxt: async (host) => (await query(host, 'TXT')).map(txtChunks),
    resolveMx: async (host) =>
      (await query(host, 'MX')).map((d) => {
        const [priority, exchange] = d.split(/\s+/);
        return { priority: Number(priority), exchange: exchange ?? '' };
      }),
    resolveCaa: async (host) => query(host, 'CAA'),
  };
}

export const defaultDohResolvers = (): DohResolver[] => [dohResolver('cloudflare'), dohResolver('google')];
