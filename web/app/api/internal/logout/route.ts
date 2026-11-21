import { cookies } from 'next/headers';
import { revokeSession, SESSION_COOKIE } from '../../../../lib/core/auth';
import { ctx } from '../../../../lib/server';

/** Ends the session on the server (a copied cookie stops working) and deletes the cookie. */
export async function POST() {
  const jar = await cookies();
  await revokeSession(ctx().db, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
