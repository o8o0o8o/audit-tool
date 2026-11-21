/**
 * Publishes a local run to the platform (design §8.13, task 4.7): `POST /audits/import` creates an
 * audit (source `pipeline`) and returns an upload grant; the model, raw archive and stored files are
 * uploaded; `POST /audits/{id}/complete` hands it to the loader. Gate runs after that (rerank,
 * recheck) are appended with `POST /audits/{id}/gate-runs`. Secrets are masked before upload.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildAuditModel, writeRawArchive } from '../model/build/build-audit-model';
import { MODEL_VERSION } from '../model/version';
import { classify } from '../platform-worker/files';
import { maskSecretsInRun, readMaskRecord } from '../platform-worker/mask-secrets';
import { walkFiles } from '../platform-worker/snapshot';
import type { ApiProspectStore } from './prospect-store';

interface Grant {
  url: string;
  headers: Record<string, string>;
}

async function upload(grant: Grant, key: string, body: Uint8Array): Promise<void> {
  const res = await fetch(grant.url, {
    method: 'POST',
    headers: { ...grant.headers, 'x-file-key': key, 'content-type': 'application/octet-stream' },
    body: Buffer.from(body),
  });
  if (!res.ok) throw new Error(`upload ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export interface PublishResult {
  auditId: string;
  alreadyImported: boolean;
  artifacts: number;
}

export async function publishRun(
  api: ApiProspectStore,
  runDir: string,
  opts: { withEvidence?: boolean } = {},
): Promise<PublishResult> {
  maskSecretsInRun(runDir);
  const probe = buildAuditModel({ runDir, auditId: randomUUID(), gateSource: 'pipeline' });
  const legacy = `${path.basename(path.dirname(runDir))}/${path.basename(runDir)}`;
  const begin = await api.call<{ audit_id: string; already_imported: boolean; prefix?: string; upload?: Grant }>(
    'POST',
    '/api/v1/audits/import',
    {
      url: probe.audit.targetUrl,
      mode: probe.audit.mode,
      legacy_run_id: legacy,
      finished_at: probe.audit.finishedAt ?? undefined,
    },
  );
  if (begin.already_imported) return { auditId: begin.audit_id, alreadyImported: true, artifacts: 0 };
  const doc = buildAuditModel({ runDir, auditId: begin.audit_id, gateSource: 'pipeline' });
  const prefix = begin.prefix!;
  const grant = begin.upload!;
  const masked = readMaskRecord(runDir);
  const artifacts: Array<{ kind: string; key: string; bytes: number; sha256: string; page_url?: string | null }> = [];
  await upload(grant, `${prefix}model/site.json.gz`, gzipSync(JSON.stringify(doc)));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  try {
    const archive = path.join(tmp, 'raw-archive.tar.gz');
    writeRawArchive(runDir, archive);
    const body = readFileSync(archive);
    await upload(grant, `${prefix}model/raw-archive.tar.gz`, body);
    artifacts.push({
      kind: 'raw_archive',
      key: `${prefix}model/raw-archive.tar.gz`,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const f of walkFiles(runDir)) {
    const rel = path.relative(runDir, f).split(path.sep).join('/');
    if (rel.startsWith('model/')) continue;
    const c = classify(rel, {});
    if (!c?.kind) continue;
    if (
      !opts.withEvidence &&
      (c.kind === 'evidence' || (c.kind === 'screenshot' && rel !== doc.siteProfile.homepageScreenshot))
    )
      continue;
    const body = readFileSync(f);
    await upload(grant, prefix + rel, body);
    artifacts.push({
      kind: c.kind,
      key: prefix + rel,
      bytes: body.byteLength,
      sha256: masked[rel]?.sha256Original ?? createHash('sha256').update(body).digest('hex'),
      page_url: c.pageUrl ?? null,
    });
  }
  await api.call('POST', `/api/v1/audits/${begin.audit_id}/complete`, { artifacts, model_version: MODEL_VERSION });
  return { auditId: begin.audit_id, alreadyImported: false, artifacts: artifacts.length };
}

/** Appends one gate run (a lead.json / gate-runs file) to a published audit. */
export async function publishGateRun(
  api: ApiProspectStore,
  auditId: string,
  lead: unknown,
): Promise<{ gate_run_id: number; duplicate: boolean }> {
  return api.call('POST', `/api/v1/audits/${auditId}/gate-runs`, lead);
}
