/**
 * Renders the HTML report of a finished run folder with the current report and scoring code.
 * The platform's report view runs it on demand (web/lib/core/render-report.ts), so every view shows
 * the current report, not the HTML written when the audit ran.
 *
 *   npx tsx scripts/render-report.ts --run=<run dir> --out=<file.html> [--preset=<name>] [--sections=<csv>] [--history=<file.json>]
 *
 * --history: earlier audits of the same site with the same settings (ReportHistoryEntry[], oldest first).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { generateHTML, type ReportHistoryEntry } from '../generateHTML';
import { resolvePreset } from '../lib/presets';

const opt = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

function main(): void {
  const runDir = path.resolve(opt('run') ?? '');
  const out = path.resolve(opt('out') ?? '');
  const manifest = path.join(runDir, 'manifest.json.gz');
  if (!existsSync(manifest)) throw new Error(`no manifest.json.gz in ${runDir}`);
  const domain = (JSON.parse(gunzipSync(readFileSync(manifest)).toString()) as { domain?: string }).domain ?? path.basename(path.dirname(runDir));
  const sections = (opt('sections') ?? '').split(',').filter(Boolean);
  const preset = opt('preset') || null;
  const resolved = resolvePreset(preset, preset === 'custom' ? { sections } : {});
  const historyFile = opt('history');
  const history = historyFile ? (JSON.parse(readFileSync(historyFile, 'utf8')) as ReportHistoryEntry[]) : [];
  generateHTML(manifest, domain, out, undefined, {
    sections: resolved.htmlSections,
    checks: resolved.checks,
    preset: resolved.preset ?? undefined,
    rescore: true,
    history,
  });
}

main();
