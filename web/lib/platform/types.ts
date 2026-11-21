/** Private file storage. Keys are paths like `audits/<id>/<attempt>/model/site.json.gz`. */
export interface FileStore {
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string },
  ): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; bytes: number; contentType?: string } | null>;
  list(prefix: string): AsyncIterable<{ key: string; bytes: number }>;
  delete(keys: string[]): Promise<void>;
  /** What a worker needs to upload under `prefix` and nowhere else. Local: a URL on the app plus a signed token. */
  issueUpload(prefix: string, ttlSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
}

export type WorkerKind = 'audit' | 'render-pdf';

export interface DispatchRequest {
  kind: WorkerKind;
  /** audits.id or jobs.id */
  id: string;
  attempt: number;
  nonce: string;
  /** Everything the worker needs to build its command line; never a secret. */
  inputs: Record<string, string>;
  resumeFromAttempt?: number;
}

/** Starts and controls workers. Throws DispatchUnavailable when the backend refuses; the row then stays queued. */
export interface Dispatcher {
  dispatch(req: DispatchRequest): Promise<void>;
  /** For the reaper: is a run for this attempt waiting, running or gone? */
  state(id: string, attempt: number): Promise<'waiting' | 'running' | 'gone'>;
  cancel(id: string, attempt: number): Promise<void>;
}

export interface WorkerClaims {
  /** Identifies the run on the backend: GitHub's run_id, or the local child's id. */
  runId: string;
  runAttempt: number;
  /** Local tokens name the audit (or job) and attempt they were made for; GitHub's do not. */
  id?: string;
  attempt?: number;
}

/** Checks the token a worker sends to `register`. Returns null when it is not valid. */
export interface WorkerIdentity {
  verify(token: string): Promise<WorkerClaims | null>;
}

/** Thrown by a Dispatcher when the backend refuses a run; the audit stays queued. */
export class DispatchUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchUnavailable';
  }
}

export interface Platform {
  mode: 'local' | 'production';
  files: FileStore;
  dispatcher: Dispatcher;
  identity: WorkerIdentity;
}
