/**
 * The cron steps (design §3 "Crons"), defined once: the local loop (`scripts/local-crons.ts`) and
 * production's two timers (`/api/cron/tick` and `/api/cron/retention`, called on a schedule by
 * `.github/workflows/platform-cron.yml`) run the same functions. Every
 * step locks the rows it works on, so one that fires twice or overlaps itself does no double work.
 * Each step first asks the cron gate: while nothing is open it skips the database, so Neon can scale
 * to zero.
 */
import type { Db } from '../../db/client';
import type { Platform } from '../platform/types';
import { cronGate, gated } from './cron-gate';
import { dispatchJobs } from './jobs';
import { runLoader } from './loader';
import { dispatchNext } from './queue';
import { reap } from './reaper';
import { rescoreStale } from './rescore';
import { runRetention } from './retention';
import { deliverDueWebhooks, onAuditFinished } from './webhooks';

export const CRON_STEPS = ['reaper', 'dispatch', 'jobs', 'loader', 'rescore', 'webhooks', 'retention'] as const;
export type CronStepName = (typeof CRON_STEPS)[number];

/** The steps as plain functions, with no idle gate. */
function rawSteps(
  db: Db,
  platform: Platform,
  opts: { loaderBudgetMs?: number },
): Record<CronStepName, () => Promise<unknown>> {
  const onFinished = (id: string) => onAuditFinished(db, id);
  return {
    reaper: () => reap(db, platform.dispatcher, { onFinished }),
    dispatch: () => dispatchNext(db, platform, { onFinished }),
    jobs: () => dispatchJobs(db, platform),
    loader: () => runLoader(db, platform.files, { budgetMs: opts.loaderBudgetMs ?? 60_000, onFinished }),
    rescore: () => rescoreStale(db, platform.files),
    webhooks: () => deliverDueWebhooks(db, { allowPrivate: platform.mode === 'local' }),
    retention: () => runRetention(db, platform.files),
  };
}

/** Every step behind its own gate, for the local loop, where each step runs on a loop of its own. */
export function cronSteps(
  db: Db,
  platform: Platform,
  opts: { loaderBudgetMs?: number } = {},
): Record<CronStepName, () => Promise<unknown>> {
  const steps = rawSteps(db, platform, opts);
  // The reaper's tick also records the platform as idle once nothing is open.
  for (const name of CRON_STEPS) steps[name] = gated(db, platform.files, steps[name], { settle: name === 'reaper' });
  return steps;
}

/** The steps one tick runs: everything but retention, which has a daily run of its own. */
export const TICK_STEPS = CRON_STEPS.filter((s) => s !== 'retention');

export type TickResult = Record<string, { ok: true; result: unknown } | { ok: false; error: string }>;

/**
 * Production's tick, every 5 minutes: asks the idle gate once, then runs the tick steps side by side, so
 * a long load does not hold back the reaper or dispatch. A step that throws does not stop the
 * others. Ticks may overlap while a large audit loads; every step locks the rows it works on.
 * Returns null when the platform is idle and the database was left alone.
 */
export async function cronTick(
  db: Db,
  platform: Platform,
  opts: { loaderBudgetMs?: number } = {},
): Promise<TickResult | null> {
  const gate = cronGate(db, platform.files);
  if (!(await gate.shouldRun())) return null;
  const steps = rawSteps(db, platform, opts);
  const settled = await Promise.allSettled(TICK_STEPS.map((name) => steps[name]()));
  const out: TickResult = {};
  settled.forEach((r, i) => {
    const name = TICK_STEPS[i]!;
    if (r.status === 'fulfilled') out[name] = { ok: true, result: r.value ?? null };
    else {
      console.error(`[cron] ${name} failed`, r.reason);
      out[name] = { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    }
  });
  await gate.settle();
  return out;
}

/** Production's daily cron. Not gated: expired files are due while nothing is open. */
export const cronRetention = (db: Db, platform: Platform) => rawSteps(db, platform, {}).retention();
