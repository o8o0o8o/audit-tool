/**
 * What the worker and the audit may see of the environment. The platform's own secrets never reach
 * the worker; the worker's identity token and nonce never reach the audit. Both `scripts/platform-worker.ts`
 * and `start.ts` read the checkout's `.env`, which could bring a removed name back, so the worker
 * removes them again after loading and hands the audit an empty value (an existing value wins over `.env`).
 */
import type { RunOptions } from '../model/run-options';

const PLATFORM_PRIVATE =
  /^(DATABASE_URL.*|INTERNAL_PASSWORD_HASH|SESSION_SECRET|REPORT_TOKEN_SECRET|LOCAL_WORKER_SECRET|TURNSTILE_SECRET_KEY|GITHUB_TOKEN|BLOB_READ_WRITE_TOKEN)$/;
/** Named even when unset, so `.env` cannot supply them to the audit. */
const PLATFORM_PRIVATE_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_TEST',
  'DATABASE_URL_UNPOOLED',
  'INTERNAL_PASSWORD_HASH',
  'SESSION_SECRET',
  'REPORT_TOKEN_SECRET',
  'LOCAL_WORKER_SECRET',
  'TURNSTILE_SECRET_KEY',
  'GITHUB_TOKEN',
  'BLOB_READ_WRITE_TOKEN',
];
const WORKER_ONLY = [
  'PLATFORM_WORKER_TOKEN',
  'DISPATCH_NONCE',
  'WORKER_ID',
  'WORKER_ATTEMPT',
  'WORKER_INPUTS',
  'WORKER_KIND',
];
const LLM_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Removes the platform's secrets from the worker's own environment (after `.env` was loaded). */
export function scrubPlatformSecrets(env: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(env)) if (PLATFORM_PRIVATE.test(k)) delete env[k];
}

/** Removes the worker's identity token and nonce once they have been read. */
export function scrubWorkerIdentity(env: NodeJS.ProcessEnv): void {
  delete env.PLATFORM_WORKER_TOKEN;
  delete env.DISPATCH_NONCE;
}

/**
 * The audit child's environment: the worker's, without platform secrets and worker identity. The
 * keys the audit uses stay (`CRUX_API_KEY`, `WPSCAN_API_TOKEN`); LLM keys stay only when the run
 * asks for an LLM pass.
 */
export function auditChildEnv(
  env: NodeJS.ProcessEnv,
  options: Pick<RunOptions, 'llm' | 'verify' | 'contentResearch'>,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const usesLlm = options.llm || options.verify || options.contentResearch;
  const blank = [...PLATFORM_PRIVATE_NAMES, ...WORKER_ONLY, ...(usesLlm ? [] : LLM_KEYS)];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || PLATFORM_PRIVATE.test(k) || blank.includes(k)) continue;
    out[k] = v;
  }
  for (const k of blank) out[k] = '';
  return { ...out, ...extra };
}
