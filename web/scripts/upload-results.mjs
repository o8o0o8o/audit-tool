#!/usr/bin/env node
// Uploads an audit run folder to Vercel Blob under audits/<RUN_ID>/ and writes audits/<RUN_ID>/status.json.
//
// Usage: node web/scripts/upload-results.mjs --status=running|succeeded|failed|cancelled [--results=<audit-results dir>]
// Env: RUN_ID, AUDIT_URL, AUDIT_OPTIONS (JSON), AUDIT_STARTED_AT (ISO), BLOB_READ_WRITE_TOKEN,
//      GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (for the Actions run link).
import { put } from '@vercel/blob';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled']);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Newest `<domain>/<ts>/` folder (by name) modified at or after the job started. */
async function findRunFolder(resultsDir, startedAtMs) {
  let domains;
  try {
    domains = await readdir(resultsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const domain of domains.filter((d) => d.isDirectory())) {
    const domainDir = path.join(resultsDir, domain.name);
    for (const ts of await readdir(domainDir, { withFileTypes: true })) {
      if (!ts.isDirectory()) continue;
      const full = path.join(domainDir, ts.name);
      const { mtimeMs } = await stat(full);
      if (Number.isNaN(startedAtMs) || mtimeMs >= startedAtMs) candidates.push({ name: ts.name, full });
    }
  }
  candidates.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return candidates[0]?.full ?? null;
}

const blobOptions = { access: 'public', addRandomSuffix: false, allowOverwrite: true };

async function main() {
  const runId = process.env.RUN_ID ?? '';
  if (!RUN_ID_PATTERN.test(runId)) {
    console.error('RUN_ID is missing or invalid; refusing to upload.');
    process.exit(1);
  }
  let status = arg('status', 'succeeded');
  if (!STATUSES.has(status)) {
    console.error(`Unknown --status=${status}`);
    process.exit(1);
  }
  const resultsDir = path.resolve(arg('results', 'audit-results'));
  const startedAt = process.env.AUDIT_STARTED_AT || new Date().toISOString();
  let options = {};
  try {
    options = JSON.parse(process.env.AUDIT_OPTIONS || '{}');
  } catch {}

  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const ghRunUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : undefined;

  const files = [];
  let error;
  if (status !== 'running') {
    // Allow a little clock skew between the recorded start and folder mtimes.
    const runFolder = await findRunFolder(resultsDir, Date.parse(startedAt) - 60_000);
    if (!runFolder) {
      status = 'failed';
      error = 'no audit results produced';
    } else {
      for (const file of await walk(runFolder)) {
        const rel = path.relative(runFolder, file).split(path.sep).join('/');
        const blob = await put(`audits/${runId}/${rel}`, await readFile(file), blobOptions);
        files.push({ name: rel, url: blob.url });
        console.log(`uploaded ${rel}`);
      }
    }
  }

  const statusDoc = {
    runId,
    url: process.env.AUDIT_URL ?? '',
    options,
    status,
    startedAt,
    finishedAt: status === 'running' ? undefined : new Date().toISOString(),
    files,
    ghRunUrl,
    ...(error ? { error } : {}),
  };
  await put(`audits/${runId}/status.json`, JSON.stringify(statusDoc, null, 2), {
    ...blobOptions,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
  console.log(`status.json written: ${status}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
