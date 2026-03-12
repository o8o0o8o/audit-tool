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

        // Sample up to 200 elements for performance
        const elements = Array.from(textElements).slice(0, 200);

        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (!text || text.length === 0) continue;

          const style = window.getComputedStyle(el);
          const fg = style.color;
          const bg = getEffectiveBackground(el);
          const fontSize = parseFloat(style.fontSize);
          const fontWeight = parseInt(style.fontWeight, 10) || 400;

          if (!fg || !bg) continue;

          findings.push({
            text: text.substring(0, 50),
            fg,
            bg,
            fontSize,
            fontWeight,
            tagName: el.tagName.toLowerCase(),
          });
        }

        return findings;

        function getEffectiveBackground(el: Element): string {
          let current: Element | null = el;
          while (current) {
            const style = window.getComputedStyle(current);
            const bg = style.backgroundColor;

            // If not transparent, return it
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              return bg;
            }
            current = current.parentElement;
          }
          // Default to white
          return 'rgb(255, 255, 255)';
        }
      });

      for (const result of results) {
        const fgColor = this.parseColor(result.fg);
        const bgColor = this.parseColor(result.bg);

        if (!fgColor || !bgColor) continue;

        info.totalChecked++;

        const ratio = this.getContrastRatio(fgColor, bgColor);
        const isLargeText =
          result.fontSize >= 24 || (result.fontSize >= 18.66 && result.fontWeight >= 700);
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
    info.failures = info.failures
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 20);

    if (info.aaFailures > 0) {
      const worst = info.worstContrast;
      const worstDetail = worst
        ? ` Worst: "${worst.text}" with ratio ${worst.ratio}:1 (${worst.foreground} on ${worst.background})`
        : '';

      issues.push({
        message: `Color contrast fails WCAG AA (${info.aaFailures} elements)`,
        detail: `${info.aaFailures} of ${info.totalChecked} checked text elements have insufficient contrast ratio.${worstDetail}. Required: 4.5:1 for normal text, 3:1 for large text.`,
        severity: info.aaFailures > 5 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      });
    }

    if (info.aaFailures === 0 && info.aaaFailures > 0) {
      warnings.push({
        message: `Color contrast passes AA but fails AAA (${info.aaaFailures} elements)`,
        detail: `${info.aaaFailures} elements pass WCAG AA but fail AAA (7:1 for normal text, 4.5:1 for large text). Consider improving for enhanced accessibility.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  private static parseColor(color: string): [number, number, number] | null {
    // Parse rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = color.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/,
    );
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

  private static getContrastRatio(
    fg: [number, number, number],
    bg: [number, number, number],
  ): number {
    const l1 = this.getLuminance(fg[0], fg[1], fg[2]);
    const l2 = this.getLuminance(bg[0], bg[1], bg[2]);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
}

export { ColorContrastAnalyzer };
