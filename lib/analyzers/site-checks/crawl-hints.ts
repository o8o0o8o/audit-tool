/**
 * Small per-page facts captured at crawl time for the post-crawl site checks.
 * The full `requests` map and anchor texts are slimmed away when pages are
 * checkpointed, so the probes (secrets scan, buckets, CORS, abandoned script
 * domains, WordPress plugins, session replay, CTA targets) read these capped
 * lists instead. Also runs the per-page structured-data phone check, which
 * needs JSON-LD and visible text that are not kept.
 */

import type { Issue, PageInfo, ParsedPage } from '../../types';
import { checkPhoneConsistency, extractSchemaPhones, isCtaText, type PageLink } from '../site-wide/crawl-graph-checks';
import {
  detectReplayVendors,
  extractSensitiveFields,
  type EvaluatablePage,
  type SensitiveFields,
} from './session-replay-sensitive';
import { orgDomain } from './site-checks-types';

export interface SiteHints {
  scripts: string[];
  assets: string[];
  api: Array<{ url: string; resourceType?: string; method?: string }>;
  thirdPartyHosts: string[];
  ctaLinks: PageLink[];
  replayVendors: string[];
  sensitive?: SensitiveFields;
}

const CAP = { scripts: 30, assets: 60, api: 10, hosts: 40, cta: 20 };

interface RequestLike {
  resourceType?: string;
  method?: string;
}

type PageLike = EvaluatablePage & {
  evaluate<T>(fn: () => T): Promise<T>;
};

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Pure part: classify request URLs and anchors. */
export function buildSiteHints(
  url: string,
  requests: Record<string, RequestLike>,
  anchors: PageLink[],
): Omit<SiteHints, 'sensitive'> {
  const pageHost = hostOf(url) ?? '';
  const site = orgDomain(pageHost);
  const hints: Omit<SiteHints, 'sensitive'> = {
    scripts: [],
    assets: [],
    api: [],
    thirdPartyHosts: [],
    ctaLinks: [],
    replayVendors: [],
  };
  const hosts = new Set<string>();
  for (const [reqUrl, r] of Object.entries(requests)) {
    if (!/^https?:/i.test(reqUrl)) continue;
    const host = hostOf(reqUrl);
    if (!host) continue;
    const type = r.resourceType ?? '';
    const sameSite = orgDomain(host) === site;
    if (type === 'script' && hints.scripts.length < CAP.scripts) hints.scripts.push(reqUrl);
    if (['image', 'media', 'font', 'script', 'stylesheet'].includes(type) && hints.assets.length < CAP.assets)
      hints.assets.push(reqUrl);
    if (sameSite && (type === 'fetch' || type === 'xhr') && hints.api.length < CAP.api)
      hints.api.push({ url: reqUrl, resourceType: type, method: r.method });
    if (!sameSite && (type === 'script' || type === 'document') && reqUrl !== url) hosts.add(host);
  }
  hints.thirdPartyHosts = [...hosts].slice(0, CAP.hosts);
  hints.replayVendors = detectReplayVendors(Object.keys(requests));
  for (const a of anchors) {
    if (hints.ctaLinks.length >= CAP.cta) break;
    if (a.href && isCtaText(a.text)) hints.ctaLinks.push(a);
  }
  return hints;
}

function anchorsOf(parsedPage: ParsedPage, url: string): PageLink[] {
  const out: PageLink[] = [];
  for (const a of parsedPage.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    try {
      out.push({ href: new URL(href, url).toString(), text: (a.text ?? '').replace(/\s+/g, ' ').trim() });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Captures hints onto `pageData.siteHints` and returns per-page phone findings. */
export async function capturePageHints(
  page: PageLike,
  parsedPage: ParsedPage,
  url: string,
  pageData: PageInfo,
  requests: Record<string, RequestLike>,
): Promise<Issue[]> {
  const hints: SiteHints = buildSiteHints(url, requests, anchorsOf(parsedPage, url));
  if (hints.replayVendors.length) hints.sensitive = await extractSensitiveFields(page);
  pageData.siteHints = hints;

  const schemaPhones = parsedPage.querySelectorAll('script[type="application/ld+json"]').flatMap((s) => {
    try {
      return extractSchemaPhones(JSON.parse(s.text));
    } catch {
      return [];
    }
  });
  if (!schemaPhones.length) return [];
  let visibleText: string;
  try {
    visibleText = await page.evaluate(() => document.body?.innerText ?? '');
  } catch {
    return [];
  }
  const telLinks = parsedPage.querySelectorAll('a[href^="tel:"]').map((a) => a.getAttribute('href') ?? '');
  return checkPhoneConsistency([{ url, schemaPhones, visibleText, telLinks }]);
}

/** Union of hints across pages, deduped and capped, for the post-crawl probes. */
export function mergeSiteHints(pages: Record<string, PageInfo>) {
  const scripts = new Set<string>();
  const assets = new Set<string>();
  const api = new Map<string, { url: string; resourceType?: string; method?: string }>();
  const hosts = new Set<string>();
  const linksByPage: Record<string, PageLink[]> = {};
  const replayPages: Array<{ url: string; replayVendors: string[] } & SensitiveFields> = [];
  for (const [url, p] of Object.entries(pages)) {
    const h = p.siteHints;
    if (!h) continue;
    h.scripts.forEach((s) => scripts.add(s));
    h.assets.forEach((s) => assets.add(s));
    h.api.forEach((a) => api.set(a.url, a));
    h.thirdPartyHosts.forEach((s) => hosts.add(s));
    if (h.ctaLinks.length) linksByPage[url] = h.ctaLinks;
    if (h.replayVendors.length && h.sensitive)
      replayPages.push({ url, replayVendors: h.replayVendors, ...h.sensitive });
  }
  return {
    scripts: [...scripts],
    assets: [...assets],
    api: [...api.values()],
    thirdPartyHosts: [...hosts],
    linksByPage,
    replayPages,
  };
}
