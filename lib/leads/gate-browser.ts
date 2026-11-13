/**
 * The truth gate's own browser: a fresh session per check, so nothing the scan left behind (cookies,
 * cache, a cleared bot challenge) can make a re-check agree with the scan by accident.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { readRuntimeVersions } from '../analyzers/security/js-library-analyzer';
import { LINK_CHECK_HEADERS } from '../utils/link-status';
import { installNamePolyfill } from './fingerprint';
import type { GateBrowser } from './truth-gate';

export class PlaywrightGateBrowser implements GateBrowser {
  #browser: Browser | null = null;
  readonly #evidenceDir: string;
  /** Evidence paths are reported relative to this folder (the run folder). */
  readonly #relativeTo: string;

  constructor(evidenceDir: string, relativeTo: string) {
    this.#evidenceDir = evidenceDir;
    this.#relativeTo = relativeTo;
  }

  async #context(): Promise<BrowserContext> {
    this.#browser ??= await chromium.launch({ headless: true });
    const context = await this.#browser.newContext({
      userAgent: LINK_CHECK_HEADERS['User-Agent'],
      locale: 'en-US',
      viewport: { width: 1366, height: 900 }, // desktop, so a header navigation is visible and clickable
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

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => undefined);
    this.#browser = null;
  }
}
