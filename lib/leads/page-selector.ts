/**
 * Page selection for a lead scan: which pages to load when the whole scan may load only a few.
 *
 * The first N sitemap URLs (what `--limit` does) are often N posts of one blog. A lead scan wants the
 * pages a visitor and a buyer see: the homepage, what its navigation links to, and one page of each
 * template. Pure: the homepage is crawled first by the caller, and its links are passed in.
 *
 * robots.txt `Disallow` rules for `*` are honoured: a disallowed URL is never selected.
 */

import { LANG_CODES } from '../orchestrators/language-pattern-detector';
import type { LinkPosition } from '../analyzers/site-wide/crawl-graph-checks';

export interface HomeLink {
  url: string;
  position?: LinkPosition;
}

export type SelectionReason = 'homepage' | 'navigation' | 'language' | 'money' | 'template' | 'fill';

export interface SelectedPage {
  url: string;
  reason: SelectionReason;
  /** Template key, e.g. `/blog/*`; a leading language segment is not part of it. */
  template: string;
}

export interface SelectInput {
  /** The homepage URL as crawled. Always first in the result. */
  home: string;
  /** Internal links found on the homepage, in document order. */
  homeLinks: HomeLink[];
  sitemapUrls: string[];
  /** Total pages, the homepage included. */
  cap: number;
  /** robots.txt check for a URL path; omitted means everything is allowed. */
  isAllowed?: (path: string) => boolean;
  /** Seed for the sample taken inside a selling template; defaults to the homepage's host, so a rescan picks the same pages. */
  seed?: string;
}

export interface Selection {
  selected: SelectedPage[];
  /** Candidate URLs left out because robots.txt disallows them. */
  disallowed: string[];
  /** Language codes seen in URL prefixes, the homepage's own first. */
  languages: string[];
}

const LANG_SEGMENT = /^([a-z]{2})(?:[-_][a-z]{2,4})?$/i;

/** `/de/…`, `/en-us/…`, `/pt_BR/…` → the language code; null when the first segment is not a language. */
export function languagePrefix(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0];
  const m = first ? LANG_SEGMENT.exec(first) : null;
  return m && LANG_CODES.has(m[1].toLowerCase()) ? first.toLowerCase() : null;
}

function pathSegments(pathname: string): string[] {
  const segments = pathname.split('/').filter(Boolean);
  return languagePrefix(pathname) ? segments.slice(1) : segments;
}

/**
 * The template a URL belongs to, with a leading language segment ignored:
 * `/` → `/`, `/pricing` → `/pricing`, `/blog/post` and `/en/blog/2024/x` → `/blog/*`.
 */
export function templateKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = pathSegments(parsed.pathname);
  if (segments.length === 0) return '/';
  if (segments.length === 1) return `/${segments[0].toLowerCase()}`;
  return `/${segments[0].toLowerCase()}/*`;
}

/** Pages a visitor rarely judges a site by; they are taken last. */
const UTILITY_PATH =
  /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|account|cart|basket|checkout|search|privacy|terms|legal|cookies?|imprint|impressum|sitemap|feed|rss|wp-admin|wp-login|cdn-cgi|unsubscribe|password)(?:[/._-]|$)/i;

/**
 * Pages where the site sells or takes a lead: products, shop listings, prices, booking, contact and
 * demo forms. A defect there costs money, so these templates are scanned first and with more than
 * one page each. Matched on a whole path segment, in the languages the prospect list covers.
 */
const MONEY_PATH =
  /\/(?:products?|produkte?|produits?|productos?|prodotti|producten|p|pd|pdp|shop|store|boutique|tienda|collections?|catalog(?:ue)?|categor(?:y|ies)|kategorie|pricing|prices?|preise|tarifs?|precios|prezzi|plans?|buy|kaufen|order|book(?:ing)?|buchen|reserv(?:e|ation)s?|demo|request-demo|contact(?:-us|-sales)?|kontakt|contacto|quote|get-started|trial|free-trial)(?:[/._-]|$)/i;

/** Pages that say little about how the site sells; they are taken after everything else but utility pages. */
const LOW_VALUE_PATH =
  /\/(?:careers?|jobs?|karriere|stellenangebote|emploi|press|presse|newsroom|media|investors?|investor-relations|ir|sustainability|esg|events?|webinars?|glossary|authors?|tags?)(?:[/._-]|$)/i;

/** Most pages loaded from one selling template, and the share of the scan all selling templates may take. */
const MONEY_PER_TEMPLATE = 3;
const MONEY_SHARE = 0.4;

/** Small seeded generator (mulberry32): the sample is random over the template, and the same on a rescan. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in random order (Fisher–Yates with the seeded generator). */
function shuffled<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** True for a selling page: product, listing, price, booking, contact or demo. */
export function isMoneyPath(pathname: string): boolean {
  return MONEY_PATH.test(pathname);
}

const NON_PAGE =
  /\.(?:pdf|zip|gz|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|css|js|json|xml|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf|eot)$/i;

/** Same page whatever the `www.`, trailing slash or letter case; the query string keeps pages apart. */
const comparisonKey = (url: URL) =>
  `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();

interface Candidate {
  url: string;
  parsed: URL;
  key: string;
  template: string;
  language: string | null;
  position?: LinkPosition;
  fromHome: boolean;
  utility: boolean;
  money: boolean;
  lowValue: boolean;
  order: number;
}

export function selectLeadPages(input: SelectInput): Selection {
  const cap = Math.max(1, Math.floor(input.cap));
  let home: URL;
  try {
    home = new URL(input.home);
  } catch {
    return { selected: [], disallowed: [], languages: [] };
  }
  const homeKey = comparisonKey(home);
  const homeLanguage = languagePrefix(home.pathname);
  const sameHost = (u: URL) => u.hostname.replace(/^www\./, '') === home.hostname.replace(/^www\./, '');

  const disallowed: string[] = [];
  const byKey = new Map<string, Candidate>();
  let order = 0;
  const add = (url: string, fromHome: boolean, position?: LinkPosition) => {
    let parsed: URL;
    try {
      parsed = new URL(url, home);
    } catch {
      return;
    }
    if (!/^https?:$/.test(parsed.protocol) || !sameHost(parsed) || NON_PAGE.test(parsed.pathname)) return;
    parsed.hash = '';
    const key = comparisonKey(parsed);
    if (key === homeKey) return;
    const existing = byKey.get(key);
    if (existing) {
      // The same page linked from the navigation and listed in the sitemap: keep the stronger position.
      if (fromHome && !existing.fromHome) Object.assign(existing, { fromHome: true, position });
      return;
    }
    if (input.isAllowed && !input.isAllowed(parsed.pathname + parsed.search)) {
      disallowed.push(parsed.toString());
      return;
    }
    const template = templateKey(parsed.toString());
    if (!template) return;
    byKey.set(key, {
      url: parsed.toString(),
      parsed,
      key,
      template,
      language: languagePrefix(parsed.pathname),
      position,
      fromHome,
      // A query string usually means a filter, a search or a tracking variant of a page.
      utility: UTILITY_PATH.test(parsed.pathname) || parsed.search.length > 0,
      money: MONEY_PATH.test(parsed.pathname),
      lowValue: LOW_VALUE_PATH.test(parsed.pathname),
      order: order++,
    });
  };
  for (const link of input.homeLinks) add(link.url, true, link.position);
  for (const url of input.sitemapUrls) add(url, false);

  const candidates = [...byKey.values()];
  const selected: SelectedPage[] = [{ url: input.home, reason: 'homepage', template: templateKey(input.home) ?? '/' }];
  const taken = new Set<string>([homeKey]);
  const templates = new Set<string>(['/']);
  const room = () => selected.length < cap;
  const take = (c: Candidate, reason: SelectionReason) => {
    if (!room() || taken.has(c.key)) return false;
    taken.add(c.key);
    templates.add(c.template);
    selected.push({ url: c.url, reason, template: c.template });
    return true;
  };

  // 1. What the homepage's header and navigation link to, in the order a visitor sees it.
  //    At most 40% of the scan, so one long menu does not crowd out the rest of the site.
  const navMax = Math.max(1, Math.round(cap * 0.4));
  let navTaken = 0;
  for (const c of candidates) {
    if (navTaken >= navMax) break;
    const inNav = c.position === 'header' || c.position === 'nav';
    if (inNav && !c.utility && !c.lowValue && c.language === homeLanguage && take(c, 'navigation')) navTaken++;
  }

  // 2. The entry page of up to two other languages: localisation problems show there.
  const otherLanguages = [
    ...new Set(candidates.map((c) => c.language).filter((l): l is string => !!l && l !== homeLanguage)),
  ];
  for (const language of otherLanguages.slice(0, 2)) {
    const roots = candidates.filter((c) => c.language === language && c.template === '/');
    const root = roots[0] ?? candidates.find((c) => c.language === language && !c.utility);
    if (root) take(root, 'language');
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.utility || c.language !== homeLanguage) continue;
    groups.set(c.template, [...(groups.get(c.template) ?? []), c]);
  }
  const ranked = [...groups.entries()].sort(
    (a, b) =>
      b[1].length - a[1].length || Math.min(...a[1].map((c) => c.order)) - Math.min(...b[1].map((c) => c.order)),
  );

  // 3. Selling templates (products, prices, booking, contact): up to three pages of each, drawn at
  //    random so a fact can say "2 of 3 product pages" and no page is favoured by its place in the
  //    sitemap. Pages the navigation step already took count towards the three.
  const random = seededRandom(input.seed ?? home.hostname.replace(/^www\./, ''));
  const moneyMax = Math.max(1, Math.round(cap * MONEY_SHARE));
  let moneyTaken = 0;
  const moneyGroups = ranked.filter(([, members]) => members.some((c) => c.money));
  for (let round = 0; round < MONEY_PER_TEMPLATE && moneyTaken < moneyMax; round++) {
    for (const [template, members] of moneyGroups) {
      if (moneyTaken >= moneyMax || !room()) break;
      const have = selected.filter((s) => s.template === template).length;
      if (have > round) continue;
      const pick = shuffled(
        members.filter((c) => c.money && !taken.has(c.key)),
        random,
      )[0];
      if (pick && take(pick, 'money')) moneyTaken++;
    }
  }

  // 4. One page per template not seen yet, largest templates first (a blog or a catalogue matters
  //    more than a one-off page), preferring a page the homepage links to. Careers, press and the
  //    like wait for step 5.
  for (const [template, members] of ranked) {
    if (!room()) break;
    if (templates.has(template) || members.every((c) => c.lowValue)) continue;
    const pick = members.find((c) => c.fromHome) ?? members[0];
    take(pick, 'template');
  }

  // 5. Fill what is left: pages the homepage links to first, then the sitemap; careers and press
  //    pages after those, utility pages last.
  const rest = candidates
    .filter((c) => !taken.has(c.key))
    .sort(
      (a, b) =>
        Number(a.utility) - Number(b.utility) ||
        Number(a.lowValue) - Number(b.lowValue) ||
        Number(a.language !== homeLanguage) - Number(b.language !== homeLanguage) ||
        Number(b.fromHome) - Number(a.fromHome) ||
        a.order - b.order,
    );
  for (const c of rest) {
    if (!room()) break;
    take(c, 'fill');
  }

  const languages = [...new Set([homeLanguage, ...otherLanguages].filter((l): l is string => !!l))];
  return { selected, disallowed, languages };
}

/** Up to `n` URLs spread evenly over the list: a small, unbiased picture of a large sitemap. */
export function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const out: T[] = [];
  const step = items.length / n;
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}
