/**
 * Visual-defect screenshots (`--visual`).
 *
 * For a page whose visual analyzers raised findings, screenshot a band of the
 * page around each located defect and keep the defect boxes relative to that
 * band, so the HTML report can draw highlight boxes over the image with plain
 * CSS. Bands are JPEG, cropped to the defect area, and capped per page and per
 * audit so a site with the same defect on hundreds of pages stays small.
 *
 * Files land in `evidence/<safe>--visual/` with a `_meta.json` (no
 * `screenshot.mobile.png`, so the directory never enters the representative-
 * page evidence index used by Phase 2).
 */

import fs from 'fs';
import path from 'path';
import type { ChromePage } from '../types';
import type { DocRect, VisualHighlight } from '../analyzers/visual/visual-highlights';
import { createSafeFilename } from '../utils';

export interface VisualShotBox {
  /** Position within the shot, in CSS px. */
  rect: DocRect;
  label: string;
}

export interface VisualShot {
  /** Finding message this shot illustrates. */
  kind: string;
  /** Path relative to the run directory (`evidence/<dir>/<file>.jpg`). */
  file: string;
  /** Shot size in CSS px. */
  width: number;
  height: number;
  boxes: VisualShotBox[];
}

/** Context kept above and below a defect. */
const BAND_PADDING_PX = 160;
const BAND_MAX_HEIGHT_PX = 900;
const MAX_SHOTS_PER_PAGE = 4;
/** Audit-wide cap on shot files; counted on disk so `--proceed` resumes keep it. */
export const MAX_VISUAL_SHOTS_PER_AUDIT = 60;
/** Per finding kind, so one widespread defect can't spend the whole budget. The report shows 6 pages per kind. */
export const MAX_VISUAL_SHOTS_PER_KIND = 12;
const JPEG_QUALITY = 70;

/** Filename-safe slug of a finding message; shot files are `<slug>-<n>.jpg` so on-disk counts work per kind. */
export const kindSlug = (kind: string) =>
  kind.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export interface Band {
  kind: string;
  y: number;
  height: number;
  items: VisualHighlight[];
}

/**
 * Group highlights into vertical bands: one band per finding kind and page
 * region, merging defects close enough to share a screenshot.
 */
export function planBands(highlights: VisualHighlight[], docHeight: number, maxBands = MAX_SHOTS_PER_PAGE): Band[] {
  const bands: Band[] = [];
  const sorted = [...highlights].sort((a, b) => a.rect.y - b.rect.y);
  for (const h of sorted) {
    const top = Math.max(0, h.rect.y - BAND_PADDING_PX);
    const bottom = Math.min(docHeight || Infinity, h.rect.y + h.rect.height + BAND_PADDING_PX);
    const same = bands.find((b) => b.kind === h.kind && Math.max(b.y + b.height, bottom) - Math.min(b.y, top) <= BAND_MAX_HEIGHT_PX);
    if (same) {
      const end = Math.max(same.y + same.height, bottom);
      same.y = Math.min(same.y, top);
      same.height = end - same.y;
      same.items.push(h);
      continue;
    }
    if (bands.length >= maxBands) continue;
    // A defect taller than the band cap is shown from its top edge.
    bands.push({ kind: h.kind, y: top, height: Math.min(Math.max(bottom - top, 1), BAND_MAX_HEIGHT_PX), items: [h] });
  }
  return bands;
}

/** Existing shot files in this audit's evidence dir: total and per kind slug. */
function countExistingShots(evidenceDir: string): { total: number; byKind: Map<string, number> } {
  const byKind = new Map<string, number>();
  let total = 0;
  try {
    for (const d of fs.readdirSync(evidenceDir, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.endsWith('--visual')) continue;
      for (const f of fs.readdirSync(path.join(evidenceDir, d.name))) {
        const m = /^(.+)-\d+\.jpg$/.exec(f);
        if (!m) continue;
        total++;
        byKind.set(m[1]!, (byKind.get(m[1]!) ?? 0) + 1);
      }
    }
  } catch {
    // no evidence yet
  }
  return { total, byKind };
}

/** Screenshot the bands around a page's visual defects. Best effort: returns what it managed to capture. */
export async function captureVisualShots(
  page: ChromePage,
  url: string,
  evidenceDir: string,
  highlights: VisualHighlight[],
): Promise<VisualShot[]> {
  const existing = countExistingShots(evidenceDir);
  const budget = MAX_VISUAL_SHOTS_PER_AUDIT - existing.total;
  const wanted = highlights.filter((h) => (existing.byKind.get(kindSlug(h.kind)) ?? 0) < MAX_VISUAL_SHOTS_PER_KIND);
  if (wanted.length === 0 || budget <= 0) return [];

  const doc = await page
    .evaluate(() => ({
      width: document.documentElement.clientWidth || window.innerWidth,
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    }))
    .catch(() => null);
  if (!doc) return [];

  const bands = planBands(wanted, doc.height, Math.min(MAX_SHOTS_PER_PAGE, budget));
  const dirName = `${createSafeFilename(url)}--visual`;
  const dir = path.join(evidenceDir, dirName);
  const shots: VisualShot[] = [];

  // Caps are soft under concurrency: parallel pages count the disk before either writes.
  for (const [i, band] of bands.entries()) {
    const clip = { x: 0, y: Math.round(band.y), width: doc.width, height: Math.round(band.height) };
    try {
      const buf = await page.screenshot({ clip, fullPage: true, type: 'jpeg', quality: JPEG_QUALITY, timeout: 5000 });
      fs.mkdirSync(dir, { recursive: true });
      const file = `${kindSlug(band.kind)}-${i + 1}.jpg`;
      fs.writeFileSync(path.join(dir, file), buf);
      shots.push({
        kind: band.kind,
        file: `evidence/${dirName}/${file}`,
        width: clip.width,
        height: clip.height,
        boxes: band.items.map((h) => ({
          rect: { x: h.rect.x - clip.x, y: h.rect.y - clip.y, width: h.rect.width, height: h.rect.height },
          label: h.label,
        })),
      });
    } catch {
      // evidence is best effort
    }
  }

  if (shots.length > 0) {
    try {
      fs.writeFileSync(
        path.join(dir, '_meta.json'),
        JSON.stringify({ url, capturedAt: new Date().toISOString(), kind: 'visual' }, null, 2),
      );
    } catch {
      // evidence is best effort
    }
  }
  return shots;
}
