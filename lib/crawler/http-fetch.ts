/**
 * Plain-HTTP page fetch for `--no-playwright` mode.
 *
 * Acquires a page over the network WITHOUT launching Chromium: Node's global
 * `fetch` (undici) with manual redirect following so the redirect chain is
 * captured in the same `{ url, status }` shape the browser crawl records. The
 * returned data is enough to build `PageInfo` (status, response headers, redirect
 * chain) plus the HTML string that `parse()` (node-html-parser) turns into the
 * same `parsedPage` the analyzers already accept.
 *
 * What it deliberately does NOT provide (browser-only, absent in this mode):
 * per-subresource network log, vitals/metrics, CDP coverage, screenshots.
 *
 * SSRF: every hop (initial URL + each redirect target) is gated through
 * `validators.isFetchAllowed`, matching the crawler/sitemap/robots/phase3 sinks.
 * gzip/br: global `fetch` transparently decodes `content-encoding`, so no manual
 * decompression is needed. Non-HTML or non-2xx responses return `html: ''` so the
 * caller records the status/headers but never feeds a non-HTML/error body to the
 * HTML parser.
 */

import { DEFAULT_USER_AGENT, THRESHOLDS } from '../constants';
import { isFetchAllowed } from '../../validators';
import { readResponseTextCapped } from '../utils';

/** Hard cap on the HTML body read — bounds memory on a pathological/huge/slow
 *  body (the sibling robots/sitemap sinks cap the same way). Generous vs. the
 *  PAGE_SIZE finding threshold so normal pages are never truncated. */
const MAX_HTML_BYTES = 25_000_000;

export interface HttpFetchResult {
  /** Final HTTP status (of the last hop). 0 on network error / SSRF block. */
  status: number;
  /** Lowercased response headers of the final document. */
  headers: Record<string, string>;
  /** Decoded HTML body — '' for non-HTML content-types, non-2xx, or errors. */
  html: string;
  /** Redirect chain in the crawler's shape; empty when there were no redirects. */
  redirectChain: Array<{ url: string; status: number | string }>;
  /** The URL of the final hop (after redirects). */
  finalUrl: string;
  /** Lowercased content-type of the final response (sans parameters), or ''. */
  contentType: string;
  /** Populated when the fetch could not complete (network error / SSRF block). */
  error?: string;
}

const MAX_REDIRECTS = 10;
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Fetch a page over plain HTTP, following redirects manually and SSRF-gating
 * every hop. Never throws — network/SSRF failures resolve to a result with
 * `status: 0`, `html: ''`, and an `error` message so the caller can record a
 * failed page rather than aborting the crawl.
 *
 * @param url - the URL to fetch (already normalized by the caller).
 * @param options - userAgent / extra headers / origin host (for the SSRF
 *   same-host allowance) / timeout override.
 */
export async function fetchPageViaHttp(
  url: string,
  options: {
    userAgent?: string | null;
    headers?: Record<string, string> | null;
    originHost?: string;
    timeoutMs?: number;
  } = {},
): Promise<HttpFetchResult> {
  const timeoutMs = options.timeoutMs ?? THRESHOLDS.PAGE_TIMEOUT;
  const baseHeaders: Record<string, string> = {
    'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
    ...(options.headers ?? {}),
  };

  const redirectChain: Array<{ url: string; status: number | string }> = [];
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const gate = isFetchAllowed(currentUrl, { originHost: options.originHost });
    if (!gate.allowed) {
      return {
        status: 0,
        headers: {},
        html: '',
        redirectChain,
        finalUrl: currentUrl,
        contentType: '',
        error: `SSRF-blocked: ${gate.reason}`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: baseHeaders,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      return {
        status: 0,
        headers: {},
        html: '',
        redirectChain,
        finalUrl: currentUrl,
        contentType: '',
        error: (err as Error)?.message ?? 'fetch failed',
      };
    }
    // NB: the abort timer is intentionally NOT cleared here — it must also bound
    // the terminal body read below (undici's fetch() resolves at headers, so a
    // slow-drip body would otherwise be untimed). It is cleared per-branch.
    const status = res.status;
    // Redirect? (fetch with redirect:'manual' yields status 3xx + Location)
    const location = res.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      clearTimeout(timer);
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        // Malformed Location — stop and report the redirect as terminal.
        redirectChain.push({ url: currentUrl, status });
        return { status, headers: lowerHeaders(res.headers), html: '', redirectChain, finalUrl: currentUrl, contentType: '' };
      }
      redirectChain.push({ url: currentUrl, status });
      currentUrl = nextUrl;
      // Cancel the body to free the socket.
      await res.body?.cancel?.().catch(() => undefined);
      continue;
    }

    // Terminal response. If we followed any redirects, append the final hop.
    if (redirectChain.length > 0) redirectChain.push({ url: currentUrl, status });

    const headers = lowerHeaders(res.headers);
    const contentType = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const isHtml = HTML_TYPES.includes(contentType) || contentType === '';
    let html = '';
    try {
      if (status >= 200 && status < 300 && isHtml) {
        // Size-capped, streaming read (bounds memory) with the abort timer still
        // armed (bounds time). Matches the robots/sitemap capped-read sinks.
        html = await readResponseTextCapped(res, MAX_HTML_BYTES);
      } else {
        await res.body?.cancel?.().catch(() => undefined);
      }
    } catch {
      html = '';
    } finally {
      clearTimeout(timer);
    }

    return { status, headers, html, redirectChain, finalUrl: currentUrl, contentType };
  }

  // Exceeded redirect budget.
  return {
    status: 0,
    headers: {},
    html: '',
    redirectChain,
    finalUrl: currentUrl,
    contentType: '',
    error: `too many redirects (>${MAX_REDIRECTS})`,
  };
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
