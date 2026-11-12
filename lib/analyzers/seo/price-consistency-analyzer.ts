/**
 * Product price consistency: the price in Product JSON-LD should be the price
 * users see. Google's merchant listing / product snippet guidelines require
 * structured data to match the visible page; a mismatch can cost the rich
 * result or trigger a manual action. Pure: (JSON-LD blocks, visible text).
 */

import { parse } from 'node-html-parser';
import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';

export const PRICE_NOT_SHOWN_MESSAGE = 'Product schema price not shown on the page';

export interface SchemaProductPrice {
  name: string;
  prices: number[];
  currency?: string;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const typesOf = (n: Json) => asArray(n['@type']).map((t) => String(t).replace(/^.*[/#]/, ''));

function toPrice(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  // schema.org says '.' decimal, but tolerate "1,299.00" and "1299,00"
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  const decimals = lastSep >= 0 ? s.length - lastSep - 1 : 0;
  const n =
    lastSep >= 0 && decimals > 0 && decimals <= 2
      ? Number(s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + s.slice(lastSep + 1))
      : Number(s.replace(/[.,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function offerPrices(offer: unknown, out: number[], currencies: string[]): void {
  for (const o of asArray(offer)) {
    if (!isObj(o)) continue;
    for (const key of ['price', 'lowPrice', 'highPrice']) {
      const p = toPrice(o[key]);
      if (p !== null) out.push(p);
    }
    for (const spec of asArray(o.priceSpecification)) {
      if (isObj(spec)) {
        const p = toPrice(spec.price);
        if (p !== null) out.push(p);
      }
    }
    if (typeof o.priceCurrency === 'string') currencies.push(o.priceCurrency);
    if (o.offers) offerPrices(o.offers, out, currencies); // AggregateOffer.offers
  }
}

/** Collect Product nodes (incl. @graph, arrays, nesting) with their offer prices. */
export function productPricesFromJsonLd(blocks: unknown[]): SchemaProductPrice[] {
  const products: SchemaProductPrice[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const obj = node as Json;
    if (typesOf(obj).some((t) => t === 'Product' || t === 'ProductModel' || t === 'IndividualProduct')) {
      const prices: number[] = [];
      const currencies: string[] = [];
      offerPrices(obj.offers, prices, currencies);
      if (prices.length > 0)
        products.push({
          name: typeof obj.name === 'string' ? obj.name : 'Product',
          prices: [...new Set(prices)],
          currency: currencies[0],
        });
    }
    for (const [k, v] of Object.entries(obj)) if (k !== 'offers') walk(v, depth + 1);
  };
  for (const b of blocks) {
    let v = b;
    if (typeof b === 'string') {
      try {
        v = JSON.parse(b);
      } catch {
        continue;
      }
    }
    walk(v, 0);
  }
  return products;
}

/** Every numeric value a visible-text token could denote (both decimal conventions). */
export function numbersInText(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\d+(?:(?:[.,'\u2019]|[ \u00a0\u202f](?=\d{3}(?!\d)))\d+)*/g;
  const add = (n: number) => {
    if (Number.isFinite(n)) out.add(Math.round(n * 100) / 100);
  };
  for (const m of text.matchAll(re)) {
    const tok = m[0].replace(/[ \u00a0\u202f'\u2019]/g, '');
    const seps = [...tok.matchAll(/[.,]/g)].map((x) => x.index ?? 0);
    if (seps.length === 0) {
      add(Number(tok));
      continue;
    }
    const last = seps[seps.length - 1];
    const intPart = tok.slice(0, last).replace(/[.,]/g, '');
    const frac = tok.slice(last + 1);
    add(Number(tok.replace(/[.,]/g, ''))); // all separators are thousands
    if (frac.length <= 3) add(Number(`${intPart}.${frac}`)); // last separator is decimal
  }
  return out;
}

export function priceShown(price: number, visible: Set<number>): boolean {
  const p = Math.round(price * 100) / 100;
  if (visible.has(p)) return true;
  // superscript cents rendered as "$12" + "99" → "1299"
  if (!Number.isInteger(p) && visible.has(Math.round(p * 100))) return true;
  return false;
}

/** Pure decision. */
export function priceConsistencyIssues(blocks: unknown[], visibleText: string): Issue[] {
  const products = productPricesFromJsonLd(blocks);
  if (products.length === 0 || !visibleText.trim()) return [];
  const visible = numbersInText(visibleText);
  const missing = products.filter((p) => !p.prices.some((price) => priceShown(price, visible)));
  if (missing.length === 0) return [];
  const examples = missing
    .slice(0, 3)
    .map((p) => `"${escapeHtml(p.name)}" ${p.prices.join(' / ')}${p.currency ? ` ${escapeHtml(p.currency)}` : ''}`)
    .join('; ');
  return [
    {
      message: PRICE_NOT_SHOWN_MESSAGE,
      detail: `The Product structured data declares a price that does not appear anywhere in the visible page text: ${examples}. Google requires product markup to match what users see; a stale or mismatched price can lose the product rich result. Update the schema price (or the displayed price) so they agree, including after sale or currency changes.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

/** JSON-LD script bodies from an HTML string. */
export function jsonLdBlocks(html: string): string[] {
  const root = parse(html, { blockTextElements: { script: true } });
  return root
    .querySelectorAll('script')
    .filter((s) => (s.getAttribute('type') ?? '').trim().toLowerCase() === 'application/ld+json')
    .map((s) => s.rawText);
}

export class PriceConsistencyAnalyzer {
  static analyze(renderedHtml: string | undefined, visibleText: string | undefined) {
    if (!renderedHtml || !visibleText) return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    try {
      const blocks = jsonLdBlocks(renderedHtml);
      return {
        issues: priceConsistencyIssues(blocks, visibleText),
        warnings: [] as Issue[],
        info: { products: productPricesFromJsonLd(blocks).length },
      };
    } catch {
      return { issues: [] as Issue[], warnings: [] as Issue[], info: null };
    }
  }
}
