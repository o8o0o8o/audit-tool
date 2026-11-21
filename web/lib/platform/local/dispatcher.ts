import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DispatchRequest, Dispatcher } from '../types';
import type { LocalWorkerIdentity } from './identity';

/** Env names never passed to a worker: the worker talks to the app only through worker routes. */
const PRIVATE_ENV =
  /^(DATABASE_URL|DATABASE_URL_TEST|INTERNAL_PASSWORD_HASH|SESSION_SECRET|REPORT_TOKEN_SECRET|LOCAL_WORKER_SECRET|TURNSTILE_SECRET_KEY|GITHUB_TOKEN|BLOB_READ_WRITE_TOKEN|__NEXT.*|NEXT_.*|TURBOPACK.*)$/;

export function repoRootFrom(cwd = process.cwd()): string {
  if (process.env.PLATFORM_REPO_ROOT) return path.resolve(process.env.PLATFORM_REPO_ROOT);
  return path.basename(cwd) === 'web' ? path.resolve(cwd, '..') : cwd;
}

interface WorkerFile {
  pid: number;
  runId: string;
  startedAt: string;
}

/**
 * Starts `scripts/platform-worker.ts` as a child process in its own process group, with a work
 * folder of its own (`.platform/work/<id>-<attempt>/`), output to `.platform/logs/<id>-<attempt>.log`.
 */
export class LocalDispatcher implements Dispatcher {
  readonly root: string;
  readonly platformDir: string;

  constructor(
    private readonly identity: LocalWorkerIdentity,
    private readonly opts: { appUrl: string; repoRoot?: string; extraEnv?: Record<string, string> },
  ) {
    this.root = opts.repoRoot ?? repoRootFrom();
    this.platformDir = path.join(this.root, '.platform');
  }

  workDir(id: string, attempt: number): string {
    return path.join(this.platformDir, 'work', `${id}-${attempt}`);
  }

  async dispatch(req: DispatchRequest): Promise<void> {
    const work = this.workDir(req.id, req.attempt);
    const logs = path.join(this.platformDir, 'logs');
    mkdirSync(work, { recursive: true });
    mkdirSync(logs, { recursive: true });
    const runId = String(randomInt(1, 2 ** 47));
    const token = this.identity.issue({ runId, runAttempt: 1, id: req.id, attempt: req.attempt });
    const env = {} as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE_ENV.test(k)) env[k] = v;
    Object.assign(env, this.opts.extraEnv ?? {}, {
      APP_URL: this.opts.appUrl,
      PLATFORM_WORKER_TOKEN: token,
      WORKER_KIND: req.kind,
      WORKER_ID: req.id,
      WORKER_ATTEMPT: String(req.attempt),
      DISPATCH_NONCE: req.nonce,
      WORKER_INPUTS: JSON.stringify(req.inputs),
      WORK_DIR: work,
      NODE_ENV: 'production',
      PLATFORM_WORKER_GROUP_LEADER: '1',
    });
    const log = openSync(path.join(logs, `${req.id}-${req.attempt}.log`), 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(this.root, 'scripts/platform-worker.ts')], {
      cwd: this.root,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    if (!child.pid) throw new Error('worker did not start');
    const info: WorkerFile = { pid: child.pid, runId, startedAt: new Date().toISOString() };
    writeFileSync(path.join(work, 'worker.json'), JSON.stringify(info));
    child.unref();
  }

  private read(id: string, attempt: number): WorkerFile | null {
    const f = path.join(this.workDir(id, attempt), 'worker.json');
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as WorkerFile;
    } catch {
      return null;
    }
  }

  async state(id: string, attempt: number): Promise<'waiting' | 'running' | 'gone'> {
    const info = this.read(id, attempt);
    if (!info) return 'gone';
    try {
      process.kill(info.pid, 0);
      return 'running';
    } catch {
      return 'gone';
    }
  }

  async cancel(id: string, attempt: number): Promise<void> {
    const info = this.read(id, attempt);
    if (!info) return;
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-info.pid, sig);
      } catch {
        /* already gone */
      }
    };
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 5000).unref();
  }
}
