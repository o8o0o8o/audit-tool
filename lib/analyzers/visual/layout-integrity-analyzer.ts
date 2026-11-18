/**
 * Layout defects a visitor sees and no markup check finds (`--visual`): text printed over other
 * text, images stretched out of proportion, in-page links to a section that is not there, the same
 * entry twice in one list, and large blocks that render empty.
 *
 * The page collects geometry (`collectLayoutSnapshot`); the decisions are pure functions over that
 * snapshot, so each rule is tested without a browser. The collector scrolls to the places it checks
 * and back, so it runs after the analyzers that need the page as loaded.
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';
import { type DocRect, type VisualHighlight, capHighlights } from './visual-highlights';

export const TEXT_OVERLAP_MESSAGE = 'Text overlaps other text';
export const DISTORTED_IMAGE_MESSAGE = 'Image stretched out of proportion';
export const DEAD_FRAGMENT_MESSAGE = 'In-page link points to a missing section';
export const DUPLICATE_ENTRY_MESSAGE = 'Duplicate entries in a list';
export const EMPTY_BLOCK_MESSAGE = 'Large empty area on page';
export const DESKTOP_OVERFLOW_MESSAGE = 'Page scrolls sideways on desktop';

export const LAYOUT_FINDING_MESSAGES = [
  TEXT_OVERLAP_MESSAGE,
  DISTORTED_IMAGE_MESSAGE,
  DEAD_FRAGMENT_MESSAGE,
  DUPLICATE_ENTRY_MESSAGE,
  EMPTY_BLOCK_MESSAGE,
  DESKTOP_OVERFLOW_MESSAGE,
] as const;

/** One rendered line of a text node. */
export interface TextLine {
  /** Index of the element that owns the text node; lines of one element never overlap "each other". */
  owner: number;
  text: string;
  rect: DocRect;
}

export interface OverlapPair {
  a: TextLine;
  b: TextLine;
  rect: DocRect;
}

export interface ImageSample {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
  /** Computed `object-fit`; only `fill` (the default) can distort. */
  objectFit: string;
  /** Marked as decoration (`alt=""`, `aria-hidden`, `role="presentation"`): a texture may be stretched on purpose. */
  decorative?: boolean;
  rect?: DocRect;
}

export interface FragmentLink {
  fragment: string;
  text: string;
  /** True when an element with that id or name exists. */
  targetExists: boolean;
  /** True when the link is wired to a script widget (tab, modal, toggle): its hash is not a section. */
  scripted: boolean;
  rect?: DocRect;
}

export interface SiblingEntry {
  /** Index of the list (shared parent) the entry belongs to. */
  list: number;
  text: string;
  href: string;
  /** Tag and class of the entry: only entries that look alike are compared. */
  group?: string;
  rect?: DocRect;
}

export interface EmptyBlock {
  tag: string;
  rect: DocRect;
}

export interface LayoutSnapshot {
  viewport: { width: number; height: number };
  /** Widest the document scrolls, against the viewport width. */
  scrollWidth: number;
  /** Text overlaps the page confirmed by looking at what is painted on top (see the collector). */
  overlaps: OverlapPair[];
  images: ImageSample[];
  fragments: FragmentLink[];
  entries: SiblingEntry[];
  emptyBlocks: EmptyBlock[];
}

export interface LayoutIntegrityData {
  textOverlaps: string[];
  distortedImages: string[];
  deadFragments: string[];
  duplicateEntries: string[];
  emptyBlocks: number;
  issues: Issue[];
  highlights?: VisualHighlight[];
}

const SAMPLE_LIMIT = 5;
const MIN_LINE_PX = 8;
/** Share of the smaller line's area that must be covered, and of its height. */
const OVERLAP_MIN_AREA_SHARE = 0.35;
const OVERLAP_MIN_HEIGHT_SHARE = 0.5;
const OVERLAP_MIN_WIDTH_PX = 12;
const DISTORTION_TOLERANCE = 0.1;
const DISTORTION_MIN_PX = 50;

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

const GLYPH_INSET = 0.15;
const glyphBox = (r: DocRect): DocRect => ({
  x: r.x,
  y: r.y + r.height * GLYPH_INSET,
  width: r.width,
  height: r.height * (1 - 2 * GLYPH_INSET),
});

function intersection(a: DocRect, b: DocRect): DocRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Pairs of text lines from different elements that are printed over each other. Geometry only: the
 * collector then looks at each pair on the page to drop the ones where one line is hidden under an
 * opaque box. A sweep over lines sorted by top keeps this near-linear on a long page.
 */
export function findOverlappingLines(lines: TextLine[], limit = 40): OverlapPair[] {
  const usable = lines
    .filter((l) => l.rect.width >= MIN_LINE_PX && l.rect.height >= MIN_LINE_PX && l.text.trim().length >= 2)
    .sort((p, q) => p.rect.y - q.rect.y);
  const out: OverlapPair[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < usable.length && out.length < limit; i++) {
    const a = usable[i]!;
    for (let j = i + 1; j < usable.length; j++) {
      const b = usable[j]!;
      if (b.rect.y >= a.rect.y + a.rect.height) break;
      if (a.owner === b.owner) continue;
      // Compare the letters, not the line boxes: a line box is taller than its glyphs (a display
      // headline with a tight line height reaches well above its capitals), so each line is
      // trimmed by GLYPH_INSET of its height at the top and at the bottom first.
      const ga = glyphBox(a.rect);
      const gb = glyphBox(b.rect);
      const glyphs = intersection(ga, gb);
      const hit = intersection(a.rect, b.rect);
      if (!glyphs || !hit || glyphs.width < OVERLAP_MIN_WIDTH_PX) continue;
      const smaller = Math.min(ga.width * ga.height, gb.width * gb.height);
      const lower = Math.min(ga.height, gb.height);
      if (
        glyphs.width * glyphs.height < smaller * OVERLAP_MIN_AREA_SHARE ||
        glyphs.height < lower * OVERLAP_MIN_HEIGHT_SHARE
      ) {
        continue;
      }
      const key = `${Math.min(a.owner, b.owner)}:${Math.max(a.owner, b.owner)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, rect: hit });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** An `<img>` drawn at a width-to-height ratio more than 10% off its file's, with nothing set to crop it instead. */
export function isDistortedImage(i: ImageSample): boolean {
  if (i.decorative || (i.objectFit && i.objectFit !== 'fill')) return false;
  if (i.naturalWidth < 2 || i.naturalHeight < 2) return false;
  if (i.width < DISTORTION_MIN_PX || i.height < DISTORTION_MIN_PX) return false;
  const natural = i.naturalWidth / i.naturalHeight;
  const shown = i.width / i.height;
  return Math.abs(shown / natural - 1) > DISTORTION_TOLERANCE;
}

/** A link to `#section` on its own page where no element carries that id or name. */
export function isDeadFragment(l: FragmentLink): boolean {
  const f = l.fragment;
  if (l.targetExists || l.scripted) return false;
  if (!f || f === 'top' || /^[!/]/.test(f) || f.includes('=') || f.length > 80) return false;
  return true;
}

/** Entries of one list that say the same thing and lead to the same place, with the times each occurs. */
export function findDuplicateEntries(entries: SiblingEntry[]): Array<{ entry: SiblingEntry; times: number }> {
  const groups = new Map<string, SiblingEntry[]>();
  const listSize = new Map<number, number>();
  for (const e of entries) listSize.set(e.list, (listSize.get(e.list) ?? 0) + 1);
  for (const e of entries) {
    // Only an entry that leads somewhere: labels such as "Self-paced" or "Mid size" repeat on cards
    // by design, while the same link twice in one menu or list is a mistake.
    if (!e.href) continue;
    const text = e.text.replace(/\s+/g, ' ').trim().toLowerCase();
    // Prices, ratings and icons repeat by nature: an entry needs a word.
    // …and be an entry, not a paragraph: legal text repeats whole sentences on purpose.
    if (text.length < 3 || text.length > 60 || !/\p{L}{3}/u.test(text)) continue;
    const key = `${e.list}|${e.group ?? ''}|${text}|${e.href}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return (
    [...groups.values()]
      // A list that is mostly one entry repeats it on purpose ("Read more", a rental tile).
      .filter((g) => g.length > 1 && g.length * 2 <= (listSize.get(g[0]!.list) ?? 0))
      .map((g) => ({ entry: g[0]!, times: g.length }))
  );
}

function sampleList(items: string[]): string {
  const shown = items
    .slice(0, SAMPLE_LIMIT)
    .map((s) => `"${s}"`)
    .join(', ');
  return items.length > SAMPLE_LIMIT ? `${shown} (+${items.length - SAMPLE_LIMIT} more)` : shown;
}

/** Findings and highlight boxes for one snapshot; `where` names the screen width when it is not the phone default. */
export function evaluateLayout(snapshot: LayoutSnapshot, url: string, where = ''): LayoutIntegrityData {
  const link = `<a href="${url}">${url}</a>`;
  const at = where ? ` at ${where}` : '';
  const issues: Issue[] = [];
  const highlights: VisualHighlight[] = [];

  const textOverlaps = snapshot.overlaps.map((p) => `${short(p.a.text.trim(), 30)} / ${short(p.b.text.trim(), 30)}`);
  if (textOverlaps.length > 0) {
    issues.push({
      severity: SEVERITY.MEDIUM,
      message: TEXT_OVERLAP_MESSAGE,
      detail: `${link} prints text over other text${at} in ${textOverlaps.length} place(s): ${sampleList(textOverlaps)}`,
    });
    for (const p of snapshot.overlaps) {
      highlights.push({ kind: TEXT_OVERLAP_MESSAGE, rect: p.rect, label: `overlap: ${short(p.a.text.trim(), 24)}` });
    }
  }

  const distorted = snapshot.images.filter(isDistortedImage);
  const distortedImages = distorted.map(
    (i) =>
      `${short(i.src.split('/').pop() ?? i.src, 50)} (file ${i.naturalWidth}×${i.naturalHeight}, shown ${Math.round(i.width)}×${Math.round(i.height)})`,
  );
  if (distorted.length > 0) {
    issues.push({
      severity: SEVERITY.MEDIUM,
      message: DISTORTED_IMAGE_MESSAGE,
      detail: `${link} shows ${distorted.length} image(s) stretched or squashed${at}: ${sampleList(distortedImages)}`,
    });
    for (const i of distorted) {
      if (i.rect) highlights.push({ kind: DISTORTED_IMAGE_MESSAGE, rect: i.rect, label: 'stretched image' });
    }
  }

  const dead = snapshot.fragments.filter(isDeadFragment);
  const deadFragments = [...new Set(dead.map((l) => `#${l.fragment}`))];
  if (deadFragments.length > 0) {
    issues.push({
      severity: SEVERITY.LOW,
      message: DEAD_FRAGMENT_MESSAGE,
      detail: `${link} has ${deadFragments.length} in-page link target(s) that are not on the page: ${sampleList(deadFragments)}`,
    });
    for (const l of dead) {
      if (l.rect) highlights.push({ kind: DEAD_FRAGMENT_MESSAGE, rect: l.rect, label: `#${short(l.fragment, 24)}` });
    }
  }

  const duplicates = findDuplicateEntries(snapshot.entries);
  const duplicateEntries = duplicates.map((d) => `${short(d.entry.text.replace(/\s+/g, ' ').trim(), 40)} ×${d.times}`);
  if (duplicates.length > 0) {
    issues.push({
      severity: SEVERITY.LOW,
      message: DUPLICATE_ENTRY_MESSAGE,
      detail: `${link} lists the same entry more than once in one list: ${sampleList(duplicateEntries)}`,
    });
    for (const d of duplicates) {
      if (d.entry.rect) highlights.push({ kind: DUPLICATE_ENTRY_MESSAGE, rect: d.entry.rect, label: `×${d.times}` });
    }
  }

  if (snapshot.emptyBlocks.length > 0) {
    const tallest = Math.max(...snapshot.emptyBlocks.map((b) => Math.round(b.rect.height)));
    issues.push({
      severity: SEVERITY.LOW,
      message: EMPTY_BLOCK_MESSAGE,
      detail: `${link} has ${snapshot.emptyBlocks.length} block(s) at least a third of a screen tall with nothing in them${at} (tallest ${tallest}px)`,
    });
    for (const b of snapshot.emptyBlocks) highlights.push({ kind: EMPTY_BLOCK_MESSAGE, rect: b.rect, label: 'empty' });
  }

  return {
    textOverlaps,
    distortedImages,
    deadFragments,
    duplicateEntries,
    emptyBlocks: snapshot.emptyBlocks.length,
    issues,
    highlights: capHighlights(highlights),
  };
}

/** The desktop pass keeps only what a wider screen can change: overlapping text and sideways scroll. */
export function evaluateDesktopLayout(snapshot: LayoutSnapshot, url: string): Issue[] {
  const where = `${snapshot.viewport.width}px wide (desktop)`;
  const issues = evaluateLayout(
    { ...snapshot, images: [], fragments: [], entries: [], emptyBlocks: [] },
    url,
    where,
  ).issues;
  const extra = snapshot.scrollWidth - snapshot.viewport.width;
  if (extra > 16) {
    issues.push({
      severity: SEVERITY.MEDIUM,
      message: DESKTOP_OVERFLOW_MESSAGE,
      detail: `<a href="${url}">${url}</a> is ${extra}px wider than a ${snapshot.viewport.width}px desktop window, so it scrolls sideways`,
    });
  }
  return issues;
}

/** Where the desktop pass's findings sit, for its screenshots. */
export function desktopHighlights(snapshot: LayoutSnapshot): VisualHighlight[] {
  const out: VisualHighlight[] = snapshot.overlaps.map((p) => ({
    kind: TEXT_OVERLAP_MESSAGE,
    rect: p.rect,
    label: `overlap: ${short(p.a.text.trim(), 24)}`,
  }));
  const extra = snapshot.scrollWidth - snapshot.viewport.width;
  if (extra > 16) {
    out.push({
      kind: DESKTOP_OVERFLOW_MESSAGE,
      rect: { x: snapshot.viewport.width - 48, y: 0, width: 48, height: Math.min(snapshot.viewport.height, 600) },
      label: `the page continues ${extra}px to the right`,
    });
  }
  return capHighlights(out);
}

/**
 * Reads the layout from the page. Runs in the browser: everything it needs is inside the function.
 * `candidates` are overlap pairs from `findOverlappingLines`; the second call confirms them.
 */
async function collect(page: ChromePage): Promise<Omit<LayoutSnapshot, 'overlaps'> & { lines: TextLine[] }> {
  return page.evaluate(() => {
    const docRect = (r: DOMRect) => ({
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    });
    const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    const shown = (el: Element) => {
      const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
      if (typeof check === 'function') {
        if (!check.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
          return false;
        }
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    /** The part of `rect` (viewport coords) left after every clipping ancestor; null when nothing is left. */
    const clipped = (el: Element, rect: DOMRect) => {
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      // From the element itself: a line-clamped heading hides its own extra lines.
      for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (cs.overflowX !== 'visible') {
          left = Math.max(left, pr.left);
          right = Math.min(right, pr.right);
        }
        if (cs.overflowY !== 'visible') {
          top = Math.max(top, pr.top);
          bottom = Math.min(bottom, pr.bottom);
        }
        if (right - left < 1 || bottom - top < 1) return null;
      }
      return new DOMRect(left, top, right - left, bottom - top);
    };
    const pinned = (el: Element) => {
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
        const position = getComputedStyle(p).position;
        if (position === 'fixed' || position === 'sticky') return true;
      }
      return false;
    };

    // Text lines.
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'TITLE']);
    const owners: Element[] = [];
    const lines: Array<{ owner: number; text: string; rect: { x: number; y: number; width: number; height: number } }> =
      [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const pageWidth = Math.max(document.documentElement.scrollWidth, viewport.width);
    for (let node = walker.nextNode(); node && lines.length < 4000; node = walker.nextNode()) {
      const value = (node.nodeValue ?? '').trim();
      const parent = node.parentElement;
      if (value.length < 2 || !parent || SKIP.has(parent.tagName)) continue;
      if (!shown(parent) || pinned(parent)) continue;
      const cs = getComputedStyle(parent);
      if (parseFloat(cs.fontSize) < 6 || cs.color === 'rgba(0, 0, 0, 0)' || cs.color === 'transparent') continue;
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).slice(0, 6);
      let owner = -1;
      for (const r of rects) {
        const visible = clipped(parent, r);
        if (!visible || visible.width < 8 || visible.height < 8) continue;
        if (visible.right < 0 || visible.left > pageWidth) continue;
        if (owner < 0) {
          owner = owners.length;
          owners.push(parent);
        }
        lines.push({ owner, text: value.slice(0, 60), rect: docRect(visible) });
      }
    }
    (window as unknown as { __auditLayoutOwners?: Element[] }).__auditLayoutOwners = owners;

    // Images.
    const images = Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth > 0 && shown(img))
      .slice(0, 300)
      .map((img) => {
        const r = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        // The laid-out content box, not the bounding box: a rotated or scaled slide has a bounding
        // box of another shape while the picture itself keeps its proportions.
        return {
          src: img.currentSrc || img.src,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          width: img.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          height: img.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
          objectFit: cs.objectFit,
          decorative:
            img.getAttribute('alt') === '' ||
            img.getAttribute('role') === 'presentation' ||
            !!img.closest('[aria-hidden="true"]'),
          rect: docRect(r),
        };
      })
      // An SVG file reports the size of its viewBox, which the page is free to ignore.
      .filter((i) => !/\.svg(?:[?#]|$)/i.test(i.src) && !i.src.startsWith('data:image/svg'));

    // In-page links.
    const here = `${location.origin}${location.pathname}${location.search}`;
    const SCRIPT_ATTR = /toggle|modal|target|popup|lightbox|fancybox|collapse|tab|slide|scroll|dismiss|drawer/i;
    const fragments = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="#"]'))
      .filter((a) => {
        try {
          const u = new URL(a.href);
          return `${u.origin}${u.pathname}${u.search}` === here && u.hash.length > 1 && shown(a);
        } catch {
          return false;
        }
      })
      .slice(0, 300)
      .map((a) => {
        let fragment = new URL(a.href).hash.slice(1);
        try {
          fragment = decodeURIComponent(fragment);
        } catch {
          // keep the raw fragment
        }
        const role = a.getAttribute('role') ?? '';
        const scripted =
          /^(?:button|tab|menuitem|switch)$/.test(role) ||
          a.hasAttribute('aria-controls') ||
          a.hasAttribute('aria-expanded') ||
          a.hasAttribute('aria-haspopup') ||
          a.hasAttribute('onclick') ||
          Array.from(a.attributes).some((at) => at.name.startsWith('data-') && SCRIPT_ATTR.test(at.name)) ||
          SCRIPT_ATTR.test(a.className);
        const targetExists =
          !!document.getElementById(fragment) || document.getElementsByName(fragment).length > 0 || fragment === '';
        return {
          fragment,
          text: (a.textContent ?? '').trim().slice(0, 60),
          targetExists,
          scripted,
          rect: docRect(a.getBoundingClientRect()),
        };
      });

    // Sibling entries of lists.
    const LOOPING =
      /clone|duplicate|marquee|ticker|slick|swiper|carousel|slider|splide|embla|glide|flickity|keen|loop/i;
    const entries: Array<{
      list: number;
      text: string;
      href: string;
      group: string;
      rect: { x: number; y: number; width: number; height: number };
    }> = [];
    let listIndex = 0;
    // Any element with three or more children counts as a list: accordions and card grids are
    // often plain <div>s. Entries are compared only with siblings of the same tag and class.
    const parents = Array.from(document.body?.querySelectorAll('*') ?? []).filter(
      (el) => (el.children?.length ?? 0) >= 3 && el.children.length <= 400,
    );
    for (const parent of parents.slice(0, 1500)) {
      if (parent.closest('[aria-hidden="true"]')) continue;
      let looping = false;
      for (let p: Element | null = parent; p && p !== document.body; p = p.parentElement) {
        if (LOOPING.test(`${p.className} ${p.id}`)) {
          looping = true;
          break;
        }
      }
      if (looping) continue;
      const children = Array.from(parent.children).filter((c) => c.tagName !== 'SCRIPT' && c.tagName !== 'TEMPLATE');
      if (children.length < 3 || children.length > 400) continue;
      const list = listIndex++;
      for (const child of children) {
        if (child.getAttribute('aria-hidden') === 'true' || LOOPING.test(child.className)) continue;
        if (child.tagName !== 'OPTION' && !shown(child)) continue;
        const anchor = child.matches('a[href]') ? child : child.querySelector('a[href]');
        entries.push({
          list,
          text: ((child as HTMLElement).innerText ?? child.textContent ?? '').slice(0, 160),
          group: `${child.tagName}.${typeof child.className === 'string' ? child.className : ''}`,
          href: anchor ? (anchor as HTMLAnchorElement).href : '',
          rect: docRect(child.getBoundingClientRect()),
        });
      }
    }

    // Large empty blocks.
    const MEDIA = 'img, picture, video, canvas, svg, iframe, object, embed, input, select, textarea, button, audio';
    const emptyBlocks: Array<{ tag: string; rect: { x: number; y: number; width: number; height: number } }> = [];
    const minHeight = Math.max(300, viewport.height / 3);
    const painted = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') return true;
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content !== 'none' && ps.content !== 'normal' && ps.display !== 'none') return true;
      }
      return false;
    };
    const blocks = document.querySelectorAll('section, article, main > div, body > div, [class*="section"]');
    for (const el of Array.from(blocks).slice(0, 600)) {
      if (emptyBlocks.length >= 12) break;
      const r = el.getBoundingClientRect();
      if (r.height < minHeight || r.width < viewport.width * 0.8 || !shown(el) || pinned(el)) continue;
      if (((el as HTMLElement).innerText ?? '').trim()) continue;
      if (el.querySelector(MEDIA) || el.shadowRoot) continue;
      if (painted(el)) continue;
      const inner = Array.from(el.querySelectorAll('*')).slice(0, 300);
      if (inner.some((d) => painted(d) || d.shadowRoot || d.tagName.includes('-'))) continue;
      if (
        emptyBlocks.some(
          (b) => b.rect.y <= r.top + window.scrollY && b.rect.y + b.rect.height >= r.bottom + window.scrollY,
        )
      ) {
        continue;
      }
      emptyBlocks.push({ tag: el.tagName.toLowerCase(), rect: docRect(r) });
    }

    return {
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      lines,
      images,
      fragments,
      entries,
      emptyBlocks,
    };
  });
}

/**
 * Looks at each overlap on the page. Geometry alone flags a line that sits under an opaque box (a
 * closed panel, a stacked slide); a visitor does not see that one. The pair is kept only when the
 * element painted on top at the overlap is one of the two lines' elements and nothing opaque lies
 * between it and the ancestor both lines share.
 */
async function confirmOverlaps(page: ChromePage, pairs: OverlapPair[]): Promise<OverlapPair[]> {
  if (pairs.length === 0) return [];
  const points = pairs.map((p) => ({
    a: p.a.owner,
    b: p.b.owner,
    x: p.rect.x + p.rect.width / 2,
    y: p.rect.y + p.rect.height / 2,
  }));
  const kept: boolean[] = await page.evaluate((pts: Array<{ a: number; b: number; x: number; y: number }>) => {
    const owners = (window as unknown as { __auditLayoutOwners?: Element[] }).__auditLayoutOwners ?? [];
    const startX = window.scrollX;
    const startY = window.scrollY;
    const opaque = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') return true;
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      if (!m) return false;
      const parts = m[1]!.split(',').map((s) => parseFloat(s));
      return (parts[3] ?? 1) > 0.05;
    };
    const out = pts.map((pt) => {
      const a = owners[pt.a];
      const b = owners[pt.b];
      if (!a || !b || a.contains(b) || b.contains(a)) return false;
      window.scrollTo(0, Math.max(0, pt.y - window.innerHeight / 2));
      const top = document.elementFromPoint(pt.x - window.scrollX, pt.y - window.scrollY);
      if (!top) return false;
      const upper = a.contains(top) ? a : b.contains(top) ? b : null;
      if (!upper) return false;
      const lower = upper === a ? b : a;
      for (let el: Element | null = upper; el && !el.contains(lower); el = el.parentElement) {
        if (opaque(el)) return false;
      }
      return true;
    });
    window.scrollTo(startX, startY);
    delete (window as unknown as { __auditLayoutOwners?: Element[] }).__auditLayoutOwners;
    return out;
  }, points);
  return pairs.filter((_, i) => kept[i]);
}

/** The page's layout at its current screen width. */
export async function collectLayoutSnapshot(page: ChromePage): Promise<LayoutSnapshot> {
  const { lines, ...rest } = await collect(page);
  const overlaps = await confirmOverlaps(page, findOverlappingLines(lines));
  return { ...rest, overlaps };
}

class LayoutIntegrityAnalyzer {
  static async analyze(chromePage: ChromePage, url: string): Promise<LayoutIntegrityData> {
    return evaluateLayout(await collectLayoutSnapshot(chromePage), url);
  }
}

export { LayoutIntegrityAnalyzer };
