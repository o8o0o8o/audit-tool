/**
 * Render the report fixture with 15 synthetic issues (12 critical, 3 low) into
 * web/public/report/many-issues.html, so the issues-table "Show all" toggle can
 * be previewed at /report/many-issues.html. Two critical issues land past the cap.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHTML } from '../generateHTML';

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixtures', 'report-fixture', 'audit.json');
const outDir = path.join(root, 'web', 'public', 'report');
const outFile = path.join(outDir, 'many-issues.html');

export function manyIssuesDetails(critical = 12, low = 3) {
  const details: Record<string, { severity: string; count: number; examples: string[] }> = {};
  for (let i = 1; i <= critical; i++) {
    details[`Synthetic critical issue ${i}`] = {
      severity: 'critical',
      count: i,
      examples: ['https://fixture.example/'],
    };
  }
  for (let i = 1; i <= low; i++) {
    details[`Synthetic low issue ${i}`] = { severity: 'low', count: i, examples: ['https://fixture.example/about'] };
  }
  return details;
}

export function writeManyIssuesAudit(details = manyIssuesDetails()): string {
  const audit = JSON.parse(fs.readFileSync(fixture, 'utf8')) as { analysis: Record<string, unknown> };
  audit.analysis = { ...audit.analysis, details, summary: { totalIssues: Object.keys(details).length } };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'many-issues-')), 'audit.json');
  fs.writeFileSync(file, JSON.stringify(audit));
  return file;
}

if (process.argv[1]?.endsWith('preview-many-issues.ts')) {
  fs.mkdirSync(outDir, { recursive: true });
  generateHTML(writeManyIssuesAudit(), 'fixture.example', outFile);
}
