/**
 * Stage 4 of the lead pipeline: turn the stack profile and the scan into candidate highlights.
 *
 * This stage decides nothing about truth. It only says "this might be worth telling the prospect,
 * and here is what would have to be confirmed". The truth gate (`truth-gate.ts`) does the confirming.
 * Facts are placed side by side with the stack; a cause is never claimed.
 */

import type { LinkPosition } from '../analyzers/site-wide/crawl-graph-checks';
import { okPages, formatDateParts, type RunData, type RunPage } from './run-data';
import type { EolHit, StackProfile, Track } from './types';

/** Finding types the truth gate knows how to confirm. Anything else stays in the full audit. */
export const ALLOWLIST = ['end-of-life', 'dead-nav-link', 'broken-image', 'poor-vitals', 'noindex'] as const;
export type FindingType = (typeof ALLOWLIST)[number];

export type Angle =
  | 'end-of-life platform'
  | 'visitors hit broken things'
  | 'localisation gaps'
  | 'slow for real users'
  | 'search visibility blockers';

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

export type Candidate = DeadLinkCandidate | NoindexCandidate | VitalsCandidate | EolCandidate | BrokenImageCandidate;

/** Audit findings that are deliberately not candidates, whatever their severity. */
export const NOT_ON_ALLOWLIST: Array<[RegExp, string]> = [
  [/orphan/i, 'orphan pages'],
  [/soft 404/i, 'soft 404s'],
  [/crawl budget/i, 'crawl-budget estimates'],
  [/duplicate (?:title|description|content)|near-duplicate/i, 'duplicate content'],
  [/anchor text/i, 'anchor-text findings'],
  [/security header|content-security-policy|x-frame-options|strict-transport/i, 'security-header checklist'],
  [/accessib|aria|contrast|alt text|touch target/i, 'accessibility heuristics'],
  [/user-agent .*blocked|blocked from entire site|ai crawler/i, 'robots.txt bot rules'],
  [/redirect.* in sitemap|sitemap .*redirect/i, 'sitemap redirects'],
  [/consent|cookie/i, 'cookie consent (allowlist candidate after a precision review)'],
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
    if (!c.text && text.trim()) c.text = text.trim();
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
      angle: 'end-of-life platform' as const,
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

export function buildCandidates(run: RunData, stack: StackProfile | null): Candidate[] {
  return [
    ...eolCandidates(stack),
    ...deadLinkCandidates(run),
    ...brokenImageCandidates(run),
    ...vitalsCandidates(run),
    ...noindexCandidates(run),
  ];
}

/** Audit findings left for the full audit, with the reason: logged so the reviewer sees what was not used. */
export function findingsNotOnAllowlist(run: RunData): Array<{ finding: string; reason: string }> {
  const out: Array<{ finding: string; reason: string }> = [];
  for (const message of Object.keys(run.findings)) {
    const plain = message.replace(/<[^>]*>/g, '');
    const hit = NOT_ON_ALLOWLIST.find(([pattern]) => pattern.test(plain));
    if (hit) out.push({ finding: plain.slice(0, 120), reason: hit[1] });
  }
  return out;
}

/** The pitch track a stack kind puts a prospect on (re-exported here for the teaser). */
export type { Track };
