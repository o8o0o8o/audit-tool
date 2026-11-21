/**
 * <run dir> → <run dir>/model/ files, for trying the model on stored runs.
 *   npx tsx scripts/build-model.ts <run dir> [<run dir> …]
 *   npx tsx scripts/build-model.ts --all [--base=lead-results] [--limit=n]   validate every stored run (writes nothing)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAuditModel, writeAuditModel } from '../lib/model/build/build-audit-model';

const args = process.argv.slice(2);
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

export function storedRuns(bases = ['audit-results', 'lead-results']): string[] {
  const out: string[] = [];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const dd = path.join(base, d);
      if (!statSync(dd).isDirectory()) continue;
      for (const t of readdirSync(dd)) if (existsSync(path.join(dd, t, 'manifest.json.gz'))) out.push(path.join(dd, t));
    }
  }
  return out;
}

if (args.includes('--all')) {
  const runs = storedRuns(opt('base') ? [opt('base')!] : undefined).slice(0, Number(opt('limit')) || undefined);
  let ok = 0;
  const failed: string[] = [];
  for (const r of runs) {
    try {
      buildAuditModel({ runDir: r, auditId: randomUUID() });
      ok++;
    } catch (err) {
      failed.push(`${r}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log(`${ok}/${runs.length} runs build a valid model`);
  failed.slice(0, 30).forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(failed.length ? 1 : 0);
} else {
  for (const r of args.filter((a) => !a.startsWith('--'))) {
    const { doc, sitePath } = writeAuditModel({ runDir: r, auditId: randomUUID() });
    console.log(
      `${sitePath}: ${doc.findings.length} findings, scan ${doc.scanQuality.state}, ${doc.stack?.technologies.length ?? 0} technologies`,
    );
  }
}
