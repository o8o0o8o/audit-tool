/**
 * Site-wide favicon and web app manifest checks.
 * Fetches each distinct icon/manifest once per audit. Outcomes that cannot be
 * verified (timeouts, network errors, URLs blocked by isFetchAllowed, data:/blob:
 * hrefs) never produce a finding.
 */

import type { Issue, PageInfo } from '../../types';
import { SEVERITY } from '../../constants';
import { isFetchAllowed } from '../../../validators';
import { escapeHtml } from '../../reports/html-utils';
import { parse } from 'node-html-parser';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FaviconManifestOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface ProbeResult {
  status: number;
  contentType: string;
  bytes?: Uint8Array;
}

const FETCH_TIMEOUT_MS = 10000;
const MAX_ICON_URLS = 20;
const MAX_MANIFEST_URLS = 5;
const MAX_MANIFEST_ICONS = 20;
const MIN_FAVICON_PX = 48;
const MAX_REDIRECTS = 5;
const HEAD_RETRY_STATUSES = new Set([403, 405, 501]);
const FAVICON_RELS = new Set(['icon', 'shortcut icon']);

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function originHostOf(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

function link(url: string): string {
  const safe = escapeHtml(url);
  return `<a href="${safe}">${safe}</a>`;
}

class Prober {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #originHost: string | undefined;

  constructor(origin: string, opts: FaviconManifestOptions) {
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.#originHost = originHostOf(origin);
  }

  canFetch(url: string): boolean {
    return isHttpUrl(url) && isFetchAllowed(url, { originHost: this.#originHost }).allowed;
  }

  async #request(url: string, method: 'HEAD' | 'GET', readBody: boolean): Promise<ProbeResult | undefined> {
    try {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      let current = url;
      let res: Response | undefined;
      // Follow redirects by hand so every hop is re-checked against isFetchAllowed (SSRF).
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const r = await this.#fetch(current, { method, redirect: 'manual', signal });
        const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
        if (!location) {
          res = r;
          break;
        }
        const next = new URL(location, current).href;
        if (!this.canFetch(next)) return undefined;
        current = next;
      }
      if (!res) return undefined;
      const result: ProbeResult = {
        status: res.status,
        contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      };
      if (readBody && res.ok) result.bytes = new Uint8Array(await res.arrayBuffer());
      return result;
    } catch {
      return undefined;
    }
  }

  /** GET with body, for assets whose bytes are inspected. */
  async get(url: string): Promise<ProbeResult | undefined> {
    if (!this.canFetch(url)) return undefined;
    return this.#request(url, 'GET', true);
  }

  /** HEAD, retried as GET when the server rejects HEAD or the request errors. */
  async status(url: string): Promise<ProbeResult | undefined> {
    if (!this.canFetch(url)) return undefined;
    const head = await this.#request(url, 'HEAD', false);
    if (head && !HEAD_RETRY_STATUSES.has(head.status)) return head;
    return (await this.#request(url, 'GET', false)) ?? head;
  }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Largest pixel dimension read from PNG, GIF or ICO header bytes. */
export function readImageSize(bytes: Uint8Array): number | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Math.max(view.getUint32(16), view.getUint32(20));
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Math.max(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    const count = bytes[4] | (bytes[5] << 8);
    let largest = 0;
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      if (offset + 2 > bytes.length) break;
      // A stored 0 means 256px in the ICO directory format.
      const w = bytes[offset] || 256;
      const h = bytes[offset + 1] || 256;
      largest = Math.max(largest, w, h);
    }
    return largest || undefined;
  }
  return undefined;
}

function sizeFromSizesAttr(sizes: string | undefined): number | undefined {
  if (!sizes) return undefined;
  let largest = 0;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const m = /^(\d+)x(\d+)$/.exec(token);
    if (m) largest = Math.max(largest, Number(m[1]), Number(m[2]));
  }
  return largest || undefined;
}

function isNonImageType(contentType: string): boolean {
  if (!contentType) return false;
  return !contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream');
}

interface ResolvedPages {
  pages: Record<string, PageInfo>;
  /** Head links of some pages are unknown and the homepage could not be read. */
  unknown: boolean;
}

/**
 * Pages restored from a checkpoint written before head links were captured have
 * no `icons` field. Their icon/manifest links are read from the homepage instead,
 * so a resumed audit does not report a false "Favicon missing".
 */
async function resolveHeadLinks(
  pages: Record<string, PageInfo>,
  origin: string,
  prober: Prober,
): Promise<ResolvedPages> {
  if (!Object.values(pages).some((p) => p.icons === undefined)) return { pages, unknown: false };
  let home: string;
  try {
    home = new URL('/', origin).href;
  } catch {
    return { pages, unknown: true };
  }
  const res = await prober.get(home);
  if (!res || !isOk(res.status) || !res.bytes) return { pages, unknown: true };
  const icons: NonNullable<PageInfo['icons']> = [];
  let manifest: string | undefined;
  try {
    const doc = parse(new TextDecoder().decode(res.bytes));
    for (const el of doc.querySelectorAll('link[rel][href]')) {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
      let href: string;
      try {
        href = new URL(el.getAttribute('href') ?? '', home).href;
      } catch {
        continue;
      }
      if (rel === 'manifest') manifest ??= href;
      else if (FAVICON_RELS.has(rel) || rel.startsWith('apple-touch-icon')) {
        icons.push({ href, rel, sizes: el.getAttribute('sizes') ?? undefined });
      }
    }
  } catch {
    return { pages, unknown: true };
  }
  const homePage = { url: home, icons, manifest } as PageInfo;
  return { pages: { ...pages, [`${home}#head-links`]: homePage }, unknown: false };
}

export async function checkFavicon(
  pages: Record<string, PageInfo>,
  origin: string,
  opts: FaviconManifestOptions = {},
): Promise<{ issues: Issue[]; warnings: Issue[] }> {
  const prober = new Prober(origin, opts);
  return checkFaviconResolved(await resolveHeadLinks(pages, origin, prober), origin, prober);
}

async function checkFaviconResolved(
  { pages, unknown }: ResolvedPages,
  origin: string,
  prober: Prober,
): Promise<{ issues: Issue[]; warnings: Issue[] }> {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];

  const icons = new Map<string, { sizes?: string }>();
  let hasAnyIconLink = false;
  for (const page of Object.values(pages)) {
    for (const icon of page.icons ?? []) {
      if (!icon.href || !FAVICON_RELS.has(icon.rel ?? '')) continue;
      hasAnyIconLink = true;
      if (isHttpUrl(icon.href) && !icons.has(icon.href) && icons.size < MAX_ICON_URLS) {
        icons.set(icon.href, { sizes: icon.sizes });
      }
    }
  }

  if (!hasAnyIconLink) {
    if (unknown) return { issues, warnings };
    let fallback: string;
    try {
      fallback = new URL('/favicon.ico', origin).href;
    } catch {
      return { issues, warnings };
    }
    const res = await prober.status(fallback);
    if (res && (!isOk(res.status) || res.contentType.includes('text/html'))) {
      issues.push({
        message: 'Favicon missing',
        detail: `No <code>&lt;link rel="icon"&gt;</code> on any page and ${link(fallback)} returned ${
          isOk(res.status) ? 'an HTML page' : `HTTP ${res.status}`
        }. Browsers and search results show a blank icon.`,
        severity: SEVERITY.MEDIUM,
      });
    }
    return { issues, warnings };
  }

  let largestSize = 0;
  let measured = false;
  for (const [url, meta] of icons) {
    const res = await prober.get(url);
    if (!res) continue;
    if (!isOk(res.status)) {
      issues.push({
        message: 'Favicon returns error status',
        detail: `Favicon ${link(url)} returned HTTP ${res.status}.`,
        severity: SEVERITY.MEDIUM,
      });
      continue;
    }
    if (isNonImageType(res.contentType)) {
      issues.push({
        message: 'Favicon is not an image',
        detail: `Favicon ${link(url)} is served as <code>${escapeHtml(res.contentType)}</code>, not an image.`,
        severity: SEVERITY.MEDIUM,
      });
      continue;
    }
    if (res.contentType.includes('svg')) continue;
    const size = (res.bytes && readImageSize(res.bytes)) ?? sizeFromSizesAttr(meta.sizes);
    if (size) {
      measured = true;
      largestSize = Math.max(largestSize, size);
    }
  }

  if (measured && largestSize < MIN_FAVICON_PX) {
    warnings.push({
      message: 'Favicon smaller than 48px',
      detail: `The largest favicon is ${largestSize}px. Google recommends at least ${MIN_FAVICON_PX}×${MIN_FAVICON_PX}px for search results.`,
      severity: SEVERITY.LOW,
    });
  }

  return { issues, warnings };
}

function manifestUrlOf(page: PageInfo): string | undefined {
  const m = page.manifest;
  if (typeof m === 'string') return m;
  return m?.url;
}

export async function checkManifest(
  pages: Record<string, PageInfo>,
  origin: string,
  opts: FaviconManifestOptions = {},
): Promise<{ issues: Issue[]; warnings: Issue[] }> {
  const prober = new Prober(origin, opts);
  return checkManifestResolved((await resolveHeadLinks(pages, origin, prober)).pages, prober);
}

async function checkManifestResolved(
  pages: Record<string, PageInfo>,
  prober: Prober,
): Promise<{ issues: Issue[]; warnings: Issue[] }> {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];

  const manifestUrls = new Set<string>();
  for (const page of Object.values(pages)) {
    const url = manifestUrlOf(page);
    if (url && isHttpUrl(url) && manifestUrls.size < MAX_MANIFEST_URLS) manifestUrls.add(url);
  }

  for (const manifestUrl of manifestUrls) {
    const res = await prober.get(manifestUrl);
    if (!res) continue;
    if (!isOk(res.status)) {
      issues.push({
        message: 'Web manifest failed to load',
        detail: `Manifest ${link(manifestUrl)} returned HTTP ${res.status}.`,
        severity: SEVERITY.MEDIUM,
      });
      continue;
    }

    const text = new TextDecoder().decode(res.bytes ?? new Uint8Array());
    // Only validity is checked here; manifest content (fields, icon sizes,
    // maskable) is out of scope for this fetch check.
    let parsed: { icons?: Array<{ src?: unknown }> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (error: unknown) {
      issues.push({
        message: 'Invalid manifest JSON',
        detail: `Manifest could not be parsed: ${(error as Error).message} (${link(manifestUrl)})`,
        severity: SEVERITY.MEDIUM,
      });
      continue;
    }
    if (!Array.isArray(parsed?.icons)) continue;

    const iconUrls = new Set<string>();
    for (const icon of parsed.icons) {
      if (typeof icon?.src !== 'string' || iconUrls.size >= MAX_MANIFEST_ICONS) continue;
      try {
        iconUrls.add(new URL(icon.src, manifestUrl).href);
      } catch {}
    }
    for (const iconUrl of iconUrls) {
      const iconRes = await prober.status(iconUrl);
      if (iconRes && iconRes.status >= 400) {
        issues.push({
          message: 'Manifest icon returns 404',
          detail: `Icon ${link(iconUrl)} listed in ${link(manifestUrl)} returned HTTP ${iconRes.status}.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }
  }

  return { issues, warnings };
}

export async function checkFaviconAndManifest(
  pages: Record<string, PageInfo>,
  origin: string,
  opts: FaviconManifestOptions = {},
): Promise<{ issues: Issue[]; warnings: Issue[] }> {
  const prober = new Prober(origin, opts);
  const resolved = await resolveHeadLinks(pages, origin, prober);
  const favicon = await checkFaviconResolved(resolved, origin, prober);
  const manifest = await checkManifestResolved(resolved.pages, prober);
  return {
    issues: [...favicon.issues, ...manifest.issues],
    warnings: [...favicon.warnings, ...manifest.warnings],
  };
}
