/**
 * UI Issues section (`--visual`).
 *
 * One card per visual finding kind (broken images, failed media, template
 * tokens, lorem ipsum, mojibake, clipped text) listing the affected pages, with
 * the crawl-time screenshots of each defect and highlight boxes drawn over them.
 * Boxes are %-positioned over the shot (`VisualShot` sizes are CSS px), so the
 * image's pixel density never enters the math. Images are inlined as data URIs
 * so the report stays a single self-contained file.
 */

import fs from 'fs';
import path from 'path';
import type { PageInfo, ReportSectionData, Issue } from '../../types';
import type { VisualShot } from '../../crawler/visual-shot-capture';
import { VISUAL_FINDING_MESSAGES } from '../../phase2/categorize';
import { escapeHtml } from '../../utils';
import { getSeverityBadge } from '../html-utils';
import { NO_UI_ISSUES_TEXT } from './issues-detail';

/** Pages shown with screenshots per finding; the rest are listed as links. */
const PAGES_WITH_SHOTS_PER_FINDING = 6;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface PageHit {
  url: string;
  detail: string;
  shots: VisualShot[];
}

interface UiFinding {
  message: string;
  severity: string;
  pages: PageHit[];
}

function visualIssues(page: PageInfo): Issue[] {
  return [...(page.brokenMediaData?.issues ?? []), ...(page.textIntegrityData?.issues ?? [])];
}

type AnalysisDetails = Record<string, { severity?: unknown; examples?: unknown } | undefined>;

export function collectUiFindings(pages: PageInfo[], details: AnalysisDetails = {}): UiFinding[] {
  const known = new Set<string>(VISUAL_FINDING_MESSAGES);
  const byMessage = new Map<string, UiFinding>();
  for (const page of pages) {
    for (const issue of visualIssues(page)) {
      const message = issue.message;
      if (!message || !known.has(message)) continue;
      const finding: UiFinding = byMessage.get(message) ?? { message, severity: String(issue.severity), pages: [] };
      finding.pages.push({
        url: page.url,
        detail: issue.detail ?? '',
        shots: (page.visualShots ?? []).filter((s) => s.kind === message),
      });
      byMessage.set(message, finding);
    }
  }
  // Findings present in the site-wide analysis but not on any loaded page (e.g. trimmed page data): list their examples.
  for (const [message, d] of Object.entries(details)) {
    if (!known.has(message) || byMessage.has(message)) continue;
    const examples = Array.isArray(d?.examples) ? d.examples.map(String) : [];
    byMessage.set(message, {
      message,
      severity: String(d?.severity ?? 'medium'),
      pages: examples.map((ex) => ({ url: /href="([^"]+)"/.exec(ex)?.[1] ?? '', detail: ex, shots: [] })),
    });
  }
  const findings = [...byMessage.values()];
  for (const f of findings) f.pages.sort((a, b) => b.shots.length - a.shots.length);
  return findings.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.pages.length - a.pages.length,
  );
}

function readImage(runDir: string | undefined, file: string): string | null {
  if (!runDir) return null;
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(path.join(runDir, file)).toString('base64')}`;
  } catch {
    return null;
  }
}

const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / of) * 100)).toFixed(2)}%`;

function renderShot(shot: VisualShot, runDir: string | undefined): string {
  const src = readImage(runDir, shot.file);
  if (!src) return '';
  const boxes = shot.boxes
    .map(
      (b) => `<div class="ui-shot-box" style="left:${pct(b.rect.x, shot.width)};top:${pct(b.rect.y, shot.height)};width:${pct(b.rect.width, shot.width)};height:${pct(b.rect.height, shot.height)};">
          <span class="ui-shot-label">${escapeHtml(b.label)}</span></div>`,
    )
    .join('');
  return `<figure class="ui-shot"><div class="ui-shot-frame"><img src="${src}" alt="Screenshot of the highlighted defect" loading="lazy">${boxes}</div></figure>`;
}

/** Strip the analyzer's leading page link from a detail, leaving the defect description. */
function detailText(detail: string): string {
  return escapeHtml(detail.replace(/<[^>]+>/g, '').replace(/^\S+\s+/, ''));
}

function renderFinding(f: UiFinding, runDir: string | undefined): string {
  const withShots = f.pages.slice(0, PAGES_WITH_SHOTS_PER_FINDING);
  const rest = f.pages.slice(PAGES_WITH_SHOTS_PER_FINDING);
  const pagesHtml = withShots
    .map((p) => {
      const shots = p.shots.map((s) => renderShot(s, runDir)).join('');
      return `<div class="ui-page">
        <div class="ui-page-url">${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="ui-link">${escapeHtml(p.url)}</a>` : ''}</div>
        <div class="ui-page-detail">${detailText(p.detail)}</div>
        ${shots ? `<div class="ui-shots">${shots}</div>` : '<div class="ui-page-noshot">No screenshot: the defect has no visible element to highlight, or the screenshot budget was used up.</div>'}
      </div>`;
    })
    .join('');
  const restHtml = rest.length
    ? `<details class="ui-more"><summary>${rest.length} more page${rest.length > 1 ? 's' : ''}</summary><ul>${rest
        .map(
          (p) =>
            `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="ui-link">${escapeHtml(p.url)}</a> — ${detailText(p.detail)}</li>`,
        )
        .join('')}</ul></details>`
    : '';
  return `<div class="ui-finding">
    <div class="ui-finding-head">${getSeverityBadge(f.severity)}<h3>${escapeHtml(f.message)}</h3><span class="ui-finding-count">${f.pages.length} page${f.pages.length > 1 ? 's' : ''}</span></div>
    ${pagesHtml}${restHtml}
  </div>`;
}

const STYLES = `<style>
#ui-issues .ui-finding{border:1px solid var(--gray-200);border-radius:var(--radius-lg);padding:16px;margin-bottom:16px;}
#ui-issues .ui-finding-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;}
#ui-issues .ui-finding-head h3{margin:0;font-size:var(--font-size-base);color:var(--gray-800);}
#ui-issues .ui-finding-count{margin-left:auto;font-size:var(--font-size-sm);color:var(--gray-500);}
#ui-issues .ui-page{padding:12px 0;border-top:1px solid var(--gray-200);}
#ui-issues .ui-page-url{font-size:var(--font-size-sm);word-break:break-all;}
#ui-issues .ui-page-detail,#ui-issues .ui-page-noshot{font-size:var(--font-size-sm);color:var(--gray-500);margin-top:4px;word-break:break-word;}
#ui-issues .ui-shots{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;}
#ui-issues .ui-shot{margin:0;flex:0 1 360px;max-width:100%;}
#ui-issues .ui-shot-frame{position:relative;border:1px solid var(--gray-200);border-radius:var(--radius-md,6px);overflow:hidden;line-height:0;}
#ui-issues .ui-shot-frame img{width:100%;height:auto;display:block;}
#ui-issues .ui-shot-box{position:absolute;outline:3px solid #ff3b30;box-shadow:0 0 0 9999px rgba(0,0,0,.35);border-radius:2px;line-height:normal;}
#ui-issues .ui-shot-box + .ui-shot-box{box-shadow:none;}
#ui-issues .ui-shot-label{position:absolute;left:-3px;top:-22px;background:#ff3b30;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;}
#ui-issues .ui-more{margin-top:8px;font-size:var(--font-size-sm);}
#ui-issues .ui-more li{word-break:break-all;margin:4px 0;}
</style>`;

/** Empty when the visual check did not run (or `--checks` excluded it). */
export function getUiIssues(data: ReportSectionData): string {
  if (data.jsonData.visual !== true) return '';
  const analysis = data.jsonData.analysis as { details?: AnalysisDetails } | undefined;
  const findings = collectUiFindings(data.pages, analysis?.details ?? {});
  const body = findings.length
    ? findings.map((f) => renderFinding(f, data.runDir)).join('')
    : `<div style="border:1px solid var(--color-success);border-radius:var(--radius-lg);padding:10px 14px;font-size:var(--font-size-sm);"><strong>${NO_UI_ISSUES_TEXT}.</strong> The visual check found no broken images or media, unrendered template text, placeholder copy, garbled characters or clipped text.</div>`;
  return `<div id="ui-issues" class="issues-section">${STYLES}
    <h2 style="margin:0 0 16px;font-size:var(--font-size-lg);color:var(--gray-800);">UI Issues (${findings.length})</h2>
    ${body}
  </div>`;
}
