/**
 * Browser-launch invariant for `--no-playwright` mode.
 *
 * When the audit runs with `--no-playwright`, NO Chromium may be launched
 * anywhere — not in the crawl, the Phase-3 verifier, the Phase-4 competitor
 * crawl, the robots/sitemap fallback, or the PDF renderer. This module turns
 * that from a hope into a hard, testable invariant: every `chromium.launch()`
 * site routes through `launchChromium()` (or asserts via `assertBrowserAllowed()`
 * first), which THROWS when the process-scoped no-playwright signal is set.
 *
 * The signal is `process.env.SEO_AUDIT_NO_PLAYWRIGHT === '1'`, set as early as
 * possible in `robots.ts` (and by `runVerifyPhase` for standalone re-runs) so it
 * is visible to every phase and the parsers. The flag-off (default) path never
 * sets it, so the guard is a pure no-op by default — the normal browser audit is
 * completely unaffected.
 *
 * Note: at two sinks a thrown guard error is swallowed by an upstream
 * `.catch(() => …)` (the robots/sitemap `fetchTextViaBrowser` fallback) or an
 * enclosing try/catch (the PDF renderer). Those sites therefore ALSO skip their
 * browser work explicitly by the flag — the guard is the backstop/tripwire, the
 * explicit skips are the primary control. See the callers.
 */

import { chromium } from 'playwright';
import type { Browser, LaunchOptions } from 'playwright';

/** Is the process running in no-playwright mode? */
export function isNoPlaywright(): boolean {
  return process.env.SEO_AUDIT_NO_PLAYWRIGHT === '1';
}

/**
 * Throw if a browser launch is attempted while no-playwright mode is active.
 * @param context - short label for the launch site, included in the error.
 */
export function assertBrowserAllowed(context = 'browser'): void {
  if (isNoPlaywright()) {
    throw new Error(
      `[no-playwright] Refusing to launch Chromium (${context}) — the audit is running with --no-playwright. ` +
        `This is the browser-launch invariant; the calling code should have skipped this browser work by the flag.`,
    );
  }
}

/**
 * The single sanctioned wrapper around `chromium.launch()`. Enforces the
 * no-playwright invariant, then launches normally. Every launch site in the
 * codebase should call this instead of `chromium.launch()` directly.
 */
export async function launchChromium(options?: LaunchOptions, context = 'browser'): Promise<Browser> {
  assertBrowserAllowed(context);
  return chromium.launch(options);
}
