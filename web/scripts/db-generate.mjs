// `yarn db:generate --name=<name>`: drizzle-kit generate, then strip `"public".` from the SQL.
import { execFileSync } from 'node:child_process';

execFileSync('npx', ['drizzle-kit', 'generate', ...process.argv.slice(2)], { stdio: 'inherit' });
await import('./strip-public-schema.mjs');
