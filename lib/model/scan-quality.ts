/**
 * Scan quality (design §8.10): one function owns the thresholds.
 * blocked: the homepage (single page: the page) was not read, or ≥ 50 % of requested pages were
 * blocked or challenged. partial: 10–50 % blocked, or site probes refused.
 */
import type { ScanQuality } from './site';

export const BLOCKED_SHARE = 0.5;
export const PARTIAL_SHARE = 0.1;

/** byError keys that mean the site refused us (not that the page is broken). */
export const BLOCKED_ERROR_KEYS = new Set([
  '401',
  '403',
  '429',
  'challenge-401',
  'challenge-403',
  'challenge-429',
  'challenge-503',
]);

export interface ScanQualityInput {
  /** The URL that must be readable: the homepage, or the page of a single-page audit. */
  keyUrl: string;
  pages: Array<{ url: string; finalUrl?: string | null; status?: number | null; redirectOnly?: boolean }>;
  byError: Record<string, unknown>;
  sitemapTotal: number | null;
  sitemapCrawled: number | null;
  probesBlocked: number;
  botProtection: string | null;
}

const norm = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return u;
  }
};

export function computeScanQuality(input: ScanQualityInput): ScanQuality & { blockedUrls: Set<string> } {
  const blockedUrls = new Set<string>();
  const errorsByType: Record<string, number> = {};
  let failed = 0;
  for (const [key, value] of Object.entries(input.byError ?? {})) {
    const urls = Array.isArray(value) ? (value as unknown[]).filter((u): u is string => typeof u === 'string') : [];
    if (!urls.length) continue;
    errorsByType[key] = urls.length;
    if (BLOCKED_ERROR_KEYS.has(key)) urls.forEach((u) => blockedUrls.add(u));
    else failed += urls.length;
  }
  const okPages = input.pages.filter(
    (p) => !p.redirectOnly && !blockedUrls.has(p.url) && (p.status ?? 200) >= 200 && (p.status ?? 200) < 300,
  );
  for (const p of input.pages) if (p.status && BLOCKED_ERROR_KEYS.has(String(p.status))) blockedUrls.add(p.url);
  const blocked = blockedUrls.size;
  const requested = okPages.length + blocked + failed;
  const key = norm(input.keyUrl);
  const homepageRead = okPages.some((p) => norm(p.url) === key || (p.finalUrl ? norm(p.finalUrl) === key : false));
  const share = requested ? blocked / requested : 0;
  const reasons: string[] = [];
  let state: ScanQuality['state'] = 'ok';
  if (!homepageRead) reasons.push('the homepage could not be read');
  if (share >= BLOCKED_SHARE) reasons.push(`${blocked} of ${requested} pages were blocked or challenged`);
  if (!homepageRead || share >= BLOCKED_SHARE) state = 'blocked';
  else {
    if (share >= PARTIAL_SHARE) reasons.push(`${blocked} of ${requested} pages were blocked or challenged`);
    if (input.probesBlocked > 0) reasons.push(`${input.probesBlocked} site check(s) were refused`);
    if (reasons.length) state = 'partial';
  }
  return {
    state,
    reasons,
    homepageRead,
    pagesRequested: requested,
    pagesOk: okPages.length,
    pagesBlocked: blocked,
    pagesFailed: failed,
    errorsByType,
    botProtection: blocked > 0 ? input.botProtection : null,
    sitemapTotal: input.sitemapTotal,
    sitemapCrawled: input.sitemapCrawled,
    probesBlocked: input.probesBlocked,
    blockedUrls,
  };
}
