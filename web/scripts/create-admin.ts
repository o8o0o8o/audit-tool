/**
 * Adds a person who can log in to /internal, or gives an existing one a new password (and enables
 * them again). The password is asked for, never passed as an argument. Once one admin exists, the
 * shared INTERNAL_PASSWORD_HASH no longer logs in.
 *   yarn --cwd web admin:create --email=<email> [--name=<name>]
 *   yarn --cwd web admin:create --email=<email> --disable
 */
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { actionLog, admins } from '../db/schema';
import { normalizeEmail, upsertAdmin } from '../lib/core/auth';

const opt = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main(): Promise<void> {
  const email = opt('email');
  if (!email) throw new Error('usage: admin:create --email=<email> [--name=<name>] [--disable]');
  const db = getDb();
  if (process.argv.includes('--disable')) {
    const done = await db
      .update(admins)
      .set({ disabledAt: new Date() })
      .where(eq(admins.email, normalizeEmail(email)))
      .returning({ id: admins.id });
    if (!done.length) throw new Error(`no admin ${email}`);
    await db.insert(actionLog).values({ principal: 'cli', action: 'admin_disabled', target: normalizeEmail(email) });
    console.log(`disabled ${normalizeEmail(email)}; an open session ends within 12 hours`);
    return;
  }
  const password =
    process.env.ADMIN_PASSWORD ??
    (await createInterface({ input: process.stdin, output: process.stderr }).question('Password (12+ characters): '));
  const res = await upsertAdmin(db, { email, name: opt('name'), password });
  await db
    .insert(actionLog)
    .values({
      principal: 'cli',
      action: res.created ? 'admin_created' : 'admin_password_set',
      target: normalizeEmail(email),
    });
  console.log(`${res.created ? 'created' : 'updated'} admin ${normalizeEmail(email)} (${res.id})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    process.exit();
  });
