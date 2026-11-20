import { list } from '@vercel/blob';

import { isValidRunId } from '../../lib/audit-options';
import { runIdStartedAt } from '../../lib/blob';

// Rebuilt at most every 30s, so Blob is listed at most twice per 30s however often the page is opened.
export const revalidate = 30;

interface RunEntry {
  runId: string;
  /** Last status upload; for older runs without a `runs/` entry, the start time from the run id. */
  updatedAt: Date | null;
}

/** `runs/<runId>.json` holds one small status copy per run, so listing it never walks evidence files. */
async function listIndexedRuns(): Promise<RunEntry[]> {
  const runs: RunEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'runs/', cursor });
    for (const blob of page.blobs) {
      const m = /^runs\/([^/]+)\.json$/.exec(blob.pathname);
      if (m && isValidRunId(m[1])) runs.push({ runId: m[1], updatedAt: blob.uploadedAt });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return runs;
}

/** Runs uploaded before `runs/` existed: folded listing returns one folder per run, not its files. */
async function listLegacyRuns(): Promise<RunEntry[]> {
  const runs: RunEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'audits/', mode: 'folded', cursor });
    for (const folder of page.folders) {
      const runId = folder.split('/')[1];
      if (isValidRunId(runId)) runs.push({ runId, updatedAt: runIdStartedAt(runId) });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return runs;
}

async function listRuns(): Promise<RunEntry[]> {
  const [indexed, legacy] = await Promise.all([listIndexedRuns(), listLegacyRuns()]);
  const byId = new Map(legacy.map((r) => [r.runId, r]));
  for (const r of indexed) byId.set(r.runId, r);
  // Run ids start with a UTC timestamp, so newest first is reverse id order.
  return [...byId.values()].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

export default async function RunsPage() {
  let runs: RunEntry[] = [];
  let error: string | null = null;
  try {
    runs = await listRuns();
  } catch (err) {
    console.error('blob list failed', err);
    error =
      'Could not read runs from Blob storage. Check that a Blob store is connected to this project (see the function logs).';
  }

  return (
    <main>
      <h1>Audit runs</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!error && runs.length === 0 && <p className="muted">No runs yet.</p>}
      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.runId}>
            <a href={`/runs/${run.runId}`}>{run.runId}</a>
            {run.updatedAt && <span className="muted"> — updated {run.updatedAt.toISOString()}</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
