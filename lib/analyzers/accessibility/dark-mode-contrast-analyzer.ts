/**
 * Dark-mode contrast: pages that ship a dark theme (prefers-color-scheme: dark
 * rules or a color-scheme declaration allowing dark) often only get their
 * light theme checked. This re-renders the page with the dark color scheme
 * emulated, scans text contrast (WCAG AA), then restores the light scheme.
 *
 * MUTATES the page's media emulation while it runs: run it LAST (or at least
 * after every analyzer that reads computed styles / screenshots).
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../reports/html-utils';

export const DARK_MODE_CONTRAST_MESSAGE = 'Low color contrast in dark mode';
export const DARK_SCAN_CAP = 300;

export interface DarkModeSupport {
  mediaRules: number;
  colorSchemeMeta: boolean;
  colorSchemeCss: boolean;
}

export interface ContrastFailure {
  text: string;
  selector: string;
  ratio: number;
  fg: string;
  bg: string;
  large: boolean;
}

export interface ContrastScan {
  checked: number;
  failures: ContrastFailure[];
}

export interface DarkModePage {
  evaluate<T>(fn: () => T): Promise<T>;
  emulateMedia(options: { colorScheme?: 'light' | 'dark' | 'no-preference' | null }): Promise<void>;
}

/** Runs in the browser: does the page offer a dark theme? Cross-origin sheets are skipped. */
export function detectDarkModeSupport(): DarkModeSupport {
  let mediaRules = 0;
  const visit = (rules: CSSRuleList | undefined, depth: number) => {
    if (!rules || depth > 4) return;
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (/prefers-color-scheme\s*:\s*dark/i.test(rule.conditionText ?? rule.media.mediaText)) mediaRules++;
        visit(rule.cssRules, depth + 1);
      } else if (rule instanceof CSSImportRule) {
        try {
          if (/prefers-color-scheme\s*:\s*dark/i.test(rule.media.mediaText)) mediaRules++;
          visit(rule.styleSheet?.cssRules, depth + 1);
        } catch {
          /* cross-origin import */
        }
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules, depth + 1);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (/prefers-color-scheme\s*:\s*dark/i.test(sheet.media.mediaText)) mediaRules++;
      visit(sheet.cssRules, 0);
    } catch {
      /* cross-origin stylesheet: cssRules throws */
    }
  }
  const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? '';
  const css = getComputedStyle(document.documentElement).colorScheme ?? '';
  return {
    mediaRules,
    colorSchemeMeta: /\bdark\b/i.test(meta) && !/\bonly\s+light\b/i.test(meta),
    colorSchemeCss: /\bdark\b/i.test(css),
  };
}

export function supportsDarkMode(s: DarkModeSupport): boolean {
  return s.mediaRules > 0 || s.colorSchemeMeta || s.colorSchemeCss;
}

/** Runs in the browser: WCAG AA text contrast over up to 300 text elements. */
export function scanTextContrast(): ContrastScan {
  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4]?.endsWith('%')) a /= 100;
    return [+m[1], +m[2], +m[3], a];
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const lum = (c: RGBA) => {
    const ch = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  };
  const fmt = (c: RGBA) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
  const rootScheme = getComputedStyle(document.documentElement).colorScheme ?? '';
  const darkCanvas = /\bdark\b/.test(rootScheme) && matchMedia('(prefers-color-scheme: dark)').matches;
  const canvas: RGBA = darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];

  // Effective background: composite ancestor backgrounds; null when an image/gradient is involved.
  const background = (el: Element): RGBA | null => {
    const layers: RGBA[] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (!c) return null;
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let acc = canvas;
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const selectorOf = (el: Element) => {
    if (el.id) return `#${el.id}`;
    const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  };

  const failures: ContrastFailure[] = [];
  let checked = 0;
  const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
  for (const el of all) {
    if (checked >= 300) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME)$/i.test(el.tagName)) continue;
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (own.length < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const fg0 = parse(cs.color);
    const bg = background(el);
    if (!fg0 || !bg) continue;
    checked++;
    const fg = over(fg0, bg);
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    if (ratio < (large ? 3 : 4.5)) {
      failures.push({
        text: own.slice(0, 60),
        selector: selectorOf(el),
        ratio: Math.round(ratio * 100) / 100,
        fg: fmt(fg),
        bg: fmt(bg),
        large,
      });
    }
  }
  return { checked, failures };
}

export function darkModeContrastIssues(scan: ContrastScan): Issue[] {
  if (scan.failures.length === 0) return [];
  const examples = [...scan.failures]
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 5)
    .map((f) => `"${escapeHtml(f.text)}" (${escapeHtml(f.selector)}, ${f.ratio}:1, ${f.fg} on ${f.bg})`)
    .join('; ');
  return [
    {
      message: DARK_MODE_CONTRAST_MESSAGE,
      detail: `With the dark color scheme active, ${scan.failures.length} of ${scan.checked} checked text elements fall below WCAG AA contrast (4.5:1, or 3:1 for large text). Examples: ${examples}. Users with dark mode enabled in their OS get this theme automatically; check the dark-theme text and background colors.`,
      severity: SEVERITY.MEDIUM,
    },
  ];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DarkModeContrastAnalyzer {
  static async analyze(page: DarkModePage, sleep: (ms: number) => Promise<void> = defaultSleep) {
    const warnings: Issue[] = [];
    let support: DarkModeSupport;
    try {
      support = await page.evaluate(detectDarkModeSupport);
    } catch {
      return { issues: [] as Issue[], warnings, info: null };
    }
    if (!supportsDarkMode(support)) return { issues: [] as Issue[], warnings, info: { support, scanned: false } };
    let scan: ContrastScan | null;
    try {
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(400); // let color transitions settle
      scan = await page.evaluate(scanTextContrast);
    } catch {
      scan = null;
    } finally {
      try {
        await page.emulateMedia({ colorScheme: null });
      } catch {
        /* ignore */
      }
    }
    return {
      issues: scan ? darkModeContrastIssues(scan) : [],
      warnings,
      info: { support, scanned: !!scan, checked: scan?.checked ?? 0, failures: scan?.failures.length ?? 0 },
    };
  }
}
