/**
 * Bot parity probe: fetches a few sample URLs with a desktop Chrome user agent,
 * a Googlebot smartphone user agent and the main AI crawler user agents, and
 * compares what each gets back (status, final URL, title, canonical, robots).
 *
 * Caveat built into every message: CDNs / WAFs commonly block *spoofed*
 * crawler UAs and let the real crawler through after verifying its IP, so a
 * block seen here is a signal to confirm, not proof.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import type { SiteCheckResult, SiteProbeResult } from './site-checks-types';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const GOOGLEBOT_SMARTPHONE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** AI crawlers to compare. Google-Extended is a robots.txt-only token (no own fetcher), so it is skipped. */
export const AI_CRAWLERS: { token: string; ua: string }[] = [
  {
    token: 'GPTBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  },
  {
    token: 'ClaudeBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  },
  {
    token: 'PerplexityBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  },
  { token: 'CCBot', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
];

const MAX_SAMPLES = 5;
const MAX_HOPS = 5;
const MAX_BODY = 512 * 1024;

/** One HTTP response, redirects NOT followed. `null` from the fetcher = network failure. */
export interface RawResponse {
  status: number;
  location?: string | null;
  xRobotsTag?: string | null;
  /** Response body (HTML); may be truncated. Empty for redirects. */
  body?: string;
}

export type RawFetcher = (url: string, headers: Record<string, string>) => Promise<RawResponse | null>;

export const defaultRawFetcher: RawFetcher = async (url, headers) => {
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    let body = '';
    if (res.status < 300 || res.status >= 400) {
      body = (await res.text().catch(() => '')).slice(0, MAX_BODY);
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    return {
      status: res.status,
      location: res.headers.get('location'),
      xRobotsTag: res.headers.get('x-robots-tag'),
      body,
    };
  } catch {
    return null;
  }
};

export interface FetchOutcome {
  status: number;
  finalUrl: string;
  chain: { url: string; status: number }[];
  title: string | null;
  canonical: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  challenge: boolean;
}

/** Follows up to 5 redirects manually, recording the chain. Returns null on network failure. */
export async function fetchWithChain(
  url: string,
  headers: Record<string, string>,
  fetcher: RawFetcher,
): Promise<FetchOutcome | null> {
  const chain: { url: string; status: number }[] = [];
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetcher(current, headers);
    if (!res) return null;
    chain.push({ url: current, status: res.status });
    if (res.status >= 300 && res.status < 400 && res.location && hop < MAX_HOPS) {
      try {
        current = new URL(res.location, current).href;
      } catch {
        return null;
      }
      continue;
    }
    const body = res.body ?? '';
    return {
      status: res.status,
      finalUrl: current,
      chain,
      title: extractTitle(body),
      canonical: extractLinkHref(body, 'canonical'),
      metaRobots: extractMetaContent(body, 'robots'),
      xRobotsTag: res.xRobotsTag?.trim() || null,
      challenge: isChallengePage(body),
    };
  }
  return null;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decode(m[1]) : null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

export function extractLinkHref(html: string, rel: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const r = attr(tag, 'rel');
    if (r && r.toLowerCase().split(/\s+/).includes(rel)) return attr(tag, 'href');
  }
  return null;
}

export function extractMetaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, 'name') ?? '').toLowerCase() === name) return (attr(tag, 'content') ?? '').toLowerCase();
  }
  return null;
}

const CHALLENGE_RE =
  /cf-chl|challenge-platform|cf_chl_opt|<title>\s*(?:just a moment|attention required|access denied)|g-recaptcha|h-captcha|hcaptcha\.com|captcha-delivery\.com|px-captcha|_incapsula_resource|are you a robot/i;

export function isChallengePage(html: string): boolean {
  return CHALLENGE_RE.test(html);
}

/** Blocked = 403/429/503 or a bot-challenge page. */
export function isBlocked(o: FetchOutcome): boolean {
  return o.status === 403 || o.status === 429 || o.status === 503 || o.challenge;
}

const normUrl = (u: string | null) => (u ? u.replace(/\/+$/, '').toLowerCase() : null);
const normRobots = (r: string | null) =>
  r
    ? r
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(',')
    : null;

/** Differences in SEO tags between two 200 responses (empty = same). */
export function seoTagDiffs(browser: FetchOutcome, bot: FetchOutcome): string[] {
  const diffs: string[] = [];
  if ((browser.title ?? '') !== (bot.title ?? '')) diffs.push(`title "${browser.title ?? ''}" vs "${bot.title ?? ''}"`);
  if (normUrl(browser.canonical) !== normUrl(bot.canonical))
    diffs.push(`canonical ${browser.canonical ?? '(none)'} vs ${bot.canonical ?? '(none)'}`);
  if (normRobots(browser.metaRobots) !== normRobots(bot.metaRobots))
    diffs.push(`meta robots "${browser.metaRobots ?? ''}" vs "${bot.metaRobots ?? ''}"`);
  if (normRobots(browser.xRobotsTag?.toLowerCase() ?? null) !== normRobots(bot.xRobotsTag?.toLowerCase() ?? null))
    diffs.push(`X-Robots-Tag "${browser.xRobotsTag ?? ''}" vs "${bot.xRobotsTag ?? ''}"`);
  if (normUrl(browser.finalUrl) !== normUrl(bot.finalUrl))
    diffs.push(`final URL ${browser.finalUrl} vs ${bot.finalUrl}`);
  return diffs;
}

/** robots.txt decision: true when `ua` (product token, e.g. "GPTBot") may fetch `path`. */
export type RobotsAllows = (ua: string, path: string) => boolean;

export interface BotParityOptions {
  /** Extra sample URLs (homepage is always first); capped at 5 total. */
  sampleUrls?: string[];
  /** Parsed robots.txt decision. Without it the AI-crawler firewall check is skipped. */
  robotsAllows?: RobotsAllows;
  fetcher?: RawFetcher;
}

const HEADERS = (ua: string): Record<string, string> => ({
  'User-Agent': ua,
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
});

const link = (u: string) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`;
const describe = (o: FetchOutcome) => `HTTP ${o.status}${o.challenge ? ' (bot challenge page)' : ''}`;

export class BotParityProbe {
  static async probe(origin: string, opts: BotParityOptions = {}): Promise<SiteProbeResult> {
    const fetcher = opts.fetcher ?? defaultRawFetcher;
    const home = `${origin.replace(/\/$/, '')}/`;
    const samples = [...new Set([home, ...(opts.sampleUrls ?? [])])].slice(0, MAX_SAMPLES);

    const tagDiffs: string[] = [];
    const gbBlocked: string[] = [];
    const aiBlocked = new Map<string, string[]>();
    let compared = 0;
    let aiCompared = 0;

    for (const url of samples) {
      const browser = await fetchWithChain(url, HEADERS(BROWSER_UA), fetcher);
      if (!browser || browser.status !== 200 || browser.challenge) continue; // baseline unusable
      const gb = await fetchWithChain(url, HEADERS(GOOGLEBOT_SMARTPHONE_UA), fetcher);
      if (gb) {
        compared++;
        if (isBlocked(gb)) gbBlocked.push(`${link(url)}: ${describe(gb)}`);
        else if (gb.status === 200) {
          const d = seoTagDiffs(browser, gb);
          if (d.length) tagDiffs.push(`${link(url)}: ${escapeHtml(d.join('; '))}`);
        }
      }
      if (!opts.robotsAllows) continue;
      let path = '/';
      try {
        const u = new URL(url);
        path = u.pathname + u.search;
      } catch {
        /* keep "/" */
      }
      for (const bot of AI_CRAWLERS) {
        if (!opts.robotsAllows(bot.token, path)) continue; // robots disallows — a block is intended
        const res = await fetchWithChain(url, HEADERS(bot.ua), fetcher);
        if (!res) continue;
        aiCompared++;
        if (isBlocked(res)) {
          const list = aiBlocked.get(bot.token) ?? [];
          list.push(`${link(url)}: ${describe(res)}`);
          aiBlocked.set(bot.token, list);
        }
      }
    }

    const issues: Issue[] = [];
    if (tagDiffs.length) {
      issues.push({
        message: 'Googlebot is served different SEO tags than browsers',
        detail: `With a Googlebot smartphone user agent these pages return different title, canonical or robots directives than with a desktop browser user agent: ${tagDiffs.join(' | ')}. Serving crawlers different SEO signals is cloaking-adjacent and makes indexing unpredictable; serve the same tags to every user agent.`,
        severity: SEVERITY.HIGH,
      });
    }
    if (gbBlocked.length) {
      issues.push({
        message: 'Requests with a Googlebot user agent are blocked',
        detail: `A desktop browser user agent gets HTTP 200, but a Googlebot user agent gets: ${gbBlocked.join(' | ')}. CDNs and firewalls often block spoofed Googlebot requests and verify the real crawler by IP, so this may not affect Google. Confirm with URL Inspection (live test) in Google Search Console.`,
        severity: SEVERITY.LOW,
      });
    }
    if (aiBlocked.size) {
      const parts = [...aiBlocked].map(([bot, urls]) => `<strong>${escapeHtml(bot)}</strong>: ${urls.join(', ')}`);
      issues.push({
        message: 'AI crawlers blocked by firewall despite robots.txt allowing them',
        detail: `robots.txt allows these crawlers, but requests with their user agent are blocked or challenged: ${parts.join(' | ')}. If you want to appear in AI search answers, allow them in your CDN/WAF bot settings. Firewalls may verify the real crawler by IP, so the actual bot can be treated differently from this test.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    const checks: SiteCheckResult[] = [
      {
        id: 'googlebot-parity',
        label: 'Googlebot vs browser response',
        status: compared === 0 ? 'skipped' : tagDiffs.length ? 'fail' : gbBlocked.length ? 'warn' : 'pass',
        note:
          compared === 0
            ? 'no sample URL returned 200 to a browser'
            : `${compared} URL(s) compared${tagDiffs.length ? `, ${tagDiffs.length} differ` : ''}${gbBlocked.length ? `, ${gbBlocked.length} blocked` : ''}`,
      },
      {
        id: 'ai-crawler-access',
        label: 'AI crawler access',
        status: !opts.robotsAllows || aiCompared === 0 ? 'skipped' : aiBlocked.size ? 'fail' : 'pass',
        note: !opts.robotsAllows
          ? 'robots.txt not available'
          : aiCompared === 0
            ? 'no AI crawler allowed by robots.txt or no response'
            : aiBlocked.size
              ? `blocked: ${[...aiBlocked.keys()].join(', ')}`
              : `${AI_CRAWLERS.map((b) => b.token).join(', ')} not blocked`,
      },
    ];
    return { issues, checks };
  }
}
