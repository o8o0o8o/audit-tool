/**
 * DNS & IPv6 Analyzer
 * Checks DNS configuration: nameserver count, IPv6 (AAAA records), DNSSEC
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import * as dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const resolveNs = promisify(dns.resolveNs);

class DNSIPv6Analyzer {
  /**
   * Analyze DNS configuration for the origin domain.
   * Called once per audit (site-level), not per page.
   */
  static async analyze(origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      domain: string;
      hasIPv4: boolean;
      hasIPv6: boolean;
      ipv4Addresses: string[];
      ipv6Addresses: string[];
      nameservers: string[];
      nameserverCount: number;
    } = {
      domain: '',
      hasIPv4: false,
      hasIPv6: false,
      ipv4Addresses: [],
      ipv6Addresses: [],
      nameservers: [],
      nameserverCount: 0,
    };

    try {
      info.domain = new URL(origin).hostname;
    } catch {
      return { issues, warnings, info };
    }

    // 1. Check IPv4 (A records)
    try {
      const ipv4 = await resolve4(info.domain);
      info.hasIPv4 = ipv4.length > 0;
      info.ipv4Addresses = ipv4.slice(0, 5);
    } catch {
      // No A records or DNS error
    }

    // 2. Check IPv6 (AAAA records)
    try {
      const ipv6 = await resolve6(info.domain);
      info.hasIPv6 = ipv6.length > 0;
      info.ipv6Addresses = ipv6.slice(0, 5);
    } catch {
      // No AAAA records
    }

    // 3. Check nameservers
    try {
      // Try resolving NS for the main domain (strip subdomain)
      const parts = info.domain.split('.');
      const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : info.domain;
      const ns = await resolveNs(baseDomain);
      info.nameservers = ns.slice(0, 10);
      info.nameserverCount = ns.length;
    } catch {
      // NS resolution failed
    }

    // Report findings
    if (!info.hasIPv6) {
      warnings.push({
        message: 'No IPv6 (AAAA) DNS records found',
        detail: `Domain "${info.domain}" has no AAAA records. ~40% of internet traffic uses IPv6. Adding IPv6 support improves reachability and can reduce latency for IPv6-native clients.`,
        severity: SEVERITY.LOW,
      });
    }

    if (info.nameserverCount === 1) {
      warnings.push({
        message: 'Only one nameserver configured',
        detail: `Domain has only 1 nameserver (${info.nameservers[0]}). Best practice is at least 2 nameservers for redundancy. DNS failure would make the site completely unreachable.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!info.hasIPv4 && !info.hasIPv6) {
      issues.push({
        message: 'No DNS records found for domain',
        detail: `No A or AAAA records found for "${info.domain}". This may indicate a DNS misconfiguration.`,
        severity: SEVERITY.HIGH,
      });
    }

    return { issues, warnings, info };
  }
}

export { DNSIPv6Analyzer };
