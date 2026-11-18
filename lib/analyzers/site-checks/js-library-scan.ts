/**
 * Libraries with a published advisory in the site's scripts. Reads what the secrets scan already
 * downloaded (no request of its own) plus the address of every script the crawl saw, third-party
 * CDNs included. Versions and advisories come from `js-vulnerability-db.ts` (Retire.js data), which
 * also finds a library bundled inside one of the site's own files.
 */

import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';
import { escapeHtml } from '../../reports/html-utils';
import {
  advisoryIds,
  describeAdvisories,
  detectLibrariesFromUrl,
  detectLibrariesInContent,
  vulnerabilitiesFor,
  type VulnerableLibrary,
} from '../security/js-vulnerability-db';
import type { SiteProbeResult } from './site-checks-types';

export const VULNERABLE_LIBRARY_MESSAGE = 'Outdated JavaScript library with known vulnerabilities';

/** One vulnerable library in one script, as kept in the `js-libraries` check row for the lead gate. */
export interface VulnerableScript {
  library: string;
  version: string;
  via: VulnerableLibrary['via'];
  script: string;
  severity: SeverityLevel;
  /** Severity of the worst advisory, in the source's words (`critical`, `high`, `medium`, `low`). */
  worst: string;
  /** `CVE-…, CVE-…`: the advisories that apply. */
  ids: string;
  advisories: number;
  fixedIn: string;
}

const RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export class JsLibraryScan {
  readonly #found = new Map<string, VulnerableScript>();
  #scripts = 0;
  #read = 0;

  #add(script: string, hit: VulnerableLibrary | null): void {
    if (!hit) return;
    const key = `${hit.library}@${hit.version}`;
    const row: VulnerableScript = {
      library: hit.library,
      version: hit.version,
      via: hit.via,
      script,
      severity: hit.severity,
      worst: hit.vulnerabilities[0]!.severity,
      ids: advisoryIds(hit, 4),
      advisories: hit.vulnerabilities.length,
      fixedIn: hit.fixedIn,
    };
    const had = this.#found.get(key);
    // The content of a file is stronger evidence than its name, and is what the gate re-reads.
    if (!had || (had.via !== 'filecontent' && hit.via === 'filecontent')) this.#found.set(key, row);
  }

  /** A script the crawl saw, by address only. */
  addUrl(url: string): void {
    this.#scripts++;
    for (const d of detectLibrariesFromUrl(url)) this.#add(url, vulnerabilitiesFor(d));
  }

  /** A script that was downloaded. */
  addScript(url: string, body: string): void {
    this.#read++;
    for (const d of detectLibrariesInContent(body)) this.#add(url, vulnerabilitiesFor(d));
  }

  result(): SiteProbeResult {
    const rows = [...this.#found.values()].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0));
    const issues: Issue[] = [];
    if (rows.length > 0) {
      const lines = rows
        .slice(0, 12)
        .map(
          (r) =>
            `${escapeHtml(describeAdvisories(r.library, r.version, r.advisories, r.worst, r.ids, r.fixedIn))}, in ${escapeHtml(r.script)}`,
        );
      const more = rows.length > 12 ? ` (+${rows.length - 12} more)` : '';
      issues.push({
        message: VULNERABLE_LIBRARY_MESSAGE,
        detail: `The site's scripts contain ${rows.length} librar${rows.length === 1 ? 'y version' : 'y versions'} with a published security advisory: ${lines.join('; ')}${more}. Upgrade each to a fixed release.`,
        // A library advisory says the code is there, not that the site uses the vulnerable path: capped at HIGH.
        severity: rows[0]!.severity === SEVERITY.CRITICAL ? SEVERITY.HIGH : rows[0]!.severity,
      });
    }
    return {
      issues,
      checks: [
        {
          id: 'js-libraries',
          label: 'JavaScript libraries',
          status: rows.length ? 'fail' : this.#scripts ? 'pass' : 'skipped',
          note: rows.length
            ? rows
                .slice(0, 6)
                .map((r) => `${r.library} ${r.version}`)
                .join(', ') + (rows.length > 6 ? ` (+${rows.length - 6} more)` : '')
            : this.#scripts
              ? `${this.#scripts} script address(es) and ${this.#read} file(s) read, no version with a published advisory`
              : 'no scripts found',
          details: rows,
        },
      ],
    };
  }
}
