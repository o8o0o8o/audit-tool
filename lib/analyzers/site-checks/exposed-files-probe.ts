/**
 * Probes for files that should never be public: VCS metadata (.git, .svn),
 * .env, .DS_Store, .htpasswd, backups and database dumps, phpinfo() pages and
 * directory listings. Runs once, after the crawl, so a WAF that blocks these
 * probes cannot affect the crawl. Each hit is confirmed by the response body
 * (magic bytes or file syntax), so a catch-all 200 page is never a finding.
 * Stops early when the server answers with repeated 403/429 (WAF / rate limit).
 */

import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';
import type { SiteCheckResult, SiteProbeResult } from './site-checks-types';

const MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 3;

export interface ProbeResponse {
  status: number;
  bytes: Uint8Array;
}

export type ProbeFetcher = (url: string) => Promise<ProbeResponse | null>;

const text = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);
const startsWith = (b: Uint8Array, magic: number[]) => magic.every((v, i) => b[i] === v);
const looksHtml = (s: string) => /^\s*(?:<!doctype|<html|<head|<body)/i.test(s);

export interface ProbeTarget {
  path: string;
  message: string;
  severity: SeverityLevel;
  why: string;
  confirm: (bytes: Uint8Array) => boolean;
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const GZIP = [0x1f, 0x8b];
const SQLITE = Array.from('SQLite format 3').map((c) => c.charCodeAt(0));

const isSqlDump = (b: Uint8Array) => {
  const s = text(b);
  return !looksHtml(s) && /\b(?:CREATE TABLE|INSERT INTO|-- MySQL dump|PostgreSQL database dump)\b/i.test(s);
};
const isPhpSource = (b: Uint8Array) =>
  /<\?php/i.test(text(b)) && /\b(?:DB_PASSWORD|define\s*\(|\$\w+\s*=)/.test(text(b));
const isArchive = (b: Uint8Array) => startsWith(b, ZIP) || startsWith(b, GZIP);

const BACKUP = {
  message: 'Backup or database dump publicly downloadable',
  severity: SEVERITY.HIGH,
  why: 'Backups and dumps usually contain source code, credentials or customer data.',
};

export const PROBE_TARGETS: ProbeTarget[] = [
  {
    path: '/.git/HEAD',
    message: 'Git repository exposed',
    severity: SEVERITY.CRITICAL,
    why: 'An exposed .git directory lets anyone download the full source code and history, often including secrets.',
    confirm: (b) => /^(?:ref: refs\/|[0-9a-f]{40}\s*$)/.test(text(b)),
  },
  {
    path: '/.git/config',
    message: 'Git repository exposed',
    severity: SEVERITY.CRITICAL,
    why: 'An exposed .git directory lets anyone download the full source code and history, often including secrets.',
    confirm: (b) => /^\s*\[core\]/m.test(text(b)) && !looksHtml(text(b)),
  },
  {
    path: '/.svn/wc.db',
    message: 'Subversion metadata exposed',
    severity: SEVERITY.HIGH,
    why: 'Exposed .svn metadata reveals file names and can leak source code.',
    confirm: (b) => startsWith(b, SQLITE),
  },
  {
    path: '/.env',
    message: '.env file exposed',
    severity: SEVERITY.CRITICAL,
    why: '.env files hold environment secrets such as database passwords and API keys.',
    confirm: (b) => {
      const s = text(b);
      return !looksHtml(s) && (s.match(/^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/gm) ?? []).length >= 2;
    },
  },
  {
    path: '/.DS_Store',
    message: '.DS_Store file exposed',
    severity: SEVERITY.LOW,
    why: '.DS_Store files list the names of files in the folder, which can reveal hidden paths.',
    confirm: (b) => startsWith(b, [0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]),
  },
  {
    path: '/.htpasswd',
    message: '.htpasswd file exposed',
    severity: SEVERITY.HIGH,
    why: '.htpasswd holds password hashes for HTTP authentication.',
    confirm: (b) => {
      const s = text(b);
      return !looksHtml(s) && /^[^:\s<]+:(?:\$apr1\$|\$2[aby]\$|\{SHA\}|[./0-9A-Za-z]{13}$)/m.test(s);
    },
  },
  ...['/backup.zip', '/backup.tar.gz', '/site.zip', '/www.zip', '/public_html.zip'].map((path) => ({
    path,
    ...BACKUP,
    confirm: isArchive,
  })),
  ...['/backup.sql', '/dump.sql', '/db.sql', '/database.sql'].map((path) => ({ path, ...BACKUP, confirm: isSqlDump })),
  ...['/wp-config.php.bak', '/wp-config.php~', '/wp-config.php.save', '/config.php.bak'].map((path) => ({
    path,
    ...BACKUP,
    confirm: isPhpSource,
  })),
  {
    path: '/phpinfo.php',
    message: 'phpinfo() page exposed',
    severity: SEVERITY.MEDIUM,
    why: 'phpinfo() output reveals server paths, module versions and environment variables.',
    confirm: (b) => /phpinfo\(\)/.test(text(b)) && /PHP Version/i.test(text(b)),
  },
];

export const DIRECTORY_LISTING = /<title>\s*Index of \/|<h1>\s*Index of \/|Directory listing for \//i;

const defaultFetcher: ProbeFetcher = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, bytes: new Uint8Array() };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
    await reader.cancel().catch(() => undefined);
    const bytes = new Uint8Array(Math.min(total, MAX_BYTES));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, bytes.length - off);
      bytes.set(c.subarray(0, take), off);
      off += take;
      if (off >= bytes.length) break;
    }
    return { status: res.status, bytes };
  } catch {
    return null;
  }
};

/** First-level directories of same-origin asset URLs (e.g. /uploads/, /assets/), max `limit`. */
export function candidateDirectories(origin: string, assetUrls: Iterable<string>, limit = 6): string[] {
  const dirs = new Set<string>(['/uploads/', '/wp-content/uploads/']);
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return [...dirs];
  }
  for (const u of assetUrls) {
    if (dirs.size >= limit) break;
    try {
      const url = new URL(u, origin);
      if (url.host !== host) continue;
      const first = url.pathname.split('/').filter(Boolean);
      if (first.length >= 2) dirs.add(`/${first[0]}/`);
    } catch {
      /* skip */
    }
  }
  return [...dirs].slice(0, limit);
}

export class ExposedFilesProbe {
  static async probe(
    origin: string,
    directories: string[] = [],
    fetcher: ProbeFetcher = defaultFetcher,
  ): Promise<SiteProbeResult> {
    const issues: Issue[] = [];
    const base = origin.replace(/\/$/, '');
    const hits = new Map<string, { target: Omit<ProbeTarget, 'confirm' | 'path'>; urls: string[] }>();
    let blocked = 0;
    let stopped = false;

    const jobs: Array<() => Promise<void>> = [
      ...PROBE_TARGETS.map((t) => async () => {
        const res = await fetcher(base + t.path);
        if (!res) return;
        if (res.status === 403 || res.status === 429) blocked++;
        if (res.status !== 200 || !t.confirm(res.bytes)) return;
        const hit = hits.get(t.message) ?? { target: t, urls: [] };
        hit.urls.push(base + t.path);
        hits.set(t.message, hit);
      }),
      ...directories.map((dir) => async () => {
        const res = await fetcher(base + dir);
        if (!res) return;
        if (res.status === 403 || res.status === 429) blocked++;
        if (res.status !== 200 || !DIRECTORY_LISTING.test(text(res.bytes))) return;
        const msg = 'Directory listing enabled';
        const hit = hits.get(msg) ?? {
          target: {
            message: msg,
            severity: SEVERITY.MEDIUM,
            why: 'Directory listings let anyone browse every file in the folder, including ones not linked from the site.',
          },
          urls: [],
        };
        hit.urls.push(base + dir);
        hits.set(msg, hit);
      }),
    ];

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        if (blocked >= 5) {
          stopped = true;
          return;
        }
        await jobs[next++]();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    for (const { target, urls } of hits.values()) {
      issues.push({
        message: target.message,
        detail: `${target.why} Publicly reachable: ${urls.map((u) => `<a href="${u}">${u}</a>`).join(', ')}. Block or remove ${urls.length > 1 ? 'these paths' : 'this path'} on the web server.`,
        severity: target.severity,
      });
    }

    const check: SiteCheckResult = {
      id: 'exposed-files',
      label: 'Sensitive files',
      status: issues.length ? 'fail' : stopped ? 'skipped' : 'pass',
      note: issues.length
        ? `${hits.size} type${hits.size > 1 ? 's' : ''} exposed`
        : stopped
          ? 'probes blocked by the server (403/429); result incomplete'
          : `${PROBE_TARGETS.length + directories.length} paths checked`,
    };
    return { issues, checks: [check] };
  }
}
