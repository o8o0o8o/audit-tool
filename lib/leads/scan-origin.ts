/**
 * Which origin a lead scan starts from. The fingerprint's landing page is usually right (it has the
 * www host and https), but a site can send a visitor off to another of its subdomains: gymshark.com
 * redirects to its checkout host, a store redirects by country. The scan should cover the site the
 * company runs at its main address, so in that case the www host is tried first.
 */

import { isChallengeResponse } from '../utils/blocked-fetch';
import { LINK_CHECK_HEADERS } from '../utils/link-status';

/** What a request to the main host returned: the status and the host it ended on after redirects. */
export interface MainHostProbe {
  status: number;
  finalHost: string;
  challenge: boolean;
}

export type MainHostProber = (url: string) => Promise<MainHostProbe | null>;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The site's main hosts: the listed domain and its www host. */
export function mainHosts(domain: string): string[] {
  const bare = domain.toLowerCase().replace(/^www\./, '');
  return [bare, `www.${bare}`];
}

/**
 * The origin to scan.
 *  - No fingerprint landing page, or it landed on another site: the listed website.
 *  - Landed on the domain or its www host: that origin.
 *  - Landed on another subdomain: `https://www.<domain>` when it serves a page there itself (2xx, no
 *    bot challenge, no redirect away); otherwise the landing origin. A refused request proves nothing,
 *    so it never replaces where a browser actually landed.
 */
export async function chooseScanOrigin(
  domain: string,
  listedOrigin: string,
  landing: { finalUrl?: string | null; redirectedTo?: string | null } | null,
  probe: MainHostProber = probeMainHost,
): Promise<{ origin: string; note: string | null }> {
  if (!landing?.finalUrl || landing.redirectedTo) return { origin: listedOrigin, note: null };
  const landedHost = hostOf(landing.finalUrl);
  if (!landedHost) return { origin: listedOrigin, note: null };
  const landedOrigin = new URL(landing.finalUrl).origin;
  const main = mainHosts(domain);
  if (main.includes(landedHost)) return { origin: landedOrigin, note: null };

  const www = `https://${main[1]}`;
  const result = await probe(www).catch(() => null);
  if (result && result.status >= 200 && result.status < 300 && !result.challenge && main.includes(result.finalHost)) {
    return {
      origin: `https://${result.finalHost}`,
      note: `the homepage sent the fingerprint to ${landedHost}; ${result.finalHost} serves the site itself`,
    };
  }
  const why = !result
    ? 'could not be reached'
    : result.challenge || [401, 403, 429, 503].includes(result.status)
      ? `refused the request (${result.status})`
      : !main.includes(result.finalHost)
        ? `redirects to ${result.finalHost} too`
        : `returned ${result.status}`;
  return {
    origin: landedOrigin,
    note: `${main[1]} ${why}, so the scan starts where the browser landed (${landedHost})`,
  };
}

export async function probeMainHost(url: string): Promise<MainHostProbe | null> {
  try {
    const res = await fetch(url, {
      headers: LINK_CHECK_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => undefined);
    const finalHost = hostOf(res.url) ?? '';
    return { status: res.status, finalHost, challenge: isChallengeResponse(res.status, res.headers) };
  } catch {
    return null;
  }
}
