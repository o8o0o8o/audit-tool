/**
 * Bounded competitor content crawler for Phase 4.
 *
 * Self-contained on purpose: it launches its own Chromium (like the PDF
 * renderer) rather than wiring up the full `CrawlerEngine` (which is coupled to
 * SEOData, callbacks, and all 89 analyzers) because the competitive-gap analysis
 * needs only topic signal — title, headings, and per-page `topKeywords`.
 *
 * Bounds (see `CONTENT_RESEARCH` in constants): ≤ COMPETITOR_MAX_PAGES per
 * competitor, fetched at COMPETITOR_FETCH_CONCURRENCY. URLs are sourced from the
 * competitor's sitemap when available, else a shallow homepage link scrape, and
 * content/editorial paths are prioritised. Every URL passes the SSRF guard.
 */

import { type Browser } from 'playwright';
import { launchChromium, isNoPlaywright } from '../crawler/browser-guard';
import { fetchPageViaHttp } from '../crawler/http-fetch';
import { parse } from 'node-html-parser';
import { CONTENT_RESEARCH, STOP_WORDS } from '../constants';
import { isFetchAllowed } from '../../validators';
import { SitemapParser } from '../parsers/sitemap-parser';
import type { PageInfo } from '../types';
import type { CompetitorProfile } from './types';

export interface TopKeyword {
  word: string;
  count: number;
  density: number;
}

/**
 * Frequency-based top-keyword extraction — the Node-side mirror of the in-page
 * logic in `content-quality-analyzer.ts` (words > 3 chars, stop-word filtered,
 * top 10 by count, density as % of total words). Pure and exported for tests.
 */
export function extractTopKeywords(text: string): TopKeyword[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const freq: Record<string, number> = {};
  for (const w of words) {
    const cw = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cw.length > 3 && !STOP_WORDS.has(cw)) freq[cw] = (freq[cw] || 0) + 1;
  }
  return (Object.entries(freq) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({
      word,
      count,
      density: wordCount > 0 ? Number(((count / wordCount) * 100).toFixed(2)) : 0,
    }));
}

/** Normalise a user/LLM-supplied competitor string to an origin, or null. */
export function normaliseOrigin(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  // Already schemed: accept ONLY http(s) — a non-http scheme (ftp:, mailto:)
  // must be rejected, never coerced into a bogus `https://ftp` host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(`https://${raw}`).origin;
  } catch {
    return null;
  }
}

/** True when a URL's path looks like editorial/content worth prioritising. */
function isContentPath(u: string): boolean {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return CONTENT_RESEARCH.CONTENT_PATH_HINTS.some((h) => p.includes(h));
  } catch {
    return false;
  }
}

/** Content paths first, then everything else; stable within each group. */
function prioritise(urls: string[]): string[] {
  const content = urls.filter(isContentPath);
  const rest = urls.filter((u) => !isContentPath(u));
  return [...content, ...rest];
}

/** Try the competitor's sitemap(s) for a URL list. Returns [] on any failure. */
async function urlsFromSitemap(origin: string, host: string): Promise<string[]> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const sm of candidates) {
    try {
      const result = await SitemapParser.parseSitemaps(origin, [sm]);
      const urls = Object.keys(result.urls ?? {});
      const sameHost = urls.filter((u) => {
        try {
          return new URL(u).host === host;
        } catch {
          return false;
        }
      });
      if (sameHost.length) return sameHost;
    } catch {
      // try next candidate
    }
  }
  return [];
}

/** Shallow fallback: scrape same-origin links off the homepage HTML. */
async function urlsFromHomepage(browser: Browser, origin: string, host: string, timeoutMs: number): Promise<string[]> {
  const context = await browser.newContext();
  try {
    await shimContext(context);
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href),
    );
    const seen = new Set<string>([origin]);
    for (const h of hrefs) {
      try {
        const u = new URL(h);
        if (u.host !== host) continue;
        u.hash = '';
        seen.add(u.toString());
      } catch {
        /* skip */
      }
    }
    return [...seen];
  } catch {
    return [origin];
  } finally {
    await context.close();
  }
}

interface FetchedPage {
  url: string;
  title: string;
  h1: string[];
  h2: string[];
  h3: string[];
  text: string;
}

/**
 * esbuild/tsx compiles this module with `keepNames`, which wraps named inner
 * functions inside `page.evaluate(() => …)` with a `__name(fn, "fn")` helper
 * that does not exist in the browser context (→ `ReferenceError: __name is not
 * defined`). Defining an identity shim before any page script runs makes those
 * calls harmless. Passed as a `content` STRING so it is never itself bundled.
 */
async function shimContext(context: { addInitScript: (s: { content: string }) => Promise<void> }): Promise<void> {
  await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
}

/** Navigate one URL and extract title/headings/main text. Null on failure. */
async function fetchPage(browser: Browser, url: string, timeoutMs: number): Promise<FetchedPage | null> {
  const context = await browser.newContext();
  try {
    await shimContext(context);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const data = await page.evaluate(() => {
      const norm = (s: string | null) => (s || '').replace(/\s+/g, ' ').trim();
      const pick = (sel: string) =>
        Array.from(document.querySelectorAll(sel))
          .map((e) => norm(e.textContent))
          .filter(Boolean);
      const main = document.querySelector('main, article, [role="main"]') ?? document.body;
      const clone = main.cloneNode(true) as Element;
      clone
        .querySelectorAll('script, style, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')
        .forEach((el) => el.remove());
      let text = norm(clone.textContent);
      if (!text) {
        const body = document.body.cloneNode(true) as Element;
        body.querySelectorAll('script, style').forEach((el) => el.remove());
        text = norm(body.textContent);
      }
      return { title: norm(document.title), h1: pick('h1'), h2: pick('h2'), h3: pick('h3'), text };
    });
    return { url, ...data };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/** No-playwright homepage link scrape: fetch + node-html-parser (no browser). */
async function urlsFromHomepageHttp(origin: string, host: string, timeoutMs: number): Promise<string[]> {
  const res = await fetchPageViaHttp(origin, { originHost: host, timeoutMs });
  if (res.status !== 200 || !res.html) return [origin];
  const root = parse(res.html);
  const seen = new Set<string>([origin]);
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    try {
      const u = new URL(href, origin);
      if (u.host !== host) continue;
      u.hash = '';
      seen.add(u.toString());
    } catch {
      /* skip */
    }
  }
  return [...seen];
}

/** No-playwright page fetch: mirrors fetchPage() using fetch + node-html-parser
 *  (same title/headings/main-text extraction, no browser). Null on failure. */
async function fetchPageHttp(url: string, host: string, timeoutMs: number): Promise<FetchedPage | null> {
  const res = await fetchPageViaHttp(url, { originHost: host, timeoutMs });
  if (res.status !== 200 || !res.html) return null;
  const root = parse(res.html);
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const pick = (sel: string) =>
    root
      .querySelectorAll(sel)
      .map((e) => norm(e.text))
      .filter(Boolean);
  // Pick headings from the full document BEFORE stripping chrome for the text body.
  const title = norm(root.querySelector('title')?.text);
  const h1 = pick('h1');
  const h2 = pick('h2');
  const h3 = pick('h3');
  const main =
    root.querySelector('main') ??
    root.querySelector('article') ??
    root.querySelector('[role="main"]') ??
    root.querySelector('body') ??
    root;
  main
    .querySelectorAll('script, style, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')
    .forEach((el) => el.remove());
  let text = norm(main.text);
  if (!text) {
    const body = root.querySelector('body');
    if (body) {
      body.querySelectorAll('script, style').forEach((el) => el.remove());
      text = norm(body.text);
    }
  }
  return { url, title, h1, h2, h3, text };
}

/** Build a minimal PageInfo carrying the topic signal the gap analyzer reads. */
function toPageInfo(fp: FetchedPage): PageInfo {
  const wordCount = fp.text ? fp.text.split(/\s+/).filter(Boolean).length : 0;
  const page = {
    url: fp.url,
    status: 200,
    statusCode: 200,
    title: fp.title,
    headings: {
      h1: fp.h1,
      h2: fp.h2,
      h3: fp.h3,
      h1Count: fp.h1.length,
      h2Count: fp.h2.length,
      h3Count: fp.h3.length,
      issues: [],
    },
    contentQuality: {
      wordCount,
      topKeywords: extractTopKeywords(fp.text),
    },
  };
  return page as unknown as PageInfo;
}

/** Run `tasks` with a bounded concurrency pool, preserving input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Crawl one competitor: resolve a bounded, content-prioritised URL set, fetch
 * each page, and reduce to topic signal. Never throws — returns a profile with
 * an `error` string when the site is unreachable.
 */
export async function crawlCompetitor(originInput: string, opts: { verbose?: boolean } = {}): Promise<CompetitorProfile> {
  const origin = normaliseOrigin(originInput);
  if (!origin) {
    return { origin: originInput, host: originInput, pagesCrawled: 0, pagesAttempted: 0, pages: {}, discovered: false, error: 'invalid URL' };
  }
  const host = new URL(origin).host;
  const gate = isFetchAllowed(origin);
  if (!gate.allowed) {
    return { origin, host, pagesCrawled: 0, pagesAttempted: 0, pages: {}, discovered: false, error: `blocked: ${gate.reason}` };
  }

  const timeoutMs = CONTENT_RESEARCH.COMPETITOR_PAGE_TIMEOUT_MS;
  // No-playwright mode: crawl competitors over plain HTTP (no browser launched).
  const noPw = isNoPlaywright();
  // Launch INSIDE the try so a browser failure (e.g. missing binary) degrades
  // to a per-competitor error rather than aborting the whole phase.
  let browser: Browser | null = null;
  try {
    if (!noPw) browser = await launchChromium(undefined, 'competitor-crawl');
    const b = browser as Browser; // non-null binding for the browser path's closures
    let urls = await urlsFromSitemap(origin, host);
    if (!urls.length) {
      if (opts.verbose) console.log(`   ${host}: no sitemap, scraping homepage links`);
      urls = noPw ? await urlsFromHomepageHttp(origin, host, timeoutMs) : await urlsFromHomepage(b, origin, host, timeoutMs);
    }
    // SSRF re-check every candidate, prioritise content, cap.
    const safe = urls.filter((u) => isFetchAllowed(u, { originHost: host }).allowed);
    const selected = prioritise([...new Set(safe)]).slice(0, CONTENT_RESEARCH.COMPETITOR_MAX_PAGES);
    if (urls.length > selected.length && opts.verbose) {
      console.log(`   ${host}: capping ${urls.length} candidate URLs to ${selected.length}`);
    }

    const fetched = await pool(selected, CONTENT_RESEARCH.COMPETITOR_FETCH_CONCURRENCY, (u) =>
      noPw ? fetchPageHttp(u, host, timeoutMs) : fetchPage(b, u, timeoutMs),
    );
    const pages: Record<string, PageInfo> = {};
    for (const fp of fetched) {
      if (fp && fp.text) pages[fp.url] = toPageInfo(fp);
    }
    const pagesCrawled = Object.keys(pages).length;
    if (opts.verbose) console.log(`   ${host}: ${pagesCrawled}/${selected.length} pages with content`);
    return {
      origin,
      host,
      pagesCrawled,
      pagesAttempted: selected.length,
      pages,
      discovered: false,
      error: pagesCrawled === 0 ? 'no content pages crawled' : undefined,
    };
  } catch (e: unknown) {
    return { origin, host, pagesCrawled: 0, pagesAttempted: 0, pages: {}, discovered: false, error: (e as Error).message };
  } finally {
    if (browser) await browser.close();
  }
}
