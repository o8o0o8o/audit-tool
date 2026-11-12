import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';
import { type DocRect, type VisualHighlight, capHighlights } from './visual-highlights';

export interface ClipMetrics {
  overflowX: string;
  overflowY: string;
  textOverflow: string;
  lineClamp: string;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** Computed `clip` (e.g. `rect(0px, 0px, 0px, 0px)`), `auto` when unset. */
  clip?: string;
  /** Computed `clip-path`, `none` when unset. */
  clipPath?: string;
}

export interface ClippedSample {
  tag: string;
  text: string;
  metrics: ClipMetrics;
  rect?: DocRect;
}

/** A visible text node with its parent element's document-coordinate box. */
export interface TextSample {
  value: string;
  rect?: DocRect;
}

export interface TextIntegrityData {
  templateTokens: string[];
  placeholderText: boolean;
  mojibake: string[];
  clippedText: string[];
  issues: Issue[];
  /** Where each defect sits on the page (document coords); absent on older audits. */
  highlights?: VisualHighlight[];
}

export const TEMPLATE_TOKENS_MESSAGE = 'Unrendered template tokens in page text';
export const PLACEHOLDER_TEXT_MESSAGE = 'Placeholder text (lorem ipsum) on page';
export const MOJIBAKE_MESSAGE = 'Garbled characters (mojibake) in page text';
export const CLIPPED_TEXT_MESSAGE = 'Text clipped by its container';

const CLIP_TOLERANCE_PX = 5;
/** Boxes this small are the visually-hidden (`.sr-only`) pattern, not a layout that cut text off. */
const VISUALLY_HIDDEN_MAX_PX = 2;
const REPLACEMENT_CHAR_MIN = 3;
const SAMPLE_LIMIT = 5;

const CURLY_TOKEN = /\{\{[^{}]{0,80}\}\}/g;
const OBJECT_TOKEN = /\[object Object\]/g;
const BARE_VALUE = /^(?:undefined|NaN)$/;
const VALUE_SLOT_BEFORE = /(?:[:=]\s*|[$€£¥]\s*|\d\s*)\b(undefined|NaN)\b/g;
const VALUE_SLOT_AFTER = /\b(undefined|NaN)\b(?=\s*(?:%|px\b|[$€£¥]|\d))/g;
const LOREM = /\blorem ipsum\b/i;
// UTF-8 bytes decoded as Latin-1/CP1252: a lead byte (Ã/Â) followed by a continuation byte, or the â€ prefix of curly quotes/dashes.
const MOJIBAKE_PAIR = /[ÃÂ][\u0080-¿]|â€/g;
const REPLACEMENT_CHAR = /�/g;

/** Unrendered template output in one visible text node; prose mentions of `undefined`/`NaN` are not flagged. */
export function findTemplateTokens(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.match(CURLY_TOKEN) ?? []) found.add(m);
  for (const m of text.match(OBJECT_TOKEN) ?? []) found.add(m);
  const trimmed = text.trim();
  if (BARE_VALUE.test(trimmed)) found.add(trimmed);
  for (const re of [VALUE_SLOT_BEFORE, VALUE_SLOT_AFTER]) {
    for (const m of text.matchAll(re)) found.add(m[1]!);
  }
  return [...found];
}

export function hasPlaceholderText(text: string): boolean {
  return LOREM.test(text);
}

/** Mis-decoded UTF-8 sequences in the page text; `�` counts only when it recurs. */
export function findMojibake(text: string): string[] {
  const found = new Set(text.match(MOJIBAKE_PAIR) ?? []);
  if ((text.match(REPLACEMENT_CHAR) ?? []).length >= REPLACEMENT_CHAR_MIN) found.add('�');
  return [...found];
}

/** Text cut off by an `overflow: hidden|clip` box with no ellipsis or line-clamp signalling the truncation. */
export function isClippedText(m: ClipMetrics): boolean {
  if (m.textOverflow === 'ellipsis') return false;
  if (m.lineClamp && m.lineClamp !== 'none') return false;
  // Deliberately hidden text (.sr-only / .visually-hidden): clipped away or shrunk to a ~1px box.
  if (m.clip && m.clip !== 'auto') return false;
  if (m.clipPath && m.clipPath !== 'none') return false;
  if (m.clientWidth <= VISUALLY_HIDDEN_MAX_PX || m.clientHeight <= VISUALLY_HIDDEN_MAX_PX) return false;
  const hides = (v: string) => v === 'hidden' || v === 'clip';
  const clippedX = hides(m.overflowX) && m.scrollWidth > m.clientWidth + CLIP_TOLERANCE_PX;
  const clippedY = hides(m.overflowY) && m.scrollHeight > m.clientHeight + CLIP_TOLERANCE_PX;
  return clippedX || clippedY;
}

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Box the text nodes and elements behind each text finding. Mojibake boxes only nodes containing a reported sequence. */
export function buildTextHighlights(texts: TextSample[], mojibake: string[], clipped: ClippedSample[]): VisualHighlight[] {
  const out: VisualHighlight[] = [];
  for (const t of texts) {
    if (!t.rect) continue;
    const tokens = findTemplateTokens(t.value);
    if (tokens.length > 0) out.push({ kind: TEMPLATE_TOKENS_MESSAGE, rect: t.rect, label: short(tokens.join(' ')) });
    if (hasPlaceholderText(t.value)) out.push({ kind: PLACEHOLDER_TEXT_MESSAGE, rect: t.rect, label: 'lorem ipsum' });
    const bad = mojibake.find((m) => t.value.includes(m));
    if (bad) out.push({ kind: MOJIBAKE_MESSAGE, rect: t.rect, label: `“${bad}”` });
  }
  for (const c of clipped) {
    if (c.rect) out.push({ kind: CLIPPED_TEXT_MESSAGE, rect: c.rect, label: `clipped: ${short(c.text, 30)}` });
  }
  return capHighlights(out);
}

function sampleList(items: string[]): string {
  const shown = items.slice(0, SAMPLE_LIMIT).map((s) => `"${s}"`).join(', ');
  return items.length > SAMPLE_LIMIT ? `${shown} (+${items.length - SAMPLE_LIMIT} more)` : shown;
}

class TextIntegrityAnalyzer {
  static async analyze(chromePage: ChromePage, url: string): Promise<TextIntegrityData> {
    const snapshot = await chromePage.evaluate(() => {
      const docRect = (r: DOMRect) =>
        r.width > 0 && r.height > 0
          ? { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
          : undefined;
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA']);
      const texts: Array<{ value: string; rect?: { x: number; y: number; width: number; height: number } }> = [];
      const clipCandidates = new Set<Element>();
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? '';
        if (!value.trim()) continue;
        let skip = false;
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (SKIP.has(el.tagName)) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        texts.push({ value, rect: docRect(rect) });
        if (clipCandidates.size < 500) clipCandidates.add(parent);
      }
      const clipped = Array.from(clipCandidates).map((el) => {
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().slice(0, 60),
          metrics: {
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
            textOverflow: cs.textOverflow,
            lineClamp: cs.getPropertyValue('-webkit-line-clamp') || cs.getPropertyValue('line-clamp'),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            clip: cs.clip,
            clipPath: cs.clipPath,
          },
          rect: docRect(el.getBoundingClientRect()),
        };
      });
      return { texts, clipped };
    });

    const values = snapshot.texts.map((t) => t.value);
    const templateTokens = [...new Set(values.flatMap(findTemplateTokens))];
    const placeholderText = values.some(hasPlaceholderText);
    const mojibake = findMojibake(values.join('\n'));
    const clippedSamples = snapshot.clipped.filter((c: ClippedSample) => isClippedText(c.metrics));
    const clippedText = clippedSamples.map((c: ClippedSample) => `<${c.tag}> ${c.text}`);
    const link = `<a href="${url}">${url}</a>`;
    const issues: Issue[] = [];

    if (templateTokens.length > 0) {
      issues.push({
        severity: SEVERITY.HIGH,
        message: TEMPLATE_TOKENS_MESSAGE,
        detail: `${link} shows raw template output: ${sampleList(templateTokens)}`,
      });
    }
    if (placeholderText) {
      issues.push({
        severity: SEVERITY.MEDIUM,
        message: PLACEHOLDER_TEXT_MESSAGE,
        detail: `${link} contains lorem ipsum placeholder copy`,
      });
    }
    if (mojibake.length > 0) {
      issues.push({
        severity: SEVERITY.MEDIUM,
        message: MOJIBAKE_MESSAGE,
        detail: `${link} shows mis-decoded characters: ${sampleList(mojibake)}`,
      });
    }
    if (clippedText.length > 0) {
      issues.push({
        severity: SEVERITY.LOW,
        message: CLIPPED_TEXT_MESSAGE,
        detail: `${link} has ${clippedText.length} element(s) whose text is cut off without an ellipsis: ${sampleList(clippedText)}`,
      });
    }

    const highlights = buildTextHighlights(snapshot.texts, mojibake, clippedSamples);
    return { templateTokens, placeholderText, mojibake, clippedText, issues, highlights };
  }
}

export { TextIntegrityAnalyzer };
