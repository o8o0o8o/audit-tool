import { DispatchUnavailable, type DispatchRequest, type Dispatcher } from '../types';

export interface GitHubWorkerConfig {
  /** `owner/name` of the repository the worker workflow lives in. */
  repository: string;
  /** Workflow file name, e.g. `platform-worker.yml`. */
  workflow: string;
  /** Branch the workflow runs from. */
  ref: string;
}

interface Run {
  id: number;
  status: string;
  display_title: string;
}

/** The workflow's `run-name`; the reaper finds a run by it. Keep in step with platform-worker.yml. */
export const runTitle = (kind: string, id: string, attempt: number) => `platform ${kind} ${id} #${attempt}`;

const API = 'https://api.github.com';
/** Pages of 100 runs looked through for one attempt. */
const RUN_PAGES = 3;

/**
 * Starts a worker as a `workflow_dispatch` run of the worker workflow. The inputs carry no secret:
 * the nonce only says which attempt the run is for, and the run proves itself with GitHub's OIDC
 * token. `req.inputs` is not sent: the worker gets the audit's settings from `register`. GitHub
 * refuses an input the workflow does not declare, so the two lists must match.
 */
export class GitHubDispatcher implements Dispatcher {
  constructor(private readonly cfg: GitHubWorkerConfig & { token: string; appUrl: string; fetch?: typeof fetch }) {}

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return (this.cfg.fetch ?? fetch)(`${API}/repos/${this.cfg.repository}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.cfg.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'audit-platform',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  }

  async dispatch(req: DispatchRequest): Promise<void> {
    let res: Response;
    try {
      res = await this.call('POST', `/actions/workflows/${this.cfg.workflow}/dispatches`, {
        ref: this.cfg.ref,
        inputs: {
          kind: req.kind,
          id: req.id,
          attempt: String(req.attempt),
          nonce: req.nonce,
          app_url: this.cfg.appUrl,
        },
      });
    } catch (err) {
      throw new DispatchUnavailable(`GitHub dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return;
    const text = (await res.text().catch(() => '')).slice(0, 300);
    // 401, 403, 404 and 422 mean a wrong token, repository, workflow or input: say so in the log.
    if (res.status < 500 && res.status !== 429)
      console.error(`[dispatch] GitHub refused the run: ${res.status} ${text}`);
    throw new DispatchUnavailable(`GitHub dispatch: ${res.status} ${text}`);
  }

  /** The run for this attempt, newest first; null when there is none in the last pages. */
  private async find(kind: string | null, id: string, attempt: number): Promise<Run | null> {
    const titles = (kind ? [kind] : ['audit', 'render-pdf']).map((k) => runTitle(k, id, attempt));
    for (let page = 1; page <= RUN_PAGES; page++) {
      const res = await this.call(
        'GET',
        `/actions/workflows/${this.cfg.workflow}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
      );
      if (!res.ok) throw new Error(`GitHub runs: ${res.status}`);
      const runs = ((await res.json()) as { workflow_runs?: Run[] }).workflow_runs ?? [];
      const hit = runs.find((r) => titles.includes(r.display_title));
      if (hit) return hit;
      if (runs.length < 100) break;
    }
    return null;
  }

  /**
   * An error from GitHub is answered as `waiting`: the reaper then leaves the attempt alone, and its
   * hard timeout gives up on a run that never registers.
   */
  async state(id: string, attempt: number): Promise<'waiting' | 'running' | 'gone'> {
    try {
      const run = await this.find(null, id, attempt);
      if (!run || run.status === 'completed') return 'gone';
      return run.status === 'in_progress' ? 'running' : 'waiting';
    } catch (err) {
      console.warn(`[dispatch] could not read the run of ${id} #${attempt}`, err);
      return 'waiting';
    }
  }

  async cancel(id: string, attempt: number): Promise<void> {
    const run = await this.find(null, id, attempt);
    if (!run || run.status === 'completed') return;
    const res = await this.call('POST', `/actions/runs/${run.id}/cancel`);
    // 409: the run ended between the two calls.
    if (!res.ok && res.status !== 409) throw new Error(`GitHub cancel: ${res.status}`);
  }
}
