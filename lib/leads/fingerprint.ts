/**
 * Stage 1 of the lead pipeline: fingerprint a prospect's site from its homepage and robots.txt.
 *
 * Cost per site: one GET of the homepage and one of robots.txt. A site that refuses the plain
 * request (403, 429, a bot challenge) is read once more in headless Chromium; if that also fails
 * the site is `unreadable` and nothing is claimed about it. A blocked response is never evidence.
 *
 * Passive only: nothing here asks for a URL the site did not publish to every visitor.
 */

import { chromium, type Browser } from 'playwright';
import { TechnologyDetector, stripCodeBlocks, type DetectedTechnology } from '../analyzers/seo/technology-detector';
import { readRuntimeVersions } from '../analyzers/security/js-library-analyzer';
import { isChallengeResponse } from '../utils/blocked-fetch';
import { LINK_CHECK_HEADERS } from '../utils/link-status';
import { domainOf, originOf } from './csv-store';
import { formatEolHit } from './eol';
import { buildStackProfile, emptyProfile, kindsOf, signalsOf } from './stack-profile';
import { extractVersions, mergeVersions } from './versions';
import type { FingerprintResult, RobotsSummary, StackProfile } from './types';

export interface PageSnapshot {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Lower-cased names; several `Set-Cookie` values are joined with a newline. */
  headers: Record<string, string>;
  body: string;
}

export interface BrowserSnapshot extends PageSnapshot {
  scriptUrls: string[];
  /** Names from `TechnologyDetector.KNOWN_GLOBALS` that exist on `window`. */
  globals: string[];
  /** Library slug → version from runtime globals. */
  runtime: Record<string, string>;
  /** Requests the page made to the site's own hosts. */
  requests: number;
}

/** Resolves to null on a network error or timeout. */
export type PageFetcher = (
  url: string,
  opts?: { maxBytes?: number; timeoutMs?: number },
) => Promise<PageSnapshot | null>;
export type BrowserReader = (url: string, siteDomain: string) => Promise<BrowserSnapshot | null>;

const HOMEPAGE_MAX_BYTES = 2 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 200 * 1024;

export const httpPageFetcher: PageFetcher = async (url, opts = {}) => {
  try {
    const res = await fetch(url, {
      headers: LINK_CHECK_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers['set-cookie'] = cookies.join('\n');

    const maxBytes = opts.maxBytes ?? HOMEPAGE_MAX_BYTES;
    const reader = res.body?.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    if (reader) {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(Buffer.from(value));
        total += value.length;
      }
      await reader.cancel().catch(() => undefined);
    }
    const body = Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
    return { status: res.status, url: res.url || url, headers, body };
  } catch {
    return null;
  }
};

/** Text that only a bot-protection page shows. Checked on small pages only: real pages mention these services too. */
const CHALLENGE_BODY =
  /just a moment\.\.\.|attention required! \| cloudflare|<title>client challenge<\/title>|\/_fs-ch-[a-z0-9]+\/|enable javascript to proceed|cf-browser-verification|_cf_chl_opt|px-captcha|perimeterx|captcha-delivery\.com|incapsula incident id|request unsuccessful\. incapsula|ddos-guard|sucuri website firewall|access denied[\s\S]{0,400}reference(?:&#32;|\s)(?:&#35;|#)|verifying you are human|checking your browser before|enable javascript and cookies to continue|pardon our interruption|are you a robot|bot verification/i;
const CHALLENGE_MAX_BODY = 20_000;

/**
 * Why a response cannot be used as a picture of the site, or null when it can.
 * 403/429 and challenge pages mean we were refused; other errors mean there was nothing to read.
 */
export function blockReason(status: number, headers: Record<string, string>, body: string): string | null {
  if (isChallengeResponse(status, headers)) return `challenge-${status}`;
  if (status >= 400) return `http-${status}`;
  if (status < 200 || status >= 300) return `http-${status}`;
  if (!body.trim()) return 'empty';
  if (body.length < CHALLENGE_MAX_BODY && CHALLENGE_BODY.test(body)) return 'challenge-page';
  const contentType = headers['content-type'] ?? '';
  const looksHtml = /<html[\s>]|<!doctype html|<head[\s>]|<body[\s>]/i.test(body.slice(0, 5000));
  if (!looksHtml && !/html/i.test(contentType)) return 'not-html';
  return null;
}

export function extractScriptSrcs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (src) out.add(src);
  }
  return [...out];
}

export function parseRobots(body: string): Pick<RobotsSummary, 'sitemaps' | 'disallowAll'> {
  const sitemaps: string[] = [];
  let agents: string[] = [];
  let lastWasAgent = false;
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[] }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[] } | null = null;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'sitemap') {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
    } else if (field === 'user-agent') {
      if (!lastWasAgent) {
        agents = [];
        current = { agents, disallow: [], allow: [] };
        groups.push(current);
      }
      agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    } else if (field === 'disallow' && current) {
      current.disallow.push(value);
    } else if (field === 'allow' && current) {
      current.allow.push(value);
    }
    lastWasAgent = false;
  }

  const star = groups.filter((g) => g.agents.includes('*'));
  const disallowAll = star.some((g) => g.disallow.includes('/')) && !star.some((g) => g.allow.some((a) => a !== ''));
  return { sitemaps: [...new Set(sitemaps)], disallowAll };
}

/** True when `a` and `b` are the same site (same domain, or one is a subdomain of the other). */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export interface FingerprintDeps {
  fetchPage?: PageFetcher;
  /** Omit to skip the browser retry (a refused site is then `unreadable` straight away). */
  readInBrowser?: BrowserReader;
  now?: () => Date;
}

export async function fingerprintSite(website: string, deps: FingerprintDeps = {}): Promise<FingerprintResult> {
  const fetchPage = deps.fetchPage ?? httpPageFetcher;
  const now = deps.now ?? (() => new Date());
  const domain = domainOf(website);
  const requestedUrl = `${originOf(website)}/`;
  let requestsSent = 0;

  let snapshot: PageSnapshot | null = await fetchPage(requestedUrl);
  requestsSent++;
  if (!snapshot && !/^https?:\/\/www\./i.test(requestedUrl)) {
    // Some sites resolve only with the www. prefix.
    snapshot = await fetchPage(requestedUrl.replace(/^(https?:\/\/)/i, '$1www.'));
    requestsSent++;
  }

  let reason = snapshot ? blockReason(snapshot.status, snapshot.headers, snapshot.body) : 'network';
  let via: FingerprintResult['via'] = snapshot ? 'http' : 'none';
  let browserExtras: Pick<BrowserSnapshot, 'scriptUrls' | 'globals' | 'runtime'> | null = null;

  // A page that is simply gone (404/410) is not worth a browser; a refusal or an error may be.
  const worthBrowser = reason !== null && reason !== 'http-404' && reason !== 'http-410';
  if (worthBrowser && deps.readInBrowser) {
    const rendered = await deps.readInBrowser(snapshot?.url ?? requestedUrl, domain);
    requestsSent += rendered?.requests ?? 1;
    if (rendered) {
      const renderedReason = blockReason(rendered.status, rendered.headers, rendered.body);
      if (!renderedReason) {
        snapshot = rendered;
        browserExtras = rendered;
        via = 'browser';
        reason = null;
      } else {
        reason = renderedReason;
      }
    }
  }

  const base = {
    website,
    domain,
    fingerprintedAt: now().toISOString(),
    requestedUrl,
    finalUrl: snapshot?.url ?? null,
    status: snapshot?.status ?? null,
  };

  if (reason || !snapshot) {
    return {
      ...base,
      via,
      unreadableReason: reason ?? 'network',
      redirectedTo: null,
      robots: null,
      requestsSent,
      profile: emptyProfile('unreadable', `Site could not be read: ${reason ?? 'network'}`),
    };
  }

  const finalDomain = domainOf(snapshot.url);
  const redirectedTo = sameSite(finalDomain, domain) ? null : finalDomain;

  let robots: RobotsSummary | null = null;
  let finalOrigin: string;
  try {
    finalOrigin = new URL(snapshot.url).origin;
  } catch {
    finalOrigin = originOf(website);
  }
  const robotsResponse = await fetchPage(`${finalOrigin}/robots.txt`, {
    maxBytes: ROBOTS_MAX_BYTES,
    timeoutMs: 10_000,
  });
  requestsSent++;
  if (robotsResponse) {
    const isText =
      robotsResponse.status === 200 && !/<html[\s>]|<!doctype html/i.test(robotsResponse.body.slice(0, 500));
    robots = {
      status: robotsResponse.status,
      ...(isText ? parseRobots(robotsResponse.body) : { sitemaps: [], disallowAll: false }),
    };
  }

  const profile = profileFromSnapshot(snapshot, browserExtras, now().toISOString().slice(0, 10));
  if (redirectedTo) profile.notes.push(`Homepage redirects to another site: ${redirectedTo}`);
  if (robots?.disallowAll) profile.notes.push('robots.txt disallows the whole site for all crawlers');

  return { ...base, via, unreadableReason: null, redirectedTo, robots, requestsSent, profile };
}

export function profileFromSnapshot(
  snapshot: PageSnapshot,
  browserExtras: Pick<BrowserSnapshot, 'scriptUrls' | 'globals' | 'runtime'> | null,
  today?: string,
): StackProfile {
  const html = stripCodeBlocks(snapshot.body);
  const scriptSrcs = [...new Set([...extractScriptSrcs(html), ...(browserExtras?.scriptUrls ?? [])])];
  const detected = TechnologyDetector.detectFromHtml(
    html,
    snapshot.headers,
    scriptSrcs.map((s) => s.toLowerCase()),
    browserExtras?.globals ?? [],
  );
  const versions = mergeVersions(
    extractVersions({ html, headers: snapshot.headers, scriptSrcs, runtime: browserExtras?.runtime }),
  );
  return buildStackProfile({ technologies: detected.technologies as DetectedTechnology[], versions, html, today });
}

/**
 * tsx compiles with `keepNames`, which wraps named functions in `__name(...)` calls. A function passed
 * to `page.evaluate` is serialized with those calls, so the page needs `__name` to exist; without it
 * the evaluate throws and a runtime read silently comes back empty.
 */
export function installNamePolyfill(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name === 'undefined') g.__name = (target: unknown) => target;
}

/** Most requests one browser read may send (to any host) before the rest are aborted. */
export const BROWSER_REQUEST_CAP = 150;

/** Headless Chromium reader for sites that refuse a plain request. One browser, one context per site. */
export class BrowserSession {
  #browser: Browser | null = null;

  read: BrowserReader = async (url, siteDomain) => {
    try {
      this.#browser ??= await chromium.launch({ headless: true });
    } catch {
      return null;
    }
    const context = await this.#browser.newContext({
      userAgent: LINK_CHECK_HEADERS['User-Agent'],
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    try {
      await context.addInitScript(installNamePolyfill);
      // Images, fonts and media tell us nothing about the stack: they are aborted in the browser and
      // never reach the site. Everything else is let through up to a hard cap, so a page that polls
      // or retries in a loop cannot turn one fingerprint into thousands of requests.
      let requests = 0; // requests that actually left for the site's own hosts
      let allowed = 0;
      await context.route('**/*', (route) => {
        const req = route.request();
        if (['image', 'media', 'font'].includes(req.resourceType()) || allowed >= BROWSER_REQUEST_CAP) {
          return route.abort();
        }
        allowed++;
        try {
          const host = new URL(req.url()).hostname.replace(/^www\./, '');
          if (sameSite(host, siteDomain)) requests++;
        } catch {
          // not a URL we count
        }
        return route.continue();
      });
      const page = await context.newPage();
      const scriptUrls = new Set<string>();
      const mainResponses: Array<{ status: number; headers: () => Promise<Record<string, string>> }> = [];
      page.on('request', (req) => {
        if (req.resourceType() === 'script') scriptUrls.add(req.url());
      });
      page.on('response', (res) => {
        const req = res.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          mainResponses.push({ status: res.status(), headers: () => res.allHeaders() });
        }
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // A challenge that clears navigates on; give it, and late scripts, a moment.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

      const last = mainResponses.at(-1);
      if (!last) return null;
      const headers = await last.headers().catch(() => ({}) as Record<string, string>);
      const body = await page.content();
      const globals = await page
        .evaluate(
          (names: string[]) =>
            names.filter((g) => {
              try {
                return typeof (window as unknown as Record<string, unknown>)[g] !== 'undefined';
              } catch {
                return false;
              }
            }),
          TechnologyDetector.KNOWN_GLOBALS,
        )
        .catch(() => [] as string[]);
      const runtime = await page.evaluate(readRuntimeVersions).catch(() => ({}) as Record<string, string>);
      return {
        status: last.status,
        url: page.url(),
        headers,
        body,
        scriptUrls: [...scriptUrls],
        globals,
        runtime,
        requests,
      };
    } catch {
      return null;
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => undefined);
    this.#browser = null;
  }
}

/** Column names the fingerprint stage owns in the companies CSV. */
export const STACK_COLUMNS = [
  'stack_kind',
  'cms_detected',
  'cms_secondary',
  'cms_version',
  'framework',
  'framework_version',
  'runtime',
  'eol',
  'stack_confidence',
  'stack_signals',
  'fingerprinted_at',
] as const;

/** `Concrete CMS[cookie+source]; Contentful[asset-host]`, plus flags a person scanning the sheet needs. */
export function signalSummary(result: FingerprintResult): string {
  if (result.unreadableReason) return `unreadable:${result.unreadableReason}`;
  const byTech = new Map<string, string[]>();
  for (const s of result.profile.signals) byTech.set(s.tech, [...(byTech.get(s.tech) ?? []), s.kind]);
  const parts = [...byTech].map(([tech, kinds]) => `${tech}[${[...new Set(kinds)].sort().join('+')}]`);
  if (result.redirectedTo) parts.push(`redirect:${result.redirectedTo}`);
  if (result.robots?.disallowAll) parts.push('robots:disallow-all');
  if (result.via === 'browser') parts.push('via:browser');
  return parts.join('; ');
}

export function stackColumns(result: FingerprintResult): Record<(typeof STACK_COLUMNS)[number], string> {
  const p = result.profile;
  return {
    stack_kind: p.kind,
    cms_detected: p.cms ?? '',
    cms_secondary: p.cmsSecondary ?? '',
    cms_version: p.cmsVersion ?? '',
    framework: p.framework ?? '',
    framework_version: p.frameworkVersion ?? '',
    runtime: p.runtime ?? '',
    eol: p.eol.map(formatEolHit).join('; '),
    stack_confidence: p.kind === 'unreadable' ? '' : p.confidence,
    stack_signals: signalSummary(result),
    fingerprinted_at: result.fingerprintedAt,
  };
}

export { kindsOf, signalsOf };
