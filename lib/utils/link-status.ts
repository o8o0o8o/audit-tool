/**
 * Classifying the HTTP status of an external link check. Many sites answer automated requests
 * with 403/429/999 (bot protection, Cloudflare challenges, LinkedIn) or reject HEAD with
 * 405/501, while the page opens fine for a visitor. Only answers that say the page is gone count
 * as broken; the rest are "blocked" (unverified).
 */

/** Browser-like headers for link checks: a bot user agent is refused far more often. */
export const LINK_CHECK_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export type LinkVerdict = 'ok' | 'dead' | 'blocked' | 'unknown';

/** Status codes that mean "this URL does not exist". */
const DEAD_STATUSES = new Set([404, 410]);

/**
 * Verdict for a final status (after the GET retry). 404/410 and persistent 5xx are dead;
 * other 4xx (401/403/405/419/429/451, LinkedIn's 999, …) mean the check was refused.
 */
export function classifyLinkStatus(status: number | null | undefined): LinkVerdict {
  if (!status) return 'unknown';
  if (status < 400) return 'ok';
  if (DEAD_STATUSES.has(status)) return 'dead';
  if (status >= 500 && status < 600) return 'dead';
  return 'blocked';
}

/** HEAD answers that must be retried with GET before trusting them (HEAD is often unsupported). */
export function needsGetRetry(headStatus: number | null | undefined): boolean {
  return !!headStatus && headStatus >= 400;
}

/** Remove the fragment: `page#a` and `page#b` are one link to check. */
export function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}
