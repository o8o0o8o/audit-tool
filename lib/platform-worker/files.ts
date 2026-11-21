/** Which files of a finished run are stored, and as which artifact kind (§4 `artifacts`). */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppClient, ArtifactRecord, UploadGrant } from './client';
import { walkFiles } from './snapshot';
import { readMaskRecord } from './mask-secrets';

export interface StoredFile {
  rel: string;
  kind: string | null;
  pageUrl?: string | null;
}

const REPORT_KINDS: Array<[RegExp, string]> = [
  [/^audit-report\.verified\.md$/, 'report_verified_md'],
  [/^audit-report\.verified\.pdf$/, 'report_verified_pdf'],
  [/^audit-report\.md$/, 'report_md'],
  [/^audit-report\.pdf$/, 'report_pdf'],
  [/^content-research-report\.md$/, 'content_research_md'],
  [/^content-research-report\.pdf$/, 'content_research_pdf'],
  [/^lead\/teaser\.md$/, 'teaser_md'],
  [/^lead\/teaser\.pdf$/, 'teaser_pdf'],
  [/^model\/raw-archive\.tar\.gz$/, 'raw_archive'],
];

/** The main HTML report is `<domain>.html` (never the Phase 2/3 PDF-source pages). */
export const isMainReport = (rel: string) =>
  !rel.includes('/') && /^(?!audit-report\.|content-research-report\.)[^/]+\.html$/i.test(rel);

/**
 * Files uploaded under `audits/{id}/{attempt}/`: reports, the model, evidence and gate evidence.
 * Raw `*.json.gz` stay out: they are inside the raw archive.
 */
export function classify(rel: string, evidenceUrls: Record<string, string>): StoredFile | null {
  if (isMainReport(rel)) return { rel, kind: 'report_html' };
  for (const [re, kind] of REPORT_KINDS) if (re.test(rel)) return { rel, kind };
  if (rel.startsWith('model/')) return { rel, kind: null };
  if (rel.startsWith('lead/evidence/') || rel.startsWith('lead/gate-runs/') || rel === 'lead/lead.json')
    return { rel, kind: 'gate_evidence' };
  if (rel.startsWith('evidence/')) {
    const dir = rel.split('/')[1] ?? '';
    const pageUrl = evidenceUrls[dir] ?? null;
    return { rel, kind: /\.(png|jpe?g|webp)$/i.test(rel) ? 'screenshot' : 'evidence', pageUrl };
  }
  if (rel === 'badge.svg') return { rel, kind: 'evidence' };
  return null;
}

function evidenceIndex(runDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of walkFiles(path.join(runDir, 'evidence'))) {
    if (path.basename(f) !== '_meta.json') continue;
    try {
      const meta = JSON.parse(readFileSync(f, 'utf8')) as { url?: string };
      if (meta.url) out[path.basename(path.dirname(f))] = meta.url;
    } catch {
      /* skip */
    }
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
  gz: 'application/gzip',
  ndjson: 'application/x-ndjson',
};

/** Uploads the run's stored files; returns the artifact rows for the `built` status call. */
export async function uploadRun(
  client: AppClient,
  runDir: string,
  auditId: string,
  attempt: number,
  concurrency = 8,
): Promise<ArtifactRecord[]> {
  const urls = evidenceIndex(runDir);
  // A masked file keeps the hash of the original answer (design §8.14).
  const masked = readMaskRecord(runDir);
  const files = walkFiles(runDir)
    .map((f) => path.relative(runDir, f).split(path.sep).join('/'))
    .map((rel) => classify(rel, urls))
    .filter((f): f is StoredFile => f !== null)
    // A file that could not be masked is never stored (platform/masked.json says which).
    .filter((f) => !masked[f.rel]?.notMasked);
  const grant: { current: UploadGrant; area: 'audit' } = { current: await client.uploadGrant('audit'), area: 'audit' };
  const prefix = `audits/${auditId}/${attempt}/`;
  const out: ArtifactRecord[] = [];
  let next = 0;
  const work = async () => {
    while (next < files.length) {
      const f = files[next++]!;
      const body = readFileSync(path.join(runDir, f.rel));
      const key = prefix + f.rel;
      await client.upload(grant, key, body, CONTENT_TYPES[f.rel.split('.').pop() ?? '']);
      if (f.kind) {
        out.push({
          kind: f.kind,
          key,
          bytes: body.byteLength,
          sha256: masked[f.rel]?.sha256Original ?? createHash('sha256').update(body).digest('hex'),
          page_url: f.pageUrl ?? null,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, work));
  return out;
}
