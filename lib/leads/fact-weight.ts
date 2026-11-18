/**
 * How much a confirmed fact weighs as a reason to hire developers.
 *
 * - `heavy`: work a team has to plan — software past its end of life or a framework several major
 *   versions behind, a site that is slow for real visitors, a key page that is empty without
 *   JavaScript, a main-navigation link that is dead across the site, analytics or ad tags that lose data.
 * - `medium`: a real defect with a contained fix (a key page hidden from search, a missing price in
 *   product data, tracking before consent).
 * - `light`: hygiene (unnamed controls, email records, a library advisory, a footer link).
 *
 * A teaser needs at least one heavy fact, and its facts are shown heaviest first.
 *
 * The weight is read from the fact as the gate wrote it — type, evidence and the gate's own fixed
 * wording — so results already on disk can be weighed again without a request to the site
 * (`lead-pipeline.ts rerank`). `tests/leads-fact-weight.test.ts` holds the wording in place.
 */

export type FactWeight = 'heavy' | 'medium' | 'light';

/** The parts of a highlight the weight is read from. */
export interface WeighableFact {
  type: string;
  rootCause: string;
  fact: string;
  evidence: { target?: string; value?: number | string };
}

const WEIGHT_RANK: Record<FactWeight, number> = { heavy: 0, medium: 1, light: 2 };
export const weightRank = (w: FactWeight | undefined) => WEIGHT_RANK[w ?? 'light'];

/** A framework this many major versions behind its fixed release is an upgrade project, not a patch. */
export const FRAMEWORK_MAJORS_BEHIND = 2;
/** A dead link, or a blocked tag, on at least this share of the scanned pages is site-wide. */
export const SITE_WIDE_SHARE = 0.5;
/** …or on at least this many scanned pages. */
export const SITE_WIDE_PAGES = 5;

/** `on 16 of 21 pages scanned`, `on all 25 pages scanned` → pages with it and pages scanned. */
export function pageShare(fact: string): { pages: number; scanned: number } | null {
  const all = /\bon all (\d+) pages? scanned/.exec(fact);
  if (all) return { pages: Number(all[1]), scanned: Number(all[1]) };
  const some = /\bon (\d+) of (\d+) pages? scanned/.exec(fact);
  return some ? { pages: Number(some[1]), scanned: Number(some[2]) } : null;
}

function siteWide(fact: string): boolean {
  const share = pageShare(fact);
  if (!share || share.scanned === 0) return false;
  return share.pages >= SITE_WIDE_PAGES || share.pages / share.scanned >= SITE_WIDE_SHARE;
}

const major = (version: string | undefined) => {
  const m = /^(\d+)/.exec(version ?? '');
  return m ? Number(m[1]) : null;
};

/** A framework the site runs on, far behind: `The site runs on Next.js 10.2.3 … all fixed from version 15.5.28`. */
function frameworkFarBehind(fact: string): boolean {
  const runs = /^The site runs on \S+(?: \S+)*? (\d[\w.-]*)/.exec(fact);
  if (!runs) return false;
  if (/no fixed release in the \d+\.x line/.test(fact)) return true;
  const fixed = /fixed from version (\d[\w.-]*)/.exec(fact);
  const have = major(runs[1]);
  const need = major(fixed?.[1]);
  return have !== null && need !== null && need - have >= FRAMEWORK_MAJORS_BEHIND;
}

/** The gate names the vendor when it knows the tag (`blocks the Pinterest tag`); otherwise `blocks requests to <host>`. */
const namesVendor = (fact: string) => /Content Security Policy blocks /.test(fact) && !/blocks requests to /.test(fact);

export function weighFact(h: WeighableFact): FactWeight {
  switch (h.type) {
    case 'end-of-life':
    case 'poor-vitals':
    case 'content-not-served':
    case 'analytics-gap':
      return 'heavy';
    case 'vulnerable-library':
      return frameworkFarBehind(h.fact) ? 'heavy' : 'light';
    case 'dead-nav-link':
      if (/ in the footer /.test(h.fact)) return 'light';
      return siteWide(h.fact) ? 'heavy' : 'medium';
    case 'blocked-by-policy':
      return namesVendor(h.fact) && siteWide(h.fact) ? 'heavy' : 'medium';
    case 'noindex':
    case 'product-no-price':
    case 'missing-hreflang':
    case 'missing-page-status':
    case 'broken-image':
    case 'template-text':
    case 'tracking-before-consent':
      return 'medium';
    default:
      return 'light';
  }
}

/** Heaviest first; the given order (the gate's cause order) decides between equals. */
export function sortByWeight<T extends { weight?: FactWeight }>(facts: T[]): T[] {
  return facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => weightRank(a.f.weight) - weightRank(b.f.weight) || a.i - b.i)
    .map((x) => x.f);
}

/** Enough different causes, and at least one of them heavy. */
export function isTeaserReady(facts: Array<{ rootCause: string; weight?: FactWeight }>, minCauses: number): boolean {
  const causes = new Set(facts.map((f) => f.rootCause));
  return causes.size >= minCauses && facts.some((f) => f.weight === 'heavy');
}
