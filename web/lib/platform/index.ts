import path from 'node:path';
import { LocalDispatcher, repoRootFrom } from './local/dispatcher';
import { LocalFileStore } from './local/file-store';
import { LocalWorkerIdentity } from './local/identity';
import { BlobFileStore } from './production/blob-file-store';
import { GitHubDispatcher } from './production/github-dispatcher';
import { GitHubWorkerIdentity } from './production/github-identity';
import type { Dispatcher, Platform, WorkerIdentity } from './types';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Picks the platform implementations by PLATFORM_MODE. `local` refuses to run in Vercel production.
 * `production`: a private Vercel Blob store, workers as GitHub Actions runs, GitHub OIDC identity.
 */
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
  if (mode === 'production') {
    const appUrl = required(env, 'APP_URL').replace(/\/$/, '');
    if (!appUrl.startsWith('https://')) throw new Error('APP_URL must be an https address in production mode');
    const repository = required(env, 'WORKER_REPOSITORY');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('WORKER_REPOSITORY must be "owner/name"');
    const worker = {
      repository,
      workflow: env.WORKER_WORKFLOW || 'platform-worker.yml',
      ref: env.WORKER_REF || 'main',
    };
    const audience = required(env, 'WORKER_OIDC_AUDIENCE');
    return {
      mode,
      files: new BlobFileStore({ token: required(env, 'PLATFORM_BLOB_READ_WRITE_TOKEN'), appUrl }),
      dispatcher:
        parts.dispatcher ?? new GitHubDispatcher({ ...worker, token: required(env, 'GITHUB_DISPATCH_TOKEN'), appUrl }),
      identity:
        parts.identity ??
        new GitHubWorkerIdentity({ ...worker, audience, repositoryId: env.WORKER_REPOSITORY_ID || undefined }),
    };
  }
  throw new Error(`PLATFORM_MODE must be "local" or "production", got ${JSON.stringify(mode)}`);
}

let platform: Platform | undefined;
export function getPlatform(): Platform {
  return (platform ??= createPlatform());
}
