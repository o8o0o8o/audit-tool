/**
 * Analytics and advertising cookies by name, with the service that sets them. Deliberately narrow:
 * only cookies that exist to measure or follow a visitor. Session, load-balancer, consent, A/B-test
 * and security cookies are not on the list, so a site is never told it tracks when it does not.
 * Used by the scan's candidate and by the gate's fresh-browser re-check alike.
 */

const RULES: Array<[RegExp, string]> = [
  [/^_ga(?:_[A-Z0-9]+)?$/, 'Google Analytics'],
  [/^_gid$/, 'Google Analytics'],
  [/^_gat(?:_|$)/, 'Google Analytics'],
  [/^__utm[abcz]$/, 'Google Analytics'],
  [/^_gcl_(?:au|aw|dc|gb|gs|ha)$/, 'Google Ads'],
  [/^IDE$/, 'Google Ads'],
  [/^_fb[pc]$/, 'Meta'],
  [/^_hj(?:Session|SessionUser|id|FirstSeen)(?:_\d+)?$/, 'Hotjar'],
  [/^_cl(?:ck|sk)$/, 'Microsoft Clarity'],
  [/^_uet(?:sid|vid)$/, 'Microsoft Advertising'],
  [/^_ttp$/, 'TikTok'],
  [/^_pin_unauth$/, 'Pinterest'],
  [/^(?:hubspotutk|__hstc|__hssc)$/, 'HubSpot'],
  [/^_scid$/, 'Snapchat'],
  [/^li_fat_id$/, 'LinkedIn'],
  [/^_rdt_uuid$/, 'Reddit'],
  [/^ajs_anonymous_id$/, 'Segment'],
  [/^mp_[0-9a-f]+_mixpanel$/, 'Mixpanel'],
  [/^AMP_[0-9a-f]+$/i, 'Amplitude'],
];

/** The service behind an analytics or advertising cookie, or null for any other cookie. */
export function trackingVendor(name: string): string | null {
  return RULES.find(([re]) => re.test(name))?.[1] ?? null;
}

export interface TrackingCookie {
  name: string;
  vendor: string;
}

/** The tracking cookies among `names`, deduplicated, in the order given. */
export function trackingCookies(names: Iterable<string>): TrackingCookie[] {
  const out = new Map<string, TrackingCookie>();
  for (const name of names) {
    const vendor = trackingVendor(name);
    if (vendor && !out.has(name)) out.set(name, { name, vendor });
  }
  return [...out.values()];
}

/**
 * `Google Ads (_gcl_au), Google Analytics (_ga, _ga_2S6SQZ66CV) and Meta (_fbp)`: per service, at most
 * three cookie names, at most four services (`and N more services` beyond that).
 */
export function describeTrackingCookies(cookies: TrackingCookie[]): string {
  const perVendor = new Map<string, string[]>();
  for (const c of cookies) perVendor.set(c.vendor, [...(perVendor.get(c.vendor) ?? []), c.name]);
  const all = [...perVendor.entries()].map(([vendor, names]) => `${vendor} (${names.slice(0, 3).join(', ')})`);
  const parts = all.slice(0, 4);
  if (all.length > 4) parts.push(`${all.length - 4} more service${all.length - 4 === 1 ? '' : 's'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}
