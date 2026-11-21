/**
 * One worker run (build guide §3 "One worker entry"): register, heartbeat, restore a snapshot when
 * resuming, guard a cross-domain homepage, run `start.ts`, forward progress, snapshot after each
 * checkpoint, then the platform steps (fingerprint, gate, secrets masking, model build) and upload.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL_VERSION } from '../model/version';
import { normalizeRunOptions, toCliArgs } from '../model/run-options';
import { AppClient, StaleAttempt, type RegisteredAudit } from './client';
import { mtimeOf, restoreSnapshot, Snapshotter } from './snapshot';
import { uploadRun } from './files';
import { auditChildEnv } from './env';
import { killTree } from './proc-tree';

export interface WorkerEnv {
  appUrl: string;
  identityToken: string;
  auditId: string;
  attempt: number;
  nonce: string;
  workDir: string;
  repoRoot: string;
  heartbeatMs: number;
  progressMs: number;
  snapshotIntervalMs: number;
  /** Wall-clock limit of one run, by mode; after it the worker kills the audit and reports `failed`. */
  maxRunMs: Record<RegisteredAudit['mode'], number>;
  /** The audit child has written nothing (progress, checkpoint, output) for this long: the run is given up. */
  stallMs: number;
}

/** Full audits: the GitHub workflow's 350 minutes. A quick scan loads 25 pages, a page audit one. */
const MAX_RUN_MINUTES = { full: 350, quick: 45, page: 20 } as const;

export function workerEnvFrom(env: NodeJS.ProcessEnv, repoRoot: string): WorkerEnv {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    appUrl: need('APP_URL').replace(/\/$/, ''),
    identityToken: need('PLATFORM_WORKER_TOKEN'),
    auditId: need('WORKER_ID'),
    attempt: Number(need('WORKER_ATTEMPT')),
    nonce: need('DISPATCH_NONCE'),
    workDir: path.resolve(need('WORK_DIR')),
    repoRoot,
    heartbeatMs: Number(env.PLATFORM_HEARTBEAT_MS) || 60_000,
    progressMs: Number(env.PLATFORM_PROGRESS_MS) || 15_000,
    snapshotIntervalMs: Number(env.PLATFORM_SNAPSHOT_INTERVAL_MS) || 10 * 60_000,
    maxRunMs: {
      full: (Number(env.PLATFORM_MAX_RUN_MINUTES_FULL) || MAX_RUN_MINUTES.full) * 60_000,
      quick: (Number(env.PLATFORM_MAX_RUN_MINUTES_QUICK) || MAX_RUN_MINUTES.quick) * 60_000,
      page: (Number(env.PLATFORM_MAX_RUN_MINUTES_PAGE) || MAX_RUN_MINUTES.page) * 60_000,
    },
    stallMs: (Number(env.PLATFORM_STALL_MINUTES) || 30) * 60_000,
  };
}

/** tsx's loader as a file URL, so the audit runs from any work folder. */
export function tsxLoader(repoRoot: string): string {
  return pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
}

const log = (...a: unknown[]) => console.log(`[worker ${new Date().toISOString()}]`, ...a);

export function resultsBase(mode: string): string {
  return mode === 'quick' ? 'lead-results' : 'audit-results';
}

/** The newest `<base>/<domain>/<timestamp>/` folder in the work folder. */
export function findRunDir(workDir: string, base: string): string | null {
  const root = path.join(workDir, base);
  if (!existsSync(root)) return null;
  const runs: string[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const t of readdirSync(path.join(root, d.name), { withFileTypes: true })) {
      if (t.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(t.name)) runs.push(path.join(root, d.name, t.name));
    }
  }
  runs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return runs[0] ?? null;
}

/**
 * Follows the homepage's redirects one hop at a time and returns the host it lands on (lower-case).
 * A hop that cannot be fetched still names its host, so a redirect to an unreachable domain is guarded too.
 */
async function finalHost(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FR-Audit/1.0)' },
      });
    } catch {
      return hop === 0 ? null : new URL(current).hostname.toLowerCase();
    }
    await res.body?.cancel();
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return new URL(current).hostname.toLowerCase();
    current = new URL(loc, current).toString();
  }
  return new URL(current).hostname.toLowerCase();
}

export interface PlatformSteps {
  fingerprint?: (ctx: StepContext) => Promise<void>;
  gate?: (ctx: StepContext) => Promise<void>;
  mask?: (ctx: StepContext) => Promise<void>;
  build?: (ctx: StepContext) => Promise<void>;
}

export interface StepContext {
  audit: RegisteredAudit;
  runDir: string;
  repoRoot: string;
}

export async function runWorker(env: WorkerEnv, steps: PlatformSteps = {}): Promise<number> {
  const client = new AppClient(env.appUrl);
  const audit = await client.register(env.identityToken, {
    audit_id: env.auditId,
    attempt: env.attempt,
    nonce: env.nonce,
  });
  log(`registered ${audit.audit_id} attempt ${audit.attempt}: ${audit.mode} ${audit.target_url}`);
  mkdirSync(env.workDir, { recursive: true });

  let stopped = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  /** Never resolves: the run is being stopped and the process exits from `stop`. */
  const halt = () => new Promise<never>(() => {});
  /**
   * Ends the run: no more heartbeats, the audit and everything it started (Chromium runs in a
   * process group of its own) is killed and checked to be gone, then the worker exits.
   * `report` is sent as the audit's final status; without it the reaper redispatches the audit.
   */
  const stop = async (why: string, code: number, report?: string): Promise<never> => {
    if (stopped) return halt();
    stopped = true;
    log(`stopping: ${why}`);
    for (const t of timers) clearInterval(t);
    const gone = await killTree(process.pid, { includeRoot: false });
    if (!gone) log('some child processes could not be killed');
    if (report) await client.status({ status: 'failed', error: report }).catch(() => {});
    process.exit(code);
  };
  const stale = () => stop('attempt is no longer current', 3);
  timers.push(
    setInterval(() => {
      client.heartbeat().catch((err) => {
        if (err instanceof StaleAttempt) void stale();
      });
    }, env.heartbeatMs),
  );
  const maxRunMs = env.maxRunMs[audit.mode];
  const maxRunMin = Math.round(maxRunMs / 60_000);
  timers.push(
    setInterval(
      () =>
        void stop(
          `run time limit of ${maxRunMin} min reached`,
          1,
          `stopped after ${maxRunMin} minutes (run time limit)`,
        ),
      maxRunMs,
    ),
  );
  const finish = (code: number): number => {
    for (const t of timers) clearInterval(t);
    return code;
  };

  try {
    const base = resultsBase(audit.mode);
    // Resume: restore the newest snapshot of an earlier attempt and run with --proceed.
    let proceed = false;
    if (audit.resume_from_attempt) {
      await client.progress({ phase: 'restore' });
      const snap = await client.snapshot();
      if (snap && snap.manifest.base === base) {
        const n = await restoreSnapshot(client, env.workDir, snap);
        proceed = n > 0;
        log(`restored ${n} file(s) from attempt ${snap.attempt}`);
      } else log('no snapshot to resume from; starting over');
    }

    // Guard a homepage that lands on another host before anything else is loaded.
    const host = await finalHost(audit.target_url);
    if (host && host !== audit.host) {
      const g = await client.guard(host);
      if (!g.allowed) {
        await client.status({ status: 'cancelled', error: 'scan_guard' });
        log(`homepage redirects to ${host}, which must not be scanned`);
        return finish(0);
      }
    }

    const options = normalizeRunOptions(audit.mode, audit.options);
    const args = toCliArgs({ mode: audit.mode, url: audit.target_url, profile: audit.profile, options, proceed });
    const progressFile = path.join(env.workDir, 'progress.json');
    const marker = path.join(env.workDir, 'checkpoint.marker');
    await client.progress({ phase: 'crawl' });
    log(`start.ts ${args.join(' ')}`);
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader(env.repoRoot), path.join(env.repoRoot, 'start.ts'), ...args],
      {
        cwd: env.workDir,
        env: auditChildEnv(process.env, options, {
          AUDIT_PROGRESS_FILE: progressFile,
          AUDIT_CHECKPOINT_MARKER: marker,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Output is passed on, and counts as a sign of life: the phases after the crawl write no progress file.
    let lastActivity = Date.now();
    child.stdout.on('data', (d: Buffer) => {
      lastActivity = Date.now();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      lastActivity = Date.now();
      process.stderr.write(d);
    });

    const snapshotter = new Snapshotter(client, env.workDir, base, audit.audit_id, audit.attempt);
    let lastProgress = '';
    let lastMarker = 0;
    let snapshotting = false;
    const poll = setInterval(
      () => {
        try {
          if (existsSync(progressFile)) {
            const raw = readFileSync(progressFile, 'utf8');
            if (raw !== lastProgress) {
              lastProgress = raw;
              const p = JSON.parse(raw) as { processed?: number; total?: number };
              client
                .progress({ processed: p.processed, total: p.total })
                .catch((err) => err instanceof StaleAttempt && void stale());
            }
          }
        } catch {
          /* a half-written progress file; next tick */
        }
        const m = mtimeOf(marker);
        const idle = Date.now() - Math.max(lastActivity, mtimeOf(progressFile), m);
        if (idle > env.stallMs) {
          // No final status: the reaper sees the heartbeat stop and redispatches from the snapshot.
          void stop(`the audit has made no progress for ${Math.round(idle / 60_000)} min`, 4);
          return;
        }
        const due = snapshotter.count === 0 || Date.now() - snapshotter.lastAt >= env.snapshotIntervalMs;
        if (m && m !== lastMarker && due && !snapshotting) {
          snapshotting = true;
          snapshotter
            .take(() => mtimeOf(marker) === m)
            .then((ok) => {
              if (ok) {
                lastMarker = m;
                log(`snapshot ${snapshotter.count} taken`);
              }
            })
            .catch((err) => (err instanceof StaleAttempt ? void stale() : log(`snapshot failed: ${err.message}`)))
            .finally(() => (snapshotting = false));
        }
      },
      Math.min(env.progressMs, 5000),
    );

    timers.push(poll);
    const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
    clearInterval(poll);
    if (stopped) await halt();
    if (code !== 0) {
      await client.status({ status: 'failed', error: `audit exited with code ${code}` });
      return finish(1);
    }
    const runDir = findRunDir(env.workDir, base);
    if (!runDir) {
      await client.status({ status: 'failed', error: 'no audit results produced' });
      return finish(1);
    }
    const ctx: StepContext = { audit, runDir, repoRoot: env.repoRoot };
    // Platform steps: each is separate from the audit and never fails it (except the model build).
    for (const [phase, fn] of [
      ['fingerprint', steps.fingerprint],
      ['gate', steps.gate],
    ] as const) {
      if (!fn) continue;
      await client.progress({ phase });
      await fn(ctx).catch((err) => log(`${phase} failed (audit continues): ${err instanceof Error ? err.stack : err}`));
    }
    await steps.mask?.(ctx);
    await client.progress({ phase: 'build' });
    await steps.build?.(ctx);
    await client.progress({ phase: 'upload' });
    const artifacts = await uploadRun(client, runDir, audit.audit_id, audit.attempt);
    const pkg = JSON.parse(readFileSync(path.join(env.repoRoot, 'package.json'), 'utf8')) as { version: string };
    await client.status({
      status: steps.build ? 'built' : 'succeeded',
      tool_version: pkg.version,
      model_version: MODEL_VERSION,
      artifacts,
    });
    log(`uploaded ${artifacts.length} artifact(s); status ${steps.build ? 'built' : 'succeeded'}`);
    return finish(0);
  } catch (err) {
    // A 409 on any call (a status call included: the audit was cancelled or reaped) ends the run quietly.
    if (err instanceof StaleAttempt) await stale();
    if (stopped) await halt();
    log(`failed: ${err instanceof Error ? err.stack : err}`);
    await client
      .status({ status: 'failed', error: String(err instanceof Error ? err.message : err).slice(0, 1000) })
      .catch(() => {});
    return finish(1);
  }
}
