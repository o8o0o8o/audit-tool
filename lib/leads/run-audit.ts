/**
 * Runs the audit CLI (`start.ts`) as a child process with a hard timeout.
 *
 * Without a timeout one site that never finishes holds a whole batch: `start.ts` restarts a
 * crashed run up to three times and has no time limit of its own. Here the child gets its own
 * process group; on timeout the whole group is asked to stop (SIGTERM, so Playwright can close its
 * browser) and killed a few seconds later if it has not.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeDomainName } from '../../validators';
import { readCompressedJson } from '../utils';
import { FileManager } from '../storage/file-manager';
import type { LeadScanInfo } from './types';

export interface AuditRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface AuditRunOptions {
  timeoutMs: number;
  /** Append the child's output here instead of the terminal. */
  logFile?: string;
  /** Grace period between SIGTERM and SIGKILL. */
  killAfterMs?: number;
  /** Test seam: the command to run instead of `npx tsx start.ts`. */
  command?: [string, ...string[]];
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // negative pid = the whole process group
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function runAuditProcess(args: string[], opts: AuditRunOptions): Promise<AuditRunResult> {
  const [command, ...baseArgs] = opts.command ?? ['npx', 'tsx', 'start.ts'];
  const started = Date.now();
  let logFd: number | null = null;
  if (opts.logFile) {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    logFd = fs.openSync(opts.logFile, 'a');
  }

  return new Promise((resolve) => {
    const child = spawn(command, [...baseArgs, ...args], {
      detached: true, // own process group, so the timeout can stop the whole tree
      stdio: logFd === null ? 'inherit' : ['ignore', logFd, logFd],
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        killGroup(child.pid, 'SIGTERM');
        const pid = child.pid;
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), opts.killAfterMs ?? 8000);
      }
    }, opts.timeoutMs);

    // Ctrl+C on the batch stops the running audit too (it is in another process group).
    const onSigint = () => {
      if (child.pid) killGroup(child.pid, 'SIGINT');
    };
    process.on('SIGINT', onSigint);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      if (killTimer && !timedOut) clearTimeout(killTimer);
      process.off('SIGINT', onSigint);
      if (logFd !== null) fs.closeSync(logFd);
      logFd = null;
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}

export interface LeadRunSummary {
  runDir: string;
  pagesOk: number;
  pagesFailed: number;
  /** Error keys the crawl recorded (`403`, `challenge-403`, `timeout`…). */
  errors: Record<string, number>;
  leadScan: LeadScanInfo | null;
  hasFieldData: boolean;
}

/**
 * The newest run folder of `origin` under `base`, if it was created at or after `since`.
 * Reads the manifest and metadata the audit wrote; null when the run left nothing usable.
 */
export function readLatestRun(origin: string, base: string, since: Date): LeadRunSummary | null {
  const runDir = FileManager.findLatestRun(sanitizeDomainName(origin), base);
  if (!runDir) return null;
  // Folder names are local timestamps: YYYY-MM-DD_HH-MM-SS.
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(runDir);
  if (m) {
    const created = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (created.getTime() < since.getTime() - 2000) return null;
  }
  try {
    const manifest = readCompressedJson<{
      progress?: { totalWithoutError?: number; totalWithError?: number; byError?: Record<string, number> };
    }>(path.join(runDir, 'manifest.json.gz'));
    const metadata = readCompressedJson<{ leadScan?: LeadScanInfo; cruxData?: unknown }>(
      path.join(runDir, 'metadata.json.gz'),
    );
    return {
      runDir,
      pagesOk: manifest.progress?.totalWithoutError ?? 0,
      pagesFailed: manifest.progress?.totalWithError ?? 0,
      errors: manifest.progress?.byError ?? {},
      leadScan: metadata.leadScan ?? null,
      hasFieldData: Boolean(metadata.cruxData),
    };
  } catch {
    return null;
  }
}
