import { list, type ListBlobResultBlob } from '@vercel/blob';

export const dynamic = 'force-dynamic';

async function listStatusBlobs(): Promise<ListBlobResultBlob[]> {
  const statuses: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: 'audits/', cursor });
    statuses.push(...page.blobs.filter((b) => /^audits\/[^/]+\/status\.json$/.test(b.pathname)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return statuses.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

export default async function RunsPage() {
  let runs: ListBlobResultBlob[] = [];
  let error: string | null = null;
  try {
    runs = await listStatusBlobs();
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
        {runs.map((blob) => {
          const runId = blob.pathname.split('/')[1];
          return (
            <li key={blob.pathname}>
              <a href={`/runs/${runId}`}>{runId}</a>{' '}
              <span className="muted">— updated {blob.uploadedAt.toISOString()}</span>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
