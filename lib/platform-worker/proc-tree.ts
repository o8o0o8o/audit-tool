/**
 * Process control for the local worker: the whole tree under a process is found from `ps`
 * (Playwright starts Chromium in a process group of its own, so a group kill does not reach it),
 * and a process is identified by its pid together with its start time, so a reused pid is noticed.
 * No dependencies: the local Dispatcher in web/ uses it too.
 */
import { execFileSync } from 'node:child_process';

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
}

function ps(args: string[]): string | null {
  try {
    return execFileSync('ps', args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/** Every live process (zombies left out); null when `ps` cannot be run. */
function listProcesses(): Proc[] | null {
  const out = ps(['-A', '-o', 'pid=,ppid=,pgid=,stat=']);
  if (out === null) return null;
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m && !m[4]!.startsWith('Z')) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return procs;
}

/** When the process started, as `ps` prints it in UTC; null when it does not exist. */
export function processStart(pid: number): string | null {
  const out = ps(['-o', 'lstart=', '-p', String(pid)])?.trim();
  return out || null;
}

/**
 * Live pids under `seeds`: their descendants, and every member of a process group led by one of
 * them (so children whose parent has already died are still found).
 */
function treeOf(seeds: Iterable<number>, procs: Proc[]): Set<number> {
  const tree = new Set<number>(seeds);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!tree.has(p.pid) && (tree.has(p.ppid) || tree.has(p.pgid))) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  const live = new Set(procs.map((p) => p.pid));
  for (const pid of tree) if (!live.has(pid)) tree.delete(pid);
  return tree;
}

export function descendantsOf(root: number): number[] | null {
  const procs = listProcesses();
  if (!procs) return null;
  const tree = treeOf([root], procs);
  tree.delete(root);
  return [...tree];
}

/**
 * Kills (SIGKILL) everything under `root`, and `root` itself unless `includeRoot` is false, then
 * looks again until nothing is left or `verifyMs` has passed. The calling process is never killed.
 * Returns true when the tree is gone.
 */
export async function killTree(
  root: number,
  opts: { includeRoot?: boolean; verifyMs?: number } = {},
): Promise<boolean> {
  const includeRoot = opts.includeRoot ?? true;
  const end = Date.now() + (opts.verifyMs ?? 5000);
  const seen = new Set<number>([root]);
  for (;;) {
    const procs = listProcesses();
    if (!procs) {
      // No `ps`: the process group is all that can be reached.
      for (const target of includeRoot && root !== process.pid ? [-root, root] : []) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      return false;
    }
    const targets = treeOf(seen, procs);
    for (const pid of targets) seen.add(pid);
    targets.delete(process.pid);
    if (!includeRoot) targets.delete(root);
    if (!targets.size) return true;
    for (const pid of targets) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
