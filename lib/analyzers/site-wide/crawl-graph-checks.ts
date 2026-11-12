/**
 * Post-crawl graph checks over the crawled page set: canonical chains/loops,
 * canonical and hreflang targets that redirect / error / are noindex, faceted
 * navigation explosions, infinite calendar URL spaces, untrustworthy sitemap
 * lastmod values, CTA links to broken or login pages, and JSON-LD telephone
 * numbers that do not appear on the page. Pure functions, no network.
 *
 * Relies only on PageInfo fields that survive checkpointing: status/statusCode,
 * canonical, alternates / international.hreflangTags, noindex / indexability /
 * metaRobots, hasRedirects / redirectCount / finalUrl, ctas.
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';
import { escapeHtml } from '../../reports/html-utils';

export const CRAWL_GRAPH_MESSAGES = {
  canonicalLoop: 'Canonical loop between pages',
  canonicalChain: 'Canonical chain (canonical points to a page with its own canonical)',
  canonicalToRedirect: 'Canonical points to a redirecting URL',
  canonicalToError: 'Canonical points to an error page',
  canonicalToNoindex: 'Canonical points to a noindex page',
  hreflangToRedirect: 'Hreflang alternate points to a redirecting URL',
  hreflangToError: 'Hreflang alternate points to an error page',
  hreflangToNoindex: 'Hreflang alternate points to a noindex page',
  hreflangToCanonicalised: 'Hreflang alternate points to a canonicalised URL',
  facetExplosion: 'Faceted navigation creates many crawlable URL variants',
  calendarOutOfRange: 'Calendar URL space with out-of-range dates',
  calendarArchiveLarge: 'Large date-archive URL series',
  lastmodUniform: 'Sitemap lastmod values are not trustworthy (identical dates)',
  lastmodFuture: 'Sitemap lastmod dates in the future',
  ctaToError: 'CTA link points to a broken page',
  ctaToLogin: 'CTA link redirects to a login page',
  phoneNotOnPage: 'Structured data telephone not shown on page',
} as const;

const MAX_EXAMPLES = 10;
export const FACET_VARIANT_THRESHOLD = 50;
export const DATE_ARCHIVE_THRESHOLD = 100;
export const LASTMOD_MIN_URLS = 20;
export const LASTMOD_UNIFORM_RATIO = 0.9;
const DAY_MS = 86_400_000;

// ---------- URL helpers ----------

/** Normalises a URL for graph lookups: drops the hash, lowercases host. Returns null when unparsable. */
export function normalizeUrl(url: string, base?: string): string | null {
  try {
    const u = new URL(url, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Builds a lookup that also tolerates trailing-slash differences. */
export function buildPageIndex(pages: Record<string, PageInfo>): Map<string, PageInfo> {
  const index = new Map<string, PageInfo>();
  for (const [key, page] of Object.entries(pages)) {
    const n = normalizeUrl(page?.url || key);
    if (n && page) index.set(n, page);
    const k = normalizeUrl(key);
    if (k && page && !index.has(k)) index.set(k, page);
  }
  return index;
}

function lookup(index: Map<string, PageInfo>, url: string): PageInfo | undefined {
  const n = normalizeUrl(url);
  if (!n) return undefined;
  const hit = index.get(n);
  if (hit) return hit;
  const alt = n.endsWith('/') ? n.slice(0, -1) : `${n}/`;
  return index.get(alt);
}

function sameUrl(a: string, b: string): boolean {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  if (!na || !nb) return false;
  return na.replace(/\/$/, '') === nb.replace(/\/$/, '');
}

export function pageStatus(page: PageInfo): number | undefined {
  const s = page.statusCode ?? page.status ?? page.indexability?.statusCode;
  return typeof s === 'number' && s > 0 ? s : undefined;
}

export function isRedirecting(page: PageInfo, requestedUrl: string): boolean {
  const s = pageStatus(page);
  if (s !== undefined && s >= 300 && s < 400) return true;
  if (page.hasRedirects || (page.redirectCount ?? 0) > 0) return true;
  if (page.finalUrl && !sameUrl(page.finalUrl, requestedUrl)) return true;
  return false;
}

export function isNoindex(page: PageInfo): boolean {
  if (page.noindex || page.indexability?.hasNoindexTag) return true;
  const robots = `${page.metaRobots ?? ''} ${page.indexability?.metaRobots ?? ''} ${page.indexability?.xRobotsTag ?? ''}`;
  return /\b(noindex|none)\b/i.test(robots);
}

type TargetState = 'redirect' | 'error' | 'noindex' | null;

function targetState(page: PageInfo, url: string): TargetState {
  const s = pageStatus(page);
  if (s !== undefined && s >= 400) return 'error';
  if (isRedirecting(page, url)) return 'redirect';
  if (isNoindex(page)) return 'noindex';
  return null;
}

function link(url: string): string {
  const e = escapeHtml(url);
  return `<a href="${e}">${e}</a>`;
}

function examples(list: string[]): string {
  const shown = list.slice(0, MAX_EXAMPLES).join('<br>');
  return list.length > MAX_EXAMPLES ? `${shown}<br>…and ${list.length - MAX_EXAMPLES} more` : shown;
}

// ---------- 1. canonical chains / loops ----------

export function checkCanonicalChains(pages: Record<string, PageInfo>): Issue[] {
  const index = buildPageIndex(pages);
  const canonicalOf = (url: string): string | null => {
    const p = lookup(index, url);
    if (!p?.canonical) return null;
    const c = normalizeUrl(p.canonical, p.url || url);
    if (!c || sameUrl(c, p.url || url)) return null;
    return c;
  };

  const issues: Issue[] = [];
  const seenLoops = new Set<string>();
  for (const [key, page] of Object.entries(pages)) {
    const start = normalizeUrl(page?.url || key);
    if (!start) continue;
    const path = [start];
    let current = canonicalOf(start);
    let loop = false;
    while (current) {
      if (path.some((p) => sameUrl(p, current!))) {
        loop = true;
        path.push(current);
        break;
      }
      path.push(current);
      if (!lookup(index, current)) break;
      current = canonicalOf(current);
      if (path.length > 20) break;
    }
    if (loop) {
      const cycleStart = path.findIndex((p) => sameUrl(p, path[path.length - 1]!));
      const cycle = path.slice(cycleStart, -1);
      const sig = [...cycle]
        .map((u) => u.replace(/\/$/, ''))
        .sort()
        .join('|');
      if (seenLoops.has(sig)) continue;
      seenLoops.add(sig);
      issues.push({
        message: CRAWL_GRAPH_MESSAGES.canonicalLoop,
        detail: `Canonical tags form a loop: ${[...cycle, cycle[0]!].map(link).join(' → ')}. Search engines cannot pick a canonical and may ignore all of them.`,
        severity: SEVERITY.HIGH,
      });
    } else if (path.length >= 3) {
      issues.push({
        message: CRAWL_GRAPH_MESSAGES.canonicalChain,
        detail: `${path.map(link).join(' → ')}. Point the canonical of ${link(start)} directly at the final URL ${link(path[path.length - 1]!)}.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }
  return issues;
}

// ---------- 2. canonical target quality ----------

export function checkCanonicalTargets(pages: Record<string, PageInfo>): Issue[] {
  const index = buildPageIndex(pages);
  const issues: Issue[] = [];
  for (const [key, page] of Object.entries(pages)) {
    if (!page?.canonical) continue;
    const from = page.url || key;
    const target = normalizeUrl(page.canonical, from);
    if (!target || sameUrl(target, from)) continue;
    const t = lookup(index, target);
    if (!t) continue;
    const state = targetState(t, target);
    if (!state) continue;
    const msg =
      state === 'error'
        ? CRAWL_GRAPH_MESSAGES.canonicalToError
        : state === 'redirect'
          ? CRAWL_GRAPH_MESSAGES.canonicalToRedirect
          : CRAWL_GRAPH_MESSAGES.canonicalToNoindex;
    const why =
      state === 'error'
        ? `returns HTTP ${pageStatus(t)}`
        : state === 'redirect'
          ? `redirects${t.finalUrl ? ` to ${link(t.finalUrl)}` : ''}`
          : 'is marked noindex';
    issues.push({
      message: msg,
      detail: `${link(from)} declares canonical ${link(target)}, which ${why}.`,
      severity: SEVERITY.HIGH,
    });
  }
  return issues;
}

// ---------- 3. hreflang target quality ----------

function hreflangsOf(page: PageInfo): Array<{ hreflang: string; href: string }> {
  const list = page.alternates?.length ? page.alternates : (page.international?.hreflangTags ?? []);
  return list.filter((a) => a && typeof a.href === 'string');
}

export function checkHreflangTargets(pages: Record<string, PageInfo>): Issue[] {
  const index = buildPageIndex(pages);
  const issues: Issue[] = [];
  for (const [key, page] of Object.entries(pages)) {
    if (!page) continue;
    const from = page.url || key;
    for (const alt of hreflangsOf(page)) {
      const target = normalizeUrl(alt.href, from);
      if (!target) continue;
      const t = lookup(index, target);
      if (!t) continue;
      const state = targetState(t, target);
      let msg: string | null = null;
      let why = '';
      if (state === 'error') {
        msg = CRAWL_GRAPH_MESSAGES.hreflangToError;
        why = `returns HTTP ${pageStatus(t)}`;
      } else if (state === 'redirect') {
        msg = CRAWL_GRAPH_MESSAGES.hreflangToRedirect;
        why = `redirects${t.finalUrl ? ` to ${link(t.finalUrl)}` : ''}`;
      } else if (state === 'noindex') {
        msg = CRAWL_GRAPH_MESSAGES.hreflangToNoindex;
        why = 'is marked noindex';
      } else if (t.canonical) {
        const c = normalizeUrl(t.canonical, target);
        if (c && !sameUrl(c, target)) {
          msg = CRAWL_GRAPH_MESSAGES.hreflangToCanonicalised;
          why = `is canonicalised to ${link(c)}`;
        }
      }
      if (!msg) continue;
      issues.push({
        message: msg,
        detail: `${link(from)} lists hreflang="${escapeHtml(alt.hreflang)}" → ${link(target)}, which ${why}.`,
        severity: SEVERITY.MEDIUM,
      });
    }
  }
  return issues;
}

// ---------- 4. faceted navigation explosion ----------

export function checkFacetExplosion(
  pages: Record<string, PageInfo>,
  discoveredUrls: Iterable<string>,
  origin: string,
  threshold = FACET_VARIANT_THRESHOLD,
): Issue[] {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const index = buildPageIndex(pages);
  const byPath = new Map<string, { clean: string; variants: Set<string> }>();
  const add = (raw: string) => {
    const n = normalizeUrl(raw, origin);
    if (!n) return;
    const u = new URL(n);
    if (u.hostname.replace(/^www\./, '') !== host || !u.search) return;
    const clean = `${u.origin}${u.pathname}`;
    const entry = byPath.get(clean) ?? { clean, variants: new Set<string>() };
    entry.variants.add(n);
    byPath.set(clean, entry);
  };
  for (const [key, page] of Object.entries(pages)) add(page?.url || key);
  for (const u of discoveredUrls) add(u);

  const issues: Issue[] = [];
  for (const { clean, variants } of byPath.values()) {
    if (variants.size < threshold) continue;
    // Variants that were crawled and canonicalise to the clean URL are handled.
    let crawled = 0;
    let handled = 0;
    for (const v of variants) {
      const p = lookup(index, v);
      if (!p) continue;
      crawled++;
      if (p.canonical && sameUrl(normalizeUrl(p.canonical, v) ?? '', clean)) handled++;
    }
    if (crawled > 0 && handled / crawled >= 0.9) continue;
    const keys = new Set<string>();
    for (const v of variants) for (const k of new URL(v).searchParams.keys()) keys.add(k);
    issues.push({
      message: CRAWL_GRAPH_MESSAGES.facetExplosion,
      detail:
        `${link(clean)} has ${variants.size} query-string variants (parameters: <code>${escapeHtml([...keys].slice(0, 15).join(', '))}</code>); ` +
        `${handled} of ${crawled} crawled variants canonicalise to the clean URL. Add a canonical to the clean URL, or block the facet parameters from crawling.`,
      severity: SEVERITY.MEDIUM,
    });
  }
  return issues;
}

// ---------- 5. infinite calendar / date URL spaces ----------

const DATE_PARAM =
  /^(?:date|day|month|year|yr|y|m|d|from|to|start|end|start_date|end_date|event_date|cal(?:endar)?|tribe-bar-date)$/i;
const DATE_CONTEXT_SEGMENT =
  /^(?:calendar|events?|archives?|date|dates|year|blog|news|posts?|agenda|kalender|veranstaltungen|calendrier|evenements|calendario|eventos)$/i;
const YEAR_SEGMENT = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/;

/** Returns the years found in date-like URL parts (path year segments or date query params). */
export function extractUrlYears(url: string): number[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const years: number[] = [];
  const segs = u.pathname.split('/');
  segs.forEach((seg, i) => {
    const m = YEAR_SEGMENT.exec(seg);
    if (!m) return;
    // A bare 4-digit segment is only a year in a date context (avoids /product/1234).
    const next = segs[i + 1] ?? '';
    const prev = segs[i - 1] ?? '';
    const dated =
      m[2] !== undefined ||
      (/^\d{1,2}$/.test(next) && Number(next) >= 1 && Number(next) <= 12) ||
      DATE_CONTEXT_SEGMENT.test(prev);
    if (dated) years.push(Number(m[1]));
  });
  for (const [k, v] of u.searchParams) {
    if (!DATE_PARAM.test(k)) continue;
    const m = /(?:^|\D)(\d{4})(?:\D|$)/.exec(v);
    if (m) years.push(Number(m[1]));
  }
  // Ignore 4-digit numbers that clearly are not years (e.g. product ids 4821).
  return years.filter((y) => y >= 1000 && y <= 9999);
}

/** Key of a date-archive series: path with year/month/day segments replaced, or null if none. */
export function dateSeriesKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segs = u.pathname.split('/');
  const yi = segs.findIndex((s) => /^(?:19|20|21)\d{2}$/.test(s));
  const params = [...u.searchParams.keys()].filter((k) => DATE_PARAM.test(k));
  if (yi === -1 && params.length === 0) return null;
  const path = segs
    .map((s, i) => (i === yi ? '{Y}' : yi !== -1 && i > yi && i <= yi + 2 && /^\d{1,2}$/.test(s) ? '{N}' : s))
    .join('/');
  return `${u.origin}${path}${params.length ? `?${params.sort().join('&')}` : ''}`;
}

export function checkCalendarSpaces(
  urls: Iterable<string>,
  origin: string,
  now: Date = new Date(),
  archiveThreshold = DATE_ARCHIVE_THRESHOLD,
): Issue[] {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }
  const maxYear = now.getUTCFullYear() + 2;
  const outOfRange = new Map<string, string[]>();
  const series = new Map<string, Set<string>>();
  for (const raw of urls) {
    const n = normalizeUrl(raw, origin);
    if (!n || new URL(n).hostname.replace(/^www\./, '') !== host) continue;
    const years = extractUrlYears(n);
    if (years.length === 0) continue;
    const key = dateSeriesKey(n) ?? n;
    if (years.some((y) => y > maxYear || y < 1995)) {
      const list = outOfRange.get(key) ?? [];
      list.push(n);
      outOfRange.set(key, list);
    }
    const set = series.get(key) ?? new Set<string>();
    set.add(n);
    series.set(key, set);
  }
  const issues: Issue[] = [];
  for (const [key, list] of outOfRange) {
    issues.push({
      message: CRAWL_GRAPH_MESSAGES.calendarOutOfRange,
      detail:
        `${list.length} URL(s) in series <code>${escapeHtml(key)}</code> use years after ${maxYear} or before 1995 — a sign of an unbounded calendar crawlers can follow forever. ` +
        `Examples:<br>${examples(list.map(link))}`,
      severity: SEVERITY.MEDIUM,
    });
  }
  for (const [key, set] of series) {
    if (set.size <= archiveThreshold || outOfRange.has(key)) continue;
    issues.push({
      message: CRAWL_GRAPH_MESSAGES.calendarArchiveLarge,
      detail: `${set.size} URLs share the date-archive pattern <code>${escapeHtml(key)}</code>. Consider noindex or limiting archive depth to save crawl budget.`,
      severity: SEVERITY.LOW,
    });
  }
  return issues;
}

// ---------- 6. sitemap lastmod trustworthiness ----------

export interface SitemapUrlEntry {
  loc?: string;
  lastmod?: string;
}

export function checkSitemapLastmod(
  sitemapUrls: Record<string, SitemapUrlEntry | unknown>,
  now: Date = new Date(),
): Issue[] {
  const entries: Array<{ loc: string; lastmod: string }> = [];
  for (const [key, value] of Object.entries(sitemapUrls)) {
    const v = (value ?? {}) as SitemapUrlEntry;
    if (typeof v.lastmod === 'string' && v.lastmod.trim()) {
      entries.push({ loc: v.loc ?? key, lastmod: v.lastmod.trim() });
    }
  }
  const issues: Issue[] = [];
  if (entries.length >= LASTMOD_MIN_URLS) {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.lastmod, (counts.get(e.lastmod) ?? 0) + 1);
    const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (count / entries.length >= LASTMOD_UNIFORM_RATIO) {
      issues.push({
        message: CRAWL_GRAPH_MESSAGES.lastmodUniform,
        detail: `${count} of ${entries.length} sitemap URLs (${Math.round((count / entries.length) * 100)}%) share lastmod <code>${escapeHtml(value)}</code>. Search engines ignore lastmod when it does not reflect real content changes.`,
        severity: SEVERITY.LOW,
      });
    }
  }
  const future = entries.filter((e) => {
    const t = Date.parse(e.lastmod);
    return !isNaN(t) && t > now.getTime() + DAY_MS;
  });
  if (future.length > 0) {
    issues.push({
      message: CRAWL_GRAPH_MESSAGES.lastmodFuture,
      detail: `${future.length} sitemap URL(s) have a lastmod more than a day in the future:<br>${examples(
        future.map((e) => `${link(e.loc)} (<code>${escapeHtml(e.lastmod)}</code>)`),
      )}`,
      severity: SEVERITY.LOW,
    });
  }
  return issues;
}

// ---------- 7. CTA links to broken / login pages ----------

export interface PageLink {
  href: string;
  text: string;
}

export const CTA_PATTERN = new RegExp(
  [
    // en
    'buy',
    'add to (?:cart|basket|bag)',
    'sign ?up',
    'get started',
    'book (?:a )?(?:demo|call|meeting)',
    'request (?:a )?demo',
    'contact us',
    'subscribe',
    'download',
    'start (?:your |a )?free trial',
    'free trial',
    'order now',
    'shop now',
    // de
    'kaufen',
    'in den warenkorb',
    'registrieren',
    'jetzt starten',
    'demo buchen',
    'kontakt(?:ieren)?',
    'abonnieren',
    'herunterladen',
    'kostenlos testen',
    // fr
    'acheter',
    'ajouter au panier',
    "s'inscrire",
    'inscrivez-vous',
    'commencer',
    'réserver une démo',
    'contactez-nous',
    "s'abonner",
    'télécharger',
    'essai gratuit',
    // es
    'comprar',
    'añadir al carrito',
    'agregar al carrito',
    'regístrate',
    'registrarse',
    'empezar',
    'comenzar',
    'reservar una demo',
    'contáctanos',
    'contacto',
    'suscríbete',
    'suscribirse',
    'descargar',
    'prueba gratis',
  ].join('|'),
  'i',
);

export function isCtaText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80) return false;
  return new RegExp(`(?:^|[^\\p{L}])(?:${CTA_PATTERN.source})(?:$|[^\\p{L}])`, 'iu').test(t);
}

export const LOGIN_PATH = /\/(?:log-?in|sign-?in|auth|account\/log-?in|users?\/sign_in)(?:\/|$|\?|\.)/i;

/** Links from the page's CTA analyzer output (survives checkpointing). */
export function ctaLinksFromPage(page: PageInfo): PageLink[] {
  return (page.ctas ?? [])
    .filter((c) => typeof c.href === 'string' && c.href && typeof c.text === 'string')
    .map((c) => ({ href: c.href!, text: c.text }));
}

export function checkCtaLinks(pages: Record<string, PageInfo>, linksByPage?: Record<string, PageLink[]>): Issue[] {
  const index = buildPageIndex(pages);
  const issues: Issue[] = [];
  const sources = new Set([...Object.keys(pages), ...Object.keys(linksByPage ?? {})]);
  for (const from of sources) {
    const page = pages[from];
    const fromUrl = page?.url || from;
    const raw = [...(linksByPage?.[from] ?? []), ...(page ? ctaLinksFromPage(page) : [])];
    const seen = new Set<string>();
    for (const l of raw) {
      if (!isCtaText(l.text)) continue;
      const target = normalizeUrl(l.href, fromUrl);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const t = lookup(index, target);
      if (!t) continue;
      const s = pageStatus(t);
      const label = `"${escapeHtml(l.text.trim().slice(0, 80))}"`;
      if (s !== undefined && s >= 400) {
        issues.push({
          message: CRAWL_GRAPH_MESSAGES.ctaToError,
          detail: `CTA ${label} on ${link(fromUrl)} links to ${link(target)}, which returns HTTP ${s}.`,
          severity: SEVERITY.MEDIUM,
        });
        continue;
      }
      const final = t.finalUrl && !sameUrl(t.finalUrl, target) ? t.finalUrl : null;
      if (
        final &&
        LOGIN_PATH.test(new URL(final, target).pathname + '/') &&
        !LOGIN_PATH.test(new URL(target).pathname + '/')
      ) {
        issues.push({
          message: CRAWL_GRAPH_MESSAGES.ctaToLogin,
          detail: `CTA ${label} on ${link(fromUrl)} links to ${link(target)}, which redirects to the login page ${link(final)}.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }
  }
  return issues;
}

// ---------- 8. structured-data telephone vs. visible text ----------

/** Per-page input the crawler must capture (raw JSON-LD is stripped from PageInfo at checkpoint). */
export interface PhoneConsistencyInput {
  url: string;
  /** Telephone values from LocalBusiness / Organization (incl. subtypes) JSON-LD, with the schema type. */
  schemaPhones: Array<{ type: string; telephone: string }>;
  /** document.body.innerText (visible text). */
  visibleText: string;
  /** href values of a[href^="tel:"] links. */
  telLinks: string[];
}

const PHONE_TYPES =
  /^(?:Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|Store|Restaurant|.*(?:Business|Store|Shop|Office|Clinic|Hotel|Agency|Service|Organization))$/;

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** Collects JSON-LD telephone values (Organization/LocalBusiness and subtypes, nested @graph supported). */
export function extractSchemaPhones(jsonLd: unknown): Array<{ type: string; telephone: string }> {
  const out: Array<{ type: string; telephone: string }> = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const rawType = obj['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType]).filter((t): t is string => typeof t === 'string');
    const type = types.find((t) => PHONE_TYPES.test(t));
    const tel = obj['telephone'];
    if (type && (typeof tel === 'string' || Array.isArray(tel))) {
      for (const t of Array.isArray(tel) ? tel : [tel])
        if (typeof t === 'string' && t.trim()) out.push({ type, telephone: t });
    }
    for (const v of Object.values(obj)) if (v && typeof v === 'object') visit(v, depth + 1);
  };
  visit(jsonLd, 0);
  return out;
}

export function phoneAppearsOnPage(telephone: string, visibleText: string, telLinks: string[]): boolean {
  const digits = digitsOnly(telephone);
  if (digits.length < 7) return true; // too short to compare reliably
  // Last 9 digits (or all, if 7-8) survive country-code / trunk-prefix differences.
  const key = digits.slice(-Math.min(9, digits.length));
  if (telLinks.some((l) => digitsOnly(l).endsWith(key))) return true;
  // Candidate phone-number runs in the text: digits with common separators.
  const runs = visibleText.match(/[+(]?\d[\d\s().\-/]{5,}\d/g) ?? [];
  return runs.some((r) => digitsOnly(r).includes(key));
}

export function checkPhoneConsistency(inputs: PhoneConsistencyInput[]): Issue[] {
  const issues: Issue[] = [];
  for (const p of inputs) {
    const seen = new Set<string>();
    for (const { type, telephone } of p.schemaPhones) {
      const d = digitsOnly(telephone);
      if (seen.has(d)) continue;
      seen.add(d);
      if (phoneAppearsOnPage(telephone, p.visibleText, p.telLinks)) continue;
      issues.push({
        message: CRAWL_GRAPH_MESSAGES.phoneNotOnPage,
        detail: `${escapeHtml(type)} JSON-LD on ${link(p.url)} lists telephone <code>${escapeHtml(telephone)}</code>, but that number does not appear in the visible text or tel: links. Keep NAP data consistent with what users see.`,
        severity: SEVERITY.LOW,
      });
    }
  }
  return issues;
}

// ---------- entry ----------

export interface CrawlGraphExtras {
  /** Internal URLs discovered (linked) but not necessarily crawled, e.g. keys of incoming-links. */
  discoveredUrls?: Iterable<string>;
  /** Per-page links with anchor text, keyed by page URL (when the crawler captures them). */
  linksByPage?: Record<string, PageLink[]>;
  /** Per-page phone data (when the crawler captures it). */
  phoneInputs?: PhoneConsistencyInput[];
}

export function runCrawlGraphChecks(
  pages: Record<string, PageInfo>,
  sitemapUrls: Record<string, SitemapUrlEntry | unknown>,
  origin: string,
  now: Date = new Date(),
  extras: CrawlGraphExtras = {},
): Issue[] {
  const discovered = [...(extras.discoveredUrls ?? [])];
  const allUrls = [...Object.entries(pages).map(([k, p]) => p?.url || k), ...discovered, ...Object.keys(sitemapUrls)];
  const run = (fn: () => Issue[]): Issue[] => {
    try {
      return fn();
    } catch {
      return [];
    }
  };
  return [
    ...run(() => checkCanonicalChains(pages)),
    ...run(() => checkCanonicalTargets(pages)),
    ...run(() => checkHreflangTargets(pages)),
    ...run(() => checkFacetExplosion(pages, discovered, origin)),
    ...run(() => checkCalendarSpaces(new Set(allUrls), origin, now)),
    ...run(() => checkSitemapLastmod(sitemapUrls, now)),
    ...run(() => checkCtaLinks(pages, extras.linksByPage)),
    ...run(() => checkPhoneConsistency(extras.phoneInputs ?? [])),
  ];
}
