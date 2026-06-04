/**
 * Markdown → styled HTML → PDF renderer.
 *
 * Deterministic, no LLM. Produces an audit-style PDF resembling the human
 * report examples: cover, sectioned narrative with `Analysis` / `Recommendations`
 * prose, inline code, tables, embedded screenshots. Designed for the Phase 2
 * synthesis output to be rendered as-is.
 *
 * Usage:
 *   await renderMarkdownToPdf(markdown, '/path/to/audit-report.pdf', { imageBaseDir });
 */

import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { marked } from 'marked';

export interface PdfRenderOptions {
  /** Document title shown in PDF header. Defaults to the first H1 found in the markdown. */
  title?: string;
  /**
   * Directory used to resolve relative image paths. When set, `![](foo.png)`
   * becomes `file:///<imageBaseDir>/foo.png` so screenshots embed correctly.
   */
  imageBaseDir?: string;
  /** PDF format. Defaults to 'A4'. */
  format?: 'A4' | 'Letter';
  /** Override the page CSS. Power user; defaults to the built-in stylesheet. */
  customCss?: string;
}

const DEFAULT_CSS = `
:root {
  --body: #1f2328;
  --muted: #57606a;
  --rule: #d0d7de;
  --bg-code: #f6f8fa;
  --accent: #0969da;
  --high: #cf222e;
  --medium: #bf8700;
  --low: #1a7f37;
}

* { box-sizing: border-box; }

@page {
  size: A4;
  margin: 22mm 18mm;
}

html, body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: var(--body);
  font-size: 11pt;
  line-height: 1.55;
  margin: 0;
  padding: 0;
}

h1 {
  font-size: 24pt;
  font-weight: 700;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.3em;
  margin-top: 0;
  margin-bottom: 0.6em;
}

h2 {
  font-size: 17pt;
  font-weight: 700;
  margin-top: 1.6em;
  margin-bottom: 0.4em;
  page-break-after: avoid;
}

h3 {
  font-size: 13pt;
  font-weight: 600;
  margin-top: 1.2em;
  margin-bottom: 0.3em;
  page-break-after: avoid;
}

h4 {
  font-size: 11pt;
  font-weight: 600;
  margin-top: 1em;
  margin-bottom: 0.2em;
}

p { margin: 0.5em 0; }

ul, ol { padding-left: 1.3em; margin: 0.5em 0; }
li { margin: 0.2em 0; }

/* Keep a standalone bold label ("Affected pages", "Fix", …) attached to the
   block that follows it, so the label never sits orphaned at the foot of a
   page with its list pushed to the next (which reads as an empty section). */
p:has(> strong:only-child) { page-break-after: avoid; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

strong { font-weight: 600; }

code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: var(--bg-code);
  padding: 0.1em 0.35em;
  border-radius: 3px;
}

pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: var(--bg-code);
  padding: 0.9em 1.1em;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.45;
  page-break-inside: avoid;
}
pre code { background: transparent; padding: 0; }

blockquote {
  border-left: 3px solid var(--rule);
  margin: 0.8em 0;
  padding-left: 1em;
  color: var(--muted);
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 0.95em;
  page-break-inside: avoid;
}
th, td {
  border: 1px solid var(--rule);
  padding: 0.45em 0.7em;
  text-align: left;
  vertical-align: top;
}
th { background: var(--bg-code); font-weight: 600; }

img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0.6em auto;
  border: 1px solid var(--rule);
  border-radius: 4px;
  page-break-inside: avoid;
}

/* Evidence screenshots — mobile + desktop side by side under a finding. Each
   shot is height-capped so a tall full-page capture doesn't span several PDF
   pages, and the row avoids splitting across a page break. */
.evidence-shots {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0.6em 0;
  page-break-inside: avoid;
}
.evidence-shots figure {
  margin: 0;
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
}
.evidence-shots img {
  max-width: 100%;
  max-height: 360px;
  width: auto;
  margin: 0 auto 4px;
}
.evidence-shots figcaption {
  font-size: 0.8em;
  color: var(--muted);
}

/* Annotated evidence — the full-page screenshot CSS-cropped to the issue
   region (aspect-ratio wrapper + oversized img shifted by negative margins),
   with highlight boxes %-positioned over it. All geometry is inline (computed
   from overlays.json); these rules style the chrome. */
.evidence-annotated {
  margin: 0.6em auto;
  page-break-inside: avoid;
  text-align: center;
}
.evidence-annotated .ev-crop {
  position: relative;
  overflow: hidden;
  max-width: 100%;
  margin: 0 auto;
  border: 1px solid var(--rule);
  border-radius: 4px;
}
.evidence-annotated .ev-crop img {
  border: none;
  border-radius: 0;
}
.ev-box {
  position: absolute;
  border: 2px solid #e0245e;
  border-radius: 3px;
  background: rgba(224, 36, 94, 0.08);
}
.ev-box.ev-ghost {
  border-style: dashed;
  border-color: #64748b;
  background: transparent;
}
.ev-label {
  position: absolute;
  top: -2px;
  left: -2px;
  background: #e0245e;
  color: #fff;
  font-size: 9px;
  line-height: 1.3;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ev-fold {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px dashed #2563eb;
}
.ev-fold-label {
  position: absolute;
  right: 2px;
  top: 1px;
  color: #2563eb;
  font-size: 9px;
  font-weight: 600;
}
.evidence-annotated figcaption {
  font-size: 0.8em;
  color: var(--muted);
  margin-top: 4px;
}

/* CLS before/after pair — first-load shot next to the annotated settled shot */
.evidence-pair {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0.6em 0;
  page-break-inside: avoid;
  align-items: flex-start;
  justify-content: center;
}
.evidence-pair > figure {
  flex: 1 1 0;
  min-width: 0;
  margin: 0;
  text-align: center;
}
.evidence-pair > figure > img {
  max-height: 420px;
  width: auto;
  max-width: 100%;
  margin: 0 auto 4px;
}
.evidence-pair figcaption {
  font-size: 0.8em;
  color: var(--muted);
}

/* SERP preview card — how a search engine renders the sampled page's snippet */
.serp-preview {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 12px 16px;
  margin: 0.6em 0;
  max-width: 600px;
  background: #fff;
  page-break-inside: avoid;
}
.serp-url {
  color: #202124;
  font-size: 0.8em;
  margin-bottom: 2px;
}
.serp-title {
  color: #1a0dab;
  font-size: 1.05em;
  line-height: 1.3;
  margin-bottom: 2px;
}
.serp-desc {
  color: #4d5156;
  font-size: 0.85em;
  line-height: 1.45;
}
.serp-overflow {
  text-decoration: line-through;
  opacity: 0.45;
}
.serp-missing {
  font-style: italic;
  color: #b00020;
}
.serp-note {
  margin-top: 8px;
  font-size: 0.8em;
  color: var(--high);
  font-weight: 600;
  border-top: 1px dashed var(--rule);
  padding-top: 6px;
}

/* Head snippet card — reconstructed <head> excerpt with the offending line
   flagged (red) or rendered as a flagged "missing:" comment */
.code-card {
  border: 1px solid var(--rule);
  border-radius: 8px;
  margin: 0.6em 0;
  max-width: 640px;
  overflow: hidden;
  page-break-inside: avoid;
}
.code-card-title {
  font-size: 0.75em;
  color: var(--muted);
  padding: 6px 12px;
  border-bottom: 1px solid var(--rule);
  background: var(--bg-code);
}
.code-card-pre {
  margin: 0;
  padding: 10px 12px;
  font-size: 0.78em;
  line-height: 1.6;
  white-space: pre;
  overflow-x: hidden;
}
.code-card-pre .line-flag {
  background: rgba(224, 36, 94, 0.12);
  outline: 2px solid rgba(224, 36, 94, 0.45);
  border-radius: 2px;
}
.code-card-pre .line-missing {
  background: rgba(224, 36, 94, 0.12);
  color: var(--high);
  font-weight: 600;
  border-radius: 2px;
}

/* Data panels — pure-CSS labelled horizontal bars (network, coverage,
   render-blocking). No JS, PDF-safe. */
.data-panel {
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 10px 14px;
  margin: 0.6em 0;
  max-width: 640px;
  page-break-inside: avoid;
}
.data-panel-title {
  font-size: 0.8em;
  font-weight: 600;
  margin-bottom: 8px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.75em;
  margin: 3px 0;
}
.bar-name {
  flex: 0 0 150px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
  color: var(--muted);
}
.bar-name-wide {
  flex: 1 1 auto;
  text-align: left;
}
.bar-track {
  flex: 1 1 auto;
  height: 10px;
  background: var(--bg-code);
  border-radius: 5px;
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  background: #2563eb;
  border-radius: 5px;
}
.bar-fill.bar-flag {
  background: #e0245e;
}
.bar-sub {
  flex: 0 0 130px;
  white-space: nowrap;
  color: var(--muted);
}
.rb-chip {
  flex: 0 0 auto;
  font-size: 0.9em;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 3px;
  color: #fff;
}
.rb-chip.rb-script {
  background: #d97706;
}
.rb-chip.rb-style {
  background: #2563eb;
}
.hdr-miss {
  flex: 0 0 auto;
  color: #e0245e;
  font-weight: 700;
}
.chip {
  display: inline-block;
  font-size: 0.85em;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--bg-code);
  border: 1px solid var(--rule);
}

hr {
  border: 0;
  border-top: 1px solid var(--rule);
  margin: 2em 0;
}

/* Severity pill helpers — used by the synthesis prose */
.sev-high   { color: var(--high);   font-weight: 600; }
.sev-medium { color: var(--medium); font-weight: 600; }
.sev-low    { color: var(--low);    font-weight: 600; }
/* Verification labels (only in the --verify report) */
.verified   { color: var(--low);    font-weight: 600; } /* re-checked out against crawl data */
.unverified { color: var(--muted);  font-weight: 600; } /* no deterministic check applies — neutral, not a defect */

/* Force major sections onto a new page when authored with an HR + H2 */
h1 + hr + h2,
hr + h2 {
  page-break-before: always;
}
`;

function buildHtml(markdown: string, options: PdfRenderOptions): string {
  // Rewrite relative image paths to file:// URLs so Playwright can fetch them.
  // Handle both markdown image syntax `![alt](src)` and raw `<img src="...">`.
  // Skip rewriting inside fenced code blocks — code snippets often contain
  // example tags like `<img src="hero.webp">` that should stay literal.
  const baseDir = options.imageBaseDir;
  const rewriteSrc = (src: string): string => {
    if (/^(https?:|data:|file:)/.test(src) || path.isAbsolute(src)) return src;
    if (!baseDir) return src;
    return `file://${path.resolve(baseDir, src)}`;
  };
  const rewriteOutsideCode = (text: string): string =>
    text
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => `![${alt}](${rewriteSrc(src)})`)
      .replace(
        /<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/g,
        (_m, pre: string, src: string, post: string) => `<img${pre}src="${rewriteSrc(src)}"${post}>`,
      );

  let rewritten = markdown;
  if (baseDir) {
    // Split on fenced code blocks (```...```) and only rewrite the non-fence
    // segments. Even-indexed segments are prose, odd are code blocks.
    const parts = markdown.split(/(```[\s\S]*?```)/g);
    rewritten = parts.map((seg, i) => (i % 2 === 0 ? rewriteOutsideCode(seg) : seg)).join('');
  }

  const body = marked.parse(rewritten, { async: false }) as string;
  const title = options.title ?? extractTitle(markdown) ?? 'Audit Report';
  const css = options.customCss ?? DEFAULT_CSS;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function extractTitle(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Render `markdown` to a PDF at `outputPath`. Returns the resolved path.
 *
 * Quirk: if you pass `imageBaseDir`, only paths that look relative get
 * rewritten to file:// URLs. Absolute paths, data: URLs, and http(s):// URLs
 * pass through unchanged.
 */
export async function renderMarkdownToPdf(
  markdown: string,
  outputPath: string,
  options: PdfRenderOptions = {},
): Promise<string> {
  const html = buildHtml(markdown, options);

  // Also drop the intermediate HTML alongside the PDF — handy for debugging
  // styling without re-running the browser.
  const htmlPath = outputPath.replace(/\.pdf$/i, '.html');
  fs.writeFileSync(htmlPath, html);

  // Use page.goto(file://) instead of setContent so file:// image URLs are
  // permitted (setContent runs in an about:blank context which blocks them).
  //
  // Launching Chromium can fail transiently when this runs at the tail of an
  // audit, while the crawler's own browser is tearing down (resource/port
  // contention). Retry once before giving up so a one-off hiccup doesn't
  // silently lose the report.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: 'networkidle' });
      await page.pdf({
        path: outputPath,
        format: options.format ?? 'A4',
        printBackground: true,
        margin: { top: '22mm', bottom: '22mm', left: '18mm', right: '18mm' },
      });
      return outputPath;
    } catch (e: unknown) {
      lastError = e;
    } finally {
      await browser.close();
    }
  }
  throw lastError;
}
