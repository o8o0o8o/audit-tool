/**
 * Color Contrast Analyzer
 * Checks text-background color contrast ratios against WCAG 2.1 AA/AAA standards
 * AA: 4.5:1 for normal text, 3:1 for large text (18pt+ or 14pt+ bold)
 * AAA: 7:1 for normal text, 4.5:1 for large text
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage } from '../../types';

interface ContrastResult {
  selector: string;
  text: string;
  foreground: string;
  background: string;
  ratio: number;
  fontSize: number;
  fontWeight: number;
  isLargeText: boolean;
  passesAA: boolean;
  passesAAA: boolean;
}

class ColorContrastAnalyzer {
  static async analyze(chromePage: ChromePage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      totalChecked: number;
      aaFailures: number;
      aaaFailures: number;
      worstContrast: ContrastResult | null;
      failures: ContrastResult[];
    } = {
      totalChecked: 0,
      aaFailures: 0,
      aaaFailures: 0,
      worstContrast: null,
      failures: [],
    };

    try {
      const results = await chromePage.evaluate(() => {
        const textElements = document.querySelectorAll(
          'p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label, button, input, textarea, select, dt, dd, figcaption, blockquote, cite, small, strong, em, b, i',
        );

        const findings: {
          text: string;
          fg: string;
          bg: string;
          fontSize: number;
          fontWeight: number;
          tagName: string;
        }[] = [];

        // Only visible elements that own text directly (a text-node child): counting a <li> and
        // the <a>/<span> inside it reported the same string up to four times.
        const ownsText = (el: Element) =>
          Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim());
        const isVisible = (el: Element) => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 1 || rect.height <= 1) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
        };

        // Sample up to 200 elements for performance
        const elements = Array.from(textElements)
          .filter((el) => ownsText(el) || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
          .filter(isVisible)
          .slice(0, 200);

        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (!text || text.length === 0) continue;

          const style = window.getComputedStyle(el);
          const bgRgb = getEffectiveBackground(el);
          if (!bgRgb) continue; // background image/gradient behind the text: contrast unknown
          const fgRgb = blend(parseRgba(style.color), bgRgb);
          if (!fgRgb) continue;
          // Text drawn in exactly its background colour is deliberately invisible (or sits on a
          // layer we cannot resolve); either way it is not a contrast defect a reader meets.
          if (fgRgb.every((v, i) => v === bgRgb[i])) continue;
          const fontSize = parseFloat(style.fontSize);
          const fontWeight = parseInt(style.fontWeight, 10) || 400;

          findings.push({
            text: text.substring(0, 50),
            fg: `rgb(${fgRgb.join(', ')})`,
            bg: `rgb(${bgRgb.join(', ')})`,
            fontSize,
            fontWeight,
            tagName: el.tagName.toLowerCase(),
          });
        }

        return findings;

        function parseRgba(c: string): [number, number, number, number] | null {
          const m = /rgba?\(([^)]+)\)/.exec(c);
          if (!m) return null;
          const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
          if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        }

        /** Composite a possibly translucent colour over an opaque one. */
        function blend(top: [number, number, number, number] | null, under: [number, number, number]) {
          if (!top) return null;
          const a = top[3];
          return [0, 1, 2].map((i) => Math.round(top[i] * a + under[i] * (1 - a))) as [number, number, number];
        }

        /**
         * Opaque background behind `el`, compositing translucent layers up the tree over the
         * page's white canvas. Null when a background image or gradient sits in between.
         */
        function getEffectiveBackground(el: Element): [number, number, number] | null {
          const layers: [number, number, number, number][] = [];
          let current: Element | null = el;
          while (current) {
            const style = window.getComputedStyle(current);
            if (style.backgroundImage && style.backgroundImage !== 'none') return null;
            const c = parseRgba(style.backgroundColor);
            if (c && c[3] > 0) {
              layers.push(c);
              if (c[3] >= 1) break;
            }
            current = current.parentElement;
          }
          let rgb: [number, number, number] = [255, 255, 255];
          for (const layer of layers.reverse()) rgb = blend(layer, rgb) ?? rgb;
          return rgb;
        }
      });

      for (const result of results) {
        const fgColor = this.parseColor(result.fg);
        const bgColor = this.parseColor(result.bg);

        if (!fgColor || !bgColor) continue;

        info.totalChecked++;

        const ratio = this.getContrastRatio(fgColor, bgColor);
        const isLargeText = result.fontSize >= 24 || (result.fontSize >= 18.66 && result.fontWeight >= 700);
        const requiredAA = isLargeText ? 3 : 4.5;
        const requiredAAA = isLargeText ? 4.5 : 7;
        const passesAA = ratio >= requiredAA;
        const passesAAA = ratio >= requiredAAA;

        if (!passesAA) {
          info.aaFailures++;
          const finding: ContrastResult = {
            selector: result.tagName,
            text: result.text,
            foreground: result.fg,
            background: result.bg,
            ratio: Math.round(ratio * 100) / 100,
            fontSize: result.fontSize,
            fontWeight: result.fontWeight,
            isLargeText,
            passesAA,
            passesAAA,
          };
          info.failures.push(finding);

          if (!info.worstContrast || ratio < info.worstContrast.ratio) {
            info.worstContrast = finding;
          }
        } else if (!passesAAA) {
          info.aaaFailures++;
        }
      }
    } catch {
      // Evaluation failed, return empty results
      return { issues, warnings, info };
    }

    // Keep only top 20 failures
    info.failures = info.failures.sort((a, b) => a.ratio - b.ratio).slice(0, 20);

    // The element count stays in the DETAIL, not the message, so every page's
    // failure aggregates under ONE finding instead of fragmenting into "(5
    // elements)", "(24 elements)", … per page (each a distinct key → a distinct
    // report row, inflating the issue count). Severity is FIXED for the same
    // reason the message is stable: the aggregator keys by message and keeps the
    // first-seen severity, so a per-page-varying severity (`>5 ? HIGH : MEDIUM`)
    // would make the finding's severity depend on non-deterministic crawl order.
    // See docs/report-rules.md and dom-complexity-analyzer for the same pattern.
    const pageRef = `<a href="${url}">${url}</a>`;
    if (info.aaFailures > 0) {
      const worst = info.worstContrast;
      const worstDetail = worst
        ? ` Worst: "${worst.text}" with ratio ${worst.ratio}:1 (${worst.foreground} on ${worst.background}).`
        : '';
      issues.push({
        message: `Color contrast fails WCAG AA`,
        detail: `${pageRef} has ${info.aaFailures} of ${info.totalChecked} checked text elements below the WCAG AA contrast ratio (4.5:1 for normal text, 3:1 for large text).${worstDetail}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.aaFailures === 0 && info.aaaFailures > 0) {
      warnings.push({
        message: `Color contrast passes AA but fails AAA`,
        detail: `${pageRef} has ${info.aaaFailures} element(s) that pass WCAG AA but fail AAA (7:1 for normal text, 4.5:1 for large text). Consider improving for enhanced accessibility.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  private static parseColor(color: string): [number, number, number] | null {
    // Parse rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/);
    if (rgbMatch) {
      return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
    }
    return null;
  }

  private static getLuminance(r: number, g: number, b: number): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  private static getContrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
    const l1 = this.getLuminance(fg[0], fg[1], fg[2]);
    const l2 = this.getLuminance(bg[0], bg[1], bg[2]);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
}

export { ColorContrastAnalyzer };
