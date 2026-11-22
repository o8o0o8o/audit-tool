import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { WorkerClaims, WorkerIdentity } from '../types';
import type { GitHubWorkerConfig } from './github-dispatcher';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60_000;
/** Unknown key ids trigger a new fetch at most this often. */
const JWKS_RETRY_MS = 60_000;
const CLOCK_SKEW_S = 60;

type Jwk = JsonWebKey & { kid?: string };

function decode<T>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Verifies the OIDC token a GitHub Actions run sends to `register` (design §3 "Worker auth"): signed
 * by GitHub, made for our audience, and from a `workflow_dispatch` run of the worker workflow on the
 * expected branch of our repository. The claims do not name the audit; the nonce does that.
 */
export class GitHubWorkerIdentity implements WorkerIdentity {
  private keys: { at: number; byKid: Map<string, Jwk> } | null = null;

  constructor(
    private readonly cfg: GitHubWorkerConfig & {
      audience: string;
      /** GitHub's numeric repository id; when set, a repository re-created under the same name is refused. */
      repositoryId?: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private async key(kid: string): Promise<Jwk | null> {
    const age = this.keys ? this.now() - this.keys.at : Infinity;
    const known = this.keys?.byKid.get(kid);
    if (known && age < JWKS_TTL_MS) return known;
    if (this.keys && !known && age < JWKS_RETRY_MS) return null;
    const res = await (this.cfg.fetch ?? fetch)(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub JWKS: ${res.status}`);
    const { keys } = (await res.json()) as { keys?: Jwk[] };
    this.keys = { at: this.now(), byKid: new Map((keys ?? []).filter((k) => k.kid).map((k) => [k.kid!, k])) };
    return this.keys.byKid.get(kid) ?? null;
  }

  async verify(token: string): Promise<WorkerClaims | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    const header = decode<{ alg?: string; kid?: string }>(head);
    const claims = decode<Record<string, unknown>>(body);
    if (!header || !claims || header.alg !== 'RS256' || !header.kid) return null;
    const jwk = await this.key(header.kid);
    if (!jwk) return null;
    const verifier = createVerify('RSA-SHA256').update(`${head}.${body}`);
    if (!verifier.verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) return null;

    const nowS = this.now() / 1000;
    const aud = claims.aud;
    const { repository, workflow, ref } = this.cfg;
    const branch = `refs/heads/${ref}`;
    const ok =
      claims.iss === GITHUB_OIDC_ISSUER &&
      (Array.isArray(aud) ? aud.includes(this.cfg.audience) : aud === this.cfg.audience) &&
      typeof claims.exp === 'number' &&
      claims.exp > nowS &&
      (typeof claims.nbf !== 'number' || claims.nbf <= nowS + CLOCK_SKEW_S) &&
      claims.repository === repository &&
      (!this.cfg.repositoryId || claims.repository_id === this.cfg.repositoryId) &&
      claims.event_name === 'workflow_dispatch' &&
      claims.ref === branch &&
      claims.workflow_ref === `${repository}/.github/workflows/${workflow}@${branch}`;
    if (!ok) return null;
    const runId = String(claims.run_id ?? '');
    const runAttempt = Number(claims.run_attempt);
    if (!/^\d+$/.test(runId) || !Number.isInteger(runAttempt) || runAttempt < 1) return null;
    return { runId, runAttempt };
  }
}
