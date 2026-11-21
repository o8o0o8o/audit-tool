/**
 * Prints one PDF for a finished run (design §8.9: PDFs only on request).
 *   npx tsx scripts/render-pdf.ts <run dir> --kind=pdf|verified_pdf|content_research_pdf|teaser_pdf
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderMarkdownToPdf } from '../lib/reports/pdf-renderer';

export const PDF_KINDS = {
  pdf: { md: 'audit-report.md', pdf: 'audit-report.pdf', title: 'audit report' },
  verified_pdf: { md: 'audit-report.verified.md', pdf: 'audit-report.verified.pdf', title: 'verified audit report' },
  content_research_pdf: {
    md: 'content-research-report.md',
    pdf: 'content-research-report.pdf',
    title: 'content research',
  },
  teaser_pdf: { md: 'lead/teaser.md', pdf: 'lead/teaser.pdf', title: 'teaser' },
} as const;
export type PdfKind = keyof typeof PDF_KINDS;

export async function renderRunPdf(runDir: string, kind: PdfKind): Promise<string> {
  const spec = PDF_KINDS[kind];
  if (!spec) throw new Error(`unknown kind ${kind}`);
  const md = path.join(runDir, spec.md);
  if (!existsSync(md)) throw new Error(`${spec.md} not found in ${runDir}`);
  const out = path.join(runDir, spec.pdf);
  await renderMarkdownToPdf(readFileSync(md, 'utf8'), out, {
    title: `${path.basename(path.dirname(runDir))} — ${spec.title}`,
    imageBaseDir: runDir,
  });
  return out;
}

if (require.main === module) {
  const runDir = process.argv[2];
  const kind = (process.argv.find((a) => a.startsWith('--kind='))?.slice(7) ?? 'pdf') as PdfKind;
  if (!runDir) {
    console.error(
      'usage: npx tsx scripts/render-pdf.ts <run dir> --kind=pdf|verified_pdf|content_research_pdf|teaser_pdf',
    );
    process.exit(1);
  }
  renderRunPdf(runDir, kind).then(
    (p) => console.log(`📄 ${p}`),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
