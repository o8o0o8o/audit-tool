import { parse, type HTMLElement } from 'node-html-parser';
import { AGENTIC_FINDING_MESSAGES } from '../../constants';
import type { Issue } from '../../types';

/** Computed-style data gathered in the page; absent when the in-page evaluate failed or timed out. */
export interface ComputedHints {
  /** Non-interactive elements rendered with `cursor: pointer` and no interactive role or tabindex. */
  pointerSelectors: string[];
  /** Elements hidden by default that only a `:hover` rule reveals. */
  hoverOnlySelectors: string[];
}

export interface AgenticCheckResult {
  passed: boolean;
  offenders: string[];
}

export interface AgenticPageData {
  checks: {
    interactiveNames: AgenticCheckResult;
    interactiveRoles: AgenticCheckResult;
    formLabels: AgenticCheckResult;
    hoverOnly: AgenticCheckResult;
  };
  computedHintsUnavailable?: boolean;
  issues: Issue[];
}

export interface LlmsTxtInfo {
  hasLlmsTxt: boolean;
  status?: 'valid' | 'invalid' | 'missing' | 'server-error';
  problems?: string[];
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch']);
const NATIVE_INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);
const UNLABELED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const SAMPLE_LIMIT = 5;

function describe(el: HTMLElement): string {
  const id = el.getAttribute('id');
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  return `<${el.tagName.toLowerCase()}${id ? `#${id}` : cls ? `.${cls}` : ''}>`;
}

function hasNonEmptyAttr(el: HTMLElement, name: string): boolean {
  return Boolean(el.getAttribute(name)?.trim());
}

function labelledByText(root: HTMLElement, el: HTMLElement): boolean {
  const ids = el.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? [];
  return ids.some((id) => Boolean(root.getElementById(id)?.textContent.trim()));
}

function hasAccessibleName(root: HTMLElement, el: HTMLElement): boolean {
  if (hasNonEmptyAttr(el, 'aria-label') || hasNonEmptyAttr(el, 'title')) return true;
  if (labelledByText(root, el)) return true;
  if (el.textContent.trim()) return true;
  return el.querySelectorAll('img').some((img) => hasNonEmptyAttr(img, 'alt'));
}

function isTabbable(el: HTMLElement): boolean {
  const tabindex = el.getAttribute('tabindex');
  return tabindex !== undefined && Number(tabindex) >= 0;
}

function sampled(offenders: string[]): string {
  const shown = offenders.slice(0, SAMPLE_LIMIT).join(', ');
  return offenders.length > SAMPLE_LIMIT ? `${shown} (+${offenders.length - SAMPLE_LIMIT} more)` : shown;
}

function result(offenders: string[]): AgenticCheckResult {
  return { passed: offenders.length === 0, offenders };
}

/** Links, buttons, interactive roles and tabbable elements an agent must be able to name. */
export function checkInteractiveNames(root: HTMLElement): AgenticCheckResult {
  const offenders = root
    .querySelectorAll('a[href], button, [role], [tabindex]')
    .filter((el) => {
      const role = el.getAttribute('role');
      const tag = el.tagName.toLowerCase();
      const hasInteractiveRole = role !== undefined && INTERACTIVE_ROLES.has(role);
      const interactive = tag === 'a' || tag === 'button' || hasInteractiveRole || isTabbable(el);
      return interactive && !hasAccessibleName(root, el);
    })
    .map(describe);
  return result(offenders);
}

/** Elements that act on click (onclick or `cursor: pointer`) but expose no interactive role or focus. */
export function checkInteractiveRoles(root: HTMLElement, hints?: ComputedHints): AgenticCheckResult {
  const offenders = root
    .querySelectorAll('[onclick]')
    .filter((el) => {
      if (NATIVE_INTERACTIVE.has(el.tagName.toLowerCase())) return false;
      const role = el.getAttribute('role');
      return !(role && INTERACTIVE_ROLES.has(role)) && !isTabbable(el);
    })
    .map(describe);
  return result([...new Set([...offenders, ...(hints?.pointerSelectors ?? [])])]);
}

export function checkFormLabels(root: HTMLElement): AgenticCheckResult {
  const labelFor = new Set(
    root
      .querySelectorAll('label[for]')
      .filter((l) => l.textContent.trim())
      .map((l) => l.getAttribute('for')),
  );
  const offenders = root
    .querySelectorAll('input, select, textarea')
    .filter((el) => {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (el.tagName.toLowerCase() === 'input' && UNLABELED_INPUT_TYPES.has(type)) return false;
      const id = el.getAttribute('id');
      if (id && labelFor.has(id)) return false;
      if (hasNonEmptyAttr(el, 'aria-label') || hasNonEmptyAttr(el, 'title') || labelledByText(root, el)) return false;
      let parent = el.parentNode;
      while (parent) {
        if (parent.tagName?.toLowerCase() === 'label' && parent.textContent.trim()) return false;
        parent = parent.parentNode;
      }
      return true;
    })
    .map(describe);
  return result(offenders);
}

const REVEAL = /(display\s*:\s*(?!none)[a-z-]+|visibility\s*:\s*visible|opacity\s*:\s*1)/i;

/** `:hover` reveal rules in inline `<style>` with no `:focus`/`:focus-within` counterpart. */
export function findInlineHoverOnlySelectors(root: HTMLElement): string[] {
  const css = root
    .querySelectorAll('style')
    .map((s) => s.textContent)
    .join('\n');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.trim(), body: m[2]! }));
  const focusSelectors = rules
    .flatMap((r) => r.selectors.split(','))
    .filter((s) => /:focus/.test(s))
    .map((s) => s.replace(/:focus(-within|-visible)?/g, '').trim());
  const found = new Set<string>();
  for (const rule of rules) {
    if (!REVEAL.test(rule.body)) continue;
    for (const raw of rule.selectors.split(',')) {
      const selector = raw.trim();
      if (!selector.includes(':hover')) continue;
      const base = selector.replace(/:hover/g, '').trim();
      if (!focusSelectors.includes(base)) found.add(selector);
    }
  }
  return [...found];
}

/** Hover-only reveals plus links that navigate only through JavaScript (`javascript:` / bare `#`). */
export function checkHoverOnly(root: HTMLElement, hints?: ComputedHints): AgenticCheckResult {
  const jsOnlyLinks = root
    .querySelectorAll('a')
    .filter((a) => {
      const href = a.getAttribute('href')?.trim();
      if (href === undefined) return hasNonEmptyAttr(a, 'onclick');
      return href === '#' || /^javascript:/i.test(href);
    })
    .map(describe);
  const hover = hints ? hints.hoverOnlySelectors : findInlineHoverOnlySelectors(root);
  return result([...new Set([...hover, ...jsOnlyLinks])]);
}

export function runAgenticChecks(html: string, hints?: ComputedHints): AgenticPageData {
  const root = parse(html);
  const checks = {
    interactiveNames: checkInteractiveNames(root),
    interactiveRoles: checkInteractiveRoles(root, hints),
    formLabels: checkFormLabels(root),
    hoverOnly: checkHoverOnly(root, hints),
  };
  const issues: Issue[] = [];
  for (const [key, check] of Object.entries(checks) as [keyof typeof checks, AgenticCheckResult][]) {
    if (check.passed) continue;
    const { message, severity } = AGENTIC_FINDING_MESSAGES[key];
    issues.push({ message, detail: `${check.offenders.length} element(s): ${sampled(check.offenders)}`, severity });
  }
  return { checks, ...(hints ? {} : { computedHintsUnavailable: true }), issues };
}

/** Site-level llms.txt finding, from the aeo-analyzer's fetch; null when the file is present and valid. */
export function llmsTxtFinding(info: LlmsTxtInfo | undefined, origin: string): Issue | null {
  if (!info) return null;
  const url = `${origin.replace(/\/$/, '')}/llms.txt`;
  const status = info.status ?? (info.hasLlmsTxt ? 'valid' : 'missing');
  // 'server-error' covers 5xx and unreachable fetches: the file was never read, so no finding.
  if (status === 'valid' || status === 'server-error') return null;
  if (status === 'missing') return { ...AGENTIC_FINDING_MESSAGES.llmsTxtMissing, detail: url };
  return { ...AGENTIC_FINDING_MESSAGES.llmsTxtInvalid, detail: url };
}

/** Matches the agentic-browsing finding messages (all five checks), for check-group filtering and Phase 3. */
export const AGENTIC_FINDING_PATTERN =
  /\b(without an accessible name|unlabeled click target|form inputs? without a label|reachable only via hover|llms\.txt is (missing|invalid))/i;

/** True for an agentic-browsing finding; these come from the rendered DOM, so Phase 3 never refutes them. */
export function isAgenticFinding(text: string): boolean {
  return AGENTIC_FINDING_PATTERN.test(text);
}
