/**
 * Render the report fixture (no preset) to markdown + HTML, with volatile
 * timestamps normalised. Used to write the golden baseline and to compare
 * against it in tests.
 *
 *   npx tsx tests/fixtures/report-fixture/make-golden.ts   # (re)write golden files
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHTML, type HtmlReportSelection } from '../../../generateHTML';
import { buildReportMarkdown, type ReportSelection } from '../../../lib/phase2/phase2-runner';
import type { AuditArtifacts } from '../../../lib/phase2/types';

const fixtureDir = __dirname;
const auditFile = path.join(fixtureDir, 'audit.json');
export const goldenDir = path.join(fixtureDir, 'golden');

/** Replace ISO timestamps and locale date strings with fixed placeholders. */
export function normalise(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ISO>')
    .replace(/(id="reportTimestamp">)[^<]*(<\/time>)/g, '$1<LOCAL>$2');
}

export function renderNoPresetMarkdown(selection: ReportSelection = {}): string {
  const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8')) as Record<string, unknown>;
  const pageData = audit.pageData as { processedPages?: string[] } & Record<string, unknown>;
  const artifacts = {
    runDir: fixtureDir,
    manifest: {
      version: 1,
      format: 'multi',
      domain: 'fixture.example',
      created: '2026-01-01T00:00:00.000Z',
      progress: { ...pageData, processedPages: pageData.processedPages ?? [] },
      files: { metadata: '', analysis: '', incomingLinks: '', pageBatches: [] },
      evidence: null,
    },
    analysis: audit.analysis,
    metadata: { robots: audit.robots, sitemaps: audit.sitemaps, timing: audit.timing },
    repoAnalysis: null,
  } as unknown as AuditArtifacts;
  return normalise(buildReportMarkdown(artifacts, {}, [], new Set(), undefined, undefined, false, selection));
}

export function renderNoPresetHtml(selection: HtmlReportSelection = {}): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'golden-')), 'index.html');
  generateHTML(auditFile, 'fixture.example', out, undefined, selection);
  return normalise(fs.readFileSync(out, 'utf8'));
}

if (process.argv[1]?.endsWith('make-golden.ts')) {
  fs.mkdirSync(goldenDir, { recursive: true });
  fs.writeFileSync(path.join(goldenDir, 'no-preset.md'), renderNoPresetMarkdown());
  fs.writeFileSync(path.join(goldenDir, 'no-preset.html'), renderNoPresetHtml());
  console.log(`Golden files written to ${goldenDir}`);
}
