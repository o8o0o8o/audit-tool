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
}

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
  const beat = setInterval(() => {
    client.heartbeat().catch((err) => {
      if (err instanceof StaleAttempt) stop('attempt is no longer current');
    });
  }, env.heartbeatMs);
  let child: ReturnType<typeof spawn> | null = null;
  const stop = (why: string) => {
    if (stopped) return;
    stopped = true;
    log(`stopping: ${why}`);
    clearInterval(beat);
    // The local Dispatcher starts the worker as a process-group leader: the audit and Chromium are
    // in the same group, so one kill ends them all.
    if (process.env.PLATFORM_WORKER_GROUP_LEADER === '1') {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        /* fall through */
      }
    }
    child?.kill('SIGKILL');
    process.exit(3);
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
    const host = audit.mode === 'page' ? null : await finalHost(audit.target_url);
    if (host && host !== audit.host) {
      const g = await client.guard(host);
      if (!g.allowed) {
        await client.status({ status: 'cancelled', error: 'scan_guard' });
        log(`homepage redirects to ${host}, which must not be scanned`);
        clearInterval(beat);
        return 0;
      }
    }

    const options = normalizeRunOptions(audit.mode, audit.options);
    const args = toCliArgs({ mode: audit.mode, url: audit.target_url, profile: audit.profile, options, proceed });
    const progressFile = path.join(env.workDir, 'progress.json');
    const marker = path.join(env.workDir, 'checkpoint.marker');
    await client.progress({ phase: 'crawl' });
    log(`start.ts ${args.join(' ')}`);
    child = spawn(
      process.execPath,
      ['--import', tsxLoader(env.repoRoot), path.join(env.repoRoot, 'start.ts'), ...args],
      {
        cwd: env.workDir,
        env: { ...process.env, AUDIT_PROGRESS_FILE: progressFile, AUDIT_CHECKPOINT_MARKER: marker },
        stdio: 'inherit',
      },
    );

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
                .catch((err) => err instanceof StaleAttempt && stop('stale'));
            }
          }
        } catch {
          /* a half-written progress file; next tick */
        }
        const m = mtimeOf(marker);
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
            .catch((err) => (err instanceof StaleAttempt ? stop('stale') : log(`snapshot failed: ${err.message}`)))
            .finally(() => (snapshotting = false));
        }
      },
      Math.min(env.progressMs, 5000),
    );

    const code: number = await new Promise((resolve) => child!.on('exit', (c) => resolve(c ?? 1)));
    clearInterval(poll);
    child = null;
    if (code !== 0) {
      await client.status({ status: 'failed', error: `audit exited with code ${code}` });
      clearInterval(beat);
      return 1;
    }
    const runDir = findRunDir(env.workDir, base);
    if (!runDir) {
      await client.status({ status: 'failed', error: 'no audit results produced' });
      clearInterval(beat);
      return 1;
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
    clearInterval(beat);
    return 0;
  } catch (err) {
    if (err instanceof StaleAttempt) stop('attempt is no longer current');
    log(`failed: ${err instanceof Error ? err.stack : err}`);
    await client
      .status({ status: 'failed', error: String(err instanceof Error ? err.message : err).slice(0, 1000) })
      .catch(() => {});
    clearInterval(beat);
    return 1;
  }
}
