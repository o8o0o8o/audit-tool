/**
 * Detects front-end JavaScript libraries with publicly known vulnerabilities.
 * Versions come from runtime globals (jQuery.fn.jquery, angular.version…) and
 * from versioned script URLs (jquery-3.4.1.min.js, /jquery@3.4.1/, /3.4.1/jquery.js).
 * The advisory table is a curated subset of Retire.js data for the most
 * widely deployed libraries; it is not a full vulnerability database.
 */

import { SEVERITY } from '../../constants';
import type { Issue, SeverityLevel } from '../../types';

export interface LibraryAdvisory {
  /** Vulnerable when version < below (and >= from, if given). */
  below: string;
  from?: string;
  severity: SeverityLevel;
  summary: string;
}

export const LIBRARIES: Record<string, { label: string; advisories: LibraryAdvisory[] }> = {
  jquery: {
    label: 'jQuery',
    advisories: [
      {
        below: '3.5.0',
        severity: SEVERITY.MEDIUM,
        summary: 'XSS in htmlPrefilter / DOM manipulation (CVE-2020-11022, CVE-2020-11023)',
      },
    ],
  },
  'jquery-ui': {
    label: 'jQuery UI',
    advisories: [
      {
        below: '1.13.2',
        severity: SEVERITY.MEDIUM,
        summary: 'XSS in several widgets (CVE-2021-41182/41183/41184, CVE-2022-31160)',
      },
    ],
  },
  bootstrap: {
    label: 'Bootstrap',
    advisories: [
      {
        below: '3.4.1',
        severity: SEVERITY.MEDIUM,
        summary: 'XSS in tooltip/popover data-template (CVE-2019-8331, CVE-2018-14042)',
      },
      {
        from: '4.0.0',
        below: '4.3.1',
        severity: SEVERITY.MEDIUM,
        summary: 'XSS in tooltip/popover data-template (CVE-2019-8331)',
      },
    ],
  },
  angularjs: {
    label: 'AngularJS',
    advisories: [
      {
        below: '2.0.0',
        severity: SEVERITY.MEDIUM,
        summary: 'AngularJS 1.x is end-of-life (Jan 2022) with unpatched XSS and ReDoS issues',
      },
    ],
  },
  lodash: {
    label: 'Lodash',
    advisories: [
      {
        below: '4.17.21',
        severity: SEVERITY.MEDIUM,
        summary: 'Prototype pollution / command injection (CVE-2020-8203, CVE-2021-23337)',
      },
    ],
  },
  underscore: {
    label: 'Underscore',
    advisories: [
      {
        from: '1.3.2',
        below: '1.12.1',
        severity: SEVERITY.MEDIUM,
        summary: 'Arbitrary code execution in template (CVE-2021-23358)',
      },
    ],
  },
  moment: {
    label: 'Moment.js',
    advisories: [{ below: '2.29.4', severity: SEVERITY.LOW, summary: 'ReDoS in RFC 2822 parsing (CVE-2022-31129)' }],
  },
  handlebars: {
    label: 'Handlebars',
    advisories: [
      {
        below: '4.7.7',
        severity: SEVERITY.MEDIUM,
        summary: 'Remote code execution via templates (CVE-2021-23369, CVE-2021-23383)',
      },
    ],
  },
  dompurify: {
    label: 'DOMPurify',
    advisories: [
      { below: '2.5.4', severity: SEVERITY.MEDIUM, summary: 'Sanitizer bypass / prototype pollution (CVE-2024-45801)' },
      { from: '3.0.0', below: '3.1.3', severity: SEVERITY.MEDIUM, summary: 'Sanitizer bypass (CVE-2024-45801)' },
    ],
  },
  vue: {
    label: 'Vue',
    advisories: [
      {
        below: '3.0.0',
        severity: SEVERITY.LOW,
        summary: 'Vue 2 is end-of-life (Dec 2023) and receives no security fixes',
      },
    ],
  },
};

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function advisoryFor(lib: string, version: string): LibraryAdvisory | null {
  const entry = LIBRARIES[lib];
  if (!entry || !/^\d+\.\d+(?:\.\d+)?/.test(version)) return null;
  return (
    entry.advisories.find(
      (a) => compareVersions(version, a.below) < 0 && (!a.from || compareVersions(version, a.from) >= 0),
    ) ?? null
  );
}

const URL_NAMES: Array<[string, string]> = [
  ['jquery-ui', 'jquery-ui'],
  ['jqueryui', 'jquery-ui'],
  ['jquery', 'jquery'],
  ['bootstrap', 'bootstrap'],
  ['angular.js', 'angularjs'],
  ['angularjs', 'angularjs'],
  ['angular', 'angularjs'],
  ['lodash', 'lodash'],
  ['underscore', 'underscore'],
  ['moment', 'moment'],
  ['handlebars', 'handlebars'],
  ['dompurify', 'dompurify'],
  ['purify', 'dompurify'],
  ['vue', 'vue'],
];

const VER = '(\\d+\\.\\d+\\.\\d+)';

/** Library + version from a script URL, or null. */
export function libraryFromUrl(url: string): { lib: string; version: string } | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return null;
  }
  for (const [name, lib] of URL_NAMES) {
    const n = name.replace(/\./g, '\\.');
    const patterns = [
      new RegExp(`/${n}[-.@]v?${VER}(?:[./-]|$)`), // jquery-3.4.1.min.js, jquery@3.4.1
      new RegExp(`/${n}/v?${VER}/`), // cdnjs: /jquery/3.4.1/jquery.min.js
      new RegExp(`/${VER}/${n}(?:\\.min)?\\.js$`), // /3.4.1/jquery.min.js
    ];
    for (const re of patterns) {
      const m = re.exec(path);
      if (m) {
        // AngularJS 1.x only: "angular" 2+ is a different framework without this global/file layout.
        if (lib === 'angularjs' && !m[1].startsWith('1.')) return null;
        return { lib, version: m[1] };
      }
    }
  }
  return null;
}

interface PageLike {
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Runtime globals → versions. Runs in the browser, so it must stay self-contained (no outer references). */
export function readRuntimeVersions(): Record<string, string> {
  const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    if (typeof v === 'string' && /^\d+\.\d+/.test(v)) out[k] = v;
  };
  try {
    const jq = w.jQuery ?? w.$;
    set('jquery', jq?.fn?.jquery);
    set('jquery-ui', jq?.ui?.version);
    set('bootstrap', w.bootstrap?.Tooltip?.VERSION ?? jq?.fn?.tooltip?.Constructor?.VERSION);
  } catch {
    /* ignore */
  }
  try {
    if (w.angular?.version?.major === 1) set('angularjs', w.angular.version.full);
    const u = w._;
    if (u && typeof u.VERSION === 'string')
      set(typeof u.flatMapDeep === 'function' ? 'lodash' : 'underscore', u.VERSION);
    set('moment', w.moment?.version);
    set('handlebars', w.Handlebars?.VERSION);
    set('dompurify', w.DOMPurify?.version);
    set('vue', w.Vue?.version);
  } catch {
    /* ignore */
  }
  return out;
}

export function jsLibraryIssues(found: Record<string, string>): Issue[] {
  const hits = Object.entries(found)
    .map(([lib, version]) => ({ lib, version, adv: advisoryFor(lib, version) }))
    .filter((h): h is { lib: string; version: string; adv: LibraryAdvisory } => h.adv !== null);
  if (!hits.length) return [];
  const order = [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW];
  const severity = hits.map((h) => h.adv.severity).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return [
    {
      message: 'Outdated JavaScript library with known vulnerabilities',
      detail: hits
        .map((h) => `${LIBRARIES[h.lib].label} ${h.version}: ${h.adv.summary}; upgrade to ${h.adv.below} or later`)
        .join('. '),
      severity,
    },
  ];
}

export class JsLibraryAnalyzer {
  static async analyze(page: PageLike, scriptUrls: Iterable<string>) {
    const found: Record<string, string> = {};
    for (const url of scriptUrls) {
      const hit = libraryFromUrl(url);
      if (hit && !found[hit.lib]) found[hit.lib] = hit.version;
    }
    try {
      Object.assign(found, await page.evaluate(readRuntimeVersions)); // runtime wins over URL
    } catch {
      /* keep URL-based results */
    }
    return { issues: jsLibraryIssues(found), warnings: [] as Issue[], info: { libraries: found } };
  }
}
