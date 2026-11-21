import path from 'node:path';
import { LocalFileStore } from './local/file-store';
import type { Dispatcher, Platform, WorkerIdentity } from './types';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Picks the platform implementations by PLATFORM_MODE. `local` refuses to run in Vercel production. */
export function createPlatform(env: Env = process.env, parts: { dispatcher?: Dispatcher; identity?: WorkerIdentity } = {}): Platform {
  const mode = env.PLATFORM_MODE;
  if (mode === 'local') {
    if (env.VERCEL_ENV === 'production') throw new Error('PLATFORM_MODE=local is refused when VERCEL_ENV=production');
    const secret = required(env, 'LOCAL_WORKER_SECRET');
    if (secret.length < 32) throw new Error('LOCAL_WORKER_SECRET must be at least 32 characters');
    const files = new LocalFileStore(path.resolve(env.FILES_DIR ?? '../.platform/files'), {
      appUrl: required(env, 'APP_URL'),
      secret,
    });
    // The local Dispatcher and WorkerIdentity arrive in step 1 (tasks 1.5, 1.6).
    const notYet = (what: string) => new Proxy({}, { get: () => () => { throw new Error(`${what} is not built yet`); } });
    return {
      mode,
      files,
      dispatcher: parts.dispatcher ?? (notYet('local Dispatcher') as Dispatcher),
      identity: parts.identity ?? (notYet('local WorkerIdentity') as WorkerIdentity),
    };
  }
  if (mode === 'production') throw new Error('PLATFORM_MODE=production is written at deployment (build guide §8)');
  throw new Error(`PLATFORM_MODE must be "local" or "production", got ${JSON.stringify(mode)}`);
}

let platform: Platform | undefined;
export function getPlatform(): Platform {
  return (platform ??= createPlatform());
}
