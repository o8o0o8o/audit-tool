/**
 * On a GitHub Actions runner the worker's identity is GitHub's OIDC token, requested for the
 * platform's audience (design §3 "Worker auth"). The job needs `id-token: write`. The token lives a
 * few minutes, so it is requested right before `register`, not by an earlier workflow step.
 */
export async function githubOidcToken(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) return null;
  const audience = env.PLATFORM_OIDC_AUDIENCE;
  if (!audience) throw new Error('PLATFORM_OIDC_AUDIENCE is not set');
  const ask = new URL(url);
  ask.searchParams.set('audience', audience);
  const res = await fetchFn(ask, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub OIDC token request: ${res.status}`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error('GitHub OIDC token request returned no token');
  return value;
}
