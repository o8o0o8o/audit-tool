/**
 * Email authentication and DNS hygiene for the audited domain: SPF, DMARC,
 * DKIM (common selectors only), MTA-STS, TLS-RPT and CAA. DNS only, plus one
 * HTTPS fetch of the MTA-STS policy. A DNS timeout or SERVFAIL gives no finding.
 */

import { promises as dnsPromises } from 'node:dns';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { orgDomain, type SiteCheckResult, type SiteProbeResult } from './site-checks-types';

export interface DnsLookup {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCaa(name: string): Promise<unknown[]>;
}

/** Thrown-error codes that mean "no such record" rather than "lookup failed". */
const ABSENT_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export function isAbsentError(e: unknown): boolean {
  return ABSENT_CODES.has((e as { code?: string })?.code ?? '');
}

export function defaultDnsLookup(timeoutMs = 5000): DnsLookup {
  const resolver = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 2 });
  return {
    resolveTxt: (n) => resolver.resolveTxt(n),
    resolveMx: (n) => resolver.resolveMx(n),
    resolveCaa: (n) => resolver.resolveCaa(n),
  };
}

/** TXT records joined per record; `null` = lookup failed (unknown), `[]` = none. */
async function txt(dns: DnsLookup, name: string): Promise<string[] | null> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (e) {
    return isAbsentError(e) ? [] : null;
  }
}

// ─── SPF ────────────────────────────────────────────────────────────────────

const SPF_LOOKUP_MECHANISMS = /^[+?~-]?(include|a|mx|ptr|exists)(?=[:/]|$)/i;

export interface SpfEvaluation {
  issues: Issue[];
  lookups: number;
}

/** Recursively counts DNS-querying terms (RFC 7208 §4.6.4 limit is 10). */
export async function countSpfLookups(
  dns: DnsLookup,
  record: string,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<number> {
  if (depth > 10) return 0;
  let count = 0;
  for (const term of record.trim().split(/\s+/).slice(1)) {
    const m = SPF_LOOKUP_MECHANISMS.exec(term);
    const redirect = /^redirect=(.+)$/i.exec(term);
    if (!m && !redirect) continue;
    count++;
    const target = redirect ? redirect[1] : m![1].toLowerCase() === 'include' ? term.split(':')[1] : null;
    if (!target || seen.has(target) || target.includes('%{')) continue;
    seen.add(target);
    const records = await txt(dns, target);
    const spf = records?.find((r) => /^v=spf1(\s|$)/i.test(r));
    if (spf) count += await countSpfLookups(dns, spf, depth + 1, seen);
  }
  return count;
}

export async function evaluateSpf(dns: DnsLookup, domain: string, records: string[]): Promise<SpfEvaluation> {
  const issues: Issue[] = [];
  const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) {
    issues.push({
      message: 'No SPF record',
      detail: `${domain} publishes no SPF (v=spf1) TXT record, so anyone can send mail that claims to be from it. Domains that send no mail should publish "v=spf1 -all".`,
      severity: SEVERITY.MEDIUM,
    });
    return { issues, lookups: 0 };
  }
  if (spf.length > 1) {
    issues.push({
      message: 'Multiple SPF records',
      detail: `${domain} publishes ${spf.length} SPF records. RFC 7208 allows one; receivers treat this as a permanent error and SPF fails for every message.`,
      severity: SEVERITY.HIGH,
    });
  }
  const record = spf[0].trim();
  const all = /(?:^|\s)([+?~-]?)all(?:\s|$)/i.exec(record);
  if (all && (all[1] === '+' || all[1] === '')) {
    issues.push({
      message: 'SPF record allows any sender (+all)',
      detail: `SPF for ${domain} ends in "${all[0].trim()}", which authorises every server on the internet: "${record}".`,
      severity: SEVERITY.HIGH,
    });
  } else if (all && all[1] === '?') {
    issues.push({
      message: 'SPF record is neutral (?all)',
      detail: `SPF for ${domain} ends in "?all", which gives receivers no instruction for unauthorised senders. Use "~all" or "-all": "${record}".`,
      severity: SEVERITY.MEDIUM,
    });
  }
  if (/(?:^|\s)[+?~-]?ptr(?=[:\s]|$)/i.test(record)) {
    issues.push({
      message: 'SPF record uses the deprecated ptr mechanism',
      detail: `RFC 7208 says "ptr" should not be used; it is slow and some receivers ignore it: "${record}".`,
      severity: SEVERITY.LOW,
    });
  }
  const lookups = await countSpfLookups(dns, record);
  if (lookups > 10) {
    issues.push({
      message: 'SPF record exceeds 10 DNS lookups',
      detail: `SPF for ${domain} needs ${lookups} DNS lookups (include/a/mx/ptr/exists/redirect, counted recursively). Over 10 is a permanent error, so SPF fails.`,
      severity: SEVERITY.HIGH,
    });
  }
  return { issues, lookups };
}

// ─── DMARC ──────────────────────────────────────────────────────────────────

export function parseTagList(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(part);
    if (m) tags[m[1].toLowerCase()] = m[2];
  }
  return tags;
}

export function evaluateDmarc(domain: string, records: string[]): { issues: Issue[]; policy?: string } {
  const issues: Issue[] = [];
  const dmarc = records.filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  if (dmarc.length === 0) {
    issues.push({
      message: 'No DMARC record',
      detail: `No _dmarc.${domain} TXT record. Without DMARC, receivers have no policy for mail that fails SPF/DKIM, and the domain is easy to spoof. Start with "v=DMARC1; p=none; rua=mailto:…" and move to quarantine/reject.`,
      severity: SEVERITY.MEDIUM,
    });
    return { issues };
  }
  if (dmarc.length > 1) {
    issues.push({
      message: 'Multiple DMARC records',
      detail: `_dmarc.${domain} has ${dmarc.length} DMARC records; RFC 7489 says receivers must then ignore DMARC entirely.`,
      severity: SEVERITY.HIGH,
    });
  }
  const tags = parseTagList(dmarc[0]);
  const policy = tags.p?.toLowerCase();
  if (!policy || !['none', 'quarantine', 'reject'].includes(policy)) {
    issues.push({
      message: 'DMARC record has no valid policy',
      detail: `The DMARC record "${dmarc[0]}" has no valid p= tag (none, quarantine or reject), so receivers ignore it.`,
      severity: SEVERITY.MEDIUM,
    });
    return { issues };
  }
  if (policy === 'none') {
    issues.push({
      message: 'DMARC policy is p=none (monitoring only)',
      detail: `DMARC for ${domain} only monitors; spoofed mail is still delivered. Move to p=quarantine or p=reject once reports look clean.`,
      severity: SEVERITY.LOW,
    });
  }
  if (!tags.rua) {
    issues.push({
      message: 'DMARC record has no aggregate report address (rua)',
      detail: `Without rua=mailto:…, ${domain} gets no reports on who sends mail as it, so a stricter policy can't be rolled out safely.`,
      severity: SEVERITY.LOW,
    });
  }
  return { issues, policy };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export const DKIM_SELECTORS = [
  'google',
  'selector1',
  'selector2',
  'default',
  'k1',
  'k2',
  's1',
  's2',
  'dkim',
  'mail',
  'smtp',
  'mandrill',
  'mxvault',
  'zoho',
  'everlytickey1',
  'protonmail',
  'fm1',
] as const;

type PolicyFetcher = (url: string) => Promise<{ ok: boolean; body: string } | null>;

const defaultPolicyFetcher: PolicyFetcher = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return { ok: res.ok, body: res.ok ? (await res.text()).slice(0, 10000) : '' };
  } catch {
    return null;
  }
};

export class EmailDnsAnalyzer {
  static async analyze(
    domain: string,
    dns: DnsLookup = defaultDnsLookup(),
    fetchPolicy: PolicyFetcher = defaultPolicyFetcher,
  ): Promise<SiteProbeResult> {
    const issues: Issue[] = [];
    const checks: SiteCheckResult[] = [];
    if (!domain) return { issues, checks };
    const add = (id: string, label: string, found: Issue[], note?: string, unknown = false) => {
      issues.push(...found);
      const worst = found.some((i) => i.severity !== SEVERITY.LOW) ? 'fail' : found.length ? 'warn' : 'pass';
      checks.push({ id, label, status: unknown ? 'skipped' : worst, note });
    };

    let hasMx: boolean | null;
    try {
      hasMx = (await dns.resolveMx(domain)).length > 0;
    } catch (e) {
      hasMx = isAbsentError(e) ? false : null;
    }

    // SPF
    const rootTxt = await txt(dns, domain);
    if (rootTxt === null) add('spf', 'SPF', [], 'DNS lookup failed', true);
    else {
      const spf = await evaluateSpf(dns, domain, rootTxt);
      const record = rootTxt.find((r) => /^v=spf1/i.test(r));
      add('spf', 'SPF', spf.issues, record ? `${record.slice(0, 120)} (${spf.lookups} lookups)` : 'no record');
    }

    // DMARC (falls back to the organisational domain, RFC 7489 §6.6.3)
    let dmarcTxt = await txt(dns, `_dmarc.${domain}`);
    const org = orgDomain(domain);
    if (dmarcTxt && !dmarcTxt.some((r) => /^v=DMARC1/i.test(r)) && org !== domain) {
      dmarcTxt = await txt(dns, `_dmarc.${org}`);
    }
    if (dmarcTxt === null) add('dmarc', 'DMARC', [], 'DNS lookup failed', true);
    else {
      const dmarc = evaluateDmarc(domain, dmarcTxt);
      add('dmarc', 'DMARC', dmarc.issues, dmarc.policy ? `p=${dmarc.policy}` : 'no valid record');
    }

    // Mail-receiving checks only make sense when the domain has MX records.
    if (hasMx === true) {
      const found: string[] = [];
      await Promise.all(
        DKIM_SELECTORS.map(async (s) => {
          const r = await txt(dns, `${s}._domainkey.${domain}`);
          if (r?.some((v) => /(?:^|;)\s*(?:v=DKIM1|k=|p=)/i.test(v))) found.push(s);
        }),
      );
      add(
        'dkim',
        'DKIM',
        found.length
          ? []
          : [
              {
                message: 'No DKIM key found at common selectors',
                detail: `None of ${DKIM_SELECTORS.length} common selectors (${DKIM_SELECTORS.slice(0, 6).join(', ')}, …) has a DKIM key under ${domain}. If your mail provider uses a custom selector this can be ignored; otherwise enable DKIM signing.`,
                severity: SEVERITY.LOW,
              },
            ],
        found.length
          ? `selector${found.length > 1 ? 's' : ''}: ${found.sort().join(', ')}`
          : 'not found at common selectors',
      );

      const stsTxt = await txt(dns, `_mta-sts.${domain}`);
      if (stsTxt === null) add('mta-sts', 'MTA-STS', [], 'DNS lookup failed', true);
      else if (!stsTxt.some((r) => /^v=STSv1/i.test(r))) {
        add(
          'mta-sts',
          'MTA-STS',
          [
            {
              message: 'No MTA-STS policy',
              detail: `${domain} receives mail but publishes no _mta-sts TXT record, so inbound SMTP can be downgraded to plaintext (RFC 8461).`,
              severity: SEVERITY.LOW,
            },
          ],
          'not configured',
        );
      } else {
        const policy = await fetchPolicy(`https://mta-sts.${domain}/.well-known/mta-sts.txt`);
        const mode = policy?.ok ? /^mode:\s*(enforce|testing|none)\s*$/im.exec(policy.body)?.[1] : undefined;
        if (policy === null) add('mta-sts', 'MTA-STS', [], 'policy host unreachable', true);
        else if (!mode) {
          add(
            'mta-sts',
            'MTA-STS',
            [
              {
                message: 'MTA-STS policy file missing or invalid',
                detail: `_mta-sts.${domain} exists but https://mta-sts.${domain}/.well-known/mta-sts.txt is not served or has no valid "mode:" line, so senders cannot apply the policy.`,
                severity: SEVERITY.MEDIUM,
              },
            ],
            'policy invalid',
          );
        } else add('mta-sts', 'MTA-STS', [], `mode: ${mode}`);
      }

      const tlsRpt = await txt(dns, `_smtp._tls.${domain}`);
      if (tlsRpt === null) add('tls-rpt', 'TLS-RPT', [], 'DNS lookup failed', true);
      else
        add(
          'tls-rpt',
          'TLS-RPT',
          tlsRpt.some((r) => /^v=TLSRPTv1/i.test(r))
            ? []
            : [
                {
                  message: 'No TLS-RPT record',
                  detail: `No _smtp._tls.${domain} TXT record, so ${domain} gets no reports of failed TLS delivery (RFC 8460).`,
                  severity: SEVERITY.LOW,
                },
              ],
          tlsRpt.length ? 'configured' : 'not configured',
        );
    } else {
      const note = hasMx === false ? 'no MX records' : 'MX lookup failed';
      for (const [id, label] of [
        ['dkim', 'DKIM'],
        ['mta-sts', 'MTA-STS'],
        ['tls-rpt', 'TLS-RPT'],
      ] as const) {
        checks.push({ id, label, status: 'skipped', note });
      }
    }

    // CAA: inherited from parent names, so walk up to the organisational domain.
    let caa: boolean | null = false;
    const names = [domain];
    if (org !== domain) names.push(org);
    for (const name of names) {
      try {
        if ((await dns.resolveCaa(name)).length > 0) {
          caa = true;
          break;
        }
      } catch (e) {
        if (!isAbsentError(e)) caa = null;
      }
    }
    if (caa === null) add('caa', 'CAA', [], 'DNS lookup failed', true);
    else
      add(
        'caa',
        'CAA',
        caa
          ? []
          : [
              {
                message: 'No CAA record',
                detail: `${domain} has no CAA record, so any certificate authority may issue certificates for it. Add CAA records naming the CAs you use.`,
                severity: SEVERITY.LOW,
              },
            ],
        caa ? 'present' : 'none',
      );

    return { issues, checks };
  }
}
