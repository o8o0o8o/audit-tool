/** `<domain>.html` is the main report; Phase 2/3 PDF-source pages are not. */
export const isMainReportName = (name: string) =>
  !name.includes('/') && /^(?!audit-report\.|content-research-report\.)[^/]+\.html$/i.test(name);
