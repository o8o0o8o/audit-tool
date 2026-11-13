/**
 * Runs the site-level Domain & Exposure checks once, after the crawl. Each
 * check is isolated: one failing probe never stops the others.
 *
 * - DNS: email authentication + CAA, dangling CNAMEs, staging hosts (CT logs),
 *   script domains that no longer resolve
 * - HTTP probes: exposed files, missing-page status, CORS, open buckets,
 *   leaked secrets in same-site JS, WordPress plugin advisories
 * - Behaviour: Googlebot / AI-crawler parity, locale redirects, consent
 *   "Reject" test (headless Chromium), session replay on sensitive pages
 * - Crawl graph: canonical/hreflang targets, facets, calendars, lastmod, CTAs
 */

import { chromium } from 'playwright';
import type { Issue, PageInfo } from '../../types';
import { RobotsParser } from '../../parsers/robots-parser';
import { runCrawlGraphChecks } from '../site-wide/crawl-graph-checks';
import { cdnHtmlCacheIssues } from '../performance/asset-delivery-analyzer';
import { EmailDnsAnalyzer } from './email-dns-analyzer';
import { ExposedFilesProbe, candidateDirectories } from './exposed-files-probe';
import { NotFoundProbe } from './not-found-probe';
import { SubdomainTakeoverAnalyzer, collectSiteHosts } from './subdomain-takeover';
import { JsSecretsScanner, collectScriptUrls } from './js-secrets-scanner';
import { OpenBucketProbe } from './open-bucket-probe';
import { CorsProbe, selectApiUrls } from './cors-probe';
import { AbandonedScriptDomains } from './abandoned-script-domains';
import { WordPressPluginsAnalyzer, extractWpPlugins } from './wordpress-plugins';
import { StagingHostsAnalyzer } from './staging-hosts';
import { BotParityProbe } from './bot-parity-probe';
import { LocaleRedirectProbe } from './locale-redirect-probe';
import { ConsentRejectTest, type ConsentBrowser } from './consent-reject-test';
import { SessionReplaySensitive } from './session-replay-sensitive';
import { mergeSiteHints } from './crawl-hints';
import { TagBehaviorProbe, type ProbeBrowser } from './tag-behavior-probe';
import { GtmContainerAnalyzer } from '../analytics/gtm-container-analyzer';
import { siteDomain, type SiteChecksData, type SiteProbeResult } from './site-checks-types';

type SaveErrorFn = (message: string, detail: string, severity?: string) => void;

export interface SiteProbeContext {
  /** Parsed robots.txt rules by user agent (`results.robots['user-agent']`). */
  robotsUserAgents?: Record<string, unknown>;
  /** Sitemap URL entries (`results.sitemaps.urls`). */
  sitemapUrls?: Record<string, unknown>;
  /** Internal URLs linked but not necessarily crawled (incoming-links keys). */
  discoveredUrls?: Iterable<string>;
  userAgent?: string;
  /** Test seam: skip the browser-based consent test. */
  skipBrowser?: boolean;
  /**
   * Passive mode (`--passive`, implied by `--lead`): for a site whose owner did not ask for the
   * audit. Only checks that read what the site publishes to every visitor run; the probes that ask
   * for unlinked files, send forged headers, impersonate a crawler or touch other hosts and data
   * stores are skipped and show as "not run in passive mode". See `PASSIVE_SKIPPED_STEPS`.
   */
  passive?: boolean;
  /** Called with the URL of every request the browser probes send (lead scans count them). */
  onBrowserRequest?: (url: string) => void;
}

/**
 * Steps that do not run in passive mode, with the reason and the check rows they would have filled.
 * Policy table: docs/gtm/sales-audit-system.md, "Probe policy in lead mode".
 */
export const PASSIVE_SKIPPED_STEPS: Record<string, { why: string; checks: Array<[id: string, label: string]> }> = {
  'exposed files': { why: 'requests files nobody linked to', checks: [['exposed-files', 'Exposed files']] },
  'staging hosts': { why: 'requests hosts the site never published', checks: [['staging-hosts', 'Staging hosts']] },
  'open buckets': { why: 'requests a storage bucket listing', checks: [['open-buckets', 'Open storage buckets']] },
  CORS: { why: 'sends forged Origin headers', checks: [['cors', 'CORS']] },
  'bot parity': {
    why: 'sends requests that claim to be a search crawler',
    checks: [
      ['googlebot-parity', 'Googlebot parity'],
      ['ai-crawler-access', 'AI crawler access'],
    ],
  },
  'locale redirect': {
    why: 'repeats the homepage request with other languages',
    checks: [['locale-redirect', 'Locale redirect']],
  },
  'consent reject': { why: 'clicks the consent banner', checks: [['consent-reject', 'Trackers after consent reject']] },
};

export const PASSIVE_NOTE = 'not run in passive mode';

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

/** Up to `n` crawled 200 HTML pages, homepage first, spread across distinct first path segments. */
export function samplePages(origin: string, pages: Record<string, PageInfo>, n = 5): string[] {
  const home = origin.replace(/\/$/, '') + '/';
  const seen = new Set<string>();
  const out: string[] = [home];
  for (const [key, p] of Object.entries(pages)) {
    const url = p.url || key;
    if ((p.status ?? 200) !== 200 || url === home || out.length >= n) continue;
    let seg: string;
    try {
      seg = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    } catch {
      continue;
    }
    if (seen.has(seg)) continue;
    seen.add(seg);
    out.push(url);
  }
  return out;
}

/**
 * One headless browser for the consent "Reject" test and the tag behaviour probe.
 * In passive mode only the tag behaviour probe runs (a second homepage load, no clicks on consent).
 */
async function browserProbes(
  home: string,
  second: string | undefined,
  userAgent?: string,
  passive = false,
  onRequest?: (url: string) => void,
): Promise<SiteProbeResult> {
  const launched = await chromium.launch();
  // Every context the probes open reports its requests to the observer.
  const browser = onRequest
    ? new Proxy(launched, {
        get(target, prop) {
          if (prop !== 'newContext') {
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          }
          return async (...args: Parameters<typeof launched.newContext>) => {
            const context = await target.newContext(...args);
            context.on('request', (request) => onRequest(request.url()));
            return context;
          };
        },
      })
    : launched;
  const merged: SiteProbeResult = { issues: [], checks: [] };
  try {
    for (const run of [
      ...(passive
        ? []
        : [
            () => ConsentRejectTest.probe(browser as unknown as ConsentBrowser, home, { secondUrl: second, userAgent }),
          ]),
      () => TagBehaviorProbe.probe(browser as unknown as ProbeBrowser, home, { userAgent }),
    ]) {
      try {
        const r = await run();
        merged.issues.push(...r.issues);
        merged.checks.push(...r.checks);
      } catch (e) {
        console.log(`  ⚠️  browser probe skipped: ${(e as Error).message}`);
      }
    }
    return merged;
  } finally {
    await launched.close().catch(() => undefined);
  }
}

/** Site-wide tag facts from the per-page analytics data. */
export function tagSummary(pages: Record<string, PageInfo>) {
  const gtm = new Set<string>();
  const ga4 = new Set<string>();
  const ads = new Set<string>();
  let installed = 0;
  let withHits = 0;
  for (const p of Object.values(pages)) {
    const ids = p.analytics?.trackingIds ?? {};
    (ids.gtm ?? []).forEach((i) => gtm.add(i.toUpperCase()));
    (ids.ga4 ?? []).forEach((i) => ga4.add(i.toUpperCase()));
    Object.entries(ids)
      .filter(([k]) => /ads|adwords|aw/i.test(k))
      .forEach(([, v]) => v.forEach((i) => ads.add(i.toUpperCase())));
    const rt = p.tagRuntime;
    rt?.ga4Ids.forEach((i) => ga4.add(i));
    if ((ids.gtm?.length ?? 0) + (ids.ga4?.length ?? 0) > 0 || (rt?.hits ?? 0) > 0) installed++;
    if ((rt?.hits ?? 0) > 0) withHits++;
  }
  return { gtm: [...gtm], ga4: [...ga4], ads: [...ads], installed, withHits };
}

function ga4HitsCheck(pages: Record<string, PageInfo>): SiteProbeResult {
  const s = tagSummary(pages);
  const runtimeIds = new Set(Object.values(pages).flatMap((p) => p.tagRuntime?.ga4Ids ?? []));
  return {
    issues: [],
    checks: [
      {
        id: 'ga4-hits',
        label: 'GA4 hits',
        status:
          s.installed === 0 ? 'skipped' : s.withHits === s.installed ? 'pass' : s.withHits === 0 ? 'fail' : 'warn',
        note:
          s.installed === 0
            ? 'no Google tags found'
            : `hits on ${s.withHits} of ${s.installed} tagged pages${runtimeIds.size ? `; properties: ${[...runtimeIds].join(', ')}` : ''}`,
      },
    ],
  };
}

type Step = [string, () => Promise<SiteProbeResult>];

/**
 * The probe steps for a run, in order. Exported so the passive policy can be tested without
 * running a probe: in passive mode the steps of `PASSIVE_SKIPPED_STEPS` are absent.
 */
export function siteProbeSteps(origin: string, pages: Record<string, PageInfo>, ctx: SiteProbeContext = {}): Step[] {
  const domain = siteDomain(origin);
  if (!domain) return [];
  const passive = ctx.passive === true;
  const { assetUrls, linkHosts } = gatherCrawlHints(pages);
  const hints = mergeSiteHints(pages);
  const allAssets = [...hints.assets, ...assetUrls];
  const samples = samplePages(origin, pages);
  const robots = ctx.robotsUserAgents
    ? ({ userAgents: ctx.robotsUserAgents } as unknown as Parameters<typeof RobotsParser.isPathAllowed>[2])
    : null;
  const robotsAllows = robots ? (ua: string, path: string) => RobotsParser.isPathAllowed(path, ua, robots) : undefined;

  // DNS-based checks need a real domain name, not an IP or a local host.
  const dnsName = !isIpOrLocal(domain);
  const steps: Step[] = [
    ...(dnsName ? ([['email/DNS', () => EmailDnsAnalyzer.analyze(domain)]] as Step[]) : []),
    ['exposed files', () => ExposedFilesProbe.probe(origin, candidateDirectories(origin, assetUrls))],
    ['missing-page status', () => NotFoundProbe.probe(origin)],
    ...(dnsName
      ? ([
          ['subdomain takeover', () => SubdomainTakeoverAnalyzer.analyze(collectSiteHosts(origin, linkHosts))],
          ['staging hosts', () => StagingHostsAnalyzer.analyze(domain)],
          ['abandoned script domains', () => AbandonedScriptDomains.analyze(origin, hints.thirdPartyHosts)],
        ] as Step[])
      : []),
    // Passive: the public scripts are still read for key patterns, but a Firebase database named in
    // them is not queried (that would be an unauthenticated read of a data store).
    [
      'JS secrets',
      () => JsSecretsScanner.scan(collectScriptUrls(origin, hints.scripts), undefined, { checkFirebase: !passive }),
    ],
    ['open buckets', () => OpenBucketProbe.probe(allAssets)],
    ['CORS', () => CorsProbe.probe(origin, selectApiUrls(origin, hints.api))],
    // Passive: plugin versions come from asset URLs only; the unlinked readme files are not requested.
    [
      'WordPress plugins',
      () =>
        WordPressPluginsAnalyzer.analyze(origin, extractWpPlugins(allAssets), undefined, undefined, {
          readReadme: !passive,
        }),
    ],
    ['bot parity', () => BotParityProbe.probe(origin, { sampleUrls: samples, robotsAllows })],
    ['locale redirect', () => LocaleRedirectProbe.probe(origin)],
    ['GA4 hits', () => Promise.resolve(ga4HitsCheck(pages))],
    [
      'GTM container',
      () => {
        const s = tagSummary(pages);
        return GtmContainerAnalyzer.analyze(s.gtm, s.ga4, s.ads);
      },
    ],
    ['session replay', () => Promise.resolve(SessionReplaySensitive.analyze(hints.replayPages))],
    ...(ctx.skipBrowser
      ? []
      : ([
          ['browser probes', () => browserProbes(samples[0], samples[1], ctx.userAgent, passive, ctx.onBrowserRequest)],
        ] as Step[])),
  ];
  return passive ? steps.filter(([name]) => !(name in PASSIVE_SKIPPED_STEPS)) : steps;
}

export async function runSiteProbes(
  origin: string,
  pages: Record<string, PageInfo>,
  saveError: SaveErrorFn,
  ctx: SiteProbeContext = {},
): Promise<SiteChecksData> {
  const domain = siteDomain(origin);
  const data: SiteChecksData = { checkedAt: new Date().toISOString(), domain, checks: [] };
  if (!domain) return data;
  if (ctx.passive) data.passive = true;
  const hints = mergeSiteHints(pages);
  const steps = siteProbeSteps(origin, pages, ctx);
  for (const [name, run] of steps) {
    try {
      const result = await run();
      result.issues.forEach((i: Issue) => saveError(i.message ?? '', i.detail ?? '', i.severity));
      data.checks.push(...result.checks);
    } catch (e) {
      console.log(`  ⚠️  ${name} check skipped: ${(e as Error).message}`);
    }
  }
  if (ctx.passive) {
    // Show what was left out, so a clean table is not read as "checked and fine".
    for (const { checks } of Object.values(PASSIVE_SKIPPED_STEPS)) {
      for (const [id, label] of checks) data.checks.push({ id, label, status: 'skipped', note: PASSIVE_NOTE });
    }
  }

  try {
    runCrawlGraphChecks(pages, ctx.sitemapUrls ?? {}, origin, new Date(), {
      discoveredUrls: ctx.discoveredUrls,
      linksByPage: hints.linksByPage,
    }).forEach((i) => saveError(i.message ?? '', i.detail ?? '', i.severity));
    const cdnStates = Object.values(pages)
      .map((p) => p.cdnCache)
      .filter((s): s is 'hit' | 'miss' | 'none' => !!s);
    cdnHtmlCacheIssues(cdnStates).forEach((i) => saveError(i.message ?? '', i.detail ?? '', i.severity));
  } catch (e) {
    console.log(`  ⚠️  crawl graph checks skipped: ${(e as Error).message}`);
  }
  return data;
}
