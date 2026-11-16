/**
 * Stage 4 of the lead pipeline: turn the scan into candidate highlights — problems on the site as
 * it is today. The stack profile is read only for outdated software, which is an issue in its own
 * right; the platform is never the pitch (design revision 3).
 *
 * This stage decides nothing about truth. It only says "this might be worth telling the prospect,
 * and here is what would have to be confirmed". The truth gate (`truth-gate.ts`) does the confirming.
 * A cause is never claimed.
 */

import type { LinkPosition } from '../analyzers/site-wide/crawl-graph-checks';
import { LIBRARIES } from '../analyzers/security/js-library-analyzer';
import { okPages, formatDateParts, type RunData, type RunPage } from './run-data';
import { trackingCookies, type TrackingCookie } from './tracking-cookies';
import type { EolHit, StackProfile } from './types';

/** Finding types the truth gate knows how to confirm. Anything else stays in the full audit. */
export const ALLOWLIST = [
  'dead-nav-link',
  'broken-image',
  'template-text',
  'missing-hreflang',
  'noindex',
  'sitemap-dead-urls',
  'poor-vitals',
  'tracking-before-consent',
  'unnamed-controls',
  'vulnerable-library',
  'end-of-life',
] as const;
export type FindingType = (typeof ALLOWLIST)[number];

export type Angle =
  | 'outdated software'
  | 'visitors hit broken things'
  | 'localisation gaps'
  | 'slow for real users'
  | 'search visibility blockers'
  | 'privacy and consent'
  | 'accessibility';

export interface DeadLinkCandidate {
  type: 'dead-nav-link';
  angle: Angle;
  rootCause: 'language-switch' | 'dead-navigation-links';
  /** The link target to check. */
  target: string;
  text: string;
  position: LinkPosition | 'cta';
  /** Scanned pages that carry the link; the first is the one the prospect is pointed at. */
  pages: string[];
  pagesScanned: number;
  /** Status the crawl saw for the target, when the target was itself a scanned page. */
  crawledStatus: number | null;
  /**
   * The same link with a different address on each page (a language switch that carries the current
   * page in its query string). Each address is checked on its own; `target` and `pages[0]` are the
   * first pair. Empty for an ordinary link, which has one address everywhere.
   */
  variants: Array<{ target: string; page: string }>;
}

export interface NoindexCandidate {
  type: 'noindex';
  angle: Angle;
  rootCause: 'noindex';
  url: string;
  /** Why the page counts as a key page. */
  keyReason: 'homepage' | 'main navigation' | 'sitemap';
  metaRobots: string | null;
  xRobotsTag: string | null;
}

export interface VitalsCandidate {
  type: 'poor-vitals';
  angle: Angle;
  rootCause: 'real-user-performance';
  metric: 'LCP' | 'INP' | 'CLS';
  p75: number;
  origin: string;
  formFactor: string;
  /** Last day of the 28-day collection period, when the API gave one. */
  periodEnd: string | null;
}

export interface EolCandidate {
  type: 'end-of-life';
  angle: Angle;
  rootCause: string;
  hit: EolHit;
}

export interface BrokenImageCandidate {
  type: 'broken-image';
  angle: Angle;
  rootCause: 'broken-images';
  image: string;
  /** Scanned pages that show the image; the first is the one the prospect is pointed at. */
  pages: string[];
  /** Screenshot the scan took of the defect, relative to the run folder, when there is one. */
  shot: string | null;
}

export interface TemplateTextCandidate {
  type: 'template-text';
  angle: Angle;
  rootCause: 'template-text';
  url: string;
  /** Raw template code the scan saw in the rendered text, e.g. `{{ product.title }}`. */
  tokens: string[];
  /** The page shows lorem ipsum. */
  placeholder: boolean;
  shot: string | null;
}

export interface MissingHreflangCandidate {
  type: 'missing-hreflang';
  angle: Angle;
  rootCause: 'missing-hreflang';
  /** Primary language codes seen in the scanned pages' `<html lang>`, e.g. `nl`, `en`, `fr`. */
  languages: string[];
  /** One scanned page per language, the homepage's language first. */
  pages: Array<{ lang: string; url: string }>;
  pagesScanned: number;
  /** Sitemap files the scan read; the gate looks for hreflang there too. */
  sitemaps: string[];
}

export interface SitemapDeadCandidate {
  type: 'sitemap-dead-urls';
  angle: Angle;
  rootCause: 'sitemap-dead-urls';
  /** Sitemap URLs to request, spread over the sitemap. */
  sample: string[];
  sitemapTotal: number;
}

export interface VulnerableLibraryCandidate {
  type: 'vulnerable-library';
  angle: Angle;
  rootCause: 'vulnerable-libraries';
  /** Key in `LIBRARIES` (js-library-analyzer.ts), e.g. `jquery`. */
  lib: string;
  label: string;
  version: string;
  /** The advisory as the scan reported it, e.g. `XSS in … (CVE-2020-11022)`. */
  advisory: string;
  fixedIn: string;
  /** A scanned page that loads it. */
  page: string;
  /** Script files on that page that may be the library; the gate reads the version from their banner. */
  scripts: string[];
}

export interface TrackingBeforeConsentCandidate {
  type: 'tracking-before-consent';
  angle: Angle;
  rootCause: 'tracking-before-consent';
  /** The page the gate loads on a first visit: the homepage when the scan read it. */
  url: string;
  /** `url` is the homepage (the address a visitor types), not another scanned page. */
  isHome: boolean;
  /** Analytics and advertising cookies the scan saw there before anything was clicked. */
  cookies: TrackingCookie[];
}

export interface UnnamedControlsCandidate {
  type: 'unnamed-controls';
  angle: Angle;
  rootCause: 'unnamed-controls';
  /** The page the gate opens: the scanned page that carries the most widespread offenders. */
  url: string;
  /** Offenders on that page as `<tag#id>` / `<tag.class>`, the most widespread first. */
  offenders: string[];
  /** Scanned pages carrying each offender. */
  pagesWith: Record<string, number>;
  pagesScanned: number;
}

export type Candidate =
  | TrackingBeforeConsentCandidate
  | UnnamedControlsCandidate
  | DeadLinkCandidate
  | NoindexCandidate
  | VitalsCandidate
  | EolCandidate
  | BrokenImageCandidate
  | TemplateTextCandidate
  | MissingHreflangCandidate
  | SitemapDeadCandidate
  | VulnerableLibraryCandidate;

/** Audit findings that are deliberately not candidates, whatever their severity. */
export const NOT_ON_ALLOWLIST: Array<[RegExp, string]> = [
  [/orphan/i, 'orphan pages'],
  [/soft 404/i, 'soft 404s'],
  [/crawl budget/i, 'crawl-budget estimates'],
  [/duplicate (?:title|description|content)|near-duplicate/i, 'duplicate content'],
  [/anchor text/i, 'anchor-text findings'],
  [/security header|content-security-policy|x-frame-options|strict-transport/i, 'security-header checklist'],
  [/accessib|aria|contrast|alt text|touch target/i, 'accessibility heuristics other than unnamed controls'],
  [/user-agent .*blocked|blocked from entire site|ai crawler/i, 'robots.txt bot rules'],
  [/redirect.* in sitemap|sitemap .*redirect/i, 'sitemap redirects'],
  [/consent|cookie/i, 'cookie checks other than tracking cookies before consent'],
  [/no ga4 hits|analytics installed but/i, 'tag installed, no hits (allowlist candidate after a precision review)'],
];

const LOCALE_PARAM = /[?&](?:lang|locale|language|hl|_lcl|lng)=[a-z]{2}(?:[-_][a-z]{2})?(?:&|$)/i;
const LOCALE_PATH = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?)\/?$/i;
const LANGUAGE_TEXT =
  /^(?:[a-z]{2}|[a-z]{2}[-_][a-z]{2}|english|deutsch|german|français|french|español|spanish|italiano|italian|português|portuguese|nederlands|dutch|polski|русский|العربية|arabic|中文|日本語|한국어|türkçe|svenska|dansk|norsk|suomi)$/i;

/** A link that switches the site's language: by its URL shape or by its label. */
export function isLanguageSwitch(href: string, text: string): boolean {
  try {
    const u = new URL(href);
    if (LOCALE_PARAM.test(u.search) || /\/(?:locale|lang|language)\b/i.test(u.pathname)) return true;
    return LOCALE_PATH.test(u.pathname) && LANGUAGE_TEXT.test(text.trim());
  } catch {
    return false;
  }
}

const UTILITY =
  /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|account|cart|basket|checkout|search|privacy|terms|legal|cookies?|imprint|impressum|thank-you|thanks|unsubscribe|password|preview|staging|test)(?:[/._-]|$)/i;

const sameSite = (a: string, b: string) => {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb;
  } catch {
    return false;
  }
};

const key = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
};

const POSITION_RANK: Record<string, number> = { header: 0, nav: 1, cta: 2, footer: 3, main: 4 };

/** Most link targets a gate run may check; header and navigation links first. */
export const MAX_LINK_TARGETS = 40;

export function deadLinkCandidates(run: RunData): DeadLinkCandidate[] {
  const scanned = okPages(run);
  if (!scanned.length) return [];
  const home = run.metadata.leadScan?.home ?? scanned[0].url;
  const statusByKey = new Map<string, number>();
  for (const p of Object.values(run.pages)) {
    if (!p.redirectOnly && p.status) statusByKey.set(key(p.url), p.status);
  }

  const byTarget = new Map<string, DeadLinkCandidate>();
  const add = (page: RunPage, href: string, text: string, position: LinkPosition | 'cta') => {
    if (!/^https?:/i.test(href) || !sameSite(href, page.url)) return;
    let target: string;
    try {
      const u = new URL(href);
      u.hash = '';
      target = u.toString();
    } catch {
      return;
    }
    if (key(target) === key(page.url)) return;
    const crawled = statusByKey.get(key(target)) ?? null;
    if (crawled !== null && crawled >= 200 && crawled < 400) return; // the scan loaded it: it works
    // A link whose address carries a query string is the same link on every page when its path,
    // label and place agree: it is one candidate with one address per page.
    const parsed = new URL(target);
    const logical = parsed.search
      ? `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}|${text.trim().toLowerCase()}|${position}`
      : null;
    const k = logical ?? key(target);
    let c = byTarget.get(k);
    if (c && logical && !c.pages.includes(page.url) && c.target !== target) {
      if (!c.variants.length) c.variants.push({ target: c.target, page: c.pages[0] });
      c.variants.push({ target, page: page.url });
    }
    if (!c) {
      const language = isLanguageSwitch(target, text);
      c = {
        type: 'dead-nav-link',
        angle: language ? 'localisation gaps' : 'visitors hit broken things',
        rootCause: language ? 'language-switch' : 'dead-navigation-links',
        target,
        text: text.trim(),
        position,
        pages: [],
        pagesScanned: scanned.length,
        crawledStatus: crawled,
        variants: [],
      };
      byTarget.set(k, c);
    }
    if (POSITION_RANK[position] < POSITION_RANK[c.position]) c.position = position;
    // Screen-reader hints such as "(opens in a new tab)" are not part of what a visitor reads.
    const label = text.replace(/\s*\((?:opens|open) in (?:a )?new (?:tab|window)\)\s*/gi, ' ').trim();
    if (!c.text && label) c.text = label;
    if (!c.pages.includes(page.url)) c.pages.push(page.url);
  };

  for (const page of scanned) {
    for (const link of page.siteHints?.navLinks ?? []) add(page, link.href, link.text ?? '', link.position ?? 'nav');
    for (const link of page.siteHints?.ctaLinks ?? []) add(page, link.href, link.text ?? '', 'cta');
  }

  const candidates = [...byTarget.values()];
  for (const c of candidates) {
    // Point the prospect at the homepage when it carries the link.
    const homeFirst = (a: string, b: string) => Number(key(b) === key(home)) - Number(key(a) === key(home));
    c.pages.sort(homeFirst);
    if (c.variants.length) {
      c.variants.sort((a, b) => homeFirst(a.page, b.page));
      c.target = c.variants[0].target;
    }
  }
  return candidates
    .sort(
      (a, b) =>
        Number(b.crawledStatus !== null) - Number(a.crawledStatus !== null) ||
        POSITION_RANK[a.position] - POSITION_RANK[b.position] ||
        b.pages.length - a.pages.length,
    )
    .slice(0, MAX_LINK_TARGETS);
}

export function noindexCandidates(run: RunData): NoindexCandidate[] {
  const home = run.metadata.leadScan?.home;
  const navigation = new Set(
    (run.metadata.leadScan?.selected ?? []).filter((p) => p.reason === 'navigation').map((p) => key(p.url)),
  );
  const out: NoindexCandidate[] = [];
  for (const page of okPages(run)) {
    const meta = page.indexability?.metaRobots ?? null;
    const header = page.indexability?.xRobotsTag ?? null;
    const noindex = page.indexability?.hasNoindexTag === true || /noindex/i.test(header ?? '');
    if (!noindex) continue;
    let pathname: string;
    try {
      pathname = new URL(page.url).pathname;
    } catch {
      continue;
    }
    if (UTILITY.test(pathname)) continue; // such pages are often noindex on purpose
    const keyReason: NoindexCandidate['keyReason'] | null =
      home && key(page.url) === key(home)
        ? 'homepage'
        : navigation.has(key(page.url))
          ? 'main navigation'
          : page.foundIn === 'sitemap'
            ? 'sitemap'
            : null;
    if (!keyReason) continue;
    out.push({
      type: 'noindex',
      angle: 'search visibility blockers',
      rootCause: 'noindex',
      url: page.url,
      keyReason,
      metaRobots: meta,
      xRobotsTag: header,
    });
  }
  const rank = { homepage: 0, 'main navigation': 1, sitemap: 2 };
  return out.sort((a, b) => rank[a.keyReason] - rank[b.keyReason]);
}

/** Google's "poor" thresholds for the 75th percentile. */
export const POOR_THRESHOLD = { LCP: 4000, INP: 500, CLS: 0.25 } as const;

export function vitalsCandidates(run: RunData): VitalsCandidate[] {
  const crux = run.metadata.cruxData;
  // Only origin-level data is comparable with what PageSpeed Insights shows the site owner.
  if (!crux?.metrics || crux.targetType !== 'origin') return [];
  const out: VitalsCandidate[] = [];
  for (const metric of ['LCP', 'INP', 'CLS'] as const) {
    const p75 = Number(crux.metrics[metric]?.percentiles?.p75);
    if (!Number.isFinite(p75) || p75 <= POOR_THRESHOLD[metric]) continue;
    out.push({
      type: 'poor-vitals',
      angle: 'slow for real users',
      rootCause: 'real-user-performance',
      metric,
      p75,
      origin: crux.target ?? '',
      formFactor: crux.formFactor ?? 'ALL_FORM_FACTORS',
      periodEnd: formatDateParts(crux.collectionPeriod?.lastDate),
    });
  }
  return out;
}

/** Products whose end of life is one fact with another product's (Nuxt 2 is built on Vue 2). */
const EOL_FAMILY: Record<string, string> = { vue: 'nuxt' };

export function eolCandidates(stack: StackProfile | null): EolCandidate[] {
  if (!stack) return [];
  const products = new Set(stack.eol.map((h) => h.product));
  return stack.eol.map((hit) => {
    const family = EOL_FAMILY[hit.product];
    return {
      type: 'end-of-life' as const,
      angle: 'outdated software' as const,
      rootCause: `end-of-life:${family && products.has(family) ? family : hit.product}`,
      hit,
    };
  });
}

export function brokenImageCandidates(run: RunData): BrokenImageCandidate[] {
  const home = run.metadata.leadScan?.home;
  const byImage = new Map<string, BrokenImageCandidate>();
  for (const page of okPages(run)) {
    const shot = page.visualShots?.find((s) => /broken image/i.test(s.kind))?.file ?? null;
    for (const image of page.brokenMediaData?.brokenImages ?? []) {
      if (!/^https?:/i.test(image)) continue;
      let c = byImage.get(image);
      if (!c) {
        c = {
          type: 'broken-image',
          angle: 'visitors hit broken things',
          rootCause: 'broken-images',
          image,
          pages: [],
          shot: null,
        };
        byImage.set(image, c);
      }
      c.pages.push(page.url);
      c.shot ??= shot;
    }
  }
  const candidates = [...byImage.values()];
  for (const c of candidates)
    c.pages.sort((a, b) => Number(home && key(b) === key(home)) - Number(home && key(a) === key(home)));
  // An image on the homepage or on many pages first.
  return candidates
    .sort(
      (a, b) =>
        Number(home && key(b.pages[0]) === key(home)) - Number(home && key(a.pages[0]) === key(home)) ||
        b.pages.length - a.pages.length,
    )
    .slice(0, 10);
}

/**
 * Template code that was not filled in (`{{ name }}`, `[object Object]`) or lorem ipsum on a scanned
 * page. Bare words such as `undefined` or `NaN` are left out: they also occur in real text, and the
 * served-HTML re-check could not tell them apart.
 */
export function templateTextCandidates(run: RunData): TemplateTextCandidate[] {
  const home = run.metadata.leadScan?.home;
  const out: TemplateTextCandidate[] = [];
  for (const page of okPages(run)) {
    const data = page.textIntegrityData;
    if (!data) continue;
    const tokens = (data.templateTokens ?? []).filter((t) => TEMPLATE_CODE.test(t));
    if (!tokens.length && !data.placeholderText) continue;
    const shot = page.visualShots?.find((s) => /template tokens|lorem ipsum/i.test(s.kind))?.file ?? null;
    out.push({
      type: 'template-text',
      angle: 'visitors hit broken things',
      rootCause: 'template-text',
      url: page.url,
      tokens,
      placeholder: data.placeholderText === true,
      shot,
    });
  }
  return out
    .sort((a, b) => Number(home && key(b.url) === key(home)) - Number(home && key(a.url) === key(home)))
    .slice(0, 5);
}

/** Template syntax that a renderer should have replaced. */
export const TEMPLATE_CODE = /\{\{|\}\}|\{%|%\}|\$\{[^}]*\}|\[object Object\]/;

const primaryLanguage = (lang: string | null | undefined) => {
  const m = /^\s*([a-z]{2,3})(?:[-_]|$)/i.exec(lang ?? '');
  return m ? m[1].toLowerCase() : null;
};

/**
 * Pages in two or more languages (by their `<html lang>`), and not one scanned page with hreflang.
 * The gate checks the served pages, the `Link` header and the sitemap before anything is claimed.
 */
export function missingHreflangCandidates(run: RunData): MissingHreflangCandidate[] {
  const scanned = okPages(run);
  if (scanned.some((p) => p.internationalSEO?.hasHreflang !== false)) return [];
  const home = run.metadata.leadScan?.home;
  const ordered = [...scanned].sort(
    (a, b) => Number(home && key(b.url) === key(home)) - Number(home && key(a.url) === key(home)),
  );
  const byLang = new Map<string, string>();
  for (const page of ordered) {
    const lang = primaryLanguage(page.internationalSEO?.langAttribute);
    if (lang && !byLang.has(lang)) byLang.set(lang, page.url);
  }
  if (byLang.size < 2) return [];
  const sitemaps = Object.keys(run.metadata.sitemaps ?? {}).filter((k) => /^https?:/i.test(k));
  return [
    {
      type: 'missing-hreflang',
      angle: 'localisation gaps',
      rootCause: 'missing-hreflang',
      languages: [...byLang.keys()],
      pages: [...byLang.entries()].map(([lang, url]) => ({ lang, url })),
      pagesScanned: scanned.length,
      sitemaps,
    },
  ];
}

/** Sitemap URLs the gate requests, and how few of the sampled URLs make a candidate worth checking. */
export const SITEMAP_SAMPLE_SIZE = 20;
const SITEMAP_SAMPLE_MINIMUM = 5;

/**
 * An even spread of sitemap URLs the scan did not load (the ones it loaded answered). The scan
 * stores up to 200 sitemap URLs spread over the whole sitemap; this takes 20 of them.
 */
export function sitemapDeadCandidates(run: RunData): SitemapDeadCandidate[] {
  const info = run.metadata.leadScan;
  if (!info?.sitemapSample?.length) return [];
  const loaded = new Set(okPages(run).map((p) => key(p.url)));
  const pool = info.sitemapSample.filter((u) => /^https?:/i.test(u) && !loaded.has(key(u)));
  if (pool.length < SITEMAP_SAMPLE_MINIMUM) return [];
  const n = Math.min(SITEMAP_SAMPLE_SIZE, pool.length);
  const sample = Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)]);
  return [
    {
      type: 'sitemap-dead-urls',
      angle: 'search visibility blockers',
      rootCause: 'sitemap-dead-urls',
      sample,
      sitemapTotal: info.sitemapTotal ?? info.sitemapSample.length,
    },
  ];
}

/** The audit's finding for outdated libraries; its examples carry `<Label> <version>: <advisory>; upgrade to <v> or later — <a href="page">`. */
export const VULNERABLE_LIBRARY_FINDING = 'Outdated JavaScript library with known vulnerabilities';

/** Words a library's file name may carry, per `LIBRARIES` key. */
const LIBRARY_FILE_WORDS: Record<string, RegExp> = {
  jquery: /jquery(?!-?ui)/i,
  'jquery-ui': /jquery-?ui/i,
  bootstrap: /bootstrap/i,
  angularjs: /angular/i,
  lodash: /lodash/i,
  underscore: /underscore/i,
  moment: /moment/i,
  handlebars: /handlebars/i,
  dompurify: /purify/i,
  vue: /\bvue/i,
};

/** CMSs that ship their own patched copy of a library: its banner keeps the old version number. */
const PATCHED_BY_CMS: Array<{ cms: RegExp; lib: RegExp }> = [{ cms: /drupal/i, lib: /^jquery/ }];

/**
 * Libraries with a published advisory, read from the audit's finding. Left out: a library a CMS
 * patches in place, and a library whose end of life is already a candidate (one fact, not two).
 */
export function vulnerableLibraryCandidates(run: RunData, stack: StackProfile | null): VulnerableLibraryCandidate[] {
  const finding = run.findings[VULNERABLE_LIBRARY_FINDING];
  if (!finding?.examples?.length) return [];
  const eolProducts = new Set((stack?.eol ?? []).map((h) => h.product));
  const byLib = new Map<string, VulnerableLibraryCandidate>();
  for (const example of finding.examples) {
    const page = /href="([^"]+)"/.exec(example)?.[1]?.replace(/&amp;/g, '&');
    if (!page) continue;
    const text = example.replace(/<[^>]*>/g, '');
    for (const [lib, entry] of Object.entries(LIBRARIES)) {
      if (byLib.has(lib)) continue;
      const label = entry.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(?:^|\\. )${label} (\\d+\\.\\d+(?:\\.\\d+)?): (.+?); upgrade to (\\S+) or later`).exec(
        text,
      );
      if (!m) continue;
      if (stack?.cms && PATCHED_BY_CMS.some((p) => p.cms.test(stack.cms ?? '') && p.lib.test(lib))) continue;
      if (eolProducts.has(lib) || (lib === 'angularjs' && eolProducts.has('angular'))) continue;
      const pageData = run.pages[page] ?? okPages(run).find((p) => key(p.url) === key(page));
      const words = LIBRARY_FILE_WORDS[lib];
      const scripts = (pageData?.siteHints?.scripts ?? []).filter((s) => {
        try {
          return words?.test(decodeURIComponent(new URL(s).pathname)) ?? false;
        } catch {
          return false;
        }
      });
      byLib.set(lib, {
        type: 'vulnerable-library',
        angle: 'outdated software',
        rootCause: 'vulnerable-libraries',
        lib,
        label: entry.label,
        version: m[1],
        advisory: m[2],
        fixedIn: m[3],
        page,
        scripts: scripts.slice(0, 3),
      });
    }
  }
  return [...byLib.values()];
}

/**
 * Analytics or advertising cookies in the browser after the homepage loaded, before anything was
 * clicked. The gate decides whether that is a fact worth stating: only when a first visit in a fresh
 * browser shows a cookie banner and finds the cookies already set.
 */
export function trackingBeforeConsentCandidates(run: RunData): TrackingBeforeConsentCandidate[] {
  const pages = okPages(run);
  const home = run.metadata.leadScan?.home;
  // The homepage, or the page it redirects to (`/` → `/en-eu`): the first page in scan order.
  const page = (home ? pages.find((p) => key(p.url) === key(home)) : undefined) ?? pages[0];
  if (!page?.consentData) return [];
  const names = [
    ...(page.consentData.cookiesBeforeConsent ?? []),
    ...(page.consentData.cookies ?? []).map((c) => c.name),
  ];
  const cookies = trackingCookies(names);
  if (!cookies.length) return [];
  return [
    {
      type: 'tracking-before-consent',
      angle: 'privacy and consent',
      rootCause: 'tracking-before-consent',
      // A first visit starts where a visitor types the address.
      url: home ?? page.url,
      isHome: Boolean(home),
      cookies,
    },
  ];
}

/** Most offenders a candidate carries to the gate. */
const MAX_UNNAMED_OFFENDERS = 12;

/**
 * Links and buttons without an accessible name. One candidate per site: the page whose offenders
 * recur on the most scanned pages (a header or footer control is on all of them), homepage first on
 * a tie. The gate asks the browser's own accessibility tree.
 */
export function unnamedControlsCandidates(run: RunData): UnnamedControlsCandidate[] {
  const pages = okPages(run);
  const offendersOf = (p: RunPage) => [...new Set(p.agentic?.checks?.interactiveNames?.offenders ?? [])];
  const pagesWith: Record<string, number> = {};
  for (const p of pages) for (const o of offendersOf(p)) pagesWith[o] = (pagesWith[o] ?? 0) + 1;
  if (!Object.keys(pagesWith).length) return [];
  const home = run.metadata.leadScan?.home;
  const spread = (p: RunPage) => Math.max(0, ...offendersOf(p).map((o) => pagesWith[o]));
  const best = [...pages]
    .filter((p) => offendersOf(p).length)
    .sort(
      (a, b) =>
        spread(b) - spread(a) || Number(home && key(b.url) === key(home)) - Number(home && key(a.url) === key(home)),
    )[0];
  const offenders = offendersOf(best)
    .sort((a, b) => pagesWith[b] - pagesWith[a])
    .slice(0, MAX_UNNAMED_OFFENDERS);
  return [
    {
      type: 'unnamed-controls',
      angle: 'accessibility',
      rootCause: 'unnamed-controls',
      url: best.url,
      offenders,
      pagesWith: Object.fromEntries(offenders.map((o) => [o, pagesWith[o]])),
      pagesScanned: pages.length,
    },
  ];
}

/** Audit findings the candidates above are built from: not listed as left out. */
const COVERED_FINDINGS = [
  /^interactive elements without an accessible name/i,
  /^tracking cookies without consent banner|^multiple tracking cookies set before consent/i,
];

export function buildCandidates(run: RunData, stack: StackProfile | null): Candidate[] {
  return [
    ...deadLinkCandidates(run),
    ...brokenImageCandidates(run),
    ...templateTextCandidates(run),
    ...missingHreflangCandidates(run),
    ...noindexCandidates(run),
    ...sitemapDeadCandidates(run),
    ...vitalsCandidates(run),
    ...trackingBeforeConsentCandidates(run),
    ...unnamedControlsCandidates(run),
    ...vulnerableLibraryCandidates(run, stack),
    ...eolCandidates(stack),
  ];
}

/** Audit findings left for the full audit, with the reason: logged so the reviewer sees what was not used. */
export function findingsNotOnAllowlist(run: RunData): Array<{ finding: string; reason: string }> {
  const out: Array<{ finding: string; reason: string }> = [];
  for (const message of Object.keys(run.findings)) {
    const plain = message.replace(/<[^>]*>/g, '');
    if (COVERED_FINDINGS.some((re) => re.test(plain))) continue;
    const hit = NOT_ON_ALLOWLIST.find(([pattern]) => pattern.test(plain));
    if (hit) out.push({ finding: plain.slice(0, 120), reason: hit[1] });
  }
  return out;
}
