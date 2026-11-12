import { AGENTIC_HINTS_TIMEOUT_MS } from '../../constants';
import type { ChromePage } from '../../types';
import { runAgenticChecks, type AgenticPageData, type ComputedHints } from './agentic-checks';

async function collectHints(chromePage: ChromePage): Promise<ComputedHints> {
  return chromePage.evaluate(() => {
    const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL', 'OPTION']);
    const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch']);
    const describe = (el: Element) => {
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls ? `.${cls}` : ''}>`;
    };
    const pointer = new Set<string>();
    for (const el of Array.from(document.body?.querySelectorAll('div, span, li, img, p') ?? []).slice(0, 3000)) {
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      if (el.closest('a, button, [role], [tabindex]')) continue;
      const parent = el.parentElement;
      if (parent && INTERACTIVE.has(parent.tagName)) continue;
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
      const role = el.getAttribute('role');
      if (role && ROLES.has(role)) continue;
      pointer.add(describe(el));
    }
    const hoverOnly = new Set<string>();
    const focusBases = new Set<string>();
    const hoverRules: { base: string; selector: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const raw of rule.selectorText.split(',')) {
          const sel = raw.trim();
          if (/:focus/.test(sel)) focusBases.add(sel.replace(/:focus(-within|-visible)?/g, '').trim());
          const reveals = (rule.style.display && rule.style.display !== 'none') || rule.style.visibility === 'visible';
          if (sel.includes(':hover') && reveals)
            hoverRules.push({ base: sel.replace(/:hover/g, '').trim(), selector: sel });
        }
      }
    }
    for (const { base, selector } of hoverRules) {
      if (focusBases.has(base)) continue;
      try {
        const target = document.querySelector(base);
        if (target && getComputedStyle(target).display === 'none') hoverOnly.add(selector);
      } catch {
        // selector the DOM API cannot query
      }
    }
    return { pointerSelectors: [...pointer].slice(0, 50), hoverOnlySelectors: [...hoverOnly].slice(0, 50) };
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

class AgenticBrowsingAnalyzer {
  static async analyze(chromePage: ChromePage, _url: string, html: string): Promise<AgenticPageData> {
    const hints = await withTimeout(collectHints(chromePage), AGENTIC_HINTS_TIMEOUT_MS);
    return runAgenticChecks(html, hints);
  }
}

export { AgenticBrowsingAnalyzer, collectHints };
