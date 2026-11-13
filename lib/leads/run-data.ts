/**
 * Reads a finished run folder (a lead scan or a full audit; both have the same layout) into the
 * shape the lead pipeline needs. Read-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCompressedJson } from '../utils';
import type { LinkPosition } from '../analyzers/site-wide/crawl-graph-checks';
import type { LeadScanInfo } from './types';

export interface RunLink {
  href: string;
  text: string;
  position?: LinkPosition;
}

/** The fields of a crawled page that the lead pipeline reads. Everything is optional: older runs lack some. */
export interface RunPage {
  url: string;
  status?: number;
  redirectOnly?: boolean;
  finalUrl?: string;
  foundIn?: 'sitemap' | 'discovered';
  title?: string;
  indexability?: { hasNoindexTag?: boolean; metaRobots?: string | null; xRobotsTag?: string | null };
  siteHints?: { navLinks?: RunLink[]; ctaLinks?: RunLink[] };
  brokenMediaData?: { brokenImages?: string[]; failedRequests?: Array<{ url: string; status: number }> };
  visualShots?: Array<{ kind: string; file: string }>;
}

export interface RunCruxMetric {
  percentiles?: { p75?: number | string };
}

export interface RunMetadata {
  cruxData?: {
    target?: string;
    targetType?: string;
    formFactor?: string;
    collectionPeriod?: { firstDate?: DateParts; lastDate?: DateParts } | null;
    metrics?: Record<string, RunCruxMetric>;
  } | null;
  leadScan?: LeadScanInfo;
  passive?: boolean;
  siteChecks?: { checks?: Array<{ id: string; status: string; note?: string }> } | null;
  sitemaps?: { urls?: Record<string, unknown>; total?: number };
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface RunData {
  runDir: string;
  /** `lead` when the run was a lead scan, `full` for a full audit. */
  kind: 'lead' | 'full';
  metadata: RunMetadata;
  pages: Record<string, RunPage>;
  /** Finding message → detail, as written by the audit. */
  findings: Record<string, { severity?: string; count?: number; examples?: string[] }>;
}

export function loadRun(runDir: string): RunData {
  const manifestPath = path.join(runDir, 'manifest.json.gz');
  if (!fs.existsSync(manifestPath)) throw new Error(`Not a run folder (no manifest.json.gz): ${runDir}`);
  const manifest = readCompressedJson<{ files?: { pageBatches?: Array<{ file: string }> } }>(manifestPath);
  const metadata = readCompressedJson<RunMetadata>(path.join(runDir, 'metadata.json.gz'));

  const pages: Record<string, RunPage> = {};
  for (const batch of manifest.files?.pageBatches ?? []) {
    try {
      const data = readCompressedJson<{ pages?: Record<string, RunPage> }>(path.join(runDir, batch.file));
      for (const [url, page] of Object.entries(data.pages ?? {})) pages[url] = { ...page, url: page.url ?? url };
    } catch {
      // a missing batch leaves those pages out; the gate works with what is readable
    }
  }

  let findings: RunData['findings'] = {};
  try {
    findings =
      readCompressedJson<{ details?: RunData['findings'] }>(path.join(runDir, 'analysis.json.gz')).details ?? {};
  } catch {
    // no analysis file
  }

  return { runDir, kind: metadata.leadScan ? 'lead' : 'full', metadata, pages, findings };
}

/** Pages that were loaded and analysed as HTML pages: not redirect stubs, not errors. */
export function okPages(run: RunData): RunPage[] {
  return Object.values(run.pages).filter((p) => !p.redirectOnly && (p.status ?? 200) >= 200 && (p.status ?? 200) < 300);
}

export function formatDateParts(d: DateParts | undefined): string | null {
  if (!d) return null;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
