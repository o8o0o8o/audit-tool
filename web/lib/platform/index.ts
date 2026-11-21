import path from 'node:path';
import { LocalDispatcher, repoRootFrom } from './local/dispatcher';
import { LocalFileStore } from './local/file-store';
import { LocalWorkerIdentity } from './local/identity';
import type { Dispatcher, Platform, WorkerIdentity } from './types';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Picks the platform implementations by PLATFORM_MODE. `local` refuses to run in Vercel production. */
export function createPlatform(
  env: Env = process.env,
  parts: { dispatcher?: Dispatcher; identity?: WorkerIdentity } = {},
): Platform {
  const mode = env.PLATFORM_MODE;
  if (mode === 'local') {
    if (env.VERCEL_ENV === 'production') throw new Error('PLATFORM_MODE=local is refused when VERCEL_ENV=production');
    const secret = required(env, 'LOCAL_WORKER_SECRET');
    if (secret.length < 32) throw new Error('LOCAL_WORKER_SECRET must be at least 32 characters');
    const appUrl = required(env, 'APP_URL');
    const root = repoRootFrom();
    const filesDir = env.FILES_DIR ? path.resolve(env.FILES_DIR) : path.join(root, '.platform/files');
    const identity = new LocalWorkerIdentity(secret);
    return {
      mode,
      files: new LocalFileStore(filesDir, { appUrl, secret }),
      dispatcher: parts.dispatcher ?? new LocalDispatcher(identity, { appUrl, repoRoot: root }),
      identity: parts.identity ?? identity,
    };
  }
  if (mode === 'production') throw new Error('PLATFORM_MODE=production is written at deployment (build guide §8)');
  throw new Error(`PLATFORM_MODE must be "local" or "production", got ${JSON.stringify(mode)}`);
}

let platform: Platform | undefined;
export function getPlatform(): Platform {
  return (platform ??= createPlatform());
}
