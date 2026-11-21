// drizzle-kit writes `"public".` into foreign keys; the test harness runs migrations into a
// schema of its own, so the SQL must name no schema. Run after every `drizzle-kit generate`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../db/migrations/', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
  const before = readFileSync(new URL(f, dir), 'utf8');
  const after = before.replaceAll('"public".', '');
  if (after !== before) writeFileSync(new URL(f, dir), after);
}
