/**
 * The cron steps (design §3 "Crons"), defined once: the local loop (`scripts/local-crons.ts`) and the
 * production routes (`/api/cron/<step>`, scheduled in `vercel.json`) run the same functions. Every
 * step locks the rows it works on, so one that fires twice or overlaps itself does no double work.
 * Each step first asks the cron gate: while nothing is open it skips the database, so Neon can scale
 * to zero.
 */
import type { Db } from '../../db/client';
import type { Platform } from '../platform/types';
import { gated } from './cron-gate';
import { dispatchJobs } from './jobs';
import { runLoader } from './loader';
import { dispatchNext } from './queue';
import { reap } from './reaper';
import { rescoreStale } from './rescore';
import { runRetention } from './retention';
import { deliverDueWebhooks, onAuditFinished } from './webhooks';

export const CRON_STEPS = ['reaper', 'dispatch', 'jobs', 'loader', 'rescore', 'webhooks', 'retention'] as const;
export type CronStepName = (typeof CRON_STEPS)[number];

export function cronSteps(
  db: Db,
  platform: Platform,
  /**
   * `gateRetention: false` for a scheduler that runs retention once a day: the idle gate would
   * skip that one run, and retention has work (expired files) while nothing is open.
   */
  opts: { loaderBudgetMs?: number; gateRetention?: boolean } = {},
): Record<CronStepName, () => Promise<unknown>> {
  const onFinished = (id: string) => onAuditFinished(db, id);
  const steps: Record<CronStepName, () => Promise<unknown>> = {
    reaper: () => reap(db, platform.dispatcher, { onFinished }),
    dispatch: () => dispatchNext(db, platform, { onFinished }),
    jobs: () => dispatchJobs(db, platform),
    loader: () => runLoader(db, platform.files, { budgetMs: opts.loaderBudgetMs ?? 60_000, onFinished }),
    rescore: () => rescoreStale(db, platform.files),
    webhooks: () => deliverDueWebhooks(db, { allowPrivate: platform.mode === 'local' }),
    retention: () => runRetention(db, platform.files),
  };
  // The reaper's tick also records the platform as idle once nothing is open.
  for (const name of CRON_STEPS) {
    if (name === 'retention' && opts.gateRetention === false) continue;
    steps[name] = gated(db, platform.files, steps[name], { settle: name === 'reaper' });
  }
  return steps;
}
