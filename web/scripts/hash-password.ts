/** Prints an INTERNAL_PASSWORD_HASH for web/.env.local. Format: scrypt:<salt hex>:<hash hex> (no `$`: Next's env loader expands it). */
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

async function main(): Promise<void> {
  const fromArg = process.argv[2];
  const password =
    fromArg ?? (await createInterface({ input: process.stdin, output: process.stderr }).question('Password: '));
  if (password.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  const salt = randomBytes(16);
  console.log(`scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`);
  process.exit(0);
}
void main();
