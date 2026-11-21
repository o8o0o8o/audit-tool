import { signToken, verifyToken } from '../../core/tokens';
import type { WorkerClaims, WorkerIdentity } from '../types';

/** A short-lived token signed with LOCAL_WORKER_SECRET. Accepted only in PLATFORM_MODE=local. */
export class LocalWorkerIdentity implements WorkerIdentity {
  constructor(private readonly secret: string) {}

  issue(claims: Required<WorkerClaims>, ttlSeconds = 900): string {
    return signToken('worker', { ...claims }, this.secret, ttlSeconds);
  }

  async verify(token: string): Promise<WorkerClaims | null> {
    const c = verifyToken<{ runId: string; runAttempt: number; id: string; attempt: number }>(
      'worker',
      token,
      this.secret,
    );
    if (!c || typeof c.runId !== 'string' || typeof c.id !== 'string') return null;
    return { runId: c.runId, runAttempt: c.runAttempt, id: c.id, attempt: c.attempt };
  }
}
