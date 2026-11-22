import { cookies } from 'next/headers';
import { login, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../../../../lib/core/auth';
import { sessionKeyFromEnv } from '../../../../lib/core/tokens';
import { clientIp, ctx, handle, readJson } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/** Internal login (design §7): a person's email and password (or the shared password while no admins exist), 5 failures per IP per 15 min, signed httpOnly cookie. */
export const POST = handle(async (request: Request) => {
  const { db } = ctx();
  const body = (await readJson(request)) as { email?: unknown; password?: unknown };
  const value = await login(
    db,
    {
      email: typeof body?.email === 'string' ? body.email : undefined,
      password: typeof body?.password === 'string' ? body.password : '',
      ip: clientIp(request),
    },
    { passwordHash: process.env.INTERNAL_PASSWORD_HASH, sessionSecret: sessionKeyFromEnv() },
  );
  (await cookies()).set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' && !(process.env.APP_URL ?? '').startsWith('http://'),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return Response.json({ ok: true });
});
