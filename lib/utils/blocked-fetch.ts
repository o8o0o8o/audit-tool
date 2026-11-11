/**
 * Helpers for diagnosing and surviving a site that blocks the crawler
 * (rate limits, bot protection / JS challenges). Pure apart from the
 * injectable sleep, so they are unit-testable without a browser or network.
 */

import { THRESHOLDS } from '../constants';

/** Minimal header accessor shared by fetch `Headers` and Playwright `response.headers()`. */
export type HeaderSource = { get(name: string): string | null } | Record<string, string | undefined>;

function header(headers: HeaderSource | null | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const rec = headers as Record<string, string | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key !== undefined ? (rec[key] ?? null) : null;
}

const BODY_HEAD_CHARS = 200;
const DIAGNOSTIC_HEADERS = ['server', 'retry-after', 'cf-ray', 'x-vercel-id'] as const;

/** One log line describing a non-200 response: status, the headers that reveal who blocked it, and the body head. */
export function describeBlockedResponse(
  status: number | null | undefined,
  headers: HeaderSource | null | undefined,
  bodyHead = '',
  url?: string,
): string {
  const parts = [`HTTP ${status ?? 'unknown'}${url ? ` for ${url}` : ''}`];
  for (const name of DIAGNOSTIC_HEADERS) {
    parts.push(`${name}=${header(headers, name) ?? '-'}`);
  }
  const body = bodyHead.replace(/\s+/g, ' ').trim().slice(0, BODY_HEAD_CHARS);
  parts.push(`body="${body}"`);
  return parts.join(' ');
}

/** Retry-After (delta-seconds or HTTP-date) → ms, clamped to the max; absent/0/negative/garbage → default. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number {
  const fallback = THRESHOLDS.RETRY_AFTER_DEFAULT_MS;
  if (!value) return fallback;
  const trimmed = value.trim();
  let ms: number;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return fallback;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(ms, THRESHOLDS.RETRY_AFTER_MAX_MS);
}

/** True when the response headers show a bot-protection JS challenge rather than a plain error. */
export function isChallengeResponse(status: number | null | undefined, headers: HeaderSource | null | undefined): boolean {
  if (header(headers, 'cf-mitigated')?.toLowerCase() === 'challenge') return true;
  if (header(headers, 'x-vercel-mitigated')) return true;
  const server = header(headers, 'server')?.toLowerCase() ?? '';
  const blockingStatus = status === 403 || status === 429 || status === 503;
  return blockingStatus && (server.includes('cloudflare') || server.includes('vercel'));
}

export interface RetryableResponse {
  status: number;
  headers: HeaderSource;
}

export interface FetchWithRetryOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  onRetry?: (attempt: number, waitMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Call `doFetch`, retrying only on 429 after the (clamped) Retry-After, at most `maxRetries` times. */
export async function fetchWithRetryAfter<T extends RetryableResponse>(
  doFetch: () => Promise<T>,
  options: FetchWithRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? THRESHOLDS.RETRY_AFTER_MAX_RETRIES;
  let response = await doFetch();
  for (let attempt = 1; attempt <= maxRetries && response.status === 429; attempt++) {
    const waitMs = parseRetryAfter(header(response.headers, 'retry-after'));
    options.onRetry?.(attempt, waitMs);
    await sleep(waitMs);
    response = await doFetch();
  }
  return response;
}

export interface MainFrameResponse {
  status: number;
  headers: HeaderSource;
}

/**
 * Status to record for a navigation: the first main-frame response, unless it is a
 * bot challenge, in which case the last main-frame response (the page the challenge
 * navigated on to). A challenge that never cleared keeps its own status.
 */
export function pickFinalMainFrameStatus(responses: readonly MainFrameResponse[]): number | null {
  const first = responses[0];
  if (!first) return null;
  if (!isChallengeResponse(first.status, first.headers)) return first.status;
  return responses[responses.length - 1]!.status;
}

/** byError key for a page whose final response was still a challenge (so a challenge 503 differs from a plain 503). */
export function challengeErrorKey(status: number): string {
  return `challenge-${status}`;
}

const BLOCKED_ERROR_KEYS = new Set(['429', '403', challengeErrorKey(429), challengeErrorKey(403), challengeErrorKey(503)]);

export interface CrawlerBlockedInput {
  byError?: Record<string, unknown> | null;
  totalWithoutError?: number | null;
}

export interface CrawlerBlockedResult {
  blocked: boolean;
  pages: number;
}

/** Every page fetch got 429/403/challenge-503 — the site blocked the crawler. A partial block is not reported. */
export function detectCrawlerBlocked(input: CrawlerBlockedInput | null | undefined): CrawlerBlockedResult {
  const byError = input?.byError ?? {};
  if ((input?.totalWithoutError ?? 0) > 0) return { blocked: false, pages: 0 };
  let blockedPages = 0;
  for (const [key, value] of Object.entries(byError)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    if (!BLOCKED_ERROR_KEYS.has(key)) return { blocked: false, pages: 0 };
    blockedPages += value.length;
  }
  return blockedPages > 0 ? { blocked: true, pages: blockedPages } : { blocked: false, pages: 0 };
}

/** One-sentence explanation of a blocked crawl, shared by the HTML and Phase 2 reports. */
export function crawlerBlockedMessage(pages: number): string {
  return `The site blocked the crawler (HTTP 429/403 or a bot challenge on every request) — this audit covers only ${pages} page${pages === 1 ? '' : 's'}.`;
}
