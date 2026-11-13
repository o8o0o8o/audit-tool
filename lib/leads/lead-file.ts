/**
 * `lead.json`: everything the lead pipeline knows about one prospect after the truth gate.
 * Written to `<run folder>/lead/lead.json`; the teaser and the review page are built from it alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { okPages, type RunData } from './run-data';
import type { DroppedCandidate, GateResult, Highlight } from './truth-gate';
import type { StackProfile, Track } from './types';
import { TECH_TO_PRODUCT } from './versions';

export interface LeadFile {
  domain: string;
  company: string;
  /** The run the facts come from, and whether it was a lead scan or a full audit. */
  runDir: string;
  runKind: 'lead' | 'full';
  scannedAt: string | null;
  checkedAt: string;
  /** Pages that were loaded and read; the number a teaser cites. */
  pagesScanned: number;
  /** Requests sent to the site: by the scan (when it counted them) and by the gate. */
  requestsSent: { scan: number | null; gate: number };
  stack: {
    kind: string;
    cms: string | null;
    cmsSecondary: string | null;
    cmsVersion: string | null;
    /** True when two different kinds of signal agree on the CMS version; only then may it be cited. */
    cmsVersionConfirmed: boolean;
    framework: string | null;
    frameworkVersion: string | null;
    libraries: Array<{ name: string; version: string }>;
    eol: string[];
    confidence: string;
    signals: string[];
  } | null;
  fitScore: number | null;
  track: Track | null;
  control: GateResult['control'];
  highlights: Highlight[];
  causes: string[];
  teaserReady: boolean;
  candidatesDropped: DroppedCandidate[];
  /** Non-empty: a security exposure must be disclosed before any outreach to this company. */
  disclosure: GateResult['disclosure'];
}

export const leadDir = (runDir: string) => path.join(runDir, 'lead');
export const leadJsonPath = (runDir: string) => path.join(leadDir(runDir), 'lead.json');

/** Copies evidence the scan captured into the lead folder, so that folder is complete on its own. */
function localiseEvidence(runDir: string, highlights: Highlight[]): Highlight[] {
  const dir = leadDir(runDir);
  return highlights.map((h, i) => {
    const shot = h.evidence.screenshot;
    if (!shot || (shot.startsWith('evidence/') && fs.existsSync(path.join(dir, shot)))) return h;
    const source = path.join(runDir, shot);
    if (!fs.existsSync(source)) return { ...h, evidence: { ...h.evidence, screenshot: null } };
    const target = path.join('evidence', `${h.type}-${i + 1}${path.extname(shot) || '.jpg'}`);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.copyFileSync(source, path.join(dir, target));
    return { ...h, evidence: { ...h.evidence, screenshot: target } };
  });
}

function versionConfirmed(stack: StackProfile, tech: string | null): boolean {
  const product = tech ? TECH_TO_PRODUCT[tech] : undefined;
  const evidence = product ? stack.versions.find((v) => v.product === product) : undefined;
  return Boolean(evidence && !evidence.conflict && evidence.kinds.length >= 2);
}

export interface LeadFileInput {
  domain: string;
  company: string;
  run: RunData;
  stack: StackProfile | null;
  gate: GateResult;
  fitScore: number | null;
  track: Track | null;
  scannedAt: string | null;
}

export function buildLeadFile(input: LeadFileInput): LeadFile {
  const { run, stack, gate } = input;
  return {
    domain: input.domain,
    company: input.company,
    runDir: run.runDir,
    runKind: run.kind,
    scannedAt: input.scannedAt,
    checkedAt: gate.checkedAt,
    pagesScanned: okPages(run).length,
    requestsSent: { scan: run.metadata.leadScan?.requests?.total ?? null, gate: gate.requestsSent },
    stack: stack
      ? {
          kind: stack.kind,
          cms: stack.cms,
          cmsSecondary: stack.cmsSecondary,
          cmsVersion: stack.cmsVersion,
          cmsVersionConfirmed: versionConfirmed(stack, stack.cms),
          framework: stack.framework,
          frameworkVersion: stack.frameworkVersion,
          libraries: stack.libraries,
          eol: stack.eol.map((h) => `${h.label} ${h.version}`),
          confidence: stack.confidence,
          signals: stack.signals.map((s) => `${s.kind}:${s.tech}`),
        }
      : null,
    fitScore: input.fitScore,
    track: input.track,
    control: gate.control,
    highlights: localiseEvidence(run.runDir, gate.highlights),
    causes: gate.causes,
    teaserReady: gate.teaserReady,
    candidatesDropped: gate.candidatesDropped,
    disclosure: gate.disclosure,
  };
}

export function writeLeadFile(lead: LeadFile): string {
  const file = leadJsonPath(lead.runDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(lead, null, 2));
  return file;
}

export function readLeadFile(runDir: string): LeadFile | null {
  try {
    return JSON.parse(fs.readFileSync(leadJsonPath(runDir), 'utf8')) as LeadFile;
  } catch {
    return null;
  }
}
