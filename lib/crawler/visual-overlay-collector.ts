/**
 * Visual overlay collector
 *
 * Measures the document-coordinate rectangles of issue-bearing elements on the
 * live page at evidence-capture time (mobile viewport, same moment as
 * screenshot.mobile.png), so Phase 2 can draw issue-specific highlight boxes
 * over the already-captured screenshot instead of embedding a context-free
 * full-page shot. Persisted as `evidence/<dir>/overlays.json`.
 *
 * Rects are in CSS pixels relative to the DOCUMENT origin (viewport rect +
 * scroll offset), matching a `fullPage: true` screenshot. Phase 2 renders the
 * boxes as percentage-positioned divs over the image, so deviceScaleFactor
 * never enters the math — only the document dimensions recorded here do.
 */

import type { ChromePage } from '../types';
import type { CLSEntry } from './vitals-collector';

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayItem {
  selector: string;
  rect: OverlayRect;
  /** Short human caption rendered next to the box ("no alt", "2400×1350 → 414×233"). */
  label?: string;
}

export interface ClsShiftSource {
  node: string | null;
  selector: string | null;
  previousRect: OverlayRect | null;
  currentRect: OverlayRect | null;
}

/** Head facts for snippet-card evidence (canonical / robots / lang / hreflang). */
export interface HeadFacts {
  canonical: string | null;
  metaRobots: string | null;
  htmlLang: string | null;
  charset: string | null;
  hasDoctype: boolean;
  hreflangs: Array<{ lang: string; href: string }>;
}

/** Per-file slice of the CDP coverage summary persisted for panel evidence. */
export interface CoverageFileSummary {
  url: string;
  total: number;
  unused: number;
  unusedPercent: number;
}
export interface CoverageSummary {
  total: number;
  unused: number;
  files: CoverageFileSummary[];
}

export interface VisualOverlays {
  url: string;
  capturedAt: string;
  /** Crawl (mobile) viewport at capture time — also the fold line. */
  viewport: { width: number; height: number };
  /** Full document size at capture time (scrollWidth/scrollHeight). */
  document: { width: number; height: number };
  /**
   * The mobile screenshot's actual size in CSS px (PNG pixels ÷ devicePixelRatio).
   * Can exceed `document` (e.g. a scrollbar gutter widens the capture); the
   * renderer sizes the image from this so highlight boxes stay aligned. Falls
   * back to `document` when absent (older audits).
   */
  shot?: { width: number; height: number };
  /** For SERP-preview rendering of title/description findings. */
  pageMeta: { title: string; description: string };
  /** Head facts for snippet-card evidence. */
  head?: HeadFacts;
  /** Data-panel inputs (render-blocking list, coverage summary, security headers). */
  panels?: {
    renderBlocking?: Array<{ url: string; kind: 'script' | 'style' }>;
    coverage?: { js?: CoverageSummary; css?: CoverageSummary };
    securityHeaders?: { missing: string[] };
  };
  /** JSON-LD structured data found on the page (types + truncated first block). */
  schema?: { types: string[]; snippet: string | null };
  /** Issue kind → highlighted elements. Keys sorted at write time for determinism. */
  kinds: Record<string, OverlayItem[]>;
  /** Layout-shift attribution (from the vitals pass), when CLS was observed. */
  cls?: { value: number; shifts: ClsShiftSource[] };
  /** LCP element attribution (from the vitals pass, --perf). */
  lcp?: {
    selector: string | null;
    rect: OverlayRect | null;
    value: number;
    subParts?: { ttfb: number; resourceLoad: number; resourceDelay: number; renderDelay: number };
  };
}

/** Per-kind cap — keeps overlays.json small and the annotated shot readable. */
const MAX_ITEMS_PER_KIND = 12;
const MAX_CLS_SHIFTS = 8;

interface AxeTarget {
  selector: string;
  label?: string;
}

/**
 * Collect overlay rects for every visually-evidencable issue kind. Runs one
 * in-page evaluate; all queries are cheap (the analyzers already ran heavier
 * versions of each). Returns null when the evaluate fails — overlays are
 * best-effort evidence, never a crawl blocker.
 */
/** Compact coverage shape accepted from the analyzer (matches CodeCoverageData). */
interface CoverageInput {
  js?: { total: number; unused: number; files: CoverageFileSummary[] };
  css?: { total: number; unused: number; files: CoverageFileSummary[] };
}

export async function collectVisualOverlays(
  chromePage: ChromePage,
  url: string,
  contrastTargets: AxeTarget[],
  clsData?: { value?: number; entries?: CLSEntry[] },
  codeCoverage?: CoverageInput | null,
  extra?: {
    /** LCP attribution from the vitals pass (--perf). */
    lcp?: VisualOverlays['lcp'];
    /** Security headers the analyzer found missing on this page. */
    missingHeaders?: string[] | null;
  },
): Promise<VisualOverlays | null> {
  let collected:
    | (Omit<VisualOverlays, 'url' | 'capturedAt' | 'cls' | 'lcp' | 'panels'> & {
        renderBlocking: Array<{ url: string; kind: 'script' | 'style' }>;
      })
    | null;
  try {
    collected = await chromePage.evaluate(
      ({ contrastTargets, maxPerKind }) => {
        const round = (n: number) => Math.round(n);
        const docRect = (el: Element) => {
          const r = el.getBoundingClientRect();
          return {
            x: round(r.x + window.scrollX),
            y: round(r.y + window.scrollY),
            width: round(r.width),
            height: round(r.height),
          };
        };
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.01;
        };
        const cssPath = (node: Element | null): string => {
          let el: Element | null = node;
          const parts: string[] = [];
          for (let depth = 0; el && el.nodeType === 1 && depth < 4; depth++) {
            if (el.id) {
              parts.unshift(`#${CSS.escape(el.id)}`);
              break;
            }
            let part = el.tagName.toLowerCase();
            const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
            if (cls) part += `.${CSS.escape(cls)}`;
            const parent: Element | null = el.parentElement;
            if (parent) {
              const sibs = Array.from(parent.children).filter((c) => c.tagName === el!.tagName);
              if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
            }
            parts.unshift(part);
            if (el.tagName === 'BODY' || !parent) break;
            el = parent;
          }
          return parts.join(' > ');
        };
        const item = (el: Element, label?: string) => ({ selector: cssPath(el), rect: docRect(el), label });

        const kinds: Record<
          string,
          Array<{ selector: string; rect: { x: number; y: number; width: number; height: number }; label?: string }>
        > = {};
        const add = (kind: string, el: Element, label?: string) => {
          if (!visible(el)) return;
          const list = (kinds[kind] ??= []);
          if (list.length >= maxPerKind) return;
          list.push(item(el, label));
        };

        // ── Images ──────────────────────────────────────────────────────────
        for (const img of Array.from(document.querySelectorAll('img'))) {
          const displayW = img.getBoundingClientRect().width;
          const alt = img.getAttribute('alt');
          if (alt === null || alt.trim() === '') add('missing-alt', img, 'no alt text');
          if (img.naturalWidth > 0 && displayW > 0 && img.naturalWidth > displayW * 2) {
            add(
              'oversized-image',
              img,
              `${img.naturalWidth}×${img.naturalHeight} → displayed ${round(displayW)}px (${(img.naturalWidth / displayW).toFixed(1)}×)`,
            );
          }
          const src = img.currentSrc || img.src || '';
          if (
            /\.(jpe?g|png)(\?|#|$)/i.test(src) &&
            !img.closest('picture')?.querySelector('source[type="image/webp"], source[type="image/avif"]')
          ) {
            add('legacy-image-format', img, (src.match(/\.(jpe?g|png)/i)?.[1] || 'jpg').toUpperCase());
          }
        }

        // ── Empty anchors ────────────────────────────────────────────────────
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const hasText = (a.textContent ?? '').trim().length > 0;
          const hasLabel = a.getAttribute('aria-label') || a.getAttribute('title');
          const hasImgAlt = a.querySelector('img[alt]:not([alt=""])');
          const hasSvgLabel = a.querySelector('svg [aria-label], svg title');
          if (!hasText && !hasLabel && !hasImgAlt && !hasSvgLabel) add('empty-anchor', a, 'link without text');
        }

        // ── Multiple H1 ──────────────────────────────────────────────────────
        const h1s = Array.from(document.querySelectorAll('h1'));
        if (h1s.length > 1) {
          h1s.forEach((h, i) => add('multiple-h1', h, `H1 #${i + 1}: “${(h.textContent ?? '').trim().slice(0, 40)}”`));
        }

        // ── Small touch targets ──────────────────────────────────────────────
        for (const el of Array.from(
          document.querySelectorAll('a[href], button, [role="button"], input:not([type="hidden"]), select, textarea'),
        )) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.width < 48 || r.height < 48) && r.width < 200) {
            add('small-touch-target', el, `${round(r.width)}×${round(r.height)}px`);
          }
        }

        // ── Intrusive interstitial / overlay ─────────────────────────────────
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        for (const el of Array.from(document.querySelectorAll('div, section, aside, dialog'))) {
          const style = window.getComputedStyle(el);
          if (style.position !== 'fixed' && style.position !== 'absolute') continue;
          const r = el.getBoundingClientRect();
          const coverage = (Math.min(r.width, vw) * Math.min(r.height, vh)) / (vw * vh);
          if (coverage > 0.5 && visible(el) && Number(style.zIndex) > 10) {
            add('interstitial', el, `covers ${Math.round(coverage * 100)}% of viewport`);
            break; // one is enough
          }
        }

        // ── First CTA vs the fold ────────────────────────────────────────────
        const ctaSelector =
          'button, [type="submit"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i], [role="button"]';
        const cta = Array.from(document.querySelectorAll(ctaSelector)).find((el) => visible(el));
        if (cta) {
          const r = docRect(cta);
          const below = r.y > vh;
          add(
            'cta-fold',
            cta,
            below ? `first CTA — ${round(r.y - vh)}px below the fold` : 'first CTA (above the fold)',
          );
        }

        // ── Form inputs missing labels / autocomplete ────────────────────────
        for (const input of Array.from(
          document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
          ),
        )) {
          const id = input.getAttribute('id');
          const hasLabel =
            (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
            input.closest('label') ||
            input.getAttribute('aria-label') ||
            input.getAttribute('aria-labelledby');
          if (!hasLabel) add('form-label', input, 'no label');
          const type = (input.getAttribute('type') ?? 'text').toLowerCase();
          if (
            input.tagName === 'INPUT' &&
            ['text', 'email', 'tel', 'password'].includes(type) &&
            !input.getAttribute('autocomplete')
          ) {
            add('autocomplete', input, `type="${type}" — no autocomplete`);
          }
        }

        // ── Landmark regions (for the missing-<main> overlay) ────────────────
        for (const lm of Array.from(document.querySelectorAll('header, nav, main, [role="main"], footer, aside'))) {
          const name = lm.getAttribute('role') === 'main' ? 'main' : lm.tagName.toLowerCase();
          add('landmarks', lm, `<${name}>`);
        }

        // ── JSON-LD structured data (types + truncated first block) ──────────
        const schemaTypes: string[] = [];
        let schemaSnippet: string | null = null;
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          const text = s.textContent ?? '';
          if (schemaSnippet === null && text.trim()) schemaSnippet = text.trim().slice(0, 600);
          try {
            const parsed = JSON.parse(text) as unknown;
            const collect = (node: unknown) => {
              if (Array.isArray(node)) node.forEach(collect);
              else if (node && typeof node === 'object') {
                const ty = (node as { '@type'?: unknown })['@type'];
                if (typeof ty === 'string' && schemaTypes.length < 8 && !schemaTypes.includes(ty)) schemaTypes.push(ty);
                const graph = (node as { '@graph'?: unknown })['@graph'];
                if (Array.isArray(graph)) graph.forEach(collect);
              }
            };
            collect(parsed);
          } catch {
            // invalid JSON-LD — the snippet alone is still evidence
          }
        }

        // ── Contrast failures (axe-core targets resolved to rects) ───────────
        for (const t of contrastTargets) {
          try {
            const el = document.querySelector(t.selector);
            if (el) add('contrast', el, t.label ?? 'insufficient contrast');
          } catch {
            // invalid/escaped selector — skip
          }
        }

        // ── Head facts (for snippet-card evidence on canonical/robots/lang
        // findings) and render-blocking head resources (for the panel) ────────
        const canonicalEl = document.querySelector('link[rel="canonical" i]');
        const robotsEl = document.querySelector('meta[name="robots" i]');
        const charsetEl = document.querySelector('meta[charset]');
        const hreflangs = Array.from(document.querySelectorAll('link[rel="alternate" i][hreflang]'))
          .slice(0, 8)
          .map((l) => ({
            lang: (l.getAttribute('hreflang') ?? '').slice(0, 20),
            href: (l.getAttribute('href') ?? '').slice(0, 200),
          }));
        const head = {
          canonical: canonicalEl?.getAttribute('href')?.slice(0, 300) ?? null,
          metaRobots: robotsEl?.getAttribute('content')?.slice(0, 100) ?? null,
          htmlLang: document.documentElement.getAttribute('lang'),
          charset: charsetEl?.getAttribute('charset') ?? null,
          hasDoctype: document.doctype !== null,
          hreflangs,
        };
        const renderBlocking: Array<{ url: string; kind: 'script' | 'style' }> = [];
        for (const s of Array.from(
          document.querySelectorAll('head script[src]:not([defer]):not([async]):not([type="module"])'),
        )) {
          if (renderBlocking.length >= 10) break;
          renderBlocking.push({ url: (s.getAttribute('src') ?? '').slice(0, 300), kind: 'script' });
        }
        for (const l of Array.from(document.querySelectorAll('head link[rel="stylesheet" i]:not([media="print"])'))) {
          if (renderBlocking.length >= 10) break;
          renderBlocking.push({ url: (l.getAttribute('href') ?? '').slice(0, 300), kind: 'style' });
        }

        const doc = document.documentElement;
        const meta = document.querySelector('meta[name="description" i]');
        return {
          viewport: { width: vw, height: vh },
          document: {
            width: round(Math.max(doc.scrollWidth, doc.clientWidth)),
            height: round(Math.max(doc.scrollHeight, doc.clientHeight)),
          },
          pageMeta: {
            title: (document.title ?? '').slice(0, 300),
            description: (meta?.getAttribute('content') ?? '').slice(0, 500),
          },
          head,
          renderBlocking,
          schema: { types: schemaTypes, snippet: schemaSnippet },
          kinds,
        };
      },
      { contrastTargets, maxPerKind: MAX_ITEMS_PER_KIND },
    );
  } catch {
    return null;
  }
  if (!collected) return null;

  // Deterministic key order for byte-identical artifacts.
  const sortedKinds: VisualOverlays['kinds'] = {};
  for (const key of Object.keys(collected.kinds).sort()) sortedKinds[key] = collected.kinds[key];

  const overlays: VisualOverlays = {
    url,
    capturedAt: new Date().toISOString(),
    viewport: collected.viewport,
    document: collected.document,
    pageMeta: collected.pageMeta,
    head: collected.head,
    kinds: sortedKinds,
  };
  if (collected.schema && (collected.schema.types.length > 0 || collected.schema.snippet)) {
    overlays.schema = collected.schema;
  }
  if (extra?.lcp && (extra.lcp.selector || extra.lcp.rect)) {
    overlays.lcp = extra.lcp;
  }

  // Data-panel inputs: render-blocking head resources (measured in-page) and a
  // compact slice of the CDP coverage summary the analyzer already computed.
  const covSummary = (c?: {
    total: number;
    unused: number;
    files: CoverageFileSummary[];
  }): CoverageSummary | undefined =>
    c && c.total > 0
      ? {
          total: c.total,
          unused: c.unused,
          files: [...(c.files ?? [])]
            .sort((a, b) => b.unused - a.unused || (a.url < b.url ? -1 : 1))
            .slice(0, 5)
            .map((f) => ({
              url: f.url.slice(0, 200),
              total: f.total,
              unused: f.unused,
              unusedPercent: f.unusedPercent,
            })),
        }
      : undefined;
  const coverage = {
    js: covSummary(codeCoverage?.js ?? undefined),
    css: covSummary(codeCoverage?.css ?? undefined),
  };
  const panels: VisualOverlays['panels'] = {};
  if (collected.renderBlocking.length > 0) panels.renderBlocking = collected.renderBlocking;
  if (coverage.js || coverage.css) panels.coverage = coverage;
  if (extra?.missingHeaders && extra.missingHeaders.length > 0) {
    panels.securityHeaders = { missing: [...extra.missingHeaders].sort() };
  }
  if (panels.renderBlocking || panels.coverage || panels.securityHeaders) overlays.panels = panels;

  // Layout-shift attribution measured by the vitals pass during load. Rects are
  // viewport-relative at shift time; shifts overwhelmingly happen at scroll 0,
  // where viewport coordinates equal document coordinates on the same shot.
  const shifts: ClsShiftSource[] = [];
  // Dedupe by selector when present, else by rect signature — the same node
  // often appears in several session-window entries.
  const shiftKey = (s: {
    selector?: string | null;
    currentRect?: OverlayRect | null;
    previousRect?: OverlayRect | null;
  }) => s.selector ?? JSON.stringify([s.previousRect, s.currentRect]);
  const seenShifts = new Set<string>();
  for (const entry of clsData?.entries ?? []) {
    for (const s of entry.sources ?? []) {
      if (!s.currentRect && !s.previousRect) continue;
      const key = shiftKey(s);
      if (seenShifts.has(key)) continue;
      seenShifts.add(key);
      shifts.push({
        node: s.node ?? null,
        selector: s.selector ?? null,
        previousRect: s.previousRect ?? null,
        currentRect: s.currentRect ?? null,
      });
      if (shifts.length >= MAX_CLS_SHIFTS) break;
    }
    if (shifts.length >= MAX_CLS_SHIFTS) break;
  }
  if (typeof clsData?.value === 'number' && shifts.length > 0) {
    overlays.cls = { value: Number(clsData.value.toFixed(4)), shifts };
  }

  return overlays;
}
