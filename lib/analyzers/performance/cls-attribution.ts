/**
 * CLS attribution to cookie/consent banners.
 *
 * Uses the layout-shift entries the vitals collector already records
 * (CLSEntry: value, startTime, sources[{ selector, previousRect, currentRect }]).
 * Two attributions:
 *  1. the shifted element itself is a consent banner (selector matches a CMP
 *     id/class — e.g. a banner sliding in at the bottom);
 *  2. the banner was inserted above the content and pushed it down: every
 *     source of the shift moved down by about the banner's height and a
 *     banner is docked at the top of the page (needs `banners` from
 *     findConsentBanners, read from the live page after load).
 * Web-font swap attribution is NOT done: shift entries carry no font-load
 * timing, so it cannot be told apart from other late shifts.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import type { CLSEntry } from '../../crawler/vitals-collector';
import { escapeHtml } from '../../reports/html-utils';

export const BANNER_CLS_MESSAGE = 'Cookie banner causes layout shift';
export const BANNER_CLS_THRESHOLD = 0.05;

export const CMP_PATTERN =
  /onetrust|cookiebot|CybotCookiebot|usercentrics|didomi|cmplz|\bcky-|cookieyes|cookie|consent|gdpr|truste|quantcast|qc-cmp|osano|iubenda|termly|borlabs|klaro|tarteaucitron/i;

export interface BannerRect {
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Runs in the browser: visible consent banners with document-coordinate rects. */
export function findConsentBanners(): BannerRect[] {
  const re =
    /onetrust|cookiebot|CybotCookiebot|usercentrics|didomi|cmplz|\bcky-|cookieyes|cookie|consent|gdpr|truste|quantcast|qc-cmp|osano|iubenda|termly|borlabs|klaro|tarteaucitron/i;
  const out: BannerRect[] = [];
  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 5000)) {
    const id = el.id ?? '';
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!re.test(id) && !re.test(cls)) continue;
    // keep the outermost match only
    let p = el.parentElement;
    let nested = false;
    while (p) {
      if (seen.has(p)) {
        nested = true;
        break;
      }
      p = p.parentElement;
    }
    if (nested) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 20) continue;
    seen.add(el);
    out.push({
      selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/)[0] : ''}`,
      rect: {
        x: Math.round(r.x + scrollX),
        y: Math.round(r.y + scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
    if (out.length >= 5) break;
  }
  return out;
}

export interface BannerShift {
  value: number;
  reason: 'banner-moved' | 'pushed-by-banner';
  selector: string;
}

/** Pure attribution. */
export function attributeBannerShifts(entries: CLSEntry[], banners: BannerRect[] = []): BannerShift[] {
  const topBanners = banners.filter((b) => b.rect.y <= 5 && b.rect.height >= 20);
  const out: BannerShift[] = [];
  for (const e of entries) {
    if (!e || !(e.value > 0)) continue;
    const srcs = e.sources ?? [];
    const own = srcs.find((s) => CMP_PATTERN.test(s.selector ?? ''));
    if (own) {
      out.push({ value: e.value, reason: 'banner-moved', selector: own.selector ?? '' });
      continue;
    }
    if (topBanners.length === 0 || srcs.length === 0) continue;
    const deltas = srcs.map((s) => (s.previousRect && s.currentRect ? s.currentRect.y - s.previousRect.y : Number.NaN));
    if (deltas.some((d) => !Number.isFinite(d))) continue;
    const match = topBanners.find((b) => deltas.every((d) => Math.abs(d - b.rect.height) <= 8));
    if (match) out.push({ value: e.value, reason: 'pushed-by-banner', selector: match.selector });
  }
  return out;
}

export function bannerClsIssues(shifts: BannerShift[]): Issue[] {
  const total = shifts.reduce((s, x) => s + x.value, 0);
  if (total < BANNER_CLS_THRESHOLD) return [];
  const sels = [...new Set(shifts.map((s) => s.selector).filter(Boolean))].slice(0, 3);
  const pushed = shifts.some((s) => s.reason === 'pushed-by-banner');
  return [
    {
      message: BANNER_CLS_MESSAGE,
      detail: `Layout shifts worth ${total.toFixed(3)} CLS are caused by the cookie/consent banner${sels.length ? ` (${sels.map(escapeHtml).join(', ')})` : ''}${pushed ? ', which is inserted above the content and pushes it down' : ''}. Show the banner as a fixed/sticky overlay or reserve its space in the initial layout so it does not move the page.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

export class ClsAttributionAnalyzer {
  /** `entries` = the full max-session CLS entries (not the 5-entry slice stored on pageData.vitals). */
  static async analyze(page: PageLike | null, entries: CLSEntry[] | undefined) {
    if (!entries || entries.length === 0) return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    let banners: BannerRect[] = [];
    if (page) {
      try {
        banners = await page.evaluate(findConsentBanners);
      } catch {
        banners = [];
      }
    }
    const shifts = attributeBannerShifts(entries, banners);
    return {
      issues: bannerClsIssues(shifts),
      warnings: [] as Issue[],
      info: { bannerCls: Number(shifts.reduce((s, x) => s + x.value, 0).toFixed(4)), shifts: shifts.length },
    };
  }
}
