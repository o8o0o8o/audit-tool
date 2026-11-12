/**
 * Site-level analysis of public Google Tag Manager containers.
 *
 * For each GTM container ID seen on the site (capped), fetches
 * `https://www.googletagmanager.com/gtm.js?id=<ID>` once and reads the compiled
 * container config embedded in it:
 *
 *   var data = { "resource": { "version": "727", "macros": [...], "tags": [...],
 *                "predicates": [...], "rules": [...] },
 *                "runtime": [...], "entities": {...}, "blob": {...}, ... };
 *
 * Each tag is `{ "function": "__gaawe", "tag_id": 12, "consent": ["list", "ad_storage"]?,
 * "vtp_*": ... }`. Values may be literals or references such as `["macro", 35]`
 * (index into `resource.macros`; constant macros are `{ "function": "__c", "vtp_value": "G-..." }`).
 *
 * Notes from real containers:
 * - An unknown / never-published ID still returns HTTP 200 with an empty stub
 *   (`"version":"1"` and empty macros/tags), so that is treated as "fails to load".
 * - The whole gtm.js response is 0.5–1 MB because it bundles the runtime library;
 *   the container config ("resource" JSON) is what GTM's 200 KB size limit is about,
 *   so size checks use the byte length of that JSON (an approximation: GTM measures
 *   its own compiled form).
 * - Paused tags compile to `{ "function": "__paused", "vtp_originalTagType": "ua" }`
 *   and are excluded from tag-type checks.
 * - Per-tag `consent` lists only *additional* consent requirements; a missing value
 *   is indistinguishable from "no additional consent needed" (and Google tags have
 *   built-in consent checks), so no "tags without consent settings" finding is made.
 */

import { SEVERITY } from '../../constants';
import { escapeHtml } from '../../reports/html-utils';
import type { Issue } from '../../types';
import { defaultHttpFetcher, plural, type HttpProbeFetcher } from '../site-checks/http-probe';
import type { SiteCheckResult } from '../site-checks/site-checks-types';

export const GTM_MAX_CONTAINERS = 3;
export const GTM_FETCH_TIMEOUT_MS = 15_000;
export const GTM_MAX_BYTES = 2 * 1024 * 1024;
/**
 * GTM refuses to publish containers over 200 KB (its own compiled measure) and warns
 * from 70%. The config JSON in the published gtm.js runs larger than GTM's figure
 * (a live 279 KB one was still publishable), so flag at 180 KB of that JSON: in
 * practice the container is then close to or over GTM's warning band.
 */
export const GTM_SIZE_WARN_BYTES = 180 * 1024;
export const GTM_SIZE_LIMIT_BYTES = 200 * 1024;
export const GTM_CUSTOM_HTML_WARN = 10;

export const GTM_FINDING_MESSAGES = {
  failsToLoad: 'GTM container fails to load',
  universalAnalytics: 'GTM container still has Universal Analytics tags',
  unknownIds: 'GTM container sends to IDs not found on the site',
  nearSizeLimit: 'GTM container is close to the size limit',
  manyCustomHtml: 'Many Custom HTML tags in GTM container',
} as const;

/** Matches every message above (plain text). */
export const GTM_FINDING_PATTERN =
  /^(?:GTM container fails to load|GTM container still has Universal Analytics tags|GTM container sends to IDs not found on the site|GTM container is close to the size limit|Many Custom HTML tags in GTM container)/i;

export interface GtmContainerInfo {
  id: string;
  version: string | null;
  /** Byte length of the embedded container config JSON (falls back to body bytes when it can't be located). */
  sizeBytes: number;
  /** Byte length of the whole gtm.js response (container config + runtime library). */
  responseBytes: number;
  tagCount: number;
  /** Count per tag `function` (e.g. `__gaawe`, `__html`, `__cvt_123_45`). */
  tagTypes: Record<string, number>;
  vendors: string[];
  customHtmlCount: number;
  uaTagCount: number;
  pausedTagCount: number;
  ga4Ids: string[];
  adsIds: string[];
  /** 'json' = config parsed; 'regex' = parse failed, counts come from a regex scan. */
  parsedWith: 'json' | 'regex';
}

export interface GtmContainerResult {
  issues: Issue[];
  checks: SiteCheckResult[];
  info: { containers: GtmContainerInfo[] };
}

// ─── Pure parsing ────────────────────────────────────────────────────────────

/**
 * Returns the JSON text of the object following `"<key>":` by balanced-brace
 * scanning (string- and escape-aware), or null.
 */
export function extractJsonObject(src: string, key = 'resource'): string | null {
  const at = src.indexOf(`"${key}"`);
  if (at < 0) return null;
  const colon = src.indexOf(':', at + key.length + 2);
  if (colon < 0) return null;
  let start = colon + 1;
  while (start < src.length && /\s/.test(src[start])) start++;
  if (src[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

type Json = unknown;
interface RawTag {
  function?: unknown;
  consent?: unknown;
  [k: string]: Json;
}
interface RawResource {
  version?: unknown;
  macros?: unknown;
  tags?: unknown;
}

const GA4_RE = /^G-[A-Z0-9]{6,}$/;
const ADS_RE = /^AW-\d{6,}$/;
const UA_FUNCS = new Set(['__ua']);
const GOOGLE_ADS_FUNCS = new Set(['__awct', '__sp', '__awud', '__awcc', '__gclidw', '__awec']);

/** Built-in tag functions → vendor. */
const FUNCTION_VENDORS: Record<string, string> = {
  __awct: 'Google Ads',
  __sp: 'Google Ads',
  __awud: 'Google Ads',
  __awcc: 'Google Ads',
  __flc: 'Floodlight',
  __fls: 'Floodlight',
  __baut: 'Bing UET',
  __bzi: 'LinkedIn Insight',
  __hjtc: 'Hotjar',
  __pntr: 'Pinterest',
  __twitter_website_tag: 'Twitter/X',
  __crto: 'Criteo',
  __tdc: 'Taboola',
  __mpm: 'Clarity',
};

/** Patterns searched in a tag's serialized content (Custom HTML, templates, image URLs). */
const CONTENT_VENDORS: [string, RegExp][] = [
  ['Meta Pixel', /connect\.facebook\.net|\bfbq\s*\(/i],
  ['LinkedIn Insight', /snap\.licdn\.com|_linkedin_partner_id|px\.ads\.linkedin\.com/i],
  ['TikTok', /analytics\.tiktok\.com|\bttq\.(?:load|track|page)/i],
  ['Hotjar', /static\.hotjar\.com|\bhjid\b/i],
  ['Clarity', /clarity\.ms/i],
  ['Google Ads', /googleadservices\.com|\bAW-\d{6,}/],
  ['Floodlight', /fls\.doubleclick\.net|\bDC-\d{5,}/],
  ['Bing UET', /bat\.bing\.com|\buetq\b/i],
  ['Pinterest', /s\.pinimg\.com\/ct|ct\.pinterest\.com|\bpintrk\s*\(/i],
  ['Twitter/X', /static\.ads-twitter\.com|\btwq\s*\(|analytics\.twitter\.com/i],
  ['Criteo', /criteo\.(?:net|com)/i],
  ['Taboola', /taboola\.com|\b_tfa\b/i],
  ['Outbrain', /outbrain\.com|\bobApi\b/i],
  ['HubSpot', /js\.hs-scripts\.com|js\.hs-analytics\.net|\b_hsq\b/i],
  ['Segment', /cdn\.segment\.com|analytics\.load\s*\(/i],
];

const sorted = (s: Set<string>) => [...s].sort();

/** Resolves `["macro", n]` to the constant value of a `__c` macro, else returns the value as-is. */
function resolve(value: Json, macros: Json[]): Json {
  if (Array.isArray(value) && value[0] === 'macro' && typeof value[1] === 'number') {
    const m = macros[value[1]];
    if (m && typeof m === 'object' && (m as RawTag).function === '__c') return (m as RawTag).vtp_value;
  }
  return value;
}

/** Collects GA4 (G-) and Google Ads (AW-) IDs a tag sends to. */
function collectTagIds(tag: RawTag, macros: Json[], ga4: Set<string>, ads: Set<string>): void {
  const fn = typeof tag.function === 'string' ? tag.function : '';
  const addId = (raw: Json) => {
    const v = resolve(raw, macros);
    if (typeof v !== 'string') return;
    for (const part of v.split(/[\s,]+/)) {
      const id = part.trim().toUpperCase();
      if (GA4_RE.test(id)) ga4.add(id);
      else if (ADS_RE.test(id)) ads.add(id);
      else if (/^\d{6,}$/.test(id) && GOOGLE_ADS_FUNCS.has(fn)) ads.add(`AW-${id}`);
    }
  };
  for (const key of ['vtp_tagId', 'vtp_measurementId', 'vtp_measurementIdOverride', 'vtp_conversionId']) {
    if (key in tag) addId(tag[key]);
  }
}

function tagVendors(fn: string, tag: RawTag, out: Set<string>): void {
  const v = FUNCTION_VENDORS[fn];
  if (v) out.add(v);
  // Only free-form content (Custom HTML, templates, image tags) is pattern-scanned;
  // structured Google tags would otherwise match on their own IDs.
  if (fn === '__html' || fn === '__img' || fn.startsWith('__cvt_')) {
    const text = JSON.stringify(tag);
    for (const [name, re] of CONTENT_VENDORS) if (re.test(text)) out.add(name);
  }
}

/** Parses a gtm.js body. Never throws; returns null when the body has no recognizable GTM container. */
export function parseGtmContainer(id: string, body: string): GtmContainerInfo | null {
  const responseBytes = Buffer.byteLength(body, 'utf8');
  const json = extractJsonObject(body, 'resource');
  if (json) {
    try {
      const res = JSON.parse(json) as RawResource;
      if (res && typeof res === 'object' && Array.isArray(res.tags)) {
        return summarize(id, res, Buffer.byteLength(json, 'utf8'), responseBytes);
      }
    } catch {
      /* fall through to regex scan */
    }
  }
  return regexScan(id, body, json ? Buffer.byteLength(json, 'utf8') : responseBytes, responseBytes);
}

function summarize(id: string, res: RawResource, sizeBytes: number, responseBytes: number): GtmContainerInfo {
  const macros = Array.isArray(res.macros) ? (res.macros as Json[]) : [];
  const tags = (res.tags as Json[]).filter((t): t is RawTag => !!t && typeof t === 'object');
  const tagTypes: Record<string, number> = {};
  const vendors = new Set<string>();
  const ga4 = new Set<string>();
  const ads = new Set<string>();
  let customHtml = 0;
  let ua = 0;
  let paused = 0;
  for (const tag of tags) {
    const fn = typeof tag.function === 'string' ? tag.function : '(unknown)';
    tagTypes[fn] = (tagTypes[fn] ?? 0) + 1;
    if (fn === '__paused') {
      paused++;
      continue;
    }
    if (fn === '__html') customHtml++;
    if (UA_FUNCS.has(fn)) ua++;
    collectTagIds(tag, macros, ga4, ads);
    tagVendors(fn, tag, vendors);
  }
  return {
    id,
    version: typeof res.version === 'string' || typeof res.version === 'number' ? String(res.version) : null,
    sizeBytes,
    responseBytes,
    tagCount: tags.length,
    tagTypes,
    vendors: sorted(vendors),
    customHtmlCount: customHtml,
    uaTagCount: ua,
    pausedTagCount: paused,
    ga4Ids: sorted(ga4),
    adsIds: sorted(ads),
    parsedWith: 'json',
  };
}

/** Fallback when the config can't be parsed as JSON: count `"function":"__x"` occurrences in the tags area. */
function regexScan(id: string, body: string, sizeBytes: number, responseBytes: number): GtmContainerInfo | null {
  const tagsAt = body.indexOf('"tags"');
  if (tagsAt < 0) return null;
  const end = body.indexOf('"predicates"', tagsAt);
  const area = body.slice(tagsAt, end > tagsAt ? end : undefined);
  const tagTypes: Record<string, number> = {};
  const vendors = new Set<string>();
  for (const m of area.matchAll(/"function"\s*:\s*"(__[\w]+)"/g)) {
    tagTypes[m[1]] = (tagTypes[m[1]] ?? 0) + 1;
    const v = FUNCTION_VENDORS[m[1]];
    if (v) vendors.add(v);
  }
  for (const [name, re] of CONTENT_VENDORS) if (re.test(area)) vendors.add(name);
  const ga4 = new Set([...area.matchAll(/\bG-[A-Z0-9]{6,}\b/g)].map((m) => m[0]));
  const ads = new Set([...area.matchAll(/\bAW-\d{6,}\b/g)].map((m) => m[0]));
  const version = /"version"\s*:\s*"([^"]*)"/.exec(body)?.[1] ?? null;
  return {
    id,
    version,
    sizeBytes,
    responseBytes,
    tagCount: Object.values(tagTypes).reduce((a, b) => a + b, 0),
    tagTypes,
    vendors: sorted(vendors),
    customHtmlCount: tagTypes.__html ?? 0,
    uaTagCount: tagTypes.__ua ?? 0,
    pausedTagCount: tagTypes.__paused ?? 0,
    ga4Ids: sorted(ga4),
    adsIds: sorted(ads),
    parsedWith: 'regex',
  };
}

/** True for the stub Google serves for unknown / never-published IDs (version "1", no tags or macros). */
export function isEmptyStub(body: string): boolean {
  const json = extractJsonObject(body, 'resource');
  if (!json) return false;
  try {
    const r = JSON.parse(json) as RawResource;
    const empty = (v: unknown) => Array.isArray(v) && v.length === 0;
    return empty(r.tags) && empty(r.macros);
  } catch {
    return false;
  }
}

export function normalizeGtmIds(ids: string[]): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim().toUpperCase();
    if (/^GTM-[A-Z0-9]{4,12}$/.test(id)) out.add(id);
  }
  return [...out];
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** One-line summary, e.g. "GTM-ABC v123: 42 tags, 5 Custom HTML, 61 KB". */
export function summarizeContainer(c: GtmContainerInfo): string {
  return `${c.id}${c.version ? ` v${c.version}` : ''}: ${plural(c.tagCount, 'tag')}, ${c.customHtmlCount} Custom HTML, ${kb(c.sizeBytes)}`;
}

/** Findings for one parsed container. */
export function containerFindings(c: GtmContainerInfo, siteGa4Ids: string[], siteAdsIds: string[]): Issue[] {
  const issues: Issue[] = [];
  const id = escapeHtml(c.id);
  if (c.uaTagCount > 0) {
    issues.push({
      message: GTM_FINDING_MESSAGES.universalAnalytics,
      detail: `${id} has ${plural(c.uaTagCount, 'Universal Analytics tag')}. Universal Analytics stopped processing data in July 2024, so these tags only add weight and requests. Remove them (GA4 tags replace them).`,
      severity: SEVERITY.MEDIUM,
    });
  }
  const siteGa4 = new Set(siteGa4Ids.map((s) => s.trim().toUpperCase()));
  if (siteGa4.size > 0) {
    const siteAds = new Set(siteAdsIds.map((s) => s.trim().toUpperCase().replace(/\/.*$/, '')));
    const unknown = [
      ...c.ga4Ids.filter((g) => !siteGa4.has(g)),
      ...c.adsIds.filter((a) => siteAds.size > 0 && !siteAds.has(a)),
    ];
    if (unknown.length > 0) {
      issues.push({
        message: GTM_FINDING_MESSAGES.unknownIds,
        detail: `${id} is configured to send data to ${unknown.map(escapeHtml).join(', ')}, which ${unknown.length === 1 ? 'was' : 'were'} not seen on the crawled pages (site uses ${[...siteGa4].map(escapeHtml).join(', ')}). This can be intentional (tags that fire only on some events or pages, or a second property), but verify these IDs belong to you and are still needed.`,
        severity: SEVERITY.LOW,
      });
    }
  }
  if (c.sizeBytes >= GTM_SIZE_WARN_BYTES) {
    issues.push({
      message: GTM_FINDING_MESSAGES.nearSizeLimit,
      detail: `${id} config is about ${kb(c.sizeBytes)} in the published gtm.js (an estimate: GTM measures its own compiled size, which is usually somewhat smaller). GTM will not publish a container over ${kb(GTM_SIZE_LIMIT_BYTES)} by its measure, and a large container slows every page. Remove unused tags, triggers and variables.`,
      severity: SEVERITY.MEDIUM,
    });
  }
  if (c.customHtmlCount >= GTM_CUSTOM_HTML_WARN) {
    issues.push({
      message: GTM_FINDING_MESSAGES.manyCustomHtml,
      detail: `${id} has ${c.customHtmlCount} Custom HTML tags. Custom HTML runs arbitrary JavaScript, is not covered by template permissions and often duplicates built-in tags. Review them: remove unused ones and replace the rest with built-in or gallery templates where possible.`,
      severity: SEVERITY.LOW,
    });
  }
  return issues;
}

// ─── Analyzer ────────────────────────────────────────────────────────────────

const failure = (id: string, why: string): Issue => ({
  message: GTM_FINDING_MESSAGES.failsToLoad,
  detail: `The site references ${escapeHtml(id)}, but ${escapeHtml(why)}. No tags from this container run. Fix the container ID on the site or publish the container.`,
  severity: SEVERITY.HIGH,
});

export class GtmContainerAnalyzer {
  static async analyze(
    containerIds: string[],
    siteGa4Ids: string[],
    siteAdsIds: string[],
    fetcher: HttpProbeFetcher = defaultHttpFetcher,
  ): Promise<GtmContainerResult> {
    const ids = normalizeGtmIds(containerIds).slice(0, GTM_MAX_CONTAINERS);
    const issues: Issue[] = [];
    const containers: GtmContainerInfo[] = [];
    const notes: string[] = [];
    let failed = false;
    let fetched = 0;

    if (ids.length === 0) {
      return {
        issues,
        checks: [
          { id: 'gtm-container', label: 'GTM container', status: 'skipped', note: 'No GTM container on the site' },
        ],
        info: { containers },
      };
    }

    for (const id of ids) {
      const url = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
      const res = await fetcher(url, { timeoutMs: GTM_FETCH_TIMEOUT_MS, maxBytes: GTM_MAX_BYTES });
      if (!res) {
        notes.push(`${id}: not checked (network error)`);
        continue;
      }
      fetched++;
      const body = res.body;
      let why: string | null = null;
      if (res.status >= 400) why = `gtm.js returns HTTP ${res.status}`;
      else if (!body.trim()) why = 'gtm.js returns an empty response';
      else if (/^\s*</.test(body)) why = 'gtm.js returns HTML instead of JavaScript';
      else if (isEmptyStub(body))
        why = 'gtm.js returns an empty container (the ID does not exist or was never published)';
      if (why) {
        failed = true;
        issues.push(failure(id, why));
        notes.push(`${id}: fails to load`);
        continue;
      }
      const info = parseGtmContainer(id, body);
      if (!info) {
        notes.push(`${id}: not a GTM container format`);
        continue;
      }
      containers.push(info);
      issues.push(...containerFindings(info, siteGa4Ids, siteAdsIds));
      notes.push(summarizeContainer(info));
    }

    const skippedAll = fetched === 0;
    const status: SiteCheckResult['status'] = skippedAll
      ? 'skipped'
      : failed
        ? 'fail'
        : issues.length > 0
          ? 'warn'
          : 'pass';
    return {
      issues,
      checks: [{ id: 'gtm-container', label: 'GTM container', status, note: notes.join('; ') }],
      info: { containers },
    };
  }
}
