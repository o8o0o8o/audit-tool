/**
 * The truth gate's own browser: a fresh session per check, so nothing the scan left behind (cookies,
 * cache, a cleared bot challenge) can make a re-check agree with the scan by accident.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readRuntimeVersions } from '../analyzers/security/js-library-analyzer';
import { LINK_CHECK_HEADERS } from '../utils/link-status';
import { installNamePolyfill } from './fingerprint';
import type { FirstVisit, GateBrowser, UnnamedControl, UnnamedControlsResult } from './truth-gate';

/** Words on a consent prompt's buttons, in the languages of the prospect list. */
const CONSENT_BUTTON =
  /(?<![a-zà-ž])(?:accept|agree|allow|reject|decline|deny|refuse|got it|ok|okay|i understand|manage|settings|preferences|customi[sz]e|akzeptieren|zustimmen|ablehnen|einstellungen|alle akzeptieren|accepter|refuser|tout accepter|paramètres|aceptar|rechazar|configurar|accetta|rifiuta|accetto|aceitar|rejeitar|accepteren|weigeren|akkoord|godkänn|acceptera|neka|accepter alle|afvis|hyväksy|hylkää|akceptuj|odrzuć|zgadzam się|přijmout|odmítnout)(?![a-zà-ž])/i;
/** A way to say no on the banner itself: what makes it a choice and not a notice. */
const REFUSE_BUTTON =
  /(?<![a-zà-ž])(?:reject|decline|deny|refuse|disagree|(?:only|strictly) necessary|necessary only|essential only|continue without (?:accepting|agreeing|consent)|ablehnen|nur (?:notwendige|essenzielle)|refuser|tout refuser|continuer sans accepter|rechazar|rifiuta|rifiutare|rejeitar|recusar|weigeren|afwijzen|alleen noodzakelijke|neka|avvisa|afvis|afslå|hylkää|odrzuć|odmítnout)(?![a-zà-ž])/i;
/** "Save my choices", for a banner whose category switches start off. */
const SAVE_CHOICES =
  /(?<![a-zà-ž])(?:save|confirm (?:my )?choices|speichern|auswahl bestätigen|enregistrer|guardar|salva|opslaan|spara|gem|lagre|tallenna|zapisz|uložit)(?![a-zà-ž])/i;
// "Privacy" alone is not enough: a fixed header or chat widget can say it. A consent prompt names
// cookies or consent.
const CONSENT_TEXT =
  /cookie|consent|einwilligung|consentement|consentimiento|consenso|toestemming|samtycke|samtykke|suostumus|zgod[aęy]/i;
const CONSENT_CONTAINER =
  /cookie|consent|cmp|gdpr|privacy|onetrust|optanon|cookiebot|cybot|didomi|usercentrics|truste|osano|cky-|iubenda|qc-cmp|sp_message|termly|ketch|klaro|axeptio|tarteaucitron|cookiehub|shopify-pc/i;

/**
 * Runs in the page: the visible consent prompt, if any. A prompt is a fixed, sticky or dialog
 * element (or one named like a consent tool) that is on screen, names cookies or consent and
 * offers a consent button. Open shadow roots are searched too (some consent tools render there).
 */
function findConsentPrompt(args: {
  button: string;
  refuse: string;
  save: string;
  text: string;
  container: string;
}): { text: string; canRefuse: boolean } | null {
  const button = new RegExp(args.button, 'i');
  const refuse = new RegExp(args.refuse, 'i');
  const text = new RegExp(args.text, 'i');
  const container = new RegExp(args.container, 'i');
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 40 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
    );
  };
  const all: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  for (const el of all) {
    const cs = getComputedStyle(el);
    const named = container.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`);
    const floating = cs.position === 'fixed' || cs.position === 'sticky';
    const dialog =
      /^(?:dialog|alertdialog)$/.test(el.getAttribute('role') ?? '') ||
      el.tagName === 'DIALOG' ||
      el.getAttribute('aria-modal') === 'true';
    if (!(named || floating || dialog) || !visible(el)) continue;
    const body = ((el as HTMLElement).innerText || el.shadowRoot?.textContent || '').slice(0, 3000);
    if (!text.test(body)) continue;
    const scope: ParentNode = el.shadowRoot ?? el;
    const selector = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
    const buttons: Element[] = [];
    const collect = (root: ParentNode) => {
      buttons.push(...Array.from(root.querySelectorAll(selector)));
      for (const inner of Array.from(root.querySelectorAll('*'))) if (inner.shadowRoot) collect(inner.shadowRoot);
    };
    collect(scope);
    const shown = (b: Element) => {
      const r = b.getBoundingClientRect();
      const st = getComputedStyle(b);
      return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const labels = buttons
      .filter(shown)
      .map((b) =>
        ((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || '').trim(),
      );
    if (labels.some((l) => button.test(l))) {
      // Category switches that start off, next to a "save" button, refuse as well (fc.de: "Einstellungen speichern").
      const switches: Element[] = [];
      const collectSwitches = (root: ParentNode) => {
        switches.push(
          ...Array.from(root.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]')),
        );
        for (const inner of Array.from(root.querySelectorAll('*')))
          if (inner.shadowRoot) collectSwitches(inner.shadowRoot);
      };
      collectSwitches(scope);
      const off = switches.some(
        (sw) =>
          !(sw as HTMLInputElement).disabled &&
          ((sw instanceof HTMLInputElement && !sw.checked) || sw.getAttribute('aria-checked') === 'false'),
      );
      const save = new RegExp(args.save, 'i');
      return {
        text: body.replace(/\s+/g, ' ').trim().slice(0, 160),
        canRefuse: labels.some((l) => refuse.test(l)) || (off && labels.some((l) => save.test(l))),
      };
    }
  }
  return null;
}

/**
 * Runs in the page, for screenshots only: hides consent prompts and full-screen backdrops with CSS so
 * the evidence is not covered. Nothing is clicked, so no consent is given or refused.
 */
function hideOverlays(args: { text: string; container: string }): number {
  const text = new RegExp(args.text, 'i');
  const container = new RegExp(args.container, 'i');
  let hidden = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    const cs = getComputedStyle(el);
    if (
      cs.position !== 'fixed' &&
      cs.position !== 'sticky' &&
      !container.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`)
    )
      continue;
    const r = el.getBoundingClientRect();
    const backdrop =
      cs.position === 'fixed' &&
      r.width >= innerWidth * 0.8 &&
      r.height >= innerHeight * 0.8 &&
      el.innerText.trim().length < 20;
    const prompt =
      text.test(el.innerText.slice(0, 3000)) &&
      (cs.position === 'fixed' || container.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`));
    if (backdrop || prompt || (el.tagName === 'IFRAME' && container.test(el.getAttribute('src') ?? ''))) {
      el.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
  document.documentElement.style.setProperty('overflow', 'auto', 'important');
  document.body.style.setProperty('overflow', 'auto', 'important');
  return hidden;
}

/** Runs in the page: the consent tool behind the prompt, from the global it installs. */
function consentVendor(): string | null {
  const w = window as unknown as Record<string, unknown>;
  const known: Array<[string, string]> = [
    ['OneTrust', 'OneTrust'],
    ['Optanon', 'OneTrust'],
    ['Cookiebot', 'Cookiebot'],
    ['UC_UI', 'Usercentrics'],
    ['__ucCmp', 'Usercentrics'],
    ['Didomi', 'Didomi'],
    ['truste', 'TrustArc'],
    ['Osano', 'Osano'],
    ['getCkyConsent', 'CookieYes'],
    ['_iub', 'iubenda'],
    ['_sp_', 'Sourcepoint'],
    ['ketch', 'Ketch'],
    ['Termly', 'Termly'],
    ['axeptioSDK', 'Axeptio'],
    ['tarteaucitron', 'tarteaucitron'],
    ['klaro', 'Klaro'],
    ['CookieHub', 'CookieHub'],
  ];
  for (const [global, name] of known) if (w[global]) return name;
  return null;
}

/** Runs on one element: how the scan would label it, where it sits, where it goes and what its markup says. */
function describeControl(this: Element) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- CDP calls this function with the element as `this`
  const el = this;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const visible =
    r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  const id = el.getAttribute('id');
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0];
  const label = `<${el.tagName.toLowerCase()}${id ? `#${id}` : cls ? `.${cls}` : ''}>`;
  const region = el.closest('header, [role="banner"]')
    ? 'header'
    : el.closest('nav, [role="navigation"]')
      ? 'nav'
      : el.closest('footer, [role="contentinfo"]')
        ? 'footer'
        : 'main';
  const href = el instanceof HTMLAnchorElement ? el.href || null : null;
  const icon = Array.from(el.querySelectorAll('use, img, svg, i, span'))
    .map((n) =>
      [
        n.getAttribute('href'),
        n.getAttribute('xlink:href'),
        n.getAttribute('src'),
        n.getAttribute('class'),
        n.getAttribute('data-icon'),
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(' ');
  const hint = [
    id,
    el.getAttribute('class'),
    el.getAttribute('aria-controls'),
    el.getAttribute('data-testid'),
    el.getAttribute('data-action'),
    icon,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
  return { visible, label, region, href, hint };
}

const UNNAMED_ROLES = new Set([
  'link',
  'button',
  'menuitem',
  'tab',
  'checkbox',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
]);
/** Most unnamed nodes resolved per page: enough for a header and a footer, bounded for huge pages. */
const MAX_UNNAMED_NODES = 60;

export class PlaywrightGateBrowser implements GateBrowser {
  #browser: Browser | null = null;
  readonly #evidenceDir: string;
  /** Evidence paths are reported relative to this folder (the run folder). */
  readonly #relativeTo: string;

  constructor(evidenceDir: string, relativeTo: string) {
    this.#evidenceDir = evidenceDir;
    this.#relativeTo = relativeTo;
  }

  async #context(phone?: {
    width: number;
    height: number;
    isMobile: boolean;
    hasTouch: boolean;
  }): Promise<BrowserContext> {
    this.#browser ??= await chromium.launch({ headless: true });
    const context = await this.#browser.newContext({
      userAgent: LINK_CHECK_HEADERS['User-Agent'],
      locale: 'en-US',
      // desktop by default, so a header navigation is visible and clickable
      ...(phone
        ? { viewport: { width: phone.width, height: phone.height }, isMobile: phone.isMobile, hasTouch: phone.hasTouch }
        : { viewport: { width: 1366, height: 900 } }),
    });
    await context.addInitScript(installNamePolyfill);
    return context;
  }

  async readRuntime(url: string): Promise<{ status: number | null; runtime: Record<string, string> } | null> {
    let context: BrowserContext | null = null;
    try {
      context = await this.#context();
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      const runtime = await page.evaluate(readRuntimeVersions).catch(() => ({}) as Record<string, string>);
      // Framework globals the library reader does not cover.
      const extra = await page
        .evaluate(() => {
          const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          const out: Record<string, string> = {};
          try {
            const vue2 = w.$nuxt?.$root?.constructor?.version ?? w.$nuxt?.constructor?.version;
            if (typeof vue2 === 'string') out.vue = vue2;
            if (w.$nuxt && typeof vue2 === 'string' && vue2.startsWith('2.')) out.nuxt = '2';
            if (typeof w.next?.version === 'string') out.nextjs = w.next.version;
            if (typeof w.angular?.version?.full === 'string') out.angularjs = w.angular.version.full;
            const ng = document.querySelector('[ng-version]')?.getAttribute('ng-version');
            if (ng) out.angular = ng;
          } catch {
            /* ignore */
          }
          return out;
        })
        .catch(() => ({}) as Record<string, string>);
      return { status: response?.status() ?? null, runtime: { ...runtime, ...extra } };
    } catch {
      return null;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async followLink(
    sourceUrl: string,
    targetUrl: string,
    evidenceName: string,
  ): Promise<{ status: number | null; via: 'browser-click' | 'browser-navigation'; screenshot: string | null } | null> {
    let context: BrowserContext | null = null;
    try {
      context = await this.#context();
      const page = await context.newPage();
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

      let status: number | null = null;
      let via: 'browser-click' | 'browser-navigation' = 'browser-click';
      const handle = await page.evaluateHandle((target: string) => {
        const norm = (u: string) => {
          try {
            const x = new URL(u, location.href);
            x.hash = '';
            return x.href.replace(/\/$/, '');
          } catch {
            return null;
          }
        };
        const wanted = norm(target);
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        return anchors.find((a) => norm(a.href) === wanted && a.getClientRects().length > 0) ?? null;
      }, targetUrl);
      const anchor = handle.asElement();
      let screenshot: string | null = null;
      const shoot = async (suffix: string): Promise<string | null> => {
        try {
          fs.mkdirSync(this.#evidenceDir, { recursive: true });
          const file = path.join(this.#evidenceDir, `${evidenceName.replace(/[^a-z0-9-]/gi, '-')}${suffix}.png`);
          await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
          return path.relative(this.#relativeTo, file);
        } catch {
          return null; // evidence is best effort; the status is the fact
        }
      };
      if (anchor) {
        // Evidence a person can read at a glance: the page with the link outlined, before the click.
        await anchor.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
        await anchor
          .evaluate((a) => {
            const el = a as HTMLElement;
            el.style.outline = '3px solid #e5484d';
            el.style.outlineOffset = '3px';
          })
          .catch(() => undefined);
        screenshot = await shoot('');
        await anchor.evaluate((a) => (a as HTMLAnchorElement).removeAttribute('target')).catch(() => undefined);
        const [response] = await Promise.all([
          page.waitForNavigation({ timeout: 15_000, waitUntil: 'domcontentloaded' }).catch(() => null),
          anchor.click({ timeout: 5000 }).catch(() => null),
        ]);
        status = response?.status() ?? null;
      }
      if (status === null) {
        // The link could not be clicked (hidden in a menu) or a script handled the click: open the
        // address the link carries, as a visitor who copies it would.
        via = 'browser-navigation';
        const response = await page
          .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => null);
        status = response?.status() ?? null;
      }

      // No picture when the link could not be shown outlined (it sits in a closed menu): a shot of
      // the page without the link, or of an empty error page, would not show the fact. The address
      // and the status are the evidence then.
      return { status, via, screenshot };
    } catch {
      return null;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async openPage(url: string): Promise<{ status: number | null } | null> {
    let context: BrowserContext | null = null;
    try {
      context = await this.#context();
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { status: response?.status() ?? null };
    } catch {
      return null;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async firstVisit(url: string, evidenceName: string): Promise<FirstVisit | null> {
    let context: BrowserContext | null = null;
    try {
      context = await this.#context();
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(4000); // tags and consent tools that start after load
      const args = {
        button: CONSENT_BUTTON.source,
        refuse: REFUSE_BUTTON.source,
        save: SAVE_CHOICES.source,
        text: CONSENT_TEXT.source,
        container: CONSENT_CONTAINER.source,
      };
      let prompt = await page.evaluate(findConsentPrompt, args).catch(() => null);
      if (!prompt) {
        // Consent tools that render in an iframe (Sourcepoint, TrustArc): a visible frame with the prompt.
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const box = await (await frame.frameElement().catch(() => null))?.boundingBox().catch(() => null);
          if (!box || box.width < 200 || box.height < 80) continue;
          const body = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          if (CONSENT_TEXT.test(body) && CONSENT_BUTTON.test(body)) {
            prompt = { text: body.replace(/\s+/g, ' ').trim().slice(0, 160), canRefuse: REFUSE_BUTTON.test(body) };
            break;
          }
        }
      }
      const vendor = prompt ? await page.evaluate(consentVendor).catch(() => null) : null;
      const cookies = (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain }));
      const screenshot = prompt ? await this.#shoot(page, evidenceName) : null;
      return {
        status: response?.status() ?? null,
        cookies,
        banner: prompt ? { vendor, text: prompt.text, canRefuse: prompt.canRefuse } : null,
        screenshot,
      };
    } catch {
      return null;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async unnamedControls(url: string, expected: string[], evidenceName: string): Promise<UnnamedControlsResult | null> {
    const wanted = new Set(expected);
    let last: UnnamedControlsResult | null = null;
    for (const viewport of ['desktop', 'phone'] as const) {
      let context: BrowserContext | null = null;
      try {
        context = await this.#context(
          viewport === 'phone' ? { width: 414, height: 896, isMobile: true, hasTouch: true } : undefined,
        );
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        const status = response?.status() ?? null;
        if (status === null || status < 200 || status >= 300)
          return { status, viewport, controls: [], screenshot: null };

        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.getDocument', { depth: 0 });
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
          nodes: Array<{
            ignored?: boolean;
            role?: { value?: string };
            name?: { value?: string };
            backendDOMNodeId?: number;
          }>;
        };
        const unnamed = nodes
          .filter(
            (n) =>
              !n.ignored &&
              n.backendDOMNodeId &&
              UNNAMED_ROLES.has(n.role?.value ?? '') &&
              !String(n.name?.value ?? '').trim(),
          )
          .slice(0, MAX_UNNAMED_NODES);
        const controls: UnnamedControl[] = [];
        const toOutline: string[] = [];
        for (const node of unnamed) {
          const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId })) as {
            object: { objectId?: string };
          };
          if (!object.objectId) continue;
          const { result } = (await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: describeControl.toString(),
            returnByValue: true,
          })) as { result: { value?: ReturnType<typeof describeControl> } };
          const d = result.value;
          if (!d?.visible) continue;
          controls.push({
            role: node.role?.value ?? 'link',
            label: d.label,
            region: d.region as UnnamedControl['region'],
            href: d.href,
            hint: d.hint,
          });
          if (wanted.has(d.label) && toOutline.length < 6) {
            toOutline.push(object.objectId);
            await cdp
              .send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration:
                  'function(){this.style.outline="3px solid #e5484d";this.style.outlineOffset="2px";}',
              })
              .catch(() => undefined);
          }
        }
        let screenshot: string | null = null;
        if (toOutline.length) {
          await page
            .evaluate(hideOverlays, { text: CONSENT_TEXT.source, container: CONSENT_CONTAINER.source })
            .catch(() => 0);
          await cdp
            .send('Runtime.callFunctionOn', {
              objectId: toOutline[0],
              functionDeclaration: 'function(){this.scrollIntoView({block:"center"});}',
            })
            .catch(() => undefined);
          screenshot = await this.#shoot(page, `${evidenceName}-${viewport}`);
        }
        last = { status, viewport, controls, screenshot };
        if (controls.some((c) => wanted.has(c.label))) return last;
      } catch {
        // try the next viewport; a failure on both returns what the last one saw
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
    return last;
  }

  async #shoot(page: Page, name: string): Promise<string | null> {
    try {
      fs.mkdirSync(this.#evidenceDir, { recursive: true });
      const file = path.join(this.#evidenceDir, `${name.replace(/[^a-z0-9-]/gi, '-')}.png`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
      return path.relative(this.#relativeTo, file);
    } catch {
      return null; // evidence is best effort
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => undefined);
    this.#browser = null;
  }
}
