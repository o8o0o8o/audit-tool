/**
 * WordPress plugins with known vulnerabilities. Plugin slugs come from crawled
 * asset URLs (/wp-content/plugins/<slug>/...); the version from the plugin's
 * readme.txt "Stable tag", falling back to the asset's ?ver= query. With
 * WPSCAN_API_TOKEN set, each plugin is looked up in the WPScan database (one
 * request per plugin; the free plan allows 25 per day). Without a token the
 * detected plugins are listed in the check note only.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { defaultHttpFetcher, looksHtml, plural, runPool, type HttpProbeFetcher } from './http-probe';
import type { SiteProbeResult } from './site-checks-types';

const MAX_PLUGINS = 30;
const CONCURRENCY = 3;

const PLUGIN_PATH = /\/wp-content\/plugins\/([a-z0-9][a-z0-9_-]*)\//i;

/** slug → `?ver=` version (or null) from asset URLs, first seen wins; capped at 30 slugs. */
export function extractWpPlugins(assetUrls: Iterable<string>, limit = MAX_PLUGINS): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of assetUrls) {
    const m = PLUGIN_PATH.exec(raw);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    let ver: string | null = null;
    try {
      ver = new URL(raw, 'https://x.invalid').searchParams.get('ver');
    } catch {
      /* ignore */
    }
    if (ver && !/^\d+(?:\.\d+)*[\w.-]*$/.test(ver)) ver = null;
    if (!out.has(slug)) {
      if (out.size >= limit) continue;
      out.set(slug, ver);
    } else if (!out.get(slug) && ver) out.set(slug, ver);
  }
  return out;
}

/** "Stable tag:" version from a readme.txt body, or null ("trunk" and HTML pages give null). */
export function parseStableTag(readme: string): string | null {
  if (looksHtml(readme)) return null;
  const m = /^[\s*]*Stable tag:\s*([0-9][\w.-]*)/im.exec(readme);
  return m ? m[1] : null;
}

/** Numeric dotted version compare: -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface WpVuln {
  title: string;
  fixed_in: string | null;
}

/** Vulnerabilities from a WPScan /plugins/<slug> response that affect `version`. */
export function affectingVulns(json: unknown, slug: string, version: string): WpVuln[] {
  const entry = (json as Record<string, { vulnerabilities?: WpVuln[] }> | null)?.[slug];
  const vulns = Array.isArray(entry?.vulnerabilities) ? entry.vulnerabilities : [];
  return vulns.filter((v) => !v.fixed_in || compareVersions(v.fixed_in, version) > 0);
}

export class WordPressPluginsAnalyzer {
  static async analyze(
    origin: string,
    plugins: Map<string, string | null>,
    fetcher: HttpProbeFetcher = defaultHttpFetcher,
    token: string | undefined = process.env.WPSCAN_API_TOKEN,
    /** `readReadme: false` (passive mode): versions come from asset URLs only; no readme.txt is requested. */
    opts: { readReadme?: boolean } = {},
  ): Promise<SiteProbeResult> {
    const base = origin.replace(/\/$/, '');
    const slugs = [...plugins.keys()].slice(0, MAX_PLUGINS);
    const versions = new Map<string, string | null>();
    if (opts.readReadme === false) for (const slug of slugs) versions.set(slug, plugins.get(slug) ?? null);

    await runPool(opts.readReadme === false ? [] : slugs, CONCURRENCY, async (slug) => {
      const res = await fetcher(`${base}/wp-content/plugins/${slug}/readme.txt`, { maxBytes: 16 * 1024 });
      const tag = res?.status === 200 ? parseStableTag(res.body) : null;
      versions.set(slug, tag ?? plugins.get(slug) ?? null);
    });

    const detected = slugs.map((s) => `${s}${versions.get(s) ? ` ${versions.get(s)}` : ''}`).join(', ');
    if (!slugs.length) {
      return {
        issues: [],
        checks: [
          { id: 'wp-plugins', label: 'WordPress plugins', status: 'skipped', note: 'no WordPress plugins detected' },
        ],
      };
    }
    if (!token) {
      return {
        issues: [],
        checks: [
          {
            id: 'wp-plugins',
            label: 'WordPress plugins',
            status: 'skipped',
            note: `${plural(slugs.length, 'plugin')} detected (${detected}); set WPSCAN_API_TOKEN to check vulnerabilities`,
          },
        ],
      };
    }

    const vulnerable: string[] = [];
    let checked = 0;
    let stopped = false;
    for (const slug of slugs) {
      const version = versions.get(slug);
      if (!version || stopped) continue;
      const res = await fetcher(`https://wpscan.com/api/v3/plugins/${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Token token=${token}` },
        maxBytes: 512 * 1024,
      });
      if (!res) continue;
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        stopped = true;
        continue;
      }
      checked++;
      if (res.status !== 200) continue;
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        continue;
      }
      const vulns = affectingVulns(json, slug, version);
      if (!vulns.length) continue;
      const titles = vulns
        .slice(0, 5)
        .map((v) => `${v.title}${v.fixed_in ? ` (fixed in ${v.fixed_in})` : ' (no fix yet)'}`)
        .join('; ');
      vulnerable.push(
        `<strong>${escapeHtml(slug)} ${escapeHtml(version)}</strong>: ${vulns.length} known ${vulns.length === 1 ? 'vulnerability' : 'vulnerabilities'}:${escapeHtml(titles)}${vulns.length > 5 ? ' …' : ''}`,
      );
    }

    const issues: Issue[] = [];
    if (vulnerable.length) {
      issues.push({
        message: 'WordPress plugin with known vulnerabilities',
        detail: `Installed plugin versions with published vulnerabilities (WPScan): ${vulnerable.join(' | ')}. Update the plugins (or remove unused ones).`,
        severity: SEVERITY.HIGH,
      });
    }
    return {
      issues,
      checks: [
        {
          id: 'wp-plugins',
          label: 'WordPress plugins',
          status: vulnerable.length ? 'fail' : checked ? 'pass' : 'skipped',
          note: vulnerable.length
            ? `${plural(vulnerable.length, 'vulnerable plugin')} of ${slugs.length}`
            : checked
              ? `${plural(checked, 'plugin')} checked against WPScan (${detected})`
              : stopped
                ? 'WPScan API refused the token or rate-limited'
                : `${plural(slugs.length, 'plugin')} detected (${detected}); versions unknown or WPScan unreachable`,
        },
      ],
    };
  }
}
