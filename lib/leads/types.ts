/**
 * Types shared by the lead pipeline (`lib/leads/`, driven by `scripts/lead-pipeline.ts`).
 * Design: `docs/gtm/sales-audit-system.md`.
 */

/**
 * The kind of evidence a signal is. Two signals of the same kind are not independent (a path in the
 * HTML and the same path in a script URL say the same thing), so confidence counts kinds, not hits.
 */
export type SignalKind = 'cookie' | 'header' | 'meta' | 'global' | 'source' | 'asset-host';

export interface StackSignal {
  /** Technology name as the detector reports it, e.g. `Concrete CMS`. */
  tech: string;
  kind: SignalKind;
  /** Short human-readable evidence, e.g. `set-cookie CONCRETE=` or `/concrete/js/`. */
  detail: string;
}

export type StackKind = 'legacy' | 'hybrid' | 'builder' | 'headless' | 'custom' | 'unknown' | 'unreadable';

export type StackConfidence = 'high' | 'low';

export type Track = 'migrate' | 'optimise';

/** One observation of a version, from one place. */
export interface VersionFinding {
  /** Product slug; where the public end-of-life dataset covers the product, it is that dataset's slug. */
  product: string;
  label: string;
  version: string;
  kind: SignalKind;
  /** Where it was read, e.g. `meta generator`, `x-powered-by`, `/wp-includes/…?ver=`. */
  source: string;
}

/** All observations of one product, merged. */
export interface VersionEvidence {
  product: string;
  label: string;
  version: string;
  /** Kinds of evidence that agree on `version`. Two or more are needed before a version is cited. */
  kinds: SignalKind[];
  sources: string[];
  /** True when another observation gave a different, incompatible version. */
  conflict?: boolean;
}

export interface EolHit {
  product: string;
  label: string;
  version: string;
  /** Release cycle in the end-of-life dataset that the version belongs to. */
  cycle: string;
  /** ISO date the cycle stopped receiving fixes; null when the dataset only says "ended". */
  eolDate: string | null;
  /** Kinds of evidence behind the version (see `VersionEvidence.kinds`). */
  kinds: SignalKind[];
  /**
   * True when the version string comes from a header that Linux distributions keep unchanged while
   * backporting fixes (PHP). Such a hit is a supporting line at most, never a headline.
   */
  upstreamOnly?: boolean;
}

export interface StackProfile {
  kind: StackKind;
  cms: string | null;
  cmsSecondary: string | null;
  cmsVersion: string | null;
  framework: string | null;
  /** Version, or a variant such as `App Router` / `2` when only that is visible. */
  frameworkVersion: string | null;
  /** Server-side runtime and web server, e.g. `PHP 7.4.33; nginx 1.18.0`. */
  runtime: string | null;
  libraries: Array<{ name: string; version: string }>;
  versions: VersionEvidence[];
  eol: EolHit[];
  confidence: StackConfidence;
  signals: StackSignal[];
  /** Why the kind or the confidence came out as it did; for the reviewer, not for the prospect. */
  notes: string[];
}

/** Stored in a lead scan's `metadata.json.gz` as `leadScan`. */
export interface LeadScanInfo {
  /** Most page loads the scan may make. */
  cap: number;
  home: string | null;
  /** Pages chosen for the scan, the homepage first, with the reason each was chosen. */
  selected: Array<{ url: string; reason: string; template: string }>;
  /** Candidate URLs left out because robots.txt disallows them for all crawlers (first 50). */
  disallowedByRobots: string[];
  languages: string[];
  /** URLs in the site's sitemaps, before the scan narrowed them to the selected pages. */
  sitemapTotal: number;
  /** Up to 200 sitemap URLs spread evenly over the sitemap, for sampling checks. */
  sitemapSample: string[];
  /** Navigations made (a redirect and its target count as two). */
  pagesLoaded?: number;
  /** Requests sent to the site's own hosts. */
  requests?: { browser: number; node: number; total: number };
}

export interface RobotsSummary {
  status: number | null;
  sitemaps: string[];
  /** `User-agent: *` with `Disallow: /`: the lead scan must not crawl this site. */
  disallowAll: boolean;
}

export interface FingerprintResult {
  website: string;
  domain: string;
  fingerprintedAt: string;
  /** How the homepage was read. */
  via: 'http' | 'browser' | 'none';
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  /** Set when the site could not be read; the profile kind is then `unreadable`. */
  unreadableReason: string | null;
  /** Host the homepage redirected to, when it is a different site. */
  redirectedTo: string | null;
  robots: RobotsSummary | null;
  /** Requests sent to the site's hosts for this fingerprint. */
  requestsSent: number;
  profile: StackProfile;
}
