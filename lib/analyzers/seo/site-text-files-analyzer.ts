/**
 * Site text files analyzer: security.txt (RFC 9116) and ads.txt / app-ads.txt (IAB).
 * Each file is fetched once per audit, before the crawl.
 */

import { SEVERITY } from '../../constants';
import type { Issue, SiteTextFileInfo } from '../../types';

const FETCH_TIMEOUT_MS = 10000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface TextFileFetch {
  /** true = served, false = absent (non-2xx, HTML soft-404, cross-host redirect), undefined = network error */
  found: boolean | undefined;
  body: string;
  contentType: string;
}

export function looksLikeHtml(body: string, contentType = ''): boolean {
  if (/text\/html/i.test(contentType)) return true;
  return /^\s*(?:<!doctype|<html)/i.test(body);
}

/** Hosts match when equal after stripping one leading `www.`. */
export function sameSiteHost(a: string, b: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return norm(a) === norm(b);
}

export async function fetchTextFile(url: string): Promise<TextFileFetch> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch {
    return { found: undefined, body: '', contentType: '' };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) return { found: false, body: '', contentType };
  if (response.url) {
    try {
      if (!sameSiteHost(new URL(response.url).hostname, new URL(url).hostname)) {
        return { found: false, body: '', contentType };
      }
    } catch {
      // unparseable final URL: keep the response
    }
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { found: undefined, body: '', contentType };
  }
  if (looksLikeHtml(body, contentType)) return { found: false, body: '', contentType };
  return { found: true, body, contentType };
}

/** Strip an OpenPGP cleartext-signature wrapper (RFC 4880 §7); the signature is not verified. */
export function stripPgpCleartext(body: string): string {
  if (!/^\s*-----BEGIN PGP SIGNED MESSAGE-----/.test(body)) return body;
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let i = lines.findIndex((l) => l.startsWith('-----BEGIN PGP SIGNED MESSAGE-----')) + 1;
  while (i < lines.length && lines[i].trim() !== '') i++;
  i++;
  const out: string[] = [];
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('-----BEGIN PGP SIGNATURE-----')) break;
    out.push(lines[i].startsWith('- ') ? lines[i].slice(2) : lines[i]);
  }
  return out.join('\n');
}

export interface ParsedSecurityTxt {
  fields: Record<string, string[]>;
}

export function parseSecurityTxt(body: string): ParsedSecurityTxt {
  const fields: Record<string, string[]> = {};
  for (const raw of stripPgpCleartext(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    (fields[key] ??= []).push(m[2].trim());
  }
  return { fields };
}

/** Findings for a served security.txt body. */
export function securityTxtIssues(body: string, contentType: string, now: Date, legacyOnly: boolean): Issue[] {
  const issues: Issue[] = [];
  const { fields } = parseSecurityTxt(body);
  if (!fields.contact?.length) {
    issues.push({
      message: 'security.txt has no Contact field',
      detail: 'RFC 9116 requires at least one Contact field (mailto: or https: URL) so researchers can report vulnerabilities.',
      severity: SEVERITY.MEDIUM,
    });
  }
  const expiresRaw = fields.expires?.[0];
  const expires = expiresRaw ? Date.parse(expiresRaw) : NaN;
  if (Number.isNaN(expires) || expires <= now.getTime()) {
    issues.push({
      message: 'security.txt Expires field is missing, invalid or in the past',
      detail: expiresRaw
        ? `Expires is "${expiresRaw}". RFC 9116 requires a valid future ISO 8601 date.`
        : 'RFC 9116 requires an Expires field with a future ISO 8601 date.',
      severity: SEVERITY.MEDIUM,
    });
  } else if (expires - now.getTime() > ONE_YEAR_MS) {
    issues.push({
      message: 'security.txt Expires is more than a year ahead',
      detail: `Expires is "${expiresRaw}". RFC 9116 recommends an Expires less than a year in the future.`,
      severity: SEVERITY.LOW,
    });
  }
  if (!/^text\/plain/i.test(contentType.trim())) {
    issues.push({
      message: 'security.txt is not served as text/plain',
      detail: `Content-Type is "${contentType || '(none)'}"; RFC 9116 requires text/plain.`,
      severity: SEVERITY.LOW,
    });
  }
  if (legacyOnly) {
    issues.push({
      message: 'security.txt found only at the legacy /security.txt location',
      detail: 'Serve it at /.well-known/security.txt; the root location is legacy only.',
      severity: SEVERITY.LOW,
    });
  }
  return issues;
}

const ADS_VARIABLE = /^[A-Za-z_-]+\s*=/;
const ADS_RECORD = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*,\s*[^,\s]+\s*,\s*(?:DIRECT|RESELLER)\s*(?:,\s*[^,\s]+\s*)?$/i;

/** Returns the 1-based numbers and text of invalid record lines. */
export function validateAdsTxtLines(body: string): { line: number; text: string }[] {
  const invalid: { line: number; text: string }[] = [];
  body.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || ADS_VARIABLE.test(line)) return;
    if (!ADS_RECORD.test(line)) invalid.push({ line: idx + 1, text: raw.trim() });
  });
  return invalid;
}

function adsIssue(file: 'ads.txt' | 'app-ads.txt', invalid: { line: number; text: string }[]): Issue {
  const sample = invalid
    .slice(0, 5)
    .map((l) => `line ${l.line}: ${l.text}`)
    .join('; ');
  return {
    message: `${file} has invalid record lines`,
    detail: `${invalid.length} line(s) do not match "domain, publisher-id, DIRECT|RESELLER[, cert-id]": ${sample}`,
    severity: SEVERITY.LOW,
  };
}

export class SiteTextFilesAnalyzer {
  static async analyzeSecurityTxt(origin: string, now: Date = new Date()) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: SiteTextFileInfo = { found: undefined };

    const wellKnownUrl = `${origin}/.well-known/security.txt`;
    const wellKnown = await fetchTextFile(wellKnownUrl);
    let file = wellKnown;
    let url = wellKnownUrl;
    let legacyOnly = false;
    if (wellKnown.found === false) {
      url = `${origin}/security.txt`;
      file = await fetchTextFile(url);
      legacyOnly = file.found === true;
    }
    info.found = file.found;
    if (file.found === true) info.url = url;

    if (file.found === false) {
      issues.push({
        message: 'security.txt missing',
        detail: 'No /.well-known/security.txt found. RFC 9116 security.txt tells researchers how to report vulnerabilities.',
        severity: SEVERITY.LOW,
      });
    } else if (file.found === true) {
      issues.push(...securityTxtIssues(file.body, file.contentType, now, legacyOnly));
    }
    return { issues, warnings, info };
  }

  static async analyzeAdsTxt(origin: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const [ads, appAds] = await Promise.all([
      fetchTextFile(`${origin}/ads.txt`),
      fetchTextFile(`${origin}/app-ads.txt`),
    ]);
    const adsTxt: SiteTextFileInfo = { found: ads.found };
    const appAdsTxt: SiteTextFileInfo = { found: appAds.found };
    if (ads.found) {
      const invalid = validateAdsTxtLines(ads.body);
      adsTxt.invalidLines = invalid.length;
      if (invalid.length) issues.push(adsIssue('ads.txt', invalid));
    }
    if (appAds.found) {
      const invalid = validateAdsTxtLines(appAds.body);
      appAdsTxt.invalidLines = invalid.length;
      if (invalid.length) issues.push(adsIssue('app-ads.txt', invalid));
    }
    return { issues, warnings, info: { adsTxt, appAdsTxt } };
  }
}
