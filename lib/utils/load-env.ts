import * as fs from 'fs';
import * as path from 'path';

/**
 * Read `KEY=value` lines from `<dir>/.env` into `process.env`. A variable already set in the
 * environment wins over the file. Blank lines and `#` comments are skipped; one pair of
 * surrounding quotes is stripped from the value. A missing file is not an error.
 */
export function loadDotEnv(dir: string): void {
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    process.env[key] ??= value;
  }
}
