/**
 * The `render-pdf` worker kind (task 2.8): registers for a job, restores the report text and the
 * screenshots from the file store into a scratch folder, prints, uploads, reports done.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderRunPdf, PDF_KINDS, type PdfKind } from '../../scripts/render-pdf';
import { AppClient, type UploadGrant } from './client';
import type { WorkerEnv } from './run';

interface JobInfo {
  job_id: string;
  audit_id: string;
  kind: PdfKind;
  audit_attempt: number;
  markdown: string;
  files: Array<{ key: string; kind: string }>;
}

export async function runPdfJob(env: WorkerEnv): Promise<number> {
  const res = await fetch(`${env.appUrl}/api/worker/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.identityToken}` },
    body: JSON.stringify({ job_id: env.auditId, attempt: env.attempt, nonce: env.nonce }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  const { session, job } = (await res.json()) as { session: string; job: JobInfo };
  const client = new AppClient(env.appUrl);
  client.session = session;
  const beat = setInterval(() => void client.heartbeat().catch(() => {}), env.heartbeatMs);
  try {
    const dir = path.join(env.workDir, 'run');
    for (const f of job.files) {
      const rel = f.key.split('/').slice(3).join('/');
      if (!rel || rel.includes('..')) continue;
      const r = await fetch(`${env.appUrl}/api/worker/file?key=${encodeURIComponent(f.key)}`, {
        headers: { authorization: `Bearer ${session}` },
      });
      if (!r.ok) continue; // an expired screenshot: the PDF is printed without it
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), Buffer.from(await r.arrayBuffer()));
    }
    const out = await renderRunPdf(dir, job.kind);
    const body = readFileSync(out);
    const key = `audits/${job.audit_id}/${job.audit_attempt}/${PDF_KINDS[job.kind].pdf}`;
    const grant: { current: UploadGrant; area: 'audit' } = {
      current: await client.uploadGrant('audit'),
      area: 'audit',
    };
    await client.upload(grant, key, body, 'application/pdf');
    await fetch(`${env.appUrl}/api/worker/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: JSON.stringify({
        status: 'done',
        artifact: { key, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') },
      }),
    });
    return 0;
  } catch (err) {
    await fetch(`${env.appUrl}/api/worker/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: JSON.stringify({ status: 'failed', error: String(err) }),
    }).catch(() => {});
    console.error(err);
    return 1;
  } finally {
    clearInterval(beat);
  }
}
