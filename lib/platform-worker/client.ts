/** The worker's side of the worker routes (§3). A 409 means this attempt is over: stop at once. */

export class StaleAttempt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleAttempt';
  }
}

export interface RegisteredAudit {
  audit_id: string;
  attempt: number;
  mode: 'full' | 'quick' | 'page';
  target_url: string;
  host: string;
  profile: 'public' | 'standard';
  options: Record<string, unknown>;
  source: string;
  resume_from_attempt: number | null;
}

export interface UploadGrant {
  prefix: string;
  url: string;
  headers: Record<string, string>;
}

export interface ArtifactRecord {
  kind: string;
  key: string;
  bytes: number;
  sha256: string;
  page_url?: string | null;
}

export class AppClient {
  session: string | null = null;

  constructor(readonly appUrl: string) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = this.session): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(`${this.appUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (res.status === 409) throw new StaleAttempt(text);
        if (!res.ok) {
          const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
          if (res.status < 500) throw Object.assign(err, { fatal: true });
          throw err;
        }
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        if (err instanceof StaleAttempt || (err as { fatal?: boolean }).fatal) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    throw lastErr;
  }

  async register(
    identityToken: string,
    body: { audit_id: string; attempt: number; nonce: string },
  ): Promise<RegisteredAudit> {
    const res = await this.call<{ session: string; audit: RegisteredAudit }>(
      'POST',
      '/api/worker/register',
      body,
      identityToken,
    );
    this.session = res.session;
    return res.audit;
  }

  heartbeat = () => this.call('POST', '/api/worker/heartbeat', {});
  progress = (p: { processed?: number; total?: number; phase?: string }) =>
    this.call('POST', '/api/worker/progress', p);
  status = (s: {
    status: string;
    phase?: string;
    error?: string | null;
    tool_version?: string;
    model_version?: string;
    artifacts?: ArtifactRecord[];
  }) => this.call<{ status: string }>('POST', '/api/worker/status', s);
  guard = (host: string) => this.call<{ allowed: boolean; reason?: string }>('POST', '/api/worker/guard', { host });
  uploadGrant = (area: 'audit' | 'checkpoint') => this.call<UploadGrant>('POST', '/api/worker/upload-token', { area });
  snapshot = () => this.call<{ attempt: number; manifest: SnapshotManifest } | null>('GET', '/api/worker/snapshot');

  /** The stored files of the capped audit this one continues; null when it continues none. */
  continueSource = () =>
    this.call<{ audit_id: string; files: { path: string; key: string; bytes: number }[] } | null>(
      'GET',
      '/api/worker/continue',
    );

  async continueFile(key: string): Promise<Uint8Array> {
    const res = await fetch(`${this.appUrl}/api/worker/continue/file?key=${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${this.session}` },
    });
    if (res.status === 409) throw new StaleAttempt('stale');
    if (!res.ok) throw new Error(`continue file ${key}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async snapshotObject(attempt: number, sha: string): Promise<Uint8Array> {
    const res = await fetch(`${this.appUrl}/api/worker/snapshot/${attempt}/${sha}`, {
      headers: { authorization: `Bearer ${this.session}` },
    });
    if (res.status === 409) throw new StaleAttempt('stale');
    if (!res.ok) throw new Error(`snapshot object ${sha}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Uploads one file under a grant; refreshes the grant when it has expired. */
  async upload(
    grant: { current: UploadGrant; area: 'audit' | 'checkpoint' },
    key: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(grant.current.url, {
          method: 'POST',
          headers: {
            ...grant.current.headers,
            'x-file-key': key,
            'content-type': contentType ?? 'application/octet-stream',
          },
          body: Buffer.from(body),
        });
        if (res.status === 401) {
          grant.current = await this.uploadGrant(grant.area);
          continue;
        }
        if (!res.ok) throw new Error(`upload ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
        return;
      } catch (err) {
        if (i === 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    throw new Error(`upload ${key}: the upload grant was refused`);
  }
}

export interface SnapshotManifest {
  takenAt: string;
  /** Results base inside the work folder: audit-results or lead-results. */
  base: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}
