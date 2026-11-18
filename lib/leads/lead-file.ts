/**
 * `lead.json`: everything the lead pipeline knows about one prospect after the truth gate.
 * Written to `<run folder>/lead/lead.json`; the teaser and the review page are built from it alone.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { okPages, type RunData } from './run-data';
import type { DroppedCandidate, GateResult, Highlight, Observation } from './truth-gate';
import type { StackProfile } from './types';
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
  control: GateResult['control'];
  highlights: Highlight[];
  causes: string[];
  teaserReady: boolean;
  candidatesDropped: DroppedCandidate[];
  /** Non-empty: a security exposure must be disclosed before any outreach to this company. */
  disclosure: GateResult['disclosure'];
  /** Folder name of this gate run under `lead/evidence/` and file name under `lead/gate-runs/`. */
  runStamp?: string;
  /** What the control requests returned. */
  controlObservations?: Observation[];
  /** The gate run before this one, and what changed since: set when the lead is saved. */
  previous?: { checkedAt: string; file: string; changes: FactChange[] } | null;
  /** Set when the facts were weighed and ordered again from this file, with no new request to the site. */
  rerankedAt?: string;
}

/** One fact, compared between two gate runs of the same prospect. */
export interface FactChange {
  rootCause: string;
  type: string;
  /** `confirmed`: same fact again. `changed`: still a fact, other values. `new` / `gone`: in one run only. */
  change: 'confirmed' | 'changed' | 'new' | 'gone';
  before?: string;
  after?: string;
  /** For `gone`: why the later run did not pass it, when that run says so. */
  reason?: string;
}

/** `2026-11-18T09-30-00-123Z`: a gate run's time as a file and folder name. */
export const gateRunStamp = (iso: string) => iso.replace(/[:.]/g, '-');

/** A fact's wording without what differs by design on every run (the random address a control asks for). */
const comparable = (fact: string) => fact.replace(/\/lead-check-[a-z0-9]+/gi, '/lead-check');

/** What happened to each fact between two gate runs, in the later run's order, facts that went away last. */
export function compareGateRuns(
  before: Pick<LeadFile, 'highlights'>,
  after: Pick<LeadFile, 'highlights' | 'candidatesDropped'>,
): FactChange[] {
  const earlier = new Map(before.highlights.map((h) => [h.rootCause, h]));
  const changes: FactChange[] = [];
  for (const h of after.highlights) {
    const was = earlier.get(h.rootCause);
    earlier.delete(h.rootCause);
    if (!was) changes.push({ rootCause: h.rootCause, type: h.type, change: 'new', after: h.fact });
    else if (comparable(was.fact) === comparable(h.fact)) {
      changes.push({ rootCause: h.rootCause, type: h.type, change: 'confirmed', after: h.fact });
    } else {
      changes.push({ rootCause: h.rootCause, type: h.type, change: 'changed', before: was.fact, after: h.fact });
    }
  }
  for (const was of earlier.values()) {
    const drop = after.candidatesDropped.find(
      (d) => d.reason !== 'same-root-cause' && (d.rootCause === was.rootCause || d.type === was.type),
    );
    changes.push({
      rootCause: was.rootCause,
      type: was.type,
      change: 'gone',
      before: was.fact,
      reason: drop
        ? `${drop.reason}${drop.detail ? `: ${drop.detail}` : ''}`
        : 'the scan data no longer yields this candidate',
    });
  }
  return changes;
}

const extensionFor = (o: Observation) =>
  o.method !== 'http-get' || /^\s*[[{]/.test(o.body ?? '')
    ? 'json'
    : /html/i.test(o.headers?.['content-type'] ?? '') || /^\s*</.test(o.body ?? '')
      ? 'html'
      : 'txt';

/**
 * Moves each observation's raw answer out of the lead file into `evidence/<stamp>/…`, leaving its
 * path, size and SHA-256 behind. `lead.json` stays small enough to read, and the answer stays
 * byte for byte what was received.
 */
function saveObservations(runDir: string, stamp: string, folder: string, observations: Observation[]): Observation[] {
  return observations.map((o, k) => {
    if (o.body === undefined) return o;
    const { body, ...rest } = o;
    const name = `${String(k + 1).padStart(2, '0')}-${o.method.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${extensionFor(o)}`;
    const relative = path.join('evidence', stamp, folder, name);
    try {
      fs.mkdirSync(path.dirname(path.join(leadDir(runDir), relative)), { recursive: true });
      fs.writeFileSync(path.join(leadDir(runDir), relative), body);
    } catch {
      return rest; // evidence is best effort; the fact itself is unaffected
    }
    return {
      ...rest,
      file: relative,
      bytes: Buffer.byteLength(body),
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    };
  });
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
  scannedAt: string | null;
  /** Evidence folder of this gate run; defaults to the gate's own time. */
  runStamp?: string;
}

export function buildLeadFile(input: LeadFileInput): LeadFile {
  const { run, stack, gate } = input;
  const runStamp = input.runStamp ?? gateRunStamp(gate.checkedAt);
  const highlights = localiseEvidence(run.runDir, gate.highlights).map((h, i) =>
    h.evidence.observations
      ? {
          ...h,
          evidence: {
            ...h.evidence,
            observations: saveObservations(run.runDir, runStamp, `${i + 1}-${h.type}`, h.evidence.observations),
          },
        }
      : h,
  );
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
    control: gate.control,
    highlights,
    causes: gate.causes,
    teaserReady: gate.teaserReady,
    candidatesDropped: gate.candidatesDropped,
    disclosure: gate.disclosure,
    runStamp,
    controlObservations: saveObservations(run.runDir, runStamp, 'control', gate.controlObservations ?? []),
  };
}

export const gateRunsDir = (runDir: string) => path.join(leadDir(runDir), 'gate-runs');

/** Every gate run kept for a scan, oldest first. */
export function listGateRuns(runDir: string): string[] {
  try {
    return fs
      .readdirSync(gateRunsDir(runDir))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Saves a gate run. `lead.json` is always the latest run; every run is also kept under
 * `gate-runs/<stamp>.json` and never overwritten, so a re-check can be compared with what was true
 * before. A `lead.json` from before runs were kept is filed there first. The saved lead records the
 * previous run and what changed since (`previous`).
 */
export function writeLeadFile(lead: LeadFile): string {
  const file = leadJsonPath(lead.runDir);
  const runs = gateRunsDir(lead.runDir);
  fs.mkdirSync(runs, { recursive: true });
  const before = readLeadFile(lead.runDir);
  let previous: LeadFile['previous'] = null;
  if (before && before.checkedAt !== lead.checkedAt) {
    const name = `${before.runStamp ?? gateRunStamp(before.checkedAt)}.json`;
    if (!fs.existsSync(path.join(runs, name))) fs.writeFileSync(path.join(runs, name), JSON.stringify(before, null, 2));
    previous = {
      checkedAt: before.checkedAt,
      file: path.join('gate-runs', name),
      changes: compareGateRuns(before, lead),
    };
  }
  const saved: LeadFile = { ...lead, previous };
  const text = JSON.stringify(saved, null, 2);
  fs.writeFileSync(path.join(runs, `${lead.runStamp ?? gateRunStamp(lead.checkedAt)}.json`), text);
  fs.writeFileSync(file, text);
  lead.previous = previous;
  return file;
}

/**
 * Saves a lead file whose facts were re-ordered but not re-checked: the same gate run, so it
 * replaces lead.json and that run's own copy, and leaves `previous` as it was.
 */
export function rewriteLeadFile(lead: LeadFile): string {
  const file = leadJsonPath(lead.runDir);
  const text = JSON.stringify(lead, null, 2);
  const own = path.join(gateRunsDir(lead.runDir), `${lead.runStamp ?? gateRunStamp(lead.checkedAt)}.json`);
  if (fs.existsSync(own)) fs.writeFileSync(own, text);
  fs.writeFileSync(file, text);
  return file;
}

export function readLeadFile(runDir: string): LeadFile | null {
  try {
    return JSON.parse(fs.readFileSync(leadJsonPath(runDir), 'utf8')) as LeadFile;
  } catch {
    return null;
  }
}
