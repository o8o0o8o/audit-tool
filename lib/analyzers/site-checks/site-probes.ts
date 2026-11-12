/**
 * Runs the site-level Domain & Exposure checks once, after the crawl:
 * email/DNS authentication, exposed sensitive files, the missing-page status
 * probe and the dangling-CNAME check. Each check is isolated: one failing
 * probe never stops the others.
 */

import type { Issue, PageInfo } from '../../types';
import { EmailDnsAnalyzer } from './email-dns-analyzer';
import { ExposedFilesProbe, candidateDirectories } from './exposed-files-probe';
import { NotFoundProbe } from './not-found-probe';
import { SubdomainTakeoverAnalyzer, collectSiteHosts } from './subdomain-takeover';
import { siteDomain, type SiteChecksData, type SiteProbeResult } from './site-checks-types';

type SaveErrorFn = (message: string, detail: string, severity?: string) => void;

/** Same-origin asset URLs (images) and linked hostnames gathered from the crawled pages. */
export function gatherCrawlHints(pages: Record<string, PageInfo>): { assetUrls: string[]; linkHosts: string[] } {
  const assetUrls: string[] = [];
  const linkHosts = new Set<string>();
  for (const page of Object.values(pages)) {
    const images: unknown = page.images; // the image analyzer stores [{ src, alt }]; checkpoints may slim it
    for (const img of Array.isArray(images) ? (images as Array<{ src?: string }>) : []) {
      if (img?.src && assetUrls.length < 500) assetUrls.push(img.src);
    }
    for (const domain of Object.keys(page.externalLinksData?.linksByDomain ?? {})) linkHosts.add(domain);
  }
  return { assetUrls, linkHosts: [...linkHosts] };
}

export function isIpOrLocal(host: string): boolean {
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    !host.includes('.')
  );
}

export async function runSiteProbes(
  origin: string,
  pages: Record<string, PageInfo>,
  saveError: SaveErrorFn,
): Promise<SiteChecksData> {
  const domain = siteDomain(origin);
  const data: SiteChecksData = { checkedAt: new Date().toISOString(), domain, checks: [] };
  if (!domain) return data;
  const { assetUrls, linkHosts } = gatherCrawlHints(pages);

  // DNS-based checks need a real domain name, not an IP or a local host.
  const dnsName = !isIpOrLocal(domain);
  const steps: Array<[string, () => Promise<SiteProbeResult>]> = [
    ...(dnsName
      ? [['email/DNS', () => EmailDnsAnalyzer.analyze(domain)] as [string, () => Promise<SiteProbeResult>]]
      : []),
    ['exposed files', () => ExposedFilesProbe.probe(origin, candidateDirectories(origin, assetUrls))],
    ['missing-page status', () => NotFoundProbe.probe(origin)],
    ...(dnsName
      ? [
          ['subdomain takeover', () => SubdomainTakeoverAnalyzer.analyze(collectSiteHosts(origin, linkHosts))] as [
            string,
            () => Promise<SiteProbeResult>,
          ],
        ]
      : []),
  ];
  for (const [name, run] of steps) {
    try {
      const result = await run();
      result.issues.forEach((i: Issue) => saveError(i.message ?? '', i.detail ?? '', i.severity));
      data.checks.push(...result.checks);
    } catch (e) {
      console.log(`  ⚠️  ${name} check skipped: ${(e as Error).message}`);
    }
  }
  return data;
}
