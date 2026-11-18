/**
 * Interaction probes (`--visual`): click what a visitor clicks and report a control that does
 * nothing. Runs last on a page the crawl has finished with, so no extra page is loaded, and on a
 * few pages per audit (one per URL template).
 *
 * What it clicks: the phone menu button, collapsed sections and tabs, plain buttons, and the site
 * search with a word from the page. What it never clicks: anything in a form other than the search
 * box, consent prompts, and buttons that buy, book, send, sign in or delete. A click that leaves
 * the page ends the probe.
 *
 * The page reports what changed after each click (`ClickOutcome`); whether that counts as a
 * response is decided by pure functions here.
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';
import { collectLayoutSnapshot, desktopHighlights, evaluateDesktopLayout } from './layout-integrity-analyzer';
import { captureVisualShots, saveVisualShot, type VisualShot } from '../../crawler/visual-shot-capture';

export const MENU_DEAD_MESSAGE = 'Menu button does not open a menu';
export const CONTROL_DEAD_MESSAGE = 'Control does not respond to a click';
export const CLICK_ERROR_MESSAGE = 'JavaScript error when a control is clicked';
export const SEARCH_BROKEN_MESSAGE = 'Site search does not work';

export const INTERACTION_FINDING_MESSAGES = [
  MENU_DEAD_MESSAGE,
  CONTROL_DEAD_MESSAGE,
  CLICK_ERROR_MESSAGE,
  SEARCH_BROKEN_MESSAGE,
] as const;

/** Pages probed per audit: a full audit, and a lead scan (which loads 25 pages in all). */
export const MAX_INTERACTION_PROBES = 10;
export const MAX_INTERACTION_PROBES_LEAD = 4;
const PROBE_BUDGET_MS = 25_000;
const SETTLE_MS = 900;
const DESKTOP = { width: 1366, height: 800 };

export type ControlKind = 'menu' | 'disclosure' | 'tab' | 'button';

export interface ProbeTarget {
  /** Value of the `data-audit-probe` attribute the collector put on the element. */
  id: number;
  kind: ControlKind;
  /** How the fact names the control: its label, text or markup. */
  name: string;
}

/** What changed on the page between just before a click and `SETTLE_MS` after it. */
export interface ClickOutcome {
  /** False when the control was covered by something else and no click was made. */
  clicked: boolean;
  /** `aria-expanded`, `aria-selected`, `aria-pressed`, `open` of the control and what it controls, before and after. */
  stateBefore: string;
  stateAfter: string;
  /** DOM changes anywhere on the page (nodes added or removed, attributes changed). */
  mutations: number;
  /** Visible links before and after: a menu that opens shows more of them. */
  linksBefore: number;
  linksAfter: number;
  urlChanged: boolean;
  /** Network requests that started after the click. */
  requests: number;
  /** Things a script can do without touching the DOM: scroll, focus, play media, print, share, copy, open a window. */
  sideEffects: number;
  /** Uncaught errors thrown while the click was handled. */
  errors: string[];
  /** The control's box in the window when it was clicked, and the window just before and after. */
  box?: { x: number; y: number; width: number; height: number };
  before?: Buffer;
  after?: Buffer;
}

export interface InteractionProbeData {
  probed: Array<{ kind: ControlKind | 'search'; name: string; responded: boolean | null; errors: number }>;
  desktopChecked: boolean;
  issues: Issue[];
  /** Screenshots behind the findings: the window before and after a click, the desktop layout. */
  shots?: VisualShot[];
}

const NOISE_ERROR = /^Script error\.?$|ResizeObserver loop|Load failed|NetworkError|Failed to fetch|AbortError/i;

/** Uncaught errors worth reporting: not the browser's generic cross-origin or cancelled-request messages. */
export function realErrors(errors: string[]): string[] {
  return [...new Set(errors.map((e) => e.split('\n')[0]!.trim()).filter((e) => e && !NOISE_ERROR.test(e)))];
}

/** A menu opened when its state flipped or clearly more links are on screen. */
export function menuOpened(o: ClickOutcome): boolean {
  return o.stateBefore !== o.stateAfter || o.linksAfter - o.linksBefore >= 3 || o.urlChanged;
}

/** Any sign that the page reacted to the click. */
export function responded(o: ClickOutcome): boolean {
  return o.stateBefore !== o.stateAfter || o.mutations > 0 || o.urlChanged || o.requests > 0 || o.sideEffects > 0;
}

/** Button texts and labels the probe leaves alone: they buy, send, sign in, change consent or remove something. */
export const UNSAFE_CONTROL =
  /\b(?:add to|cart|basket|bag|buy|purchase|checkout|check out|order|pay|book|reserve|submit|send|subscribe|sign|log ?in|log ?out|register|join|apply|delete|remove|clear|accept|agree|allow|reject|decline|deny|consent|cookies?|donate|download|install|share|print|call|chat|kaufen|bestellen|warenkorb|buchen|senden|anmelden|akzeptieren|ablehnen|acheter|panier|envoyer|accepter|refuser|comprar|carrito|enviar|aceptar|rechazar)\b/i;

/** A word of 4 to 14 letters from the page's own navigation or heading, to search the site for. */
export function searchWord(texts: string[]): string | null {
  const words = texts
    .flatMap((t) => t.split(/[^\p{L}]+/u))
    .filter(
      (w) =>
        w.length >= 4 &&
        w.length <= 14 &&
        !/^(?:home|menu|more|about|contact|login|search|skip|main|content|open|close)$/i.test(w),
    );
  if (words.length === 0) return null;
  return words.sort((a, b) => b.length - a.length)[0]!.toLowerCase();
}

const link = (url: string) => `<a href="${url}">${url}</a>`;

/** Findings for one clicked control. */
export function judgeClick(target: ProbeTarget, outcome: ClickOutcome, url: string): Issue[] {
  if (!outcome.clicked) return [];
  const issues: Issue[] = [];
  const errors = realErrors(outcome.errors);
  if (errors.length > 0) {
    issues.push({
      severity: SEVERITY.HIGH,
      message: CLICK_ERROR_MESSAGE,
      detail: `${link(url)}: clicking ${target.name} throws "${errors[0]!.slice(0, 160)}"`,
    });
  }
  if (target.kind === 'menu') {
    if (!menuOpened(outcome) && !responded(outcome) && errors.length === 0) {
      issues.push({
        severity: SEVERITY.HIGH,
        message: MENU_DEAD_MESSAGE,
        detail: `${link(url)}: on a phone-sized screen, clicking ${target.name} opens nothing and changes nothing on the page`,
      });
    }
  } else if (!responded(outcome) && errors.length === 0) {
    issues.push({
      severity: SEVERITY.MEDIUM,
      message: CONTROL_DEAD_MESSAGE,
      detail: `${link(url)}: clicking ${target.name} changes nothing on the page, starts no request and leaves the address as it is`,
    });
  }
  return issues;
}

/**
 * Takes consent prompts out of the way with CSS, clicking nothing: a banner that covers the page
 * would otherwise receive the clicks. The visitor's consent state is left as it was.
 */
async function hideConsentPrompts(page: ChromePage): Promise<void> {
  await page.evaluate(() => {
    const NAMED =
      /cookie|consent|cmp|gdpr|onetrust|optanon|cookiebot|cybot|didomi|usercentrics|truste|osano|cky-|iubenda|qc-cmp|sp_message|termly|ketch|klaro|axeptio|tarteaucitron|cookiehub|shopify-pc|complianz|borlabs|adopt|lgpd/i;
    const TEXT = /cookie|consent|einwilligung|consentement|consentimiento|consenso|toestemming|samtycke|samtykke/i;
    for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
      const cs = getComputedStyle(el);
      const named = NAMED.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`);
      const floating = cs.position === 'fixed' || cs.position === 'sticky';
      const dialog =
        el.tagName === 'DIALOG' || el.getAttribute('aria-modal') === 'true' || el.getAttribute('role') === 'dialog';
      if (!(floating || dialog) || !(named || TEXT.test(((el as HTMLElement).innerText ?? '').slice(0, 2000))))
        continue;
      if (el.querySelector('nav, main, h1')) continue; // a page shell that merely mentions cookies
      (el as HTMLElement).style.setProperty('display', 'none', 'important');
    }
    for (const el of [document.documentElement, document.body]) {
      if (el && getComputedStyle(el).overflow === 'hidden') el.style.setProperty('overflow', 'auto', 'important');
    }
  });
}

/** Finds the controls to click, marks each with `data-audit-probe`, and returns them in click order. */
async function findTargets(page: ChromePage, unsafe: string): Promise<ProbeTarget[]> {
  return page.evaluate((unsafeSource: string) => {
    const UNSAFE = new RegExp(unsafeSource, 'i');
    const CONSENT =
      /cookie|consent|onetrust|optanon|cmp|gdpr|privacy|usercentrics|didomi|truste|osano|klaro|iubenda|cookiebot|cybot|cky-|termly|ketch|axeptio|tarteaucitron|complianz|borlabs|adopt|lgpd/i;
    const shown = (el: Element) => {
      const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
      if (typeof check === 'function' && !check.call(el, { opacityProperty: true, visibilityProperty: true })) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width >= 12 && r.height >= 12;
    };
    const label = (el: Element) =>
      (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el as HTMLElement).innerText ||
        el.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
    const describe = (el: Element) => {
      const text = label(el);
      if (text) return `"${text.slice(0, 50)}"`;
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : '';
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : cls}>`;
    };
    const excluded = (el: Element) => {
      if (el.closest('form, [aria-hidden="true"], [inert]')) return true;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return true;
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
        if (CONSENT.test(`${p.id} ${typeof p.className === 'string' ? p.className : ''}`)) return true;
      }
      const words = `${label(el)} ${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
      return UNSAFE.test(words.replace(/[-_]/g, ' '));
    };
    const out: Array<{ id: number; kind: 'menu' | 'disclosure' | 'tab' | 'button'; name: string }> = [];
    const taken = new Set<Element>();
    const signatures = new Set<string>();
    const add = (el: Element, kind: 'menu' | 'disclosure' | 'tab' | 'button') => {
      if (taken.has(el)) return;
      taken.add(el);
      const id = out.length + 1;
      el.setAttribute('data-audit-probe', String(id));
      out.push({ id, kind, name: kind === 'menu' ? `the menu button (${describe(el)})` : describe(el) });
    };

    // The phone menu button: a small control near the top that says "menu" in its label, class or id.
    const MENU = /menu|hamburger|burger|navbar-toggler|nav-toggle|navigation|drawer|offcanvas/i;
    const menu = Array.from(
      document.querySelectorAll('button, [role="button"], a, summary, label, div[tabindex]'),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      if (r.top + window.scrollY > 240 || r.width > 120 || r.height > 120 || !shown(el)) return false;
      if (el.closest('form') || el.getAttribute('aria-expanded') === 'true') return false;
      const words = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('aria-controls') ?? ''} ${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
      const text = ((el as HTMLElement).innerText ?? '').trim();
      return (
        MENU.test(words) &&
        (text.length <= 5 || /^(?:menu|menü|meny)$/i.test(text)) &&
        !/search|cart|account|lang|close/i.test(words)
      );
    });
    if (menu) add(menu, 'menu');

    // Collapsed sections and tabs, one of each look.
    const collapsible = [
      ...Array.from(document.querySelectorAll('[aria-expanded="false"]')).map((el) => [el, 'disclosure'] as const),
      ...Array.from(document.querySelectorAll('details:not([open]) > summary')).map(
        (el) => [el, 'disclosure'] as const,
      ),
      ...Array.from(document.querySelectorAll('[role="tab"][aria-selected="false"]')).map((el) => [el, 'tab'] as const),
    ];
    let disclosures = 0;
    for (const [el, kind] of collapsible) {
      if (disclosures >= 3) break;
      if (el === menu || !shown(el) || excluded(el) || el.closest('header, nav')) continue;
      if (el.tagName === 'A' && (el as HTMLAnchorElement).href && !el.getAttribute('href')?.startsWith('#')) continue;
      const signature = `${kind}|${el.tagName}|${typeof el.className === 'string' ? el.className : ''}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      add(el, kind);
      disclosures++;
    }

    // Plain buttons in the page body.
    let buttons = 0;
    // …and elements that only look like one: the cursor turns into a hand over them, and they are
    // not a link, a button or a field. The outermost element of such a group is the one clicked.
    const handed = Array.from(document.querySelectorAll('div, span, li, h2, h3, h4, p, figure, img')).filter((el) => {
      if (getComputedStyle(el).cursor !== 'pointer') return false;
      if (el.closest('a[href], button, [role="button"], label, summary, select, input')) return false;
      if (el.querySelector('a[href], button, input, select, textarea')) return false;
      return !el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer';
    });
    const plain = [...Array.from(document.querySelectorAll('button, [role="button"]')), ...handed];
    for (const el of plain) {
      if (buttons >= 4) break;
      if (taken.has(el) || !shown(el) || excluded(el) || el.closest('header, nav, footer, [role="dialog"]')) continue;
      if (
        (el as HTMLButtonElement).type === 'submit' ||
        el.hasAttribute('aria-expanded') ||
        el.getAttribute('role') === 'tab'
      ) {
        continue;
      }
      const signature = `button|${typeof el.className === 'string' ? el.className : ''}|${label(el).slice(0, 24)}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      add(el, 'button');
      buttons++;
    }
    return out;
  }, unsafe);
}

/** Clicks one marked control and reports what changed. */
async function clickAndObserve(
  page: ChromePage,
  target: ProbeTarget,
  errors: string[],
  /** Take a picture of the window before and after the click (kept only when the click yields a finding). */
  withShots = false,
): Promise<ClickOutcome> {
  const shot = () =>
    withShots ? page.screenshot({ type: 'jpeg', quality: 70, timeout: 4000 }).catch(() => undefined) : undefined;
  const none: ClickOutcome = {
    clicked: false,
    stateBefore: '',
    stateAfter: '',
    mutations: 0,
    linksBefore: 0,
    linksAfter: 0,
    urlChanged: false,
    requests: 0,
    sideEffects: 0,
    errors: [],
  };
  const before = await page.evaluate((id: number) => {
    const el = document.querySelector(`[data-audit-probe="${id}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || !(el === top || el.contains(top) || top.contains(el))) return null;
    const w = window as unknown as {
      __auditProbe?: {
        mutations: number;
        side: number;
        observer: MutationObserver;
        scrollY: number;
        focus: Element | null;
      };
    };
    w.__auditProbe?.observer.disconnect();
    const state = { mutations: 0, side: 0, scrollY: window.scrollY, focus: document.activeElement } as NonNullable<
      typeof w.__auditProbe
    >;
    state.observer = new MutationObserver((records) => {
      // The probe's own marker attributes are not the page reacting.
      state.mutations += records.filter((m) => m.attributeName !== 'data-audit-probe').length;
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const bump = () => {
      state.side++;
    };
    window.print = bump;
    window.open = () => {
      bump();
      return null;
    };
    try {
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => bump() });
      if (navigator.clipboard) navigator.clipboard.writeText = async () => bump();
    } catch {
      // read-only in this browser
    }
    for (const type of ['play', 'pause', 'fullscreenchange', 'toggle'])
      document.addEventListener(type, bump, { capture: true, once: true });
    w.__auditProbe = state;
    const visibleLinks = () =>
      Array.from(document.querySelectorAll('a[href]')).filter((a) => {
        const b = a.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.bottom > 0 &&
          b.top < window.innerHeight &&
          b.right > 0 &&
          b.left < window.innerWidth
        );
      }).length;
    const readState = () => {
      const controlled = document.getElementById(el.getAttribute('aria-controls') ?? '');
      const details = el.closest('details');
      return [
        el.getAttribute('aria-expanded'),
        el.getAttribute('aria-selected'),
        el.getAttribute('aria-pressed'),
        details?.open ?? '',
        controlled
          ? `${controlled.hidden}|${getComputedStyle(controlled).display}|${getComputedStyle(controlled).visibility}`
          : '',
        typeof el.className === 'string' ? el.className : '',
      ].join('|');
    };
    return {
      x,
      y,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      state: readState(),
      links: visibleLinks(),
      url: location.href,
    };
  }, target.id);
  if (!before) return none;

  let requests = 0;
  const onRequest = () => {
    requests++;
  };
  const errorsBefore = errors.length;
  const shotBefore = await shot();
  page.on('request', onRequest);
  try {
    await page.mouse.click(before.x, before.y);
    await page.waitForTimeout(SETTLE_MS);
  } finally {
    page.off('request', onRequest);
  }
  const shotAfter = await shot();

  const after = await page
    .evaluate((id: number) => {
      const el = document.querySelector(`[data-audit-probe="${id}"]`);
      const w = window as unknown as {
        __auditProbe?: {
          mutations: number;
          side: number;
          observer: MutationObserver;
          scrollY: number;
          focus: Element | null;
        };
      };
      const s = w.__auditProbe;
      s?.observer.disconnect();
      const visibleLinks = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
        const b = a.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.bottom > 0 &&
          b.top < window.innerHeight &&
          b.right > 0 &&
          b.left < window.innerWidth
        );
      }).length;
      let state = 'gone';
      if (el) {
        const controlled = document.getElementById(el.getAttribute('aria-controls') ?? '');
        const details = el.closest('details');
        state = [
          el.getAttribute('aria-expanded'),
          el.getAttribute('aria-selected'),
          el.getAttribute('aria-pressed'),
          details?.open ?? '',
          controlled
            ? `${controlled.hidden}|${getComputedStyle(controlled).display}|${getComputedStyle(controlled).visibility}`
            : '',
          typeof el.className === 'string' ? el.className : '',
        ].join('|');
      }
      const moved = s ? Math.abs(window.scrollY - s.scrollY) > 4 : false;
      const refocused = s
        ? document.activeElement !== s.focus &&
          document.activeElement !== el &&
          document.activeElement !== document.body
        : false;
      return {
        state,
        links: visibleLinks,
        url: location.href,
        mutations: s?.mutations ?? 0,
        side: (s?.side ?? 0) + Number(moved) + Number(refocused),
      };
    }, target.id)
    // The click navigated away and the page is mid-load: that is a response.
    .catch(() => null);

  return {
    clicked: true,
    stateBefore: before.state,
    stateAfter: after?.state ?? 'navigated',
    mutations: after?.mutations ?? 1,
    linksBefore: before.links,
    linksAfter: after?.links ?? before.links,
    urlChanged: !after || after.url.split('#')[0] !== before.url.split('#')[0],
    requests,
    sideEffects: after?.side ?? 0,
    errors: errors.slice(errorsBefore),
    box: before.box,
    before: shotBefore,
    after: shotAfter,
  };
}

/** Types a word from the page into the site search and reports a search that errors or does nothing. */
async function probeSearch(
  page: ChromePage,
  url: string,
  errors: string[],
): Promise<{ issues: Issue[]; name: string } | null> {
  const found = await page.evaluate(() => {
    const input = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type="search"], input[name="q"], input[name="s"], input[name="search"], input[name="query"], input[placeholder*="search" i], input[aria-label*="search" i], input[placeholder*="such" i], input[placeholder*="recherch" i], input[placeholder*="busca" i]',
      ),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 40 && r.height > 10 && !el.disabled && !el.readOnly && getComputedStyle(el).visibility !== 'hidden'
      );
    });
    if (!input) return null;
    input.setAttribute('data-audit-probe', 'search');
    const texts = [
      ...Array.from(document.querySelectorAll('nav a, header a')).map((a) => (a as HTMLElement).innerText ?? ''),
      document.querySelector('h1')?.textContent ?? '',
    ];
    return { texts, url: location.href };
  });
  if (!found) return null;
  const word = searchWord(found.texts);
  if (!word) return null;

  let requests = 0;
  let status: number | null = null;
  const onRequest = () => {
    requests++;
  };
  const onResponse = (res: { status(): number; request(): { isNavigationRequest(): boolean; frame(): unknown } }) => {
    if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) status = res.status();
  };
  const errorsBefore = errors.length;
  page.on('request', onRequest);
  page.on('response', onResponse);
  let after: { url: string; mutations: number } | null;
  try {
    const input = page.locator('[data-audit-probe="search"]');
    await input.scrollIntoViewIfNeeded({ timeout: 2000 });
    await page.evaluate(() => {
      const w = window as unknown as { __auditSearch?: { n: number } };
      const state = { n: 0 };
      new MutationObserver((r) => {
        state.n += r.length;
      }).observe(document.body, { subtree: true, childList: true });
      w.__auditSearch = state;
    });
    await input.fill(word, { timeout: 2000 });
    await input.press('Enter', { timeout: 2000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    after = await page
      .evaluate(() => ({
        url: location.href,
        mutations: (window as unknown as { __auditSearch?: { n: number } }).__auditSearch?.n ?? 1,
      }))
      .catch(() => null);
  } catch {
    return null; // the box could not be typed into: not a finding
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }

  const issues: Issue[] = [];
  const thrown = realErrors(errors.slice(errorsBefore));
  const name = `the site search for "${word}"`;
  const navigated = !after || after.url.split('#')[0] !== found.url.split('#')[0];
  if (status !== null && status >= 400) {
    issues.push({
      severity: SEVERITY.HIGH,
      message: SEARCH_BROKEN_MESSAGE,
      detail: `${link(url)}: searching the site for "${word}" leads to a page that answers ${status}`,
    });
  }
  // A search that "does nothing" is not reported: without a request or a new address there is no
  // way to tell a broken search from one that waits for a suggestion to be picked.
  if (thrown.length > 0) {
    issues.push({
      severity: SEVERITY.HIGH,
      message: CLICK_ERROR_MESSAGE,
      detail: `${link(url)}: using ${name} throws "${thrown[0]!.slice(0, 160)}"`,
    });
  }
  return { issues, name };
}

class InteractionProbe {
  static #probed = new Set<string>();

  static resetProbeState(): void {
    this.#probed.clear();
  }

  /** True while the audit's budget lasts and no page of this URL template has been probed. */
  static shouldProbe(url: string, lead = false): boolean {
    if (this.#probed.size >= (lead ? MAX_INTERACTION_PROBES_LEAD : MAX_INTERACTION_PROBES)) return false;
    let key: string;
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      const rest = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i.test(segments[0] ?? '') ? segments.slice(1) : segments;
      key = rest.length <= 1 ? `/${rest[0] ?? ''}` : `/${rest[0]}/*`;
    } catch {
      return false;
    }
    if (this.#probed.has(key)) return false;
    this.#probed.add(key);
    return true;
  }

  /** Runs the desktop layout pass and the click probes on a page nothing else will read again. Never throws. */
  /**
   * Runs the desktop layout pass and the click probes. With `evidenceDir`, every finding gets a
   * picture: the desktop layout with the defect boxed, and the window before and after a click.
   */
  static async run(
    page: ChromePage,
    url: string,
    evidenceDir?: string,
    /** Uncaught errors the page threw while it loaded; a click is never blamed for one of these. */
    knownErrors: string[] = [],
  ): Promise<InteractionProbeData> {
    const data: InteractionProbeData = { probed: [], desktopChecked: false, issues: [], shots: [] };
    const keep = (shot: VisualShot | null) => {
      if (shot) data.shots!.push(shot);
    };
    const deadline = Date.now() + PROBE_BUDGET_MS;
    const errors: string[] = [];
    const onError = (e: Error) => {
      errors.push(e.message);
    };
    page.on('pageerror', onError);
    const original = page.viewportSize();
    try {
      // Desktop width first: the layout checks ran at phone width during the crawl.
      if (original && original.width < DESKTOP.width) {
        await page.setViewportSize(DESKTOP);
        await page.waitForTimeout(500);
        const desktop = await collectLayoutSnapshot(page);
        data.issues.push(...evaluateDesktopLayout(desktop, url));
        data.desktopChecked = true;
        const boxes = desktopHighlights(desktop);
        if (evidenceDir && boxes.length > 0) {
          data.shots!.push(...(await captureVisualShots(page, url, evidenceDir, boxes, 'desktop').catch(() => [])));
        }
        await page.setViewportSize(original);
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await hideConsentPrompts(page);

      const targets = await findTargets(page, UNSAFE_CONTROL.source);
      // Errors the page throws on its own (before any click, and during the desktop pass) are not
      // caused by a click, however close in time the next one lands.
      await page.waitForTimeout(600);
      const background = new Set([...knownErrors, ...errors].map((e) => e.split('\n')[0]!.trim()));
      for (const target of targets) {
        if (Date.now() > deadline) break;
        const outcome = await clickAndObserve(page, target, errors, Boolean(evidenceDir));
        if (!outcome.clicked) continue;
        outcome.errors = outcome.errors.filter((e) => !background.has(e.split('\n')[0]!.trim()));
        const issues = judgeClick(target, outcome, url);
        data.issues.push(...issues);
        if (evidenceDir && issues.length > 0 && outcome.box) {
          const size = page.viewportSize() ?? { width: 0, height: 0 };
          for (const [when, jpeg] of [
            ['before', outcome.before],
            ['after', outcome.after],
          ] as const) {
            if (!jpeg) continue;
            const label = `${when} the click: ${target.name.slice(0, 40)}`;
            keep(
              saveVisualShot(evidenceDir, url, issues[0]!.message ?? '', `${when}-${target.id}`, jpeg, size, [
                { rect: outcome.box, label },
              ]),
            );
          }
        }
        data.probed.push({
          kind: target.kind,
          name: target.name,
          responded: target.kind === 'menu' ? menuOpened(outcome) || responded(outcome) : responded(outcome),
          errors: realErrors(outcome.errors).length,
        });
        if (outcome.urlChanged) return data; // the click left the page
        // Close what the click opened, so the next control is not covered by it.
        if (target.kind === 'menu' && menuOpened(outcome)) {
          await page.keyboard.press('Escape').catch(() => undefined);
          await clickAndObserve(page, target, []).catch(() => undefined);
        }
      }

      if (Date.now() < deadline) {
        const search = await probeSearch(page, url, errors);
        if (search) {
          data.issues.push(...search.issues);
          if (evidenceDir && search.issues.length > 0) {
            const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 4000 }).catch(() => undefined);
            const size = page.viewportSize() ?? { width: 0, height: 0 };
            if (jpeg) {
              keep(saveVisualShot(evidenceDir, url, search.issues[0]!.message ?? '', 'after-search', jpeg, size, []));
            }
          }
          data.probed.push({ kind: 'search', name: search.name, responded: search.issues.length === 0, errors: 0 });
        }
      }
    } catch {
      // best effort: a page that closes or navigates mid-probe keeps what was found so far
    } finally {
      page.off('pageerror', onError);
    }
    return data;
  }
}

export { InteractionProbe };
