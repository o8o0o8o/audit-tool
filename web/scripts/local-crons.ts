/**
 * Local stand-in for the Vercel crons (design §10): dispatch, loader, reaper, webhooks, PDF jobs and
 * retention, each in a loop of its own. Every step locks the rows it works on, so two loops never double-work.
 * Each step first asks the cron gate (`lib/core/cron-gate.ts`): while nothing is open it skips the database,
 * as the production crons must, so Neon can scale to zero.
 *   yarn --cwd web crons            (CRON_INTERVAL_MS, default 15000; --once for one pass)
 */
import { closeDb, getDb } from '../db/client';
import { getPlatform } from '../lib/platform';
import { cronSteps } from '../lib/core/cron-steps';
import { runCronLoops, type CronStep } from '../lib/platform/local/cron-loop';

const once = process.argv.includes('--once');
const interval = Number(process.env.CRON_INTERVAL_MS) || 15_000;
let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

type Step = CronStep;

const steps = (): Step[] => Object.entries(cronSteps(getDb(), getPlatform()));

async function run([name, fn]: Step): Promise<void> {
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
}

async function main(): Promise<void> {
  console.log(`[cron] local crons every ${interval} ms (${getPlatform().mode} mode)`);
  // --once: one pass in order. Otherwise every step runs on its own loop, so a slow one (a webhook
  // to a slow endpoint, a long load) does not hold back the reaper or dispatch.
  if (once) for (const step of steps()) await run(step);
  else await runCronLoops(steps(), run, interval, () => stopping);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
