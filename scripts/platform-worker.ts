/**
 * The one worker entry (build guide §3): the local Dispatcher starts it as a child process, and
 * `.github/workflows/platform-worker.yml` runs it in production. Talks to the app only through
 * /api/worker/* and uploads.
 *
 * Env: APP_URL, PLATFORM_WORKER_TOKEN (on a GitHub runner: PLATFORM_OIDC_AUDIENCE instead, and the
 * token is requested from GitHub), WORKER_KIND (audit), WORKER_ID, WORKER_ATTEMPT, DISPATCH_NONCE,
 * WORK_DIR; optional PLATFORM_HEARTBEAT_MS, PLATFORM_PROGRESS_MS, PLATFORM_SNAPSHOT_INTERVAL_MS,
 * PLATFORM_MAX_RUN_MINUTES_FULL / _QUICK / _PAGE (350 / 45 / 20), PLATFORM_STALL_MINUTES (30).
 */
import path from 'node:path';
import { loadDotEnv } from '../lib/utils/load-env';
import { runWorker, workerEnvFrom } from '../lib/platform-worker/run';
import { platformSteps } from '../lib/platform-worker/steps';
import { runPdfJob } from '../lib/platform-worker/render-pdf-job';
import { scrubPlatformSecrets, scrubWorkerIdentity } from '../lib/platform-worker/env';
import { githubOidcToken } from '../lib/platform-worker/github-oidc';

const repoRoot = path.resolve(__dirname, '..');
loadDotEnv(repoRoot);
// The checkout's .env must not bring back what the Dispatcher kept from the worker.
scrubPlatformSecrets(process.env);

async function main(): Promise<number> {
  const kind = process.env.WORKER_KIND ?? 'audit';
  if (!process.env.PLATFORM_WORKER_TOKEN) {
    const token = await githubOidcToken(process.env);
    if (token) process.env.PLATFORM_WORKER_TOKEN = token;
  }
  const env = workerEnvFrom(process.env, repoRoot);
  scrubWorkerIdentity(process.env);
  if (kind === 'render-pdf') return runPdfJob(env);
  if (kind !== 'audit') throw new Error(`worker kind ${kind} is not supported`);
  return runWorker(env, platformSteps());
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
