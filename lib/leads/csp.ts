/**
 * Reads a Content Security Policy the way a browser does, far enough to answer one question: does
 * the policy the server sends allow the page to load this address? Used by the truth gate to confirm,
 * from the response header alone, a block that the scan's browser reported.
 *
 * Source lists only: a policy that relies on `'strict-dynamic'` decides by nonce and by which script
 * loaded which, and that cannot be read from a header, so `allows` answers `null` (unknown) there.
 */

export type Policy = Map<string, string[]>;

/** One policy string → its directives. A header that carries several policies is split by the caller. */
export function parsePolicy(policy: string): Policy {
  const out: Policy = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** Attribute text as the browser reads it: `&#x27;self&#x27;` is `'self'`. Decoded before the policy is split at `;`. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Enforced policies of a response: every `Content-Security-Policy` header value, comma-separated ones split. */
export function enforcedPolicies(headers: Record<string, string>, html = ''): Policy[] {
  const values = (headers['content-security-policy'] ?? '')
    .split(/,(?=\s*[a-z-]+\s)/i)
    .map((v) => v.trim())
    .filter(Boolean);
  for (const tag of html.match(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi) ?? []) {
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) values.push(decodeEntities(value));
  }
  return values.map(parsePolicy);
}

const FALLBACK: Record<string, string[]> = {
  'script-src-elem': ['script-src', 'default-src'],
  'script-src-attr': ['script-src', 'default-src'],
  'script-src': ['default-src'],
  'style-src-elem': ['style-src', 'default-src'],
  'style-src-attr': ['style-src', 'default-src'],
  'style-src': ['default-src'],
  'connect-src': ['default-src'],
  'img-src': ['default-src'],
  'font-src': ['default-src'],
  'media-src': ['default-src'],
  'frame-src': ['child-src', 'default-src'],
  'child-src': ['default-src'],
  'worker-src': ['child-src', 'script-src', 'default-src'],
  'manifest-src': ['default-src'],
  'object-src': ['default-src'],
};

/** The directive that governs `name` in this policy, after fallbacks; null when the policy says nothing about it. */
export function governing(policy: Policy, name: string): { directive: string; sources: string[] } | null {
  for (const directive of [name, ...(FALLBACK[name] ?? [])]) {
    const sources = policy.get(directive);
    if (sources) return { directive, sources };
  }
  return null;
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

/** One source expression against a URL. */
function sourceAllows(source: string, target: URL, self: URL): boolean {
  const s = source.toLowerCase();
  if (s === "'none'") return false;
  if (s === '*') return /^https?:$/.test(target.protocol) || target.protocol === self.protocol;
  if (s === "'self'") return target.origin === self.origin;
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return target.protocol === s;
  if (s.startsWith("'")) return false; // nonces, hashes and keywords do not allow a host
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  if (scheme ? `${scheme}:` !== target.protocol : !/^https?:$/.test(target.protocol)) return false;
  if (!hostMatches(host!, target.hostname.toLowerCase())) return false;
  if (port && port !== '*' && port !== (target.port || (target.protocol === 'https:' ? '443' : '80'))) return false;
  if (path && path !== '/') {
    const p = target.pathname;
    return path.endsWith('/') ? p.startsWith(path) : p === path;
  }
  return true;
}

/**
 * Whether one policy allows the page at `selfUrl` to load `targetUrl` under `directive`.
 * `true` / `false`, or `null` when the header cannot settle it (no such directive: nothing is
 * restricted, so that is `true`; `'strict-dynamic'`: unknown).
 */
export function allows(policy: Policy, directive: string, targetUrl: string, selfUrl: string): boolean | null {
  const rule = governing(policy, directive);
  if (!rule) return true;
  if (/^script-src/.test(rule.directive) && rule.sources.some((s) => s.toLowerCase() === "'strict-dynamic'")) {
    return null;
  }
  let target: URL;
  let self: URL;
  try {
    target = new URL(targetUrl);
    self = new URL(selfUrl);
  } catch {
    return null;
  }
  return rule.sources.some((s) => sourceAllows(s, target, self));
}

/** Tags whose silent failure costs a marketing team its data: the host, and how a teaser names the tag. */
const VENDORS: Array<[RegExp, string]> = [
  [/(^|\.)bat\.bing\.(com|net)$/, 'the Microsoft Advertising (Bing Ads) tag'],
  [/(^|\.)clarity\.ms$/, 'Microsoft Clarity'],
  [/(^|\.)(google-analytics\.com|analytics\.google\.com)$/, 'Google Analytics'],
  [/(^|\.)googletagmanager\.com$/, 'Google Tag Manager'],
  [/(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com)$/, 'Google Ads'],
  [/(^|\.)(connect\.facebook\.net|facebook\.com)$/, 'the Meta (Facebook) pixel'],
  [/(^|\.)analytics\.tiktok\.com$/, 'the TikTok pixel'],
  [/(^|\.)(snap\.licdn\.com|px\.ads\.linkedin\.com)$/, 'the LinkedIn Insight tag'],
  [/(^|\.)(ct\.pinterest\.com|s\.pinimg\.com)$/, 'the Pinterest tag'],
  [/(^|\.)(sc-static\.net|tr\.snapchat\.com)$/, 'the Snapchat pixel'],
  [/(^|\.)(hotjar\.com|hotjar\.io)$/, 'Hotjar'],
  [/(^|\.)(hs-scripts\.com|hs-analytics\.net|hsforms\.net|hubspot\.com)$/, 'HubSpot'],
  [/(^|\.)klaviyo\.com$/, 'Klaviyo'],
  [/(^|\.)(segment\.com|segment\.io)$/, 'Segment'],
  [/(^|\.)criteo\.(com|net)$/, 'the Criteo tag'],
  [/(^|\.)(ads-twitter\.com|t\.co)$/, 'the X (Twitter) pixel'],
  [/(^|\.)redditstatic\.com$/, 'the Reddit pixel'],
  [/(^|\.)(mxpnl\.com|mixpanel\.com)$/, 'Mixpanel'],
  [/(^|\.)amplitude\.com$/, 'Amplitude'],
];

/** How a teaser names what sits at this address, or null when it is not a tag we know. */
export function vendorOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VENDORS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}
