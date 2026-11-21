/**
 * Local stand-in for the Vercel crons (design §10): dispatch, loader, reaper, webhooks, PDF jobs and
 * retention, in a loop. Every step locks the rows it works on, so two loops never double-work.
 *   yarn --cwd web crons            (CRON_INTERVAL_MS, default 15000; --once for one pass)
 */
import { closeDb, getDb } from '../db/client';
import { getPlatform } from '../lib/platform';
import { dispatchNext } from '../lib/core/queue';
import { runLoader } from '../lib/core/loader';
import { reap } from '../lib/core/reaper';
import { deliverDueWebhooks, onAuditFinished } from '../lib/core/webhooks';
import { runRetention } from '../lib/core/retention';
import { dispatchJobs } from '../lib/core/jobs';
import { rescoreStale } from '../lib/core/rescore';

const once = process.argv.includes('--once');
const interval = Number(process.env.CRON_INTERVAL_MS) || 15_000;
let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

async function pass(): Promise<void> {
  const db = getDb();
  const platform = getPlatform();
  const onFinished = (id: string) => onAuditFinished(db, id);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      const show = Array.isArray(r)
        ? r.length
        : r && typeof r === 'object'
          ? Object.values(r)
              .flat()
              .some((v) => (typeof v === 'number' ? v > 0 : !!v))
          : r;
      if (show) console.log(`[cron ${new Date().toISOString()}] ${name}: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error(`[cron] ${name} failed`, err);
    }
  };
  await step('reaper', () => reap(db, platform.dispatcher, { onFinished }));
  await step('dispatch', () => dispatchNext(db, platform, { onFinished }));
  await step('jobs', () => dispatchJobs(db, platform));
  await step('loader', () => runLoader(db, platform.files, { budgetMs: 60_000, onFinished }));
  await step('rescore', () => rescoreStale(db, platform.files));
  await step('webhooks', () => deliverDueWebhooks(db, { allowPrivate: platform.mode === 'local' }));
  await step('retention', () => runRetention(db, platform.files));
}

async function main(): Promise<void> {
  console.log(`[cron] local crons every ${interval} ms (${getPlatform().mode} mode)`);
  do {
    await pass();
    if (once) break;
    for (let t = 0; t < interval && !stopping; t += 500) await new Promise((r) => setTimeout(r, 500));
  } while (!stopping);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
