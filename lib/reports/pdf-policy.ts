/**
 * PDFs only on request (docs/platform-api.md §2 "PDFs: only on request"): the Phase 2, 3 and 4
 * runners print a PDF only with `--pdf` or `pdf: true` in `.seoauditrc`. robots.ts sets
 * `SEO_AUDIT_PDF=1` for the run; `scripts/render-pdf.ts` prints one for a finished run.
 */
export function pdfRequested(): boolean {
  return process.env.SEO_AUDIT_PDF === '1';
}
